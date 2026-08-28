import { describe, expect, it } from "vitest";

import {
  createCheckResult,
  isCheckResultMember,
  type CheckResult,
  type Membership,
} from "./membership";

// Characterization of Spiceport `Membership.cs` (no covering C# test; CaveatCheckTests pins the
// MissingExprFields normalisation only indirectly).
//
// Port decisions pinned here:
//   * The C# enum has explicit values 0/1/2, but they are NOT proto values: the gRPC v1
//     permissionship enum (NO_PERMISSION = 1, HAS_PERMISSION = 2, CONDITIONAL = 3) is mapped at
//     the API layer in S5. So this is a plain string-literal union with NO wire map.
//   * `CheckResult`'s primary constructor takes `IReadOnlyList<string>? MissingExprFields = null`
//     and then an `init` property RE-DECLARES it as `MissingExprFields ?? []`. The C# therefore
//     deliberately CONFLATES absent with empty here - the usual "keep undefined and [] distinct"
//     rule does NOT apply - so the constructing factory applies `?? []` and the field is typed
//     as a non-optional `readonly string[]`.
//   * `IsMember` is a computed property, so it becomes the free function `isCheckResultMember`.
describe("membership", () => {
  it("spells the three verdicts as a string-literal union", () => {
    const verdicts: readonly Membership[] = ["notMember", "member", "caveated"];

    expect(verdicts).toEqual(["notMember", "member", "caveated"]);
  });

  describe("createCheckResult", () => {
    it("normalises an omitted missing-fields list to an empty array", () => {
      const result = createCheckResult("member");

      expect(result.missingExprFields).toEqual([]);
    });

    it("normalises an explicitly undefined missing-fields list to an empty array", () => {
      const result = createCheckResult("member", undefined);

      expect(result.missingExprFields).toEqual([]);
    });

    it("does NOT keep absent and empty distinct, because the C# does not", () => {
      expect(createCheckResult("caveated").missingExprFields).toEqual(
        createCheckResult("caveated", []).missingExprFields,
      );
    });

    it("carries the supplied missing-fields list in order", () => {
      const result = createCheckResult("caveated", ["second", "first", "second"]);

      expect(result.missingExprFields).toEqual(["second", "first", "second"]);
    });

    it("carries the verdict", () => {
      expect(createCheckResult("notMember").verdict).toBe("notMember");
      expect(createCheckResult("member").verdict).toBe("member");
      expect(createCheckResult("caveated").verdict).toBe("caveated");
    });

    it("does not require a caveated verdict to carry missing fields", () => {
      expect(createCheckResult("caveated").missingExprFields).toEqual([]);
    });

    it("does not forbid a non-caveated verdict from carrying missing fields", () => {
      // The C# record applies no such invariant, so neither does the port.
      expect(createCheckResult("member", ["x"]).missingExprFields).toEqual(["x"]);
    });
  });

  describe("isCheckResultMember", () => {
    it("is true only for the member verdict", () => {
      expect(isCheckResultMember(createCheckResult("member"))).toBe(true);
      expect(isCheckResultMember(createCheckResult("notMember"))).toBe(false);
      expect(isCheckResultMember(createCheckResult("caveated", ["x"]))).toBe(false);
    });

    it("ignores the missing-fields list entirely", () => {
      expect(isCheckResultMember(createCheckResult("member", ["x"]))).toBe(true);
    });
  });

  describe("CheckResult shape", () => {
    it("types missingExprFields as non-optional, so no call site needs a `?? []`", () => {
      const result: CheckResult = createCheckResult("caveated", ["a"]);

      expect(result.missingExprFields.length).toBe(1);
    });
  });
});
