import type { CaveatDefinition } from "@benedb/core/caveat-definition";
import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { Relationship } from "@benedb/core/relationship";
import type { RelationshipReference } from "@benedb/core/relationship-reference";
import type { IGraphReader } from "@benedb/datastore/i-graph-reader";
import type { SubjectRelationFilter, SubjectsFilter } from "@benedb/datastore/relationships-filter";
import { SUBJECT_RELATION_FILTER_ANY } from "@benedb/datastore/relationships-filter";
import type { ReverseQueryOptions } from "@benedb/datastore/reverse-query-options";

import { CaveatEvaluator } from "./caveat-evaluator";
import { CheckEngine } from "./check-engine";
import { systemClockNow } from "./clock";
import { createFoundResource, type FoundResource } from "./found-resource";
import {
  createLookupResourcesCursor,
  createLookupResourcesCursorSection,
  type LookupResourcesCursor,
  type LookupResourcesCursorSection,
} from "./lookup-resources-cursor";
import type { Membership } from "./membership";
import { isDirectResult, type ReachabilityEntrypoint } from "./reachability-entrypoint";
import { buildReachabilityGraph, type ReachabilityGraph } from "./reachability-graph";
import { relationReferenceKey, type RelationReference } from "./relation-reference";

/** The default maximum recursion depth. */
export const DEFAULT_MAX_DEPTH = 50;

/**
 * How many raw relationships a query entrypoint consumes per streamed chunk. The datastore keyset
 * advances one chunk at a time, so chunk boundaries must be deterministic over the ordered stream;
 * chunking by a fixed raw count satisfies that.
 */
const CHUNK_SIZE = 100;

/** The sentinel entrypoint index marking a resume within Portion #1 (the self-match results). */
const PORTION_1_SECTION = -1;

/**
 * A resource candidate's back-mapping: which input subject ids reached it, its membership so far,
 * and any accumulated missing caveat params.
 */
interface ResourceState {
  readonly forSubjectIds: readonly string[];
  readonly membership: Membership;
  readonly missing: readonly string[];
}

/** One streamed chunk of candidate resources plus the datastore keyset of its final relationship. */
interface CandidateChunk {
  readonly candidates: Map<string, ResourceState>;
  readonly lastKeyset: RelationshipReference;
}

/**
 * Enumerates the resources of a given type/permission that a subject can reach, using the schema's
 * reachability graph to follow only productive edges (reverse traversal).
 *
 * Ported from Spiceport `src/Spiceport.Server/Engine/Lookup/LookupResourcesEngine.cs`; port of
 * SpiceDB's `internal/graph/lookupresources3.go`. This is the only API that consults the
 * reachability graph and `reverseQueryRelationships`. Results stream, so a caller applies a limit
 * simply by stopping enumeration.
 *
 * Correctness for intersection / exclusion is achieved the way SpiceDB does it: compute a
 * candidate set via reverse traversal, then confirm each candidate with the trusted
 * {@link CheckEngine} (no second exclusion implementation). Caveated candidate relationships are
 * sheared early against the request context; partial caveats survive and surface as `"caveated"`
 * with `missingContextParams`. Recursion is bounded by a depth limit and a visited-set cycle guard.
 *
 * Port decisions:
 *   * The two `LookupResources` OVERLOADS differ by a `coveredCandidateIds` parameter inserted
 *     POSITIONALLY IN THE MIDDLE, so they become two distinctly named methods per the guide's
 *     overload row: {@link lookupResources} (the live traversal) and
 *     {@link lookupResourcesWithCandidates} (the Leopard accelerator's confirm-only path).
 *   * STREAMING: the C# `IAsyncEnumerable` here is genuinely SINGLE-PASS (a cursored traversal),
 *     so `async function*` is correct - this is not the guide's "yield return -> array" case.
 *   * `[EnumeratorCancellation] CancellationToken` becomes a trailing `signal?: AbortSignal`,
 *     checked in the generators' loops and forwarded to the reader.
 *   * ORDINAL COMPARISON throughout: `string.CompareOrdinal(id, skip1) <= 0` becomes `id <= skip1`
 *     and `OrderBy(x => x, StringComparer.Ordinal)` becomes `[...xs].sort()`. This ordering IS the
 *     cursor: a different collation makes a resumed page skip or repeat results.
 *   * NO GLOBAL DEDUP, deliberately: see the comment in {@link lookupResourcesWithCandidates}.
 *   * The private `IsExpired` is DEAD CODE in the C# - the datastore filters expiration on the
 *     reverse path - so it is dropped rather than ported as an unused function.
 *   * The three C# constructors collapse to one `(namespaces, caveats?, reachability?, maxDepth?)`.
 *     The C# `(namespaces, maxDepth)` overload cannot be told apart positionally from
 *     `(namespaces, caveats)` in TypeScript, so it is the one form that does not survive.
 *   * `evaluationTime` is epoch NANOSECONDS as a `bigint`, as everywhere else in this package.
 */
