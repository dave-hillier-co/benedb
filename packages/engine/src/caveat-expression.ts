import type { ContextualizedCaveat } from "@spacedb/core/contextualized-caveat";

/**
 * A boolean combination of caveats threaded through the check graph. A node is either a leaf
 * (a single {@link ContextualizedCaveat}) or a composite (OR / AND / NOT over children).
 *
 * Ported from Spiceport `Engine/CaveatExpression.cs`, which mirrors SpiceDB's
 * `CaveatExpression` / `CaveatOperation`. The engine builds these while combining membership
 * across union (OR), intersection (AND), exclusion (base AND NOT excluded) and arrows (tupleset
 * caveat AND computed result), then collapses the whole tree to a single verdict during final
 * evaluation.
 *
 * Port decisions:
 *   * The sealed `Leaf` / `Or` / `And` / `Not` hierarchy becomes a discriminated union with a
 *     literal `kind` plus a local `assertNever`.
 *   * `undefined`, never `null`, is the "unconditionally true" sentinel.
 *   * {@link caveatExpressionCombineOr} and {@link caveatExpressionOrKeepOther} are DIFFERENT
 *     functions with different absent-operand handling, used in different places. Swapping them
 *     silently changes check verdicts.
 */

/** A leaf caveat: a named caveat with its relationship-supplied context. */
export interface LeafCaveatExpression {
  readonly kind: "leaf";
  /** The caveat and the context carried on the relationship that produced it. */
  readonly caveat: ContextualizedCaveat;
}

/** A logical OR over child expressions. */
export interface OrCaveatExpression {
  readonly kind: "or";
  /** The operands. */
  readonly children: readonly CaveatExpression[];
}

/** A logical AND over child expressions. */
export interface AndCaveatExpression {
  readonly kind: "and";
  /** The operands. */
  readonly children: readonly CaveatExpression[];
}

/** A logical NOT of a single child expression. */
export interface NotCaveatExpression {
  readonly kind: "not";
  /** The negated operand. */
  readonly child: CaveatExpression;
}

/** A node of the caveat expression tree. A closed union of the four possible kinds. */
export type CaveatExpression =
  LeafCaveatExpression | OrCaveatExpression | AndCaveatExpression | NotCaveatExpression;

function assertNever(value: never): never {
  throw new Error(`Unhandled caveat expression: ${JSON.stringify(value)}`);
}

/** Wraps a contextualized caveat as a leaf expression. */
export function caveatExpressionFromCaveat(caveat: ContextualizedCaveat): CaveatExpression {
  return { kind: "leaf", caveat };
}

/**
 * Combines two optional expressions with OR. An absent operand means "unconditionally true" for
 * that branch, which makes the whole OR unconditionally true (returns `undefined`).
 */
export function caveatExpressionCombineOr(
  a: CaveatExpression | undefined,
  b: CaveatExpression | undefined,
): CaveatExpression | undefined {
  if (a === undefined || b === undefined) {
    return undefined; // a determined (caveat-free) member dominates an OR.
  }
  return flatten("or", a, b);
}

/**
 * Combines two optional expressions with AND. An absent operand means "unconditionally true", so
 * the result is simply the other operand.
 */
export function caveatExpressionCombineAnd(
  a: CaveatExpression | undefined,
  b: CaveatExpression | undefined,
): CaveatExpression | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return flatten("and", a, b);
}

/**
 * Combines a base expression with the negation of an excluded expression:
 * `base AND NOT(excluded)`. An absent excluded operand would mean the resource is fully excluded;
 * callers handle that as removal, so this expects a present excluded expression.
 */
export function caveatExpressionSubtract(
  baseExpr: CaveatExpression | undefined,
  excluded: CaveatExpression,
): CaveatExpression | undefined {
  return caveatExpressionCombineAnd(baseExpr, { kind: "not", child: excluded });
}

/**
 * Combines two optional expressions with OR where an absent operand is treated as
 * "unconditional" and the OTHER operand is returned (mirrors SpiceDB's `caveats.Or`, used by the
 * subject-set wildcard algebra). This differs from {@link caveatExpressionCombineOr}, the
 * short-circuited OR, where an absent operand collapses the whole OR to `undefined`.
 */
export function caveatExpressionOrKeepOther(
  a: CaveatExpression | undefined,
  b: CaveatExpression | undefined,
): CaveatExpression | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return flatten("or", a, b);
}

/** Negates an optional expression; inverting an absent (unconditional) one yields `undefined`. */
export function caveatExpressionInvert(
  expr: CaveatExpression | undefined,
): CaveatExpression | undefined {
  return expr === undefined ? undefined : { kind: "not", child: expr };
}

type CompositeKind = "or" | "and";

function flatten(op: CompositeKind, a: CaveatExpression, b: CaveatExpression): CaveatExpression {
  const children: CaveatExpression[] = [];
  addFlattened(op, children, a);
  addFlattened(op, children, b);
  return op === "or" ? { kind: "or", children } : { kind: "and", children };
}

/**
 * Appends `expr` to `into`, splicing its children in when it is itself a node of the SAME
 * operator - one level only, never recursively.
 *
 * The C# is `AddFlattened<TOp>`, whose inner `expr switch` matches `Or o => o.Children,
 * And n => n.Children` regardless of `TOp`. That is only correct because the `expr is TOp` guard
 * has already run; TypeScript has no such guard, so the `expr.kind === op` check is explicit.
 */
function addFlattened(op: CompositeKind, into: CaveatExpression[], expr: CaveatExpression): void {
  if (expr.kind !== op) {
    into.push(expr);
    return;
  }

  switch (expr.kind) {
    case "or":
    case "and":
      into.push(...expr.children);
      return;
    default:
      return assertNever(expr);
  }
}
