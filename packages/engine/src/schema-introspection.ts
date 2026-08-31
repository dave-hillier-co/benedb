import { isAllowedRelationPublicWildcard } from "@benedb/core/allowed-relation";
import { ELLIPSIS } from "@benedb/core/core-constants";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { isPermission, type Relation } from "@benedb/core/relation";
import type { SetOperation, SetOperationChild } from "@benedb/core/userset-rewrite";

import type { ReachabilityGraph } from "./reachability-graph";
import { relationReferenceKey, type RelationReference } from "./relation-reference";
import { SchemaIntrospectionException } from "./schema-introspection-exception";

/**
 * Schema-introspection walks for the `ComputablePermissions` and `DependentRelations` RPCs. Pure
 * functions of the compiled namespace definitions (plus the memoized reachability graph); no
 * datastore, no revision.
 *
 * Ported from Spiceport `Engine/Reachability/SchemaIntrospection.cs`, itself a port of SpiceDB's
 * `pkg/schema` reflection helpers (`ComputablePermissions`/`RelationsEncounteredForSubject` and
 * `DependentRelations`/`RelationsEncounteredForResource`).
 *
 * Port decisions:
 *   * `HashSet<RelationReference>` for the results/seen/visited sets becomes a `Set` over the
 *     canonical key from `relation-reference.ts`; a `Set` of objects would compare by reference and
 *     dedupe nothing. The results set keeps the reference values alongside their keys, because the
 *     projection must hand back the objects.
 *   * `SchemaIntrospectionErrorKind` and `SchemaIntrospectionException` live in
 *     `schema-introspection-exception.ts` under the one-primary-export rule.
 */

/** A key-addressed set of relation references, standing in for `HashSet<RelationReference>`. */
type ReferenceSet = Map<string, RelationReference>;

/**
 * Forward closure: the relations/permissions reachable *from* the given relation when it acts as a
 * subject. Port of `ComputablePermissions` / `RelationsEncounteredForSubject`.
 *
 * @param namespaces The compiled namespaces, keyed by name.
 * @param reachability The pre-built (full-mode) reachability graph for this schema.
 * @param definitionName The starting definition.
 * @param relationName The starting relation (empty defaults to the ellipsis subject).
 * @param optionalDefinitionNameFilter Optional prefix filter on result definition names.
 * @returns The reachable targets, deduped and ordinally sorted, excluding the input itself.
 * @throws SchemaIntrospectionException If the definition is unknown, or a non-empty relation is
 * unknown.
 */
export function computablePermissions(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  reachability: ReachabilityGraph,
  definitionName: string,
  relationName: string,
  optionalDefinitionNameFilter?: string | undefined,
): readonly RelationReference[] {
  if (namespaces === undefined || namespaces === null) {
    throw new InvalidArgumentError("namespaces is required");
  }
  if (reachability === undefined || reachability === null) {
    throw new InvalidArgumentError("reachability is required");
  }

  const def = namespaces.get(definitionName);
  if (def === undefined) {
    throw new SchemaIntrospectionException(
      "definitionNotFound",
      `object definition \`${definitionName}\` not found`,
    );
  }

  // An empty relation name defaults to the ellipsis subject and SKIPS the existence check.
  const relation = relationName === undefined || relationName === "" ? ELLIPSIS : relationName;
  if (relation !== ELLIPSIS && !def.relations.some((r) => r.name === relation)) {
    throw new SchemaIntrospectionException(
      "relationNotFound",
      `relation/permission \`${relation}\` not found under definition \`${definitionName}\``,
    );
  }

  const graph = reachability;
  const input: RelationReference = { namespace: definitionName, relation };

  const results: ReferenceSet = new Map();
  const worklist: RelationReference[] = [];
  const seenSubjects = new Set<string>([relationReferenceKey(input)]);
  worklist.push(input);

  while (worklist.length > 0) {
    // `Queue.Dequeue`: FIFO, so shift, not pop.
    const subject = worklist.shift()!;
    for (const target of graph.targets) {
      const entrypoints = graph.entrypointsForSubjectToResource(subject, target, false);
      if (entrypoints.length === 0) continue;

      // `target` is reachable from `subject`; add it and continue the closure outward.
      const targetKey = relationReferenceKey(target);
      const addedToResults = !results.has(targetKey);
      if (addedToResults) results.set(targetKey, target);
      const addedToSeen = !seenSubjects.has(targetKey);
      if (addedToResults && addedToSeen) {
        seenSubjects.add(targetKey);
        worklist.push(target);
      } else {
        // Redundant in the C# too (the `&&` already short-circuited on a seen subject), but
        // transliterated faithfully: changing it changes the enqueue condition.
        seenSubjects.add(targetKey);
      }
    }
  }

  // AFTER the closure, so the input may be re-added transitively and is then removed.
  results.delete(relationReferenceKey(input));

  return project(results, optionalDefinitionNameFilter);
}

/**
 * Inverse closure: every relation/arrow a permission transitively depends on. Port of
 * `DependentRelations` / `RelationsEncounteredForResource`.
 *
 * @param namespaces The compiled namespaces, keyed by name.
 * @param definitionName The definition owning the permission.
 * @param permissionName The permission to walk.
 * @returns The referenced relations/permissions, deduped and ordinally sorted, excluding the input.
 * @throws SchemaIntrospectionException If the definition or permission is unknown, or the target is
 * a base relation rather than a permission.
 */
