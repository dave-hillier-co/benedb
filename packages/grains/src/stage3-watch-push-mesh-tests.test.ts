import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import { createRelationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { WatchContent, type RevisionChange } from "@benedb/datastore/watch";
import { createClient, type ClientNode } from "@thresh/client/client-node";
import { IManagementGrain } from "@thresh/core/management-grain";
import { SiloAddress } from "@thresh/core/silo-address";
import { InProcessTransport } from "@thresh/messaging/in-process-transport";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { TestCluster } from "@thresh/testing/test-cluster";
import { constructGrain } from "@thresh/runtime/construct-grain";

import { DatastoreGrain } from "./datastore-grain";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import { IDatastoreGrain } from "./i-datastore-grain";
import { createIsolatedWatchHub } from "./isolated-watch-hub";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/Stage3WatchPushMeshTests.cs`.
 *
 * Gates for the PUSH-driven Watch feed: the per-silo `LogWatchHub` registers an `IDatastoreWatcher`
 * observer on the datastore grain, so a commit from anywhere wakes parked streams by notification,
 * with the hub's slow heartbeat only as the missed-push backstop. Proves (a) PUSH: a commit through
 * a DIFFERENT datastore instance (no local pulse) is observed far faster than the fallback
 * heartbeat could deliver it; (b) LIVENESS ACROSS REACTIVATION: deactivating the datastore grain
 * (which empties its in-memory observer set) never wedges a parked stream - the heartbeat
 * resubscribes and pulses the head it missed.
 *
 * PORT NOTES.
 *  - THE TWO HUBS MUST STAY GENUINELY SEPARATE. Gate (a) is worthless the moment the watcher and
 *    the committer share a hub instance: the commit would pulse the observing side locally and the
 *    observation would prove nothing about observer push. `createIsolatedWatchHub` is what keeps
 *    them apart, and the watcher's heartbeat is set to 30s - far beyond the 5s assertion bound - so
 *    an in-bound observation can ONLY have arrived by the grain's observer notification.
 *  - OBSERVER REFERENCES ARE REAL ON THRESH. `ClientNode.createObjectReference` /
 *    `deleteObjectReference` are the `IGrainObserver` surface (see
 *    `../thresh/packages/parity/src/default-cluster/observer.test.ts`), so the hub's own
 *    registration path runs unmodified here. The factory handed to both hubs is therefore a real
 *    `ClientNode` joined to the cluster through its primary silo as gateway, NOT a silo host: a
 *    host offers `getGrain` but not the observer members.
 *  - `ISiloConfigurator` + `AddDatastoreGrainStorage(...)` +
 *    `AddCustomStorageBasedLogConsistencyProvider("CustomStorage")` do not transliterate. Thresh
 *    has no constructor DI, so the grain's storage arrives through a `GrainActivator`, and the
 *    journaling binder DETECTS the grain's custom-storage shape rather than being named a provider
 *    (`TestCluster` already calls `useMemoryJournaling`, which is what makes the binder run). This
 *    is the same wiring `stage1-journaled-write-path-tests.test.ts` uses.
 *  - `gf.GetGrain<IManagementGrain>(0).ForceActivationCollection(TimeSpan.Zero)` ->
 *    `IManagementGrain` at key `0n` with `{ ms: 0 }`, resolved from the (single) silo host.
 *  - `Stopwatch` -> `Date.now()` deltas. THE BOUND IS THE ASSERTION; widening it converts a dropped
 *    push into a slow pass.
 *  - `await using` -> explicit `try/finally` for the cluster, the client and BOTH hubs. A leaked
 *    hub leaves a live heartbeat loop running past the end of the test - the Node analogue of the
 *    orphaned-host hazard.
 */

function create(rid: string, sid: string): RelationshipUpdate {
  return {
    relationship: createRelationship(
      { objectType: "document", objectId: rid, relation: "viewer" },
      { objectType: "user", objectId: sid, relation: ELLIPSIS },
    ),
    operation: "create",
  };
}

/**
 * The C#'s `NewDatastoreClusterAsync` + `DatastoreSiloConfigurator`: a single-silo cluster hosting
 * the real `DatastoreGrain` over an in-memory grain-storage provider named `datastore`.
 */
async function newDatastoreCluster(): Promise<TestCluster> {
  const storage = new MemoryGrainStorage();
  return TestCluster.start({
    initialSilos: 1,
    grains: [{ ctor: DatastoreGrain, interfaces: [IDatastoreGrain] }],
    configureSilo: (builder) => {
      builder.addStorage("datastore", storage);
      builder.useGrainActivator({
        createInstance: (ctor) =>
          ctor === DatastoreGrain ? new DatastoreGrain({ storage }) : constructGrain(ctor),
      });
    },
  });
}

/** The cluster CLIENT - the observer-capable grain factory both hubs mint their reference from. */
async function newClient(cluster: TestCluster): Promise<ClientNode> {
  const client = createClient({
    clusterId: cluster.clusterId,
    local: new SiloAddress("watch-push-client", "uid-watch-push-client", "watch-push-client:22222"),
    transport: new InProcessTransport(cluster.network, cluster.clusterId),
    gateway: cluster.primary.address,
  }).registerGrains([{ ctor: DatastoreGrain, interfaces: [IDatastoreGrain] }]);
  await client.connect();
  return client;
}

describe("Stage3WatchPushMeshTests", () => {
  /**
   * Gate (a): the watcher's fallback heartbeat is set far beyond the assertion bound, and the
   * commit goes through a SEPARATE GrainBackedDatastore instance (so the watcher's hub gets no
   * same-instance pulse). An observation inside the bound can therefore only have arrived by
   * observer push.
   */
  it("Commit_from_another_instance_wakes_a_parked_watch_by_push", async () => {
    const cluster = await newDatastoreCluster();
    const client = await newClient(cluster);
    const watcherHub = createIsolatedWatchHub(client, { seconds: 30 });
    const committerHub = createIsolatedWatchHub(client);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 20_000);
    try {
      const watcher = new GrainBackedDatastore(client, watcherHub);
      const committer = new GrainBackedDatastore(client, committerHub);

      const head = (await watcher.headRevision()).revision;

      let resolveFirst: ((change: RevisionChange) => void) | undefined;
      const first = new Promise<RevisionChange>((resolve) => {
        resolveFirst = resolve;
      });
      const consume = (async () => {
        for await (const change of watcher.watch(
          head,
          { content: WatchContent.relationships },
          controller.signal,
        )) {
          resolveFirst?.(change);
          break;
        }
      })();

      // Let the stream park and the hub's first heartbeat register the observer, then commit and
      // time it.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const startedAt = Date.now();
      await committer.readWriteTx((tx) => tx.writeRelationships([create("doc1", "alice")]));

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
        `observed after ${elapsedMs}ms - beyond push latency, and the 30s fallback cannot have delivered it`,
      ).toBeLessThan(5_000);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await committerHub.dispose();
      await watcherHub.dispose();
      await client.close();
      await cluster.dispose();
    }
  }, 120_000);

  /**
   * Gate (b): force-deactivating the datastore grain empties its in-memory observer set; the next
   * commit (again via a separate instance, so no local pulse) reactivates it with NO watchers
   * registered. The parked stream must still observe the change: the hub's heartbeat resubscribes
   * and pulses the returned head. This is the liveness guarantee that makes best-effort push safe -
   * and it also pins that a re-subscribe with the SAME object reference REFRESHES the registration
   * rather than accumulating a duplicate.
   */
  it("Grain_reactivation_never_wedges_a_parked_stream", async () => {
    const cluster = await newDatastoreCluster();
    const client = await newClient(cluster);
    const watcherHub = createIsolatedWatchHub(client);
    const committerHub = createIsolatedWatchHub(client);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try {
      const watcher = new GrainBackedDatastore(client, watcherHub);
      const committer = new GrainBackedDatastore(client, committerHub);

      const head = (await watcher.headRevision()).revision;

      let resolveFirst: ((change: RevisionChange) => void) | undefined;
      const first = new Promise<RevisionChange>((resolve) => {
        resolveFirst = resolve;
      });
      const consume = (async () => {
        for await (const change of watcher.watch(
          head,
          { content: WatchContent.relationships },
          controller.signal,
        )) {
          resolveFirst?.(change);
          break;
        }
      })();

      // Park the stream, then drop every activation (and with it the grain's observer
      // registrations).
      await new Promise((resolve) => setTimeout(resolve, 500));
      await cluster.primary.host
        .getGrain(IManagementGrain, 0n)
        .forceActivationCollection({ ms: 0 });

      await committer.readWriteTx((tx) => tx.writeRelationships([create("doc2", "bob")]));

      const outcome = await Promise.race([
        first.then(() => "observed" as const),
        new Promise<"timedOut">((resolve) => setTimeout(() => resolve("timedOut"), 15_000)),
      ]);
      expect(outcome).toBe("observed");
      const observed = await first;

      controller.abort();
      await consume;

      expect(observed.relationshipChanges.length).toBe(1);
      expect(observed.relationshipChanges[0]?.relationship.reference.resource.objectId).toBe(
        "doc2",
      );
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await committerHub.dispose();
      await watcherHub.dispose();
      await client.close();
      await cluster.dispose();
    }
  }, 120_000);
});
