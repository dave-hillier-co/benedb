/**
 * A node of the parsed (macro-expanded) CEL expression the static checker walks: the shape of
 * cel-go's `common/ast.Expr`, as its parser produces it.
 *
 * Ported from Spiceport `Engine/CelCheck/CelExpr.cs`.
 *
 * Port decisions:
 *   * The C# class hierarchy (an abstract `CelExpr` and one sealed subclass per node) becomes a
 *     discriminated union on `kind`. Nodes are compared by identity, exactly as the C# classes
 *     are: the checker keys its type map on the node object where cel-go keys it on the node id.
 *   * `CelLocation` (a C# record struct) is a readonly interface; `CelLocation.None` is
 *     `NO_LOCATION`.
 */
export type CelExpr =
  | CelLiteral
  | CelIdent
  | CelSelect
  | CelCall
  | CelList
  | CelMap
  | CelStruct
  | CelComprehension
  | CelUnspecified;

/**
 * A source location in a CEL expression: a 1-based line and a 0-based column counted in code
 * points, as cel-go's `common.Location`.
 */
export interface CelLocation {
  readonly line: number;
  readonly column: number;
}

/** cel-go's `common.NoLocation`. */
export const NO_LOCATION: CelLocation = { line: -1, column: -1 };

/** The literal kinds of cel-go's parser. */
export type CelLiteralKind = "bool" | "bytes" | "double" | "int" | "null" | "string" | "uint";

/** A literal. Only a string literal's value is ever consulted (an optional field selection). */
export interface CelLiteral {
  readonly kind: "literal";
  readonly location: CelLocation;
  readonly literalKind: CelLiteralKind;
  readonly stringValue: string | undefined;
}

/** An identifier reference. */
export interface CelIdent {
  readonly kind: "ident";
  readonly location: CelLocation;
  readonly name: string;
}

/** A field selection, or (when `testOnly`) a `has()` presence test. */
export interface CelSelect {
  readonly kind: "select";
  readonly location: CelLocation;
  readonly operand: CelExpr;
  readonly field: string;
  readonly testOnly: boolean;
}

/** A global (no `target`) or receiver-style function call; operators are calls too. */
export interface CelCall {
  readonly kind: "call";
  readonly location: CelLocation;
  readonly function: string;
  readonly target: CelExpr | undefined;
  readonly args: readonly CelExpr[];
}

/** A list literal; `optionalIndices` are the `[?e]` elements. */
export interface CelList {
  readonly kind: "list";
  readonly location: CelLocation;
  readonly elements: readonly CelExpr[];
  readonly optionalIndices: ReadonlySet<number>;
}

/** One `key: value` entry of a map literal. */
export interface CelMapEntry {
  readonly key: CelExpr;
  readonly value: CelExpr;
  readonly optional: boolean;
}

/** A map literal. */
export interface CelMap {
  readonly kind: "map";
  readonly location: CelLocation;
  readonly entries: readonly CelMapEntry[];
}

/** One `field: value` initializer of a message construction. */
export interface CelStructField {
  readonly location: CelLocation;
  readonly name: string;
  readonly value: CelExpr;
  readonly optional: boolean;
}

/** A message construction, `pkg.Type{field: value}`. */
export interface CelStruct {
  readonly kind: "struct";
  readonly location: CelLocation;
  readonly typeName: string;
  readonly fields: readonly CelStructField[];
}

/** A fold, as the parser's macros (`all`, `exists`, `map`, ...) expand to. */
export interface CelComprehension {
  readonly kind: "comprehension";
  readonly location: CelLocation;
  readonly iterRange: CelExpr;
  readonly iterVar: string;
  readonly accuVar: string;
  readonly accuInit: CelExpr;
  readonly loopCondition: CelExpr;
  readonly loopStep: CelExpr;
  readonly result: CelExpr;
}

/** The placeholder cel-go's parser leaves where it reported an error. */
export interface CelUnspecified {
  readonly kind: "unspecified";
  readonly location: CelLocation;
}
