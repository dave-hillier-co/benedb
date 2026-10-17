import {
  CharStreams,
  CommonTokenStream,
  ErrorListener,
  type ParserRuleContext,
  type RecognitionException,
  type Recognizer,
  type Token,
} from "antlr4";

import CELLexer from "./cel-gen/cel-lexer";
import CELParser, {
  BoolFalseContext,
  BoolTrueContext,
  BytesContext,
  CalcContext,
  ConditionalAndContext,
  ConditionalOrContext,
  ConstantLiteralContext,
  CreateListContext,
  CreateMessageContext,
  CreateStructContext,
  DoubleContext,
  ExprContext,
  IdentOrGlobalCallContext,
  IndexContext,
  IntContext,
  LogicalNotContext,
  MemberCallContext,
  MemberExprContext,
  NegateContext,
  NestedContext,
  NullContext,
  PrimaryExprContext,
  RelationContext,
  SelectContext,
  StartContext,
  StringContext,
  UintContext,
  UnaryContext,
  type ExprListContext,
  type MapInitializerListContext,
} from "./cel-gen/cel-parser";
import { NO_LOCATION } from "./cel-expr";
import type { CelExpr, CelLocation, CelMapEntry, CelStructField, CelUnspecified } from "./cel-expr";
import type { CelIssues } from "./cel-issues";
import { celUnescapeError } from "./cel-unescape";

const ACCUMULATOR_NAME = "__result__";

const RESERVED_IDS: ReadonlySet<string> = new Set([
  "as",
  "break",
  "const",
  "continue",
  "else",
  "false",
  "for",
  "function",
  "if",
  "import",
  "in",
  "let",
  "loop",
  "package",
  "namespace",
  "null",
  "return",
  "true",
  "var",
  "void",
  "while",
]);

const RESERVED_IDENTIFIER = /no viable alternative at input '.(true|false|null)'/g;

/**
 * Parses a CEL expression into the macro-expanded `CelExpr` tree the static checker walks,
 * reporting the errors cel-go's parser reports. A transliteration of cel-go's `parser/parser.go`
 * visitor and `parser/macro.go` expansions (`authzed/cel-go` v0.20.2), with the options SpiceDB's
 * caveat environment sets: the standard macros, optional syntax, and the optional library's
 * `optMap` macro.
 *
 * Not reproduced: cel-go's recursion-depth (250) and error-recovery (256) limits, which only a
 * pathological expression reaches.
 *
 * Ported from Spiceport `Engine/CelCheck/CelAstBuilder.cs`.
 *
 * Port decisions:
 *   * The C# drives the .NET `Cel` package's ANTLR lexer and parser. `@bufbuild/cel`'s parser is a
 *     PEG with no source positions, no optional syntax and its own error text, so it cannot stand
 *     in; the port instead vendors the lexer and parser ANTLR generates from cel-go's own
 *     `CEL.g4` (`cel-gen/`), over the `antlr4` runtime. The visitor below then transliterates
 *     the C# one context for context, and syntax errors carry ANTLR's (and so cel-go's) wording.
 *   * The C# overrides the .NET lexer's `GetErrorDisplay`, which escapes newlines in an
 *     unrecognized token's text where the Go runtime does not. The JavaScript runtime already
 *     reports the text verbatim, so no override is needed.
 *   * The C# private-constructor class with a static `Parse` becomes an exported function over a
 *     module-private class.
 */
export function parseCelExpr(expression: string, errors: CelIssues): CelExpr {
  const builder = new AstBuilder(errors);

  const lexer = new CELLexer(CharStreams.fromString(expression));
  lexer.removeErrorListeners();
  lexer.addErrorListener(new SyntaxErrorListener<number>(errors));

  const parser = new CELParser(new CommonTokenStream(lexer));
  parser.removeErrorListeners();
  parser.addErrorListener(new SyntaxErrorListener<Token>(errors));

  return builder.visit(parser.start());
}

type Quantifier = "all" | "exists" | "existsOne";

class AstBuilder {
  readonly #errors: CelIssues;

  constructor(errors: CelIssues) {
    this.#errors = errors;
  }

