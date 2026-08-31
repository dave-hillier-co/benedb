import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { describe, expect, it } from "vitest";

import { createSeededRandom } from "./seeded-random";

// `seeded-random.ts` has no C# source: it stands in for `System.Random(int seed)`, which the
// property gates depend on and which JavaScript does not supply. So this suite has no C#
// counterpart either. It exists to pin the ONE property the gates need - a seed determines the
// sequence, on every run and every machine - because nothing else in the port would notice if
// the generator silently became ambient.
//
// The hardcoded draws below are deliberately brittle: any change to the algorithm changes every
// generated world, and a generated world that changes silently makes a red property gate
// unattributable. If a change here is intended, re-record them in the same commit and say why.

describe("createSeededRandom", () => {
  it("produces the same sequence for the same seed", () => {
    const first = createSeededRandom(7);
    const second = createSeededRandom(7);
    for (let i = 0; i < 16; i++) expect(second.next(1000)).toBe(first.next(1000));
  });

  it("produces a different sequence for a different seed", () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const drawsA = Array.from({ length: 8 }, () => a.next(1000));
    const drawsB = Array.from({ length: 8 }, () => b.next(1000));
    expect(drawsA).not.toEqual(drawsB);
  });

  it("pins the exact draws for seed 0", () => {
    const rng = createSeededRandom(0);
    expect(Array.from({ length: 8 }, () => rng.next(100))).toEqual([26, 0, 22, 14, 46, 54, 61, 64]);
  });

  it("pins the exact draws for seed 1", () => {
    const rng = createSeededRandom(1);
    expect(Array.from({ length: 8 }, () => rng.next(100))).toEqual([
      92, 76, 22, 86, 17, 84, 45, 69,
    ]);
  });

  it("draws within [0, exclusiveMax) and reaches both ends", () => {
    const rng = createSeededRandom(42);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const drawn = rng.next(5);
      expect(drawn).toBeGreaterThanOrEqual(0);
      expect(drawn).toBeLessThan(5);
      seen.add(drawn);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("draws doubles in [0, 1)", () => {
    const rng = createSeededRandom(-3);
    for (let i = 0; i < 2000; i++) {
      const drawn = rng.nextDouble();
      expect(drawn).toBeGreaterThanOrEqual(0);
      expect(drawn).toBeLessThan(1);
    }
  });

  it("accepts negative seeds", () => {
    // The metamorphic gate seeds with `seed * 104729 + 1`, which C# evaluates `unchecked` and can
    // therefore hand a negative int. The scramble is bit arithmetic, so it must not care.
    expect(() => createSeededRandom(-104729)).not.toThrow();
    expect(createSeededRandom(-5).next(10)).toBe(createSeededRandom(-5).next(10));
  });

  it("rejects a non-integer seed", () => {
    expect(() => createSeededRandom(1.5)).toThrow(InvalidArgumentError);
  });

  it("rejects a non-positive bound, where .NET's Next(0) returns 0", () => {
    const rng = createSeededRandom(0);
    expect(() => rng.next(0)).toThrow(InvalidArgumentError);
    expect(() => rng.next(-1)).toThrow(InvalidArgumentError);
  });
});