export class LookupResourcesEngine {
  readonly #reachability: ReachabilityGraph;
  readonly #check: CheckEngine;
  readonly #caveats: CaveatEvaluator;
  readonly #maxDepth: number;

  /**
   * Creates a lookup-resources engine over the given schema definitions.
   *
   * @param namespaces The compiled namespace definitions that make up the schema.
   * @param caveats The compiled caveat definitions, or absent if the schema has none.
   * @param reachability A pre-built First-mode reachability graph. The production caller passes
   * the schema snapshot's graph so it is built once per schema, not once per request; when absent
   * the engine builds its own (test ergonomics).
   * @param maxDepth The maximum recursion depth before traversal stops.
   */
  constructor(
    namespaces: Iterable<NamespaceDefinition>,
    caveats?: Iterable<CaveatDefinition> | undefined,
    reachability?: ReachabilityGraph | undefined,
    maxDepth?: number | undefined,
  ) {
    if (namespaces === undefined || namespaces === null) {
      throw new InvalidArgumentError("namespaces is required");
    }
    const byName = new Map<string, NamespaceDefinition>();
    for (const ns of namespaces) {
      // `namespaces.ToImmutableDictionary(ns => ns.Name)` throws on a duplicate key; a bare
      // `Map.set` would let the last definition silently win, analysing a schema the C# refuses.
      if (byName.has(ns.name)) {
        throw new InvalidArgumentError(
          `An item with the same key has already been added. Key: ${ns.name}`,
        );
      }
      byName.set(ns.name, ns);
    }
    // The C# keeps a `_namespaces` field, but only reads it once to construct the CheckEngine, so
    // the port keeps the map as a constructor local rather than an unused field.
    const caveatList = caveats === undefined ? undefined : [...caveats];
    this.#reachability = reachability ?? buildReachabilityGraph(byName, "first");
    this.#check = new CheckEngine(byName.values(), caveatList, maxDepth);
    this.#caveats = new CaveatEvaluator(caveatList ?? []);
    this.#maxDepth = maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /**
   * Enumerates the resources of `resourceType` on which
   * `subjectType`:`subjectId`(#`subjectRelation`) holds `permission`, as of the reader's snapshot.
   *
   * @param reader A graph reader pinned to the revision to evaluate against.
   * @param subjectType The subject namespace.
   * @param subjectId The subject object id.
   * @param subjectRelation The subject relation; ellipsis for terminal subjects.
   * @param resourceType The resource namespace to enumerate.
   * @param permission The relation or permission to enumerate.
   * @param caveatContext Optional request-time caveat context.
   * @param evaluationTime Optional pinned "now" (epoch nanoseconds) for expiration filtering.
   * @param cursor Optional resume token from a prior partial enumeration.
   * @param limit Optional soft limit; the caller may also simply stop enumerating.
   * @param signal A cancellation signal.
   */
  lookupResources(
    reader: IGraphReader,
    subjectType: string,
    subjectId: string,
    subjectRelation: string,
    resourceType: string,
    permission: string,
    caveatContext?: ReadonlyMap<string, unknown> | undefined,
    evaluationTime?: bigint | undefined,
    cursor?: LookupResourcesCursor | undefined,
    limit?: number | undefined,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<FoundResource> {
    return this.lookupResourcesWithCandidates(
      reader,
      subjectType,
      subjectId,
      subjectRelation,
      resourceType,
      permission,
      undefined,
      caveatContext,
      evaluationTime,
      cursor,
      limit,
      signal,
    );
  }

  /**
   * As {@link lookupResources}, but offered an optional pre-computed COMPLETE candidate set (the
   * Leopard membership-walk accelerator's output). The only legitimate producer dispatches the
   * walk grains, confirms the reply is not partial, and filters to this exact
   * (resourceType, permission) shape before calling here. When supplied, this method just confirms
   * each id with the same trusted {@link CheckEngine} the live path uses - so verdicts are
   * identical to the live traversal, and an over-broad candidate set can only add Check work.
   *
   * The cursor/limit guard that gated the old in-engine fast path lives entirely in the caller (a
   * candidate set is only ever produced for a fresh, unpaged enumeration), so this method does not
   * re-check them: passing a non-absent `coveredCandidateIds` always takes that path. An EMPTY
   * list is a complete candidate set that happens to be empty, and is not the same as an absent
   * one.
   */
  async *lookupResourcesWithCandidates(
    reader: IGraphReader,
    subjectType: string,
    subjectId: string,
    subjectRelation: string,
    resourceType: string,
    permission: string,
    coveredCandidateIds: readonly string[] | undefined,
    caveatContext?: ReadonlyMap<string, unknown> | undefined,
    evaluationTime?: bigint | undefined,
    cursor?: LookupResourcesCursor | undefined,
    limit?: number | undefined,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<FoundResource> {
    // `ArgumentException.ThrowIfNullOrEmpty` on four parameters. Kept even though the TypeScript
    // types are non-optional, because the grain-layer caller is untyped. Like the C# iterator,
    // these run on the first `next()`, not at the call.
    if (reader === undefined || reader === null) {
      throw new InvalidArgumentError("reader is required");
    }
    throwIfNullOrEmpty(subjectType, "subjectType");
    throwIfNullOrEmpty(subjectId, "subjectId");
    throwIfNullOrEmpty(resourceType, "resourceType");
    throwIfNullOrEmpty(permission, "permission");

    const now = evaluationTime ?? systemClockNow();
    const target: RelationReference = { namespace: resourceType, relation: permission };
    const subjectRel: RelationReference = { namespace: subjectType, relation: subjectRelation };
    const terminalSubject: ObjectAndRelation = {
      objectType: subjectType,
      objectId: subjectId,
      relation: subjectRelation,
    };
    const sections = cursor?.sections ?? [];

    // Leopard fast path: the caller has already decided this is a fresh, unpaged enumeration of a
    // covered shape and produced a COMPLETE candidate set; Check confirms each, so the result set
    // equals the live traversal's.
    if (coveredCandidateIds !== undefined) {
      for (const resourceId of coveredCandidateIds) {
        signal?.throwIfAborted();
        const resource: ObjectAndRelation = {
          objectType: resourceType,
          objectId: resourceId,
          relation: permission,
        };
        const result = await this.#check.checkOnr(
          reader,
          resource,
          terminalSubject,
          caveatContext,
          now,
          undefined,
          signal,
        );
        if (result.verdict === "member") {
          yield createFoundResource(resourceId, [subjectId], "member");
        } else if (result.verdict === "caveated") {
          yield createFoundResource(resourceId, [subjectId], "caveated", result.missingExprFields);
        }
      }
      return;
    }

    // Working set keyed by resource id; the initial subject maps to itself.
    const initial = new Map<string, ResourceState>([
      [subjectId, { forSubjectIds: [subjectId], membership: "member", missing: [] }],
    ]);

    // No global dedup: like SpiceDB, the traversal is a single deterministic stream and the cursor
    // is a position in it, so a resource reachable via several entrypoints is emitted once per
    // entrypoint. This is what makes a paged enumeration equal the unpaged one - a bounded cursor
    // cannot carry a cross-page "already seen" set. Within a chunk, duplicate (resource, subject)
    // pairs are still merged.
    let emitted = 0;
    for await (const found of this.#lookupRec(
      reader,
      subjectRel,
      initial,
      target,
      terminalSubject,
      caveatContext,
      now,
      this.#maxDepth,
      new Set<string>(),
      sections,
      signal,
    )) {
      yield found;
      emitted++;
      if (limit !== undefined && emitted >= limit) {
        return;
      }
    }
  }

  // Finds resources of `target` reachable from the given subjects (keyed by id with back-mapping).
  async *#lookupRec(
    reader: IGraphReader,
    subjectRel: RelationReference,
    subjects: ReadonlyMap<string, ResourceState>,
    target: RelationReference,
    terminalSubject: ObjectAndRelation,
    caveatContext: ReadonlyMap<string, unknown> | undefined,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    cursorSections: readonly LookupResourcesCursorSection[],
    signal: AbortSignal | undefined,
  ): AsyncGenerator<FoundResource> {
    signal?.throwIfAborted();
    if (subjects.size === 0) {
      return;
    }

    // The cursor section (if any) for this nesting level positions the resume; deeper sections
    // position the levels below. A sentinel entrypoint index of -1 marks a resume *within* Portion
    // #1 (the self-match results); a non-negative index marks a resume in Portion #2, meaning
    // Portion #1 was already fully drained on a prior page and must be skipped entirely here.
    const thisSection = cursorSections.length > 0 ? cursorSections[0] : undefined;
    const deeperSections: readonly LookupResourcesCursorSection[] =
      cursorSections.length > 0 ? cursorSections.slice(1) : [];

    const resumingPortion2 = thisSection !== undefined && thisSection.entrypointIndex >= 0;

    // Portion #1: the subjects already ARE resources of the target relation. We still fall through
    // to Portion #2 afterwards: when the target is a *recursive* relation (one admitting a userset
    // subject of its own (namespace, relation), e.g. `member: user | group#member`), a matched
    // userset is simultaneously a resource AND a subject of further resources up the chain, so the
    // reverse walk must continue. For the common terminal case Portion #2 yields nothing.
    if (
      subjectRel.namespace === target.namespace &&
      subjectRel.relation === target.relation &&
      !resumingPortion2
    ) {
      const portion1SkipUpTo =
        thisSection !== undefined && thisSection.entrypointIndex === PORTION_1_SECTION
          ? thisSection.lastResourceId
          : undefined;

      for (const id of [...subjects.keys()].sort()) {
        // `string.CompareOrdinal(id, skip1) <= 0`: JS `<=` on strings IS ordinal comparison.
        if (portion1SkipUpTo !== undefined && id <= portion1SkipUpTo) {
          continue;
        }

        const state = subjects.get(id)!;
        // Decorate every self-match with a single-section leaf cursor; parent levels prepend their
        // own sections as it bubbles up, building the full nesting stack.
        const cursorOut = createLookupResourcesCursor([
          createLookupResourcesCursorSection(PORTION_1_SECTION, id),
        ]);
        yield {
          ...createFoundResource(id, state.forSubjectIds, state.membership, state.missing),
          afterCursor: cursorOut,
        };
      }
    }

    const subjectIds = [...subjects.keys()].sort();

    // Cycle guard keyed by (relation, subject-id set): a same-relation chain with new ids may
    // continue, but a revisit of the same relation over the same ids (cyclic data) stops.
    //
    // DIVERGENCE, stated deliberately: the C# builds `$"{ns}#{rel}|{string.Join(",", subjectIds)}"`,
    // which is NOT injective - SpiceDB object ids legally contain both "," and "|", so two distinct
    // id sets can collide and silently prune a live branch. The port guide prescribes
    // length-prefixing, so each part is length-prefixed here.
    const visitKey = `${relationReferenceKey(subjectRel)}|${subjectIds
      .map((id) => `${id.length}:${id}`)
      .join(",")}`;
    if (depthRemaining <= 0 || visited.has(visitKey)) {
      return;
    }
    // `visited.Add(visitKey)` on an ImmutableHashSet returns a NEW set; the caller's must be
    // untouched, so this copies rather than mutating.
    const visitedHere: ReadonlySet<string> = new Set(visited).add(visitKey);

    // Portion #2: entrypoint-pruned reverse traversal.
    const entrypoints = this.#reachability.entrypointsForSubjectToResource(
      subjectRel,
      target,
      false,
    );
    if (entrypoints.length === 0) {
      return;
    }

    // Only honour the section's entrypoint index when it is a Portion #2 section (>= 0). A Portion
    // #1 section (-1) means "resume mid self-match"; Portion #2 then starts from its first
    // entrypoint.
    const p2Section =
      thisSection !== undefined && thisSection.entrypointIndex >= 0 ? thisSection : undefined;

    for (let epIndex = 0; epIndex < entrypoints.length; epIndex++) {
      signal?.throwIfAborted();

      // Entrypoints before the resumed one were fully drained on a prior page; skip them.
      if (p2Section !== undefined && epIndex < p2Section.entrypointIndex) {
        continue;
      }

      const isResumeEp = p2Section !== undefined && epIndex === p2Section.entrypointIndex;
      const entrypoint = entrypoints[epIndex]!;

      if (entrypoint.kind === "self" || entrypoint.kind === "computedUserset") {
        // Structural rewrite: re-key the (bounded) input subject set as the containing relation and
        // recurse once. No datastore scan, so the within-level position is carried entirely by the
        // deeper sections; the section emitted for this level is structural (absent keyset).
        let candidates = new Map<string, ResourceState>();
        for (const id of subjectIds) {
          merge(candidates, id, subjects.get(id)!);
        }

        if (!isDirectResult(entrypoint)) {
          candidates = await this.#filterByCheck(
            reader,
            entrypoint.containingRelation,
            candidates,
            terminalSubject,
            caveatContext,
            now,
            signal,
          );
        }
        if (candidates.size === 0) {
          continue;
        }

        const innerSections: readonly LookupResourcesCursorSection[] = isResumeEp
          ? deeperSections
          : [];
        const section = createLookupResourcesCursorSection(epIndex);
        for await (const found of this.#lookupRec(
          reader,
          entrypoint.containingRelation,
          candidates,
          target,
          terminalSubject,
          caveatContext,
          now,
          depthRemaining - 1,
          visitedHere,
          innerSections,
          signal,
        )) {
          yield prepend(found, section);
        }
        continue;
      }

