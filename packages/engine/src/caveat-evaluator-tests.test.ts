import type { CaveatDefinition, CaveatTypeReference } from "@spacedb/core/caveat-definition";
import { CaveatEvaluationException } from "@spacedb/core/caveat-evaluation-exception";
import { describe, expect, it } from "vitest";

import { CaveatEvaluator } from "./caveat-evaluator";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/CaveatEvaluatorTests.cs`, case for case.
//
// Direct unit tests for CaveatEvaluator covering CEL partial-evaluation short-circuits over
// missing context, parameter type validation/coercion (including uint64 preservation), and the
// unknown-caveat error path. These mirror SpiceDB's `cel.OptPartialEval` +
// `ConvertContextToParameters` semantics.
//
// What the port has to get right for these nine cases to mean the same thing:
//
//   * EXCEPTIONS BECOME VALUES. The C# calls `_env.Program(expression, vars)` inside a
//     `catch (ex) when (IsMissingReferenceError(ex))`, walking `ex.InnerException` for a
//     `CelUndeclaredReferenceException`. `@bufbuild/cel` has no exception chain: `env.run(expr)`
//     RETURNS a `CelError` (or `CelUnknown`) as an ordinary value, and an unbound identifier is
//     one of those. Every catch-based control-flow path becomes value inspection, and getting
//     that predicate wrong flips `caveated` into a throw (or the reverse).
//
//   * PARTIAL EVALUATION IS THE CEL ENGINE'S JOB, NOT THE EVALUATOR'S. The first two cases only
//     pass because the engine short-circuits `||` and `&&` over an operand that is an error.
//     That behaviour is present in `@bufbuild/cel` (its `andFunc` returns false on the first
//     definite false even when a sibling is a CelError or CelUnknown, and `orFunc` mirrors it),
//     but the source carries a `TODO(tstamm) this doesn't look right` next to it, so these are
//     load-bearing regression pins on the dependency as much as on the port.
//
//   * ENVIRONMENT LIFETIME. A `CelEnv` holds its variables in mutable `data`, so a module-level
//     shared environment would leak one evaluation's context into the next. The evaluator builds
//     a fresh one per evaluate (or clears every name it previously set).
//
//   * NUMERIC WIDTHS. `uint` must stay UNSIGNED. The C# returns `ulong` and
//     `Uint64NearMaxValue_IsPreservedNotNarrowedToNegativeLong` is a dedicated test for it; in
//     CEL-JS the unsigned carrier is `CelUint` while `int` is a `bigint`. Narrowing 2^63 + 1 to
//     a signed value makes it negative and flips the comparison.
//
// Deliberately NOT extended: the C# suite is the gate this file reproduces. Everything else in
// CaveatEvaluator - the expression-tree fold, `AddContext`'s null-removes-the-key rule, the
// missing-field ordering, `ReferencesIdentifier` - is untested in Spiceport too, and inventing
// coverage here would be inventing semantics the conformance corpus has not yet asserted.

function caveat(
  name: string,
  expression: string,
  ...parameters: readonly (readonly [string, string])[]
): CaveatDefinition {
  const types = new Map<string, CaveatTypeReference>(
    parameters.map(([parameterName, typeName]) => [parameterName, { typeName }]),
  );
  return {
    name,
    serializedExpression: new TextEncoder().encode(expression),
    parameterTypes: types,
  };
}

function evaluator(...definitions: readonly CaveatDefinition[]): CaveatEvaluator {
  return new CaveatEvaluator(definitions);
}

function context(...pairs: readonly (readonly [string, unknown])[]): Map<string, unknown> {
  return new Map(pairs);
}

/** Runs `action` and returns whatever it threw, so the thrown value can be inspected. */
function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to throw, but it returned");
}

