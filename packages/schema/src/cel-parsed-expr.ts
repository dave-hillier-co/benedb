import { createEnv, type CelEnv } from "@bufbuild/cel";
import { createRegistry } from "@bufbuild/protobuf";

import { NO_LOCATION } from "./cel-expr";
import type { CelExpr, CelLocation, CelMapEntry, CelStructField, CelUnspecified } from "./cel-expr";
import type { CelIssues } from "./cel-issues";
import { tokenizeCelSource } from "./cel-source-tokens";
import type { CelToken } from "./cel-source-tokens";

type Expr = NonNullable<ReturnType<CelEnv["parse"]>["expr"]>;
type ExprCall = Extract<Expr["exprKind"], { case: "callExpr" }>["value"];
type ExprSelect = Extract<Expr["exprKind"], { case: "selectExpr" }>["value"];
type ExprComprehension = Extract<Expr["exprKind"], { case: "comprehensionExpr" }>["value"];
type ExprConstant = Extract<Expr["exprKind"], { case: "constExpr" }>["value"];

const ACCUMULATOR_NAME = "__result__";

/** The binary operators and the token each is written with. */
const BINARY_OPERATORS: ReadonlyMap<string, string> = new Map([
  ["_<_", "<"],
  ["_<=_", "<="],
  ["_>_", ">"],
  ["_>=_", ">="],
  ["_==_", "=="],
  ["_!=_", "!="],
  ["@in", "in"],
  ["_+_", "+"],
  ["_-_", "-"],
  ["_*_", "*"],
  ["_/_", "/"],
  ["_%_", "%"],
]);

/** Parsing binds no variables and registers nothing, so one environment serves every parse. */
const environment: CelEnv = createEnv("", createRegistry());

/**
 * Parses a CEL expression with `@bufbuild/cel` and converts its canonical `cel.expr.Expr` into the
 * macro-expanded `CelExpr` tree the static checker walks, shaped and placed exactly as cel-go's
 * parser (`authzed/cel-go` v0.20.2, with the standard macros and the optional library's `optMap`)
 * would shape and place it. Type checking then sees what cel-go's checker sees, so a type error
 * carries cel-go's message, line, column and caret.
 *
 * `@bufbuild/cel` yields the canonical AST cel-go's checker also consumes, with these differences,
 * each undone here:
 *   * No source positions. `createEnv`'s parser returns a `ParsedExpr` without `source_info`, and the
 *     package exports nothing else. Positions are recovered by walking the tree over the source's
 *     tokens (`cel-source-tokens`) and taking, for each node, the token cel-go anchors it at: the
 *     operator of a binary or unary call, `?` of a conditional, `.` of a selection, `[` of an index
 *     or list, `(` of a call and of a macro, `{` of a map or message, `:` of a message field.
 *   * `&&` and `||` chains are one n-ary call; cel-go balances them into a binary tree.
 *   * A leading dot is dropped from an identifier or global function name.
 *   * `!(!x)` and `-(-x)` are folded to `x`, where cel-go keeps both calls (so `!(!a)` over an `any`
 *     parameter is `bool` in cel-go, but would be `dyn` folded).
 *   * `- 1` (sign and digits apart) is a negation, where cel-go reads one signed literal: so
 *     `- 1.f()` negates the call, where cel-go calls `f` on `-1`.
 *   * Macros are expanded only when their variable is an identifier, `existsOne` is expanded as an
 *     alias of `exists_one`, and `optMap` is not expanded. cel-go reports "argument must be a simple
 *     name" (or "argument is not an identifier", or "invalid argument to has() macro") for the first,
 *     has no `existsOne`, and expands `optMap`: each is reproduced through cel-go's own macro table.
 *   * An out-of-range numeric literal is accepted; cel-go reports "invalid int literal" (or uint,
 *     or double), and so does this conversion.
 *
 * Not undone (the documented divergences of this port): a syntax error carries `@bufbuild/cel`'s
 * message and position, not ANTLR's; and its grammar is not cel-go's. It is lenient with escape
 * sequences (`"\q"` is accepted) and with a list of bare commas (`[,]`), and it does not accept the
 * optional syntax (`a.?b`, `a[?b]`, `[?a]`, `{?k: v}`, `Msg{?f: v}`), a `0X` hex prefix, an `rb`
 * bytes prefix, a triple-quoted string spanning lines, or a space between repeated unary operators
 * (`! !a`). Each is listed in `docs/port-plan.md`.
 *
 * `@bufbuild/cel` also cannot lex a `//` comment ending the input with no newline after it; that
 * one is undone by parsing the expression with a newline appended.
 *
 * Ported from Spiceport `Engine/CelCheck/CelAstBuilder.cs`: the macro expansions and literal checks
 * below are its, verbatim; the parse it walks is `@bufbuild/cel`'s rather than an ANTLR tree.
 */
