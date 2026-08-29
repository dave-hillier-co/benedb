import {
  type MemoGrainOptions,
  resolveMemoGrainOptions,
  type ResolvedMemoGrainOptions,
} from "./memo-grain-options";

/**
 * Toggle for the Leopard membership-walk accelerator. Default ON (opt-out): when `enabled` is
 * false the accelerator is never consulted and lookups run the live traversal.
 *
 * Same empty-subclass shape as `ActivationMemoOptions`, and branded for the same reason. The
 * default lives in the resolver, not in the type.
 */
export interface MembershipWalkOptions extends MemoGrainOptions {
  readonly __membershipWalkOptions?: never;
}

export function resolveMembershipWalkOptions(
  options?: MembershipWalkOptions,
): ResolvedMemoGrainOptions {
  return resolveMemoGrainOptions(options);
}
