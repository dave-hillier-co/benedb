import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import type { StorageBackend } from "@thresh/hosting/storage-backend";
import { TestCluster } from "@thresh/testing/test-cluster";

import {
  durableBackendAvailable,
  durableBackendSkipReason,
  useDurableBackend,
} from "./durable-backend-fixture";
import type { DatastoreGcOptions } from "./datastore-gc-options";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import type { SpiceportGrainServices } from "./service-collection-extensions";
import {
  addSpiceportGrainServices,
  SPICEPORT_GRAIN_REGISTRATIONS,
} from "./service-collection-extensions";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/Durability/DatastoreGrainDurabilityTests.cs`.
 *
 * The load-bearing durability gate: proves the singleton `DatastoreGrain`'s state is DURABLE over a
 * GENUINE reactivation when backed by Postgres grain storage.
 *
 * TRUE reactivation method: write through cluster A, fully dispose it (kills the silo, the grain
 * directory, and the single in-memory activation), then build a BRAND-NEW cluster B over the SAME
 * durable backend and read back. Cluster B shares no memory whatsoever with A, so the only path for
 * the data to reappear is a real read from Postgres. This is strictly stronger than
 * `forceActivationCollection` (same-process reactivation, which `thin-sequencer-tests` already
 * covers): a fresh cluster cannot be fooled by a warm activation or a leftover in-process value.
 *
 * NEGATIVE CONTROL: the grain seeds a fresh head ONLY when its journal is empty. If durable state were lost, cluster B's activation would re-seed a fresh,
 * LARGER head with zero relationships - so the head-equality and relationship-count assertions
 * below are exactly what makes this test FAIL on data loss rather than silently pass.
 *
 * PORT DECISIONS.
 *
 *  1. THE BACKEND IS THRESH'S. `siloBuilder.AddDatastoreGrainStorage(config)` becomes
 *     `TestCluster.start({ storageBackend })` over the durable backend `durable-backend-fixture`
 *     supplies: every provider - the datastore grain's journal, the shard and index grains'
 *     `datastore` storage - lives there, and this suite never touches the database itself.
 *  2. ISOLATION BY SERVICE ID, as in the C#. Every Thresh provider keys its rows by the silo's
 *     service id, so cluster A and cluster B of ONE test share a fresh id ({@link freshServiceId})
 *     and no two tests do. Rows are left behind under ids nothing reads again.
 *  3. `AddStateStorageBasedLogConsistencyProvider("StateStorage")` has no counterpart: a Thresh
 *     `JournaledGrain` persists through the silo's journal provider, here the backend's.
 *  4. THE BINARY-SERIALIZER ASSERTION IS DROPPED, AND ONLY IT.
 *     `Assert.IsType<OrleansGrainStorageSerializer>(options.GrainStorageSerializer)` has no
 *     analogue: Thresh has ONE storage codec (`@thresh/core/value-codec`), so there is no
 *     JSON-vs-binary choice to pin. What that assertion actually PROTECTED - boxed caveat context
 *     surviving the round trip - is asserted directly and in full below. The port carries caveat
 *     context as a decoded `ReadonlyMap`, so `((JsonElement)ctx["region"]).GetRawText() == "\"eu\""`
 *     becomes `ctx.get("region") === "eu"` and `"7"` becomes `7`.
 *  5. `cluster.GrainFactory` -> `await cluster.client` (Thresh's `TestCluster` client, registered
 *     with the same grain list the silos host), NOT a silo container's factory - the same
 *     distinction `MeshTestCluster.grainFactory` documents.
 *  6. `await cluster.DisposeAsync()` in a `finally` on EVERY cluster: each test builds TWO, and a
 *     leaked cluster is the orphaned-host hazard in miniature. Nothing here boots a silo host.
 *  7. `[SkippableFact]` + `Skip.IfNot(_fixture.Available, _fixture.SkipReason)` ->
 *     `it(name, (ctx) => { ctx.skip(!available, reason); ... })`, which is what keeps the REASON
 *     (`it.skipIf` drops it).
 */

const SCHEMA = `definition user {}

caveat is_active(level int) {
  level > 0
}

