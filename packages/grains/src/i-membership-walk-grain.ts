import { defineGrainInterface } from "@thresh/core/grain-interface";
import type { GrainWithStringKey } from "@thresh/core/key-kinds";

/**
 * One node of a walked membership closure: the (type, id, relation) of a resource a subject was
 * found directly named on.
 */
export interface ResourceNodeWire {
  /** The resource's namespace. */
  readonly type: string;
  /** The resource's id. */
  readonly id: string;
  /** The relation the subject was named on. */
  readonly relation: string;
}

/**
 * The canonical key for a `ResourceNodeWire` used in a `Map`/`Set`.
 *
 * The C# record gets structural equality free, which is what lets these nodes live in a `HashSet`
 * and dedupe the union of a walk's children. A JS `Set` keys by REFERENCE, so the port needs a
 * canonical key - and it must be injective UNCONDITIONALLY, as the equality it replaces is. The
 * fields are LENGTH-PREFIXED rather than joined on a separator "ids cannot contain": ids
 * demonstrably can, which is exactly why the grain-key codec escapes them.
 */
export function resourceNodeKey(node: ResourceNodeWire): string {
  return `${node.type.length}:${node.type}|${node.id.length}:${node.id}|${node.relation.length}:${node.relation}`;
}

/**
 * The argument to `IMembershipWalkGrain.getContainingSet`: the exact ancestor path this call is
 * arriving on (canonical subject-key strings, root first) and the remaining recursion budget.
 */
export interface MembershipWalkArgs {
  /**
   * The canonical subject-key strings (`type:id#relation`) of every ancestor on the call stack that
   * led to this grain, root first. Unlike `ICheckGrain`'s probabilistic traversal bloom, this is an
   * EXACT list: a false-positive skip here would silently drop a whole subtree of candidates (an
   * incomplete result), which the bounded traversal bloom's rare false positive cannot risk for a
   * completeness-critical candidate walk.
   *
   * It is threaded through recursion, so the port guide's immutable-set-in-recursion rule applies
   * at every call site: COPY at the call (`[...args.path, childKey]`), never push onto an array the
   * caller still holds. A shared mutable array compiles, passes every single-path test, then prunes
   * a live sibling branch because an earlier sibling already visited the key.
   */
  readonly path: readonly string[];
  /** The recursion budget remaining, decremented by one per hop. C# `int`. */
  readonly depthRemaining: number;
}

/**
 * The reply from `IMembershipWalkGrain.getContainingSet`: every resource node reachable from this
 * grain's subject key (its own direct parents plus everything its children's replies contributed),
 * and whether the result is trustworthy as a COMPLETE candidate set.
 */
export interface MembershipClosureReply {
  /** The union of this grain's direct parents and every child's reported nodes. */
  readonly nodes: readonly ResourceNodeWire[];
  /**
   * True if a direct parent's subject-key-as-child was already on the caller's
   * `MembershipWalkArgs.path` (a genuine back-edge) and was therefore skipped rather than recursed
   * into. A path-hit cut is still COMPLETE for reachability (the ancestor is already accounted for
   * via the path that reached it first), so, unlike Check's cycle-cut, this does not itself force
   * `incomplete`.
   */
  readonly cycleCut: boolean;
  /**
   * True if `MembershipWalkArgs.depthRemaining` was exhausted before the walk could recurse into
   * every parent - the reply is a PARTIAL candidate set and the caller MUST fall back to the live
   * traversal rather than trust it as complete.
   */
  readonly incomplete: boolean;
}

/**
 * A grain keyed by "the addressable membership-walk closure rooted at subject key
 * `subjType:subjId#subjRelation` at `(revision, schemaHash)`" - the sharded, addressable
 * replacement for the retired per-silo `MembershipIndexCache`/`MembershipIndex` replica. The
 * grain's STRING KEY is, in order: `subjType/subjId/subjRelation/revision/schemaHash` (see
 * `membership-walk-key.ts`).
 *
 * Recursion crosses grain boundaries exactly like `ICheckGrain`: computing one subject's containing
 * set dispatches to the SIBLING `IMembershipWalkGrain` keyed by each direct parent (same
 * revision/schemaHash), so the walk is genuinely sharded rather than replicated. Because a walk
 * runs over a reader pinned to the key's exact revision, it is revision-exact by construction -
 * there is no fold/catch-up machinery to keep it correct as the log advances, unlike the retired
 * cache.
 */
export interface IMembershipWalkGrain extends GrainWithStringKey {
  /**
   * Returns the containing set reachable from this grain's subject key: its own direct parents
   * plus, for each parent not already on `args`'s path, the recursively-walked sibling grain's
   * contribution. See `MembershipClosureReply` for the completeness contract.
   */
  getContainingSet(
    args: MembershipWalkArgs,
    signal?: AbortSignal | undefined,
  ): Promise<MembershipClosureReply>;
}

/**
 * The runtime value for `IMembershipWalkGrain`. `getContainingSet` carries no Orleans interleave
 * attribute, so the options map is empty.
 */
export const IMembershipWalkGrain =
  defineGrainInterface<IMembershipWalkGrain>("IMembershipWalkGrain");
