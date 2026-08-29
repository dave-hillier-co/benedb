import { PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import { resolveRevision } from "@spacedb/datastore/revision-resolver";
import type { CaveatEvaluator } from "@spacedb/engine/caveat-evaluator";
import type { CaveatExpression } from "@spacedb/engine/caveat-expression";
import { DEFAULT_MAX_DEPTH } from "@spacedb/engine/check-engine";
import { systemClockNow } from "@spacedb/engine/clock";
import { type ResourceNode, toCoveredCandidates } from "@spacedb/engine/membership-walk";
import type { GrainRuntime } from "@thresh/core/grain-runtime";

import {
  consistencyWireToRequirement,
  type ConsistencyWire,
  MINIMIZE_LATENCY_WIRE,
} from "./consistency-wire";
import { IMembershipWalkGrain, type MembershipClosureReply } from "./i-membership-walk-grain";
import type { SchemaSnapshot } from "./i-schema-provider";
import { membershipWalkKeyBuild } from "./membership-walk-key";
import {
  type MembershipWalkOptions,
  resolveMembershipWalkOptions,
} from "./membership-walk-options";
import {
  caveatedPermissionship,
  PERMISSIONSHIP_MEMBER,
  type Permissionship,
} from "./reverse-ops-dtos";

/**
 * Ported from Spiceport `Grains/ReverseOpsSupport.cs`.
 *
 * The pinning / index-acquisition / caveat-collapse logic shared by `ReverseOps.expandPermissionTree`
 * and the streaming `ReverseOps.streamLookupSubjects` / `ReverseOps.streamLookupResources` ops. Kept
 * as one copy so the snapshot-pinning and collapse rules cannot drift between the unary and
 * streaming paths.
 *
 * Port decisions:
 *   * The C# `ContinueOnCapturedContext` constant and every `.ConfigureAwait(...)` map to NOTHING -
 *     they are deleted rather than given an equivalent (the guide's Concurrency row).
 *   * `internal static class` used as a namespace becomes module-level free functions.
 *   * `bool TryCollapse(..., out Permissionship)` becomes a discriminated result: the C# sets the
 *     out-param to `Member` even on the FALSE return, so a caller reading only the permissionship
 *     silently admits a sheared subject. The three arms are unchanged.
 */

/** The grain seam `AcquireCoveredCandidates` dispatches through. */
export type MembershipWalkGrainFactory = Pick<GrainRuntime, "getGrain">;

/**
 * The C# value-tuple `(DateTimeOffset Now, string Token, IRevision Revision, string? SchemaHash)`,
 * as a named readonly interface (a labelled TS tuple's labels are unchecked).
 */
export interface PinnedRevision {
  /** The evaluation "now", epoch NANOSECONDS in this port (`engine/src/clock.ts`). */
  readonly now: bigint;
  /** The read-at ZedToken minted from the revision actually evaluated. */
  readonly token: string;
  /** The revision actually evaluated. */
  readonly revision: IRevision;
  /** The schema hash the revision pins, carried through UNCHANGED - absent stays absent. */
  readonly schemaHash?: string | undefined;
}

/**
 * Resolves the consistency requirement to the revision actually evaluated and returns the
 * evaluation "now", the read-at token, and the pinned revision + schema hash. Absent consistency
 * (the default) is MinimizeLatency -> the optimized revision.
 *
 * The order of operations is fixed and observable: resolve, THEN `getUniqueId`, THEN mint the
 * token, and "now" is captured LAST - in the return expression, after BOTH awaits. Unlike
 * `RelationshipReads.mintToken`, the token is minted from `resolved.schemaHash` UNCHANGED, with no
 * fallback to the ambient provider hash.
 */
export async function pinRevision(
  datastore: IDatastore,
  consistency: ConsistencyWire | undefined,
  signal: AbortSignal | undefined,
): Promise<PinnedRevision> {
  const requirement = consistencyWireToRequirement(consistency ?? MINIMIZE_LATENCY_WIRE);
  const resolved = await resolveRevision(datastore, requirement, "treatAsFullConsistency", signal);

  const datastoreId = await datastore.getUniqueId(signal);
  const token = zedTokenFromRevision(resolved.revision, resolved.schemaHash, datastoreId).token;
  return {
    // `DateTimeOffset.UtcNow` sits inside the C#'s return expression: after both awaits.
    now: systemClockNow(),
    token,
    revision: resolved.revision,
    schemaHash: resolved.schemaHash,
  };
}

/**
 * Acquires a COMPLETE candidate set for a fresh, unpaged (`hasCursorOrLimit` false)
 * `lookupResources` enumeration of `resourceType`/`permission` via the Leopard membership-walk
 * grain mesh - or ABSENT when the accelerator is disabled, the request is paged/resumed, the target
 * shape is not covered, or either walk reports an incomplete result (a depth-exhausted subtree), in
 * every one of which cases the caller MUST run the live traversal instead.
 *
 * Dispatches TWO root walks - the concrete subject key and its same-type/relation wildcard key (so
 * a `type:*#rel` userset edge is followed too) - and unions their nodes. The two are awaited
 * SEQUENTIALLY, not in parallel: that ordering is observable in mesh grain-call ordering.
 *
 * An EMPTY list is a complete candidate set that happens to be empty and is NOT the same as an
 * absent one, which is why the C# returns `null` rather than `[]` from every decline arm.
 */
export async function acquireCoveredCandidates(
  grainFactory: MembershipWalkGrainFactory,
  options: MembershipWalkOptions,
  schema: SchemaSnapshot,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  resourceType: string,
  permission: string,
  revision: IRevision,
  hasCursorOrLimit: boolean,
  signal: AbortSignal | undefined,
): Promise<readonly string[] | undefined> {
  // Three `ArgumentNullException.ThrowIfNull` calls, ahead of every decline arm.
  if (grainFactory === undefined || grainFactory === null) {
    throw new InvalidArgumentError("grainFactory is required");
  }
  if (options === undefined || options === null) {
    throw new InvalidArgumentError("options is required");
  }
  if (schema === undefined || schema === null) {
    throw new InvalidArgumentError("schema is required");
  }

  // Arm 1.
  const resolvedOptions = resolveMembershipWalkOptions(options);
  if (!resolvedOptions.enabled || hasCursorOrLimit) return undefined;

  // Arm 2: a wildcard subject is not a concrete membership query; leave it to the live engine.
  if (subjectId === PUBLIC_WILDCARD) return undefined;

  // Arm 3: an uncovered shape.
  const coverage = schema.membershipCoverage;
  const yieldRelations = coverage.tryGetYields(resourceType, permission);
  if (yieldRelations === undefined) return undefined;

  const revisionString = revision.toString();
  const schemaHash = schema.schemaHash;

  const concreteReply = await walkRoot(
    grainFactory,
    subjectType,
    subjectId,
    subjectRelation,
    revisionString,
    schemaHash,
    signal,
  );
  const wildcardReply = await walkRoot(
    grainFactory,
    subjectType,
    PUBLIC_WILDCARD,
    subjectRelation,
    revisionString,
    schemaHash,
    signal,
  );

  // Arm 4, checked only after BOTH walks have run: never return a silently short candidate set.
  if (concreteReply.incomplete || wildcardReply.incomplete) return undefined;

  const nodes: ResourceNode[] = [...concreteReply.nodes, ...wildcardReply.nodes].map((n) => ({
    type: n.type,
    id: n.id,
    relation: n.relation,
  }));
  // The shape filter, the reflexive self-membership add and the sort/distinct all live in
  // `toCoveredCandidates`; re-implementing any of them here is how the two callers drift.
  return toCoveredCandidates(nodes, yieldRelations, resourceType, subjectType, subjectId);
}

async function walkRoot(
  grainFactory: MembershipWalkGrainFactory,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  revision: string,
  schemaHash: string,
  signal: AbortSignal | undefined,
): Promise<MembershipClosureReply> {
  const key = membershipWalkKeyBuild(subjectType, subjectId, subjectRelation, revision, schemaHash);
  const grain = grainFactory.getGrain(IMembershipWalkGrain, key);
  // An EMPTY path and the ENGINE's default max depth - never the caller's remaining budget.
  return await grain.getContainingSet({ path: [], depthRemaining: DEFAULT_MAX_DEPTH }, signal);
}

/**
 * The result of {@link tryCollapse}. The C# out-param is set to `Member` even on the false return,
 * so the port makes the sheared arm carry no permissionship at all.
 */
export type CollapseResult =
  /** Definitely excluded: the subject is sheared off entirely. */
  | { readonly included: false }
  /** Included, with the collapsed permissionship (member or caveated). */
  | { readonly included: true; readonly permissionship: Permissionship };

/**
 * Collapses a verbatim caveat against the request context. Reports NOT included when the subject is
 * definitely excluded; otherwise carries the collapsed permissionship (member or caveated).
 */
export function tryCollapse(
  caveat: CaveatExpression | undefined,
  context: ReadonlyMap<string, unknown> | undefined,
  evaluator: CaveatEvaluator,
): CollapseResult {
  if (caveat === undefined || caveat === null) {
    // The evaluator is not consulted at all on this arm.
    return { included: true, permissionship: PERMISSIONSHIP_MEMBER };
  }

  const result = evaluator.evaluateExpression(caveat, context);
  switch (result.outcome) {
    case "definitelyTrue":
      return { included: true, permissionship: PERMISSIONSHIP_MEMBER };
    case "caveated":
      return { included: true, permissionship: caveatedPermissionship(result.missingFields) };
    // The C# `default:` arm, NOT an exhaustiveness site: it deliberately catches
    // `definitelyFalse` and anything else the evaluator could grow.
    default:
      return { included: false };
  }
}
