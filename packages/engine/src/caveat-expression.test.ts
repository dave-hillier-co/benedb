import type { ContextualizedCaveat } from "@benedb/core/contextualized-caveat";
import { describe, expect, it } from "vitest";

import {
  caveatExpressionCombineAnd,
  caveatExpressionCombineOr,
  caveatExpressionFromCaveat,
  caveatExpressionInvert,
  caveatExpressionOrKeepOther,
  caveatExpressionSubtract,
  type AndCaveatExpression,
  type CaveatExpression,
  type LeafCaveatExpression,
  type NotCaveatExpression,
  type OrCaveatExpression,
} from "./caveat-expression";

// Characterization of Spiceport `CaveatExpression.cs` (no direct C# test; the algebra is
// exercised only indirectly through CaveatCheckTests and LookupSubjectsEngineTests, which this
// port has not reached yet - so this suite is its only gate for now).
//
// Port decisions pinned here:
//   * The sealed Leaf/Or/And/Not hierarchy becomes a discriminated union with a literal `kind`.
//   * `undefined`, never `null`, is the "unconditional" sentinel.
//   * `CombineOr` and `OrKeepOther` are DIFFERENT functions with different null handling and are
//     used in different places. Swapping them silently changes check verdicts, so both are
//     pinned explicitly below.
//   * `Flatten<TOp>` collapses same-operator children ONE level only. The C# generic constraint
//     means an `Or` is flattened only into an `Or` and an `And` only into an `And`; the inner
//     `expr switch` matching `Or o => o.Children, And n => n.Children` regardless of `TOp` works
//     only because the `is TOp` guard already ran. The TypeScript port therefore needs an
//     explicit `expr.kind === op` check before spreading children.

const alpha: ContextualizedCaveat = { caveatName: "alpha" };
const beta: ContextualizedCaveat = { caveatName: "beta" };
const gamma: ContextualizedCaveat = { caveatName: "gamma" };

const a = caveatExpressionFromCaveat(alpha);
const b = caveatExpressionFromCaveat(beta);
const c = caveatExpressionFromCaveat(gamma);

