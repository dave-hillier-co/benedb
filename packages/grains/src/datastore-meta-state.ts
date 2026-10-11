import type { CounterVersionWire, SchemaVersionWire } from "./datastore-dtos";
import type { LogEvent } from "./log-event";

// A deliberately MULTI-EXPORT module, per the port ledger: `DatastoreMetaState.cs` carries the
// journaled state, the journal-entry union and the shard-tail reply, and they only make sense
// together.

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains.Abstractions/DatastoreMetaState.cs`.
 *
 * The journaled state of the sequencer datastore grain: everything the sequencer materializes
 * EXCEPT the relationship rows. Rows are owned by the per-key `IGraphShardGrain` projections (each
 * persists its own `GraphShardState`), so this record carries only the head revision, the
 * schema/counter version histories, the GC floor, the object types ever seen per direction (the
 * index's enumeration roots), and the PENDING TAIL - the committed events not yet projected into
 * the shard grains, plus the revision the projection has reached.
 *
 * The pending tail is what makes the projection crash-safe under any snapshot policy: a committed
 * event leaves the journaled state only when a `projected` entry records that every shard it
 * touches has persisted it. It is bounded by the sequencer's flush interval, so the state stays
 * small however large the graph grows.
 *
 * PORT NOTE: the C# `ImmutableSortedSet<string>` type sets become sorted `readonly string[]`s, so
 * the state round-trips through the journal's value codec as plain data.
 */
export interface DatastoreMetaState {
  /** The head (freshest committed) revision. */
  readonly headRevision: bigint;
  /** All schema versions, in write order (compacted below the GC floor). */
  readonly schemas: readonly SchemaVersionWire[];
  /** All counter versions, in write order (tombstones included; compacted below the floor). */
  readonly counters: readonly CounterVersionWire[];
  /** The MVCC GC floor: history strictly below it has been collected. */
  readonly gcFloor: bigint;
  /**
   * The committed events not yet projected into the shard grains, ascending by revision. Every
   * event above `projectedThrough` is here; none at or below it is.
   */
  readonly pending: readonly LogEvent[];
  /**
   * The revision the shard projection has reached: every event at or below it is persisted by
   * every shard grain it touches, and its touched keys are in the shard index.
   */
  readonly projectedThrough: bigint;
  /** The resource types any committed relationship has named (sorted) - the forward index's roots. */
  readonly forwardTypes: readonly string[];
  /** The subject types any committed relationship has named (sorted) - the reverse index's roots. */
  readonly reverseTypes: readonly string[];
}

/** An empty state seeded at the given initial revision. */
export function datastoreMetaStateEmpty(initialRevision: bigint): DatastoreMetaState {
  return {
    headRevision: initialRevision,
    schemas: [],
    counters: [],
    gcFloor: 0n,
    pending: [],
    projectedThrough: initialRevision,
    forwardTypes: [],
    reverseTypes: [],
  };
}

/**
 * Returns the schema version effective at the given revision (the last version with
 * `revision <= atRevision`, the write-order fold), or absent if none was persisted at or before
 * it. It relies on ascending write order, which `MetaFold`'s compaction preserves.
 */
export function datastoreMetaStateSchemaVersionAt(
  state: DatastoreMetaState,
  atRevision: bigint,
): SchemaVersionWire | undefined {
  let result: SchemaVersionWire | undefined = undefined;
  for (const schema of state.schemas) {
    if (schema.revision <= atRevision) result = schema;
    else break;
  }
  return result;
}

/** The schema hash effective at the given revision, or absent in the seed-only window. */
export function datastoreMetaStateSchemaHashAt(
  state: DatastoreMetaState,
  atRevision: bigint,
): string | undefined {
  return datastoreMetaStateSchemaVersionAt(state, atRevision)?.hash;
}

/**
 * One entry of the sequencer's journal. `committed` carries a canonical `LogEvent` (the
 * datastore's source of truth, and what Watch and the shard grains tail); `projected` records
 * that the shard projection has caught up through a revision, which is what lets the pending tail
 * shrink; `seeded` is the store's first entry, fixing the head before any write at the revision
 * the first activation minted, so the pre-first-write head is stable across reactivation.
 *
 * PORT NOTE: the C# abstract record with three nested sealed records becomes a discriminated
 * union on `kind`.
 */
export type DatastoreJournalEntry =
  | { readonly kind: "seeded"; readonly revision: bigint }
  | { readonly kind: "committed"; readonly event: LogEvent }
  | { readonly kind: "projected"; readonly through: bigint };

/**
 * The sequencer's reply to a shard grain hydrating itself: the pending events that touch the
 * shard's key, plus the head and floor to relabel and collect at. A shard's state is its own
 * projected state with these events folded over (those above its projected label), relabeled to
 * the head.
 */
export interface ShardTailWire {
  readonly events: readonly LogEvent[];
  readonly headRevision: bigint;
  readonly gcFloor: bigint;
}
