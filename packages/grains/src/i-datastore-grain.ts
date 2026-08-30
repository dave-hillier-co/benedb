import { defineGrainInterface } from "@thresh/core/grain-interface";
import type { GrainWithIntegerKey } from "@thresh/core/key-kinds";

import type { CommitReply, CommitRequest } from "./commit-contract";
import type { DatastoreHeadWire } from "./datastore-dtos";
import type { DatastoreGrainState } from "./datastore-grain-state";
import type { GraphShardKeyWire } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import type { IDatastoreWatcher } from "./i-datastore-watcher";
import type { IDatastoreLog } from "./log-event";

/**
 * The fixed key of the single datastore activation.
 *
 * The C#'s `public const long Key = 0` has no counterpart on a TypeScript interface, so it folds to
 * a module constant per the static-class rule. `GrainWithIntegerKey`'s key type is BIGINT in
 * Thresh, hence `0n`. Unlike `RELATIONSHIPS_GRAIN_KEY` this key IS an identity: one activation
 * cluster-wide is what makes the revision it mints the cluster-wide serialization point.
 */
export const DATASTORE_GRAIN_KEY = 0n;

/**
 * The cluster-singleton datastore grain: the single source of truth for all
 * relationship/schema/counter state. It is an EVENT-SOURCED grain - the append-only log of
 * `LogEvent`s is the source of truth, and the materialized `DatastoreGrainState` is the fold over
 * that log. It is keyed by the constant integer `DATASTORE_GRAIN_KEY` so every silo routes to the
 * ONE activation (single-activation virtual actor), which makes multi-silo reads correct with zero
 * replica lag, and makes the revision the grain mints the cluster-wide serialization point. Writes
 * are cheap appends.
 */
export interface IDatastoreGrain extends GrainWithIntegerKey, IDatastoreLog {
  /**
   * Returns the full committed state, ASSEMBLED on demand for the admin plane (the scan seam, the
   * compatibility ReadWriteTx write base, the equivalence gates): under the thin-sequencer layout
   * the grain no longer materializes the whole fold, so this call rebuilds it from the small state
   * plus every indexed forward key's current shard state (dirty overlay winning per key). Semantics
   * are identical to the retired materialized fold; the cost is O(graph) storage reads and transfer
   * PER CALL - never use it on the per-Check hot path (that reads through `readShard` / the shard
   * mesh). `alwaysInterleave` - see the remark on `commit` - never `readOnly`, which would not
   * interleave against the non-read-only `commit`.
   */
  readState(): Promise<DatastoreGrainState>;

  /**
   * Returns the head revision and schema hash without shipping the whole state blob.
   * `alwaysInterleave` - see the remark on `commit`.
   */
  getHead(): Promise<DatastoreHeadWire>;

  /**
   * Returns the schema bytes effective at the given revision - the last persisted version with
   * `revision <= revision` (exactly the in-memory `DatastoreState.schemaAt` fold), or `undefined`
   * when no schema was persisted at or before it (the seed-only window, a legitimate state and not
   * a failure). This is the schema-at-revision read of the graph-sharded design's `ISchemaSource`
   * seam: resolvers hit it only on a per-silo schema-hash cache miss, so the hop is once per hash
   * per silo. `alwaysInterleave` - a pure read over the confirmed fold, interleaving exactly like
   * `readState`; never `readOnly`, which would not interleave past the non-read-only `commit`.
   */
  readSchemaAt(revision: bigint): Promise<Uint8Array | undefined>;

  /**
   * The once-per-shard hydration read: the current per-key slice for `key`, served WITHOUT any
   * whole-state scan - the sequencer's dirty-buffer entry when the key was touched since its last
   * flush, otherwise the key's durable shard row relabeled to the current head (sound because any
   * touching event would have dirtied the key - the sharding fact), otherwise empty-at-head. The
   * reply's `appliedRevision` is the CURRENT head and its `gcFloor` the current floor (applied to
   * the rows) - a shard hydrated from this snapshot is exactly the per-key fold at that head (the
   * sharding lemma). `alwaysInterleave` - a pure read, interleaving exactly like `readState`; never
   * `readOnly`, which would not interleave past the non-read-only `commit` (the lesson documented
   * on `IDatastoreLog.readFrom`).
   */
  readShard(key: GraphShardKeyWire): Promise<GraphShardState>;

