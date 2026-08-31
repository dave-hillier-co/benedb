import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";

import type { CounterVersionWire, SchemaVersionWire } from "./datastore-dtos";
import { fnv1a64 } from "./stable-hash";

// A deliberately MULTI-EXPORT module, per the port ledger: `DatastoreMetaState.cs` carries the
// five thin-sequencer layout types plus the mutable holder, and they only make sense together.

/**
 * The SMALL state of the thin-sequencer datastore grain: everything the sequencer materializes
 * EXCEPT the relationship rows. Rows live in per-key `GraphShardState` storage rows (one per
 * adjacency slice, both directions) plus the grain's in-memory dirty buffer; this record carries
 * only the head revision, the schema/counter version histories, the GC floor, and the KEY INDEX -
 * a map per direction from each populated shard key (escaped `direction/type/id` key string, the
 * `GraphShardGrainKey` form) to the ROW VERSION its current durable row is stored under: shard rows
 * are VERSION-QUALIFIED and write-once per version (`shard/{rowVersion}/{dir}/{type}/{id}`, where
 * the row version is the flush's meta version), so the index is the ONLY path to a row. A key
 * absent from both maps has no stored row worth reading (a physically leaked row - a crashed
 * best-effort clear or an abandoned flush attempt - is unreferenced dead history and must be
 * ignored), so "not indexed and not dirty" resolves to the empty shard without a storage read.
 *
 * The index is add-mostly and its VERSIONS only move at flushes: folding an event adds its touched
 * keys at `NO_ROW_VERSION` (or keeps an existing entry's version - the pure fold never knows a
 * storage version); the flush that writes a key's row bumps its entry to the flush version on the
 * meta entry it persists, and keys whose shard state becomes EMPTY are pruned there too. Between
 * flushes a key indexed at `NO_ROW_VERSION` is always covered by the grain's dirty buffer, so the
 * sentinel is never dereferenced as a storage row.
 *
 * The index values are `int` STORAGE versions and stay `number`s while the head and floor are
 * `bigint` revisions; mixing the two is the easiest silent bug in this layout.
 */
export interface DatastoreMetaState {
  /** The head (freshest committed) revision. */
  readonly headRevision: bigint;
  /** All schema versions, in write order (compacted below the GC floor). */
  readonly schemas: readonly SchemaVersionWire[];
  /** All counter versions, in write order (tombstones included; compacted below the floor). */
  readonly counters: readonly CounterVersionWire[];
  /**
   * The revision below which MVCC history has been garbage-collected (0 = nothing collected yet).
   * Advanced by folding a GC `LogEvent`; never decreases. Reads pinned strictly below this floor
   * are rejected. Row-level collection is LAZY: stored shard rows compact when next dirtied and
   * flushed, and every serve path re-applies the floor, so lazily-retained dead rows are never
   * visible.
   */
  readonly gcFloor: bigint;
  /**
   * The populated FORWARD shard keys (escaped `f/type/id` strings), each mapped to the row version
   * its current durable `shard/{rowVersion}/{key}` row is stored under (`NO_ROW_VERSION` = no
   * durable row yet).
   */
  readonly forwardKeys: ReadonlyMap<string, number>;
  /** The populated REVERSE shard keys (escaped `r/type/id` strings), mapped like `forwardKeys`. */
  readonly reverseKeys: ReadonlyMap<string, number>;
}

/**
 * The sentinel row version of a key that is indexed but has NO durable row yet (first touched
 * after the last flush; its state lives only in the dirty buffer and the log tail). In-memory
 * only: it never appears in a durable row.
 */
export const NO_ROW_VERSION = -1;

/** An empty small state seeded at the given initial revision. */
export function datastoreMetaStateEmpty(initialRevision: bigint): DatastoreMetaState {
  return {
    headRevision: initialRevision,
    schemas: [],
    counters: [],
    gcFloor: 0n,
    forwardKeys: new Map<string, number>(),
    reverseKeys: new Map<string, number>(),
  };
}