export function parseCelExpr(expression: string, errors: CelIssues): CelExpr {
  let root: Expr | undefined;
  try {
    // `@bufbuild/cel` cannot lex a `//` comment that runs to the end of the input, which cel-go
    // accepts; a newline ends any such comment and is otherwise whitespace.
    root = environment.parse(`${expression}\n`).expr;
  } catch (error) {
    reportParseFailure(expression, error, errors);
    return unspecified(NO_LOCATION);
  }

  if (root === undefined) {
    errors.report(NO_LOCATION, "unknown parse element encountered: <<nil>>");
    return unspecified(NO_LOCATION);
  }

  return new ParsedExprConverter(tokenizeCelSource(expression), errors).convert(root);
}

/** A `@bufbuild/cel` fold of `op(op(x))` to `x`, to be restored around the node it returned. */
interface FoldedUnary {
  readonly fn: string;
  /** The index of the outer operator run's first token. */
  readonly start: number;
  /** The index of the `)` closing the operand of the outer operator. */
  readonly close: number;
  /** The index of the inner operator run's first token. */
  readonly innerRun: number;
}

type Quantifier = "all" | "exists" | "existsOne";

class ParsedExprConverter {
  readonly #tokens: readonly CelToken[];
  readonly #errors: CelIssues;
  readonly #folded: FoldedUnary[] = [];
  #pos = 0;
  /** Grouping parentheses opened, and not yet closed, in the current argument context. */
  #open = 0;
  /** A `-` written apart from the number after it, which cel-go reads as the number's sign. */
  #pendingSign: CelToken | undefined;

  constructor(tokens: readonly CelToken[], errors: CelIssues) {
    this.#tokens = tokens;
    this.#errors = errors;
  }

  convert(root: Expr): CelExpr {
    const result = this.#context(root);
    if (this.#pos !== this.#tokens.length) this.#misaligned("end of expression");
    return result;
  }

  /** Converts an expression that stands alone between delimiters: an argument, element or entry. */
  #context(node: Expr): CelExpr {
    const saved = this.#open;
    this.#open = 0;
    const result = this.#expr(node);
    if (this.#open !== 0) this.#misaligned(")");
    this.#open = saved;
    return result;
  }

  #expr(node: Expr): CelExpr {
    const entry = this.#pos;
    let result = this.#exprBody(node);
    for (;;) {
      const folded = this.#folded.at(-1);
      if (folded !== undefined && this.#pos === folded.close && entry <= folded.start) {
        this.#folded.pop();
        const outer = this.#token(folded.start).location;
        const inner = this.#token(folded.innerRun).location;
        this.#pos++;
        result = call(outer, folded.fn, undefined, [call(inner, folded.fn, undefined, [result])]);
        continue;
      }
      if (
        this.#open > 0 &&
        this.#isText(this.#pos, ")") &&
        !this.#folded.some((f) => f.close === this.#pos)
      ) {
        this.#pos++;
        this.#open--;
        continue;
      }
      return result;
    }
  }

