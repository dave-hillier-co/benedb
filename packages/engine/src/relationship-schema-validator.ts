import {
  isAllowedRelationPublicWildcard,
  type AllowedRelation,
} from "@benedb/core/allowed-relation";
import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { isPublicWildcard } from "@benedb/core/object-and-relation";
import { isPermission, type Relation } from "@benedb/core/relation";
import type { Relationship } from "@benedb/core/relationship";
import type { UpdateOperation } from "@benedb/core/relationship-update";
import type { CompiledSchema } from "@benedb/schema/compiled-schema";

/**
 * Mirrors SpiceDB's write-time relationship validation (`internal/relationships/validation.go`
 * `ValidateRelationshipUpdates` / `ValidateOneRelationship`): every written relationship must name
 * a known resource definition and relation, a known subject definition and (non-ellipsis)
 * subrelation, must not target a permission, and its (subject type, subrelation, caveat,
 * expiration) must match one of the relation's allowed types. A DELETE without a caveat is held
 * only to the subject type and subrelation, so a caveated or expiring tuple can be deleted without
 * restating its caveat or expiration.
 *
 * Originally ported from Spiceport `Loading/RelationshipSchemaValidator.cs` (a create-only subset
 * used by the loader-robustness suite); it now lives in `@benedb/engine` because it is production
 * code: `RelationshipsGrain` calls it on every `WriteRelationships` and `ImportBulkRelationships`
 * commit, and the conformance loader suite reuses this same copy.
 *
 * Not ported: SpiceDB's write-time caveat-context parameter type check
 * (`caveats.ConvertContextToParameters` with `ErrorForUnknownParameters`).
 */

/**
 * Which SpiceDB error a {@link RelationshipTypeException} stands for. The gRPC front door maps it:
 * `unknownDefinition` / `unknownRelation` are FAILED_PRECONDITION (`NamespaceNotFoundError` /
 * `RelationNotFoundError`); `cannotWriteToPermission` / `invalidSubjectType` are INVALID_ARGUMENT
 * (`CannotWriteToPermissionError` / `InvalidSubjectTypeError`).
 */
export type RelationshipTypeReason =
  "unknownDefinition" | "unknownRelation" | "cannotWriteToPermission" | "invalidSubjectType";

/** Raised when a written relationship is not permitted by the schema. */
export class RelationshipTypeException extends Error {
  /** Which SpiceDB validation error this is. */
  readonly reason: RelationshipTypeReason;

  constructor(reason: RelationshipTypeReason, message: string) {
    super(message);
    // Re-pins the prototype so `instanceof` survives downlevelling; C# needs no equivalent.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "RelationshipTypeException";
    this.reason = reason;
  }
}

/** One relationship update to validate: the relationship and the operation applying it. */
export interface RelationshipUpdateToValidate {
  readonly relationship: Relationship;
  readonly operation: UpdateOperation;
}

/**
 * Validates every relationship as a CREATE/TOUCH (SpiceDB's
 * `ValidateRelationshipsForCreateOrTouch`).
 *
 * @throws {RelationshipTypeException} for the first relationship the schema does not permit.
 */
export function validateAllRelationships(
  schema: CompiledSchema,
  relationships: Iterable<Relationship>,
): void {
  const byName = namespacesByName(schema);
  for (const rel of relationships) {
    validateOne(byName, rel, "createOrTouch");
  }
}

/**
 * Validates every update, holding a DELETE to SpiceDB's relaxed deletion rule and a CREATE/TOUCH
 * to the exact allowed-type match (SpiceDB's `ValidateRelationshipUpdates`).
 *
 * @throws {RelationshipTypeException} for the first update the schema does not permit.
 */
export function validateRelationshipUpdates(
  schema: CompiledSchema,
  updates: Iterable<RelationshipUpdateToValidate>,
): void {
  const byName = namespacesByName(schema);
  for (const update of updates) {
    validateOne(
      byName,
      update.relationship,
      update.operation === "delete" ? "delete" : "createOrTouch",
    );
  }
}

