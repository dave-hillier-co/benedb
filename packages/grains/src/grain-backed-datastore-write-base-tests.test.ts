import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { CreateRelationshipExistsException } from "@spacedb/datastore/datastore-exceptions";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainKeyFor } from "@thresh/core/key-kinds";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import type { CommitReply, CommitRequest } from "./commit-contract";
import type { DatastoreHeadWire } from "./datastore-dtos";
import {
  datastoreGrainStateEmpty,
  datastoreGrainStateSchemaHashAt,
  datastoreGrainStateSchemaVersionAt,
  type DatastoreGrainState,
} from "./datastore-grain-state";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import type { GraphShardKeyWire } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import type { IDatastoreGrain } from "./i-datastore-grain";
import type { IDatastoreWatcher } from "./i-datastore-watcher";
import type { LogEvent, LogSegment } from "./log-event";
import { eventFromProposal, logFoldApplyEvent } from "./log-fold";
import { LogWatchHub } from "./log-watch-hub";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/GrainBackedDatastoreWriteBaseTests.cs`.
 *
 * Gates for `GrainBackedDatastore.readWriteTx`'s COMPATIBILITY write path: each attempt derives its
 * write base (and its `expectedHead` CAS) from ONE per-attempt `IDatastoreGrain.readState` fetch -
 * the documented per-write full-state cost this path accepts because production writes are
 * declarative through `IDatastoreGrain.commit` and only tests/BulkImport/SeedData drive this lambda
 * shape. Driven against a hand-rolled in-process `IDatastoreGrain` fake (no cluster at all) that
 * counts every grain-interface call, reusing the same `logFold` the real `DatastoreGrain` folds
 * through, so the fake's CAS/fold semantics are provably the same shape as production.
 *
 * Port decisions:
 *   * `IGrainFactory` -> Thresh's `GrainFactoryAccess`. The C# fake implements the whole factory
 *     surface with `NotSupportedException` everywhere but the integer-key `GetGrain`; the Thresh
 *     surface is three members, so the fake keeps `getGrain` and leaves the two observer members
 *     throwing - the hub built here is never started, so neither is ever reached.
 *   * `lock` collapses: JavaScript is single-threaded and every fake body between the awaits is
 *     synchronous, so each is already atomic. `Interlocked.Increment` on the barrier counter is a
 *     plain `+= 1` for the same reason.
 *   * The fake's revision mint samples `Date.now()` scaled to nanoseconds (JavaScript has no
 *     epoch-nanosecond clock), so commits inside one millisecond separate through the `head + 1n`
 *     branch far more often than the C#'s 100ns ticks do. Still monotonic, which is all these
 *     tests need.
 */

function rel(rid: string, sid: string): Relationship {
  const resource: ObjectAndRelation = { objectType: "doc", objectId: rid, relation: "viewer" };
  const subject: ObjectAndRelation = { objectType: "user", objectId: sid, relation: ELLIPSIS };
  return createRelationship(resource, subject);
}

function create(relationship: Relationship): RelationshipUpdate {
  return { relationship, operation: "create" };
}

/**
 * A minimal in-process `IDatastoreGrain` that owns the append-only log and counts every interface
 * call, so the write-path tests can assert exactly which grain calls happen. Reuses the real log
 * fold (proposal-to-event and fold) so its CAS/state semantics track the production
 * `DatastoreGrain`.
 */
class CountingFakeGrain implements IDatastoreGrain {
  #state: DatastoreGrainState = datastoreGrainStateEmpty(0n);
  readonly #events: LogEvent[] = [];

  readStateCalls = 0;
  getHeadCalls = 0;
  commitCalls = 0;
  readFromCalls = 0;

  /**
   * Test-only rendezvous hook, awaited before every `commit` call applies. Used by
   * `racingWrites_loserRetries_fromAFreshBase_andBothLand` to force two concurrent `readWriteTx`
   * calls to genuinely race - both requests built from pre-commit bases - rather than one running
   * this in-process fake to completion before the other starts. Absent (the default) is a no-op.
   */
  onCommit?: (() => Promise<void>) | undefined;

  readState(): Promise<DatastoreGrainState> {
    this.readStateCalls += 1;
    return Promise.resolve(this.#state);
  }

  getHead(): Promise<DatastoreHeadWire> {
    this.getHeadCalls += 1;
    return Promise.resolve({
      head: this.#state.headRevision,
      schemaHash: datastoreGrainStateSchemaHashAt(this.#state, this.#state.headRevision),
      gcFloor: this.#state.gcFloor,
    });
  }

  /**
   * The compatibility-path slice of the real grain's commit: the `expectedHead` CAS plus the log
   * fold append. Sufficient here because `readWriteTx` only ever sends the already-resolved net
   * diff (no preconditions, no delete-by-filter, always an `expectedHead`), with every guarded
   * operation evaluated client-side by the lambda.
   */
  async commit(request: CommitRequest): Promise<CommitReply> {
    if (this.onCommit !== undefined) await this.onCommit();

    this.commitCalls += 1;
    if (request.expectedHead !== undefined && this.#state.headRevision !== request.expectedHead) {
      return {
        failure: { kind: "headMoved", detail: "head moved" },
        deletedCount: 0n,
        reachedLimit: false,
      };
    }

    const now = BigInt(Date.now()) * 1_000_000n;
    const head = this.#state.headRevision;
    const newRevision = now > head ? now : head + 1n;
    const ev = eventFromProposal(
      {
        relationshipChanges: request.updates,
        schemaBytes: request.schemaBytes,
        counterChanges: request.counterChanges,
      },
      newRevision,
    );
    this.#events.push(ev);
    this.#state = logFoldApplyEvent(this.#state, ev);
    return { revision: newRevision, deletedCount: 0n, reachedLimit: false };
  }

  readFrom(afterRevision: bigint, maxCount: number): Promise<LogSegment> {
    this.readFromCalls += 1;
    const head = this.#state.headRevision;
    const page = this.#events
      .filter((e) => e.revision > afterRevision)
      .sort((a, b) => (a.revision < b.revision ? -1 : a.revision > b.revision ? 1 : 0))
      .slice(0, maxCount < 0 ? this.#events.length : maxCount);
    return Promise.resolve({ events: page, headRevision: head });
  }

  subscribeWatch(_watcher: IDatastoreWatcher): Promise<DatastoreHeadWire> {
    return this.getHead();
  }

  unsubscribeWatch(_watcher: IDatastoreWatcher): Promise<void> {
    return Promise.resolve();
  }

  runGc(): Promise<bigint | undefined> {
    return Promise.resolve(undefined);
  }

  /** The write path under test never hydrates shards; a call here would be a routing bug. */
  readShard(_key: GraphShardKeyWire): Promise<GraphShardState> {
    throw new Error("not supported");
  }

  readSchemaAt(revision: bigint): Promise<Uint8Array | undefined> {
    return Promise.resolve(datastoreGrainStateSchemaVersionAt(this.#state, revision)?.bytes);
  }
}

/** A grain factory that hands back one fixed grain instance for every lookup. */
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

function newDatastore(): { datastore: GrainBackedDatastore; grain: CountingFakeGrain } {
  const grain = new CountingFakeGrain();
  const factory = new SingleGrainFactory(grain);
  // A real hub instance (never started - these tests never call watch); pulse on commit is a pure
  // in-memory signal, so no observer registration or heartbeat is involved.
  const datastore = new GrainBackedDatastore(factory, new LogWatchHub(grain, factory));
  return { datastore, grain };
}

describe("GrainBackedDatastoreWriteBaseTests", () => {
  it("sequentialWrites_performExactlyOneReadStatePerAttempt", async () => {
    const { datastore, grain } = newDatastore();

    for (let i = 0; i < 5; i++) {
      const id = String(i);
      await datastore.readWriteTx((tx) => tx.writeRelationships([create(rel(id, "alice"))]));
    }

    // One base fetch per (non-retried) attempt, and nothing else: no separate head probe (the base
    // state's own headRevision is the CAS expectedHead, keeping base and CAS exactly in agreement).
    expect(grain.readStateCalls).toBe(5);
    expect(grain.getHeadCalls).toBe(0);
    expect(grain.commitCalls).toBe(5);
  });

  it("racingWrites_loserRetries_fromAFreshBase_andBothLand", async () => {
    const { datastore, grain } = newDatastore();

    // Force a genuine race: both writers' FIRST commit rendezvous here (a 2-party barrier), so both
    // requests were built from bases that predate EITHER commit - guaranteeing exactly one loses
    // the CAS. A retry's later commit arrives after the barrier has opened, so it passes straight
    // through.
    let arrivals = 0;
    let openBarrier!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      openBarrier = resolve;
    });
    grain.onCommit = () => {
      arrivals += 1;
      if (arrivals >= 2) openBarrier();
      return bothArrived;
    };

    const t1 = datastore.readWriteTx((tx) => tx.writeRelationships([create(rel("a", "alice"))]));
    const t2 = datastore.readWriteTx((tx) => tx.writeRelationships([create(rel("b", "bob"))]));
    await Promise.all([t1, t2]);

    // Exactly one commit attempt lost the CAS and retried (2 that raced + 1 retry); the retry
    // re-fetched a FRESH base (2 first attempts + 1 retry = 3 readState calls), so its lambda
    // re-evaluated against the winner's committed state - race-free by construction.
    expect(grain.commitCalls).toBe(3);
    expect(grain.readStateCalls).toBe(3);

    const head = await datastore.headRevision();
    const reader = datastore.snapshotReader(head.revision);
    const live = new Set<string>();
    for await (const r of reader.queryRelationships({})) live.add(r.reference.resource.objectId);
    expect(live).toEqual(new Set(["a", "b"]));
  });

  /**
   * Read-your-writes across sequential `readWriteTx` calls on the same instance: the second write's
   * precondition (create-conflict on an already-live key) must see the first write's row through
   * its per-attempt base fetch (the grain confirms the new head before commit returns, so the next
   * attempt's readState observes it). This isolates against the fake the property the fidelity
   * suite proves end-to-end against the real grain, so it fails loudly if the write base ever goes
   * stale.
   */
  it("secondWrite_seesFirstWrites_createConflict", async () => {
    const { datastore } = newDatastore();
    const a = rel("a", "alice");

    await datastore.readWriteTx((tx) => tx.writeRelationships([create(a)]));

    await expect(datastore.readWriteTx((tx) => tx.writeRelationships([create(a)]))).rejects.toThrow(
      CreateRelationshipExistsException,
    );
  });
});