describe("caveat evaluator", () => {
  it("short-circuits an OR with a true branch over a missing variable to a definite true", () => {
    // `allowed || tier > 5` with {allowed:true} and tier absent: SpiceDB short-circuits the ||
    // and returns a definite true rather than Caveated.
    const evaluate = evaluator(
      caveat("c", "allowed || tier > 5", ["allowed", "bool"], ["tier", "int"]),
    );

    const result = evaluate.evaluate("c", undefined, context(["allowed", true]));

    expect(result.outcome).toBe("definitelyTrue");
  });

  it("short-circuits an AND with a false branch over a missing variable to a definite false", () => {
    // `denied && tier > 5` with {denied:false} and tier absent: short-circuit to definite false.
    const evaluate = evaluator(
      caveat("c", "denied && tier > 5", ["denied", "bool"], ["tier", "int"]),
    );

    const result = evaluate.evaluate("c", undefined, context(["denied", false]));

    expect(result.outcome).toBe("definitelyFalse");
  });

  it("is caveated for an OR with a false branch and a missing variable", () => {
    // `allowed || tier > 5` with {allowed:false}: the || cannot short-circuit; tier is needed.
    const evaluate = evaluator(
      caveat("c", "allowed || tier > 5", ["allowed", "bool"], ["tier", "int"]),
    );

    const result = evaluate.evaluate("c", undefined, context(["allowed", false]));

    expect(result.outcome).toBe("caveated");
    expect(result.missingFields).toContain("tier");
  });

  it("is caveated, not false, when the receiver of a custom function is missing", () => {
    // user_ip absent: the receiver of in_cidr is unbound, so the result is undetermined.
    const evaluate = evaluator(
      caveat("c", "user_ip.in_cidr(cidr)", ["user_ip", "ipaddress"], ["cidr", "string"]),
    );

    const result = evaluate.evaluate("c", undefined, context(["cidr", "10.0.0.0/8"]));

    expect(result.outcome).toBe("caveated");
    expect(result.missingFields).toContain("user_ip");
  });

  it("throws unknownCaveat for an unknown caveat name", () => {
    const evaluate = evaluator(caveat("c", "true"));

    const error = captureError(() => evaluate.evaluate("does_not_exist", undefined, undefined));

    expect(error).toBeInstanceOf(CaveatEvaluationException);
    expect((error as CaveatEvaluationException).kind).toBe("unknownCaveat");
  });

  it("throws parameterTypeMismatch for a wrong type on an int parameter", () => {
    const evaluate = evaluator(caveat("c", "age > 18", ["age", "int"]));

    const error = captureError(() =>
      evaluate.evaluate("c", undefined, context(["age", "not-a-number"])),
    );

    expect(error).toBeInstanceOf(CaveatEvaluationException);
    expect((error as CaveatEvaluationException).kind).toBe("parameterTypeMismatch");
  });

  it("preserves a uint64 near max value rather than narrowing it to a negative long", () => {
    // 2^63 + 1 fits in a uint64 but overflows a signed long; if narrowed it would become a large
    // negative value and the comparison would flip. Preserving uint semantics keeps it
    // definitely-true.
    const big = (1n << 63n) + 1n;
    const evaluate = evaluator(caveat("c", "n > 9223372036854775807u", ["n", "uint"]));

    const result = evaluate.evaluate("c", undefined, context(["n", big]));

    expect(result.outcome).toBe("definitelyTrue");
  });

  it("throws parameterTypeMismatch for a negative value on a uint parameter", () => {
    const evaluate = evaluator(caveat("c", "n > 0u", ["n", "uint"]));

    const error = captureError(() => evaluate.evaluate("c", undefined, context(["n", -5n])));

    expect(error).toBeInstanceOf(CaveatEvaluationException);
    expect((error as CaveatEvaluationException).kind).toBe("parameterTypeMismatch");
  });

  it("accepts a numeric string and a JSON number for an int parameter", () => {
    // JSON numbers arrive as double/long; a numeric string is also coerced, matching SpiceDB.
    const evaluate = evaluator(caveat("c", "age >= 18", ["age", "int"]));

    expect(evaluate.evaluate("c", undefined, context(["age", 21])).outcome).toBe("definitelyTrue");
    expect(evaluate.evaluate("c", undefined, context(["age", "21"])).outcome).toBe(
      "definitelyTrue",
    );
  });
});

// Not from the C# suite: these pin conversions where a JS-shaped naive port silently disagrees
// with BOTH reference implementations.
describe("CaveatEvaluator numeric context conversion", () => {
  // `(long)d` in .NET Core saturates rather than wrapping or throwing, and SpiceDB's
  // `big.Float.Int64` saturates too. Passing the value through unclamped puts an out-of-domain
  // bigint into CEL, where every later comparison quietly disagrees with both references.
  it("saturates an int parameter above int64 range, as .NET and Go do", () => {
    const evaluate = evaluator(caveat("c", "n == 9223372036854775807", ["n", "int"]));

    const result = evaluate.evaluate("c", undefined, context(["n", 1e19]));

    expect(result.outcome).toBe("definitelyTrue");
  });

  it("saturates an int parameter below int64 range", () => {
    const evaluate = evaluator(caveat("c", "n == -9223372036854775808", ["n", "int"]));

    const result = evaluate.evaluate("c", undefined, context(["n", -1e19]));

    expect(result.outcome).toBe("definitelyTrue");
  });

  it("saturates a uint parameter above uint64 range", () => {
    const evaluate = evaluator(caveat("c", "n == 18446744073709551615u", ["n", "uint"]));

    const result = evaluate.evaluate("c", undefined, context(["n", 1e20]));

    expect(result.outcome).toBe("definitelyTrue");
  });

  // `double.TryParse(s, NumberStyles.Float, InvariantCulture)` accepts these, and so does Go's
  // `strconv.ParseFloat`. Rejecting them turned a check that returns a verdict into a gRPC
  // InvalidArgument.
  it.each([
    ["NaN", "d != d"],
    ["Infinity", "d > 1.0"],
    ["-Infinity", "d < 1.0"],
    ["inf", "d > 1.0"],
  ])("accepts the non-finite double spelling %j", (literal, expression) => {
    const evaluate = evaluator(caveat("c", expression, ["d", "double"]));

    const result = evaluate.evaluate("c", undefined, context(["d", literal]));

    expect(result.outcome).toBe("definitelyTrue");
  });

  it("still rejects a genuinely unparseable double", () => {
    const evaluate = evaluator(caveat("c", "d > 1.0", ["d", "double"]));

    expect(() => evaluate.evaluate("c", undefined, context(["d", "not-a-number"]))).toThrow(
      CaveatEvaluationException,
    );
  });
});
