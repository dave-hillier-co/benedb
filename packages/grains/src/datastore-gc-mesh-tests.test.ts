import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import { createRelationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import type { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@spacedb/datastore/datastore-exceptions";
import type { IDatastore, IDatastoreReader } from "@spacedb/datastore/i-datastore";
import { WatchContent, type RevisionChange } from "@spacedb/datastore/watch";
import type { ClientNode } from "@thresh/client/client-node";
import type { GrainId } from "@thresh/core/grain-id";
import { grainReferenceIdentity } from "@thresh/core/grain-reference";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { TestCluster } from "@thresh/testing/test-cluster";

import { datastoreHeadWireGcFloor } from "./datastore-dtos";
import { MINIMUM_REMINDER_PERIOD, type DatastoreGcOptions } from "./datastore-gc-options";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { createIsolatedWatchHub } from "./isolated-watch-hub";
import type { LogWatchHub } from "./log-watch-hub";
import type { SpiceportGrainServices } from "./service-collection-extensions";
import {
  addSpiceportGrainServices,
  SPICEPORT_GRAIN_REGISTRATIONS,
} from "./service-collection-extensions";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/DatastoreGcMeshTests.cs`.
 *
 * Grain/mesh-level gates for reminder-driven MVCC garbage collection, driven through a real Thresh
 * {@link TestCluster} (the actual `DatastoreGrain`, not a fake). {@link gcOptions} uses
 * `DatastoreGcOptions.window = TimeSpan.Zero` -> `{ ms: 0 }`, which makes `IDatastoreGrain.runGc`
 * fully deterministic for collection/floor-rejection gates: the computed floor is
 * `min(head, now) == head` (revisions never exceed "now"), so ONE `runGc()` call collects
 * everything dead as of the current head. Gates that instead need a cursor minted moments ago to
 * SURVIVE a GC run (the Watch-continuity risk case) use {@link realWindowOptions}' realistic
 * multi-hour window instead, where the floor stays far in the past.
 *
 * PORT DECISIONS.
 *
 *  1. ONE BUILDER, NOT FIVE CONFIGURATORS. The C# declares five `ISiloConfigurator` classes that
 *     differ ONLY in the `DatastoreGcOptions` they register, because Orleans instantiates an
 *     `ISiloConfigurator` BY TYPE and so cannot close over a value. Thresh's `configureSilo` is a
 *     closure, so {@link buildCluster} takes the options as an argument - the same fold
 *     `datastore-grain-durability-tests.test.ts` already made for its two GC configurators.
 *  2. `MeshTestCluster` CANNOT BE USED HERE. Its `gcWindow` option ALWAYS forces
 *     `reminderEnabled: false` (its port decision 8), and two cases in this file are precisely
 *     about the reminder. The cluster is therefore built directly, exactly as the durability suite
 *     does.
 *  3. `AddDatastoreGrainStorage(new ConfigurationBuilder().Build())` (the S5 production
 *     registration taking its in-memory branch with the binary grain-storage serializer forced) ->
 *     a Thresh {@link MemoryGrainStorage} registered under the provider name `datastore` and also
 *     handed to `addSpiceportGrainServices`. The serializer-forcing has no TypeScript analogue:
 *     Thresh has one storage codec. `AddCustomStorageBasedLogConsistencyProvider("CustomStorage")`
 *     likewise has none - Thresh's journaling binder DETECTS a custom-storage grain and installs
 *     the adaptor, and `TestCluster` already calls `useMemoryJournaling`.
 *  4. `GcWithoutReminderServiceSiloConfigurator` simply omits `UseInMemoryReminderService()`, so
 *     `RegisterOrUpdateReminder` throws and `DatastoreGrain.OnActivateAsync`'s try/catch gate is
 *     what keeps activation alive. Thresh's `TestCluster` used to hardcode
 *     `.useReminders(this.reminderTable)` on every silo, so this case could only be approximated by
 *     a reminder table whose `upsert` rejects - which tests a reminder service that FAILED, not one
 *     that is absent. Thresh #62 added `TestClusterOptions.reminders`, the literal counterpart:
 *     `reminders: false` builds silos with no reminder service at all, exactly as the C#
 *     configurator does. The ASSERTION is unchanged: the grain activates, serves calls, and
 *     `runGc` still works.
 *  5. `((InProcessSiloHandle)cluster.Primary!).SiloHost.Services.GetRequiredService<IOptions<DatastoreGcOptions>>()`
 *     has no counterpart (Thresh has no container to resolve out of). The test passes the SAME
 *     options OBJECT to the silo and to `GrainBackedDatastore`, which is what the C# resolution was
 *     for: proving the facade's nominal window tracks the configured value.
 *  6. `IReminderTable.ReadRow(grainId, "mvcc-gc")` -> `cluster.reminderTable.read(grainId, "mvcc-gc")`
 *     on `MemoryReminderTable`, and `((GrainReference)grain).GrainId` ->
 *     `grainReferenceIdentity(grain)!.grainId`. `entry.Period` is a Thresh `Duration` (a plain
 *     object), so it is compared BY VALUE, never by identity.
 *  7. ARITHMETIC. Floors and revisions are nanosecond `bigint`s: `Assert.True(floor > oldHead...)`
 *     is a bigint comparison, and `Assert.Equal(0, headAfter.GcFloor)` is `0n` - a LEGAL floor,
 *     which must not be conflated with `undefined` (`runGc` returns `bigint | undefined`).
 *  8. `await using` -> explicit `try { ... } finally { ... }` for the cluster AND every hub. A
 *     leaked hub leaves a live heartbeat loop running past the end of the test; a leaked cluster is
 *     the orphaned-host hazard in miniature. Nothing here boots a real silo host, and nothing here
 *     touches Docker or Postgres.
 *  9. The C# clusters register no schema at all; the TypeScript grain services demand one, so
 *     {@link SCHEMA} is the minimal `doc#viewer@user` definition these relationships need.
 */

const SCHEMA = `definition user {}

definition doc {
  relation viewer: user
}`;

/** `Relationship.Create(new ObjectAndRelation("doc", rid, "viewer"), new ObjectAndRelation("user", sid, Ellipsis))`. */
function rel(rid: string, sid: string) {
  return createRelationship(
    { objectType: "doc", objectId: rid, relation: "viewer" },
    { objectType: "user", objectId: sid, relation: ELLIPSIS },
  );
}

function create(rid: string, sid: string): RelationshipUpdate {
  return { relationship: rel(rid, sid), operation: "create" };
}

function del(rid: string, sid: string): RelationshipUpdate {
  return { relationship: rel(rid, sid), operation: "delete" };
}

/** `SortedSet<string> LiveIds(IDatastoreReader)` - membership is all the C# ever asks of it. */
async function liveIds(reader: IDatastoreReader): Promise<Set<string>> {
  const set = new Set<string>();
  for await (const r of reader.queryRelationships({}))
    set.add(`${r.reference.resource.objectId}:${r.reference.subject.objectId}`);
  return set;
}

function nanos(revision: IRevision): bigint {
  return (revision as TimestampRevision).timestampNanosSinceEpoch;
}

/**
 * `GcSiloConfigurator`: aggressive, deterministic GC (Window=Zero) with the reminder wired but not
 * relied upon (tests call `runGc()` directly rather than waiting for the reminder to fire).
 */
const gcOptions: DatastoreGcOptions = {
  window: { ms: 0 },
  reminderEnabled: true,
  reminderPeriod: MINIMUM_REMINDER_PERIOD,
};

/**
 * `HugeWindowSiloConfigurator`: comfortably longer than elapsed Unix-epoch time (~56 years), safely
 * under the long-range overflow the ms->nanos conversion could hit.
 */
const hugeWindowOptions: DatastoreGcOptions = {
  window: { days: 365 * 200 },
  reminderEnabled: false,
};

/**
 * `RealWindowSiloConfigurator`: a realistic (multi-hour) retention window - `runGc` still flows a GC
 * event through the log, but the floor never approaches "just now", so a cursor minted moments ago
 * stays valid.
 */
const realWindowOptions: DatastoreGcOptions = {
  window: { hours: 24 },
  reminderEnabled: false,
};

/**
 * `ShortWindowSiloConfigurator`: a short (millisecond) NOMINAL window, reminder disabled - so
 * `runGc` is never invoked and the REAL `gcFloor` stays 0 for the whole test.
 */
const shortWindowOptions: DatastoreGcOptions = {
  window: { ms: 50 },
  reminderEnabled: false,
};

interface GcCluster {
  readonly cluster: TestCluster;
  readonly client: ClientNode;
  readonly grain: IDatastoreGrain;
}

/** The C#'s `NewClusterAsync<TConfigurator>()`, with the configurator's ONE varying value as an argument. */
async function buildCluster(
  options: DatastoreGcOptions,
  silo?: { reminders?: boolean },
): Promise<GcCluster> {
  const storage = new MemoryGrainStorage();
  let services!: SpiceportGrainServices;
  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: SPICEPORT_GRAIN_REGISTRATIONS,
    ...(silo?.reminders !== undefined ? { reminders: silo.reminders } : {}),
    configureSilo: (builder) => {
      builder.addStorage("datastore", storage);
      let datastore: IDatastore | undefined;
      services = addSpiceportGrainServices(builder, {
        schemaText: SCHEMA,
        datastoreStorage: storage,
        datastoreGcOptions: options,
        datastore: () =>
          (datastore ??= new GrainBackedDatastore(
            services.grainFactory,
            services.hub,
            undefined,
            undefined,
            options,
          )),
      });
    },
  });
  // `cluster.GrainFactory` - the TestCluster CLIENT, which carries the observer surface the watch
  // hub mints its reference from (a silo host offers `getGrain` but not `createObjectReference`).
  const client = await cluster.client;
  return { cluster, client, grain: client.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY) };
}

