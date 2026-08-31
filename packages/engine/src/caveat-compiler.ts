import { CelError, type CelEnv } from "@bufbuild/cel";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";

import { buildCaveatCelEnvironment } from "./caveat-cel-environment";

/**
 * Compiles (parses + resolves the called functions of) caveat CEL expressions at schema-write time,
 * using the same CEL environment the runtime `CaveatEvaluator` evaluates against (so the SpiceDB
 * custom functions `ipaddress`/`in_cidr`/`isSubtreeOf` resolve during the parse). Mirrors the
 * compile step of SpiceDB's `caveats.DeserializeCaveatWithTypeSet`: an expression that cannot
 * compile is rejected at write time rather than deferred to a later Check.
 *
 * Ported from Spiceport `Engine/CaveatCompiler.cs`.
 *
 * As in the C#, the compiled program is not persisted: unlike SpiceDB (which serializes the
 * compiled CEL AST) the port continues to store the verbatim expression text, and this function
 * exists purely to fail an uncompilable caveat at write time.
 *
 * Port decisions:
 *
 *   * PARSE MUST STILL RESOLVE FUNCTIONS. The .NET `Cel` package's `Environment.Parse` resolves the
 *     registered custom functions during the parse, so a caveat naming a function that does not
 *     exist fails at schema write. `@bufbuild/cel`'s `env.parse(text)` is SYNTAX ONLY, and even
 *     planning leaves an unresolved call as a node that merely errors at eval
 *     (`EvalCall` returns `CelErrors.funcNotFound` when its dispatch entry is undefined). Left
 *     alone, a caveat calling a bogus function would be accepted at write time and deny at check
 *     time instead - a real divergence in the error path `SchemaTypeValidator` depends on. So the
 *     resolution step is done here explicitly: every called function name in the parsed AST is
 *     probed against the dispatcher, and an unbound one is rejected.
 *
 *   * The probe is by NAME, not by an allowlist. An over-narrow list of known function names would
 *     reject perfectly good caveats at schema-write time, which is worse than the narrowing it
 *     would fix. Operator-shaped names (`_&&_`, `@in`, `_[_]`, `_?_:_`, `@not_strictly_false`) are
 *     skipped: the parser only ever emits operators it knows, and none of them is identifier-shaped.
 *     Macros (`has`, `all`, `exists`, `map`, `filter`) are expanded by the parser and never appear
 *     as calls at all.
 *
 *   * `private static readonly CelEnvironment Environment` is a module-level constant built once.
 *     Unlike `CaveatEvaluator`, sharing it is safe here: parsing binds no variables. The probe does
 *     evaluate, but only expressions of the form `name()`, which touch no variable.
 *
 *   * .NET `Parse` throws; `@bufbuild/cel`'s parse may throw OR return a parse with no expression,
 *     so both are normalised into a throw. The thrown type is deliberately unpinned:
 *     `SchemaTypeValidator` catches broadly and only re-reads the message.
 */

/** The shared environment, built once. Parsing binds no variables, so sharing it is safe. */
const environment: CelEnv = buildCaveatCelEnvironment();

/** The message `CelErrors.funcNotFound` produces; the probe's only signal. */
const UNBOUND_FUNCTION_PREFIX = "unbound function: ";

/** Names the probe can safely express as `name()`. Anything else is an operator, and skipped. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ParsedExpr = ReturnType<CelEnv["parse"]>;
type Expr = NonNullable<ParsedExpr["expr"]>;

/**
 * Parses the given CEL expression and resolves every function it calls, throwing if it is not a
 * valid caveat expression.
 */
export function parseCaveatExpression(expression: string): void {
  if (expression === undefined || expression === null) {
    throw new InvalidArgumentError("expression is required");
  }

  const parsed = environment.parse(expression);
  const root = parsed.expr;
  if (root === undefined) {
    throw new Error(`could not parse expression: ${expression}`);
  }

  const called = new Set<string>();
  collectCalledFunctions(root, called);
  for (const name of called) {
    if (!isBoundFunction(name)) {
      throw new Error(`${UNBOUND_FUNCTION_PREFIX}${name}`);
    }
  }
}

/**
 * True when `name` resolves to a registered function. A zero-argument probe call reaches
 * `EvalCall`, which reports `unbound function` BEFORE it looks at arity - a registered function
 * called with the wrong arity reports `found no matching overload` instead, so the two are
 * distinguishable. A probe that will not parse (a CEL reserved word, say) cannot have been a legal
 * function name in the source expression either, so it is treated as unbound.
 */
function isBoundFunction(name: string): boolean {
  let result: unknown;
  try {
    result = environment.run(`${name}()`);
  } catch {
    return false;
  }
  return !(result instanceof CelError && result.message.startsWith(UNBOUND_FUNCTION_PREFIX));
}

/** Collects the names of every function called anywhere in the expression tree. */
function collectCalledFunctions(expr: Expr, into: Set<string>): void {
  const kind = expr.exprKind;
  switch (kind.case) {
    case "callExpr": {
      const call = kind.value;
      if (IDENTIFIER.test(call.function)) {
        into.add(call.function);
      }
      if (call.target !== undefined) {
        collectCalledFunctions(call.target, into);
      }
      for (const arg of call.args) {
        collectCalledFunctions(arg, into);
      }
      return;
    }
    case "listExpr":
      for (const element of kind.value.elements) {
        collectCalledFunctions(element, into);
      }
      return;
    case "structExpr":
      for (const entry of kind.value.entries) {
        if (entry.keyKind.case === "mapKey") {
          collectCalledFunctions(entry.keyKind.value, into);
        }
        if (entry.value !== undefined) {
          collectCalledFunctions(entry.value, into);
        }
      }
      return;
    case "selectExpr":
      if (kind.value.operand !== undefined) {
        collectCalledFunctions(kind.value.operand, into);
      }
      return;
    case "comprehensionExpr": {
      const c = kind.value;
      for (const child of [c.accuInit, c.iterRange, c.loopCondition, c.loopStep, c.result]) {
        if (child !== undefined) {
          collectCalledFunctions(child, into);
        }
      }
      return;
    }
    default:
      // identExpr and constExpr have no children, and an absent kind has nothing to walk.
      return;
  }
}