      // Query entrypoint (Relation / arrow): stream the reverse query in the deterministic
      // BySubject order, in fixed-size chunks, resuming after the keyset carried in the cursor.
      // Each emitted result's section keyset is the PRIOR chunk's final relationship, so resuming
      // re-fetches the in-progress chunk and re-positions within it via the deeper sections.
      const afterKeyset = isResumeEp ? p2Section!.afterKeyset : undefined;
      let sectionKeyset = afterKeyset;
      let firstChunk = true;

      for await (const chunk of this.#streamCandidateChunks(
        reader,
        entrypoint,
        subjectRel,
        subjectIds,
        subjects,
        caveatContext,
        afterKeyset,
        signal,
      )) {
        let candidates = chunk.candidates;
        if (candidates.size > 0 && !isDirectResult(entrypoint)) {
          candidates = await this.#filterByCheck(
            reader,
            entrypoint.containingRelation,
            candidates,
            terminalSubject,
            caveatContext,
            now,
            signal,
          );
        }

        if (candidates.size > 0) {
          const innerSections: readonly LookupResourcesCursorSection[] =
            firstChunk && isResumeEp ? deeperSections : [];
          const section = createLookupResourcesCursorSection(epIndex, undefined, sectionKeyset);
          for await (const found of this.#lookupRec(
            reader,
            entrypoint.containingRelation,
            candidates,
            target,
            terminalSubject,
            caveatContext,
            now,
            depthRemaining - 1,
            visitedHere,
            innerSections,
            signal,
          )) {
            yield prepend(found, section);
          }
        }

        sectionKeyset = chunk.lastKeyset;
        firstChunk = false;
      }
    }
  }

  /**
   * Streams candidate resources of a query entrypoint's containing relation in the deterministic
   * BySubject order, grouped into fixed-size chunks, applying early caveat shearing. A chunk's
   * `lastKeyset` is the last raw relationship consumed, so resuming the scan after it continues
   * exactly where the chunk ended. Port of SpiceDB's `relationshipsChunk` stream.
   */
  async *#streamCandidateChunks(
    reader: IGraphReader,
    entrypoint: ReachabilityEntrypoint,
    subjectRel: RelationReference,
    subjectIds: readonly string[],
    subjects: ReadonlyMap<string, ResourceState>,
    caveatContext: ReadonlyMap<string, unknown> | undefined,
    afterKeyset: RelationshipReference | undefined,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<CandidateChunk> {
    const filter = buildEntrypointFilter(entrypoint, subjectRel, subjectIds);
    const options: ReverseQueryOptions = { sort: "bySubject", after: afterKeyset };

    // The datastore already applies expiration + the subject/resource filter and yields in
    // BySubject order, so each yielded relationship is a real, deterministic stream position. We
    // chunk by raw count so chunk boundaries reproduce exactly on resume.
    let current = new Map<string, ResourceState>();
    let last: RelationshipReference | undefined;
    let count = 0;

    for await (const rel of reader.reverseQueryRelationships(filter, options, signal)) {
      this.#addCandidate(current, rel, subjects, caveatContext);
      last = rel.reference;
      if (++count < CHUNK_SIZE) {
        continue;
      }

      yield { candidates: current, lastKeyset: last };
      // The C# reassigns the producer's dictionary AFTER yielding the struct that wraps it, so the
      // consumer keeps the yielded map and the producer starts a fresh one; never reuse it.
      current = new Map<string, ResourceState>();
      count = 0;
    }

    if (count > 0) {
      // `last!` in the C#, valid only because `count > 0` implies at least one relationship.
      yield { candidates: current, lastKeyset: last! };
    }
  }

  /** Confirms candidates via Check against the terminal subject, keeping Member/Caveated. */
  async #filterByCheck(
    reader: IGraphReader,
    containingRelation: RelationReference,
    candidates: ReadonlyMap<string, ResourceState>,
    terminalSubject: ObjectAndRelation,
    caveatContext: ReadonlyMap<string, unknown> | undefined,
    now: bigint,
    signal: AbortSignal | undefined,
  ): Promise<Map<string, ResourceState>> {
    const filtered = new Map<string, ResourceState>();
    for (const [resourceId, state] of candidates) {
      signal?.throwIfAborted();
      const result = await this.#check.checkOnr(
        reader,
        {
          objectType: containingRelation.namespace,
          objectId: resourceId,
          relation: containingRelation.relation,
        },
        terminalSubject,
        caveatContext,
        now,
        undefined,
        signal,
      );

      if (result.verdict === "member") {
        filtered.set(resourceId, { ...state, membership: "member", missing: [] });
      } else if (result.verdict === "caveated") {
        const missing = new Set<string>(state.missing);
        for (const f of result.missingExprFields) {
          missing.add(f);
        }
        filtered.set(resourceId, { ...state, membership: "caveated", missing: [...missing] });
      }
    }
    return filtered;
  }

  /** Adds a found relationship as a candidate resource, shearing its caveat early. */
  #addCandidate(
    result: Map<string, ResourceState>,
    rel: Relationship,
    subjects: ReadonlyMap<string, ResourceState>,
    caveatContext: ReadonlyMap<string, unknown> | undefined,
  ): void {
    // Which input subject(s) does this relationship's subject map back to? A wildcard subject
    // matches every input subject of the type.
    const subjectId = rel.reference.subject.objectId;
    let backIds: readonly string[];
    if (subjectId === PUBLIC_WILDCARD) {
      backIds = [...subjects.keys()];
    } else if (subjects.has(subjectId)) {
      backIds = [subjectId];
    } else {
      return;
    }

    // Caveat shearing against the request context.
    let membership: Membership = "member";
    const localMissing: string[] = [];
    const caveat = rel.optionalCaveat;
    if (caveat !== undefined) {
      const evaluated = this.#caveats.evaluate(caveat.caveatName, caveat.context, caveatContext);
      switch (evaluated.outcome) {
        case "definitelyFalse":
          return; // sheared off.
        case "caveated":
          membership = "caveated";
          localMissing.push(...evaluated.missingFields);
          break;
      }
    }

    // Back-map and union the originating subject states.
    const forSubjectIds = new Set<string>();
    const missing = new Set<string>(localMissing);
    for (const b of backIds) {
      const s = subjects.get(b)!;
      for (const fid of s.forSubjectIds) {
        forSubjectIds.add(fid);
      }
      for (const f of s.missing) {
        missing.add(f);
      }
      if (s.membership === "caveated") {
        membership = "caveated";
      }
    }

    const finalMissing: readonly string[] = membership === "caveated" ? [...missing] : [];
    const state: ResourceState = {
      forSubjectIds: [...forSubjectIds].sort(),
      membership,
      missing: finalMissing,
    };

    merge(result, rel.reference.resource.objectId, state);
  }
}

