import { durationToMs } from "@thresh/core/duration";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { ActivationMemoOptions } from "./activation-memo-options";
import {
  resolveSubjectFrontierMemoOptions,
  type SubjectFrontierMemoOptions,
} from "./subject-frontier-memo-options";

/**
 * No covering C# test - a characterization of `SubjectFrontierMemoOptions`: the base memo shape
 * plus `MaxMemoSubjects`, the largest frontier an activation will RETAIN.
 *
 * The documented semantics are that an oversized frontier is still returned to the caller and only
 * the retention is capped. The grain that enforces that is a later slice; this file is the shape
 * plus its resolver.
 */
describe("resolveSubjectFrontierMemoOptions", () => {
  it("is a distinct type from the other memo-options subclasses", () => {
    expectTypeOf<SubjectFrontierMemoOptions>().not.toEqualTypeOf<ActivationMemoOptions>();
  });

  it("defaults to enabled, two minutes, and 4096 retained subjects", () => {
    const resolved = resolveSubjectFrontierMemoOptions();

    expect(resolved.enabled).toBe(true);
    expect(durationToMs(resolved.collectionAge)).toBe(120_000);
    expect(resolved.maxMemoSubjects).toBe(4096);
  });

  it("keeps the retention cap a plain number, not a bigint", () => {
    // The C# member is `int`; it bounds an in-memory collection, never a wire count.
    expect(typeof resolveSubjectFrontierMemoOptions().maxMemoSubjects).toBe("number");
    expect(Number.isInteger(resolveSubjectFrontierMemoOptions().maxMemoSubjects)).toBe(true);
  });

  it("keeps an explicit zero cap rather than falling back to the default", () => {
    // Zero means "retain nothing", not "retain 4096".
    expect(resolveSubjectFrontierMemoOptions({ maxMemoSubjects: 0 }).maxMemoSubjects).toBe(0);
  });

  it("carries a configured cap through unchanged", () => {
    expect(resolveSubjectFrontierMemoOptions({ maxMemoSubjects: 10 }).maxMemoSubjects).toBe(10);
  });

  it("fills the inherited members when only the cap is configured", () => {
    const resolved = resolveSubjectFrontierMemoOptions({ maxMemoSubjects: 10 });

    expect(resolved.enabled).toBe(true);
    expect(durationToMs(resolved.collectionAge)).toBe(120_000);
  });

  it("exposes exactly the base members plus the cap", () => {
    expect(Object.keys(resolveSubjectFrontierMemoOptions()).sort()).toEqual([
      "collectionAge",
      "enabled",
      "maxMemoSubjects",
    ]);
  });
});
