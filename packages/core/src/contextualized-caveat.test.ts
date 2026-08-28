import { describe, expect, it } from "vitest";

import { contextualizedCaveatEquals, type ContextualizedCaveat } from "./contextualized-caveat";

// Characterization of Spiceport `ContextualizedCaveat` (no covering C# test).
//
// Three port decisions, all deliberate, all pinned below:
//
// 1. EQUALITY IS DEEP, WHICH DIVERGES FROM C#. C# record equality on an
//    `IReadOnlyDictionary<string, object?>` member is REFERENCE equality, so two caveats with
//    equal-content but distinct dictionaries are unequal in Spiceport. TypeScript has no free
//    record equality at all, so an explicit comparison has to be written either way; this port
//    chooses content equality, because "same caveat name, same context values" is what every
//    caller actually means and reference identity is an artifact of C# codegen. Relationship
//    dedup in the datastore keys on resource+subject only (see `RelationshipKey`), so nothing
//    downstream depends on the C# behaviour.
//
// 2. Context comparison ignores key ORDER: a JSON object is an unordered map. Key order is
//    preserved only for byte-exact tuple-string formatting (see tuple-strings.test.ts), which
//    is presentation, not identity.
//
// 3. `undefined` context and an empty context compare equal, because
//    `TupleStrings.FormatCaveat` already treats them identically (`Context is { Count: > 0 }`).
//
// The context is a `Map`, not a plain object: a plain object reorders integer-like keys
// numerically, which would change the formatted tuple string.
const ctx = (entries: [string, unknown][]): ReadonlyMap<string, unknown> => new Map(entries);

describe("contextualized caveat", () => {
  it("carries a name and an optional context map", () => {
    const caveat: ContextualizedCaveat = { caveatName: "somecaveat", context: ctx([["a", 1]]) };

    expect(caveat.caveatName).toBe("somecaveat");
    expect(caveat.context?.get("a")).toBe(1);
  });

  it("allows the context to be omitted entirely", () => {
    const caveat: ContextualizedCaveat = { caveatName: "somecaveat" };

    expect(caveat.context).toBeUndefined();
  });

  it("preserves insertion order of integer-like keys", () => {
    // A plain JS object would reorder these to 1, 2, 10 and change the emitted tuple string.
    const caveat: ContextualizedCaveat = {
      caveatName: "somecaveat",
      context: ctx([
        ["2", 1],
        ["10", 2],
        ["1", 3],
      ]),
    };

    expect([...(caveat.context?.keys() ?? [])]).toEqual(["2", "10", "1"]);
  });

  describe("equality", () => {
    it("compares context by content, not by reference", () => {
      const a: ContextualizedCaveat = { caveatName: "c", context: ctx([["a", 1]]) };
      const b: ContextualizedCaveat = { caveatName: "c", context: ctx([["a", 1]]) };

      expect(a.context).not.toBe(b.context);
      expect(contextualizedCaveatEquals(a, b)).toBe(true);
    });

    it("compares nested values deeply", () => {
      const a: ContextualizedCaveat = {
        caveatName: "c",
        context: ctx([["a", { b: [1, 2] }]]),
      };
      const b: ContextualizedCaveat = {
        caveatName: "c",
        context: ctx([["a", { b: [1, 2] }]]),
      };
      const c: ContextualizedCaveat = {
        caveatName: "c",
        context: ctx([["a", { b: [1, 3] }]]),
      };

      expect(contextualizedCaveatEquals(a, b)).toBe(true);
      expect(contextualizedCaveatEquals(a, c)).toBe(false);
    });

    it("ignores key order", () => {
      const a: ContextualizedCaveat = {
        caveatName: "c",
        context: ctx([
          ["a", 1],
          ["b", 2],
        ]),
      };
      const b: ContextualizedCaveat = {
        caveatName: "c",
        context: ctx([
          ["b", 2],
          ["a", 1],
        ]),
      };

      expect(contextualizedCaveatEquals(a, b)).toBe(true);
    });

    it("treats an absent context and an empty context as the same", () => {
      const absent: ContextualizedCaveat = { caveatName: "c" };
      const empty: ContextualizedCaveat = { caveatName: "c", context: ctx([]) };

      expect(contextualizedCaveatEquals(absent, empty)).toBe(true);
    });

    it("distinguishes caveat names", () => {
      expect(contextualizedCaveatEquals({ caveatName: "a" }, { caveatName: "b" })).toBe(false);
    });

    it("distinguishes a missing key from a key with an undefined value", () => {
      const a: ContextualizedCaveat = { caveatName: "c", context: ctx([["a", undefined]]) };
      const b: ContextualizedCaveat = { caveatName: "c", context: ctx([]) };

      expect(contextualizedCaveatEquals(a, b)).toBe(false);
    });

    it("handles both sides being absent", () => {
      expect(contextualizedCaveatEquals(undefined, undefined)).toBe(true);
      expect(contextualizedCaveatEquals(undefined, { caveatName: "c" })).toBe(false);
      expect(contextualizedCaveatEquals({ caveatName: "c" }, undefined)).toBe(false);
    });
  });
});