/** `ArgumentException.ThrowIfNullOrEmpty`. Whitespace is not empty. */
function throwIfNullOrEmpty(value: string, name: string): void {
  if (value === undefined || value === null || value === "") {
    throw new InvalidArgumentError(`${name} must not be null or empty`);
  }
}

/** Prepends this nesting level's resume section onto a bubbled-up result's cursor stack. */
function prepend(found: FoundResource, section: LookupResourcesCursorSection): FoundResource {
  const inner = found.afterCursor?.sections ?? [];
  return { ...found, afterCursor: createLookupResourcesCursor([section, ...inner]) };
}

/** Builds the subject-side filter for a query entrypoint (Relation or arrow). */
function buildEntrypointFilter(
  entrypoint: ReachabilityEntrypoint,
  subjectRel: RelationReference,
  subjectIds: readonly string[],
): SubjectsFilter {
  if (entrypoint.kind === "tupleToUserset") {
    // Arrow: reverse-query the tupleset relation of the containing namespace. Arrows ignore the
    // subject's own relation, so match on namespace only.
    return {
      subjectType: subjectRel.namespace,
      optionalSubjectIds: subjectIds,
      relationFilter: SUBJECT_RELATION_FILTER_ANY,
      optionalResourceType: entrypoint.containingRelation.namespace,
      optionalResourceRelation: entrypoint.tuplesetRelation!,
    };
  }

  return buildSubjectsFilter(
    subjectRel,
    subjectIds,
    entrypoint.targetRelation,
    subjectRel.relation === ELLIPSIS,
  );
}

