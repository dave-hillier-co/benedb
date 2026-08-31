import { allowedRelationSource } from "@benedb/core/allowed-relation-identity";
import type { AllowedRelation } from "@benedb/core/allowed-relation";
import {
  caveatTypeReferenceEquals,
  type CaveatDefinition,
  type CaveatTypeReference,
} from "@benedb/core/caveat-definition";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { isPermission, type Relation } from "@benedb/core/relation";
import {
  setOperationChildEquals,
  type SetOperation,
  type SetOperationChild,
  type UsersetRewrite,
} from "@benedb/core/userset-rewrite";
import type { CompiledSchema } from "@benedb/schema/compiled-schema";

/**
 * Ported from Spiceport `Grains/SchemaDiff.cs` - the pure, datastore-free diff engine shared by
 * `SchemaChangeValidator` (which runs orphan checks against the removal subset) and the
 * `DiffSchema` RPC (which translates the full delta list into proto). Diffs `existing -> next`, so
 * `Added`/`Removed` are relative to the existing schema as the base, matching SpiceDB's
 * orientation.
 *
 * THE DELTA ORDER IS THE CONTRACT, not a bag: `SchemaChangeValidator` derives its check list in
 * `computeSchemaDiff` order and the FIRST failing check throws, so reordering two individually
 * correct emissions changes which rejection message a user sees. There is NO sorting anywhere in
 * this file - order is source/collection order, and the by-name maps are membership indexes only;
 * every iteration is over the LIST.
 *
 * Two deliberate divergences from the C#, both recorded here because a later reader will otherwise
 * read them as bugs:
 *
 *   1. PARAMETER TYPE EQUALITY. The C# `nextType != existingType` is record equality, and
 *      `CaveatTypeReference.ChildTypes` is an `ImmutableList<CaveatTypeReference>?` whose `Equals`
 *      is REFERENCE-based - so C# reports two separately-compiled but structurally identical
 *      NESTED generic types as CHANGED. This port uses core's structural
 *      `caveatTypeReferenceEquals` (which also keeps `undefined` - a scalar - distinct from `[]`).
 *      That only ever removes a SPURIOUS rejection and never adds one.
 *   2. PARAMETER DELTA ORDER. `CaveatDefinition.ParameterTypes` is an `ImmutableDictionary` in C#,
 *      enumerated in HASH order; it is a `Map` here, enumerated in INSERTION order. For a caveat
 *      with more than one changed parameter the added/removed/type-changed deltas therefore come
 *      out in a different order from C#, and since `SchemaChangeValidator` throws on the FIRST
 *      failing check the rejection MESSAGE can differ. Reproducing .NET hash order is not
 *      attempted. Only the adds-before-the-rest GROUPING is portable, and that is preserved.
 *   3. REWRITE-CHILD OPERATION PATHS. The C# `ChildEquals` value-equality arm (`a == b`) is record
 *      equality over `SetOperationChild`, which carries an `ImmutableList<uint>? OperationPath`
 *      whose `Equals` is REFERENCE-based - the same artifact as divergence 1, one level down. core's
 *      `setOperationChildEquals` compares the path STRUCTURALLY. Like divergence 1 this can only
 *      remove a spurious `PermissionExprChanged`, never add one, and it is unreachable through
 *      `computeSchemaDiff` today: the schema compiler never populates `operationPath`, so both
 *      sides are always absent. It is reachable through the exported `rewriteEquals`.
 */

/** A whole definition was added in the comparison schema. */
export interface DefinitionAdded {
  readonly kind: "definitionAdded";
  readonly definition: NamespaceDefinition;
}

/** A whole definition was removed in the comparison schema. */
export interface DefinitionRemoved {
  readonly kind: "definitionRemoved";
  readonly definition: NamespaceDefinition;
}

/** A base relation was added to a kept definition. */
export interface RelationAdded {
  readonly kind: "relationAdded";
  readonly definitionName: string;
  readonly relation: Relation;
}

/** A base relation was removed from a kept definition (or turned into a permission). */
export interface RelationRemoved {
  readonly kind: "relationRemoved";
  readonly definitionName: string;
  readonly relation: Relation;
}

/** An allowed subject type was added to a kept relation. */
export interface RelationSubjectTypeAdded {
  readonly kind: "relationSubjectTypeAdded";
  readonly definitionName: string;
  readonly relation: Relation;
  readonly subjectType: AllowedRelation;
}

