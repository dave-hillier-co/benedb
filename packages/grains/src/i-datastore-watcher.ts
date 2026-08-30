import { defineGrainInterface } from "@thresh/core/grain-interface";

/**
 * A grain observer notified when the datastore head advances (a commit appended to the log). This
 * is the PUSH side of the Watch feed: each silo's `LogWatchHub` registers one observer so
 * cross-silo commits wake parked Watch streams without polling. Delivery is best-effort (observers
 * are non-durable client references and the set empties when the grain reactivates), so the hub
 * keeps a slow heartbeat that resubscribes and pulls the head - a missed push costs at most one
 * heartbeat of latency, never a lost event (streams always read their own diffs from the log).
 *
 * OBSERVER REFERENCES ARE AVAILABLE (correcting an earlier note in this port that claimed
 * otherwise). Orleans' `IGrainObserver` - a non-durable CLIENT REFERENCE that a grain can hold and
 * call back on - maps to `ClientNode.createObjectReference` / `deleteObjectReference` (and the same
 * pair on the `GrainFactoryAccess` a startup task is handed); `LogWatchHub` creates one and passes
 * it into `IDatastoreGrain.subscribeWatch` as an ordinary grain-call argument, and the grain calls
 * back on it through `ObserverManager`.
 *
 * ONE REAL DIFFERENCE, and it is load-bearing where the registration is refreshed: Orleans observer
 * references have VALUE equality, so `DatastoreGrain` could key its `ObserverManager` by the
 * reference itself (`Subscribe(watcher, watcher)`). Thresh references do not, so the grain keys the
 * manager by `grainReferenceIdentity(watcher).grainId` instead - without that, every heartbeat
 * resubscribe would ADD an entry rather than refresh one.
 */
export interface IDatastoreWatcher {
  /** The head advanced to `head`. One-way: the notify never blocks the commit. */
  headAdvanced(head: bigint): Promise<void>;

  /**
   * A schema change committed: `schemaBytes` is the persisted UTF-8 schema DSL and `storedHash` is
   * its stored-bytes hash (`storedSchemaHashCompute` - the same hash `DatastoreHeadWire.schemaHash`
   * carries). Pushed alongside (not instead of) the matching `headAdvanced` notify, so a watcher
   * that only cares about the head is unaffected. Schema changes are rare, so pushing the full
   * payload (rather than just the hash, forcing a fetch hop on every recipient) is cheap; one-way
   * and best-effort like `headAdvanced` - a missed push is repaired by the heartbeat backstop
   * (`LogWatchHub`), which diffs `DatastoreHeadWire.schemaHash` against the last hash it applied
   * and fetches on a mismatch.
   */
  schemaAdvanced(schemaBytes: Uint8Array, storedHash: string): Promise<void>;
}

/**
 * The runtime value for `IDatastoreWatcher`.
 *
 * Orleans' `[OneWay]` on both members DOES map cleanly, and it is the load-bearing half of the
 * contract: a two-way notify would put every commit's latency at the mercy of every registered
 * watcher.
 */
export const IDatastoreWatcher = defineGrainInterface<IDatastoreWatcher>("IDatastoreWatcher", {
  options: {
    headAdvanced: { oneWay: true },
    schemaAdvanced: { oneWay: true },
  },
});
