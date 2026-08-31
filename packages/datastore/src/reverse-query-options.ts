import type { Relationship } from "@benedb/core/relationship";
import type { RelationshipReference } from "@benedb/core/relationship-reference";

/**
 * The sort order a reverse query yields its relationships in.
 *
 * The C# enum has explicit 0/1 values, but `ReverseQuerySort` is NOT wire-visible - it never
 * leaves the process - so this is a plain string-literal union with no wire map.
 *
 * - `unsorted`: no ordering guarantee (the default; cheapest).
 * - `bySubject`: subject-first total order
 *   `(subjectType, subjectId, subjectRelation, resourceType, resourceId, resourceRelation)` by
 *   ordinal string comparison. Port of SpiceDB's `BySubject` sort, the stable order
 *   LookupResources uses for cursored, resumable reverse traversal.
 */
export type ReverseQuerySort = "unsorted" | "bySubject";

/**
 * Options for `reverseQueryRelationships` controlling ordering and keyset resumption. The
 * default (no options) preserves the original unordered, unbounded behaviour.
 *
 * When `sort` is `bySubject` the relationships are returned in a deterministic total order.
 * `after` resumes that order strictly after a previously-returned relationship (exclusive
 * keyset), so a caller can page without re-seeing rows. The full six-tuple is the
 * relationship's primary key, so the order has no ties and resumption is exact. The keyset
 * guard is applied AFTER the sort, not folded into it.
 */
export interface ReverseQueryOptions {
  /** The ordering to apply; absent means `unsorted`, matching the C# default argument. */
  readonly sort?: ReverseQuerySort | undefined;
  /** An exclusive keyset position to resume after; requires a non-unsorted sort. */
  readonly after?: RelationshipReference | undefined;
}

/**
 * `string.CompareOrdinal`. JS `<` / `>` on strings IS UTF-16 ordinal comparison, so this is
 * exact; `localeCompare` would be wrong and would corrupt every cursor.
 *
 * CompareOrdinal returns a character difference rather than -1/0/1, but only the sign is ever
 * consumed (`!= 0`, `<= 0`, and as a sort comparator), so narrowing to -1/0/1 is safe.
 */
function compareOrdinal(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The `bySubject` comparison over two relationship references.
 *
 * Note the sort key is SUBJECT-first, a different order from `MvccReadWriteTransaction`'s
 * resource-first delete-limit comparator; the two must not share one function.
 *
 * `.NET List<T>.Sort` is an unstable introsort while `Array.prototype.sort` is stable, but the
 * six-tuple is the relationship's primary key, so the comparator is total and no ties exist -
 * the difference is unobservable.
 */
export function compareReferencesBySubject(
  x: RelationshipReference,
  y: RelationshipReference,
): number {
  let c: number;
  if ((c = compareOrdinal(x.subject.objectType, y.subject.objectType)) !== 0) return c;
  if ((c = compareOrdinal(x.subject.objectId, y.subject.objectId)) !== 0) return c;
  if ((c = compareOrdinal(x.subject.relation, y.subject.relation)) !== 0) return c;
  if ((c = compareOrdinal(x.resource.objectType, y.resource.objectType)) !== 0) return c;
  if ((c = compareOrdinal(x.resource.objectId, y.resource.objectId)) !== 0) return c;
  return compareOrdinal(x.resource.relation, y.resource.relation);
}

/** The `bySubject` comparison over two relationships. */
export function compareRelationshipsBySubject(x: Relationship, y: Relationship): number {
  return compareReferencesBySubject(x.reference, y.reference);
}