/** An allowed subject type was removed from a kept relation. */
export interface RelationSubjectTypeRemoved {
  readonly kind: "relationSubjectTypeRemoved";
  readonly definitionName: string;
  readonly relation: Relation;
  readonly subjectType: AllowedRelation;
}

/** A permission was added to a kept definition. */
export interface PermissionAdded {
  readonly kind: "permissionAdded";
  readonly definitionName: string;
  readonly permission: Relation;
}

/** A permission was removed from a kept definition (or turned into a base relation). */
export interface PermissionRemoved {
  readonly kind: "permissionRemoved";
  readonly definitionName: string;
  readonly permission: Relation;
}

/** A permission's userset-rewrite expression changed. */
export interface PermissionExprChanged {
  readonly kind: "permissionExprChanged";
  readonly definitionName: string;
  readonly permission: Relation;
}

/** A whole caveat was added. */
export interface CaveatAdded {
  readonly kind: "caveatAdded";
  readonly caveat: CaveatDefinition;
}

/** A whole caveat was removed. */
export interface CaveatRemoved {
  readonly kind: "caveatRemoved";
  readonly caveat: CaveatDefinition;
}

/** A kept caveat's expression changed. */
export interface CaveatExprChanged {
  readonly kind: "caveatExprChanged";
  readonly caveat: CaveatDefinition;
}

/** A parameter was added to a kept caveat. */
export interface CaveatParameterAdded {
  readonly kind: "caveatParameterAdded";
  readonly caveatName: string;
  readonly parameterName: string;
  readonly type: CaveatTypeReference;
}

/** A parameter was removed from a kept caveat. */
export interface CaveatParameterRemoved {
  readonly kind: "caveatParameterRemoved";
  readonly caveatName: string;
  readonly parameterName: string;
  readonly type: CaveatTypeReference;
}

/** A kept caveat parameter's type changed. */
export interface CaveatParameterTypeChanged {
  readonly kind: "caveatParameterTypeChanged";
  readonly caveatName: string;
  readonly parameterName: string;
  readonly type: CaveatTypeReference;
  readonly previousType: CaveatTypeReference;
}

/**
 * A single structural difference between two compiled schemas. A closed discriminated union
 * mirroring the cases of the `authzed.api.v1.ReflectionSchemaDiff` proto `oneof`.
 *
 * Doc-comment-change variants are intentionally absent: the compiled Core model carries no comment
 * metadata (the lexer/AST drops comments), so they can never be detected.
 */
export type SchemaDelta =
  | DefinitionAdded
  | DefinitionRemoved
  | RelationAdded
  | RelationRemoved
  | RelationSubjectTypeAdded
  | RelationSubjectTypeRemoved
  | PermissionAdded
  | PermissionRemoved
  | PermissionExprChanged
  | CaveatAdded
  | CaveatRemoved
  | CaveatExprChanged
  | CaveatParameterAdded
  | CaveatParameterRemoved
  | CaveatParameterTypeChanged;

/**
 * `ToDictionary(x => x.Name)`, which THROWS on a duplicate key where `new Map` would silently keep
 * the last entry. A membership index only: every emission loop iterates the LIST.
 */
function byName<T extends { readonly name: string }>(items: readonly T[]): ReadonlyMap<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.name)) {
      throw new InvalidArgumentError(
        `An item with the same key has already been added. Key: ${item.name}`,
      );
    }
    map.set(item.name, item);
  }
  return map;
}

/** Computes the structural deltas turning `existing` into `next`. */
export function computeSchemaDiff(
  existing: CompiledSchema,
  next: CompiledSchema,
): readonly SchemaDelta[] {
  // The two `ArgumentNullException.ThrowIfNull` guards.
  if (existing === undefined || existing === null) {
    throw new InvalidArgumentError("existing is required");
  }
  if (next === undefined || next === null) {
    throw new InvalidArgumentError("next is required");
  }

  const deltas: SchemaDelta[] = [];

  diffDefinitions(existing, next, deltas);
  diffCaveats(existing, next, deltas);

  return deltas;
}

