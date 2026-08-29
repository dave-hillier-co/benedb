import type { FullRelationshipsFilterWire, SchemaVersionWire } from "./datastore-dtos";
import type { RelationshipUpdateWire } from "./relationships-dtos";

// Mutually recursive with `datastore-dtos.ts`; see the note there. Three types plus one grain
// interface FRAGMENT.

/**
 * A counter change at a revision. An ABSENT `filter` is a tombstone (the counter was unregistered
 * at this revision); otherwise it is the (re)registered filter.
 */
export interface CounterDeltaWire {
  /** The counter's name. */
  readonly name: string;
  /** The (re)registered filter, or absent for a tombstone. */
  readonly filter?: FullRelationshipsFilterWire | undefined;
}

/**
 * One entry in the datastore's append-only event log: everything that changed at a single
 * committed revision. The revision IS the log offset (the global order); folding the ordered
 * sequence of `LogEvent`s reproduces the datastore state, and the same feed powers Watch and the
 * graph shard grains' log-tail folds.
 *
 * The event is SELF-CONTAINED / FOLDABLE: every payload needed to reproduce the committed state is
 * carried inline. `relationshipChanges` carry full relationship payloads, `schemaChange` carries
 * the new schema version (revision + bytes + hash; absent = no schema change), and
 * `counterChanges` carry name + filter (absent filter = tombstone). A consumer can fold the
 * ordered event sequence from empty without any side state.
 */
export interface LogEvent {
  /** The committed revision this event was minted at (= the log offset). */
  readonly revision: bigint;
  /** The relationship changes; always empty on a GC event. */
  readonly relationshipChanges: readonly RelationshipUpdateWire[];
  /** The new schema version, or absent for no schema change; always absent on a GC event. */
  readonly schemaChange?: SchemaVersionWire | undefined;
  /** The counter deltas; always empty on a GC event. */
  readonly counterChanges: readonly CounterDeltaWire[];
  /**
   * PRESENT marks this a GC event (minted by the datastore grain's own janitor, never by a client
   * proposal): folding it applies `collectBelow(gcFloor)` to the memory-space state INSTEAD of
   * replaying the changes above (which are always empty/absent on a GC event), then advances the
   * head to `revision` as usual.
   *
   * The GC DISCRIMINANT for all three folds, so ABSENT - never `0n`, never `null` - has to mean
   * "not a GC event". 0 is a LEGAL floor (the floor of a store that has collected nothing), so a
   * port that defaults the absent case to `0n` turns every ordinary commit into a GC event that
   * replays no changes at all.
   */
  readonly gcFloor?: bigint | undefined;
}

/** A bounded page of the event log, plus the head revision observed at read time. */
export interface LogSegment {
  /** The events, in ascending revision order. */
  readonly events: readonly LogEvent[];
  /** The head revision observed when the page was read. */
  readonly headRevision: bigint;
}

/**
 * The read side of the datastore's event log: an ordered feed of committed changes by revision (=
 * the global offset), consumed by the graph shard grains' log-tail folds and the Watch API.
 *
 * A grain-interface FRAGMENT that `IDatastoreGrain` inherits, not a grain interface in its own
 * right - so it gets no `defineGrainInterface` value here. Thresh's per-method invocation options
 * live on the CONCRETE `GrainInterface` value and are NOT inherited, so the `[AlwaysInterleave]`
 * below must be repeated in `IDatastoreGrain`'s own options map; a dropped `alwaysInterleave`
 * deadlocks Watch behind a commit, and no unit test would show it.
 */
export interface IDatastoreLog {
  /**
   * Returns up to `maxCount` change-bearing events whose revision is strictly greater than
   * `afterRevision`, in ascending revision order, plus the current head revision. Throws
   * `RevisionNotFoundException` if `afterRevision` is older than the retained GC window.
   *
   * VERIFIED Orleans 10.1 semantics, carried across because the same trap applies to Thresh's
   * `InvokeMethodOptions`, which has both `readOnly` and `alwaysInterleave`: do NOT swap this for
   * `readOnly` - that option only interleaves a blocking request when BOTH the blocking request
   * and the incoming one are read-only, so it does nothing here, since `commit` carries no such
   * option. `alwaysInterleave`, declared on the grain-INTERFACE method, interleaves with anything:
   * while an in-flight write is parked at an await on the single-threaded activation scheduler, an
   * interleaved call to this method runs to completion in that gap before the write's turn
   * resumes. Only pure reads carry it; mutating members never do, so writes still never interleave
   * writes and the `commit` head-read-and-append stays atomic.
   */
  readFrom(afterRevision: bigint, maxCount: number): Promise<LogSegment>;
}