  /**
   * Executes a declarative `CommitRequest` INSIDE the sequencer
   * (`docs/graph-sharded-datastore.md` section 3): the single-threaded, non-reentrant activation
   * evaluates preconditions, applies the mutations through the MVCC transaction over its own fold
   * at head, mints the authoritative (timestamp) revision and appends the resulting canonical
   * `LogEvent` (an append to durable grain storage, confirmed before the reply) - so a declarative
   * commit (absent `CommitRequest.expectedHead`) needs no caller retry loop. WRITES carry no
   * interleave option, so they never interleave EACH OTHER: the head read at the top of the call
   * and the append at the bottom stay atomic with respect to all other writes, which is both why
   * the head cannot move under a declarative commit and why the caller-evaluated CAS of the lambda
   * compatibility path (the optional `expectedHead` compare) is exact. Rejections are returned as
   * STRUCTURED REPLY DATA (`CommitReply.failure`), never as serialized exceptions, so the client
   * rethrows its existing typed exceptions unchanged. Only the explicitly `alwaysInterleave`-marked
   * pure reads (this interface's `readState`/`getHead`/`readSchemaAt`/`readShard`, and
   * `IDatastoreLog.readFrom`) may run DURING an await inside this call - the activation's scheduler
   * is still single-threaded, so an interleaved read only ever runs while this call itself is
   * parked at an await, never concurrently with its own execution.
   */
  commit(request: CommitRequest): Promise<CommitReply>;

  /**
   * Registers (or refreshes) a head-advance observer and returns the current head, so one call
   * serves as the subscription heartbeat AND the fallback head read: a subscriber that missed a
   * push still observes the head it missed, and a subscriber dropped by grain reactivation is
   * re-registered. Registration expires if not refreshed (observers are best-effort, non-durable
   * client references).
   *
   * The `watcher` is an observer REFERENCE minted by `createObjectReference` (see
   * `i-datastore-watcher.ts`). Thresh references have no value equality, so the grain keys its
   * `ObserverManager` by the reference's grain id rather than by the reference itself.
   */
  subscribeWatch(watcher: IDatastoreWatcher): Promise<DatastoreHeadWire>;

  /**
   * Removes a head-advance observer (best-effort; expiry would remove it anyway). Keyed by the
   * reference's grain id, like `subscribeWatch`.
   */
  unsubscribeWatch(watcher: IDatastoreWatcher): Promise<void>;

  /**
   * Runs one round of MVCC garbage collection: computes a floor (bounded by the configured GC
   * window, never above the current head), and - if it advances the floor already recorded -
   * appends a GC `LogEvent` that collects history below it. This is both the reminder's periodic
   * body and a directly callable test seam. Returns the new floor, or `undefined` if no collection
   * was needed (the computed floor did not advance the current one). `0n` is a LEGAL floor, so a
   * falsy check on the result would report a genuine collection to revision 0 as no collection.
   */
  runGc(): Promise<bigint | undefined>;
}

/**
 * The runtime value for `IDatastoreGrain`.
 *
 * THE OPTIONS MAP IS THE MOST FRAGILE THING IN THIS FILE. Five methods carry `[AlwaysInterleave]`
 * in the C#: `readState`, `getHead`, `readSchemaAt`, `readShard` and `readFrom` - the last declared
 * on `IDatastoreLog` and INHERITED. Thresh's per-method options live on the CONCRETE
 * `GrainInterface` value and are NOT inherited from an extended interface, so `readFrom` must be
 * REPEATED here. A dropped flag on any of the five parks a Watch stream or a shard hydration behind
 * an in-flight commit - a deadlock or a timeout storm that no unit test would show.
 *
 * Equally: never add an option to `commit`, whose non-interleaving is what makes the
 * head-read-and-append atomic and the `expectedHead` CAS exact. `subscribeWatch`,
 * `unsubscribeWatch` and `runGc` likewise carry nothing. And never `readOnly` anywhere: it
 * interleaves only when BOTH the blocking and the incoming turn are read-only, so it would not get
 * past the non-read-only `commit`.
 */
export const IDatastoreGrain = defineGrainInterface<IDatastoreGrain>("IDatastoreGrain", {
  options: {
    readState: { alwaysInterleave: true },
    getHead: { alwaysInterleave: true },
    readSchemaAt: { alwaysInterleave: true },
    readShard: { alwaysInterleave: true },
    readFrom: { alwaysInterleave: true },
  },
});
