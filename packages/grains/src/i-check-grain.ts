import { defineGrainInterface } from "@thresh/core/grain-interface";
import type { GrainWithStringKey } from "@thresh/core/key-kinds";

import type { SerializedCaveat } from "./serialized-caveat";

/**
 * The serializable reply from a dispatched sub-problem: the engine's pre-context branch
 * (tri-state membership plus an optional gating caveat) augmented with the cycle-cut flag.
 *
 * This is the PRE-CONTEXT branch, never the collapsed verdict: the caveat is returned as its
 * stable serialized form so the caller can collapse it against request-time context. Mirrors the
 * engine's `DispatchCheckResult`.
 *
 * `[GenerateSerializer, Immutable]` does not carry across: Thresh's value codec is name-based
 * JSON, so a plain readonly interface is the whole port and the numeric field ids simply do not
 * exist here.
 */
export interface DispatchCheckReply {
  /** True if the subject is a (possibly caveated) member. */
  readonly member: boolean;
  /**
   * The serialized gating caveat expression, or absent for unconditional membership /
   * non-membership.
   */
  readonly caveat?: SerializedCaveat | undefined;
  /**
   * True if this subtree was depth- or loop-affected and must not be cached. There is no
   * visited-set verdict cut: this flag is force-set on the RETURNED reply by the dispatcher when
   * the exact visited set reports a genuine repeat on this path, purely so the result is excluded
   * from the grain's activation memo, not because the verdict itself was altered.
   */
  readonly cycleCut: boolean;
  /**
   * The recursion depth this sub-problem actually consumed below itself (leaf = 1). Travels back
   * across the grain boundary so the silo-wide caching dispatcher can gate reuse on
   * `depthRemaining >= depthRequired` - mirroring SpiceDB's `ResponseMeta.DepthRequired`.
   *
   * The C# spells this as the default PARAMETER `int DepthRequired = 1`, which has no counterpart
   * on a TypeScript interface: it is an absent optional member here, read through
   * `dispatchCheckReplyDepthRequired` so an explicit `0` survives.
   */
  readonly depthRequired?: number | undefined;
}

/**
 * Resolves the C#'s `int DepthRequired = 1` default. `??`, never `||`: an explicit zero is a
 * legitimate value and must not fall back to one.
 */
export function dispatchCheckReplyDepthRequired(reply: DispatchCheckReply): number {
  return reply.depthRequired ?? 1;
}

/**
 * A grain keyed by the canonical sub-problem identity. The grain's STRING KEY is, in order:
 * `resourceType/resourceId/relation/subjectType/subjectId/subjectRelation/quantizedRevision/schemaHash`
 * - so the grain identity itself is the cache key for the sub-problem. See `grain-key.ts`.
 *
 * Recursion crosses grain boundaries: computing one sub-problem dispatches its children back
 * through the dispatcher, which addresses a different grain per child key. The cross-cutting depth
 * budget and exact visited-set cycle guard are NOT part of that identity - they ride ambiently in
 * the `RequestContext` via `dispatch-context.ts` rather than as a method argument, so this
 * method's wire contract is exactly the canonical sub-problem (the grain key) plus the
 * cancellation signal.
 *
 * Read `dispatch-context.ts` for the scoping guarantee this relies on, and for the caveat that
 * Thresh's `RequestContext.set` MUTATES the ambient store in place where Orleans' was
 * copy-on-write: sibling isolation holds only by the discipline of setting the values immediately
 * before each outgoing call.
 */
export interface ICheckGrain extends GrainWithStringKey {
  /**
   * Evaluates the one sub-problem this grain is keyed to, dispatching children onward. The depth
   * budget and exact visited-set cycle guard are read from the ambient dispatch context, which the
   * caller must have set before making this call. The signal propagates caller cancellation across
   * the grain boundary and through every recursive child dispatch.
   */
  dispatchCheck(signal?: AbortSignal | undefined): Promise<DispatchCheckReply>;
}

/**
 * The runtime value for `ICheckGrain`. `getGrain(ICheckGrain, key)` dispatches through it, so the
 * type alone is not enough.
 *
 * NO per-method options: the C# `DispatchCheck` carries no Orleans method attribute, and adding
 * one here would be an invention rather than a port.
 */
export const ICheckGrain = defineGrainInterface<ICheckGrain>("ICheckGrain");
