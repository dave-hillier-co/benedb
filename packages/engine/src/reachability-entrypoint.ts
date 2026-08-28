import type { RelationReference } from "./relation-reference";

/**
 * The kind of structural edge an entrypoint represents, and whether reaching a resource along it
 * is a direct result. Ported from Spiceport `Engine/Reachability/ReachabilityEntrypoint.cs`, which
 * declares two enums plus the record together; they stay in one module because every one of them
 * is a member of the same value.
 *
 * Port decisions:
 *   * BOTH enums mirror SpiceDB proto enum CONCEPTS but carry no explicit numeric values in the
 *     C#, and nothing in this layer serializes them, so they are string-literal unions with NO
 *     wire map (the guide's "an enum that is not wire-visible" row). The only code that ever read
 *     their numbers is `reachability-graph.ts`'s internal dedup key, which is private to the graph.
 *   * The C# record's three defaulted constructor parameters become optional members plus a named
 *     factory that applies the `ConditionalResult` default with `??`, so an explicitly supplied
 *     value survives (the guide's "a default parameter value" row).
 *   * `IsDirectResult` is a computed property, so it becomes the free function
 *     {@link isDirectResult}.
 */

/** The kind of structural edge an entrypoint represents. Port of SpiceDB's entrypoint kinds. */
export type ReachabilityEntrypointKind =
  /** A directly-written base relation (RELATION_ENTRYPOINT). */
  | "relation"
  /** A computed userset rewrite (COMPUTED_USERSET_ENTRYPOINT). */
  | "computedUserset"
  /** A tuple-to-userset arrow (TUPLESET_TO_USERSET_ENTRYPOINT). */
  | "tupleToUserset"
  /** The resource itself treated as a subject (SELF_ENTRYPOINT). */
  | "self";

/**
 * Whether an entrypoint produces a direct result or one that must be re-validated.
 * Port of `DIRECT_OPERATION_RESULT` vs `REACHABLE_CONDITIONAL_RESULT`.
 */
export type EntrypointResultStatus =
  /** Under a pure union: a reached resource is genuinely a member along this edge. */
  | "directResult"
  /** Under an intersection/exclusion/`.all()`: reachability must be confirmed via Check. */
  | "conditionalResult";

/**
 * A productive edge in the reachability graph: a way a subject of some type can structurally reach
 * a containing relation. Port of SpiceDB's `core.ReachabilityEntrypoint` paired with its
 * `parentRelation`.
 */
export interface ReachabilityEntrypoint {
  /** The kind of structural edge. */
  readonly kind: ReachabilityEntrypointKind;
  /**
   * The relation this entrypoint lives on (the containing relation the edge reaches), i.e.
   * SpiceDB's `parentRelation`.
   */
  readonly targetRelation: RelationReference;
  /**
   * The containing relation; equal to {@link targetRelation} in this two-level model. Both fields
   * are kept because call sites read both.
   */
  readonly containingRelation: RelationReference;
  /** For ComputedUserset and TupleToUserset edges, the computed relation. */
  readonly computedUsersetRelation?: string | undefined;
  /** For TupleToUserset edges, the tupleset relation that is traversed. */
  readonly tuplesetRelation?: string | undefined;
  /** Whether this is a direct or conditional result. */
  readonly resultStatus: EntrypointResultStatus;
}

/** The arguments of {@link createReachabilityEntrypoint}; mirrors the C# constructor parameters. */
export interface ReachabilityEntrypointInit {
  readonly kind: ReachabilityEntrypointKind;
  readonly targetRelation: RelationReference;
  readonly containingRelation: RelationReference;
  readonly computedUsersetRelation?: string | undefined;
  readonly tuplesetRelation?: string | undefined;
  readonly resultStatus?: EntrypointResultStatus | undefined;
}

/**
 * Creates a {@link ReachabilityEntrypoint}, defaulting the result status to `conditionalResult`
 * exactly as the C# constructor does.
 */
export function createReachabilityEntrypoint(
  init: ReachabilityEntrypointInit,
): ReachabilityEntrypoint {
  return {
    kind: init.kind,
    targetRelation: init.targetRelation,
    containingRelation: init.containingRelation,
    computedUsersetRelation: init.computedUsersetRelation,
    tuplesetRelation: init.tuplesetRelation,
    // `??`, not `||`: an explicitly supplied status survives, including a future falsy value.
    resultStatus: init.resultStatus ?? "conditionalResult",
  };
}

/**
 * True when a resource reached via this entrypoint is genuinely a member (the edge is under a pure
 * union), so no confirming Check is required. Port of the record's `IsDirectResult` property.
 */
export function isDirectResult(entrypoint: ReachabilityEntrypoint): boolean {
  return entrypoint.resultStatus === "directResult";
}