describe("caveat expression", () => {
  describe("caveatExpressionFromCaveat", () => {
    it("wraps a contextualized caveat as a leaf", () => {
      const leaf = caveatExpressionFromCaveat(alpha);

      expect(leaf.kind).toBe("leaf");
      expect((leaf as LeafCaveatExpression).caveat).toBe(alpha);
    });

    it("carries the caveat context through untouched", () => {
      const withContext: ContextualizedCaveat = {
        caveatName: "alpha",
        context: new Map<string, unknown>([["ip", "10.0.0.1"]]),
      };

      expect((caveatExpressionFromCaveat(withContext) as LeafCaveatExpression).caveat).toBe(
        withContext,
      );
    });
  });

  describe("caveatExpressionCombineOr", () => {
    it("returns undefined when EITHER operand is undefined: a caveat-free member dominates an OR", () => {
      expect(caveatExpressionCombineOr(undefined, b)).toBeUndefined();
      expect(caveatExpressionCombineOr(a, undefined)).toBeUndefined();
      expect(caveatExpressionCombineOr(undefined, undefined)).toBeUndefined();
    });

    it("combines two leaves into an Or", () => {
      const result = caveatExpressionCombineOr(a, b) as OrCaveatExpression;

      expect(result.kind).toBe("or");
      expect(result.children).toEqual([a, b]);
    });

    it("flattens an Or left operand into the result", () => {
      const result = caveatExpressionCombineOr(
        caveatExpressionCombineOr(a, b),
        c,
      ) as OrCaveatExpression;

      expect(result.children).toEqual([a, b, c]);
    });

    it("flattens an Or right operand into the result", () => {
      const result = caveatExpressionCombineOr(
        c,
        caveatExpressionCombineOr(a, b),
      ) as OrCaveatExpression;

      expect(result.children).toEqual([c, a, b]);
    });

    it("does NOT flatten an And operand into an Or", () => {
      const and = caveatExpressionCombineAnd(a, b) as AndCaveatExpression;
      const result = caveatExpressionCombineOr(and, c) as OrCaveatExpression;

      expect(result.kind).toBe("or");
      expect(result.children).toEqual([and, c]);
    });

    it("does NOT flatten a Not operand", () => {
      const not = caveatExpressionInvert(a) as NotCaveatExpression;
      const result = caveatExpressionCombineOr(not, b) as OrCaveatExpression;

      expect(result.children).toEqual([not, b]);
    });

    it("flattens exactly one level, not recursively", () => {
      const nested: CaveatExpression = { kind: "or", children: [{ kind: "or", children: [a] }] };
      const result = caveatExpressionCombineOr(nested, b) as OrCaveatExpression;

      expect(result.children).toEqual([{ kind: "or", children: [a] }, b]);
    });

    it("preserves an empty Or operand's (empty) children rather than keeping the node", () => {
      const empty: CaveatExpression = { kind: "or", children: [] };
      const result = caveatExpressionCombineOr(empty, b) as OrCaveatExpression;

      expect(result.children).toEqual([b]);
    });

    it("keeps duplicate children: there is no deduplication", () => {
      const result = caveatExpressionCombineOr(a, a) as OrCaveatExpression;

      expect(result.children).toEqual([a, a]);
    });

    it("never mutates its operands", () => {
      const left = caveatExpressionCombineOr(a, b) as OrCaveatExpression;
      caveatExpressionCombineOr(left, c);

      expect(left.children).toEqual([a, b]);
    });
  });

  describe("caveatExpressionCombineAnd", () => {
    it("returns the other operand when one is undefined (unconditionally true)", () => {
      expect(caveatExpressionCombineAnd(undefined, b)).toBe(b);
      expect(caveatExpressionCombineAnd(a, undefined)).toBe(a);
    });

    it("returns undefined when both are undefined", () => {
      expect(caveatExpressionCombineAnd(undefined, undefined)).toBeUndefined();
    });

    it("combines two leaves into an And", () => {
      const result = caveatExpressionCombineAnd(a, b) as AndCaveatExpression;

      expect(result.kind).toBe("and");
      expect(result.children).toEqual([a, b]);
    });

    it("flattens And operands one level, on either side", () => {
      const left = caveatExpressionCombineAnd(
        caveatExpressionCombineAnd(a, b),
        c,
      ) as AndCaveatExpression;
      const right = caveatExpressionCombineAnd(
        c,
        caveatExpressionCombineAnd(a, b),
      ) as AndCaveatExpression;

      expect(left.children).toEqual([a, b, c]);
      expect(right.children).toEqual([c, a, b]);
    });

    it("does NOT flatten an Or operand into an And", () => {
      const or = caveatExpressionCombineOr(a, b) as OrCaveatExpression;
      const result = caveatExpressionCombineAnd(or, c) as AndCaveatExpression;

      expect(result.kind).toBe("and");
      expect(result.children).toEqual([or, c]);
    });
  });

  describe("caveatExpressionOrKeepOther", () => {
    it("returns the OTHER operand when one is undefined - NOT undefined like CombineOr", () => {
      expect(caveatExpressionOrKeepOther(undefined, b)).toBe(b);
      expect(caveatExpressionOrKeepOther(a, undefined)).toBe(a);
    });

    it("returns undefined only when both are undefined", () => {
      expect(caveatExpressionOrKeepOther(undefined, undefined)).toBeUndefined();
    });

    it("differs from CombineOr on exactly the one-sided-undefined case", () => {
      expect(caveatExpressionCombineOr(undefined, b)).toBeUndefined();
      expect(caveatExpressionOrKeepOther(undefined, b)).toBe(b);
    });

    it("agrees with CombineOr when both operands are present", () => {
      expect(caveatExpressionOrKeepOther(a, b)).toEqual(caveatExpressionCombineOr(a, b));
    });

    it("flattens Or operands one level, as CombineOr does", () => {
      const result = caveatExpressionOrKeepOther(
        caveatExpressionCombineOr(a, b),
        c,
      ) as OrCaveatExpression;

      expect(result.kind).toBe("or");
      expect(result.children).toEqual([a, b, c]);
    });
  });

  describe("caveatExpressionInvert", () => {
    it("returns undefined for an undefined (unconditional) expression", () => {
      expect(caveatExpressionInvert(undefined)).toBeUndefined();
    });

    it("wraps a present expression in a Not", () => {
      const result = caveatExpressionInvert(a) as NotCaveatExpression;

      expect(result.kind).toBe("not");
      expect(result.child).toBe(a);
    });

    it("does not collapse a double negation", () => {
      const result = caveatExpressionInvert(caveatExpressionInvert(a)) as NotCaveatExpression;

      expect(result.kind).toBe("not");
      expect((result.child as NotCaveatExpression).kind).toBe("not");
    });
  });

  describe("caveatExpressionSubtract", () => {
    it("is base AND NOT(excluded)", () => {
      const result = caveatExpressionSubtract(a, b) as AndCaveatExpression;

      expect(result.kind).toBe("and");
      expect(result.children).toEqual([a, { kind: "not", child: b }]);
    });

    it("returns a bare Not when the base is undefined (unconditional)", () => {
      const result = caveatExpressionSubtract(undefined, b) as NotCaveatExpression;

      expect(result.kind).toBe("not");
      expect(result.child).toBe(b);
    });

    it("flattens into an And base, because it delegates to CombineAnd", () => {
      const base = caveatExpressionCombineAnd(a, b) as AndCaveatExpression;
      const result = caveatExpressionSubtract(base, c) as AndCaveatExpression;

      expect(result.children).toEqual([a, b, { kind: "not", child: c }]);
    });

    it("requires a present excluded expression: the excluded operand is never undefined", () => {
      // The C# signature is `Subtract(CaveatExpression? baseExpr, CaveatExpression excluded)` -
      // a fully-excluded resource is handled by the caller as removal, not by this function.
      const result = caveatExpressionSubtract(a, caveatExpressionCombineOr(b, c)!);

      expect((result as AndCaveatExpression).children[1]).toEqual({
        kind: "not",
        child: { kind: "or", children: [b, c] },
      });
    });
  });

  describe("the union shape", () => {
    it("has exactly four kinds", () => {
      const all: readonly CaveatExpression[] = [
        { kind: "leaf", caveat: alpha },
        { kind: "or", children: [] },
        { kind: "and", children: [] },
        { kind: "not", child: a },
      ];

      expect(all.map((e) => e.kind)).toEqual(["leaf", "or", "and", "not"]);
    });
  });
});
