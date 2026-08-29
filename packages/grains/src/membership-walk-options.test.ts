import { durationToMs } from "@thresh/core/duration";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { ActivationMemoOptions } from "./activation-memo-options";
import {
  type MembershipWalkOptions,
  resolveMembershipWalkOptions,
} from "./membership-walk-options";

/**
 * No covering C# test - a characterization of `MembershipWalkOptions`, the toggle for the Leopard
 * membership-walk accelerator. Default ON (opt-out): when disabled, lookups run the live
 * traversal, so a port that defaults it off silently changes which code path serves every lookup.
 *
 * Empty subclass, same as `ActivationMemoOptions`: it needs a phantom brand to stay a distinct
 * type.
 */
describe("MembershipWalkOptions", () => {
  it("is a distinct type from the other empty memo-options subclasses", () => {
    expectTypeOf<MembershipWalkOptions>().not.toEqualTypeOf<ActivationMemoOptions>();
  });

  it("defaults ON - the accelerator is opt-out, not opt-in", () => {
    expect(resolveMembershipWalkOptions().enabled).toBe(true);
    expect(resolveMembershipWalkOptions({}).enabled).toBe(true);
  });

  it("honours an explicit opt-out", () => {
    expect(resolveMembershipWalkOptions({ enabled: false }).enabled).toBe(false);
  });

  it("inherits the base collection age and adds no members of its own", () => {
    const resolved = resolveMembershipWalkOptions();

    expect(durationToMs(resolved.collectionAge)).toBe(120_000);
    expect(Object.keys(resolved).sort()).toEqual(["collectionAge", "enabled"]);
  });
});
