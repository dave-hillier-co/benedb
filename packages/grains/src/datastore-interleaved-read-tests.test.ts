import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { GrainId } from "@thresh/core/grain-id";
import type { GrainStorage, StateHolder } from "@thresh/core/grain-storage";
import { grainReferenceIdentity } from "@thresh/core/grain-reference";
import { IManagementGrain } from "@thresh/core/management-grain";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { TestCluster } from "@thresh/testing/test-cluster";
import { describe, expect, it } from "vitest";

import type { CommitRequest } from "./commit-contract";
import type { LogHeadEntry } from "./datastore-dtos";
import { DatastoreGrain } from "./datastore-grain";
import { graphShardKeyForResource } from "./graph-shard-key";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { toWire } from "./wire-convert";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/DatastoreInterleavedReadTests.cs`.
 *
 * Grain-level gates for interleaving pure reads (`getHead`, `readState`, `readFrom`) past an
 * in-flight `commit` on the cluster-singleton `DatastoreGrain`. Drives the REAL grain through a
 * Thresh {@link TestCluster}, with the `datastore` storage provider wrapped by
 * {@link PausableGrainStorage} so a write can be parked mid-flight (at the `head` write, or at a
 * `log/{n}` write) while a read is issued concurrently.
 *
 * Port decisions:
 *
 *  1. `IGrainStorage.ReadStateAsync/WriteStateAsync/ClearStateAsync` -> Thresh's
 *     `GrainStorage.read/write/clear`, same `(stateName, grainId, state)` shape plus an optional
 *     ambient `AbortSignal` which the decorator forwards untouched. READS stay ungated, exactly as
 *     in the C#: only the write path is under test.
 *  2. The C#'s keyed-DI swap (`AddMemoryGrainStorage("datastore-inner")` + a keyed
 *     `IGrainStorage` override for `"datastore"`) collapses: Thresh has no keyed DI, so the test
 *     constructs the decorator over a `MemoryGrainStorage` directly and hands it to the grain
 *     through a `GrainActivator`. The "force the binary serializer" half of that registration has
 *     no counterpart either - `MemoryGrainStorage` round-trips through `structuredClone`, which
 *     preserves `Uint8Array`, `Map` and `bigint` exactly.
 *  3. The static `Gate` stays a MODULE-LEVEL handle rather than becoming per-instance state. In
 *     xunit it was safe only because `MeshClusterCollection` serialized every cluster-using class;
 *     under vitest each test FILE gets its own module registry, so this is already file-local state
 *     - see `mesh-cluster-collection.ts` for the decision this depends on. Cases within the file
 *     still run sequentially (vitest does not run cases of one file in parallel), which is what the
 *     gate needs.
 *  4. `TaskCompletionSource<bool>` -> a deferred promise; `Task.WaitAsync(timeout)` -> an explicit
 *     timeout race that CLEARS its timer, so no case leaves a dangling handle behind.
 *  5. `((GrainReference)grain).GrainId` -> `grainReferenceIdentity(grain).grainId`, Thresh's
 *     reference-identity accessor.
 *
 * The 5s {@link TIMEOUT} is load-bearing: a non-interleaving read queues behind the parked write
 * and the assertion times out. Do not raise it to make a slow port pass.
 */

const TIMEOUT_MS = 5_000;

function rel(rid: string, sid: string): Relationship {
  const resource: ObjectAndRelation = { objectType: "doc", objectId: rid, relation: "viewer" };
  const subject: ObjectAndRelation = { objectType: "user", objectId: sid, relation: ELLIPSIS };
  return createRelationship(resource, subject);
}

/**
 * A compatibility-shape commit (expectedHead CAS, one resolved Touch, nothing else) - the same wire
 * request `GrainBackedDatastore.readWriteTx` submits, so these gates exercise exactly the
 * CAS-carrying write turn the production write path parks on.
 */
function touchCommit(rid: string, sid: string, expectedHead: bigint): CommitRequest {
  return {
    preconditions: [],
    updates: [{ operation: "touch", relationship: toWire(rel(rid, sid)) }],
    deleteByFilter: undefined,
    schemaBytes: undefined,
    expectedSchemaHash: undefined,
    counterChanges: [],
    expectedHead,
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

/**
 * `Task.WaitAsync(TimeSpan)`: rejects if `promise` has not settled within `TIMEOUT_MS`, and always
 * clears its timer.
 */
async function waitAsync<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${TIMEOUT_MS}ms waiting for ${what}`)),
      TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `Task.WhenAny(work, Task.Delay(Timeout))`: which of the two won, without throwing. */
