import {
  type MemoGrainOptions,
  resolveMemoGrainOptions,
  type ResolvedMemoGrainOptions,
} from "./memo-grain-options";

/**
 * Toggle and idle-collection tuning for `CheckGrain`'s per-activation reply memo (stage (a) of
 * "Activation-as-cache"). Default ON. When `enabled` is false, `CheckGrain` never consults or
 * populates its memo and behaves exactly as it did before this feature existed.
 *
 * In C# this is an EMPTY subclass of `MemoGrainOptions` whose only job is to be a distinct DI
 * registration key. With no container here it carries no members of its own, and a bare empty
 * interface is structurally satisfied by everything - so it takes the guide's phantom brand, and
 * a brand named for THIS type rather than the guide's generic `__trait`, because an identical
 * brand name would let it unify with `MembershipWalkOptions` again.
 */
export interface ActivationMemoOptions extends MemoGrainOptions {
  readonly __activationMemoOptions?: never;
}

/** Its own resolver, so it keeps its own default identity rather than sharing the base's. */
export function resolveActivationMemoOptions(
  options?: ActivationMemoOptions,
): ResolvedMemoGrainOptions {
  return resolveMemoGrainOptions(options);
}
