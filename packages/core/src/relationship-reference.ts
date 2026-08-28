import {
  objectAndRelationEquals,
  objectAndRelationKey,
  type ObjectAndRelation,
} from "./object-and-relation";

/**
 * The identifying core of a relationship (tuple): the resource and subject, without any
 * caveat, expiration, or integrity metadata.
 */
export interface RelationshipReference {
  /** The resource ONR (e.g. document:readme#viewer). */
  readonly resource: ObjectAndRelation;
  /** The subject ONR (e.g. user:alice#...). */
  readonly subject: ObjectAndRelation;
}

/**
 * The canonical `Map`/`Set` key, replacing the C# record's structural equality where a
 * `RelationshipReference` was used as a dedup key. Composes the two ONR keys around '@', so
 * (like the ONR key) it keeps an ellipsis relation rather than eliding it as a tuple string does.
 */
export function relationshipReferenceKey(reference: RelationshipReference): string {
  return `${objectAndRelationKey(reference.resource)}@${objectAndRelationKey(reference.subject)}`;
}

/** Structural equality, matching C# record equality. */
export function relationshipReferenceEquals(
  a: RelationshipReference,
  b: RelationshipReference,
): boolean {
  return (
    objectAndRelationEquals(a.resource, b.resource) && objectAndRelationEquals(a.subject, b.subject)
  );
}
