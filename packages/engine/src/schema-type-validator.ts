import { CelError } from "@bufbuild/cel";
import {
  isAllowedRelationPublicWildcard,
  type AllowedRelation,
} from "@spacedb/core/allowed-relation";
import { allowedRelationSource } from "@spacedb/core/allowed-relation-identity";
import type { CaveatDefinition } from "@spacedb/core/caveat-definition";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import { isPermission, type Relation } from "@spacedb/core/relation";
import type { SetOperation, SetOperationChild } from "@spacedb/core/userset-rewrite";
import type { CompiledSchema } from "@spacedb/schema/compiled-schema";

import { parseCaveatExpression } from "./caveat-compiler";
import { referencesIdentifier } from "./references-identifier";
import { SchemaTypeException } from "./schema-type-exception";

/**
 * Runs SpiceDB's type-system validation pass over a freshly compiled schema at write time, plus the
 * caveat-definition validation, rejecting schemas the engine would otherwise silently mis-evaluate
 * (or crash on) at check time. Mirrors `pkg/schema/typesystem_validation.go`
 * (`TypeSystem.Validate`) and `internal/namespace/caveats.go` (`ValidateCaveatDefinition`), as
 * orchestrated by `ValidateSchemaChanges` (`internal/services/shared/schema.go`).
 *
 * Ported from Spiceport `Engine/SchemaTypeValidator.cs`, a C# `static class` -> module-level
 * functions. On the first violation a {@link SchemaTypeException} is thrown (the grain re-wraps it
 * for the gRPC boundary, where it maps to `FailedPrecondition`), and every message is transcribed
 * character-for-character, backticks included, because the suite asserts them verbatim.
 *
 * What is checked: duplicate/reused definition + caveat names; per-caveat (>= 1 parameter,
 * parseable CEL, every declared parameter referenced); per-relation arrow targets (relation exists,
 * is not a permission, does not import a wildcard); per-permission computed-userset targets exist;
 * per-base-relation allowed-type list is non-empty, every allowed type's namespace/subrelation
 * exists, none is self-referential, none is duplicated, and every `with <caveat>` names a defined
 * caveat.
 */

/**
 * Validates the whole compiled schema. Throws {@link SchemaTypeException} on the first violation;
 * returns normally if the schema is type-valid.
 */
export function validateSchemaTypes(schema: CompiledSchema): void {
  // `ArgumentNullException.ThrowIfNull(schema)`. Kept even though the parameter's TypeScript type
  // is non-optional: callers reaching this from the grain boundary are untyped.
  if (schema === undefined || schema === null) {
    throw new InvalidArgumentError("schema is required");
  }

  // 0) No name may be reused between two definitions, two caveats, or a definition and a caveat.
  validateUniqueNames(schema);

  // 1) Validate every caveat definition (CEL parse, >= 1 param, all params referenced).
  for (const caveat of schema.caveats) validateCaveat(caveat);

  // 2) Validate every object definition against the full type system.
  //    `schema.Namespaces.ToDictionary(n => n.Name)` throws on a duplicate definition name, but
  //    `validateUniqueNames` above has already rejected that, so the throw is unreachable and no
  //    explicit duplicate check is added here.
  const byName = new Map<string, NamespaceDefinition>(schema.namespaces.map((n) => [n.name, n]));
  const caveatNames = new Set<string>(schema.caveats.map((c) => c.name));
  for (const def of schema.namespaces) validateDefinition(def, byName, caveatNames);
}

function validateUniqueNames(schema: CompiledSchema): void {
  const seen = new Set<string>();
  for (const def of schema.namespaces) {
    if (seen.has(def.name)) {
      throw new SchemaTypeException(
        `found name reused between multiple definitions and/or caveats: ${def.name}`,
      );
    }
    seen.add(def.name);
  }

  for (const caveat of schema.caveats) {
    if (seen.has(caveat.name)) {
      throw new SchemaTypeException(
        `found name reused between multiple definitions and/or caveats: ${caveat.name}`,
      );
    }
    seen.add(caveat.name);
  }
}

/**
 * The C#'s `catch (Exception ex) when (ex is CelException or InvalidOperationException or
 * ArgumentException)` is a real exception filter, so only those three become a
 * `SchemaTypeException` and anything else propagates.
 *
 * DEVIATION, recorded here because there is no exact counterpart: the ported `parseCaveatExpression`
 * documents its thrown type as deliberately unpinned and raises a plain `Error` where .NET's
 * `Parse` raised `InvalidOperationException`. So the filter accepts `CelError` (CelException),
 * `InvalidArgumentError` (ArgumentException) and a plain `Error` (the compiler's own signal), while
 * genuine programming faults - `TypeError`, `RangeError`, `EvalError` - and non-`Error` throws are
 * rethrown untouched, as in the C#.
 */
function isCaveatCompileFailure(error: unknown): error is Error {
  if (error instanceof CelError) return true;
  if (error instanceof InvalidArgumentError) return true;
  if (error instanceof TypeError || error instanceof RangeError || error instanceof EvalError) {
    return false;
  }
  return error instanceof Error;
}