function buildSubjectsFilter(
  subjectRel: RelationReference,
  subjectIds: readonly string[],
  targetRelation: RelationReference,
  includeWildcard: boolean,
): SubjectsFilter {
  const ids = includeWildcard ? [...subjectIds, PUBLIC_WILDCARD] : subjectIds;

  const relFilter: SubjectRelationFilter =
    subjectRel.relation === ELLIPSIS
      ? { includeEllipsisRelation: true }
      : { nonEllipsisRelation: subjectRel.relation };

  return {
    subjectType: subjectRel.namespace,
    optionalSubjectIds: ids,
    relationFilter: relFilter,
    optionalResourceType: targetRelation.namespace,
    optionalResourceRelation: targetRelation.relation,
  };
}

function merge(into: Map<string, ResourceState>, resourceId: string, state: ResourceState): void {
  const existing = into.get(resourceId);
  if (existing === undefined) {
    into.set(resourceId, state);
    return;
  }

  const forSubjects = new Set<string>(existing.forSubjectIds);
  for (const f of state.forSubjectIds) {
    forSubjects.add(f);
  }

  // Member dominates Caveated (a non-caveated path makes the resource an unconditional member).
  let membership: Membership;
  let missing: readonly string[];
  if (existing.membership === "member" || state.membership === "member") {
    membership = "member";
    missing = [];
  } else {
    membership = "caveated";
    const m = new Set<string>(existing.missing);
    for (const f of state.missing) {
      m.add(f);
    }
    missing = [...m];
  }

  into.set(resourceId, { forSubjectIds: [...forSubjects].sort(), membership, missing });
}
