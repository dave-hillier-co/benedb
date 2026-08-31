import type { IRevision } from "@benedb/core/i-revision";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { isPublicWildcard, type ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { SetOperationType } from "@benedb/core/userset-rewrite";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import { CaveatEvaluator } from "@benedb/engine/caveat-evaluator";
import type { CaveatExpression } from "@benedb/engine/caveat-expression";
import { ExpandEngine } from "@benedb/engine/expand-engine";
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
  encodeLookupResourcesCursor,
  encodeSubjectId,
} from "./reverse-ops-cursor-codec";
import {
  caveatedPermissionship,
  type ExpandSubjectWire,
  type ExpandTreeArgs,
  type ExpandTreeNodeWire,
  type ExpandTreeReply,
  type FoundResourceWire,
  type FoundSubjectStreamItem,
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
    const after = decodeSubjectId(args.cursor);

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

      // NOTE: FoundSubject.excludedSubjects (wildcard exclusions) are not yet carried over the wire
      // - FoundSubjectWire has no excluded-subjects field, so the client-facing shape drops them.
      // The engine (and the memoized frontier, which mirrors it byte-for-byte) preserves them
      // internally; only this client-edge wire shape drops them.
      const subject = {
        subjectId: found.subjectId,
        isWildcard: found.isWildcard,
        permissionship: collapsed.permissionship,
      };
      yield {
        subject,
        resumeCursor: encodeSubjectId(found.subjectId),
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
   * a time, each with the opaque cursor positioned immediately after it. When `limit` is set this
   * runs the cursor-bearing live traversal (so every item carries a resume cursor); an unlimited,
   * cursorless enumeration may take the Leopard fast path (a complete candidate set confirmed by
   * Check). The caller applies any client limit by stopping.
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
    const startCursor = decodeLookupResourcesCursor(args.cursor);

    // A supplied client limit means the caller needs per-item resume cursors: pass the limit into
    // the engine so it runs the cursor-bearing live traversal. A limit of ZERO or negative becomes
    // UNLIMITED, not a zero-result read.
    const limit = args.limit !== undefined && args.limit > 0 ? args.limit : undefined;

    // The Leopard accelerator (absent unless it decides this request is a fresh, unpaged
    // enumeration of a covered shape). `hasCursorOrLimit` tests the DERIVED limit, so `limit = 0`
    // does NOT block the fast path while a present cursor - including an EMPTY one, which is still
    // `not null` in the C# - does.
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

    for await (const found of engine.lookupResourcesWithCandidates(
      this.#readerSource.graphReaderAt(pinned.revision),
      args.subjectType,
      args.subjectId,
      args.subjectRelation,
      args.resourceType,
      args.permission,
      candidates,
      args.context,
      pinned.now,
      startCursor,
      limit,
      signal,
    )) {
      // Anything that is not caveated - including a non-member, which the engine never yields -
      // becomes Member. The else arm is unconditional, not a third case.
      const permissionship =
        found.membership === "caveated"
          ? caveatedPermissionship(found.missingContextParams)
          : PERMISSIONSHIP_MEMBER;
      yield {
        resourceId: found.resourceId,
        permissionship,
        afterResultCursor: encodeLookupResourcesCursor(found.afterCursor),
        lookedUpAtToken: pinned.token,
      };
    }
  }
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