  visit(tree: ParserRuleContext | undefined | null): CelExpr {
    if (tree instanceof StartContext) return this.visit(tree._e);

    if (tree instanceof ExprContext) {
      if (tree._op === undefined || tree._op === null) return this.visit(tree._e);
      const result = this.visit(tree._e);
      const location = tokenLocation(tree._op);
      const ifTrue = this.visit(tree._e1);
      const ifFalse = this.visit(tree._e2);
      return this.#globalCallOrMacro(location, "_?_:_", [result, ifTrue, ifFalse]);
    }

    if (tree instanceof ConditionalOrContext) {
      return this.#visitLogical(tree, tree._e, tree._ops, tree._e1, "_||_", "'||'");
    }

    if (tree instanceof ConditionalAndContext) {
      return this.#visitLogical(tree, tree._e, tree._ops, tree._e1, "_&&_", "'&&'");
    }

    if (tree instanceof RelationContext) {
      if (tree._op === undefined || tree._op === null) return this.visit(tree.calc());
      return this.#visitBinary(tree, tree._op, tree.relation(0), tree.relation(1));
    }

    if (tree instanceof CalcContext) {
      if (tree._op === undefined || tree._op === null) return this.visit(tree.unary());
      return this.#visitBinary(tree, tree._op, tree.calc(0), tree.calc(1));
    }

    if (tree instanceof MemberExprContext) return this.visit(tree.member());

    if (tree instanceof LogicalNotContext) {
      if (tree._ops.length % 2 === 0) return this.visit(tree.member());
      return this.#globalCallOrMacro(tokenLocation(tree._ops[0] as Token), "!_", [
        this.visit(tree.member()),
      ]);
    }

    if (tree instanceof NegateContext) {
      if (tree._ops.length % 2 === 0) return this.visit(tree.member());
      return this.#globalCallOrMacro(tokenLocation(tree._ops[0] as Token), "-_", [
        this.visit(tree.member()),
      ]);
    }

    if (tree instanceof UnaryContext) {
      return literal(contextLocation(tree), "string", "<<error>>");
    }

    if (tree instanceof PrimaryExprContext) return this.visit(tree.primary());
    if (tree instanceof SelectContext) return this.#visitSelect(tree);
    if (tree instanceof MemberCallContext) return this.#visitMemberCall(tree);
    if (tree instanceof IndexContext) return this.#visitIndex(tree);
    if (tree instanceof IdentOrGlobalCallContext) return this.#visitIdentOrGlobalCall(tree);
    if (tree instanceof NestedContext) return this.visit(tree._e);
    if (tree instanceof CreateListContext) return this.#visitCreateList(tree);

    if (tree instanceof CreateStructContext) {
      return {
        kind: "map",
        location: tokenLocation(tree._op),
        entries: this.#visitMapInitializerList(tree._entries),
      };
    }

    if (tree instanceof CreateMessageContext) return this.#visitCreateMessage(tree);
    if (tree instanceof ConstantLiteralContext) return this.visit(tree.literal());
    if (tree instanceof IntContext) return this.#visitInt(tree);
    if (tree instanceof UintContext) return this.#visitUint(tree);
    if (tree instanceof DoubleContext) return this.#visitDouble(tree);

    if (tree instanceof StringContext) {
      this.#unquote(tree, tree.getText(), false);
      return literal(contextLocation(tree), "string", tree.getText());
    }

    if (tree instanceof BytesContext) {
      this.#unquote(tree, tree._tok.text.slice(1), true);
      return literal(contextLocation(tree), "bytes");
    }

    if (tree instanceof BoolTrueContext || tree instanceof BoolFalseContext) {
      return literal(contextLocation(tree), "bool");
    }

    if (tree instanceof NullContext) return literal(contextLocation(tree), "null");

    // Typically only reached once the parser has already reported a syntax error.
    if (this.#errors.errors.length === 0) {
      const text = tree === undefined || tree === null ? "<<nil>>" : `<<${tree.constructor.name}>>`;
      return this.#reportError(NO_LOCATION, `unknown parse element encountered: ${text}`);
    }

    return unspecified(NO_LOCATION);
  }

  #visitLogical(
    ctx: ParserRuleContext,
    first: ParserRuleContext | undefined,
    ops: readonly Token[],
    rest: readonly ParserRuleContext[],
    fn: string,
    wanted: string,
  ): CelExpr {
    const result = this.visit(first);
    if (ops.length === 0) return result;

    const terms: CelExpr[] = [result];
    const opLocations: CelLocation[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (i >= rest.length) {
        return this.#reportError(contextLocation(ctx), `unexpected character, wanted ${wanted}`);
      }
      terms.push(this.visit(rest[i]));
      opLocations.push(tokenLocation(ops[i] as Token));
    }

    return balancedTree(fn, terms, opLocations, 0, opLocations.length - 1);
  }

  #visitBinary(
    ctx: ParserRuleContext,
    op: Token,
    lhsCtx: ParserRuleContext | undefined,
    rhsCtx: ParserRuleContext | undefined,
  ): CelExpr {
    const fn = BINARY_OPERATORS.get(op.text);
    if (fn === undefined) return this.#reportError(contextLocation(ctx), "operator not found");

    const lhs = this.visit(lhsCtx);
    const location = tokenLocation(op);
    const rhs = this.visit(rhsCtx);
    return this.#globalCallOrMacro(location, fn, [lhs, rhs]);
  }

  #visitSelect(ctx: SelectContext): CelExpr {
    const operand = this.visit(ctx.member());
    if (isAbsent(ctx._id) || isAbsent(ctx._op)) return unspecified(contextLocation(ctx));

    const id = ctx._id.text;
    if (!isAbsent(ctx._opt)) {
      return call(tokenLocation(ctx._op), "_?._", undefined, [
        operand,
        literal(tokenLocation(ctx._id), "string", id),
      ]);
    }

    return {
      kind: "select",
      location: tokenLocation(ctx._op),
      operand,
      field: id,
      testOnly: false,
    };
  }

  #visitMemberCall(ctx: MemberCallContext): CelExpr {
    const operand = this.visit(ctx.member());
    if (isAbsent(ctx._id)) return unspecified(contextLocation(ctx));

    const location = tokenLocation(ctx._open);
    return this.#receiverCallOrMacro(
      location,
      ctx._id.text,
      operand,
      this.#visitExprList(ctx._args),
    );
  }

  #visitIndex(ctx: IndexContext): CelExpr {
    const target = this.visit(ctx.member());
    if (isAbsent(ctx._op)) return unspecified(contextLocation(ctx));

    const location = tokenLocation(ctx._op);
    const index = this.visit(ctx._index);
    const fn = isAbsent(ctx._opt) ? "_[_]" : "_[?_]";
    return this.#globalCallOrMacro(location, fn, [target, index]);
  }

  #visitIdentOrGlobalCall(ctx: IdentOrGlobalCallContext): CelExpr {
    let identName = isAbsent(ctx._leadingDot) ? "" : ".";
    if (isAbsent(ctx._id)) return unspecified(contextLocation(ctx));

    const id = ctx._id.text;
    if (RESERVED_IDS.has(id)) {
      return this.#reportError(contextLocation(ctx), `reserved identifier: ${id}`);
    }

    identName += id;
    if (!isAbsent(ctx._op)) {
      const location = tokenLocation(ctx._op);
      return this.#globalCallOrMacro(location, identName, this.#visitExprList(ctx._args));
    }

    return { kind: "ident", location: tokenLocation(ctx._id), name: identName };
  }

  #visitCreateList(ctx: CreateListContext): CelExpr {
    const location = tokenLocation(ctx._op);
    const elements: CelExpr[] = [];
    const optionals = new Set<number>();
    if (!isAbsent(ctx._elems)) {
      ctx._elems._elems.forEach((elem, i) => {
        elements.push(this.visit(elem._e));
        if (!isAbsent(elem._opt)) optionals.add(i);
      });
    }

    return { kind: "list", location, elements, optionalIndices: optionals };
  }

  #visitMapInitializerList(ctx: MapInitializerListContext | undefined): CelMapEntry[] {
    const result: CelMapEntry[] = [];
    if (isAbsent(ctx) || isAbsent(ctx._keys)) return result;

    for (let i = 0; i < ctx._cols.length; i++) {
      if (i >= ctx._keys.length || i >= ctx._values.length) return [];
      const optKey = ctx._keys[i] as (typeof ctx._keys)[number];
      const key = this.visit(optKey._e);
      const value = this.visit(ctx._values[i]);
      result.push({ key, value, optional: !isAbsent(optKey._opt) });
    }

    return result;
  }

  #visitCreateMessage(ctx: CreateMessageContext): CelExpr {
    let messageName = ctx._ids.map((id) => id.text).join(".");
    if (!isAbsent(ctx._leadingDot)) messageName = `.${messageName}`;

    const location = tokenLocation(ctx._op);
    let fields: CelStructField[] = [];
    const entries = ctx._entries;
    if (!isAbsent(entries) && !isAbsent(entries._fields)) {
      for (let i = 0; i < entries._fields.length; i++) {
        if (i >= entries._cols.length || i >= entries._values.length) {
          fields = [];
          break;
        }

        const optField = entries._fields[i] as (typeof entries._fields)[number];
        const id = optField.IDENTIFIER();
        if (isAbsent(id)) {
          fields = [];
          break;
        }

        const initLocation = tokenLocation(entries._cols[i] as Token);
        const value = this.visit(entries._values[i]);
        fields.push({
          location: initLocation,
          name: id.getText(),
          value,
          optional: !isAbsent(optField._opt),
        });
      }
    }

    return { kind: "struct", location, typeName: messageName, fields };
  }

  #visitInt(ctx: IntContext): CelExpr {
    const text = ctx._tok.text;
    const hex = text.startsWith("0x");
    const digits = hex ? text.slice(2) : text;
    const negative = !isAbsent(ctx._sign);
    const magnitude = parseMagnitude(digits, hex);
    if (
      magnitude === undefined ||
      (negative ? -magnitude < -(2n ** 63n) : magnitude > 2n ** 63n - 1n)
    ) {
      return this.#reportError(contextLocation(ctx), "invalid int literal");
    }

    return literal(contextLocation(ctx), "int");
  }

  #visitUint(ctx: UintContext): CelExpr {
    const text = ctx._tok.text.slice(0, -1);
    const hex = text.startsWith("0x");
    const digits = hex ? text.slice(2) : text;
    const magnitude = parseMagnitude(digits, hex);
    if (magnitude === undefined || magnitude > 2n ** 64n - 1n) {
      return this.#reportError(contextLocation(ctx), "invalid uint literal");
    }

    return literal(contextLocation(ctx), "uint");
  }

  #visitDouble(ctx: DoubleContext): CelExpr {
    const text = (isAbsent(ctx._sign) ? "" : ctx._sign.text) + ctx._tok.text;
    const value = Number(text);
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      return this.#reportError(contextLocation(ctx), "invalid double literal");
    }

    return literal(contextLocation(ctx), "double");
  }

  #visitExprList(ctx: ExprListContext | undefined): CelExpr[] {
    return isAbsent(ctx) ? [] : ctx._e.map((e) => this.visit(e));
  }

  #unquote(ctx: ParserRuleContext, value: string, isBytes: boolean): void {
    const error = celUnescapeError(value, isBytes);
    if (error !== undefined) this.#reportError(contextLocation(ctx), error);
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

  // ---- locations and errors ----

  #reportError(location: CelLocation, message: string): CelUnspecified {
    this.#errors.report(location, message);
    return unspecified(location);
  }
}

