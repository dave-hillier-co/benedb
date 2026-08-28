/**
 * The compiled userset-rewrite tree: the computation behind a permission.
 *
 * Ported from Spiceport `UsersetRewrite.cs`, which declares the whole cluster in one file. The
 * cluster stays in one module here because every type in it is a node of the same tree.
 *
 * Port decisions:
 *   * The three C# enums carry EXPLICIT proto values. Each becomes a string-literal union (house
 *     style) plus an explicit bidirectional wire map, so nothing depends on declaration order.
 *     `SetOperationType` starts at 1 and has no zero value; that gap is preserved.
 *   * `SetOperationChild` is a sealed hierarchy with a private constructor, so it becomes a
 *     discriminated union with a literal `kind` and a local `assertNever` at the match site. The
 *     ABSTRACT BASE declares `OperationPath`, so EVERY variant carries it - including the three
 *     operand-free ones. `SetOperation` carries its own `OperationPath` separately.
 *   * C# record equality over `ImmutableList` members is reference equality, which is not usable
 *     for the comparison and caching these trees undergo, so the port supplies explicit deep
 *     equality instead.
 */

/** Where a {@link ComputedUserset} is computed. */
export type ComputedUsersetObject = "tupleObject" | "tupleUsersetObject";

const COMPUTED_USERSET_OBJECT_TO_WIRE: Readonly<Record<ComputedUsersetObject, number>> = {
  tupleObject: 0,
  tupleUsersetObject: 1,
};

const COMPUTED_USERSET_OBJECT_FROM_WIRE: ReadonlyMap<number, ComputedUsersetObject> = new Map<
  number,
  ComputedUsersetObject
>([
  [0, "tupleObject"],
  [1, "tupleUsersetObject"],
]);

/** The proto enum value for a computed-userset object. */
export function computedUsersetObjectToWire(value: ComputedUsersetObject): number {
  return COMPUTED_USERSET_OBJECT_TO_WIRE[value];
}

/** The computed-userset object for a proto enum value, or `undefined` for an unknown value. */
export function computedUsersetObjectFromWire(wire: number): ComputedUsersetObject | undefined {
  return COMPUTED_USERSET_OBJECT_FROM_WIRE.get(wire);
}

/**
 * References another relation/permission, computed either on the resource itself or on the
 * subject reached via a tupleset traversal.
 */
export interface ComputedUserset {
  /** Which object the relation is computed on. */
  readonly object: ComputedUsersetObject;
  /** The relation/permission name to compute. */
  readonly relation: string;
}

/** Computes the relation on the resource itself (the common case). */
export function computedUsersetOnResource(relation: string): ComputedUserset {
  return { object: "tupleObject", relation };
}

/**
 * Traverses a tupleset relation and computes a relation on each reached subject.
 * E.g. `parent->view`: walk "parent", then compute "view" on each parent.
 */
export interface TupleToUserset {
  /** The relation on the resource to traverse. */
  readonly tuplesetRelation: string;
  /** The relation to compute on each traversed subject. */
  readonly computedUserset: ComputedUserset;
}

/** Aggregation function for a {@link FunctionedTupleToUserset}. */
export type TupleToUsersetFunction = "unspecified" | "any" | "all";

const TUPLE_TO_USERSET_FUNCTION_TO_WIRE: Readonly<Record<TupleToUsersetFunction, number>> = {
  unspecified: 0,
  any: 1,
  all: 2,
};

const TUPLE_TO_USERSET_FUNCTION_FROM_WIRE: ReadonlyMap<number, TupleToUsersetFunction> = new Map<
  number,
  TupleToUsersetFunction
>([
  [0, "unspecified"],
  [1, "any"],
  [2, "all"],
]);

/** The proto enum value for a tuple-to-userset function. */
export function tupleToUsersetFunctionToWire(value: TupleToUsersetFunction): number {
  return TUPLE_TO_USERSET_FUNCTION_TO_WIRE[value];
}

/** The tuple-to-userset function for a proto enum value, or `undefined` for an unknown value. */
export function tupleToUsersetFunctionFromWire(wire: number): TupleToUsersetFunction | undefined {
  return TUPLE_TO_USERSET_FUNCTION_FROM_WIRE.get(wire);
}

/** A {@link TupleToUserset} with an explicit aggregation function (`.any()` / `.all()`). */
export interface FunctionedTupleToUserset {
  /** How results across traversed subjects are aggregated. */
  readonly function: TupleToUsersetFunction;
  /** The relation on the resource to traverse. */
  readonly tuplesetRelation: string;
  /** The relation to compute on each traversed subject. */
  readonly computedUserset: ComputedUserset;
}

/**
 * Common members of every {@link SetOperationChild} variant.
 *
 * `operationPath` is declared on the C# ABSTRACT BASE, so it belongs to all seven variants, not
 * only the operand-bearing ones. An absent path is NOT the empty path.
 */
interface SetOperationChildBase {
  /** Optional hierarchical position path within the rewrite tree. */
  readonly operationPath?: readonly number[] | undefined;
}

/** Deprecated: the legacy "_this" set (all directly written subjects). */
export interface ThisChild extends SetOperationChildBase {
  readonly kind: "this";
}

/** The empty set. */
export interface NilChild extends SetOperationChildBase {
  readonly kind: "nil";
}

/** The resource itself treated as a subject (the "self" operand). */
export interface SelfChild extends SetOperationChildBase {
  readonly kind: "self";
}

/** A computed userset operand. */
export interface ComputedUsersetChild extends SetOperationChildBase {
  readonly kind: "computedUserset";
  readonly value: ComputedUserset;
}