  #exprBody(node: Expr): CelExpr {
    const kind = node.exprKind;
    switch (kind.case) {
      case "callExpr": {
        const c = kind.value;
        if (c.target !== undefined) return this.#memberCall(c, c.target);
        if (c.function === "_&&_" || c.function === "_||_") return this.#logical(c);
        if (c.function === "_?_:_") return this.#conditional(c);
        if (c.function === "_[_]") return this.#index(c);
        const operator = BINARY_OPERATORS.get(c.function);
        if (operator !== undefined && c.args.length === 2) return this.#binary(c, operator);
        return this.#prefixed(node);
      }
      case "selectExpr":
        return kind.value.testOnly ? this.#prefixed(node) : this.#select(kind.value);
      case "comprehensionExpr":
        return this.#comprehension(kind.value);
      case "identExpr":
      case "constExpr":
      case "listExpr":
      case "structExpr":
        return this.#prefixed(node);
      default:
        return this.#misaligned(`an expression of kind ${String(kind.case)}`);
    }
  }

  // ---- infix and postfix forms: the leftmost operand comes first ----

  #binary(c: ExprCall, operator: string): CelExpr {
    const lhs = this.#expr(c.args[0] as Expr);
    const location = this.#expect(operator).location;
    const rhs = this.#expr(c.args[1] as Expr);
    return this.#globalCallOrMacro(location, c.function, [lhs, rhs]);
  }

  #logical(c: ExprCall): CelExpr {
    const operator = c.function === "_&&_" ? "&&" : "||";
    const terms: CelExpr[] = [this.#expr(c.args[0] as Expr)];
    const operators: CelLocation[] = [];
    for (const arg of c.args.slice(1)) {
      operators.push(this.#expect(operator).location);
      terms.push(this.#expr(arg));
    }
    return balancedTree(c.function, terms, operators, 0, operators.length - 1);
  }

  #conditional(c: ExprCall): CelExpr {
    const condition = this.#expr(c.args[0] as Expr);
    const location = this.#expect("?").location;
    const ifTrue = this.#expr(c.args[1] as Expr);
    this.#expect(":");
    const ifFalse = this.#expr(c.args[2] as Expr);
    return this.#globalCallOrMacro(location, "_?_:_", [condition, ifTrue, ifFalse]);
  }

  #index(c: ExprCall): CelExpr {
    const target = this.#expr(c.args[0] as Expr);
    const location = this.#expect("[").location;
    const index = this.#context(c.args[1] as Expr);
    this.#expect("]");
    return this.#globalCallOrMacro(location, "_[_]", [target, index]);
  }

  #select(s: ExprSelect): CelExpr {
    const operand = this.#expr(s.operand as Expr);
    const location = this.#expect(".").location;
    const field = this.#expectIdentifier().text;
    return { kind: "select", location, operand, field, testOnly: false };
  }

  #memberCall(c: ExprCall, targetNode: Expr): CelExpr {
    const target = this.#expr(targetNode);
    this.#expect(".");
    const name = this.#expectIdentifier().text;
    const location = this.#expect("(").location;
    const args = this.#arguments(c.args, ")");
    return this.#receiverCallOrMacro(location, name, target, args);
  }

  /** A macro `@bufbuild/cel` expanded: recover the call cel-go's macro table expands. */
  #comprehension(c: ExprComprehension): CelExpr {
    const target = this.#expr(c.iterRange as Expr);
    this.#expect(".");
    const name = this.#expectIdentifier().text;
    const location = this.#expect("(").location;
    const variableToken = this.#expectIdentifier();
    const variable = ident(variableToken.location, variableToken.text);
    const rest = this.#arguments(
      macroArguments(name, c) ?? this.#misaligned(`a ${name} macro`),
      ")",
      true,
    );
    return this.#receiverCallOrMacro(location, name, target, [variable, ...rest]);
  }

  // ---- prefix forms: grouping, unary operators, then an atom ----

  #prefixed(node: Expr): CelExpr {
    for (;;) {
      if (this.#isText(this.#pos, "(")) {
        this.#pos++;
        this.#open++;
        continue;
      }

      const inner = this.#folded.find((f) => f.innerRun === this.#pos);
      if (inner !== undefined) {
        this.#pos += this.#runLength(this.#pos, this.#token(this.#pos).text);
        continue;
      }

      const op = this.#token(this.#pos).text;
      if ((op === "!" || op === "-") && this.#token(this.#pos).kind === "punctuation") {
        if (op === "-" && isNumericConstant(node) && this.#isSignedNumber(this.#pos)) break;

        const runStart = this.#pos;
        const run = this.#runLength(runStart, op);
        const fn = `${op}_`;
        if (run % 2 === 0) {
          this.#pos += run;
          continue;
        }

        const folded = this.#foldedAt(runStart, run, fn);
        if (folded !== undefined) {
          this.#folded.push(folded);
          this.#pos = runStart + run + 1;
          continue;
        }

        const kind = node.exprKind;
        if (
          kind.case !== "callExpr" ||
          kind.value.function !== fn ||
          kind.value.args.length !== 1
        ) {
          return this.#misaligned(`an operand of ${op}`);
        }
        this.#pos += run;
        const operand = kind.value.args[0] as Expr;
        // cel-go reads `- 1` as one signed literal, as it reads `-1`, so in `- 1.f()` the sign
        // belongs to the literal the call is made on, where @bufbuild/cel negates the call.
        if (op === "-" && run === 1 && this.#isSignableNumber(this.#pos)) {
          this.#pendingSign = this.#token(runStart);
          return this.#expr(operand);
        }
        const location = this.#token(runStart).location;
        return this.#globalCallOrMacro(location, fn, [this.#expr(operand)]);
      }
      break;
    }

    return this.#atom(node);
  }

  #atom(node: Expr): CelExpr {
    const kind = node.exprKind;
    switch (kind.case) {
      case "constExpr": {
        let sign = this.#pendingSign;
        this.#pendingSign = undefined;
        if (sign === undefined && this.#isText(this.#pos, "-")) sign = this.#next();
        return this.#literal(node, sign);
      }
      case "identExpr": {
        const dot = this.#isText(this.#pos, ".") ? this.#next() : undefined;
        const id = this.#expectIdentifier();
        return ident(id.location, (dot === undefined ? "" : ".") + id.text);
      }
      case "callExpr": {
        const dot = this.#isText(this.#pos, ".") ? this.#next() : undefined;
        const name = (dot === undefined ? "" : ".") + this.#expectIdentifier().text;
        const location = this.#expect("(").location;
        const args = this.#arguments(kind.value.args, ")");
        return this.#globalCallOrMacro(location, name, args);
      }
      case "selectExpr": {
        // has(a.b), which @bufbuild/cel expanded to a presence test.
        const dot = this.#isText(this.#pos, ".") ? this.#next() : undefined;
        const name = (dot === undefined ? "" : ".") + this.#expectIdentifier().text;
        const location = this.#expect("(").location;
        const select: Expr = {
          ...node,
          exprKind: { case: "selectExpr", value: { ...kind.value, testOnly: false } },
        };
        const args = this.#arguments([select], ")");
        return this.#globalCallOrMacro(location, name, args);
      }
      case "listExpr": {
        const location = this.#expect("[").location;
        const elements = this.#arguments(kind.value.elements, "]");
        return { kind: "list", location, elements, optionalIndices: new Set() };
      }
      case "structExpr":
        return kind.value.messageName === ""
          ? this.#createMap(kind.value.entries)
          : this.#createMessage(kind.value.entries);
      default:
        return this.#misaligned(`an expression of kind ${String(kind.case)}`);
    }
  }

  #createMap(
    entries: Extract<Expr["exprKind"], { case: "structExpr" }>["value"]["entries"],
  ): CelExpr {
    const location = this.#expect("{").location;
    const result: CelMapEntry[] = [];
    for (const entry of entries) {
      this.#skipCommas();
      if (entry.keyKind.case !== "mapKey" || entry.value === undefined) {
        return this.#misaligned("a map entry");
      }
      const key = this.#context(entry.keyKind.value);
      this.#expect(":");
      const value = this.#context(entry.value);
      result.push({ key, value, optional: false });
    }
    this.#skipCommas();
    this.#expect("}");
    return { kind: "map", location, entries: result };
  }

  #createMessage(
    entries: Extract<Expr["exprKind"], { case: "structExpr" }>["value"]["entries"],
  ): CelExpr {
    const dot = this.#isText(this.#pos, ".") ? this.#next() : undefined;
    let typeName = (dot === undefined ? "" : ".") + this.#expectIdentifier().text;
    while (this.#isText(this.#pos, ".")) {
      this.#next();
      typeName += `.${this.#expectIdentifier().text}`;
    }

    const location = this.#expect("{").location;
    const fields: CelStructField[] = [];
    for (const entry of entries) {
      this.#skipCommas();
      if (entry.keyKind.case !== "fieldKey" || entry.value === undefined) {
        return this.#misaligned("a message field");
      }
      const name = this.#expectIdentifier().text;
      const initLocation = this.#expect(":").location;
      const value = this.#context(entry.value);
      fields.push({ location: initLocation, name, value, optional: false });
    }
    this.#skipCommas();
    this.#expect("}");
    return { kind: "struct", location, typeName, fields };
  }

  /** A literal, at its sign when it has one; validated as cel-go's parser validates it. */
  #literal(node: Expr, sign: CelToken | undefined): CelExpr {
    const constant = (node.exprKind as { case: "constExpr"; value: ExprConstant }).value;
    const value = constant.constantKind;
    const token = this.#next();
    const location = (sign ?? token).location;
    switch (value.case) {
      case "boolValue":
        return literal(location, "bool");
      case "nullValue":
        return literal(location, "null");
      case "stringValue":
        return literal(location, "string", value.value);
      case "bytesValue":
        return literal(location, "bytes");
      case "int64Value":
        return this.#visitInt(location, token.text, sign !== undefined);
      case "uint64Value":
        return this.#visitUint(location, token.text);
      case "doubleValue":
        return this.#visitDouble(location, (sign === undefined ? "" : "-") + token.text);
      default:
        return this.#misaligned("a literal");
    }
  }

  #visitInt(location: CelLocation, text: string, negative: boolean): CelExpr {
    const hex = text.startsWith("0x");
    const digits = hex ? text.slice(2) : text;
    const magnitude = parseMagnitude(digits, hex);
    if (
      magnitude === undefined ||
      (negative ? -magnitude < -(2n ** 63n) : magnitude > 2n ** 63n - 1n)
    ) {
      return this.#reportError(location, "invalid int literal");
    }

    return literal(location, "int");
  }

  #visitUint(location: CelLocation, token: string): CelExpr {
    const text = token.slice(0, -1);
    const hex = text.startsWith("0x");
    const digits = hex ? text.slice(2) : text;
    const magnitude = parseMagnitude(digits, hex);
    if (magnitude === undefined || magnitude > 2n ** 64n - 1n) {
      return this.#reportError(location, "invalid uint literal");
    }

    return literal(location, "uint");
  }

  #visitDouble(location: CelLocation, text: string): CelExpr {
    const value = Number(text);
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      return this.#reportError(location, "invalid double literal");
    }

    return literal(location, "double");
  }

  /** Converts delimited, comma-separated expressions and consumes the closing delimiter. */
  #arguments(nodes: readonly Expr[], close: string, afterVariable = false): CelExpr[] {
    const result: CelExpr[] = [];
    for (const node of nodes) {
      if (afterVariable || result.length > 0) this.#expect(",");
      this.#skipCommas();
      result.push(this.#context(node));
    }
    this.#skipCommas();
    this.#expect(close);
    return result;
  }

  // ---- @bufbuild/cel's unary fold ----

  /**
   * The fold at an odd run of `op` starting at `runStart`, when the run's operand is a group whose
   * content `@bufbuild/cel` parsed as an `op` call: it then returned that call's operand in place of
   * both calls.
   */
  #foldedAt(runStart: number, run: number, fn: string): FoldedUnary | undefined {
    const open = runStart + run;
    if (!this.#isText(open, "(")) return undefined;
    const close = this.#token(open).match;
    if (close < 0 || this.#memberEnd(open) !== close + 1) return undefined;
    const innerRun = this.#unaryRunOf(open + 1, close, fn.slice(0, 1));
    return innerRun < 0 ? undefined : { fn, start: runStart, close, innerRun };
  }

  /**
   * For the tokens `[start, end)` of a group's content, the first token of the run of `op` whose
   * call `@bufbuild/cel` returns for the content, or -1 when it does not return an `op` call.
   */
  #unaryRunOf(start: number, end: number, op: string): number {
    while (this.#isText(start, "(") && this.#token(start).match === end - 1) {
      start++;
      end--;
    }

    const run = this.#runLength(start, op);
    if (run === 0 || (op === "-" && this.#isSignedNumber(start))) return -1;
    const operand = start + run;
    if (this.#memberEnd(operand) !== end) return -1;

    const inner =
      this.#isText(operand, "(") && this.#token(operand).match === end - 1
        ? this.#unaryRunOf(operand + 1, end - 1, op)
        : -1;
    if (run % 2 === 0) return inner;
    return inner < 0 ? start : -1;
  }

  /** The index just past the member (a primary and its selections, calls and indexes) at `i`. */
  #memberEnd(i: number): number {
    if (this.#isSignedNumber(i)) i++;
    if (this.#isText(i, ".")) i++;

    const first = this.#tokens[i];
    if (first === undefined) return -1;
    if (first.kind === "identifier") {
      i++;
      if (this.#isText(i, "(")) i = this.#token(i).match + 1;
    } else if (first.kind === "number" || first.kind === "string") {
      i++;
    } else if (first.text === "(" || first.text === "[" || first.text === "{") {
      i = first.match + 1;
    } else {
      return -1;
    }

    for (;;) {
      if (this.#isText(i, ".") && this.#tokens[i + 1]?.kind === "identifier") {
        i += 2;
        if (this.#isText(i, "(")) i = this.#token(i).match + 1;
      } else if (this.#isText(i, "[") || this.#isText(i, "{")) {
        i = this.#token(i).match + 1;
      } else {
        return i;
      }
    }
  }

  /** The number of adjacent `op` characters (`!!!`) starting at token `i`. */
  #runLength(i: number, op: string): number {
    let run = 0;
    while (
      this.#isText(i + run, op) &&
      (run === 0 || this.#token(i + run).offset === this.#token(i + run - 1).offset + 1)
    ) {
      run++;
    }
    return run;
  }

  /** True when token `i` is an int or double literal: one a sign may be read into. */
  #isSignableNumber(i: number): boolean {
    const token = this.#tokens[i];
    return token?.kind === "number" && !/[uU]$/.test(token.text);
  }

  /** True when token `i` is a `-` written against a number: one signed literal. */
  #isSignedNumber(i: number): boolean {
    return (
      this.#isText(i, "-") &&
      !this.#isText(i + 1, "-") &&
      this.#isNumber(i + 1) &&
      this.#token(i + 1).offset === this.#token(i).offset + 1
    );
  }

  // ---- macros (parser/macro.go, cel/library.go optMap) ----

  #globalCallOrMacro(location: CelLocation, fn: string, args: readonly CelExpr[]): CelExpr {
    if (fn === "has" && args.length === 1) {
      const arg = args[0] as CelExpr;
      if (arg.kind === "select") {
        return { kind: "select", location, operand: arg.operand, field: arg.field, testOnly: true };
      }
      return this.#reportError(arg.location, "invalid argument to has() macro");
    }

    return call(location, fn, undefined, args);
  }

  #receiverCallOrMacro(
    location: CelLocation,
    fn: string,
    target: CelExpr,
    args: readonly CelExpr[],
  ): CelExpr {
    if (fn === "all" && args.length === 2) return this.#quantifier(location, "all", target, args);
    if (fn === "exists" && args.length === 2) {
      return this.#quantifier(location, "exists", target, args);
    }
    if (fn === "exists_one" && args.length === 2) {
      return this.#quantifier(location, "existsOne", target, args);
    }
    if (fn === "map" && (args.length === 2 || args.length === 3)) {
      return this.#makeMap(location, target, args);
    }
    if (fn === "filter" && args.length === 2) return this.#makeFilter(location, target, args);
    if (fn === "optMap" && args.length === 2) return this.#optMap(location, target, args);
    return call(location, fn, target, args);
  }

  #quantifier(
    at: CelLocation,
    quantifier: Quantifier,
    target: CelExpr,
    args: readonly CelExpr[],
  ): CelExpr {
    const v = args[0] as CelExpr;
    if (v.kind !== "ident") return this.#reportError(v.location, "argument must be a simple name");
    const predicate = args[1] as CelExpr;

    const accu = (): CelExpr => ident(at, ACCUMULATOR_NAME);
    let init: CelExpr;
    let condition: CelExpr;
    let step: CelExpr;
    let result: CelExpr;
    switch (quantifier) {
      case "all":
        init = literal(at, "bool");
        condition = call(at, "@not_strictly_false", undefined, [accu()]);
        step = call(at, "_&&_", undefined, [accu(), predicate]);
        result = accu();
        break;
      case "exists":
        init = literal(at, "bool");
        condition = call(at, "@not_strictly_false", undefined, [
          call(at, "!_", undefined, [accu()]),
        ]);
        step = call(at, "_||_", undefined, [accu(), predicate]);
        result = accu();
        break;
      case "existsOne":
        init = literal(at, "int");
        condition = literal(at, "bool");
        step = call(at, "_?_:_", undefined, [
          predicate,
          call(at, "_+_", undefined, [accu(), literal(at, "int")]),
          accu(),
        ]);
        result = call(at, "_==_", undefined, [accu(), literal(at, "int")]);
        break;
      default:
        return assertNever(quantifier);
    }

    return comprehension(at, target, v.name, init, condition, step, result);
  }

  #makeMap(at: CelLocation, target: CelExpr, args: readonly CelExpr[]): CelExpr {
    const v = args[0] as CelExpr;
    if (v.kind !== "ident") return this.#reportError(v.location, "argument is not an identifier");

    const filter = args.length === 3 ? args[1] : undefined;
    const fn = (args.length === 3 ? args[2] : args[1]) as CelExpr;

    let step: CelExpr = call(at, "_+_", undefined, [ident(at, ACCUMULATOR_NAME), list(at, [fn])]);
    if (filter !== undefined) {
      step = call(at, "_?_:_", undefined, [filter, step, ident(at, ACCUMULATOR_NAME)]);
    }

    return comprehension(
      at,
      target,
      v.name,
      list(at, []),
      literal(at, "bool"),
      step,
      ident(at, ACCUMULATOR_NAME),
    );
  }

  #makeFilter(at: CelLocation, target: CelExpr, args: readonly CelExpr[]): CelExpr {
    const v = args[0] as CelExpr;
    if (v.kind !== "ident") return this.#reportError(v.location, "argument is not an identifier");

    let step: CelExpr = call(at, "_+_", undefined, [ident(at, ACCUMULATOR_NAME), list(at, [v])]);
    step = call(at, "_?_:_", undefined, [args[1] as CelExpr, step, ident(at, ACCUMULATOR_NAME)]);

    return comprehension(
      at,
      target,
      v.name,
      list(at, []),
      literal(at, "bool"),
      step,
      ident(at, ACCUMULATOR_NAME),
    );
  }

  #optMap(at: CelLocation, target: CelExpr, args: readonly CelExpr[]): CelExpr {
    const v = args[0] as CelExpr;
    if (v.kind !== "ident") {
      return this.#reportError(v.location, "optMap() variable name must be a simple identifier");
    }

    return call(at, "_?_:_", undefined, [
      call(at, "hasValue", target, []),
      call(at, "optional.of", undefined, [
        {
          kind: "comprehension",
          location: at,
          iterRange: list(at, []),
          iterVar: "#unused",
          accuVar: v.name,
          accuInit: call(at, "value", target, []),
          loopCondition: literal(at, "bool"),
          loopStep: ident(at, v.name),
          result: args[1] as CelExpr,
        },
      ]),
      call(at, "optional.none", undefined, []),
    ]);
  }

  // ---- tokens and errors ----

  #token(i: number): CelToken {
    const token = this.#tokens[i];
    if (token === undefined) return this.#misaligned("a token");
    return token;
  }

  #isText(i: number, text: string): boolean {
    const token = this.#tokens[i];
    return token !== undefined && token.text === text && token.kind !== "string";
  }

  #isNumber(i: number): boolean {
    return this.#tokens[i]?.kind === "number";
  }

  #next(): CelToken {
    return this.#token(this.#pos++);
  }

  #expect(text: string): CelToken {
    if (!this.#isText(this.#pos, text)) return this.#misaligned(`'${text}'`);
    return this.#next();
  }

  #expectIdentifier(): CelToken {
    if (this.#tokens[this.#pos]?.kind !== "identifier") return this.#misaligned("an identifier");
    return this.#next();
  }

  #skipCommas(): void {
    while (this.#isText(this.#pos, ",")) this.#pos++;
  }

  #reportError(location: CelLocation, message: string): CelUnspecified {
    this.#errors.report(location, message);
    return unspecified(location);
  }

  /**
   * The tree and the tokens disagree: an invariant of the conversion, not a property of the
   * expression, so it surfaces as an internal error rather than as a caveat compile failure.
   */
  #misaligned(expected: string): never {
    const token = this.#tokens[this.#pos];
    const found = token === undefined ? "end of expression" : `'${token.text}'`;
    throw new Error(`CEL source alignment failed: expected ${expected}, found ${found}`);
  }
}