definition doc {
  relation viewer: user | user with is_active
}`;

/** `private static readonly DateTimeOffset Expiry = new(2030, 1, 1, 0, 0, 0, TimeSpan.Zero)`. */
const EXPIRY = BigInt(Date.UTC(2030, 0, 1, 0, 0, 0)) * 1_000_000n;

const fixture = useDurableBackend();

/** One cluster's handles: the C#'s `Datastore(cluster)` / `GcGrain(cluster)` accessors. */
interface DurabilityCluster {
  readonly cluster: TestCluster;
  readonly datastore: IDatastore;
  readonly grain: IDatastoreGrain;
}

/**
 * `BuildAdoNetClusterAsync` / `BuildGcAdoNetClusterAsync` (the two differ only by the GC options,
 * so they fold into one builder with an optional argument - the C# duplicated the configurator only
 * because Orleans instantiates `ISiloConfigurator` BY TYPE and could not close over a value).
 */
async function buildCluster(
  backend: StorageBackend,
  serviceId: string,
  gcOptions?: DatastoreGcOptions | undefined,
): Promise<DurabilityCluster> {
  let services!: SpiceportGrainServices;
  let datastore: IDatastore | undefined;
  const cluster = await TestCluster.start({
    initialSilos: 1,
    serviceId,
    storageBackend: backend,
    grains: SPICEPORT_GRAIN_REGISTRATIONS,
    configureSilo: (builder) => {
      services = addSpiceportGrainServices(builder, {
        schemaText: SCHEMA,
        // The host-owned `IDatastore`, over the DI-singleton watch hub the grain services
        // registered - exactly the C#'s `services.AddSingleton<IDatastore>(sp => new
        // GrainBackedDatastore(...))`, including its `gcOptions:` argument, which must track the
        // SAME options the grain is configured with.
        datastore: () =>
          (datastore ??= new GrainBackedDatastore(
            services.grainFactory,
            services.hub,
            undefined,
            undefined,
            gcOptions,
          )),
        ...(gcOptions !== undefined ? { datastoreGcOptions: gcOptions } : {}),
      });
    },
  });
  const client = await cluster.client;
  return {
    cluster,
    datastore: services.datastore,
    grain: client.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY),
  };
}

/** A per-test service id (port decision 2): cluster A and B of one test share it; no two tests do. */
function freshServiceId(): string {
  return `benedb-durability-${randomUUID()}`;
}

function nanos(revision: IRevision): bigint {
  return (revision as TimestampRevision).timestampNanosSinceEpoch;
}

function row(docId: string, userId: string): Relationship {
  return createRelationship(
    { objectType: "doc", objectId: docId, relation: "viewer" },
    { objectType: "user", objectId: userId, relation: ELLIPSIS },
  );
}

/** `JsonSerializer.Deserialize<Dictionary<string, object?>>("""{"region":"eu","level":7}""")`. */
function caveatContext(): ReadonlyMap<string, unknown> {
  return new Map<string, unknown>([
    ["region", "eu"],
    ["level", 7],
  ]);
}

