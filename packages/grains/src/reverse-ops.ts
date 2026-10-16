import type { IRevision } from "@benedb/core/i-revision";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { isPublicWildcard, type ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { SetOperationType } from "@benedb/core/userset-rewrite";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import type { IGraphReader } from "@benedb/datastore/i-graph-reader";
import { CaveatEvaluator } from "@benedb/engine/caveat-evaluator";
import type { CaveatExpression } from "@benedb/engine/caveat-expression";
import { ExpandEngine } from "@benedb/engine/expand-engine";
import type { FoundResource } from "@benedb/engine/found-resource";
import type { FoundSubject } from "@benedb/engine/found-subject";
import { LookupResourcesEngine } from "@benedb/engine/lookup-resources-engine";
import { LookupSubjectsEngine } from "@benedb/engine/lookup-subjects-engine";
import type {
  DirectSubject,
  ExpandMode,
  PermissionTreeNode,
} from "@benedb/engine/permission-tree-node";
import type { GrainRuntime } from "@thresh/core/grain-runtime";

import { frontierSubjectFromWire } from "./frontier-wire";
import type { IGraphReaderSource } from "./i-graph-reader-source";
import type { ISchemaProvider, SchemaSnapshot } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import { ISubjectFrontierGrain } from "./i-subject-frontier-grain";
import type { MembershipWalkOptions } from "./membership-walk-options";
import {
  decodeLookupResourcesCursor,
  decodeSubjectId,
  encodeCandidateResume,
  encodeLookupResourcesCursor,
  encodeSubjectId,
  requestShapeHashLookupResources,
  requestShapeHashLookupSubjects,
  tryDecodeCandidateResume,
} from "./reverse-ops-cursor-codec";
import {
  caveatedPermissionship,
  type ExpandSubjectWire,
  type ExpandTreeArgs,
  type ExpandTreeNodeWire,
  type ExpandTreeReply,
  type FoundResourceWire,
  type FoundSubjectStreamItem,
  type FoundSubjectWire,
  type LookupResourcesArgs,
  type LookupSubjectsArgs,
  PERMISSIONSHIP_MEMBER,
  type SetOpWire,
} from "./reverse-ops-dtos";
import { acquireCoveredCandidates, pinRevision, tryCollapse } from "./reverse-ops-support";
import type { SchemaResolver } from "./schema-resolver";
import { subjectFrontierKeyBuild } from "./subject-frontier-key";
import {
  resolveSubjectFrontierMemoOptions,
  type SubjectFrontierMemoOptions,
} from "./subject-frontier-memo-options";

/**
 * Ported from Spiceport `Grains/ReverseOps.cs`.
 *
 * The reverse engine ops (LookupSubjects, LookupResources, ExpandPermissionTree) served
 * IN-PROCESS. These ops are pure per-request walks with nothing to memoize, so a grain hop would
 * buy only compute placement, not a consistency or caching benefit - unlike `CheckGrain`,
 * `ISubjectFrontierGrain` and `IMembershipWalkGrain`, which memoize state across calls and so stay
 * real grains, called from these in-process walks.
 *
 * The pinning / index-acquisition / caveat-collapse logic lives in `reverse-ops-support.ts`. The
 * reader handed to each ENGINE comes from the `IGraphReaderSource` seam at the pinned revision;
 * schema resolution goes through the `ISchemaSource` seam (cached by `SchemaResolver`);
 * `IDatastore` remains only for revision resolution and token minting. Since this is not grain
 * code, the streaming ops take the caller's plain `AbortSignal` with no grain-method plumbing.
 *
 * Port decisions:
 *   * `ExpandPermissionTree` passes `CancellationToken.None` at all four sites - it is the only op
 *     with no token parameter - so NO signal is threaded through it here either.
 *   * Both streaming ops are C# ITERATORS: their argument guard and entry cancellation check run
 *     at the first `MoveNext`, which `async *` generators reproduce exactly.
 *   * `string.CompareOrdinal` is UTF-16 code-unit ordering: a bare `<=` on strings, never
 *     `localeCompare`, because the subject-id skip is wire-visible through the client cursor.
 */
export class ReverseOps {
  readonly #datastore: IDatastore;
  readonly #schemaSource: ISchemaSource;
  readonly #schemaProvider: ISchemaProvider;
  readonly #schemaResolver: SchemaResolver;
  readonly #grainFactory: ReverseOpsGrainFactory;
  readonly #membershipWalkOptions: MembershipWalkOptions;
  readonly #readerSource: IGraphReaderSource;
  readonly #frontierMemoOptions: SubjectFrontierMemoOptions;

  constructor(
    datastore: IDatastore,
    schemaSource: ISchemaSource,
    schemaProvider: ISchemaProvider,
    schemaResolver: SchemaResolver,
    grainFactory: ReverseOpsGrainFactory,
    membershipWalkOptions: MembershipWalkOptions,
    readerSource: IGraphReaderSource,
    frontierMemoOptions?: SubjectFrontierMemoOptions | undefined,
  ) {
    this.#datastore = datastore;
    this.#schemaSource = schemaSource;
    this.#schemaProvider = schemaProvider;
    this.#schemaResolver = schemaResolver;
    this.#grainFactory = grainFactory;
    this.#membershipWalkOptions = membershipWalkOptions;
    this.#readerSource = readerSource;
    // `frontierMemoOptions ?? new SubjectFrontierMemoOptions()` - an absent argument keeps every
    // default, which means the memo is ENABLED.
    this.#frontierMemoOptions = frontierMemoOptions ?? {};
  }

  /**
   * Resolves the compiled schema effective at the pinned revision (the same schema the confirming
   * Check mesh evaluates under), rather than the possibly-stale ambient current schema on a
   * non-writer silo.
   */
  #resolveSchema(
    schemaHash: string | undefined,
    revision: IRevision,
    signal: AbortSignal | undefined,
  ): Promise<SchemaSnapshot> {
    return this.#schemaResolver.resolveWithSource(
      schemaHash,
      this.#schemaSource,
      revision,
      this.#schemaProvider.current,
      signal,
    );
  }

  /** Expands the resource's permission into a structural permission tree. */
  async expandPermissionTree(args: ExpandTreeArgs): Promise<ExpandTreeReply> {
    if (args === undefined || args === null) throw new InvalidArgumentError("args is required");
    // `CancellationToken.None` at all four sites below: this op takes no token at all.
    const pinned = await pinRevision(this.#datastore, args.consistency, undefined);

    const schema = await this.#resolveSchema(pinned.schemaHash, pinned.revision, undefined);
    const engine = new ExpandEngine(schema.namespaces);
    const mode: ExpandMode = args.mode === "recursive" ? "recursive" : "shallow";
    const resource: ObjectAndRelation = {
      objectType: args.resourceType,
      objectId: args.resourceId,
      relation: args.permission,
    };

    // The engine walk reads through the IGraphReaderSource seam at the same pinned revision; token
    // minting stays on pinRevision and schema resolution on the ISchemaSource seam.
    const tree = await engine.expandPermissionTree(
      this.#readerSource.graphReaderAt(pinned.revision),
      resource,
      mode,
      pinned.now,
      undefined,
    );

    // Expand carries verbatim caveat expressions; with no request context we collapse each against
    // an empty context so caveated nodes/subjects surface their missing parameter names.
    const evaluator = new CaveatEvaluator(schema.caveats);
    return { root: nodeToWire(tree, evaluator), expandedAtToken: pinned.token };
  }

  /**
   * Streams the subjects (of the requested type/subrelation) holding the resource's permission, one
   * at a time, each with the opaque cursor positioned immediately after it. The caller applies any
   * client limit by stopping enumeration; there is no page cap inside this walk.
   */
  async *streamLookupSubjects(
    args: LookupSubjectsArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<FoundSubjectStreamItem> {
    if (args === undefined || args === null) throw new InvalidArgumentError("args is required");
    signal?.throwIfAborted();
    const pinned = await pinRevision(this.#datastore, args.consistency, signal);

    const schema = await this.#resolveSchema(pinned.schemaHash, pinned.revision, signal);
    const evaluator = new CaveatEvaluator(schema.caveats);
    const resource: ObjectAndRelation = {
      objectType: args.resourceType,
      objectId: args.resourceId,
      relation: args.permission,
    };
    const requestHash = requestShapeHashLookupSubjects(args, schema.schemaHash);
    const after = decodeSubjectId(args.cursor, requestHash);

    // BELOW the pin/schema resolution: the pre-context frontier is either served from the
    // SubjectFrontierGrain activation memo (an exact memo of this identical computation at a pinned
    // identity) or walked live via the engine. Either way the result feeds the SAME cursor-skip /
    // caveat-collapse loop below, so the two paths cannot drift.
    const walk: AsyncIterable<FoundSubject> = resolveSubjectFrontierMemoOptions(
      this.#frontierMemoOptions,
    ).enabled
      ? await this.#memoizedFrontier(resource, args, pinned.revision, pinned.schemaHash, signal)
      : new LookupSubjectsEngine(schema.namespaces).lookupSubjects(
          this.#readerSource.graphReaderAt(pinned.revision),
          resource,
          args.subjectType,
          args.subjectRelation,
          pinned.now,
          signal,
        );

    for await (const found of walk) {
      // Deterministic-by-id resume: skip ids at or before the cursor. ORDINAL, never localeCompare.
      if (after !== undefined && found.subjectId <= after) continue;

      // Collapse the verbatim caveat against the request context.
      const collapsed = tryCollapse(found.caveat, args.context, evaluator);
      if (!collapsed.included) continue; // sheared off entirely.

      // Wildcard exclusions (mirrors upstream's LookupSubjects response mapping): the deprecated
      // excluded_subject_ids mirror carries EVERY engine exclusion's id, while the modern
      // excluded_subjects list collapses each exclusion's own caveat against the request context -
      // a definitely-false exclusion caveat drops the entry from the modern list only.
      let excludedIds: readonly string[] | undefined;
      let excluded: readonly FoundSubjectWire[] | undefined;
      const exclusions = found.excludedSubjects;
      if (exclusions !== undefined && exclusions.length > 0) {
        excludedIds = exclusions.map((e) => e.subjectId);
        const survivors: FoundSubjectWire[] = [];
        for (const e of exclusions) {
          const excludedCollapse = tryCollapse(e.caveat, args.context, evaluator);
          if (excludedCollapse.included) {
            survivors.push({
              subjectId: e.subjectId,
              isWildcard: e.isWildcard,
              permissionship: excludedCollapse.permissionship,
            });
          }
        }
        excluded = survivors;
      }

      const subject: FoundSubjectWire = {
        subjectId: found.subjectId,
        isWildcard: found.isWildcard,
        permissionship: collapsed.permissionship,
        excludedSubjectIds: excludedIds,
        excludedSubjects: excluded,
      };
      yield {
        subject,
        resumeCursor: encodeSubjectId(found.subjectId, requestHash),
        lookedUpAtToken: pinned.token,
      };
    }
  }

  /**
   * Resolves the pre-context frontier via the `ISubjectFrontierGrain` activation memo and replays it
   * in the engine's own walk order (no sort/reorder), so it slots into the identical
   * post-processing loop the live engine walk uses.
   */
  async #memoizedFrontier(
    resource: ObjectAndRelation,
    args: LookupSubjectsArgs,
    revision: IRevision,
    schemaHash: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AsyncIterable<FoundSubject>> {
    // The AMBIENT fallback here is deliberate, and is what `pinRevision` itself does NOT do.
    const key = subjectFrontierKeyBuild(
      resource,
      args.subjectType,
      args.subjectRelation,
      revision.toString(),
      schemaHash ?? this.#schemaProvider.current.schemaHash,
    );
    const frontierGrain = this.#grainFactory.getGrain(ISubjectFrontierGrain, key);

    const reply = await frontierGrain.getFrontier(signal);

    return toAsyncEnumerable(reply.subjects.map(frontierSubjectFromWire), signal);
  }

  /**
   * Streams the resources (of the requested type) on which the subject holds the permission, one at
   * a time, each with the opaque cursor positioned immediately after it - on every path, limited or
   * not, as SpiceDB does. When `limit` or an engine cursor is set this runs the live traversal,
   * whose cursors are engine positions; an unlimited, cursorless enumeration may take the Leopard
   * fast path (a complete candidate set confirmed by Check, streamed in ordinal id order), whose
   * cursors are candidate-resume cursors. The caller applies any client limit by stopping.
   */
  async *streamLookupResources(
    args: LookupResourcesArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<FoundResourceWire> {
    if (args === undefined || args === null) throw new InvalidArgumentError("args is required");
    signal?.throwIfAborted();
    const pinned = await pinRevision(this.#datastore, args.consistency, signal);

    // The snapshot is captured ONCE so the engine's namespaces/caveats and its pre-built
    // reachability graph all come from the same schema, even if a concurrent write swaps the
    // ambient current mid-call. First mode, not Full.
    const snapshot = await this.#resolveSchema(pinned.schemaHash, pinned.revision, signal);
    const engine = new LookupResourcesEngine(
      snapshot.namespaces,
      snapshot.caveats,
      snapshot.reachabilityFirst,
    );
    const requestHash = requestShapeHashLookupResources(args, snapshot.schemaHash);
    const reader = this.#readerSource.graphReaderAt(pinned.revision);
    // A limit of ZERO or negative becomes UNLIMITED, not a zero-result read.
    const limit = args.limit !== undefined && args.limit > 0 ? args.limit : undefined;

    // A candidate-resume cursor continues a stream the Leopard accelerator produced: that stream
    // is the covered candidates in ordinal id order, so the resume re-derives the same ordered set
    // and skips ids at or before the last one emitted. Any limit is applied by the caller stopping.
    const lastCandidate = tryDecodeCandidateResume(args.cursor, requestHash);
    if (lastCandidate !== undefined) {
      yield* this.#candidateOrderedStream(
        engine,
        reader,
        snapshot,
        args,
        pinned.revision,
        pinned.now,
        pinned.token,
        requestHash,
        lastCandidate,
        signal,
      );
      return;
    }

    const startCursor = decodeLookupResourcesCursor(args.cursor, requestHash);

    // A client limit or an engine cursor runs the cursor-bearing live traversal (a paged walk must
    // resume where the engine left off). An unlimited, cursorless enumeration may take the Leopard
    // accelerator (absent unless it decides this shape is covered): it dispatches the
    // membership-walk grain mesh and confirms every candidate with Check, so verdicts are
    // unchanged from the live traversal, and each item carries a candidate-resume cursor.
    // `hasCursorOrLimit` tests the DERIVED limit, so `limit = 0` does NOT block the fast path while
    // a present cursor - including an EMPTY one, which is still `not null` in the C# - does.
    const candidates = await acquireCoveredCandidates(
      this.#grainFactory,
      this.#membershipWalkOptions,
      snapshot,
      args.subjectType,
      args.subjectId,
      args.subjectRelation,
      args.resourceType,
      args.permission,
      pinned.revision,
      args.cursor !== undefined || limit !== undefined,
      signal,
    );

    if (candidates !== undefined) {
      yield* confirmCandidates(
        engine,
        reader,
        args,
        ordinalAfter(candidates, undefined),
        pinned.now,
        pinned.token,
        requestHash,
        signal,
      );
      return;
    }

    // The engine traversal reads through the IGraphReaderSource seam at the same pinned revision;
    // token minting stays on pinRevision, schema resolution on the ISchemaSource seam, and cursor
    // handling on the codec.
    for await (const found of engine.lookupResources(
      reader,
      args.subjectType,
      args.subjectId,
      args.subjectRelation,
      args.resourceType,
      args.permission,
      args.context,
      pinned.now,
      startCursor,
      limit,
      signal,
    )) {
      yield {
        resourceId: found.resourceId,
        permissionship: toPermissionship(found),
        afterResultCursor: encodeLookupResourcesCursor(found.afterCursor, requestHash),
        lookedUpAtToken: pinned.token,
      };
    }
  }

  /**
   * Resumes a candidate-ordered stream after `lastCandidate`. The accelerator is asked again as
   * for a fresh enumeration; if it declines (disabled, uncovered, or an incomplete walk), the live
   * traversal is drained instead, deduplicated by resource id, and put in the same ordinal order,
   * so the resume is positioned identically either way; under a client limit the drain retains
   * only the page it can return.
   */
  async *#candidateOrderedStream(
    engine: LookupResourcesEngine,
    reader: IGraphReader,
    snapshot: SchemaSnapshot,
    args: LookupResourcesArgs,
    revision: IRevision,
    now: bigint,
    token: string,
    requestHash: string,
    lastCandidate: string,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<FoundResourceWire> {
    const candidates = await acquireCoveredCandidates(
      this.#grainFactory,
      this.#membershipWalkOptions,
      snapshot,
      args.subjectType,
      args.subjectId,
      args.subjectRelation,
      args.resourceType,
      args.permission,
      revision,
      false,
      signal,
    );

    if (candidates !== undefined) {
      yield* confirmCandidates(
        engine,
        reader,
        args,
        ordinalAfter(candidates, lastCandidate),
        now,
        token,
        requestHash,
        signal,
      );
      return;
    }

    // Live fallback: one result per resource id. A resource reached through several entrypoints
    // is a member if any path makes it one; otherwise it keeps the first caveated result's missing
    // params. The traversal is unordered, so the whole result set is walked, but only ids after
    // the cursor are kept and, under a client limit, only the `limit` lowest of them: retained
    // memory is bounded by the page size. An id evicted for being above the retained maximum can
    // never re-enter, because the retained set only ever gets lower, so later results for it are
    // discarded the same way.
    const cap = args.limit !== undefined && args.limit > 0 ? args.limit : undefined;
    const byId = new Map<string, FoundResource>();
    // The C#'s ordinal `SortedSet<string>`: kept sorted ascending, so its `Max` is the last entry.
    const retained: string[] = [];
    for await (const found of engine.lookupResources(
      reader,
      args.subjectType,
      args.subjectId,
      args.subjectRelation,
      args.resourceType,
      args.permission,
      args.context,
      now,
      undefined,
      undefined,
      signal,
    )) {
      const id = found.resourceId;
      if (id <= lastCandidate) continue;

      const existing = byId.get(id);
      if (existing !== undefined) {
        if (existing.membership !== "member" && found.membership === "member") byId.set(id, found);
        continue;
      }

      if (cap !== undefined && retained.length >= cap) {
        const max = retained[retained.length - 1] as string;
        if (id > max) continue;
        byId.delete(max);
        retained.pop();
      }

      byId.set(id, found);
      insertOrdinal(retained, id);
    }

    for (const id of ordinalAfter(byId.keys(), lastCandidate)) {
      signal?.throwIfAborted();
      yield {
        resourceId: id,
        permissionship: toPermissionship(byId.get(id) as FoundResource),
        afterResultCursor: encodeCandidateResume(id, requestHash),
        lookedUpAtToken: token,
      };
    }
  }
}

/** Confirms ordered covered candidates with Check, each item carrying a candidate-resume cursor. */
async function* confirmCandidates(
  engine: LookupResourcesEngine,
  reader: IGraphReader,
  args: LookupResourcesArgs,
  orderedCandidates: readonly string[],
  now: bigint,
  token: string,
  requestHash: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<FoundResourceWire> {
  for await (const found of engine.lookupResourcesWithCandidates(
    reader,
    args.subjectType,
    args.subjectId,
    args.subjectRelation,
    args.resourceType,
    args.permission,
    orderedCandidates,
    args.context,
    now,
    undefined,
    undefined,
    signal,
  )) {
    yield {
      resourceId: found.resourceId,
      permissionship: toPermissionship(found),
      afterResultCursor: encodeCandidateResume(found.resourceId, requestHash),
      lookedUpAtToken: token,
    };
  }
}

/** Inserts `id` (absent from `sorted`) into the ordinally ascending `sorted`, by binary search. */
function insertOrdinal(sorted: string[], id: string): void {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] as string) < id) low = mid + 1;
    else high = mid;
  }
  sorted.splice(low, 0, id);
}