export function dependentRelations(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  definitionName: string,
  permissionName: string,
): readonly RelationReference[] {
  if (namespaces === undefined || namespaces === null) {
    throw new InvalidArgumentError("namespaces is required");
  }

  const def = namespaces.get(definitionName);
  if (def === undefined) {
    throw new SchemaIntrospectionException(
      "definitionNotFound",
      `object definition \`${definitionName}\` not found`,
    );
  }

  const permission = def.relations.find((r) => r.name === permissionName);
  if (permission === undefined) {
    throw new SchemaIntrospectionException(
      "relationNotFound",
      `permission \`${permissionName}\` not found under definition \`${definitionName}\``,
    );
  }

  if (!isPermission(permission)) {
    throw new SchemaIntrospectionException(
      "notAPermission",
      `\`${permissionName}\` is a relation, not a permission, under definition \`${definitionName}\``,
    );
  }

  const input: RelationReference = { namespace: definitionName, relation: permissionName };
  const results: ReferenceSet = new Map();
  const visitedPermissions = new Set<string>();

  walkPermission(namespaces, definitionName, permission, results, visitedPermissions);

  results.delete(relationReferenceKey(input));

  return project(results, undefined);
}

function walkPermission(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  defName: string,
  permission: Relation,
  results: ReferenceSet,
  visitedPermissions: Set<string>,
): void {
  const permissionKey = relationReferenceKey({ namespace: defName, relation: permission.name });
  if (visitedPermissions.has(permissionKey)) return;
  visitedPermissions.add(permissionKey);

  const rewrite = permission.usersetRewrite;
  if (rewrite === undefined) return;

  walkOperation(namespaces, defName, rewrite.operation, results, visitedPermissions);
}

function walkOperation(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  defName: string,
  operation: SetOperation,
  results: ReferenceSet,
  visitedPermissions: Set<string>,
): void {
  for (const child of operation.children) {
    walkChild(namespaces, defName, child, results, visitedPermissions);
  }
}

function walkChild(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  defName: string,
  child: SetOperationChild,
  results: ReferenceSet,
  visitedPermissions: Set<string>,
): void {
  switch (child.kind) {
    case "computedUserset":
      reference(namespaces, defName, child.value.relation, results, visitedPermissions);
      break;

    case "tupleToUserset":
      walkArrow(
        namespaces,
        defName,
        child.value.tuplesetRelation,
        child.value.computedUserset.relation,
        results,
        visitedPermissions,
      );
      break;

    case "functionedTupleToUserset":
      walkArrow(
        namespaces,
        defName,
        child.value.tuplesetRelation,
        child.value.computedUserset.relation,
        results,
        visitedPermissions,
      );
      break;

    case "nestedRewrite":
      walkOperation(namespaces, defName, child.value.operation, results, visitedPermissions);
      break;

    case "self":
      addResult(results, { namespace: defName, relation: ELLIPSIS });
      break;

    // This / Nil reference nothing. As in the C# this is a do-nothing default branch, not an
    // `assertNever` site.
    default:
      break;
  }
}

function walkArrow(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  defName: string,
  tuplesetRelation: string,
  computedRelation: string,
  results: ReferenceSet,
  visitedPermissions: Set<string>,
): void {
  // The tupleset relation on this definition is itself a dependency.
  reference(namespaces, defName, tuplesetRelation, results, visitedPermissions);

  // Then, for every allowed subject type of the tupleset relation that actually has the computed
  // relation, the (allowedType, computedRelation) is a dependency. This deliberately mirrors
  // `ReachabilityGraph`'s `addTtu`; the two must be kept in sync.
  const tuplesetRel = lookupRelation(namespaces, defName, tuplesetRelation);
  const typeInfo = tuplesetRel?.typeInformation;
  if (typeInfo === undefined) return;

  for (const allowed of typeInfo.allowedDirectRelations) {
    if (isAllowedRelationPublicWildcard(allowed)) continue;
    reference(namespaces, allowed.objectType, computedRelation, results, visitedPermissions);
  }
}

function reference(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  defName: string,
  relationName: string,
  results: ReferenceSet,
  visitedPermissions: Set<string>,
): void {
  const target = lookupRelation(namespaces, defName, relationName);
  if (target === undefined) return;

  addResult(results, { namespace: defName, relation: relationName });

  // If the referenced relation is itself a permission, expand it transitively.
  if (isPermission(target)) {
    walkPermission(namespaces, defName, target, results, visitedPermissions);
  }
}

function addResult(results: ReferenceSet, reference_: RelationReference): void {
  const key = relationReferenceKey(reference_);
  if (!results.has(key)) results.set(key, reference_);
}

function lookupRelation(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  objectType: string,
  relationName: string,
): Relation | undefined {
  const ns = namespaces.get(objectType);
  if (ns === undefined) return undefined;
  for (const r of ns.relations) {
    if (r.name === relationName) return r;
  }
  return undefined;
}

/**
 * Filters by an ORDINAL definition-name prefix and sorts by namespace then relation ORDINALLY.
 * This sort is what makes the by-target enumeration order of the reachability graph unobservable;
 * never remove it.
 */
function project(
  results: ReferenceSet,
  optionalDefinitionNameFilter: string | undefined,
): readonly RelationReference[] {
  let filtered = [...results.values()];
  // `string.IsNullOrEmpty`: an empty filter is no filter at all.
  if (optionalDefinitionNameFilter !== undefined && optionalDefinitionNameFilter !== "") {
    // JS `startsWith` is ordinal, matching `StringComparison.Ordinal`.
    filtered = filtered.filter((r) => r.namespace.startsWith(optionalDefinitionNameFilter));
  }

  return filtered.sort((a, b) => {
    if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
    if (a.relation !== b.relation) return a.relation < b.relation ? -1 : 1;
    return 0;
  });
}
