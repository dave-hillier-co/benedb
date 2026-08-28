/**
 * A reference to a relation (or permission) within a namespace. Port of SpiceDB's
 * `core.RelationReference`, via Spiceport `Engine/Reachability/RelationReference.cs`.
 *
 * NAME COLLISION, deliberately preserved: `@spacedb/core/relation-reference` also exports a
 * `RelationReference`, but its members are `{ objectType, relation }` while this engine record's
 * are `{ namespace, relation }` (matching the C# `RelationReference(string Namespace, string
 * Relation)`). The two types are therefore structurally INCOMPATIBLE, which is what we want -
 * TypeScript catches a cross-wiring that C# would too. Where both appear in one file, import
 * core's under an alias.
 */
export interface RelationReference {
  /** The object type / definition name. */
  readonly namespace: string;
  /** The relation or permission name. */
  readonly relation: string;
}

/**
 * THE canonical key for an engine {@link RelationReference}.
 *
 * The C# record is used as a `Dictionary` key and a `HashSet` element in the reachability graph
 * and schema introspection, where record equality is free; a JS `Map`/`Set` would compare by
 * reference instead. Every later batch must import this function rather than inventing a second
 * one.
 *
 * Each part is LENGTH-PREFIXED rather than joined on a bare "#": SpiceDB object-type and relation
 * names are validated elsewhere and that validator does not run inside the engine, so a bare
 * separator would make injectivity depend on a check that may never have happened.
 */
export function relationReferenceKey(reference: RelationReference): string {
  const { namespace, relation } = reference;
  return `${namespace.length}:${namespace}#${relation.length}:${relation}`;
}