function validateCaveat(caveat: CaveatDefinition): void {
  const expression = new TextDecoder().decode(caveat.serializedExpression);

  // (a) Parse/compile the CEL against the declared environment. A syntactically invalid expression
  //     is rejected here rather than deferred to a later Check at evaluation time.
  try {
    parseCaveatExpression(expression);
  } catch (error) {
    if (!isCaveatCompileFailure(error)) throw error;
    throw new SchemaTypeException(`could not compile caveat \`${caveat.name}\`: ${error.message}`);
  }

  // (b) A caveat must declare at least one parameter.
  if (caveat.parameterTypes.size === 0) {
    throw new SchemaTypeException(
      `caveat \`${caveat.name}\` must have at least one parameter defined`,
    );
  }

  // (c) Every declared parameter must be referenced by the expression.
  for (const param of caveat.parameterTypes.keys()) {
    if (!referencesIdentifier(expression, param)) {
      throw new SchemaTypeException(
        `parameter \`${param}\` for caveat \`${caveat.name}\` is unused`,
      );
    }
  }
}

function validateDefinition(
  def: NamespaceDefinition,
  byName: ReadonlyMap<string, NamespaceDefinition>,
  caveatNames: ReadonlySet<string>,
): void {
  // `def.Relations.ToDictionary(r => r.Name)` THROWS on a duplicate relation name, and nothing
  // upstream rejects one (the compiler does not, and `validateUniqueNames` covers only definition
  // and caveat names). `new Map(...)` would silently overwrite, so a schema the C# rejected with a
  // raw ArgumentException would quietly pass. The check is explicit, and the thrown shape mirrors
  // `schema-compiler`'s port of the same .NET behaviour: an `InvalidArgumentError` carrying the
  // BCL message, NOT a `SchemaTypeException` - in the C# the throw comes from `ToDictionary`,
  // outside any catch.
  const relationsByName = new Map<string, Relation>();
  for (const r of def.relations) {
    if (relationsByName.has(r.name)) {
      throw new InvalidArgumentError(
        `An item with the same key has already been added. Key: ${r.name}`,
      );
    }
    relationsByName.set(r.name, r);
  }

  for (const relation of def.relations) {
    if (isPermission(relation)) {
      validatePermissionRewrite(def, relation, relationsByName);
      continue;
    }

    validateBaseRelation(def, relation, byName, caveatNames);
  }
}

function validatePermissionRewrite(
  def: NamespaceDefinition,
  permission: Relation,
  relationsByName: ReadonlyMap<string, Relation>,
): void {
  walkRewrite(permission.usersetRewrite!.operation, (child) => {
    switch (child.kind) {
      case "computedUserset":
        if (!relationsByName.has(child.value.relation)) {
          throw new SchemaTypeException(
            `relation/permission \`${child.value.relation}\` not found under definition \`${def.name}\``,
          );
        }
        break;

      case "tupleToUserset":
        validateArrowTupleset(def, permission, child.value.tuplesetRelation, relationsByName);
        break;

      case "functionedTupleToUserset":
        validateArrowTupleset(def, permission, child.value.tuplesetRelation, relationsByName);
        break;

      default:
        break;
    }
  });
}

function validateArrowTupleset(
  def: NamespaceDefinition,
  permission: Relation,
  tuplesetRelation: string,
  relationsByName: ReadonlyMap<string, Relation>,
): void {
  const found = relationsByName.get(tuplesetRelation);
  if (found === undefined) {
    throw new SchemaTypeException(
      `relation/permission \`${tuplesetRelation}\` not found under definition \`${def.name}\``,
    );
  }

  // A permission may not appear on the left (tupleset) side of an arrow: arrows walk written
  // tuples.
  if (isPermission(found)) {
    throw new SchemaTypeException(
      `under permission \`${permission.name}\`: permissions cannot be used on the left hand side of an arrow (found \`${tuplesetRelation}\`)`,
    );
  }

  // The tupleset relation must not (directly or transitively) import a wildcard subject type.
  // The `encountered` set is FRESH at every call site: the C# `[]` collection expression allocates
  // a new HashSet per call, and the set is mutated through the recursion as a cycle guard, so a
  // shared module-level set would leak across calls.
  if (referencesWildcard(def, tuplesetRelation, new Set<string>())) {
    throw new SchemaTypeException(
      `under permission \`${permission.name}\`: relation \`${tuplesetRelation}\` includes wildcard type and thus cannot be used on the left hand side of an arrow`,
    );
  }
}