/**
 * Returns the schema version effective at the given revision (the last version with
 * `revision <= atRevision`, the write-order fold), or absent if none was persisted at or before
 * it. The identical loop to `datastoreGrainStateSchemaVersionAt`, break included: it relies on
 * ascending write order, which `MetaFold`'s compaction preserves, so an out-of-order list fails
 * loudly rather than silently disagreeing with the whole-state fold.
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

/** Returns the schema hash effective at the given revision, or absent if none. */
export function datastoreMetaStateSchemaHashAt(
  state: DatastoreMetaState,
  atRevision: bigint,
): string | undefined {
  return datastoreMetaStateSchemaVersionAt(state, atRevision)?.hash;
}

/**
 * The durable layout descriptor of the CHUNKED key index (durable layout v2): the in-memory
 * `DatastoreMetaState.forwardKeys`/`reverseKeys` maps are NOT serialized into the meta row;
 * instead each direction's index is split across `bucketCount` buckets
 * (`bucket = FNV-1a-64(key) % bucketCount`, fixed at store creation - the bucket of a key is part
 * of the durable layout and must never change), persisted as write-once
 * `indexb/{version}/{dir}/{bucket}` rows (`KeyIndexBucketEntry`) rewritten one bucket per
 * direction per flush in round-robin rotation, plus per-flush `indexd/{version}` DELTA rows
 * (`KeyIndexDeltaEntry`) carrying exactly the entries that flush dirtied. Recovery reconstructs the
 * full maps as (all bucket rows at their recorded versions) overlaid with (the pending delta rows
 * in ascending version order). The meta row's size is therefore CARDINALITY-INDEPENDENT: this
 * descriptor is O(bucketCount), never O(keys).
 */
export interface KeyIndexLayout {
  /** The store's fixed bucket count. */
  readonly bucketCount: number;
  /** Per-bucket row versions for the forward direction. */
  readonly forwardBucketVersions: readonly number[];
  /** Per-bucket row versions for the reverse direction. */
  readonly reverseBucketVersions: readonly number[];
  /** The next bucket the rotation will rewrite. */
  readonly nextBucket: number;
  /** The version below which delta rows have been folded into bucket rows. */
  readonly deltaFloorVersion: number;
  /** The pending delta row versions, ascending. */
  readonly deltaVersions: readonly number[];
}

/** The bucket count of a newly created (or migrated) store. */
export const DEFAULT_BUCKET_COUNT = 256;

/**
 * The sentinel version of a bucket that has never had a row written (a young store before the
 * rotation first reaches it): recovery reads no row for it and treats it as empty.
 */
export const NO_BUCKET_ROW = 0;

/**
 * The bucket a key string belongs to: `FNV-1a-64(key) % bucketCount`. Depends only on the stable,
 * process-independent hash and the store's fixed bucket count, so the assignment is part of the
 * DURABLE contract - a changed bucket function would strand every stored bucket row.
 *
 * The C# modulo is UNSIGNED (`% (ulong)bucketCount`), so it is done in `bigint` and only then
 * narrowed: doing it in `number` would round the 64-bit hash past 2^53 first and silently reassign
 * keys to different buckets, and treating the hash as a signed int64 would yield a negative bucket.
 */
export function keyIndexLayoutBucketOf(key: string, bucketCount: number): number {
  return Number(fnv1a64(key) % BigInt(bucketCount));
}

/** A fresh layout with no bucket rows written and no pending deltas. */
export function createEmptyKeyIndexLayout(bucketCount: number): KeyIndexLayout {
  // `ArgumentOutOfRangeException.ThrowIfLessThan(bucketCount, 1)`. Without the guard `% 0n` throws
  // a RangeError from deep inside the bucket function instead, at the far end of the store's life.
  if (bucketCount < 1) {
    throw new InvalidArgumentError(
      `bucketCount ('${bucketCount}') must be greater than or equal to '1'.`,
    );
  }
  // The C# builds ONE `ImmutableArray` and passes it twice, which is safe there because it is
  // immutable. A shared JS array is not, and the rotation writes one direction at a time, so each
  // direction gets its own array.
  const none = (): number[] => new Array<number>(bucketCount).fill(NO_BUCKET_ROW);
  return {
    bucketCount,
    forwardBucketVersions: none(),
    reverseBucketVersions: none(),
    nextBucket: 0,
    deltaFloorVersion: 0,
    deltaVersions: [],
  };
}