/**
 * The distinct ids in ordinal order, keeping only those strictly after `after`. ORDINAL (UTF-16
 * code units, `StringComparer.Ordinal`), never `localeCompare`.
 */
function ordinalAfter(ids: Iterable<string>, after: string | undefined): string[] {
  return [...new Set(ids)]
    .filter((id) => after === undefined || id > after)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Anything that is not caveated - including a non-member, which the engine never yields - becomes
 * Member. The else arm is unconditional, not a third case.
 */
function toPermissionship(found: FoundResource): FoundResourceWire["permissionship"] {
  return found.membership === "caveated"
    ? caveatedPermissionship(found.missingContextParams)
    : PERMISSIONSHIP_MEMBER;
}

/** The `{ getGrain }` slice of Thresh's `GrainRuntime` standing in for `IGrainFactory`. */
export type ReverseOpsGrainFactory = Pick<GrainRuntime, "getGrain">;

/**
 * Replays a materialised list as an async sequence, checking the signal per item exactly as the
 * C# `ToAsyncEnumerable` iterator does. The C#'s trailing `await Task.CompletedTask` is a
 * C#-iterator-shape artifact with no TypeScript counterpart and is dropped.
 */
async function* toAsyncEnumerable(
  items: readonly FoundSubject[],
  signal: AbortSignal | undefined,
): AsyncGenerator<FoundSubject> {
  for (const item of items) {
    signal?.throwIfAborted();
    yield item;
  }
}

/**
 * `ToWire(PermissionTreeNode)`. Note the two DIFFERENT default policies in this file: an
 * unrecognised NODE throws, while an unrecognised SET OPERATION (below) falls back to Union.
 */
function nodeToWire(node: PermissionTreeNode, evaluator: CaveatEvaluator): ExpandTreeNodeWire {
  const nodeMissing = missingOf(node.caveat, evaluator);
  switch (node.kind) {
    case "leaf":
      return {
        expandedType: node.expanded.objectType,
        expandedId: node.expanded.objectId,
        expandedRelation: node.expanded.relation,
        caveatMissingFields: nodeMissing,
        isLeaf: true,
        operation: "union",
        subjects: node.subjects.map((s) => subjectToWire(s, evaluator)),
        children: [],
      };

    case "setOp":
      return {
        expandedType: node.expanded.objectType,
        expandedId: node.expanded.objectId,
        expandedRelation: node.expanded.relation,
        caveatMissingFields: nodeMissing,
        isLeaf: false,
        operation: setOperationToWire(node.operation),
        subjects: [],
        children: node.children.map((c) => nodeToWire(c, evaluator)),
      };

    default:
      return assertNeverNode(node);
  }
}

/**
 * `NotSupportedException` from a narrow seam: the guide's row says declare it beside the throw
 * rather than inventing a package-wide vocabulary the C# does not have.
 */
export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The C#'s `_ => throw new NotSupportedException(...)` arm: an exhaustiveness check that keeps the
 * source's user-visible message. `node.GetType().Name` has no counterpart, so the discriminant
 * names the node.
 */
function assertNeverNode(node: never): never {
  const kind = (node as { readonly kind?: string }).kind;
  throw new NotSupportedError(`Unknown permission tree node: ${kind}`);
}

/** `ToWire(DirectSubject)`. */
function subjectToWire(subject: DirectSubject, evaluator: CaveatEvaluator): ExpandSubjectWire {
  return {
    subjectType: subject.subject.objectType,
    subjectId: subject.subject.objectId,
    subjectRelation: subject.subject.relation,
    isWildcard: isPublicWildcard(subject.subject),
    caveatMissingFields: missingOf(subject.caveat, evaluator),
  };
}

/**
 * Expand has no request context, so a caveat collapses to its missing parameter names (or empty
 * when the caveat is statically determinable). A definitely-FALSE caveat still surfaces no fields
 * here - the structural tree is NOT pruned by Expand (it carries the structure verbatim), which is
 * why Expand does not reuse `tryCollapse`.
 */
function missingOf(
  caveat: CaveatExpression | undefined,
  evaluator: CaveatEvaluator,
): readonly string[] {
  return caveat === undefined || caveat === null
    ? []
    : evaluator.evaluateExpression(caveat, undefined).missingFields;
}

/** `ToWire(SetOperationType)`: the DEFAULT arm returns Union for anything unrecognised. */
function setOperationToWire(op: SetOperationType): SetOpWire {
  switch (op) {
    case "union":
      return "union";
    case "intersection":
      return "intersection";
    case "exclusion":
      return "exclusion";
    default:
      return "union";
  }
}
