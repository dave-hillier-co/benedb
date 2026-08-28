/**
 * The membership verdict returned by a check, and the check result carrying it.
 *
 * Ported from Spiceport `Engine/Membership.cs`.
 *
 * The C# enum has explicit values 0/1/2, but they are NOT proto values: the gRPC v1
 * permissionship enum (NO_PERMISSION = 1, HAS_PERMISSION = 2, CONDITIONAL = 3) is mapped at the
 * API layer. So this is a plain string-literal union with no wire map.
 */
export type Membership =
  /** The subject is definitively not a member. */
  | "notMember"
  /** The subject is definitively a member. */
  | "member"
  /**
   * Membership is conditional on a caveat whose context could not be fully determined. The
   * unresolved parameter names are reported in {@link CheckResult.missingExprFields}.
   */
  | "caveated";

/** The result of a permission check: the verdict and (when caveated) the missing context fields. */
export interface CheckResult {
  /** The membership verdict. */
  readonly verdict: Membership;
  /**
   * When `verdict` is `"caveated"`, the caveat parameter names that were unavailable in the
   * supplied context. Empty otherwise.
   *
   * NON-OPTIONAL by design. The C# primary constructor takes `IReadOnlyList<string>? = null` and
   * then an `init` property re-declares it as `MissingExprFields ?? []`, so the C# deliberately
   * CONFLATES absent with empty here; the usual "keep undefined and [] distinct" rule does not
   * apply. {@link createCheckResult} applies the `?? []`.
   */
  readonly missingExprFields: readonly string[];
}

/** Creates a check result, normalising an absent missing-fields list to an empty one. */
export function createCheckResult(
  verdict: Membership,
  missingExprFields?: readonly string[] | undefined,
): CheckResult {
  return { verdict, missingExprFields: missingExprFields ?? [] };
}

/** True if the subject is a member. The C# computed property `CheckResult.IsMember`. */
export function isCheckResultMember(result: CheckResult): boolean {
  return result.verdict === "member";
}
