import type { AllowedRelation } from "@benedb/core/allowed-relation";
import { isAllowedRelationPublicWildcard } from "@benedb/core/allowed-relation";
import type { CaveatDefinition, CaveatTypeReference } from "@benedb/core/caveat-definition";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import type { Relation } from "@benedb/core/relation";
import { isPermission } from "@benedb/core/relation";
import type {
  ReflectionCaveat,
  ReflectionCaveatParameter,
  ReflectionDefinition,
  ReflectionPermission,
  ReflectionRelation,
  ReflectionTypeReference,
} from "@benedb/protos/authzed/api/v1/schema_service";

/**
 * Translates the compiled Core schema model into the `authzed.api.v1` reflection proto messages.
 * Shared by `ReflectSchema` (whole-schema dump) and `DiffSchema` (per-delta builders). Port of
 * Spiceport's `ReflectionMapper.cs`, itself a port of SpiceDB's `reflectionapi.go`
 * (`namespaceAPIRepr`/`relationAPIRepr`/`permissionAPIRepr`/`typeAPIRepr`/`caveatAPIRepr`).
 *
 * Honest gaps faithful to the compiled model: `comment` is always the empty string because the
 * Core model carries no doc-comment metadata (the lexer/AST drops comments). Caveat `expression`
 * is recovered from `CaveatDefinition.serializedExpression`, which stores the verbatim CEL body
 * text as UTF-8.
 *
 * Port decisions:
 *   * The C# static class becomes free functions, one per member, prefixed `reflection*` so the
 *     names do not collide with the proto message types they build. `TypeString` becomes
 *     `caveatTypeString` for the same reason.
 *   * `OrderBy(p => p.Key, StringComparer.Ordinal)` becomes an explicit ordinal comparison of the
 *     parameter names. NEVER `localeCompare`, which reorders case and accents and would silently
 *     change the emitted proto. The keys of a map are distinct, so the sort's stability is moot.
 */

/** Builds the `ReflectionDefinition` for a namespace, splitting relations vs permissions. */
export function reflectionDefinition(def: NamespaceDefinition): ReflectionDefinition {
  const result: ReflectionDefinition = {
    name: def.name,
    comment: "",
    relations: [],
    permissions: [],
  };
  for (const rel of def.relations) {
    if (isPermission(rel)) result.permissions.push(reflectionPermission(def.name, rel));
    else result.relations.push(reflectionRelation(def.name, rel));
  }
  return result;
}

/** Builds the `ReflectionRelation` for a base relation (with its subject types). */
export function reflectionRelation(
  parentDefinitionName: string,
  relation: Relation,
): ReflectionRelation {
  const result: ReflectionRelation = {
    name: relation.name,
    comment: "",
    parentDefinitionName,
    subjectTypes: [],
  };

  const allowed = relation.typeInformation?.allowedDirectRelations;
  if (allowed !== undefined) {
    for (const a of allowed) result.subjectTypes.push(reflectionTypeReference(a));
  }
  return result;
}

/** Builds the `ReflectionTypeReference` for one allowed subject type. */
export function reflectionTypeReference(allowed: AllowedRelation): ReflectionTypeReference {
  const result: ReflectionTypeReference = {
    subjectDefinitionName: allowed.objectType,
    optionalCaveatName: "",
  };

  const caveat = allowed.requiredCaveat;
  if (caveat !== undefined) result.optionalCaveatName = caveat.caveatName;

  // Ordered and exclusive: wildcard wins; else a non-ellipsis relation name; else terminal. The
  // C# test is `allowed.RelationName is { } rel`, a NULL test - an empty-string relation name is
  // relation-scoped, not terminal - so this is `!== undefined`, not a truthiness test.
  if (isAllowedRelationPublicWildcard(allowed)) result.isPublicWildcard = true;
  else if (allowed.relationName !== undefined && allowed.relationName !== ELLIPSIS)
    result.optionalRelationName = allowed.relationName;
  else result.isTerminalSubject = true;

  return result;
}

/** Builds the `ReflectionPermission` for a permission. */
export function reflectionPermission(
  parentDefinitionName: string,
  permission: Relation,
): ReflectionPermission {
  return { name: permission.name, comment: "", parentDefinitionName };
}

/** Builds the `ReflectionCaveat` for a caveat (parameters sorted by name). */
export function reflectionCaveat(caveat: CaveatDefinition): ReflectionCaveat {
  const result: ReflectionCaveat = {
    name: caveat.name,
    comment: "",
    parameters: [],
    // serializedExpression holds the verbatim CEL body text (UTF-8), captured at compile time.
    expression: new TextDecoder().decode(caveat.serializedExpression),
  };

  const ordered = [...caveat.parameterTypes.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const [name, type] of ordered) {
    result.parameters.push(reflectionCaveatParameter(caveat.name, name, type));
  }

  return result;
}

/** Builds the `ReflectionCaveatParameter` for one parameter. */
export function reflectionCaveatParameter(
  parentCaveatName: string,
  name: string,
  type: CaveatTypeReference,
): ReflectionCaveatParameter {
  return { name, type: caveatTypeString(type), parentCaveatName };
}

/** Renders a caveat parameter type as a string, e.g. `int`, `list<string>`. */
export function caveatTypeString(type: CaveatTypeReference): string {
  const children = type.childTypes;
  // `ChildTypes is not { Count: > 0 }` - absent and empty are the same bare type name.
  if (children === undefined || children.length === 0) return type.typeName;
  const args = children.map(caveatTypeString).join(", ");
  return `${type.typeName}<${args}>`;
}