/**
 * One durable `indexb/{version}/{dir}/{bucket}` row: the FULL current key->rowVersion entries of
 * one bucket of one direction's key index, as of the flush at `{version}`. Write-once per version
 * with the same ETag-tolerant read-then-write discipline the shard rows use (a boundary retry
 * overwrites its own crashed attempt's orphan). Entries are ABSOLUTE (each value is the key's
 * current shard-row version), which is what makes the recovery overlay idempotent.
 */
export interface KeyIndexBucketEntry {
  /** The bucket's absolute key -> row-version entries. */
  readonly entries: ReadonlyMap<string, number>;
}

/**
 * One durable `indexd/{version}` row: the key-index entries DIRTIED by the flush at `{version}`,
 * both directions. A key whose row was (re)written maps to that flush version; a key DROPPED at the
 * flush (its shard state emptied) is recorded as an explicit `KEY_INDEX_TOMBSTONE` entry -
 * replaying the delta at recovery must delete it from the reconstructed index, because the bucket
 * row still carrying it may be many rotations old. Like bucket entries, values are ABSOLUTE, so
 * overlaying deltas in ascending version order is idempotent last-wins.
 */
export interface KeyIndexDeltaEntry {
  /** The forward direction's dirtied entries. */
  readonly forwardEntries: ReadonlyMap<string, number>;
  /** The reverse direction's dirtied entries. */
  readonly reverseEntries: ReadonlyMap<string, number>;
}

/**
 * The delta-entry value marking a key REMOVED from the index at this flush. Distinct from
 * `NO_ROW_VERSION` (-1, "indexed but no durable row yet"), which never appears in a durable row.
 */
export const KEY_INDEX_TOMBSTONE = -2;

/**
 * The durable `meta/{version}` row of the thin-sequencer layout (write-once per version, like the
 * retired whole-state snapshots): the `DatastoreMetaState` as of the flush at
 * `flushedThroughLogVersion`. The version in the row key equals `flushedThroughLogVersion` (carried
 * inline too so the row is self-describing), and the durable head pointer's
 * `LogHeadEntry.snapshotVersion` names which meta row is current. Every shard row on disk is
 * complete through this log version: recovery replays only the log tail above it, seeding touched
 * keys from their stored rows.
 *
 * LAYOUT VERSIONS. Under the current (v2) layout `indexLayout` is present and `meta` is persisted
 * with EMPTY `forwardKeys`/`reverseKeys` maps - the index lives in the bucket/delta rows the layout
 * describes, making the meta row's size independent of graph cardinality. A row written by the
 * retired v1 layout carries the full maps INLINE and has NO `indexLayout` field at all (Orleans
 * deserialized the absent field as null; Thresh's codec yields `undefined`, which is what the port
 * reads) - activation detects that shape and migrates in place. The in-memory `DatastoreMetaState`
 * always holds the full maps regardless; only the durable representation changed.
 */
export interface DatastoreMetaEntry {
  /** The small state as of the flush. */
  readonly meta: DatastoreMetaState;
  /** The log version the flush was complete through (an `int` storage version). */
  readonly flushedThroughLogVersion: number;
  /** The v2 index layout, or ABSENT on a v1 row - the layout-version discriminant. */
  readonly indexLayout?: KeyIndexLayout | undefined;
}

/**
 * A mutable holder for the immutable `DatastoreMetaState`, required in C# because
 * `JournaledGrain<TState,TEvent>` mutates its state object in place via `TransitionState`, whereas
 * the small state is an immutable record. The fold replaces `value` with a new immutable state per
 * applied event.
 *
 * SETTLED BY `datastore-grain.ts`: Thresh's `JournaledGrain.transitionState(state, event)` RETURNS
 * the next state rather than mutating a holder in place, so the ported grain is a
 * `JournaledGrain<DatastoreMetaState, LogEvent>` and never constructs one of these. The type stays
 * because it is a faithful port of a source file's member, but nothing in the port depends on it.
 *
 * A mutable class rather than a readonly interface, because that mutability is the whole point of
 * the type in the source.
 */
export class DatastoreMetaHolder {
  /** The current confirmed small state. */
  value: DatastoreMetaState = datastoreMetaStateEmpty(0n);
}
