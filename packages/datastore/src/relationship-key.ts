import type { Relationship } from "@spacedb/core/relationship";

/**
 * The full identity of a relationship for storage purposes: resource type/id/relation and
 * subject type/id/relation. Caveat, expiration and integrity are payload, not identity.
 *
 * The C# is an `internal readonly record struct`. `internal` has no TypeScript equivalent, so
 * this is exported normally; nothing outside `@spacedb/datastore` should import it.
 *
 * The C# uses the struct directly as a `Dictionary` key, as `HashSet` members and with `==`,
 * all of which rely on record value equality. A TypeScript `Map`/`Set` keys by REFERENCE, so
 * every such lookup would silently miss. The port therefore keeps the record shape (still
 * needed: `MvccReadWriteTransaction` sorts by the individual fields, resource-first) and adds
 * `relationshipKeyString` as the canonical key actually handed to a `Map`/`Set`.
 */
export interface RelationshipKey {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly resourceRelation: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectRelation: string;
}

/**
 * Length-prefixes one field of the canonical key, so that the concatenation below is injective
 * for *any* six strings.
 *
 * A separator character is not good enough here. The C# `RelationshipKey` is a
 * `readonly record struct`, so its `Dictionary`/`HashSet` equality compares the six fields
 * positionally and is injective unconditionally. A joined string only inherits that if the
 * separator cannot occur in a field — and nothing on this path enforces the SpiceDB grammar:
 * `validateRelationship` checks emptiness and the resource-wildcard rule and nothing else, so a
 * field containing any given character reaches this function. Length-prefixing restores the
 * unconditional guarantee rather than making it contingent on a validator in another layer.
 */
function framed(part: string): string {
  return `${part.length}:${part}`;
}

/** Port of `RelationshipKey.From`. */
export function relationshipKeyOf(rel: Relationship): RelationshipKey {
  const { resource, subject } = rel.reference;
  return {
    resourceType: resource.objectType,
    resourceId: resource.objectId,
    resourceRelation: resource.relation,
    subjectType: subject.objectType,
    subjectId: subject.objectId,
    subjectRelation: subject.relation,
  };
}

/**
 * The canonical `Map`/`Set` key for a relationship key: the six parts, resource first, each
 * length-prefixed. Replaces the C# record's structural equality, and like it, distinguishes
 * every distinct six-tuple regardless of the characters the fields contain.
 */
export function relationshipKeyString(key: RelationshipKey): string {
  return (
    framed(key.resourceType) +
    framed(key.resourceId) +
    framed(key.resourceRelation) +
    framed(key.subjectType) +
    framed(key.subjectId) +
    framed(key.subjectRelation)
  );
}