/**
 * The arguments after the variable of a macro `@bufbuild/cel` expanded, read back out of its
 * expansion (`builder.js`), in source order; undefined for a shape it does not produce.
 */
function macroArguments(name: string, c: ExprComprehension): readonly Expr[] | undefined {
  const step = c.loopStep?.exprKind;
  if (step?.case !== "callExpr") return undefined;
  const stepArgs = step.value.args;
  switch (name) {
    case "all":
    case "exists":
      return stepArgs[1] === undefined ? undefined : [stepArgs[1]];
    case "exists_one":
    case "existsOne":
    case "filter":
      return stepArgs[0] === undefined ? undefined : [stepArgs[0]];
    case "map": {
      if (step.value.function === "_+_") {
        const transform = listElement(stepArgs[1]);
        return transform === undefined ? undefined : [transform];
      }
      const append = stepArgs[1]?.exprKind;
      const transform = append?.case === "callExpr" ? listElement(append.value.args[1]) : undefined;
      return stepArgs[0] === undefined || transform === undefined
        ? undefined
        : [stepArgs[0], transform];
    }
    default:
      return undefined;
  }
}

function listElement(e: Expr | undefined): Expr | undefined {
  return e?.exprKind.case === "listExpr" ? e.exprKind.value.elements[0] : undefined;
}