function diffDefinitions(
  existing: CompiledSchema,
  next: CompiledSchema,
  deltas: SchemaDelta[],
): void {
  const existingByName = byName(existing.namespaces);
  const nextByName = byName(next.namespaces);

  for (const nextDef of next.namespaces) {
    if (!existingByName.has(nextDef.name)) {
      deltas.push({ kind: "definitionAdded", definition: nextDef });
    }
  }

  for (const existingDef of existing.namespaces) {
    const nextDef = nextByName.get(existingDef.name);
    if (nextDef === undefined) {
      deltas.push({ kind: "definitionRemoved", definition: existingDef });
      continue;
    }

    diffRelations(existingDef, nextDef, deltas);
  }
}

function diffRelations(
  existingDef: NamespaceDefinition,
  nextDef: NamespaceDefinition,
  deltas: SchemaDelta[],
): void {
  const existingRels = byName(existingDef.relations);
  const nextRels = byName(nextDef.relations);

  // Added (present only in next).
  for (const nextRel of nextDef.relations) {
    if (existingRels.has(nextRel.name)) continue;
    deltas.push(
      isPermission(nextRel)
        ? { kind: "permissionAdded", definitionName: nextDef.name, permission: nextRel }
        : { kind: "relationAdded", definitionName: nextDef.name, relation: nextRel },
    );
  }

  for (const existingRel of existingDef.relations) {
    const nextRel = nextRels.get(existingRel.name);
    if (nextRel === undefined) {
      deltas.push(
        isPermission(existingRel)
          ? { kind: "permissionRemoved", definitionName: existingDef.name, permission: existingRel }
          : { kind: "relationRemoved", definitionName: existingDef.name, relation: existingRel },
      );
      continue;
    }

    // Relation <-> permission flip: removal of the old kind + addition of the new kind, in that
    // order. The definition-name argument alternates between existingDef.name and nextDef.name
    // (identical values, but copied faithfully from the C#).
    if (isPermission(existingRel) !== isPermission(nextRel)) {
      if (isPermission(existingRel)) {
        deltas.push({
          kind: "permissionRemoved",
          definitionName: existingDef.name,
          permission: existingRel,
        });
        deltas.push({ kind: "relationAdded", definitionName: nextDef.name, relation: nextRel });
      } else {
        deltas.push({
          kind: "relationRemoved",
          definitionName: existingDef.name,
          relation: existingRel,
        });
        deltas.push({ kind: "permissionAdded", definitionName: nextDef.name, permission: nextRel });
      }
      continue;
    }

    if (isPermission(existingRel)) {
      // Both permissions: compare the rewrite trees structurally. (Record equality is not enough
      // here: the trees hold ImmutableList children, whose Equals is reference, not value, based.)
      if (!rewriteEquals(existingRel.usersetRewrite, nextRel.usersetRewrite)) {
        deltas.push({
          kind: "permissionExprChanged",
          definitionName: nextDef.name,
          permission: nextRel,
        });
      }
    } else {
      diffAllowedTypes(existingDef.name, existingRel, nextRel, deltas);
    }
  }
}

function diffAllowedTypes(
  defName: string,
  existingRel: Relation,
  nextRel: Relation,
  deltas: SchemaDelta[],
): void {
  // An ABSENT TypeInformation is an EMPTY list on both sides, not a skip.
  const existingAllowed = existingRel.typeInformation?.allowedDirectRelations ?? [];
  const nextAllowed = nextRel.typeInformation?.allowedDirectRelations ?? [];

  for (const added of nextAllowed) {
    if (!existingAllowed.some((e) => sameAllowedType(e, added))) {
      deltas.push({
        kind: "relationSubjectTypeAdded",
        definitionName: defName,
        relation: nextRel,
        subjectType: added,
      });
    }
  }

  for (const removed of existingAllowed) {
    if (!nextAllowed.some((n) => sameAllowedType(n, removed))) {
      deltas.push({
        kind: "relationSubjectTypeRemoved",
        definitionName: defName,
        relation: existingRel,
        subjectType: removed,
      });
    }
  }
}