async function raceTimeout(work: Promise<unknown>): Promise<"work" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
  });
  try {
    return await Promise.race([work.then(() => "work" as const), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * File-scoped gate state consulted by {@link PausableGrainStorage}. See port decision 3 above for
 * why a module-level handle is safe here.
 */
const gate: {
  headWriteBlock: Deferred | undefined;
  headWriteParked: Deferred | undefined;
  logWriteBlock: Deferred | undefined;
  logWriteParked: Deferred | undefined;
  throwOnceOnHeadWrite: boolean;
} = {
  headWriteBlock: undefined,
  headWriteParked: undefined,
  logWriteBlock: undefined,
  logWriteParked: undefined,
  throwOnceOnHeadWrite: false,
};

function resetGate(): void {
  gate.headWriteBlock = undefined;
  gate.headWriteParked = undefined;
  gate.logWriteBlock = undefined;
  gate.logWriteParked = undefined;
  gate.throwOnceOnHeadWrite = false;
}

/**
 * Wraps the in-memory grain-storage provider so a test can park a `head` or `log/{n}` write
 * mid-flight (an await that only resumes once the test releases the corresponding gate deferred),
 * or make the next `head` write throw once. Reads are never gated - only the write path is under
 * test here.
 */
class PausableGrainStorage implements GrainStorage {
  constructor(private readonly inner: GrainStorage) {}

  read<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inner.read(stateName, grainId, state, signal);
  }

  async write<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (stateName === "head") {
      if (gate.throwOnceOnHeadWrite) {
        gate.throwOnceOnHeadWrite = false;
        throw new Error("injected head-write failure (test seam)");
      }

      const headGate = gate.headWriteBlock;
      if (headGate !== undefined) {
        gate.headWriteParked?.resolve();
        await headGate.promise;
      }
    } else if (stateName.startsWith("log/") && gate.logWriteBlock !== undefined) {
      const logGate = gate.logWriteBlock;
      gate.logWriteParked?.resolve();
      await logGate.promise;
    }

    await this.inner.write(stateName, grainId, state, signal);
  }

  clear<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inner.clear(stateName, grainId, state, signal);
  }
}

interface Fixture {
  readonly cluster: TestCluster;
  readonly storage: PausableGrainStorage;
}

async function newCluster(): Promise<Fixture> {
  resetGate();
  const storage = new PausableGrainStorage(new MemoryGrainStorage());
  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: [{ ctor: DatastoreGrain, interfaces: [IDatastoreGrain] }],
    configureSilo: (builder) => {
      builder.addStorage("datastore", storage);
      builder.useGrainActivator({
        createInstance: (ctor) =>
          ctor === (DatastoreGrain as unknown as new () => DatastoreGrain)
            ? new DatastoreGrain({ storage })
            : new ctor(),
      });
    },
  });
  return { cluster, storage };
}

function grain(cluster: TestCluster): IDatastoreGrain {
  return cluster.primary.host.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
}

async function withCluster(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await newCluster();
  try {
    await body(fixture);
  } finally {
    await fixture.cluster.dispose();
  }
}

