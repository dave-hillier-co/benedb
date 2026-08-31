import { CheckPermissionResponse_Permissionship } from "@benedb/protos/authzed/api/v1/permission_service";

/**
 * The comparison scaffolding shared by the two broad-sweep differential suites,
 * `differential-conformance-tests.test.ts` (random worlds) and
 * `corpus-differential-tests.test.ts` (the vendored corpus).
 *
 * LEDGER DEVIATION: this module has NO C# file of its own. Spiceport's two suites each keep a
 * private, byte-identical copy of `Normalize` and each spell `ToHashSet(StringComparer.Ordinal)` /
 * `OrderBy(x => x, StringComparer.Ordinal)` inline, because a nested private helper cannot be
 * shared between two xUnit classes. TypeScript can share it, and the batch brief requires it: the
 * two suites are structurally the SAME test over two different worlds, and the ONE thing that must
 * never drift between them is the mapping that decides whether they agree. It lands as a plain
 * `.ts` (not `*.test.ts`) because it declares no cases - the deviation `mesh-test-cluster.ts` and
 * `collecting-stream-writer.ts` already took.
 *
 * It keeps four exports rather than one because they are a single cohesive comparison vocabulary
 * with no independent consumers - the same latitude `core-constants.ts` and `validation-model.ts`
 * already take against the one-primary-export rule.
 *
 * PORT DECISIONS.
 *
 *  1. `StringComparer.Ordinal` IS CODE-UNIT ORDER. A JS `Set<string>` already hashes and compares
 *     by code unit, so `ToHashSet(StringComparer.Ordinal)` is a plain `Set`. Sorting is NOT free
 *     the same way: `Array.prototype.sort`'s default comparator stringifies and compares by code
 *     unit (which happens to be ordinal), but `localeCompare` does NOT - so {@link ordinalCompare}
 *     is written out explicitly and used everywhere. The ordering only ever appears inside a
 *     FAILURE MESSAGE, which is exactly why it must be stable: a human diffs those two lists.
 *  2. `SetEquals` COMPARES SIZE FIRST, THEN MEMBERSHIP. A subset check alone would silently pass
 *     when BeneDB returns EXTRA ids that real SpiceDB does not - the exact shape of an
 *     over-permissive bug this gate exists to catch.
 */

/**
 * `Normalize`: maps `CheckPermissionResponse.Permissionship` onto a small closed set so the two
 * systems' verdicts compare structurally rather than by raw enum identity.
 *
 * The `_ =>` default arm is load-bearing and is transliterated as a `default`, NOT as an
 * `assertNever`: NO_PERMISSION *and* UNSPECIFIED both normalize to "NotMember", and ts-proto adds
 * an `UNRECOGNIZED` member that must land there too. Byte-identical in both suites, by
 * construction, because there is only one copy.
 */
export function normalizePermissionship(p: CheckPermissionResponse_Permissionship): string {
  switch (p) {
    case CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION:
      return "Member";
    case CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION:
      return "Caveated";
    default:
      // NO_PERMISSION and UNSPECIFIED both normalize to "not a member".
      return "NotMember";
  }
}

/**
 * `StringComparer.Ordinal` as an explicit comparator. Never `localeCompare`, and never a bare
 * `.sort()` on non-ASCII: for the ASCII id alphabets in play they agree, but the ordering appears
 * in the failure messages a human then diffs, and it must not depend on a locale or a default.
 */
export function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `HashSet<string>.SetEquals`: same size AND same membership (port decision 2). */
export function setEquals(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

/** `string.Join(",", ids.OrderBy(x => x, StringComparer.Ordinal))`, for the failure lines. */
export function formatIdSet(ids: ReadonlySet<string>): string {
  return [...ids].sort(ordinalCompare).join(",");
}
