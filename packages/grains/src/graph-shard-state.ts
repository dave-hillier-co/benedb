import type { StoredRelationshipWire } from "./datastore-dtos";

/**
 * The state of one graph shard: the MVCC relationship rows of a single adjacency slice (one
 * `GraphShardKeyWire`), folded from the datastore's event log restricted to that key.
 * `appliedRevision` is the shard's watermark - the revision of the last log event folded, which
 * advances on EVERY event (matching or not), so "watermark covers the pinned revision" is the
 * closed-timestamp gate. `gcFloor` mirrors the whole state's floor: reads pinned strictly below it
 * are invalid.
 */
export interface GraphShardState {
  /** The revision of the last log event folded into this shard. */
  readonly appliedRevision: bigint;
  /** The revision below which MVCC history has been collected. */
  readonly gcFloor: bigint;
  /** The shard's rows. `ImmutableList<T>` becomes `readonly T[]`, COPIED ON WRITE. */
  readonly rows: readonly StoredRelationshipWire[];
}

/**
 * The empty shard, before any log event has been folded.
 *
 * A `static ... { get; }` singleton in the C#, which `ShardFold` copies with `state with { ... }`.
 * Ported naively that is a shared module object the fold ASSIGNS INTO, corrupting every later
 * shard from a line far from the failure - so it is FROZEN, and every `with` becomes a spread.
 * `Object.freeze` on the state does not freeze the array it points at, so `rows` is frozen in its
 * own right too, or `state.rows.push(row)` still writes through to every reader.
 */
export const GRAPH_SHARD_STATE_EMPTY: GraphShardState = Object.freeze({
  appliedRevision: 0n,
  gcFloor: 0n,
  rows: Object.freeze([]) as readonly StoredRelationshipWire[],
});
