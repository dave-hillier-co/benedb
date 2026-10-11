import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { GrainId } from "@thresh/core/grain-id";
import type { GrainStorage, StateHolder } from "@thresh/core/grain-storage";
import type { JournalEntry, JournalSegment, JournalStorage } from "@thresh/core/journal-storage";
import { IManagementGrain } from "@thresh/core/management-grain";
import { MemoryJournalStorage } from "@thresh/journaling/memory-journal-storage";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { TestCluster } from "@thresh/testing/test-cluster";
import { describe, expect, it } from "vitest";

import type { CommitReply, CommitRequest } from "./commit-contract";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { graphShardKeyForResource } from "./graph-shard-key";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { IGraphShardGrain } from "./i-graph-shard-grain";
import { configureSequencerSilo, SEQUENCER_GRAIN_REGISTRATIONS } from "./sequencer-test-silo";
import { toWire } from "./wire-convert";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/DatastoreInterleavedReadTests.cs`.
 *
 * Grain-level gates for interleaving pure reads (`getHead`, `readState`, `readFrom`) past an
 * in-flight `commit` on the cluster-singleton `DatastoreGrain`. Drives the REAL grain through a
 * Thresh {@link TestCluster}, with the datastore grain's journal wrapped by {@link PausableJournal}
 * so the journal append - the commit point - can be parked mid-flight while a read is issued
 * concurrently, or made to fail once; and the `datastore` grain storage wrapped by
 * {@link FaultyShardStorage} so a shard projection write can be made to fail once.
 *
 * Port decisions:
 *
 *  1. THE COMMIT POINT IS A JOURNAL APPEND. The C# parks the sequencer's grain-storage write,
 *     because Orleans' state-storage log-consistency provider writes the journaled view there; a
 *     Thresh `JournaledGrain` appends to the silo's journal instead, so the gate wraps a
 *     `JournalStorage`. Reads stay ungated, exactly as in the C#: only the write path is under test.
 *  2. The C#'s keyed-DI swap (`AddMemoryGrainStorage("datastore-inner")` + a keyed
 *     `IGrainStorage` override for `"datastore"`) collapses: Thresh has no keyed DI, so the test
 *     constructs the decorators directly and binds them through `configureSequencerSilo`. The
 *     "force the binary serializer" half of that registration has no counterpart - the memory
 *     providers round-trip through `structuredClone`, which preserves `Uint8Array`, `Map` and
 *     `bigint` exactly.
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

/** A declarative commit (no expectedHead) of one relationship update. */
function updateCommit(operation: "touch" | "create", rid: string, sid: string): CommitRequest {
  return {
    preconditions: [],
    updates: [{ operation, relationship: toWire(rel(rid, sid)) }],
    deleteByFilter: undefined,
    schemaBytes: undefined,
    expectedSchemaHash: undefined,
    counterChanges: [],
    expectedHead: undefined,
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
 * File-scoped gate state consulted by {@link PausableJournal} and {@link FaultyShardStorage}. See
 * port decision 3 above for why a module-level handle is safe here.
 */
const gate: {
  headWriteBlock: Deferred | undefined;
  headWriteParked: Deferred | undefined;
  throwOnceOnHeadWrite: boolean;
  throwOnceOnShardWrite: boolean;
  journalAppends: number;
} = {
  journalAppends: 0,
  headWriteBlock: undefined,
  headWriteParked: undefined,
  throwOnceOnHeadWrite: false,
  throwOnceOnShardWrite: false,
};

function resetGate(): void {
  gate.journalAppends = 0;
  gate.headWriteBlock = undefined;
  gate.headWriteParked = undefined;
  gate.throwOnceOnHeadWrite = false;
  gate.throwOnceOnShardWrite = false;
}

/**
 * Wraps the in-memory journal so a test can park an append - the datastore grain's commit point -
 * mid-flight (an await that only resumes once the test releases the gate deferred), or make the
 * next append throw once. Reads and snapshot replaces are never gated.
 */
class PausableJournal implements JournalStorage {
  constructor(private readonly inner: JournalStorage) {}

  read(logName: string, grainId: GrainId, signal?: AbortSignal): Promise<JournalSegment> {
    return this.inner.read(logName, grainId, signal);
  }

  async append(
    logName: string,
    grainId: GrainId,
    entries: readonly JournalEntry[],
    expectedVersion: number | undefined,
    signal?: AbortSignal,
  ): Promise<number> {
    gate.journalAppends += 1;
    if (gate.throwOnceOnHeadWrite) {
      gate.throwOnceOnHeadWrite = false;
      throw new Error("injected append failure (test seam)");
    }
    const headGate = gate.headWriteBlock;
    if (headGate !== undefined) {
      gate.headWriteParked?.resolve();
      await headGate.promise;
    }
    return this.inner.append(logName, grainId, entries, expectedVersion, signal);
  }

  replace(
    logName: string,
    grainId: GrainId,
    entries: readonly JournalEntry[],
    expectedVersion: number | undefined,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.inner.replace(logName, grainId, entries, expectedVersion, signal);
  }

  clear(logName: string, grainId: GrainId, signal?: AbortSignal): Promise<void> {
    return this.inner.clear(logName, grainId, signal);
  }
}

/** Wraps the in-memory grain storage so the next shard-projection write can be made to throw. */
class FaultyShardStorage implements GrainStorage {
  constructor(private readonly inner: GrainStorage) {}

  read<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inner.read(stateName, grainId, state, signal);
  }

  write<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (gate.throwOnceOnShardWrite && String(grainId.type).toLowerCase().includes("graphshard")) {
      gate.throwOnceOnShardWrite = false;
      return Promise.reject(new Error("injected shard-projection write failure (test seam)"));
    }
    return this.inner.write(stateName, grainId, state, signal);
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
}

async function newCluster(): Promise<Fixture> {
  resetGate();
  const stores = {
    storage: new FaultyShardStorage(new MemoryGrainStorage()),
    journal: new PausableJournal(new MemoryJournalStorage()),
  };
  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: SEQUENCER_GRAIN_REGISTRATIONS,
    configureSilo: (builder) => {
      configureSequencerSilo(builder, stores);
    },
  });
  return { cluster };
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
   * Gate 1: with a write parked at the journal append (the commit point), `getHead` and
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
        await waitAsync(gate.headWriteParked.promise, "the journal append to park");

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
   * Gate 2: a write parked mid-flight must never be observable by an interleaved reader. Once the
   * write completes, the event and the advanced head become visible together (one consistent
   * publication: both come from the one confirmed state).
   */
  it("Parked_write_is_invisible_until_the_head_commit", async () => {
    await withCluster(async ({ cluster }) => {
      const target = grain(cluster);
      const oldHead = (await target.getHead()).head;

      // Park at the journal append itself.
      gate.headWriteBlock = deferred();
      gate.headWriteParked = deferred();
      const append1 = target.commit(touchCommit("a", "alice", oldHead));
      let newHead1: bigint | undefined;
      try {
        await waitAsync(gate.headWriteParked.promise, "the journal append to park");

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
    });
  });

  /**
   * Gate 3: a commit whose journal append fails transiently must never leak a spurious event, and
   * the log-view adaptor's re-read-and-retry RECOVERS the commit: the caller's `commit` completes
   * with the minted revision. This pins three things at once: the commit succeeds despite the
   * one-shot fault, exactly ONE event surfaces, and the datastore is writable afterwards.
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
   * Gate 3b: a shard-projection write that fails at the FLUSH BOUNDARY (the 64th commit) must not
   * fail the commit that triggered the flush - that commit is already journaled - and must lose
   * nothing: the events stay pending (reads fold them over the partial projection), and the next
   * flush replays them, idempotently for the shards that did persist. After a forced deactivation
   * every key is still served from the projection.
   */
  it("Failed_projection_write_at_a_flush_boundary_keeps_events_pending_until_a_later_flush", async () => {
    await withCluster(async ({ cluster }) => {
      const target = grain(cluster);
      let head = (await target.getHead()).head;

      // 63 commits - the next commit fills the pending tail to the flush interval.
      for (let i = 0; i < 63; i += 1) {
        const reply = await target.commit(touchCommit(`k${i}`, `u${i}`, head));
        expect(reply.failure).toBeUndefined();
        head = reply.revision!;
      }

      gate.throwOnceOnShardWrite = true;
      const boundary = await waitAsync(
        target.commit(touchCommit("k63", "u63", head)),
        "the boundary commit",
      );
      expect(boundary.failure).toBeUndefined();
      expect(boundary.revision).toBeDefined();
      expect(gate.throwOnceOnShardWrite).toBe(false); // the fault really fired

      // Nothing projected yet: the tail is still served from the pending state.
      const tail = await target.readFrom(head - 1n, -1);
      expect(tail.events.some((e) => e.revision === boundary.revision)).toBe(true);
      for (let i = 0; i < 64; i += 1) {
        const shard = await target.readShard(graphShardKeyForResource("doc", `k${i}`));
        const live = shard.rows.filter((r) => r.deletedRevision === undefined);
        expect(live).toHaveLength(1);
        expect(live[0]!.relationship.subjectId).toBe(`u${i}`);
      }

      // A later flush replays the whole tail; then recovery reads every key back from projections.
      await target.flushProjection();
      const management = cluster.primary.host.getGrain(IManagementGrain, 0n);
      await management.forceActivationCollection({ ms: 0 });

      const headAfter = await target.getHead();
      expect(headAfter.head).toBe(boundary.revision);
      for (let i = 0; i < 64; i += 1) {
        const projected = await cluster.primary.host
          .getGrain(
            IGraphShardGrain,
            graphShardGrainKeyBuild(graphShardKeyForResource("doc", `k${i}`)),
          )
          .readProjected();
        const live = projected.rows.filter((r) => r.deletedRevision === undefined);
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

  /**
   * Group commit: commits that arrive while a write is parked are not queued behind it one write
   * each. They are evaluated in order and appended together, so the sequencer's journal append
   * count is two (the parked write, then one for the whole batch) rather than one per commit, and
   * every commit still gets its own revision.
   */
  it("Commits_arriving_during_a_write_share_one_write", async () => {
    await withCluster(async ({ cluster }) => {
      const target = grain(cluster);
      const oldHead = (await target.getHead()).head;
      const appendsBefore = gate.journalAppends;

      gate.headWriteBlock = deferred();
      gate.headWriteParked = deferred();
      const first = target.commit(updateCommit("touch", "first", "alice"));
      let batched: Promise<CommitReply>[];
      try {
        await waitAsync(gate.headWriteParked.promise, "the journal append to park");
        gate.headWriteParked = undefined;
        batched = Array.from({ length: 5 }, (_, i) =>
          target.commit(updateCommit("touch", `b${i}`, "bob")),
        );
        // Let every batched call reach the activation before the parked write resumes.
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        const block = gate.headWriteBlock;
        gate.headWriteBlock = undefined;
        block?.resolve();
      }

      const firstReply = await waitAsync(first, "the parked commit");
      const replies = await waitAsync(Promise.all(batched), "the batched commits");

      expect(firstReply.failure).toBeUndefined();
      for (const reply of replies) expect(reply.failure).toBeUndefined();
      const revisions = replies.map((r) => r.revision!);
      expect(new Set(revisions).size).toBe(revisions.length);
      for (const revision of revisions) expect(revision > firstReply.revision!).toBe(true);
      expect(gate.journalAppends).toBe(appendsBefore + 2);

      const segment = await target.readFrom(oldHead, -1);
      expect(segment.events).toHaveLength(6);
      expect(segment.headRevision).toBe(revisions.reduce((a, b) => (a > b ? a : b)));
    });
  });

  /**
   * A commit evaluated later in a batch sees the commits before it in the same batch: two creates of
   * one relationship batched together still conflict, exactly one winning.
   */
  it("A_batched_commit_sees_the_commits_before_it_in_its_batch", async () => {
    await withCluster(async ({ cluster }) => {
      const target = grain(cluster);

      gate.headWriteBlock = deferred();
      gate.headWriteParked = deferred();
      const first = target.commit(updateCommit("touch", "first", "alice"));
      let creates: Promise<CommitReply>[];
      try {
        await waitAsync(gate.headWriteParked.promise, "the journal append to park");
        gate.headWriteParked = undefined;
        creates = [
          target.commit(updateCommit("create", "x", "carol")),
          target.commit(updateCommit("create", "x", "carol")),
        ];
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        const block = gate.headWriteBlock;
        gate.headWriteBlock = undefined;
        block?.resolve();
      }

      await waitAsync(first, "the parked commit");
      const replies = await waitAsync(Promise.all(creates), "the batched creates");
      expect(replies.filter((r) => r.revision !== undefined)).toHaveLength(1);
      expect(replies.filter((r) => r.failure?.kind === "createAlreadyExists")).toHaveLength(1);
    });
  });
});
