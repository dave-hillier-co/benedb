import type { RelationshipsFilter } from "./relationships-filter";

/**
 * A registered relationship counter: a stable name bound to the `RelationshipsFilter` whose live
 * matches are counted on demand. Stored MVCC-versioned, exactly like the unified schema:
 * registering writes a version, unregistering tombstones it, and a snapshot read sees the counter
 * (and filter) live at its revision.
 *
 * A plain readonly interface, not a class: nothing keys or hashes a registered counter, so it
 * needs no canonical-key or equality helper. Both members are REQUIRED - the MVCC counter version
 * carries a nullable filter (null being the tombstone that unregisters it), and that case must not
 * be representable here, which is what a live counter means.
 */
export interface RegisteredCounter {
  /** The counter's unique name. */
  readonly name: string;
  /** The filter whose matching relationships are counted. */
  readonly filter: RelationshipsFilter;
}