function namespacesByName(schema: CompiledSchema): ReadonlyMap<string, NamespaceDefinition> {
  // `ToDictionary` THROWS on a duplicate key; `new Map(...)` silently overwrites, so the throw
  // is restored explicitly. `StringComparer.Ordinal` is what a JS string key already is.
  const byName = new Map<string, NamespaceDefinition>();
  for (const namespaceDefinition of schema.namespaces) {
    if (byName.has(namespaceDefinition.name)) {
      throw new InvalidArgumentError(
        `An item with the same key has already been added. Key: ${namespaceDefinition.name}`,
      );
    }
    byName.set(namespaceDefinition.name, namespaceDefinition);
  }
  return byName;
}

type ValidationRule = "createOrTouch" | "delete";

function namespaceNotFound(name: string): RelationshipTypeException {
  return new RelationshipTypeException(
    "unknownDefinition",
    `object definition \`${name}\` not found`,
  );
}

function relationNotFound(namespace: string, relation: string): RelationshipTypeException {
  return new RelationshipTypeException(
    "unknownRelation",
    `relation/permission \`${relation}\` not found under definition \`${namespace}\``,
  );
}

function findRelation(def: NamespaceDefinition, name: string): Relation | undefined {
  return def.relations.find((r) => r.name === name);
}

/** The ONE check order of SpiceDB's `ValidateOneRelationship`; the first failure wins. */
function validateOne(
  byName: ReadonlyMap<string, NamespaceDefinition>,
  rel: Relationship,
  rule: ValidationRule,
): void {
  const resource = rel.reference.resource;
  const subject = rel.reference.subject;

  const resourceDef = byName.get(resource.objectType);
  if (resourceDef === undefined) throw namespaceNotFound(resource.objectType);

  const relation = findRelation(resourceDef, resource.relation);
  if (relation === undefined) throw relationNotFound(resource.objectType, resource.relation);

  const subjectDef = byName.get(subject.objectType);
  if (subjectDef === undefined) throw namespaceNotFound(subject.objectType);

  if (subject.relation !== ELLIPSIS && findRelation(subjectDef, subject.relation) === undefined) {
    throw relationNotFound(subject.objectType, subject.relation);
  }

  if (isPermission(relation)) {
    throw new RelationshipTypeException(
      "cannotWriteToPermission",
      `cannot write a relationship to permission \`${resource.relation}\` under definition ` +
        `\`${resource.objectType}\``,
    );
  }

  const allowed: readonly AllowedRelation[] =
    relation.typeInformation?.allowedDirectRelations ?? [];
  const caveatName = rel.optionalCaveat?.caveatName;
  const wildcard = isPublicWildcard(subject);
  const toCheck: AllowedRelation = {
    objectType: subject.objectType,
    kind: wildcard ? "publicWildcard" : "relation",
    relationName: wildcard ? undefined : subject.relation,
    requiredCaveat: caveatName !== undefined ? { caveatName } : undefined,
    requiresExpiration: rel.optionalExpiration !== undefined,
  };

  let isAllowed: boolean;
  if (rule === "createOrTouch" || caveatName !== undefined) {
    // For writing, or when a caveat was specified, the caveat and expiration must match exactly
    // (SpiceDB's `HasAllowedRelation` compares the allowed types' source strings).
    const wanted = sourceForAllowedRelation(toCheck);
    isAllowed = allowed.some((a) => sourceForAllowedRelation(a) === wanted);
  } else if (wildcard) {
    // SpiceDB `IsAllowedPublicNamespace`: any wildcard of the subject type, whatever its traits.
    isAllowed = allowed.some(
      (a) => a.objectType === subject.objectType && isAllowedRelationPublicWildcard(a),
    );
  } else {
    // SpiceDB `IsAllowedDirectRelation`: the subject type and subrelation, ignoring traits.
    isAllowed = allowed.some(
      (a) =>
        a.objectType === subject.objectType &&
        !isAllowedRelationPublicWildcard(a) &&
        (a.relationName ?? ELLIPSIS) === subject.relation,
    );
  }

  if (!isAllowed) throw invalidSubjectType(rel, toCheck, allowed);
}