describe("DatastoreInterleavedReadTests", () => {
  /**
   * Gate 1: with a write parked at the `head` storage write (the commit point), `getHead` and
   * `readFrom` must still complete promptly - proving the pure reads interleave past the blocking
   * write turn rather than queuing behind it on the non-reentrant activation. MUST FAIL on a grain
   * whose interface options drop `alwaysInterleave` (reads queue behind the parked write and the
   * assertion times out) - verified red before adding it in the C#, green after. If this passes
   * trivially in the port, the interleaving has not actually been proved.
   */
  it("Reads_complete_while_a_write_is_parked", async () => {
    await withCluster(async ({ cluster }) => {
      const target = grain(cluster);
      const oldHead = (await target.getHead()).head;

      gate.headWriteBlock = deferred();
      gate.headWriteParked = deferred();

      const appendTask = target.commit(touchCommit("a", "alice", oldHead));
      try {
        await waitAsync(gate.headWriteParked.promise, "the head write to park");

        const headTask = target.getHead();
        const readTask = target.readFrom(oldHead, -1);
        const combined = Promise.all([headTask, readTask]);

        expect(await raceTimeout(combined)).toBe("work");
      } finally {
        gate.headWriteBlock.resolve();
        await appendTask;
      }
    });
  });

  /**
   * Gate 2: a write parked mid-flight must never be observable by an interleaved reader - neither
   * at the `head` write (log entries already durable) nor at a `log/{n}` write (nothing durable yet
   * for this commit). Once the write completes, the event and the advanced head become visible
   * together (one consistent publication).
   */
  it("Parked_write_is_invisible_until_the_head_commit", async () => {
    await withCluster(async ({ cluster }) => {
      const target = grain(cluster);
      const oldHead = (await target.getHead()).head;

      // Phase 1: park at the head write itself.
      gate.headWriteBlock = deferred();
      gate.headWriteParked = deferred();
      const append1 = target.commit(touchCommit("a", "alice", oldHead));
      let newHead1: bigint | undefined;
      try {
        await waitAsync(gate.headWriteParked.promise, "the head write to park");

        const segmentDuringPark = await waitAsync(
          target.readFrom(oldHead, -1),
          "readFrom during the head park",
        );
        expect(segmentDuringPark.events).toHaveLength(0);
        expect(segmentDuringPark.headRevision).toBe(oldHead);

        const headDuringPark = await waitAsync(target.getHead(), "getHead during the head park");
        expect(headDuringPark.head).toBe(oldHead);
      } finally {
        gate.headWriteBlock.resolve();
        newHead1 = (await append1).revision;
      }

      expect(newHead1).toBeDefined();
      const segmentAfterCommit = await target.readFrom(oldHead, -1);
      expect(segmentAfterCommit.events).toHaveLength(1);
      expect(segmentAfterCommit.events[0]!.revision).toBe(newHead1);
      expect(segmentAfterCommit.headRevision).toBe(newHead1);

      // Phase 2: repeat, this time parking at the log-entry write (nothing durable for this commit
      // yet).
      gate.headWriteBlock = undefined;
      gate.headWriteParked = undefined;
      gate.logWriteBlock = deferred();
      gate.logWriteParked = deferred();
      const append2 = target.commit(touchCommit("b", "bob", newHead1!));
      let newHead2: bigint | undefined;
      try {
        await waitAsync(gate.logWriteParked.promise, "the log write to park");

        const segmentDuringLogPark = await waitAsync(
          target.readFrom(newHead1!, -1),
          "readFrom during the log park",
        );
        expect(segmentDuringLogPark.events).toHaveLength(0);

        const headDuringLogPark = await waitAsync(target.getHead(), "getHead during the log park");
        expect(headDuringLogPark.head).toBe(newHead1);
      } finally {
        gate.logWriteBlock.resolve();
        newHead2 = (await append2).revision;
      }

      expect(newHead2).toBeDefined();
      const segmentFinal = await target.readFrom(newHead1!, -1);
      expect(segmentFinal.events).toHaveLength(1);
      expect(segmentFinal.events[0]!.revision).toBe(newHead2);
      expect(segmentFinal.headRevision).toBe(newHead2);
    });
  });

  /**
   * Gate 3: a commit whose `head` write fails transiently must never leak a spurious event - and,
   * because the log-row writes tolerate overwriting their own orphan (the write-first,
   * ETag-tolerant-fallback discipline), the storage adaptor's internal retry RECOVERS the commit:
   * it re-writes the same log entry over the orphan, retries the head write, and the caller's
   * `commit` completes with the minted revision. This pins three things at once: the commit
   * succeeds despite the one-shot fault, exactly ONE event surfaces (the orphan overwrite
   * duplicated nothing), and the datastore is writable afterwards.
   */
  it("Failed_head_write_recovers_without_leaking_or_duplicating_events", async () => {
    await withCluster(async ({ cluster }) => {
      const target = grain(cluster);
      const oldHead = (await target.getHead()).head;

      gate.throwOnceOnHeadWrite = true;
      const reply = await waitAsync(
        target.commit(touchCommit("a", "alice", oldHead)),
        "the recovering commit",
      );

      expect(reply.failure).toBeUndefined();
      expect(reply.revision).toBeDefined();

      const head = await waitAsync(target.getHead(), "getHead after recovery");
      expect(head.head).toBe(reply.revision);
      const segment = await waitAsync(target.readFrom(oldHead, -1), "readFrom after recovery");
      expect(segment.events).toHaveLength(1);
      expect(segment.events[0]!.revision).toBe(reply.revision);

      // Writable again afterwards - the half of the contract the wedged-retry era could not assert.
      const reply2 = await waitAsync(
        target.commit(touchCommit("b", "bob", head.head)),
        "the follow-up commit",
      );
      expect(reply2.failure).toBeUndefined();
      expect(reply2.revision).toBeDefined();
      expect(reply2.revision! > reply.revision!).toBe(true);
    });
  });

  /**
   * Gate 3b: the same one-shot head-write fault as gate 3, landed exactly ON a FLUSH BOUNDARY (the
   * 64th commit). The failed attempt has already written its shard rows, the rotated index-bucket
   * pair, the delta row and the meta row - all orphans at versioned names - and the adaptor's retry
   * re-runs the SAME boundary: same log slot, same flush version, same rotated bucket, overwriting
   * its own orphans via the read-then-write discipline. Pins that the boundary commit succeeds and
   * that the index the retried flush committed is CORRECT: after a forced deactivation, recovery
   * reconstructs the store THROUGH that index, and every pre-boundary key must still be served (a
   * referenced-but-wrong bucket/delta/shard row would lose keys or fail the recovery loudly).
   */
  it("Failed_head_write_at_a_flush_boundary_retries_the_same_bucket_and_commits_a_correct_index", async () => {
    await withCluster(async ({ cluster, storage }) => {
      const target = grain(cluster);
      let head = (await target.getHead()).head;

      // 63 commits bring the contiguous log to version 63 - the next commit is the flush boundary.
      for (let i = 0; i < 63; i += 1) {
        const reply = await target.commit(touchCommit(`k${i}`, `u${i}`, head));
        expect(reply.failure).toBeUndefined();
        head = reply.revision!;
      }

      gate.throwOnceOnHeadWrite = true;
      const boundary = await waitAsync(
        target.commit(touchCommit("k63", "u63", head)),
        "the boundary commit",
      );
      expect(boundary.failure).toBeUndefined();
      expect(boundary.revision).toBeDefined();

      // The flush really committed on the retry: the durable head names the boundary as its flush.
      const grainId = grainReferenceIdentity(target)!.grainId;
      const headRow: StateHolder<LogHeadEntry> = {
        value: undefined as unknown as LogHeadEntry,
        exists: false,
      };
      await storage.read("head", grainId, headRow);
      expect(headRow.exists).toBe(true);
      expect(headRow.value.logVersion).toBe(64);
      expect(headRow.value.snapshotVersion).toBe(64);

      // Recovery THROUGH the retried flush's index: drop the activation and re-read every key.
      const management = cluster.primary.host.getGrain(IManagementGrain, 0n);
      await management.forceActivationCollection({ ms: 0 });

      const headAfter = await target.getHead();
      expect(headAfter.head).toBe(boundary.revision);
      for (let i = 0; i < 64; i += 1) {
        const shard = await target.readShard(graphShardKeyForResource("doc", `k${i}`));
        const live = shard.rows.filter((r) => r.deletedRevision === undefined);
        expect(live).toHaveLength(1);
        expect(live[0]!.relationship.subjectId).toBe(`u${i}`);
      }
    });
  });

  /**
   * Gate 4: the CAS remains exact under concurrent writers even while reads hammer the activation
   * concurrently - exactly one of two same-expectedHead commits succeeds.
   */
  it("Cas_still_exact_under_concurrent_writers", async () => {
    await withCluster(async ({ cluster }) => {
      const target = grain(cluster);
      const head = (await target.getHead()).head;

      let cancelled = false;
      const hammer = (async () => {
        while (!cancelled) await target.getHead();
      })();

      const t1 = target.commit(touchCommit("a", "alice", head));
      const t2 = target.commit(touchCommit("b", "bob", head));
      const results = await waitAsync(Promise.all([t1, t2]), "both racing commits");

      cancelled = true;
      await hammer;

      // Exactly one same-expectedHead commit wins; the loser is rejected as reply data (headMoved),
      // the same CAS invariant the retired two-step append surfaced as an absent revision.
      expect(results.filter((r) => r.revision !== undefined)).toHaveLength(1);
      expect(results.filter((r) => r.failure?.kind === "headMoved")).toHaveLength(1);
    });
  });
});
