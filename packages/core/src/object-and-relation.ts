import { PUBLIC_WILDCARD } from "./core-constants";
import type { RelationReference } from "./relation-reference";

/**
 * An object qualified by a relation name: `namespace:object_id#relation`. Also known as an ONR.
 * Used for both resources and subjects in a relationship.
 *
 * Formatting lives in `tuple-strings.ts` (which owns the mutually recursive ONR / relationship
 * string graph); this module deliberately does not import it, so the cycle the C# has between
 * `ObjectAndRelation.ToString` and `TupleStrings` cannot bite at module-init time.
 */
export interface ObjectAndRelation {
  /** The namespace / definition name (e.g. "document", "user", "org/user"). */
  readonly objectType: string;
  /** The object identifier. May be `PUBLIC_WILDCARD` for subjects. */
  readonly objectId: string;
  /** The relation name, or `ELLIPSIS` ("...") for subjects with no subrelation. */
  readonly relation: string;
}

/** Returns a copy with a different relation. Never mutates, matching the C# `with` expression. */
export function withRelation(onr: ObjectAndRelation, newRelation: string): ObjectAndRelation {
  return { objectType: onr.objectType, objectId: onr.objectId, relation: newRelation };
}

/** Drops the object id, returning the namespace/relation pair. */
export function asRelationReference(onr: ObjectAndRelation): RelationReference {
  return { objectType: onr.objectType, relation: onr.relation };
}

/** True if this ONR refers to a public wildcard subject. C# `==` on string is ordinal; `===` matches. */
export function isPublicWildcard(onr: ObjectAndRelation): boolean {
  return onr.objectId === PUBLIC_WILDCARD;
}

/**
 * The canonical `Map`/`Set` key for an ONR, replacing C# record equality. It ALWAYS includes
 * the relation, including an ellipsis - unlike the formatted ONR string, which elides it.
 * Keying on the formatted string would make the key ambiguous the moment a relation is empty.
 */
export function objectAndRelationKey(onr: ObjectAndRelation): string {
  return `${onr.objectType}:${onr.objectId}#${onr.relation}`;
}

/** Structural equality, matching C# record equality. */
export function objectAndRelationEquals(a: ObjectAndRelation, b: ObjectAndRelation): boolean {
  return a.objectType === b.objectType && a.objectId === b.objectId && a.relation === b.relation;
}
