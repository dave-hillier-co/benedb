import { CelError, CelUint, CelUnknown } from "@bufbuild/cel";
import type { CaveatDefinition, CaveatTypeReference } from "@benedb/core/caveat-definition";
import { CaveatEvaluationException } from "@benedb/core/caveat-evaluation-exception";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";

import { buildCaveatCelEnvironment } from "./caveat-cel-environment";
import { toCelContextValue } from "./cel-context-value";
import type { CaveatExpression } from "./caveat-expression";
import { referencesIdentifier } from "./references-identifier";

/**
 * Evaluates SpiceDB-style CEL caveats, ported from Spiceport `Engine/CaveatEvaluator.cs`.
 *
 * Registers the SpiceDB custom functions/types used by caveat expressions via
 * {@link buildCaveatCelEnvironment}: `ipaddress(string)` with `.in_cidr(string)`, and a map
 * `.isSubtreeOf(map)` structural-subtree check. `timestamp` and `duration` come from the
 * underlying CEL implementation.
 *
 * Partial evaluation: the CEL engine short-circuits `||`/`&&` at the operator level, so a missing
 * variable on the non-determining branch still yields a definite verdict (e.g. `allowed || tier > 5`
 * with `{allowed:true}` is definitely-true even though `tier` is absent). The expression is executed
 * directly against the supplied context; only when the engine genuinely needs an absent variable is
 * the result `caveated`, carrying the declared parameters that are referenced by the expression yet
 * absent from the merged context. This mirrors SpiceDB's `cel.OptPartialEval` + `PartialVars`.
 *
 * Context values are validated and coerced against the caveat's declared parameter types before
 * evaluation (mirroring SpiceDB's `ConvertContextToParameters`): a value whose type cannot be
 * converted raises `CaveatEvaluationException` with kind `parameterTypeMismatch` (gRPC
 * InvalidArgument), and a `uint` parameter is preserved as an unsigned value rather than narrowed
 * to a signed one. An unknown caveat name raises kind `unknownCaveat`.
 *
 * Port decisions:
 *
 *   * EXCEPTIONS BECOME VALUES. The C# calls `_env.Program(expression, vars)` inside a
 *     `catch (ex) when (IsMissingReferenceError(ex))` that walks `ex.InnerException` for a
 *     `CelUndeclaredReferenceException`. `@bufbuild/cel` has no exception chain: `env.run(expr)`
 *     RETURNS a `CelError` (or `CelUnknown`), so the catch becomes value inspection - see
 *     {@link isMissingReferenceResult}.
 *
 *   * ENVIRONMENT LIFETIME. The C# holds one `CelEnvironment` for the evaluator's lifetime and
 *     passes `vars` per call. A `CelEnv` instead holds its variables in mutable `data`, so a shared
 *     instance would leak one evaluation's context into the next and turn a `caveated` into a
 *     definite verdict. A fresh environment is built per evaluation.
 *
 *   * MAP CARRIER. Context values go through {@link toCelContextValue} on the way into the
 *     environment. `@bufbuild/cel` throws, rather than reporting a CEL "no such key" error, when an
 *     expression reads an absent key off a `Map`-carried map; see that module for why the carrier
 *     stays a `Map` and what the wrapper restores.
 *
 *   * NUMERIC WIDTHS. `int` is a `bigint`, `uint` is a `CelUint` and `double` is a `number`. The C#
 *     returns `ulong` for `uint` specifically so that a value above `long.MaxValue` is not narrowed
 *     to a negative; `CelUint` is the carrier that preserves that here.
 *
 *   * JSON NUMBERS. The C# `NormalizeJson` distinguishes int64 from double via `TryGetInt64`, a
 *     distinction `JSON.parse` destroys - `1` and `1.0` are the same JavaScript number. An integral
 *     `number` is accepted by {@link toInt64}, so behaviour is preserved; a magnitude above 2^53
 *     loses precision silently, exactly as any JSON-sourced number in JavaScript does.
 */

