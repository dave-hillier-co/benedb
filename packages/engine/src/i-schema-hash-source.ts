/**
 * Supplies the schema hash that is current at dispatch time, so the dispatch mesh's cache and
 * grain keys are scoped to the live schema rather than a value frozen at construction time.
 *
 * Ported from Spiceport `Engine/ISchemaHashSource.cs`.
 *
 * This abstraction lives in the engine (which the caching dispatcher is part of) so the engine can
 * read the live hash without depending on the grains layer. The mutable schema provider in the
 * grains layer implements it. Reading the hash per request is what makes the cache correct across
 * a schema swap: every new key carries the new hash, so pre-change entries are never matched again
 * (they age out) and no stale-schema result is ever reused.
 */
export interface ISchemaHashSource {
  /**
   * The schema hash that is current right now.
   *
   * A COMPUTED property in C#: the grains-layer implementation recomputes it on every read. A
   * TypeScript interface cannot require getter-ness, so `i-schema-hash-source.test.ts` pins it.
   */
  readonly currentSchemaHash: string;
}

/**
 * A trivial {@link ISchemaHashSource} over a fixed hash, for the in-process check engine, which is
 * constructed against a single immutable schema (its cache key never needs to change).
 */
export function createFixedSchemaHashSource(currentSchemaHash: string): ISchemaHashSource {
  return { currentSchemaHash };
}
