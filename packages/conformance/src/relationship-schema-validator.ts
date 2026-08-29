import {
  isAllowedRelationPublicWildcard,
  type AllowedRelation,
} from "@spacedb/core/allowed-relation";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import { isPublicWildcard } from "@spacedb/core/object-and-relation";
import { isPermission } from "@spacedb/core/relation";
import type { Relationship } from "@spacedb/core/relationship";
import type { CompiledSchema } from "@spacedb/schema/compiled-schema";

/**
 * Mirrors SpiceDB's write-time `relationships.ValidateRelationshipsForCreateOrTouch`: a written
 * relationship's (subject type, subrelation, caveat) must match one of the relation's allowed
 * types. Spiceport's production write path does NOT perform this check (a known gap vs SpiceDB),
 * so the loader-robustness suite applies it explicitly before writing.
 *
 * Ported from Spiceport `Loading/RelationshipSchemaValidator.cs`. The C# static class becomes
 * module functions; its nested `RelationshipTypeException` becomes a sibling export.
 */

/** Raised when a written relationship is not permitted by the relation's allowed types. */
export class RelationshipTypeException extends Error {
  constructor(message: string) {
    super(message);
    // Re-pins the prototype so `instanceof` survives downlevelling; C# needs no equivalent.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "RelationshipTypeException";
  }
}

/**
 * Validates every relationship against the compiled schema's allowed direct relations.
 *
 * The C# `RelationshipSchemaValidator.ValidateAll`.
 *
 * @throws {RelationshipTypeException} for the first relationship the schema does not permit.
 */
export function validateAllRelationships(
  schema: CompiledSchema,
  relationships: Iterable<Relationship>,
): void {
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

  for (const rel of relationships) {
    validateOne(byName, rel);
  }
}

function validateOne(byName: ReadonlyMap<string, NamespaceDefinition>, rel: Relationship): void {
  const resource = rel.reference.resource;
  const subject = rel.reference.subject;

  const def = byName.get(resource.objectType);
  if (def === undefined) {
    throw new RelationshipTypeException(`object definition \`${resource.objectType}\` not found`);
  }

  const relation = def.relations.find((r) => r.name === resource.relation && !isPermission(r));
  if (relation === undefined) {
    throw new RelationshipTypeException(
      `relation/permission \`${resource.relation}\` not found under definition \`${resource.objectType}\``,
    );
  }

  const allowed: readonly AllowedRelation[] =
    relation.typeInformation?.allowedDirectRelations ?? [];
  const caveatName = rel.optionalCaveat?.caveatName;
  const subjectRel = subject.relation;

  for (const a of allowed) {
    const typeOk = a.objectType === subject.objectType;
    const relOk = isAllowedRelationPublicWildcard(a)
      ? isPublicWildcard(subject)
      : !isPublicWildcard(subject) && (a.relationName ?? ELLIPSIS) === subjectRel;
    // Both absent, or both the same name. C# `==` on `string?` and `===` on
    // `string | undefined` agree on the both-absent case.
    const caveatOk = a.requiredCaveat?.caveatName === caveatName;
    if (typeOk && relOk && caveatOk) {
      return;
    }
  }

  // SpiceDB message: "subjects of type `user with some_caveat` are not allowed on relation `resource#reader`"
  const subjDesc =
    caveatName === undefined ? subject.objectType : `${subject.objectType} with ${caveatName}`;
  throw new RelationshipTypeException(
    `subjects of type \`${subjDesc}\` are not allowed on relation \`${resource.objectType}#${resource.relation}\``,
  );
}