/** The kind of outcome produced by evaluating a single caveat expression. */
export type CaveatOutcome =
  /** The caveat evaluated to a definite `true`. */
  | "definitelyTrue"
  /** The caveat evaluated to a definite `false`. */
  | "definitelyFalse"
  /**
   * The caveat could not be fully determined because one or more declared parameters referenced by
   * the expression were absent from the supplied context.
   */
  | "caveated";

/**
 * The result of evaluating a caveat expression: its outcome and, when `caveated`, the names of the
 * parameters that were missing.
 */
export interface CaveatResult {
  /** The evaluation outcome. */
  readonly outcome: CaveatOutcome;
  /** The declared parameter names that were unavailable, if any. */
  readonly missingFields: readonly string[];
}

/**
 * A definite-true result with no missing fields. A frozen constant, not a factory: the C# is a
 * `static readonly` singleton and call sites may compare it by reference.
 */
export const caveatResultTrue: CaveatResult = Object.freeze({
  outcome: "definitelyTrue",
  missingFields: Object.freeze([]),
} as const);

/** A definite-false result with no missing fields. */
export const caveatResultFalse: CaveatResult = Object.freeze({
  outcome: "definitelyFalse",
  missingFields: Object.freeze([]),
} as const);

/**
 * Creates a caveated result carrying the given missing field names, de-duplicated.
 *
 * DIVERGES FROM C# in ORDER only: `def.ParameterTypes.Keys` enumerates an `ImmutableDictionary` in
 * hash order, while a `Map` enumerates in insertion order, and `.Distinct().ToList()` preserves
 * whichever it was given. The list surfaces to the gRPC `partial_caveat_info.missing_required_context`,
 * which SpiceDB itself does not sort, so nothing downstream depends on the order; it is left
 * unsorted here rather than imposing an order the source does not have.
 */
export function caveatResultMissing(fields: Iterable<string>): CaveatResult {
  return { outcome: "caveated", missingFields: [...new Set(fields)] };
}

/** Evaluates SpiceDB-style CEL caveats. */
export class CaveatEvaluator {
  readonly #caveats: ReadonlyMap<string, CaveatDefinition>;

  /** Creates an evaluator over the given caveat definitions, keyed by name. */
  constructor(caveats: Iterable<CaveatDefinition>) {
    if (caveats === undefined || caveats === null) {
      throw new InvalidArgumentError("caveats is required");
    }
    this.#caveats = new Map([...caveats].map((c) => [c.name, c]));
  }

