/**
 * A relation (or permission) qualified by a namespace, with no object id:
 * `namespace#relation` (e.g. "org#admin").
 */
export interface RelationReference {
  /** The namespace / definition name. */
  readonly objectType: string;
  /** The relation or permission name. */
  readonly relation: string;
}

/**
 * Formats as `namespace#relation`, matching the C# record's `ToString()`.
 *
 * Note this does NOT elide an ellipsis relation, unlike `formatObjectAndRelation`: the two
 * formats deliberately differ. Because C# record equality is structural and a TypeScript
 * object in a `Map`/`Set` key position compares by reference, this string is also the
 * canonical key wherever Spiceport used a `RelationReference` as a dictionary/HashSet key.
 */
export function formatRelationReference(reference: RelationReference): string {
  return `${reference.objectType}#${reference.relation}`;
}