function diffCaveats(existing: CompiledSchema, next: CompiledSchema, deltas: SchemaDelta[]): void {
  const existingByName = byName(existing.caveats);
  const nextByName = byName(next.caveats);

  for (const nextCaveat of next.caveats) {
    if (!existingByName.has(nextCaveat.name)) {
      deltas.push({ kind: "caveatAdded", caveat: nextCaveat });
    }
  }

  for (const existingCaveat of existing.caveats) {
    const nextCaveat = nextByName.get(existingCaveat.name);
    if (nextCaveat === undefined) {
      deltas.push({ kind: "caveatRemoved", caveat: existingCaveat });
      continue;
    }

    // `SerializedExpression.AsSpan().SequenceEqual(...)` - BYTE CONTENT equality, not reference.
    if (!bytesEqual(existingCaveat.serializedExpression, nextCaveat.serializedExpression)) {
      deltas.push({ kind: "caveatExprChanged", caveat: nextCaveat });
    }

    diffCaveatParameters(existingCaveat, nextCaveat, deltas);
  }
}

function diffCaveatParameters(
  existing: CaveatDefinition,
  next: CaveatDefinition,
  deltas: SchemaDelta[],
): void {
  for (const [name, type] of next.parameterTypes) {
    if (!existing.parameterTypes.has(name)) {
      deltas.push({
        kind: "caveatParameterAdded",
        caveatName: next.name,
        parameterName: name,
        type,
      });
    }
  }

  for (const [name, existingType] of existing.parameterTypes) {
    const nextType = next.parameterTypes.get(name);
    if (nextType === undefined) {
      deltas.push({
        kind: "caveatParameterRemoved",
        caveatName: existing.name,
        parameterName: name,
        type: existingType,
      });
      continue;
    }

    // DIVERGENCE 1 (see the module remark): the C#'s `nextType != existingType` is record
    // equality, which is REFERENCE equality over the nested `ChildTypes` list.
    if (!caveatTypeReferenceEquals(nextType, existingType)) {
      deltas.push({
        kind: "caveatParameterTypeChanged",
        caveatName: next.name,
        parameterName: name,
        type: nextType,
        previousType: existingType,
      });
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Structural equality of two userset rewrites. Needed because the C# rewrite tree holds
 * `ImmutableList` children whose `Equals` is reference-based, so default record equality reports
 * separately-compiled-but-identical trees as different.
 *
 * `if (a is null || b is null) return ReferenceEquals(a, b);` - true ONLY when BOTH are absent.
 * core's `usersetRewriteEquals` takes non-optional arguments, so the absent case is handled here.
 */
export function rewriteEquals(
  a: UsersetRewrite | undefined,
  b: UsersetRewrite | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return operationEquals(a.operation, b.operation);
}

/**
 * The C# `OperationEquals` compares the operation TYPE and the CHILDREN only - never the
 * `OperationPath` - so this is spelled out here rather than delegated to core's
 * `setOperationEquals`, which also compares the path.
 */
function operationEquals(a: SetOperation, b: SetOperation): boolean {
  if (a.type !== b.type || a.children.length !== b.children.length) return false;
  for (let i = 0; i < a.children.length; i++) {
    const left = a.children[i];
    const right = b.children[i];
    if (left === undefined || right === undefined) return false;
    if (!childEquals(left, right)) return false;
  }
  return true;
}

function childEquals(a: SetOperationChild, b: SetOperationChild): boolean {
  if (a.kind === "nestedRewrite" && b.kind === "nestedRewrite") {
    return operationEquals(a.value.operation, b.value.operation);
  }
  // `(NestedRewrite, _) or (_, NestedRewrite) => false`, checked BEFORE the value-equality arm.
  if (a.kind === "nestedRewrite" || b.kind === "nestedRewrite") return false;
  // All other child kinds hold only scalars/records without collection fields, so C# value
  // equality holds; core's structural compare is its counterpart - modulo the OperationPath
  // treatment recorded as divergence 3 in the module remark.
  return setOperationChildEquals(a, b);
}

/**
 * Identity equality of two allowed subject types via their canonical source string, which folds
 * the object type, kind, subrelation (ellipsis-normalized), required caveat name, AND the
 * expiration trait - matching SpiceDB's `SourceForAllowedRelation`. Changing a relation's `with`
 * caveat or adding/removing `with expiration` is therefore a genuine subject-type change (and
 * triggers the orphan check), not a no-op.
 */
export function sameAllowedType(a: AllowedRelation, b: AllowedRelation): boolean {
  return allowedRelationSource(a) === allowedRelationSource(b);
}