  /**
   * Evaluates the named caveat against the relationship context merged with the request context
   * (relationship context overrides). Returns `caveated` when a referenced declared parameter is
   * absent and the CEL engine cannot short-circuit around it.
   *
   * @throws CaveatEvaluationException The caveat name is unknown (`unknownCaveat`), or a supplied
   *   context value is type-incompatible with the declared parameter (`parameterTypeMismatch`).
   */
  evaluate(
    caveatName: string,
    relationshipContext: ReadonlyMap<string, unknown> | undefined,
    requestContext: ReadonlyMap<string, unknown> | undefined,
  ): CaveatResult {
    if (caveatName === undefined || caveatName === null) {
      throw new InvalidArgumentError("caveatName is required");
    }

    // An unknown caveat name is a schema-skew/stale-cache condition. SpiceDB's CaveatRunner.get
    // returns CaveatNameNotFoundErr; surface it loudly rather than silently denying.
    const def = this.#caveats.get(caveatName);
    if (def === undefined) {
      throw new CaveatEvaluationException(
        "unknownCaveat",
        `caveat with name \`${caveatName}\` not found`,
      );
    }

    const expression = new TextDecoder().decode(def.serializedExpression);

    // Merge request then relationship context (relationship/stored context overrides request),
    // validating + coercing each value against the declared parameter type. A mismatch becomes a
    // parameterTypeMismatch (gRPC InvalidArgument), as in SpiceDB's ConvertContextToParameters.
    const vars = new Map<string, unknown>();
    addContext(vars, requestContext, def.parameterTypes);
    addContext(vars, relationshipContext, def.parameterTypes);

    // Candidate missing set: declared parameters referenced by the expression yet absent from the
    // merged context. Only reported when the CEL engine actually needs one of them (i.e. could not
    // short-circuit the surrounding ||/&&); the engine handles boolean short-circuiting.
    const missing = [...def.parameterTypes.keys()].filter(
      (p) => !vars.has(p) && referencesIdentifier(expression, p),
    );

    // A fresh environment per evaluation: `CelEnv.data` is mutable, so a shared one would leak
    // this evaluation's variables into the next.
    const env = buildCaveatCelEnvironment();
    for (const [name, value] of vars) {
      env.set(name, toCelContextValue(value));
    }

    const result = env.run(expression);

    if (result instanceof CelError || result instanceof CelUnknown) {
      if (isMissingReferenceResult(result)) {
        // A genuinely-needed parameter was absent (short-circuit did not save us).
        if (missing.length > 0) {
          return caveatResultMissing(missing);
        }
      }

      // Either no declared parameter is missing yet evaluation still failed, or the failure is not
      // a missing reference at all: surface it rather than silently masking a genuine
      // expression/overload bug. The C# lets the CEL exception propagate; there is no exception to
      // re-raise here, so the error value is wrapped.
      throw celEvaluationError(caveatName, result);
    }

    if (typeof result === "boolean") {
      return result ? caveatResultTrue : caveatResultFalse;
    }

    // Non-boolean result: treat as undetermined rather than asserting membership.
    return missing.length > 0 ? caveatResultMissing(missing) : caveatResultFalse;
  }

  /**
   * Collapses a {@link CaveatExpression} tree to a single result against the request context,
   * following short-circuiting AND/OR/NOT rules: AND is false if any operand is definitely false;
   * OR is true if any operand is definitely true; otherwise missing fields accumulate across
   * operands and the result is `caveated`.
   */
  evaluateExpression(
    expression: CaveatExpression,
    requestContext: ReadonlyMap<string, unknown> | undefined,
  ): CaveatResult {
    if (expression === undefined || expression === null) {
      throw new InvalidArgumentError("expression is required");
    }

    switch (expression.kind) {
      case "leaf":
        return this.evaluate(
          expression.caveat.caveatName,
          expression.caveat.context,
          requestContext,
        );
      case "or":
        return this.#evaluateOr(expression.children, requestContext);
      case "and":
        return this.#evaluateAnd(expression.children, requestContext);
      case "not":
        return invert(this.evaluateExpression(expression.child, requestContext));
      default:
        // The C#'s `_ => CaveatResult.False` default over a closed hierarchy. The branch is
        // unreachable in TypeScript too, so it becomes an exhaustiveness check; note that the C#
        // returned False here rather than throwing.
        return assertNever(expression);
    }
  }

