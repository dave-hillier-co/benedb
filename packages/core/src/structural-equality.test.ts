import { describe, expect, it } from "vitest";

import { bytesEqual, contextEqual, valueEqual } from "./structural-equality";

// Characterization of Spiceport `StructuralEquality` (internal, no covering C# test of its own; the
// records' behaviour through it is `record-value-equality-tests.test.ts`). These pin the leaves the
// port had to choose a JavaScript spelling for.

describe("structural equality", () => {
  describe("bytesEqual", () => {
    it("compares by content, and absent only equals absent", () => {
      expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
      expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
      expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
      expect(bytesEqual(undefined, undefined)).toBe(true);
      expect(bytesEqual(undefined, new Uint8Array())).toBe(false);
    });
  });

  describe("contextEqual", () => {
    it("treats absent and empty alike as no context", () => {
      expect(contextEqual(undefined, new Map())).toBe(true);
      expect(contextEqual(new Map(), undefined)).toBe(true);
      expect(contextEqual(undefined, new Map([["k", 1]]))).toBe(false);
    });
  });

  describe("valueEqual", () => {
    it("compares scalars as the C# boxed Equals does: NaN equals NaN, and 0 equals -0", () => {
      expect(valueEqual(Number.NaN, Number.NaN)).toBe(true);
      expect(valueEqual(0, -0)).toBe(true);
      expect(valueEqual(1, "1")).toBe(false);
    });

    it("never equates null with a value, nor a map with a list", () => {
      expect(valueEqual(null, null)).toBe(true);
      expect(valueEqual(null, undefined)).toBe(false);
      expect(valueEqual(new Map(), [])).toBe(false);
      expect(valueEqual([], {})).toBe(false);
    });

    it("compares a Map and a plain object by entry", () => {
      expect(valueEqual(new Map([["a", [1]]]), { a: [1] })).toBe(true);
      expect(valueEqual({ a: [1] }, new Map([["a", [2]]]))).toBe(false);
    });

    it("compares lists element-wise, order included", () => {
      expect(valueEqual([1, { k: "v" }], [1, new Map([["k", "v"]])])).toBe(true);
      expect(valueEqual([1, 2], [2, 1])).toBe(false);
      expect(valueEqual([1], [1, 1])).toBe(false);
    });
  });
});
