import { durationToMs } from "@thresh/core/duration";
import { describe, expect, it } from "vitest";

import { resolveMemoGrainOptions } from "./memo-grain-options";

/**
 * No covering C# test - a characterization of the `MemoGrainOptions` abstract base: the toggle and
 * idle-collection-age shape shared by every per-activation grain memo.
 *
 * Thresh has no container, so the guide's `IOptions<T>` row applies: a plain options object with
 * defaults applied at the call site. Every member is therefore OPTIONAL on the interface and the
 * resolver applies `??` defaults - `||` would turn an explicit `false` or an explicit zero age
 * back into the default, which is the whole point of having an off switch.
 */
describe("resolveMemoGrainOptions", () => {
  it("defaults to enabled with a two-minute collection age", () => {
    const resolved = resolveMemoGrainOptions();

    expect(resolved.enabled).toBe(true);
    expect(durationToMs(resolved.collectionAge)).toBe(120_000);
  });

  it("applies the same defaults to an empty object as to nothing at all", () => {
    expect(resolveMemoGrainOptions({})).toEqual(resolveMemoGrainOptions());
  });

  it("keeps an explicit false rather than falling back to the default", () => {
    expect(resolveMemoGrainOptions({ enabled: false }).enabled).toBe(false);
  });

  it("keeps an explicit zero collection age rather than falling back to the default", () => {
    // The silo clamps a too-small age up at wiring time; the resolver must not hide the zero.
    expect(durationToMs(resolveMemoGrainOptions({ collectionAge: { ms: 0 } }).collectionAge)).toBe(
      0,
    );
  });

  it("carries a configured collection age through unchanged", () => {
    expect(
      durationToMs(resolveMemoGrainOptions({ collectionAge: { minutes: 10 } }).collectionAge),
    ).toBe(600_000);
  });

  it("fills each member independently", () => {
    const resolved = resolveMemoGrainOptions({ enabled: false });

    expect(durationToMs(resolved.collectionAge)).toBe(120_000);
  });

  it("does not mutate the object it was given", () => {
    const configured = { enabled: false };

    resolveMemoGrainOptions(configured);

    expect(configured).toEqual({ enabled: false });
  });
});