async function disposeAll(scope: GcCluster, ...hubs: readonly LogWatchHub[]): Promise<void> {
  for (const hub of hubs) await hub.dispose();
  await scope.cluster.dispose();
}

describe("DatastoreGcMeshTests", () => {
  it("RunGc_appends_a_log_event_advances_head_and_collects_dead_rows", async () => {
    const scope = await buildCluster(gcOptions);
    const hub = createIsolatedWatchHub(scope.client);
    try {
      const ds: IDatastore = new GrainBackedDatastore(scope.client, hub);
      const grain = scope.grain;

      await ds.readWriteTx((tx) =>
        tx.writeRelationships([create("a", "alice"), create("b", "bob")]),
      );
      await ds.readWriteTx((tx) => tx.writeRelationships([del("a", "alice")])); // "a" now dead

      const headBefore = (await grain.getHead()).head;

      const floor = await grain.runGc();

      expect(floor).not.toBeUndefined();
      const head = await grain.getHead();
      expect(head.head > headBefore).toBe(true);
      expect(datastoreHeadWireGcFloor(head)).toBe(floor);

      const state = await grain.readState();
      expect(state.gcFloor).toBe(floor);
      // dead row collected
      expect(state.relationships.some((r) => r.relationship.resourceId === "a")).toBe(false);
      // live row kept
      expect(state.relationships.some((r) => r.relationship.resourceId === "b")).toBe(true);
    } finally {
      await disposeAll(scope, hub);
    }
  }, 60_000);

  /**
   * The no-op guard (`floor <= currentFloor` => return undefined, no event appended, head
   * unchanged): with a retention window LONGER than elapsed Unix-epoch time, `now - window`
   * underflows below the initial floor of 0 on every call, so `runGc` never actually has anything
   * new to collect. (A realistic window can never reach this branch on a live cluster - see the
   * other tests in this file - because runGc's own GC event keeps minting a fresh head, which
   * itself becomes the next call's floor candidate. This deliberately-oversized window isolates the
   * guard itself.)
   */
  it("RunGc_is_a_no_op_when_the_window_exceeds_elapsed_epoch_time", async () => {
    const scope = await buildCluster(hugeWindowOptions);
    const hub = createIsolatedWatchHub(scope.client);
    try {
      const ds: IDatastore = new GrainBackedDatastore(scope.client, hub);
      const grain = scope.grain;

      await ds.readWriteTx((tx) => tx.writeRelationships([create("a", "alice")]));
      await ds.readWriteTx((tx) => tx.writeRelationships([del("a", "alice")]));

      const headBefore = await grain.getHead();

      const result = await grain.runGc();

      expect(result).toBeUndefined();
      const headAfter = await grain.getHead();
      expect(headAfter.head).toBe(headBefore.head); // no event was appended
      expect(datastoreHeadWireGcFloor(headAfter)).toBe(0n);
    } finally {
      await disposeAll(scope, hub);
    }
  }, 60_000);

  it("Second_datastore_instance_observes_gc_results_through_the_grain", async () => {
    const scope = await buildCluster(gcOptions);
    const gf = scope.client;
    // Two ISOLATED instances: "reader" can only observe rows (and their collection) through the
    // singleton grain's state, never by sharing "writer"'s in-memory transaction state.
    const writerHub = createIsolatedWatchHub(gf);
    const readerHub = createIsolatedWatchHub(gf);
    try {
      const writer: IDatastore = new GrainBackedDatastore(gf, writerHub);
      const reader: IDatastore = new GrainBackedDatastore(gf, readerHub); // a SEPARATE facade instance
      const grain = scope.grain;

      const rev1 = await writer.readWriteTx((tx) => tx.writeRelationships([create("a", "alice")]));

      // A pre-GC reader on the second instance sees the row live at its revision.
      const before = await liveIds(reader.snapshotReader(rev1));
      expect(before.has("a:alice")).toBe(true);

      await writer.readWriteTx((tx) => tx.writeRelationships([del("a", "alice")]));
      const floor = await grain.runGc();
      expect(floor).not.toBeUndefined();

      const head = await writer.headRevision();
      const after = await liveIds(reader.snapshotReader(head.revision));
      expect(after.has("a:alice")).toBe(false);
    } finally {
      await disposeAll(scope, readerHub, writerHub);
    }
  }, 60_000);

  it("Reader_pinned_below_the_floor_is_rejected_on_first_read", async () => {
    // The floor rejection is the MvccSnapshotReader ctor guard over the state fetched from the
    // sequencer on the reader's FIRST query (see GrainBackedDatastore.snapshotReader). That state
    // always carries the sequencer's current gcFloor, so a below-floor pin is rejected immediately -
    // there is no deferred-error window (that bounded-lag contract belonged to the retired per-silo
    // projection; the per-shard analogue is pinned by ShardedReaderEquivalenceTests'
    // Gc_Floor_Is_Enforced_Through_The_Shard_Grain).
    const scope = await buildCluster(gcOptions);
    const hub = createIsolatedWatchHub(scope.client);
    try {
      const ds: IDatastore = new GrainBackedDatastore(scope.client, hub);
      const grain = scope.grain;

      const oldHead = await ds.headRevision(); // strictly before the write below, so below the post-GC floor
      await ds.readWriteTx((tx) => tx.writeRelationships([create("a", "alice")]));

      const floor = await grain.runGc();
      expect(floor).not.toBeUndefined();
      expect(floor! > nanos(oldHead.revision)).toBe(true);

      const reader = ds.snapshotReader(oldHead.revision);
      await expect(
        (async () => {
          for await (const _ of reader.queryRelationships({})) {
            // drained for the throw
          }
        })(),
      ).rejects.toThrow(RevisionNotFoundException);

      // A reader pinned AT (or above) the floor still serves: the retained rows are intact.
      const head = await ds.headRevision();
      const live = await liveIds(ds.snapshotReader(head.revision));
      expect(live.has("a:alice")).toBe(true);
    } finally {
      await disposeAll(scope, hub);
    }
  }, 60_000);

  it("Watch_parked_before_a_gc_event_keeps_working_and_the_gc_event_itself_emits_nothing", async () => {
    // A REAL (multi-hour) window: runGc still mints a GC LogEvent (advancing the head, exercising
    // the Watch-over-a-content-free-event path), but its floor stays far in the past, so the cursor
    // parked moments ago is never retroactively invalidated (unlike the aggressive Window=Zero
    // clusters used to test the floor-rejection behavior itself, below).
    const scope = await buildCluster(realWindowOptions);
    const gf = scope.client;
    const watcherHub = createIsolatedWatchHub(gf);
    const committerHub = createIsolatedWatchHub(gf);
    // `new CancellationTokenSource(TimeSpan.FromSeconds(30))`.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try {
      const watcher = new GrainBackedDatastore(gf, watcherHub);
      const committer = new GrainBackedDatastore(gf, committerHub);
      const grain = scope.grain;

      const head = (await watcher.headRevision()).revision;

      let resolveFirst!: (change: RevisionChange) => void;
      let rejectFirst!: (error: unknown) => void;
      const first = new Promise<RevisionChange>((resolve, reject) => {
        resolveFirst = resolve;
        rejectFirst = reject;
      });
      const consume = (async () => {
        try {
          for await (const change of watcher.watch(
            head,
            { content: WatchContent.relationships },
            controller.signal,
          )) {
            resolveFirst(change);
            break;
          }
        } catch (error) {
          if (!controller.signal.aborted) rejectFirst(error);
        }
      })();

      // Let the stream park (and the hub's heartbeat register the observer), THEN run GC. A GC event
      // carries no relationship content, so it must not surface as a Watch item on its own.
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const floor = await grain.runGc();
      expect(floor).not.toBeUndefined();

      // A commit made AFTER the GC event must still be delivered to the consumer parked before it.
      await committer.readWriteTx((tx) => tx.writeRelationships([create("z", "zed")]));

      const observed = await Promise.race([
        first,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("watch did not deliver within 20s")), 20_000),
        ),
      ]);
      controller.abort();
      await consume;

      expect(observed.relationshipChanges).toHaveLength(1);
      const change = observed.relationshipChanges[0]!;
      expect(change.relationship.reference.resource.objectId).toBe("z");
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await disposeAll(scope, committerHub, watcherHub);
    }
  }, 120_000);

  it("New_watch_from_a_cursor_below_the_floor_throws", async () => {
    const scope = await buildCluster(gcOptions);
    const hub = createIsolatedWatchHub(scope.client);
    try {
      const ds: IDatastore = new GrainBackedDatastore(scope.client, hub);
      const grain = scope.grain;

      const oldHead = await ds.headRevision();
      await ds.readWriteTx((tx) => tx.writeRelationships([create("a", "alice")]));

      const floor = await grain.runGc();
      expect(floor).not.toBeUndefined();

      await expect(
        (async () => {
          for await (const _ of ds.watch(oldHead.revision, {
            content: WatchContent.relationships,
          })) {
            break;
          }
        })(),
      ).rejects.toThrow(RevisionNotFoundException);
    } finally {
      await disposeAll(scope, hub);
    }
  }, 60_000);

  /**
   * Regression test for the bug where `GrainBackedDatastore` AND'd the real `gcFloor` with its OWN
   * hardcoded 24h nominal window, completely independent of the configured
   * `DatastoreGcOptions.window`. Wiring `GrainBackedDatastore` with the SAME options the grain silo
   * is configured with (as production now does) means a 50ms window rejects a revision once the
   * HEAD has moved more than 50ms past it, EVEN THOUGH the real `gcFloor` is still 0 (no reminder,
   * no manual `runGc` ever ran) - proving the nominal window actually tracks the configured value
   * rather than a stale, independently-hardcoded default. (The nominal-window bound is checked
   * against the current HEAD, not wall-clock "now", so the head must actually advance past the
   * window for the check to bite - a second write after the delay does that.)
   */
  it("CheckRevision_and_Watch_honor_the_configured_window_not_a_hardcoded_default", async () => {
    const scope = await buildCluster(shortWindowOptions);
    const gf = scope.client;
    const hub = createIsolatedWatchHub(gf);
    try {
      const grain = scope.grain;
      // Port decision 5: the SAME options object the silo was configured with.
      const ds: IDatastore = new GrainBackedDatastore(
        gf,
        hub,
        undefined,
        undefined,
        shortWindowOptions,
      );

      const revision = await ds.readWriteTx((tx) => tx.writeRelationships([create("a", "alice")]));

      // Immediately: within the 50ms window, so both checks pass.
      expect(await ds.checkRevision(revision)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Advance the head with a second write, minted from the current (300ms-later) wall clock, so
      // the nominal window's "head - window" bound moves past the first revision. The real gcFloor
      // never moved (no reminder, no manual runGc) - the data is still fully present - but the
      // nominal window has now elapsed relative to head, so checkRevision must reject the stale
      // revision and watch must refuse to resume from it, exactly as it would for
      // ReferenceDatastore/SpiceDB API-parity.
      await ds.readWriteTx((tx) => tx.writeRelationships([create("b", "bob")]));

      expect(datastoreHeadWireGcFloor(await grain.getHead())).toBe(0n);
      expect(await ds.checkRevision(revision)).toBe(false);
      await expect(
        (async () => {
          for await (const _ of ds.watch(revision, { content: WatchContent.relationships })) {
            break;
          }
        })(),
      ).rejects.toThrow(RevisionNotFoundException);
    } finally {
      await disposeAll(scope, hub);
    }
  }, 60_000);

  it("Reminder_is_registered_after_activation", async () => {
    const scope = await buildCluster(gcOptions);
    try {
      const grain = scope.grain;

      // Force activation (any call does), then inspect the reminder table directly - the reminder
      // registration itself is not observable through the grain's own public surface.
      await grain.getHead();

      const reminderTable = scope.cluster.reminderTable;
      const grainId: GrainId = grainReferenceIdentity(grain)!.grainId;

      const entry = await reminderTable.read(grainId, "mvcc-gc");

      expect(entry).not.toBeUndefined();
      expect(entry!.name).toBe("mvcc-gc");
      // Port decision 6: a Duration is a plain object - compared BY VALUE.
      expect(entry!.period).toEqual(MINIMUM_REMINDER_PERIOD);
    } finally {
      await disposeAll(scope);
    }
  }, 60_000);

  it("Activation_without_a_reminder_service_does_not_throw", async () => {
    // The try/catch gate in DatastoreGrain.onActivate: this cluster has NO reminder service at all
    // (port decision 4), yet the grain must still activate and serve calls normally.
    const scope = await buildCluster({ window: { ms: 0 } }, { reminders: false });
    const hub = createIsolatedWatchHub(scope.client);
    try {
      const ds: IDatastore = new GrainBackedDatastore(scope.client, hub);
      const grain = scope.grain;

      await ds.readWriteTx((tx) => tx.writeRelationships([create("a", "alice")]));
      const floor = await grain.runGc(); // runGc itself remains fully usable without the reminder service
      expect(floor).not.toBeUndefined();
      // Guards port decision 4: the silo really has no reminder service, rather than one whose
      // registration merely failed - nothing reached the cluster's reminder table.
      const grainId: GrainId = grainReferenceIdentity(grain)!.grainId;
      expect(await scope.cluster.reminderTable.read(grainId, "mvcc-gc")).toBeUndefined();
    } finally {
      await disposeAll(scope, hub);
    }
  }, 60_000);
});