const BINARY_OPERATORS: ReadonlyMap<string, string> = new Map([
  ["<", "_<_"],
  ["<=", "_<=_"],
  [">", "_>_"],
  [">=", "_>=_"],
  ["==", "_==_"],
  ["!=", "_!=_"],
  ["in", "@in"],
  ["+", "_+_"],
  ["-", "_-_"],
  ["*", "_*_"],
  ["/", "_/_"],
  ["%", "_%_"],
]);

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

function tokenLocation(token: Token): CelLocation {
  return { line: token.line, column: token.column };
}

function contextLocation(ctx: ParserRuleContext): CelLocation {
  return isAbsent(ctx.start) ? NO_LOCATION : tokenLocation(ctx.start);
}

/**
 * The generated contexts declare their labelled children as always present; on an
 * error-recovered tree they may be missing, as cel-go's nil checks anticipate.
 */
function isAbsent<T>(value: T | undefined | null): value is undefined | null {
  return value === undefined || value === null;
}

function assertNever(value: never): never {
  throw new Error(`unexpected quantifier: ${String(value)}`);
}

/** cel-go's parser-as-error-listener: every lexer and parser error is a syntax error. */
class SyntaxErrorListener<TSymbol> extends ErrorListener<TSymbol> {
  readonly #errors: CelIssues;

  constructor(errors: CelIssues) {
    super();
    this.#errors = errors;
  }

  override syntaxError(
    _recognizer: Recognizer<TSymbol>,
    _offendingSymbol: TSymbol,
    line: number,
    column: number,
    msg: string,
    _e: RecognitionException | undefined,
  ): void {
    const message = msg.includes("no viable alternative")
      ? msg.replaceAll(RESERVED_IDENTIFIER, "mismatched input '$1' expecting IDENTIFIER")
      : msg;
    this.#errors.report({ line, column }, `Syntax error: ${message}`);
  }
}
