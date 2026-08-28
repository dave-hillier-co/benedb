/**
 * The schema DSL abstract syntax tree: the shape `parse` produces and `SchemaCompiler` consumes.
 *
 * Ported from Spiceport `Ast.cs`, which declares the whole cluster in one file. The cluster stays
 * in one module here because every type in it is a node of the same tree.
 *
 * Port decisions:
 *   * Every C# record here is `internal`. TypeScript has no `internal`, and there are no barrels,
 *     so the containment is that nothing outside this package imports from this module.
 *   * `ExprNode` is a sealed record hierarchy, so it becomes a discriminated union with a literal
 *     `kind`, matched with a local `assertNever` at each walk site.
 *   * `SetOp` is DELIBERATELY DISTINCT from core's `SetOperationType`. In the C# the two enums
 *     even number differently (0/1/2 here, 1/2/3 there) and `SchemaCompiler.CompileBinary`
 *     translates between them; keeping two types preserves that boundary.
 *   * `TypeRefNode.subrelation` is undefined when the `#relation` suffix is absent. The parser
 *     does not default it to the ellipsis - the compiler does.
 */

/** Root of a parsed schema file: a list of top-level definitions. */
export interface SchemaFileNode {
  readonly definitions: readonly DefinitionNode[];
  readonly caveats: readonly CaveatNode[];
}

/** A `definition` block containing relations and permissions. */
export interface DefinitionNode {
  readonly name: string;
  readonly relations: readonly RelationNode[];
  readonly permissions: readonly PermissionNode[];
}

/** A `relation` declaration with its allowed subject types. */
export interface RelationNode {
  readonly name: string;
  readonly allowedTypes: readonly TypeRefNode[];
}

/** One allowed subject type within a relation's type expression. */
export interface TypeRefNode {
  /** Subject namespace, possibly path-qualified. */
  readonly typeName: string;
  /** True for the `:*` public-wildcard form. */
  readonly isWildcard: boolean;
  /** Optional `#relation` subrelation (undefined when absent). */
  readonly subrelation: string | undefined;
  /** Optional `with caveat` name (parsed; deferred semantically). */
  readonly caveatName: string | undefined;
  /** True if the `with expiration` trait is present. */
  readonly requiresExpiration: boolean;
}

/** A `permission` declaration with its compute expression. */
export interface PermissionNode {
  readonly name: string;
  readonly expression: ExprNode;
}

/** A `caveat` block: a name, typed parameters (in source order), and the raw CEL body text. */
export interface CaveatNode {
  readonly name: string;
  readonly parameters: readonly CaveatParameterNode[];
  readonly expression: string;
}

/** One `name type` parameter inside a caveat parameter list. */
export interface CaveatParameterNode {
  readonly name: string;
  readonly type: CaveatTypeRefNode;
}

/** A caveat parameter type reference, possibly with generic child types (e.g. `list<int>`). */
export interface CaveatTypeRefNode {
  readonly name: string;
  readonly childTypes: readonly CaveatTypeRefNode[];
}

/** Base type for permission compute expressions. */
export type ExprNode = ReferenceExpr | NilExpr | SelfExpr | ArrowExpr | BinaryExpr;

/** A bare relation/permission reference (computed userset). */
export interface ReferenceExpr {
  readonly kind: "reference";
  readonly name: string;
}

/** The `nil` empty-set operand. */
export interface NilExpr {
  readonly kind: "nil";
}

/** The `self` operand: the resource treated as its own subject. */
export interface SelfExpr {
  readonly kind: "self";
}

/** An arrow expression `tupleset->computed`, optionally functioned. */
export interface ArrowExpr {
  readonly kind: "arrow";
  readonly tupleset: string;
  readonly computed: string;
  readonly functionName: string | undefined;
}

/** A binary set operation between two operands. */
export interface BinaryExpr {
  readonly kind: "binary";
  readonly op: SetOp;
  readonly left: ExprNode;
  readonly right: ExprNode;
}

/** Set operators usable in compute expressions. */
export type SetOp = "union" | "intersection" | "exclusion";