  #evaluateOr(
    children: readonly CaveatExpression[],
    requestContext: ReadonlyMap<string, unknown> | undefined,
  ): CaveatResult {
    const missing: string[] = [];
    let anyCaveated = false;
    for (const child of children) {
      const r = this.evaluateExpression(child, requestContext);
      if (r.outcome === "definitelyTrue") return caveatResultTrue; // short-circuit
      if (r.outcome === "caveated") {
        anyCaveated = true;
        missing.push(...r.missingFields);
      }
    }
    return anyCaveated ? caveatResultMissing(missing) : caveatResultFalse;
  }

  #evaluateAnd(
    children: readonly CaveatExpression[],
    requestContext: ReadonlyMap<string, unknown> | undefined,
  ): CaveatResult {
    const missing: string[] = [];
    let anyCaveated = false;
    for (const child of children) {
      const r = this.evaluateExpression(child, requestContext);
      if (r.outcome === "definitelyFalse") return caveatResultFalse; // short-circuit
      if (r.outcome === "caveated") {
        anyCaveated = true;
        missing.push(...r.missingFields);
      }
    }
    return anyCaveated ? caveatResultMissing(missing) : caveatResultTrue;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled caveat expression: ${JSON.stringify(value)}`);
}

function invert(r: CaveatResult): CaveatResult {
  switch (r.outcome) {
    case "definitelyTrue":
      return caveatResultFalse;
    case "definitelyFalse":
      return caveatResultTrue;
    default:
      return r; // caveated negation stays caveated with the same missing fields.
  }
}

/**
 * True if the result indicates a reference to a variable that was not supplied.
 *
 * The C# walks the exception chain for `CelUndeclaredReferenceException`, plus a narrow special
 * case for a bare `CelNoSuchOverloadException` (a macro such as `somelist.all(...)` over a null
 * var). `@bufbuild/cel` has neither exception: an unbound identifier resolves to nothing and
 * surfaces as `CelErrors.unresolvedAttr` ("unresolved attribute"), and a `CelUnknown` is the
 * partial-evaluation carrier for the same condition. Errors merge into `CelError.additional`, so
 * the whole merged tree is walked.
 *
 * The C#'s overload special case is deliberately NOT carried across: in `@bufbuild/cel` the macro
 * form it existed for already surfaces as "unresolved attribute" (the fold's iteration range
 * evaluates to that error), so admitting `found no matching overload` here would only widen the
 * predicate - turning a genuine type mismatch such as `age > "x"` into `caveated` where the C#
 * throws.
 */
function isMissingReferenceResult(result: CelError | CelUnknown): boolean {
  if (result instanceof CelUnknown) return true;
  for (const error of flattenErrors(result)) {
    if (
      error.message === "unresolved attribute" ||
      error.message.startsWith("undeclared reference to ")
    ) {
      return true;
    }
  }
  return false;
}

function flattenErrors(error: CelError): readonly CelError[] {
  const out: CelError[] = [error];
  for (const additional of error.additional ?? []) {
    out.push(...flattenErrors(additional));
  }
  return out;
}

function celEvaluationError(caveatName: string, result: CelError | CelUnknown): Error {
  const detail =
    result instanceof CelError
      ? result.message
      : `unknown value (ids ${result.ids.map(String).join(", ")})`;
  return new Error(`could not evaluate caveat \`${caveatName}\`: ${detail}`, { cause: result });
}

/**
 * Merges `ctx` into `vars`, validating and coercing each value against its declared parameter type.
 * A value whose type cannot be converted raises `CaveatEvaluationException`. Unknown parameters
 * (not declared by the caveat) are skipped, mirroring SpiceDB's `SkipUnknownParameters`; an absent
 * value REMOVES the parameter (treated as absent) rather than setting it to undefined.
 */
function addContext(
  vars: Map<string, unknown>,
  ctx: ReadonlyMap<string, unknown> | undefined,
  parameterTypes: ReadonlyMap<string, CaveatTypeReference>,
): void {
  if (ctx === undefined) return;
  for (const [k, v] of ctx) {
    if (v === undefined || v === null) {
      vars.delete(k);
      continue;
    }

    // SkipUnknownParameters: a context value with no declared parameter is ignored, not an error
    // (matches SpiceDB; the value cannot be referenced by the typed expression anyway).
    const declared = parameterTypes.get(k);
    if (declared === undefined) continue;

    vars.set(k, convertValue(k, declared, normalize(v)));
  }
}

/**
 * Normalizes a context value into a CEL-friendly representation. The C#'s `JsonElement` branch
 * mostly evaporates - relationship context arrives as already-parsed JavaScript values - but the
 * two rules that branch encoded survive: a plain object becomes a `Map`, and a null/undefined
 * member is DROPPED from an object or an array rather than carried through as a null.
 */
