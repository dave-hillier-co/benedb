import { describe, expect, it } from "vitest";

import { TimestampRevision } from "@benedb/core/timestamp-revision";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainKeyFor } from "@thresh/core/key-kinds";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import type { CommitReply } from "./commit-contract";
import type { DatastoreHeadWire } from "./datastore-dtos";
import { datastoreGrainStateEmpty, type DatastoreGrainState } from "./datastore-grain-state";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import type { GraphShardState } from "./graph-shard-state";
import type { IDatastoreGrain } from "./i-datastore-grain";
import type { LogSegment } from "./log-event";
import { LogWatchHub } from "./log-watch-hub";

/**
 * `DeferredReader.Inner` is `_inner ??= await acquire(ct)` in the C#, which assigns ONLY on
 * success: a throwing acquisition leaves `_inner` null, releases the gate, and the NEXT query on
 * that reader re-attempts. Memoising the in-flight promise instead caches the rejection for the
 * reader's whole life.
 *
 * That matters because `snapshotReader`'s own contract is "pin one reader per operation and query
 * it many times" - BulkExport paging and the fold-equivalence oracle both do - so one transient
 * failure of the singleton `DatastoreGrain` (mid-reactivation, a call timeout, a rejected call
 * during membership churn) would poison every later read on a reader the C# recovers.
 */
class FlakyGrain implements IDatastoreGrain {
  readStateCalls = 0;
  #state: DatastoreGrainState = datastoreGrainStateEmpty(0n);

  /** Rejects the first `readState`, then serves normally - a transient grain failure. */
  readState(): Promise<DatastoreGrainState> {
    this.readStateCalls += 1;
    if (this.readStateCalls === 1) {
      return Promise.reject(new Error("transient grain failure"));
    }
    return Promise.resolve(this.#state);
  }

  getHead(): Promise<DatastoreHeadWire> {
    return Promise.resolve({ head: 0n, schemaHash: undefined, gcFloor: 0n });
  }

  // The rest of the interface is unreachable from `snapshotReader`; a throw is louder than a
  // plausible-looking default if this fake is ever reused for something it does not model.
  readSchemaAt(): Promise<Uint8Array | undefined> {
    throw new Error("not used by this test");
  }
  readShard(): Promise<GraphShardState> {
    throw new Error("not used by this test");
  }
  commit(): Promise<CommitReply> {
    throw new Error("not used by this test");
  }
  subscribeWatch(): Promise<DatastoreHeadWire> {
    throw new Error("not used by this test");
  }
  unsubscribeWatch(): Promise<void> {
    throw new Error("not used by this test");
  }
  runGc(): Promise<bigint | undefined> {
    throw new Error("not used by this test");
  }
  readFrom(): Promise<LogSegment> {
    throw new Error("not used by this test");
  }
}

class SingleGrainFactory implements GrainFactoryAccess {
  constructor(private readonly grain: IDatastoreGrain) {}
  getGrain<T>(_def: GrainInterface<T>, _key: GrainKeyFor<T>): T {
    return this.grain as unknown as T;
  }
  createObjectReference<T>(_def: GrainInterface<T>, _obj: object): T {
    throw new Error("not supported");
  }
  deleteObjectReference(_ref: object): void {
    throw new Error("not supported");
  }
}

describe("DeferredReader acquisition retry", () => {
  it("retries the acquisition after a failure instead of caching the rejection", async () => {
    const grain = new FlakyGrain();
    const datastore = new GrainBackedDatastore(
      new SingleGrainFactory(grain),
      new LogWatchHub(grain, new SingleGrainFactory(grain)),
    );

    const reader = datastore.snapshotReader(new TimestampRevision(0n));

    const first = await reader.readStoredSchema().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toContain("transient grain failure");

    // The C# recovers here; a cached rejected promise re-throws the stale first error forever.
    await expect(reader.readStoredSchema()).resolves.toBeUndefined();
    expect(grain.readStateCalls).toBe(2);
  });
});
