import { durationToMs } from "@thresh/core/duration";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type ActivationMemoOptions,
  resolveActivationMemoOptions,
} from "./activation-memo-options";
import type { MembershipWalkOptions } from "./membership-walk-options";
import type { SubjectFrontierMemoOptions } from "./subject-frontier-memo-options";

/**
 * No covering C# test - a characterization of `ActivationMemoOptions`, the check grain's
 * per-activation reply memo settings. Default ON.
 *
 * In C# this is an EMPTY subclass of `MemoGrainOptions` whose only job is to be a distinct DI
 * registration key. With no container here the type carries no members of its own, and a bare
 * empty interface is structurally satisfied by everything - so it needs a phantom brand or it
 * unifies with the other two memo options types and a mis-wired options object type-checks.
 */
describe("ActivationMemoOptions", () => {
  it("is a distinct type from the other empty memo-options subclasses", () => {
    expectTypeOf<ActivationMemoOptions>().not.toEqualTypeOf<MembershipWalkOptions>();
    expectTypeOf<ActivationMemoOptions>().not.toEqualTypeOf<SubjectFrontierMemoOptions>();
  });

  it("inherits the base toggle and collection age, defaulting to enabled at two minutes", () => {
    const resolved = resolveActivationMemoOptions();

    expect(resolved.enabled).toBe(true);
    expect(durationToMs(resolved.collectionAge)).toBe(120_000);
  });

  it("adds no members of its own", () => {
    expect(Object.keys(resolveActivationMemoOptions()).sort()).toEqual([
      "collectionAge",
      "enabled",
    ]);
  });

  it("keeps its own default identity rather than delegating to the base resolver's object", () => {
    expect(resolveActivationMemoOptions({ enabled: false }).enabled).toBe(false);
    expect(
      durationToMs(resolveActivationMemoOptions({ collectionAge: { ms: 0 } }).collectionAge),
    ).toBe(0);
  });
});