function normalize(value: unknown): unknown {
  if (value instanceof Map) {
    const out = new Map<string, unknown>();
    for (const [k, v] of value as ReadonlyMap<unknown, unknown>) {
      if (v === undefined || v === null) continue;
      out.set(String(k), normalize(v));
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.filter((x) => x !== undefined && x !== null).map((x) => normalize(x));
  }

  if (value instanceof Uint8Array || value instanceof CelUint) return value;

  if (typeof value === "object" && value !== null && isPlainObject(value)) {
    const out = new Map<string, unknown>();
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || v === null) continue;
      out.set(k, normalize(v));
    }
    return out;
  }

  // boolean, string, number, bigint and anything else pass through with their width preserved so
  // that convertValue can validate them against the declared type.
  return value;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Validates and coerces a normalized value against the declared caveat parameter type, mirroring
 * SpiceDB's `VariableType.ConvertValue`. Numeric types accept the target type, a JSON number, or a
 * numeric string; `int` requires an integral value, `uint` requires a non-negative integral value
 * preserved as an unsigned `CelUint`, `double` accepts any number. `string` and `bool` require an
 * exact match. `list`/`map` recurse into their child types.
 */
function convertValue(param: string, type: CaveatTypeReference, value: unknown): unknown {
  switch (type.typeName) {
    case "bool":
      if (typeof value === "boolean") return value;
      throw typeError(param, "bool", value);

    case "string":
      if (typeof value === "string") return value;
      throw typeError(param, "string", value);

    case "bytes":
    case "duration":
    case "timestamp":
    case "ipaddress":
      // These flow through as strings (parsed by the registered functions / engine).
      if (typeof value === "string") return value;
      throw typeError(param, type.typeName, value);

    case "int":
      return toInt64(param, value);

    case "uint":
      return toUInt64(param, value);

    case "double":
      return toDouble(param, value);

    case "any":
      return value;

    case "list": {
      if (!Array.isArray(value)) throw typeError(param, "list", value);
      const child = type.childTypes?.[0];
      return child === undefined
        ? value
        : (value as readonly unknown[]).map((item) => convertValue(param, child, item));
    }

    case "map": {
      if (!(value instanceof Map)) throw typeError(param, "map", value);
      const entries = value as ReadonlyMap<string, unknown>;
      const childTypes = type.childTypes;
      const valueType =
        childTypes !== undefined && childTypes.length >= 1
          ? childTypes[childTypes.length - 1]
          : undefined;
      if (valueType === undefined) return entries;
      return new Map([...entries].map(([k, v]) => [k, convertValue(param, valueType, v)] as const));
    }

    default:
      // Unknown declared type keyword: pass the value through unchanged.
      return value;
  }
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

/**
 * `NumberStyles.Integer` + InvariantCulture: leading/trailing whitespace and an optional sign
 * around a run of decimal digits. Nothing else - `BigInt("0x2a")` would otherwise accept hex, and
 * `BigInt` is unbounded where a `long` is not, hence the explicit range check at each call site.
 */
const INTEGER_STYLE = /^\s*[+-]?[0-9]+\s*$/;

/** `NumberStyles.Float` + InvariantCulture: whitespace, sign, digits, decimal point, exponent. */
const FLOAT_STYLE = /^\s*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\s*$/;

/** Saturating clamp, matching .NET's unchecked float-to-integer conversion. */
function clampBigInt(value: bigint, min: bigint, max: bigint): bigint {
  return value < min ? min : value > max ? max : value;
}

function toInt64(param: string, value: unknown): bigint {
  if (typeof value === "bigint" && value >= INT64_MIN && value <= INT64_MAX) return value;
  if (value instanceof CelUint && value.value <= INT64_MAX) return value.value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    // SATURATE, do not pass through. The C# is `(long)d`, and .NET Core's unchecked
    // float-to-integer conversion saturates rather than wrapping or throwing; SpiceDB's
    // `big.Float.Int64` saturates too (basic.go, the Accuracy is discarded). Without the clamp a
    // JSON context number above 2^63 enters CEL as an out-of-domain bigint and every downstream
    // comparison silently disagrees with both reference implementations.
    return clampBigInt(BigInt(value), INT64_MIN, INT64_MAX);
  }
  if (typeof value === "string" && INTEGER_STYLE.test(value)) {
    const parsed = BigInt(value.trim());
    if (parsed >= INT64_MIN && parsed <= INT64_MAX) return parsed;
  }
  throw typeError(param, "int", value);
}

