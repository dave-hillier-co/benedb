import type {
  CounterVersionWire,
  SchemaVersionWire,
  StoredRelationshipWire,
} from "./datastore-dtos";

/**
 * The serializable mirror of the in-memory MVCC `DatastoreState`: the full committed state of the
 * datastore at a head revision. Under the thin-sequencer layout this is no longer what the
 * datastore grain persists (rows live per key in `GraphShardState` rows, the rest in
 * `DatastoreMetaState`); it survives as the ASSEMBLED whole-state reply of
 * `IDatastoreGrain.readState` - small state plus every indexed forward key's current rows - which
 * the `GrainBackedDatastore`/scan seam converts to the in-memory state to reuse the
 * fold/transaction mechanics. Every relationship row carries its created/deleted revision stamps so
 * snapshot reads at any past revision are exact.
 *
 * Mirrors `packages/datastore/src/datastore-state.ts` field-for-field, so
 * `DatastoreStateConverters` can be a pure relabeling between the two.
 */
export interface DatastoreGrainState {
  /** The head (freshest committed) revision. */
  readonly headRevision: bigint;
  /** All relationship rows ever written, each with its MVCC visibility window. */
  readonly relationships: readonly StoredRelationshipWire[];
  /** All schema versions, in write order. */
  readonly schemas: readonly SchemaVersionWire[];
  /** All counter versions, in write order (tombstones included). */
  readonly counters: readonly CounterVersionWire[];
  /**
   * The revision below which MVCC history has been garbage-collected (0 = nothing collected yet).
   * Set by folding a GC `LogEvent` (never decreases). Reads pinned strictly below this floor are
   * rejected.
   */
  readonly gcFloor: bigint;
}

/** An empty state seeded at the given initial revision. */
export function datastoreGrainStateEmpty(initialRevision: bigint): DatastoreGrainState {
  return {
    headRevision: initialRevision,
    relationships: [],
    schemas: [],
    counters: [],
    gcFloor: 0n,
  };
}

/**
 * Returns the schema version effective at the given revision (the last version with
 * `revision <= atRevision`, the write-order fold), or absent if none was persisted at or before
 * it. Mirrors the in-memory `DatastoreState` schema scan.
 *
 * The loop BREAKS at the first schema above the revision, which is NOT the same as "the last
 * matching schema": on an out-of-order list the break stops early. That is deliberate and is kept
 * rather than simplified to a filter-and-take-last, because it relies on `schemas` being in
 * ascending write order and `MetaFold`'s compaction is what preserves that order.
 */
export function datastoreGrainStateSchemaVersionAt(
  state: DatastoreGrainState,
  atRevision: bigint,
): SchemaVersionWire | undefined {
  let result: SchemaVersionWire | undefined = undefined;
  for (const schema of state.schemas) {
    if (schema.revision <= atRevision) result = schema;
    else break;
  }
  return result;
}

/** Returns the schema hash effective at the given revision, or absent if none. */
export function datastoreGrainStateSchemaHashAt(
  state: DatastoreGrainState,
  atRevision: bigint,
): string | undefined {
  return datastoreGrainStateSchemaVersionAt(state, atRevision)?.hash;
}
