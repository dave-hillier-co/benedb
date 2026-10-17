import type { CaveatTypeReference } from "@benedb/core/caveat-definition";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";

import { CaveatCompileException } from "./caveat-compile-exception";
import { caveatParameterCelType } from "./caveat-parameter-types";
import { parseCelExpr } from "./cel-ast-builder";
import { CEL_DECLARATIONS } from "./cel-declarations";
import { NO_LOCATION } from "./cel-expr";
import { CelIssues } from "./cel-issues";
import { checkCelExpr } from "./cel-type-checker";
import { CheckedType } from "./checked-type";

const MAX_CAVEAT_EXPRESSION_SIZE = 100_000;

/**
 * Compiles a caveat's CEL expression at schema-write time, as SpiceDB's
 * `caveats.CompileCaveatWithSource` (`pkg/caveats/compile.go`) does: parse, statically type-check
 * against the declared parameters, and require a boolean result. An expression that would fail
 * upstream's compile is rejected here, with upstream's message, rather than deferred to a Check.
 *
 * Throws a `CaveatCompileException` carrying SpiceDB's message when `expression` (the caveat body
 * exactly as SpiceDB's schema parser slices it) does not compile against `parameterTypes`.
 * `startLine` and `startColumn` (0-based, the column in code points) place the expression in the
 * schema, as upstream's `startPosition`.
 *
 * As upstream, the result must be exactly `bool`: an expression typed `dyn` (an `any` parameter, a
 * `map<any>` field, `dyn(x)`) is rejected even though it may evaluate to a boolean. The compiled
 * form is not persisted: the port stores the verbatim expression text (SpiceDB stores the checked
 * CEL AST), and the runtime caveat evaluator evaluates that text.
 *
 * Ported from Spiceport `Engine/CaveatCompiler.cs`.
 *
 * Port decisions:
 *   * This module lives in `@benedb/schema`, not `@benedb/engine` where the C# namespace would put
 *     it: the schema compiler calls it (as SpiceDB's schema compiler compiles caveats), and the
 *     engine package depends on the schema package, not the other way round.
 *   * It replaces the earlier `parseCaveatExpression`, which probed `@bufbuild/cel`'s parser and
 *     dispatcher for unbound functions; the static checker subsumes that probe.
 */
export function compileCaveat(
  caveatName: string,
  expression: string,
  parameterTypes: ReadonlyMap<string, CaveatTypeReference>,
  startLine = 0,
  startColumn = 0,
): void {
  if (caveatName === undefined || caveatName === null) {
    throw new InvalidArgumentError("caveatName is required");
  }
  if (expression === undefined || expression === null) {
    throw new InvalidArgumentError("expression is required");
  }
  if (parameterTypes === undefined || parameterTypes === null) {
    throw new InvalidArgumentError("parameterTypes is required");
  }

  const variables = new Map<string, CheckedType>();
  for (const [name, type] of parameterTypes) variables.set(name, caveatParameterCelType(type));

  if (new TextEncoder().encode(expression.trim()).length > MAX_CAVEAT_EXPRESSION_SIZE) {
    throw new CaveatCompileException(
      `caveat expression provided exceeds maximum allowed size of ${MAX_CAVEAT_EXPRESSION_SIZE} characters`,
    );
  }

  const issues = new CelIssues();

  const parsed = parseCelExpr(expression, issues);
  if (issues.hasErrors) throw failure(issues, expression, caveatName, startLine, startColumn);

  // cel-go builds the checker environment lazily, after a successful parse; a parameter that
  // redeclares a standard type identifier fails it, reported as one issue without a location.
  const overlapping = [...variables.keys()]
    .filter((name) => CEL_DECLARATIONS.typeIdentifiers.has(name))
    .sort(ordinal)
    .map((name) => `overlapping identifier for name '${name}'`);
  if (overlapping.length > 0) {
    issues.report(NO_LOCATION, overlapping.join("\n"));
    throw failure(issues, expression, caveatName, startLine, startColumn);
  }

  const outputType = checkCelExpr(parsed, variables, issues);
  if (issues.hasErrors) throw failure(issues, expression, caveatName, startLine, startColumn);

  if (outputType !== CheckedType.bool) {
    throw new CaveatCompileException(
      `caveat expression must result in a boolean value: found \`${outputType.toString()}\``,
    );
  }
}

/**
 * Renders the issues as SpiceDB does after relocating them into the schema: a location on the
 * expression's first line shifts by the start column, every location shifts by the start line,
 * and the snippet stays the expression's own line.
 */
function failure(
  issues: CelIssues,
  expression: string,
  caveatName: string,
  startLine: number,
  startColumn: number,
): CaveatCompileException {
  const relocated = issues.errors.map((e) => ({
    ...e,
    location:
      e.location.line === 1
        ? { line: startLine + e.location.line, column: startColumn + e.location.column }
        : { line: startLine + e.location.line, column: e.location.column },
  }));
  return new CaveatCompileException(
    CelIssues.toDisplayString(relocated, issues.count, expression, caveatName),
  );
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