function isNumericConstant(e: Expr): boolean {
  if (e.exprKind.case !== "constExpr") return false;
  const kind = e.exprKind.value.constantKind.case;
  return kind === "int64Value" || kind === "doubleValue";
}

/**
 * Reports a parse `@bufbuild/cel` rejected, at the position it gives (a UTF-16 offset, placed here
 * as cel-go places a location: line by `\n`, column in code points).
 */
function reportParseFailure(expression: string, error: unknown, errors: CelIssues): void {
  if (!(error instanceof Error)) throw error;

  const failure = error as Error & {
    rawMessage?: unknown;
    location?: { start?: { offset?: unknown } };
  };
  const offset = failure.location?.start?.offset;
  if (typeof offset !== "number" || typeof failure.rawMessage !== "string") {
    errors.report(NO_LOCATION, `Syntax error: ${error.message}`);
    return;
  }

  // An error at the end of input lies past the newline `parseCelExpr` appended; cel-go places it at
  // the end of the expression itself.
  const before = Array.from(expression.slice(0, Math.min(offset, expression.length)));
  const lastNewline = before.lastIndexOf("\n");
  const location: CelLocation = {
    line: before.filter((c) => c === "\n").length + 1,
    column: before.length - (lastNewline + 1),
  };

  if (failure.rawMessage === "reserved identifier") {
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expression.slice(offset))?.[0] ?? "";
    errors.report(location, `reserved identifier: ${word}`);
    return;
  }

  errors.report(location, `Syntax error: ${failure.rawMessage}`);
}