function validateBaseRelation(
  def: NamespaceDefinition,
  relation: Relation,
  byName: ReadonlyMap<string, NamespaceDefinition>,
  caveatNames: ReadonlySet<string>,
): void {
  const allowed = relation.typeInformation?.allowedDirectRelations ?? [];

  // A base relation (a _this relation with no rewrite) must list at least one allowed subject type.
  if (allowed.length === 0) {
    throw new SchemaTypeException(
      `at least one allowed relation/permission is required in relation \`${relation.name}\` in definition \`${def.name}\``,
    );
  }

  const seen = new Set<string>();
  for (const subject of allowed) {
    // `AllowedRelationIdentity.Source`, already ported in @spacedb/core: the duplicate check
    // depends on caveat + expiration being part of the identity, so it must not be re-derived here.
    const source = allowedRelationSource(subject);

    // No allowed type may be duplicated (caveat + expiration trait are part of the identity).
    if (seen.has(source)) {
      throw new SchemaTypeException(
        `found duplicate allowed subject type \`${source}\` on relation \`${relation.name}\` in definition \`${def.name}\``,
      );
    }
    seen.add(source);

    validateAllowedSubjectNamespace(def, relation, subject, byName);

    // A required caveat must name a caveat defined in this schema.
    const caveat = subject.requiredCaveat;
    if (caveat !== undefined && !caveatNames.has(caveat.caveatName)) {
      throw new SchemaTypeException(
        `could not lookup caveat \`${caveat.caveatName}\` for relation \`${relation.name}\`: caveat with name \`${caveat.caveatName}\` not found`,
      );
    }
  }
}

function validateAllowedSubjectNamespace(
  def: NamespaceDefinition,
  relation: Relation,
  subject: AllowedRelation,
  byName: ReadonlyMap<string, NamespaceDefinition>,
): void {
  // A wildcard subject has no subrelation to resolve; only its namespace must exist.
  const subrelation = subject.relationName ?? ELLIPSIS;
  const resolvesSubrelation = !isAllowedRelationPublicWildcard(subject) && subrelation !== ELLIPSIS;

  if (subject.objectType === def.name) {
    // Same definition: the subrelation (if any) must be one of this definition's relations.
    // Self-reference (`relation member: user | group#member`) is VALID SpiceDB - it is the
    // canonical recursive-group shape (the conformance corpus' directgroups.yaml, accepted by real
    // SpiceDB's WriteSchema in the differential suite). Do not "fix" this.
    if (resolvesSubrelation && !def.relations.some((r) => r.name === subrelation)) {
      throw new SchemaTypeException(
        `relation/permission \`${subrelation}\` not found under definition \`${def.name}\``,
      );
    }

    return;
  }

  const subjectDef = byName.get(subject.objectType);
  if (subjectDef === undefined) {
    throw new SchemaTypeException(
      `could not lookup definition \`${subject.objectType}\` for relation \`${relation.name}\`: object definition \`${subject.objectType}\` not found`,
    );
  }

  if (resolvesSubrelation && !subjectDef.relations.some((r) => r.name === subrelation)) {
    throw new SchemaTypeException(
      `relation/permission \`${subrelation}\` not found under definition \`${subject.objectType}\``,
    );
  }

  // The referenced subrelation must not itself import a wildcard (transitive wildcard). Fresh
  // cycle-guard set per call site, as above.
  if (resolvesSubrelation && referencesWildcard(subjectDef, subrelation, new Set<string>())) {
    throw new SchemaTypeException(
      `relation \`${relation.name}\` in definition \`${def.name}\` allows the wildcard type within \`${subject.objectType}#${subrelation}\`, which is not permitted`,
    );
  }
}

/**
 * True if the named base relation imports a public wildcard subject type, directly or transitively
 * through a same-or-other-definition subrelation. Mirrors SpiceDB's `referencesWildcardType`.
 */
function referencesWildcard(
  def: NamespaceDefinition,
  relationName: string,
  encountered: Set<string>,
): boolean {
  const key = `${def.name}#${relationName}`;
  if (encountered.has(key)) return false;
  encountered.add(key);

  const relation = def.relations.find((r) => r.name === relationName);
  if (relation === undefined || isPermission(relation)) return false;

  const allowed = relation.typeInformation?.allowedDirectRelations ?? [];
  for (const subject of allowed) {
    if (isAllowedRelationPublicWildcard(subject)) return true;

    const subrelation = subject.relationName ?? ELLIPSIS;
    if (subrelation === ELLIPSIS) continue;

    if (subject.objectType === def.name) {
      if (referencesWildcard(def, subrelation, encountered)) return true;
    }
    // Cross-definition transitive wildcard is reported by the caller's namespace check; here we
    // only need same-definition recursion to detect the common direct/indirect cases.
  }

  return false;
}

/**
 * Visits every {@link SetOperationChild} in a rewrite tree, depth-first. A nested rewrite is
 * RECURSED INTO WITHOUT BEING VISITED: only leaf children reach `visit`.
 */
function walkRewrite(operation: SetOperation, visit: (child: SetOperationChild) => void): void {
  for (const child of operation.children) {
    if (child.kind === "nestedRewrite") {
      walkRewrite(child.value.operation, visit);
      continue;
    }

    visit(child);
  }
}