/** A tuple-to-userset traversal operand. */
export interface TupleToUsersetChild extends SetOperationChildBase {
  readonly kind: "tupleToUserset";
  readonly value: TupleToUserset;
}

/** A functioned tuple-to-userset traversal operand. */
export interface FunctionedTupleToUsersetChild extends SetOperationChildBase {
  readonly kind: "functionedTupleToUserset";
  readonly value: FunctionedTupleToUserset;
}

/** A nested rewrite operand. */
export interface NestedRewriteChild extends SetOperationChildBase {
  readonly kind: "nestedRewrite";
  readonly value: UsersetRewrite;
}

/**
 * A single operand within a {@link SetOperation}. A closed union of the seven possible child
 * kinds.
 */
export type SetOperationChild =
  | ThisChild
  | NilChild
  | SelfChild
  | ComputedUsersetChild
  | TupleToUsersetChild
  | FunctionedTupleToUsersetChild
  | NestedRewriteChild;

/** How the children of a {@link SetOperation} are combined. */
export type SetOperationType = "union" | "intersection" | "exclusion";

// The proto numbering starts at 1: there is no zero value. Renumbering is a wire break.
const SET_OPERATION_TYPE_TO_WIRE: Readonly<Record<SetOperationType, number>> = {
  union: 1,
  intersection: 2,
  exclusion: 3,
};

const SET_OPERATION_TYPE_FROM_WIRE: ReadonlyMap<number, SetOperationType> = new Map<
  number,
  SetOperationType
>([
  [1, "union"],
  [2, "intersection"],
  [3, "exclusion"],
]);

/** The proto enum value for a set operation type. */
export function setOperationTypeToWire(value: SetOperationType): number {
  return SET_OPERATION_TYPE_TO_WIRE[value];
}

/** The set operation type for a proto enum value, or `undefined` for an unknown value. */
export function setOperationTypeFromWire(wire: number): SetOperationType | undefined {
  return SET_OPERATION_TYPE_FROM_WIRE.get(wire);
}

/** A union / intersection / exclusion over one or more child operands. */
export interface SetOperation {
  /** The combination operator. */
  readonly type: SetOperationType;
  /** The operands (at least one - not enforced, exactly as the C# `params` factories do not). */
  readonly children: readonly SetOperationChild[];
  /** Optional hierarchical position path within the rewrite tree. */
  readonly operationPath?: readonly number[] | undefined;
}

/** Creates a union over the given children. */
export function setOperationUnion(...children: SetOperationChild[]): SetOperation {
  return { type: "union", children };
}

/** Creates an intersection over the given children. */
export function setOperationIntersection(...children: SetOperationChild[]): SetOperation {
  return { type: "intersection", children };
}

/** Creates an exclusion over the given children. */
export function setOperationExclusion(...children: SetOperationChild[]): SetOperation {
  return { type: "exclusion", children };
}

/** The top-level computation for a permission. Always a single {@link SetOperation}. */
export interface UsersetRewrite {
  /** The root set operation. */
  readonly operation: SetOperation;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled set operation child: ${JSON.stringify(value)}`);
}

function operationPathEquals(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): boolean {
  // An absent path is not the root path: `undefined` and `[]` stay distinct, as C# `null` and an
  // empty `ImmutableList<uint>` do.
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function computedUsersetEquals(a: ComputedUserset, b: ComputedUserset): boolean {
  return a.object === b.object && a.relation === b.relation;
}

function tupleToUsersetEquals(a: TupleToUserset, b: TupleToUserset): boolean {
  return (
    a.tuplesetRelation === b.tuplesetRelation &&
    computedUsersetEquals(a.computedUserset, b.computedUserset)
  );
}

function functionedTupleToUsersetEquals(
  a: FunctionedTupleToUserset,
  b: FunctionedTupleToUserset,
): boolean {
  return (
    a.function === b.function &&
    a.tuplesetRelation === b.tuplesetRelation &&
    computedUsersetEquals(a.computedUserset, b.computedUserset)
  );
}

/** Deep structural equality over two set operation children, operation path included. */
export function setOperationChildEquals(a: SetOperationChild, b: SetOperationChild): boolean {
  if (a.kind !== b.kind) return false;
  if (!operationPathEquals(a.operationPath, b.operationPath)) return false;

  switch (a.kind) {
    case "this":
    case "nil":
    case "self":
      return true;
    case "computedUserset":
      return computedUsersetEquals(a.value, (b as ComputedUsersetChild).value);
    case "tupleToUserset":
      return tupleToUsersetEquals(a.value, (b as TupleToUsersetChild).value);
    case "functionedTupleToUserset":
      return functionedTupleToUsersetEquals(a.value, (b as FunctionedTupleToUsersetChild).value);
    case "nestedRewrite":
      return usersetRewriteEquals(a.value, (b as NestedRewriteChild).value);
    default:
      return assertNever(a);
  }
}

/** Deep structural equality over two set operations: type, own path, and children in order. */
export function setOperationEquals(a: SetOperation, b: SetOperation): boolean {
  if (a.type !== b.type) return false;
  if (!operationPathEquals(a.operationPath, b.operationPath)) return false;
  if (a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    const left = a.children[i];
    const right = b.children[i];
    if (left === undefined || right === undefined) return false;
    if (!setOperationChildEquals(left, right)) return false;
  }
  return true;
}

/** Deep structural equality over two rewrite trees. */
export function usersetRewriteEquals(a: UsersetRewrite, b: UsersetRewrite): boolean {
  return setOperationEquals(a.operation, b.operation);
}