/** cel-go's balancing logic manager: `a || b || c || d` becomes a balanced binary tree. */
function balancedTree(
  fn: string,
  terms: readonly CelExpr[],
  ops: readonly CelLocation[],
  lo: number,
  hi: number,
): CelExpr {
  const mid = Math.floor((lo + hi + 1) / 2);
  const left = mid === lo ? (terms[mid] as CelExpr) : balancedTree(fn, terms, ops, lo, mid - 1);
  const right =
    mid === hi ? (terms[mid + 1] as CelExpr) : balancedTree(fn, terms, ops, mid + 1, hi);
  return call(ops[mid] as CelLocation, fn, undefined, [left, right]);
}

function parseMagnitude(digits: string, hex: boolean): bigint | undefined {
  if (digits.length === 0) return undefined;
  if (!(hex ? /^[0-9a-fA-F]+$/ : /^[0-9]+$/).test(digits)) return undefined;
  return BigInt(hex ? `0x${digits}` : digits);
}

function literal(
  location: CelLocation,
  literalKind: "bool" | "bytes" | "double" | "int" | "null" | "string" | "uint",
  stringValue?: string,
): CelExpr {
  return { kind: "literal", location, literalKind, stringValue };
}

function ident(location: CelLocation, name: string): CelExpr {
  return { kind: "ident", location, name };
}

function call(
  location: CelLocation,
  fn: string,
  target: CelExpr | undefined,
  args: readonly CelExpr[],
): CelExpr {
  return { kind: "call", location, function: fn, target, args };
}

function list(location: CelLocation, elements: readonly CelExpr[]): CelExpr {
  return { kind: "list", location, elements, optionalIndices: new Set() };
}

function comprehension(
  location: CelLocation,
  iterRange: CelExpr,
  iterVar: string,
  accuInit: CelExpr,
  loopCondition: CelExpr,
  loopStep: CelExpr,
  result: CelExpr,
): CelExpr {
  return {
    kind: "comprehension",
    location,
    iterRange,
    iterVar,
    accuVar: ACCUMULATOR_NAME,
    accuInit,
    loopCondition,
    loopStep,
    result,
  };
}

function unspecified(location: CelLocation): CelUnspecified {
  return { kind: "unspecified", location };
}

function assertNever(value: never): never {
  throw new Error(`unexpected quantifier: ${String(value)}`);
}
