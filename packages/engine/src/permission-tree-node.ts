import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { SetOperationType } from "@benedb/core/userset-rewrite";

import type { CaveatExpression } from "./caveat-expression";

/**
 * The expanded permission tree value types.
 *
 * Ported from Spiceport `src/Spiceport.Server/Engine/Expand/PermissionTreeNode.cs`, which declares
 * the whole cluster (the mode enum, `DirectSubject`, and the abstract node with its two nested
 * sealed records) in one file. The cluster stays in one module here because every type in it is a
 * node of the same tree.
 *
 * Port decisions:
 *   * `PermissionTreeNode` is an ABSTRACT record whose two nested sealed records re-declare the
 *     base members. It becomes a discriminated union on a literal `kind` field, with the shared
 *     `expanded` / `caveat` members on both arms and a local `assertNever` at every match site;
 *     there is no shared base class to switch on.
 *   * `kind` is a DATA field, never a getter or a derived value. `ExpandEngine.DecorateWithCaveat`
 *     does `node with { Caveat = ... }` on the ABSTRACT type, which C# dispatches to the concrete
 *     record's clone; the TypeScript equivalent `{ ...node, caveat }` only preserves the variant
 *     because `kind` rides along as plain data.
 *   * `ExpandMode` mirrors `DispatchExpandRequest_SHALLOW` / `_RECURSIVE` but carries NO explicit
 *     values in the C# and is mapped at the API layer (S5), so it is a string union with no wire
 *     map (the guide's "enum that is not wire-visible" row).
 *   * `DirectSubject(Subject, Caveat = null)` has an optional second parameter; the factory leaves
 *     `caveat` genuinely absent rather than defaulting it.
 *   * Public wildcards are represented by the subject ONR's object id being `"*"`; `isPublicWildcard`
 *     from @benedb/core owns that test and nothing here re-implements it.
 */

/**
 * The mode used when expanding a permission tree.
 *
 * Mirrors SpiceDB's `DispatchExpandRequest_SHALLOW` / `RECURSIVE`.
 *
 * `shallow` expands one level only: a base relation's directly-written subjects are returned
 * verbatim, including non-terminal usersets (subrelations), without recursing into them.
 * `recursive` expands fully: non-terminal usersets reached from a base relation are themselves
 * expanded, producing a nested tree.
 */
export type ExpandMode = "shallow" | "recursive";

/**
 * A single direct subject of a base relation, carried verbatim from a written tuple, with its
 * optional per-tuple caveat. Public wildcards are represented as a subject whose
 * `isPublicWildcard` is true (object id `"*"`).
 *
 * Port of SpiceDB's `core.DirectSubject`.
 */
export interface DirectSubject {
  /** The subject ONR (may be a wildcard or a non-terminal userset). */
  readonly subject: ObjectAndRelation;
  /** The per-tuple caveat, or absent if unconditional. */
  readonly caveat?: CaveatExpression | undefined;
}

/** Creates a {@link DirectSubject}; an omitted caveat stays absent, as the C# default `null` does. */
export function createDirectSubject(
  subject: ObjectAndRelation,
  caveat?: CaveatExpression | undefined,
): DirectSubject {
  return { subject, caveat };
}

/** Members shared by every {@link PermissionTreeNode} arm (the C# abstract record's own members). */
interface PermissionTreeNodeBase {
  /** The resource ONR this node expands. */
  readonly expanded: ObjectAndRelation;
  /** An optional caveat applying to the whole node. */
  readonly caveat?: CaveatExpression | undefined;
}

/** The directly-written subjects of a base relation (incl. wildcards and usersets). */
export interface PermissionTreeLeaf extends PermissionTreeNodeBase {
  readonly kind: "leaf";
  /** The direct subjects, each with its per-tuple caveat. */
  readonly subjects: readonly DirectSubject[];
}

/** An intermediate set operation (union / intersection / exclusion) over children. */
export interface PermissionTreeSetOp extends PermissionTreeNodeBase {
  readonly kind: "setOp";
  /** The combination operator. */
  readonly operation: SetOperationType;
  /** The child nodes (operands). */
  readonly children: readonly PermissionTreeNode[];
}

/**
 * A node in an expanded permission tree. The tree mirrors the userset-rewrite structure of the
 * expanded relation; every node records the resource ONR it `expanded`.
 *
 * Port of SpiceDB's `core.RelationTupleTreeNode`. The tree is the structural expansion and is not
 * collapsed against a request context: a caller may evaluate the per-node and per-subject caveat
 * expressions with a `CaveatEvaluator`.
 */
export type PermissionTreeNode = PermissionTreeLeaf | PermissionTreeSetOp;

/** Creates a leaf node carrying a base relation's directly-written subjects. */
export function permissionTreeLeaf(
  expanded: ObjectAndRelation,
  subjects: readonly DirectSubject[],
  caveat?: CaveatExpression | undefined,
): PermissionTreeLeaf {
  return { kind: "leaf", expanded, subjects, caveat };
}

/** Creates a set-operation node over the given children, in order. */
export function permissionTreeSetOp(
  expanded: ObjectAndRelation,
  operation: SetOperationType,
  children: readonly PermissionTreeNode[],
  caveat?: CaveatExpression | undefined,
): PermissionTreeSetOp {
  return { kind: "setOp", expanded, operation, children, caveat };
}