function toUInt64(param: string, value: unknown): CelUint {
  if (value instanceof CelUint) return value;
  if (typeof value === "bigint" && value >= 0n && value <= UINT64_MAX) return new CelUint(value);
  if (
    typeof value === "number" &&
    value >= 0 &&
    Number.isFinite(value) &&
    Number.isInteger(value)
  ) {
    return new CelUint(clampBigInt(BigInt(value), 0n, UINT64_MAX));
  }
  if (typeof value === "string" && INTEGER_STYLE.test(value)) {
    const parsed = BigInt(value.trim());
    if (parsed >= 0n && parsed <= UINT64_MAX) return new CelUint(parsed);
  }
  throw typeError(param, "uint", value);
}

/** The non-finite spellings `double.TryParse` and `strconv.ParseFloat` accept. */
const SYMBOLIC_DOUBLES = new Map<string, number>([
  ["nan", Number.NaN],
  ["+nan", Number.NaN],
  ["-nan", Number.NaN],
  ["inf", Number.POSITIVE_INFINITY],
  ["+inf", Number.POSITIVE_INFINITY],
  ["-inf", Number.NEGATIVE_INFINITY],
  ["infinity", Number.POSITIVE_INFINITY],
  ["+infinity", Number.POSITIVE_INFINITY],
  ["-infinity", Number.NEGATIVE_INFINITY],
]);

function toDouble(param: string, value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof CelUint) return Number(value.value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (FLOAT_STYLE.test(value)) return Number(trimmed);
    // `double.TryParse(s, NumberStyles.Float, InvariantCulture)` accepts these three, and Go's
    // `strconv.ParseFloat` (which SpiceDB's ConvertValue uses) accepts them case-insensitively.
    // Rejecting them turned a check that returns a verdict in both references into a gRPC
    // InvalidArgument here. .NET matches them case-insensitively; JS `Number()` does not parse
    // them at all, so they are mapped explicitly.
    const symbolic = SYMBOLIC_DOUBLES.get(trimmed.toLowerCase());
    if (symbolic !== undefined) return symbolic;
  }
  throw typeError(param, "double", value);
}

/**
 * The C# message embeds `value.GetType().Name` ("Int64", "String") and is surfaced as gRPC
 * InvalidArgument. TypeScript has no such name, so {@link runtimeTypeName} pins a stable
 * equivalent chosen to read the same way for the types a caveat context can carry.
 */
function typeError(param: string, expected: string, value: unknown): CaveatEvaluationException {
  return new CaveatEvaluationException(
    "parameterTypeMismatch",
    `could not convert context parameter \`${param}\`: a ${expected} value is required, but found ` +
      `${runtimeTypeName(value)} \`${displayValue(value)}\``,
  );
}

function runtimeTypeName(value: unknown): string {
  if (value instanceof CelUint) return "UInt64";
  if (value instanceof Uint8Array) return "Byte[]";
  if (value instanceof Map) return "Dictionary";
  if (Array.isArray(value)) return "List";
  switch (typeof value) {
    case "bigint":
      return "Int64";
    case "number":
      return "Double";
    case "string":
      return "String";
    case "boolean":
      return "Boolean";
    default:
      return value === null || value === undefined
        ? "Null"
        : ((value as object).constructor?.name ?? typeof value);
  }
}

function displayValue(value: unknown): string {
  if (value instanceof CelUint) return String(value.value);
  if (value instanceof Map) return `[${[...value.keys()].map(String).join(", ")}]`;
  if (Array.isArray(value)) return `[${value.map(String).join(", ")}]`;
  return String(value);
}