describe.sequential("DatastoreGrainDurabilityTests", () => {
  it("GrainState_Survives_TrueReactivation_FromPostgres", async (ctx) => {
    ctx.skip(!durableBackendAvailable, durableBackendSkipReason);
    const backend = fixture();
    const serviceId = freshServiceId();
    let writtenHead: bigint;

    // --- Phase 1: write through cluster A, then fully dispose it. ---
    const a = await buildCluster(backend, serviceId);
    try {
      const dsA = a.datastore;
      const schemaBytes = new TextEncoder().encode(SCHEMA);

      const revision = await dsA.readWriteTx(async (tx) => {
        await tx.writeStoredSchema(schemaBytes);

        await tx.writeRelationships([
          // (a) a plain relationship.
          { relationship: row("plain", "alice"), operation: "create" },
          // (b) a caveated relationship with a populated context.
          {
            relationship: createRelationship(
              { objectType: "doc", objectId: "caveated", relation: "viewer" },
              { objectType: "user", objectId: "bob", relation: ELLIPSIS },
              { caveatName: "is_active", context: caveatContext() },
            ),
            operation: "create",
          },
          // (c) a relationship with an expiration.
          {
            relationship: createRelationship(
              { objectType: "doc", objectId: "expiring", relation: "viewer" },
              { objectType: "user", objectId: "carol", relation: ELLIPSIS },
              undefined,
              EXPIRY,
            ),
            operation: "create",
          },
        ]);

        await tx.writeCounter("doc_viewers", {
          optionalResourceType: "doc",
          optionalResourceRelation: "viewer",
        });
      });

      writtenHead = nanos(revision);
    } finally {
      await a.cluster.dispose();
    }

    // --- Phase 2: read through a BRAND-NEW cluster B over the same backend (TRUE reactivation). ---
    const b = await buildCluster(backend, serviceId);
    try {
      const dsB = b.datastore;

      // Negative control: head must equal the written head. If state were lost the grain
      // re-seeds an empty state => a DIFFERENT, larger head and zero relationships.
      const head = await dsB.headRevision();
      expect(nanos(head.revision)).toBe(writtenHead);

      const reader = dsB.snapshotReader(head.revision);

      // All three relationships present (count is the second lost-state tripwire).
      const rels: Relationship[] = [];
      for await (const rel of reader.queryRelationships({ optionalResourceType: "doc" }))
        rels.push(rel);
      expect(rels).toHaveLength(3);

      const plainRead = rels.find((r) => r.reference.resource.objectId === "plain")!;
      expect(plainRead.reference.resource.relation).toBe("viewer");
      expect(plainRead.reference.subject.objectType).toBe("user");
      expect(plainRead.reference.subject.objectId).toBe("alice");
      expect(plainRead.optionalCaveat).toBeUndefined();
      expect(plainRead.optionalExpiration).toBeUndefined();

      // Caveat context survived per key (port decision 4).
      const caveatedRead = rels.find((r) => r.reference.resource.objectId === "caveated")!;
      expect(caveatedRead.optionalCaveat).toBeDefined();
      expect(caveatedRead.optionalCaveat!.caveatName).toBe("is_active");
      const context = caveatedRead.optionalCaveat!.context;
      expect(context).toBeDefined();
      expect(context!.get("region")).toBe("eu");
      expect(context!.get("level")).toBe(7);

      // Expiration survived exactly.
      const expiringRead = rels.find((r) => r.reference.resource.objectId === "expiring")!;
      expect(expiringRead.optionalExpiration).toBe(EXPIRY);

      // Schema bytes survived.
      const schema = await reader.readStoredSchema();
      expect(schema).toBeDefined();
      expect(schema).toEqual(new TextEncoder().encode(SCHEMA));
      // Schema hash at head is defined (a schema was written).
      expect(head.schemaHash).toBeDefined();

      // Counter filter survived.
      const counterFilterRead = await reader.readCounterFilter("doc_viewers");
      expect(counterFilterRead).toBeDefined();
      expect(counterFilterRead!.optionalResourceType).toBe("doc");
      expect(counterFilterRead!.optionalResourceRelation).toBe("viewer");
      expect(await reader.countRelationships("doc_viewers")).toBe(3n);
    } finally {
      await b.cluster.dispose();
    }
  }, 300_000);

  /**
   * Crosses the snapshot/compaction interval (> 64 commits) so reactivation must rebuild from a
   * COMPACTED snapshot + a post-snapshot log tail (not the version-0 seed). Proves snapshot
   * serialization of a non-empty state (incl. caveat context written BEFORE the snapshot boundary,
   * so it can only survive through the snapshot), the compaction loop, and replay-from-compacted-
   * snapshot.
   */
  it("GrainState_Survives_Reactivation_AcrossSnapshotCompaction", async (ctx) => {
    ctx.skip(!durableBackendAvailable, durableBackendSkipReason);
    const backend = fixture();
    const serviceId = freshServiceId();
    const commits = 70; // > the flush interval (64): forces at least one snapshot + compaction.
    let writtenHead: bigint;

    const a = await buildCluster(backend, serviceId);
    try {
      const dsA = a.datastore;

      // Commit 0: a caveated relationship, written FIRST so it is subsumed into the compacted
      // snapshot.
      await dsA.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              { objectType: "doc", objectId: "early", relation: "viewer" },
              { objectType: "user", objectId: "alice", relation: ELLIPSIS },
              { caveatName: "is_active", context: caveatContext() },
            ),
            operation: "create",
          },
        ]),
      );

      // Commits 1..68: one relationship each, crossing the snapshot boundary.
      let last = 0n;
      for (let i = 1; i < commits; i += 1) {
        const rev = await dsA.readWriteTx((tx) =>
          tx.writeRelationships([{ relationship: row(`r${i}`, `u${i}`), operation: "create" }]),
        );
        last = nanos(rev);
      }
      writtenHead = last;
    } finally {
      await a.cluster.dispose();
    }

    // Reactivate via a brand-new cluster: state must rebuild from the compacted snapshot + tail.
    const b = await buildCluster(backend, serviceId);
    try {
      const dsB = b.datastore;

      const head = await dsB.headRevision();
      expect(nanos(head.revision)).toBe(writtenHead);

      const reader = dsB.snapshotReader(head.revision);
      const rels: Relationship[] = [];
      for await (const rel of reader.queryRelationships({ optionalResourceType: "doc" }))
        rels.push(rel);
      expect(rels).toHaveLength(commits); // all relationships survived snapshot+compaction

      // The pre-boundary caveat row survived through the SNAPSHOT with its context intact.
      const early = rels.find((r) => r.reference.resource.objectId === "early")!;
      expect(early.optionalCaveat!.caveatName).toBe("is_active");
      expect(early.optionalCaveat!.context!.get("region")).toBe("eu");
      expect(early.optionalCaveat!.context!.get("level")).toBe(7);
    } finally {
      await b.cluster.dispose();
    }
  }, 300_000);

  /**
   * The GC-specific durability gate: commits rows, deletes some, runs `runGc` (collecting the dead
   * rows and stamping a GC floor), then proves BOTH survive a TRUE reactivation - the collected
   * relationship set AND the floor itself, which is only durable if it round-trips through the
   * snapshot/log exactly like any other event.
   *
   * The GC window is `TimeSpan.Zero` so a single `runGc` deterministically collects everything dead
   * as of the current head. No reminder service is registered on this cluster (`runGc` is invoked
   * directly, never via the reminder), which also doubles as proof that a durable Postgres-backed
   * host with no reminder service still activates.
   */
  it("GcFloor_And_CollectedState_Survive_TrueReactivation_FromPostgres", async (ctx) => {
    ctx.skip(!durableBackendAvailable, durableBackendSkipReason);
    const backend = fixture();
    const serviceId = freshServiceId();
    const gcOptions: DatastoreGcOptions = { window: { ms: 0 }, reminderEnabled: false };
    let writtenHead: bigint;
    let writtenFloor: bigint;

    const a = await buildCluster(backend, serviceId, gcOptions);
    try {
      const dsA = a.datastore;
      const grainA = a.grain;

      await dsA.readWriteTx((tx) =>
        tx.writeRelationships([
          { relationship: row("dead", "alice"), operation: "create" },
          { relationship: row("alive", "bob"), operation: "create" },
        ]),
      );

      await dsA.readWriteTx((tx) =>
        tx.writeRelationships([{ relationship: row("dead", "alice"), operation: "delete" }]),
      );

      const floor = await grainA.runGc();
      expect(floor).toBeDefined();
      writtenFloor = floor!;

      const head = await dsA.headRevision();
      writtenHead = nanos(head.revision);

      // Collected in cluster A itself, before any reactivation.
      const stateA = await grainA.readState();
      expect(stateA.gcFloor).toBe(writtenFloor);
      expect(stateA.relationships.some((r) => r.relationship.resourceId === "dead")).toBe(false);
      expect(stateA.relationships.some((r) => r.relationship.resourceId === "alive")).toBe(true);
    } finally {
      await a.cluster.dispose();
    }

    // --- TRUE reactivation: a brand-new cluster over the same backend. ---
    const b = await buildCluster(backend, serviceId, gcOptions);
    try {
      const dsB = b.datastore;
      const grainB = b.grain;

      const head = await dsB.headRevision();
      expect(nanos(head.revision)).toBe(writtenHead);

      const stateB = await grainB.readState();
      expect(stateB.gcFloor).toBe(writtenFloor); // the floor itself is durable

      const reader = dsB.snapshotReader(head.revision);
      const rels: Relationship[] = [];
      for await (const rel of reader.queryRelationships({ optionalResourceType: "doc" }))
        rels.push(rel);

      expect(rels).toHaveLength(1); // "dead" stayed collected; only "alive" survives
      expect(rels[0]!.reference.resource.objectId).toBe("alive");

      // A read pinned below the (durable) floor is rejected exactly as it would be
      // pre-reactivation.
      await expect(
        (async () => {
          const stale = dsB.snapshotReader(new TimestampRevision(writtenFloor - 1n));
          for await (const _ of stale.queryRelationships({})) {
            // drained for the throw
          }
        })(),
      ).rejects.toThrow(RevisionNotFoundException);
    } finally {
      await b.cluster.dispose();
    }
  }, 300_000);
});
