import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import { createRelationship } from "@benedb/core/relationship";
import { WatchContent, type RevisionChange } from "@benedb/datastore/watch";
import { GrainCallAbortedError } from "@thresh/core/errors";

import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/Stage3WatchOverLogTests.cs`.
 *
 * Stage-3 gates for the log-driven Watch changefeed: `IDatastore.watch` tails the event log
 * (shipping only the per-revision diff) and parks on a per-silo signal rather than a per-stream
 * 50ms full-state poll. Proves a schema-only commit still surfaces a schema-change + checkpoint (no
 * phantom relationship change), and that a write is observed promptly (event-driven, not a fixed
 * poll delay) thanks to the local commit pulsing the watcher directly.
 *
 * PORT NOTES.
 *  - `CancellationTokenSource` -> an `AbortController`; a `CancellationTokenSource(TimeSpan)` ->
 *    the same controller plus a `setTimeout` that aborts it, ALWAYS cleared in a `finally` so the
 *    losing timer can never keep the Node process alive.
 *  - `GrainBackedDatastore.watch` ENDS its stream on abort (it catches `GrainCallAbortedError` from
 *    the parked wait and returns), so a `for await` simply completes rather than throwing. The
 *    catch is kept anyway, exactly as the C# keeps its `OperationCanceledException` handler: it
 *    swallows only the abort error and rethrows anything else, so a genuine fault is never masked
 *    by "cancellation is the normal terminator".
 *  - `Stopwatch` -> `Date.now()` deltas. THE SUB-SECOND BOUND IS THE ASSERTION and must never be
 *    relaxed to accommodate a missing pulse: the pulse is the thing under test.
 *  - `Task.Run(...)` -> a detached async function whose PROMISE HANDLE IS HELD and awaited before
 *    the case ends. An orphaned consumer loop is the Node analogue of the orphaned-host hazard.
 *  - `[Collection(MeshClusterCollection.Name)]` -> nothing; see `mesh-cluster-collection.ts`.
 */

const SCHEMA = `definition user {}
definition document {
    relation viewer: user
    permission view = viewer
}`;

/** An `AbortController` that self-aborts after `ms`, with the timer released by `dispose`. */
function timeoutController(ms: number): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, dispose: () => clearTimeout(timer) };
}

/** `Task.WhenAny(work, Task.Delay(timeout))`: `work` is reflected so a rejection never escapes. */
async function raceAgainstTimeout(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<"completed" | "timedOut"> {
  const settled = work.then(
    () => "completed" as const,
    () => "completed" as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timedOut">((resolve) => {
    timer = setTimeout(() => resolve("timedOut"), timeoutMs);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The C#'s `Collect`: take `count` changes, then cancel the stream. */
async function collect(
  stream: AsyncIterable<RevisionChange>,
  count: number,
  controller: AbortController,
): Promise<RevisionChange[]> {
  const list: RevisionChange[] = [];
  try {
    for await (const change of stream) {
      list.push(change);
      if (list.length >= count) {
        controller.abort();
        break;
      }
    }
  } catch (error) {
    // Cancellation is the normal stream terminator; anything else is a real fault.
    if (!(error instanceof GrainCallAbortedError)) throw error;
  }
  return list;
}

describe("Stage3WatchOverLogTests", () => {
  /**
   * A schema-only commit (no relationship change) is replayed as a RevisionChange carrying
   * schemaChanged (and no relationship updates), followed by a checkpoint - the feed rides the
   * revision even though no relationship matched. Uses the deterministic resume-from-pre-write
   * cursor path (no timing).
   */
  it("Watch_schema_only_commit_emits_schema_change_then_checkpoint", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    const { controller, dispose: releaseTimer } = timeoutController(20_000);
    try {
      const ds = cluster.datastore;
      const preWrite = (await ds.headRevision()).revision;

      // A schema-only commit: rewrite the unified schema, touching no relationships.
      await ds.readWriteTx((tx) =>
        tx.writeStoredSchema(new TextEncoder().encode(`${SCHEMA}\ndefinition folder {}`)),
      );

      const changes = await collect(
        ds.watch(
          preWrite,
          { content: WatchContent.all | WatchContent.checkpoints },
          controller.signal,
        ),
        2,
        controller,
      );

      const content = changes[0];
      expect(content).toBeDefined();
      expect(content?.isCheckpoint ?? false).toBe(false);
      expect(content?.schemaChanged ?? false).toBe(true);
      expect(content?.relationshipChanges).toEqual([]);

      const checkpoint = changes[1];
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.isCheckpoint ?? false).toBe(true);
      expect(checkpoint?.relationshipChanges).toEqual([]);
      expect(checkpoint?.revision.toString()).toBe(content?.revision.toString());
    } finally {
      releaseTimer();
      controller.abort();
      await cluster.dispose();
    }
  }, 120_000);

  /**
   * Tailing from head, a relationship write committed on the same silo is observed promptly - the
   * commit pulses the per-silo watcher directly, so it does not wait on a poll tick. A generous
   * bound proves the feed is event-driven (it is nowhere near the 20s cancellation fallback), not
   * flaky on CI jitter.
   */
  it("Watch_observes_a_write_promptly_without_polling", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    const { controller, dispose: releaseTimer } = timeoutController(20_000);
    try {
      const ds = cluster.datastore;
      const head = (await ds.headRevision()).revision;

      let resolveFirst: ((change: RevisionChange) => void) | undefined;
      const first = new Promise<RevisionChange>((resolve) => {
        resolveFirst = resolve;
      });
      const consume = (async () => {
        for await (const change of ds.watch(
          head,
          { content: WatchContent.relationships },
          controller.signal,
        )) {
          resolveFirst?.(change);
          break;
        }
      })();

      // Give the stream a moment to start tailing, then commit and time the observation.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const startedAt = Date.now();
      await ds.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              { objectType: "document", objectId: "doc1", relation: "viewer" },
              { objectType: "user", objectId: "alice", relation: ELLIPSIS },
            ),
            operation: "create",
          },
        ]),
      );

      const outcome = await Promise.race([
        first.then(() => "observed" as const),
        new Promise<"timedOut">((resolve) => setTimeout(() => resolve("timedOut"), 10_000)),
      ]);
      expect(outcome).toBe("observed");
      const observed = await first;
      const elapsedMs = Date.now() - startedAt;

      controller.abort();
      await consume;

      expect(observed.relationshipChanges.length).toBe(1);
      expect(observed.relationshipChanges[0]?.relationship.reference.resource.objectId).toBe(
        "doc1",
      );
      expect(
        elapsedMs,
        `observed after ${elapsedMs}ms (expected event-driven, sub-second)`,
      ).toBeLessThan(1_000);
    } finally {
      releaseTimer();
      controller.abort();
      await cluster.dispose();
    }
  }, 120_000);

  /**
   * Clean-teardown gate for the DI-owned hub: the per-silo `LogWatchHub` is disposable, so
   * cluster/silo disposal must dispose it (a bounded, timeout-guarded unsubscribe from the
   * DatastoreGrain's observer set) without hanging or throwing, even after a Watch stream started
   * its observer subscription and heartbeat. In Node this is ALSO the gate on the detached
   * heartbeat loop not outliving the cluster.
   */
  it("Cluster_shutdown_disposes_the_shared_hub_without_hanging_or_throwing", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);

    // Exercise the hub: park a Watch stream so the hub's signal path (observer subscription +
    // heartbeat, lazily started by the stream's ensureStarted) is genuinely live.
    const head = (await cluster.datastore.headRevision()).revision;
    const watchController = new AbortController();
    const watchTask = (async () => {
      for await (const _ of cluster.datastore.watch(
        head,
        { content: WatchContent.relationships },
        watchController.signal,
      )) {
        // Drained; the stream is here only to make the hub's signal path live.
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Drain the consumer while the cluster is still alive (a background task left running past
    // cluster disposal would leak into and perturb later tests). The hub's observer subscription on
    // the datastore grain remains registered - container disposal, not this stream's lifetime, owns
    // tearing that down.
    watchController.abort();
    await watchTask;

    const disposeTask = cluster.dispose();
    expect(await raceAgainstTimeout(disposeTask, 30_000)).toBe("completed");
    await disposeTask; // rethrows if disposal itself faulted
  }, 120_000);
});