/**
 * SpiceDB `schema.SourceForAllowedRelation`: `type`, `type#relation` or `type:*`, followed by
 * ` with <caveat>`, ` with expiration` or ` with <caveat> and expiration`.
 */
function sourceForAllowedRelation(allowed: AllowedRelation): string {
  const caveat = allowed.requiredCaveat?.caveatName;
  const hasCaveat = caveat !== undefined && caveat !== "";
  let traits = "";
  if (hasCaveat || allowed.requiresExpiration) {
    traits = " with ";
    if (hasCaveat) traits += caveat;
    if (hasCaveat && allowed.requiresExpiration) traits += " and ";
    if (allowed.requiresExpiration) traits += "expiration";
  }

  if (isAllowedRelationPublicWildcard(allowed)) {
    return `${allowed.objectType}:${PUBLIC_WILDCARD}${traits}`;
  }
  const relationName = allowed.relationName ?? ELLIPSIS;
  if (relationName !== ELLIPSIS) return `${allowed.objectType}#${relationName}${traits}`;
  return `${allowed.objectType}${traits}`;
}

/** SpiceDB `NewInvalidSubjectTypeError`, including its caveat hint and its "did you mean". */
function invalidSubjectType(
  rel: Relationship,
  toCheck: AllowedRelation,
  allowed: readonly AllowedRelation[],
): RelationshipTypeException {
  const resource = rel.reference.resource;
  const subject = rel.reference.subject;
  const source = sourceForAllowedRelation(toCheck);
  const prefix =
    `subjects of type \`${source}\` are not allowed on relation ` +
    `\`${resource.objectType}#${resource.relation}\``;

  // An uncaveated subject where only caveated forms of the same subject type are allowed.
  if (rel.optionalCaveat === undefined) {
    const caveats: string[] = [];
    for (const a of allowed) {
      const caveat = a.requiredCaveat?.caveatName;
      if (
        caveat !== undefined &&
        caveat !== "" &&
        a.objectType === subject.objectType &&
        !isAllowedRelationPublicWildcard(a) &&
        (a.relationName ?? ELLIPSIS) === subject.relation &&
        !isPublicWildcard(subject) &&
        a.requiresExpiration === (rel.optionalExpiration !== undefined) &&
        !caveats.includes(caveat)
      ) {
        caveats.push(caveat);
      }
    }
    if (caveats.length > 0) {
      return new RelationshipTypeException(
        "invalidSubjectType",
        `${prefix} without one of the following caveats: ${caveats.join(",")}`,
      );
    }
  }

  const suggestion = closestFuzzyMatch(
    source,
    allowed.map((a) => sourceForAllowedRelation(a)),
  );
  if (suggestion !== undefined) {
    return new RelationshipTypeException(
      "invalidSubjectType",
      `${prefix}; did you mean \`${suggestion}\`?`,
    );
  }

  return new RelationshipTypeException("invalidSubjectType", prefix);
}

/**
 * `fuzzy.RankFind(source, targets)` then the lowest-ranked target (lithammer/fuzzysearch): a target
 * matches when every character of `source` appears in it in order, and matches rank by Levenshtein
 * distance. Go's `sort.Sort` over the handful of allowed types is an insertion sort, so ties keep
 * their schema order - the stable sort here.
 */
function closestFuzzyMatch(source: string, targets: readonly string[]): string | undefined {
  const matches = targets
    .filter((target) => isSubsequence(source, target))
    .map((target, index) => ({ target, index, distance: levenshtein(source, target) }));
  matches.sort((a, b) => a.distance - b.distance || a.index - b.index);
  return matches[0]?.target;
}

function isSubsequence(source: string, target: string): boolean {
  let at = 0;
  for (const ch of source) {
    const found = target.indexOf(ch, at);
    if (found < 0) return false;
    at = found + ch.length;
  }
  return true;
}

function levenshtein(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  let previous = Array.from({ length: right.length + 1 }, (_unused, j) => j);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return previous[right.length]!;
}
