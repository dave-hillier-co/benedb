import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { UpdateOperation } from "@spacedb/core/relationship-update";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@spacedb/datastore/datastore-exceptions";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import type { RevisionChange } from "@spacedb/datastore/watch";
import { WatchContent } from "@spacedb/datastore/watch";
import { grainReferenceIdentity } from "@thresh/core/grain-reference";
import { GrainId } from "@thresh/core/grain-id";
import { getGrainMetadata } from "@thresh/core/grain-metadata";
import type { GrainStorage, StateHolder } from "@thresh/core/grain-storage";
import { PostgresGrainStorage } from "@thresh/persistence/postgres-grain-storage";
import { TestCluster } from "@thresh/testing/test-cluster";

import {
  adoNetDatastoreAvailable,
  adoNetDatastoreSkipReason,
  useAdoNetDatastore,
} from "./ado-net-datastore-fixture.test";
import type { CounterVersionWire, LogHeadEntry, StoredRelationshipWire } from "./datastore-dtos";
import type { DatastoreGcOptions } from "./datastore-gc-options";
import type { DatastoreGrainState } from "./datastore-grain-state";
import type {
  DatastoreMetaEntry,
  DatastoreMetaState,
  KeyIndexBucketEntry,
  KeyIndexDeltaEntry,
} from "./datastore-meta-state";
import { keyIndexLayoutBucketOf } from "./datastore-meta-state";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import type { GraphShardKeyWire } from "./graph-shard-key";
import { graphShardKeyForResource, graphShardKeyForSubject } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import { DatastoreGrain } from "./datastore-grain";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import type { LogEvent } from "./log-event";
import type { SpiceportGrainServices } from "./service-collection-extensions";
import {
  addSpiceportGrainServices,
  SPICEPORT_GRAIN_REGISTRATIONS,
} from "./service-collection-extensions";
import { computeStoredSchemaHash } from "./stored-schema-hash";
import { toFullFilter, toWire } from "./wire-convert";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/Durability/ThinLayoutDurabilityTests.cs`.
 *
 * ONE C# FILE, THREE test classes - `NewLayoutRestartDurabilityTests`,
 * `LegacyMigrationDurabilityTests`, `InlineIndexMigrationDurabilityTests` - and the ledger gives ONE
 * target, so all three land here as three `describe.sequential` blocks. The two MIGRATION classes
 * are the harder half of the file and are ported in full: each SEEDS a database in a RETIRED layout
 * by writing rows DIRECTLY through the same storage provider the grain uses, then proves the
 * reworked grain migrates IN PLACE on its first activation.
 *
 * The retired row SHAPES are therefore reconstructed here from the ported `datastore-grain-state.ts`
 * / `datastore-meta-state.ts` types: `DatastoreGrainState` still exists (it is the assembled
 * whole-state reply of `readState`, and what the v0 snapshot row held), and `DatastoreMetaEntry`'s
 * `indexLayout` is still OPTIONAL, which is exactly what marks a v1 row. `datastore-grain.ts` keeps
 * both migration paths (`#migrateLegacySnapshot`, `#migrateInlineIndex`), so both classes have a
 * live subject.
 *
 * PORT DECISIONS (see `datastore-grain-durability-tests.test.ts` for 1-7, which apply unchanged:
 * no silo package so `PostgresGrainStorage` is constructed directly; a UNIQUE TABLE per test rather
 * than a per-test `ServiceId`, which does not isolate on Thresh; no custom-storage log-consistency
 * provider to register; `await cluster.client` for the C#'s `cluster.GrainFactory`; an explicit
 * `finally { await cluster.dispose() }` per cluster; and `ctx.skip(!available, reason)` so the skip
 * REASON survives).
 *
 *  8. STORAGE ROW ACCESS. `GetRequiredKeyedService<IGrainStorage>(providerName)` has no counterpart
 *     (Thresh has no keyed DI): the test OWNS the provider it hands the silo, so {@link readRow} /
 *     {@link writeRow} go straight to it - the same handle the grain writes through, never a
 *     duplicate store that would grade rows nothing wrote. `((GrainReference)grain).GrainId` ->
 *     `grainReferenceIdentity(grain).grainId`. State NAMES are storage-visible strings and are
 *     transcribed VERBATIM: `head`, `meta/{v}`, `snapshot/{v}`, `log/{v}`, `shard/{v}/{key}`,
 *     `indexb/{v}/{dir}/{bucket}`, `indexd/{v}`.
 *  9. THE `Live*` SENTINELS ARE KEPT, and they are now stricter than they need to be. The C# needs
 *     them because AdoNet's "clear" NULLS the payload and KEEPS the row, so `RecordExists` stays
 *     true for a cleared row; Thresh's `PostgresGrainStorage.clear` DELETES the row, so `exists`
 *     alone would answer. Keeping the payload sentinel costs nothing and keeps the assertions
 *     reading as the C#'s do - and it is the assertion that would still hold if the provider ever
 *     switched to a tombstoning clear.
 * 10. Caveat context is a decoded `ReadonlyMap`, so `((JsonElement)ctx["region"]).GetRawText() ==
 *     "\"eu\""` becomes `ctx.get("region") === "eu"` (port decision 4 of the sibling file).
 * 11. THE 1h GC WINDOW IS KEPT EXACTLY. It is chosen so `runGc` appends a REAL GC event whose floor
 *     (`now - 1h`) sits far below every revision the test mints: the test gets a durable non-zero
 *     floor to assert below-floor rejection against WITHOUT invalidating its own Watch cursor.
 */

const SCHEMA = `definition user {}

caveat is_active(level int) {
  level > 0
}

definition doc {
  relation viewer: user | user with is_active
}`;

/** `private static readonly DateTimeOffset Expiry = new(2032, 3, 1, 0, 0, 0, TimeSpan.Zero)`. */
const EXPIRY = BigInt(Date.UTC(2032, 2, 1, 0, 0, 0)) * 1_000_000n;

/** The flush interval the storage-level probes are stated in (`docs/graph-sharded-datastore.md`). */
const FLUSH_INTERVAL = 64;

const fixture = useAdoNetDatastore();

/**
 * `(DateTimeOffset.UtcNow - DateTimeOffset.UnixEpoch).Ticks * 100L` - the seed head the two
 * migration cases stamp their legacy state with. The same sub-millisecond clock `datastore-grain.ts`
 * mints revisions from (`performance.timeOrigin + performance.now()`), because a seeded head must be
 * comparable with the revisions the grain mints after migration; `Date.now()` would quantise to the
 * millisecond and make "2ms before head" a coarser statement than the C#'s.
 */
const CLOCK_ORIGIN_NANOS = BigInt(Math.round(performance.timeOrigin)) * 1_000_000n;
function nowNanos(): bigint {
  return CLOCK_ORIGIN_NANOS + BigInt(Math.round(performance.now() * 1_000_000));
}

/** One cluster's handles: the C#'s `Datastore(cluster)` / `Grain(cluster)` / `Storage(cluster)`. */
interface DurabilityCluster {
  readonly cluster: TestCluster;
  readonly datastore: IDatastore;
  readonly grain: IDatastoreGrain;
  readonly grainId: GrainId;
}

async function buildCluster(
  storage: GrainStorage,
  schemaText: string,
  gcOptions?: DatastoreGcOptions | undefined,
): Promise<DurabilityCluster> {
  let services!: SpiceportGrainServices;
  let datastore: IDatastore | undefined;
  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: SPICEPORT_GRAIN_REGISTRATIONS,
    configureSilo: (builder) => {
      builder.addStorage("datastore", storage);
      services = addSpiceportGrainServices(builder, {
        schemaText,
        datastoreStorage: storage,
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
  const grain = client.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
  const identity = grainReferenceIdentity(grain);
  expect(identity, "the sequencer reference carries no grain identity").toBeDefined();
  // The seeding phases derive this id from metadata instead of from a cluster (see
  // `datastoreGrainId`). Pin the two against each other here, where a real cluster exists, so the
  // derivation cannot drift from what the runtime actually addresses and leave a seed writing rows
  // no grain ever reads - which would make the migration tests pass by testing nothing.
  expect(identity!.grainId.toString()).toBe(datastoreGrainId().toString());
  return { cluster, datastore: services.datastore, grain, grainId: identity!.grainId };
}

/**
 * The sequencer's `GrainId`, derived from its registered metadata rather than from a live cluster.
 *
 * The seeding phase of the two migration tests must write the legacy rows "WITHOUT ever activating
 * the datastore grain" (the C#'s words). The C# gets its id from a seed silo and relies on Orleans
 * grain references being lazy; here the silo's startup task starts `LogWatchHub` unconditionally,
 * and the hub subscribes to the sequencer - which ACTIVATES it, and the activation writes `head`.
 * That races the seed's own read-then-write of `head` and fails it with an etag conflict roughly
 * half the time. Deriving the id from metadata removes the cluster, and with it the race, which is
 * what the phase was documented to do all along.
 */
function datastoreGrainId(): GrainId {
  const metadata = getGrainMetadata(DatastoreGrain);
  expect(metadata, "DatastoreGrain carries no @grain() metadata").toBeDefined();
  return new GrainId(metadata!.grainType, DATASTORE_GRAIN_KEY);
}

/** A per-test table name; `PostgresGrainStorage` demands a plain SQL identifier. */
function freshTable(): string {
  return `spacedb_thin_durability_${randomUUID().replace(/-/g, "")}`;
}

/** `ReadRow<T>(cluster, stateName)` - through the SAME provider the grain uses (port decision 8). */
async function readRow<T>(
  storage: GrainStorage,
  grainId: GrainId,
  stateName: string,
): Promise<StateHolder<T>> {
  const entry: StateHolder<T> = { value: undefined as unknown as T, exists: false };
  await storage.read(stateName, grainId, entry);
  return entry;
}

/**
 * `WriteRow<T>(storage, grainId, stateName, value)` - read-then-write so the wrapper carries the
 * current etag if the row already exists (a fresh database yields none, which is a valid insert),
 * the same discipline the grain itself uses.
 */
async function writeRow<T>(
  storage: GrainStorage,
  grainId: GrainId,
  stateName: string,
  value: T,
): Promise<void> {
  const entry: StateHolder<T> = { value: undefined as unknown as T, exists: false };
  await storage.read(stateName, grainId, entry);
  entry.value = value;
  await storage.write(stateName, grainId, entry);
}

// The `Live*` payload sentinels - see port decision 9.
function liveMeta(e: StateHolder<DatastoreMetaEntry>): boolean {
  return e.exists && e.value?.meta !== undefined;
}
function liveSnapshot(e: StateHolder<DatastoreGrainState>): boolean {
  return e.exists && e.value !== undefined && e.value.headRevision > 0n;
}
function liveLogEvent(e: StateHolder<LogEvent>): boolean {
  return e.exists && e.value !== undefined && e.value.revision > 0n;
}
function liveShard(e: StateHolder<GraphShardState>): boolean {
  return e.exists && e.value !== undefined && e.value.appliedRevision > 0n;
}
function liveBucket(e: StateHolder<KeyIndexBucketEntry>): boolean {
  return e.exists && e.value?.entries !== undefined;
}
function liveDelta(e: StateHolder<KeyIndexDeltaEntry>): boolean {
  return e.exists && e.value?.forwardEntries !== undefined;
}

/** Version-qualified row name: the migration writes every split row under its own meta version. */
function shardRowKey(rowVersion: number, key: GraphShardKeyWire): string {
  return `shard/${rowVersion}/${graphShardGrainKeyBuild(key)}`;
}

function row(docId: string, userId: string): Relationship {
  return createRelationship(
    { objectType: "doc", objectId: docId, relation: "viewer" },
    { objectType: "user", objectId: userId, relation: ELLIPSIS },
  );
}

function write(
  ds: IDatastore,
  rel: Relationship,
  operation: UpdateOperation = "create",
): Promise<IRevision> {
  return ds.readWriteTx((tx) => tx.writeRelationships([{ relationship: rel, operation }]));
}

function nanos(revision: IRevision): bigint {
  return (revision as TimestampRevision).timestampNanosSinceEpoch;
}

/** `Collect`: the canonical `resource#relation@subject` strings, ordinally sorted. */
async function collect(source: AsyncIterable<Relationship>): Promise<string[]> {
  const rows: string[] = [];
  for await (const rel of source) {
    const resource = rel.reference.resource;
    const subject = rel.reference.subject;
    rows.push(
      `${resource.objectType}:${resource.objectId}#${resource.relation}` +
        `@${subject.objectType}:${subject.objectId}`,
    );
  }
  rows.sort();
  return rows;
}

/**
 * `RowMultiset`: the payload identity + MVCC stamps of a set of stored rows, ordinally sorted.
 * Liveness alone would pass a migration that wrote the right key with wrong or duplicated content.
 */
function rowMultiset(rows: readonly StoredRelationshipWire[]): string[] {
  return rows
    .map(
      (r) =>
        `${r.relationship.resourceType}:${r.relationship.resourceId}#${r.relationship.resourceRelation}` +
        `@${r.relationship.subjectType}:${r.relationship.subjectId}#${r.relationship.subjectRelation}` +
        `|created=${r.createdRevision}|deleted=${r.deletedRevision?.toString() ?? "live"}`,
    )
    .sort();
}

function caveatContext(): ReadonlyMap<string, unknown> {
  return new Map<string, unknown>([
    ["region", "eu"],
    ["level", 7],
  ]);
}

/**
 * Durability gates for the THIN-SEQUENCER storage layout against REAL Postgres: a mixed load
 * committed past a flush boundary through cluster A must be served with full fidelity by a
 * BRAND-NEW cluster B over the same database - reads, schema, counters, the GC floor's below-floor
 * rejection, and a Watch cursor replay - with the storage-level probes pinning that what cluster B
 * recovered from really was the NEW row map (`head` + `meta/{v}` + per-key `shard/...` rows +
 * post-flush log tail, no whole-state snapshot row).
 */
describe.sequential("NewLayoutRestartDurabilityTests", () => {
  it("NewLayout_FullFidelity_Survives_TrueReactivation_PastAFlushBoundary", async (ctx) => {
    ctx.skip(!adoNetDatastoreAvailable, adoNetDatastoreSkipReason);
    const { pool } = fixture();
    const table = freshTable();
    const storage = new PostgresGrainStorage(pool, { tableName: table });
    await storage.start();
    // Port decision 11: the 1h window makes `runGc` append a REAL GC event without invalidating the
    // Watch cursor captured below.
    const gcOptions: DatastoreGcOptions = { window: { hours: 1 }, reminderEnabled: false };
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try {
      let writtenHead: bigint;
      let writtenFloor: bigint;
      let writtenSchemaHash: string | undefined;
      let liveBefore: string[];
      let countBefore: bigint;
      let cursor: IRevision;

      // --- Phase 1: mixed load past the flush boundary through cluster A, then dispose it. ---
      const a = await buildCluster(storage, SCHEMA, gcOptions);
      try {
        const dsA = a.datastore;

        await dsA.readWriteTx(async (tx) => {
          await tx.writeStoredSchema(new TextEncoder().encode(SCHEMA));
          await tx.writeRelationships([
            { relationship: row("plain", "alice"), operation: "create" },
            {
              relationship: createRelationship(
                { objectType: "doc", objectId: "caveated", relation: "viewer" },
                { objectType: "user", objectId: "bob", relation: ELLIPSIS },
                { caveatName: "is_active", context: caveatContext() },
              ),
              operation: "create",
            },
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

        // Cross the 64-event flush boundary, then a delete and a REAL GC event.
        for (let i = 0; i < 66; i += 1) await write(dsA, row(`m${i}`, `w${i}`));
        await write(dsA, row("m0", "w0"), "delete");

        const floor = await a.grain.runGc();
        expect(floor).toBeDefined();
        writtenFloor = floor!;

        // The Watch cursor cluster B must replay from, then the two events it must replay.
        cursor = (await dsA.headRevision()).revision;
        await write(dsA, row("post-1", "zoe"));
        await write(dsA, row("post-2", "zed"));

        const head = await dsA.headRevision();
        writtenHead = nanos(head.revision);
        writtenSchemaHash = head.schemaHash;
        expect(writtenSchemaHash).toBeDefined();

        const reader = dsA.snapshotReader(head.revision);
        liveBefore = await collect(reader.queryRelationships({ optionalResourceType: "doc" }));
        countBefore = await reader.countRelationships("doc_viewers");
      } finally {
        await a.cluster.dispose();
      }

      // --- Phase 2: a BRAND-NEW cluster over the same Postgres (true reactivation). ---
      const b = await buildCluster(storage, SCHEMA, gcOptions);
      try {
        const dsB = b.datastore;

        // Negative control: lost state would re-seed an empty state - a different, larger head.
        const head = await dsB.headRevision();
        expect(nanos(head.revision)).toBe(writtenHead);
        expect(head.schemaHash).toBe(writtenSchemaHash);
        expect((await b.grain.getHead()).gcFloor).toBe(writtenFloor);

        // Reads: the live set, payload fidelity, schema bytes, counter, all identical.
        const reader = dsB.snapshotReader(head.revision);
        expect(await collect(reader.queryRelationships({ optionalResourceType: "doc" }))).toEqual(
          liveBefore,
        );
        expect(await reader.countRelationships("doc_viewers")).toBe(countBefore);
        const counterFilter = await reader.readCounterFilter("doc_viewers");
        expect(counterFilter!.optionalResourceType).toBe("doc");
        expect(counterFilter!.optionalResourceRelation).toBe("viewer");
        const schema = await reader.readStoredSchema();
        expect(schema).toEqual(new TextEncoder().encode(SCHEMA));

        const rels: Relationship[] = [];
        for await (const rel of reader.queryRelationships({
          optionalResourceType: "doc",
          optionalResourceIds: ["caveated", "expiring"],
        }))
          rels.push(rel);
        const caveated = rels.find((r) => r.reference.resource.objectId === "caveated")!;
        expect(caveated.optionalCaveat!.caveatName).toBe("is_active");
        expect(caveated.optionalCaveat!.context!.get("region")).toBe("eu");
        expect(caveated.optionalCaveat!.context!.get("level")).toBe(7);
        expect(
          rels.find((r) => r.reference.resource.objectId === "expiring")!.optionalExpiration,
        ).toBe(EXPIRY);

        // The durable floor still rejects a below-floor pin.
        await expect(
          (async () => {
            const stale = dsB.snapshotReader(new TimestampRevision(writtenFloor - 1n));
            for await (const _ of stale.queryRelationships({})) {
              // drained for the throw
            }
          })(),
        ).rejects.toThrow(RevisionNotFoundException);

        // Watch cursor replay: the two post-cursor commits, in order, from the rebuilt log tail.
        const replayed: RevisionChange[] = [];
        for await (const change of dsB.watch(
          cursor,
          { content: WatchContent.relationships },
          controller.signal,
        )) {
          replayed.push(change);
          if (replayed.length === 2) break;
        }
        expect(replayed[0]!.relationshipChanges).toHaveLength(1);
        expect(replayed[0]!.relationshipChanges[0]!.relationship.reference.resource.objectId).toBe(
          "post-1",
        );
        expect(replayed[1]!.relationshipChanges).toHaveLength(1);
        expect(replayed[1]!.relationshipChanges[0]!.relationship.reference.resource.objectId).toBe(
          "post-2",
        );

        // Storage-level: what B recovered from really is the NEW layout - a 64-boundary meta row
        // plus shard rows, log trimmed through the boundary, and NO whole-state snapshot row.
        const headRow = await readRow<LogHeadEntry>(storage, b.grainId, "head");
        expect(headRow.exists).toBe(true);
        const flushVersion = headRow.value.snapshotVersion;
        expect(
          flushVersion >= FLUSH_INTERVAL,
          `no flush crossed: snapshotVersion ${flushVersion}`,
        ).toBe(true);
        expect(flushVersion).toBe(
          headRow.value.logVersion - (headRow.value.logVersion % FLUSH_INTERVAL),
        );
        expect(
          liveMeta(await readRow<DatastoreMetaEntry>(storage, b.grainId, `meta/${flushVersion}`)),
        ).toBe(true);
        expect(
          liveSnapshot(
            await readRow<DatastoreGrainState>(storage, b.grainId, `snapshot/${flushVersion}`),
          ),
        ).toBe(false);
        // Trimmed at the flush.
        expect(liveLogEvent(await readRow<LogEvent>(storage, b.grainId, "log/1"))).toBe(false);
        expect(
          liveLogEvent(await readRow<LogEvent>(storage, b.grainId, `log/${flushVersion + 1}`)),
          "the first post-flush log entry is missing - the tail was over-trimmed",
        ).toBe(true);
        // Shard rows are version-qualified: doc:plain was dirty at the (only) flush boundary, so
        // its row lives under that flush version and is reachable only through the meta index.
        expect(
          liveShard(
            await readRow<GraphShardState>(
              storage,
              b.grainId,
              shardRowKey(flushVersion, graphShardKeyForResource("doc", "plain")),
            ),
          ),
          "the flushed forward shard row for doc:plain is missing",
        ).toBe(true);

        // Durable layout v2: the meta row is SLIM (no inline key maps - cardinality-independent)
        // and what cluster B recovered the index from really was the chunked rows: the flush's
        // delta row plus the rotated bucket pair (the rotation cursor starts at 0, and exactly one
        // flush happened, so bucket 0 of each direction lives at the flush version).
        const metaRowB = await readRow<DatastoreMetaEntry>(
          storage,
          b.grainId,
          `meta/${flushVersion}`,
        );
        expect(liveMeta(metaRowB)).toBe(true);
        expect(metaRowB.value.indexLayout).toBeDefined();
        expect([...metaRowB.value.meta.forwardKeys]).toEqual([]);
        expect([...metaRowB.value.meta.reverseKeys]).toEqual([]);
        expect(metaRowB.value.indexLayout!.deltaVersions).toContain(flushVersion);
        const deltaRowB = await readRow<KeyIndexDeltaEntry>(
          storage,
          b.grainId,
          `indexd/${flushVersion}`,
        );
        expect(liveDelta(deltaRowB), "the flush's indexd/{v} delta row is missing").toBe(true);
        expect(
          deltaRowB.value.forwardEntries.get(
            graphShardGrainKeyBuild(graphShardKeyForResource("doc", "plain")),
          ),
        ).toBe(flushVersion);
        expect(
          liveBucket(
            await readRow<KeyIndexBucketEntry>(storage, b.grainId, `indexb/${flushVersion}/f/0`),
          ),
          "the rotated forward bucket row is missing",
        ).toBe(true);
        expect(
          liveBucket(
            await readRow<KeyIndexBucketEntry>(storage, b.grainId, `indexb/${flushVersion}/r/0`),
          ),
          "the rotated reverse bucket row is missing",
        ).toBe(true);
      } finally {
        await b.cluster.dispose();
      }
    } finally {
      clearTimeout(deadline);
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }, 600_000);
});

/**
 * The MIGRATION gate: a database seeded in the RETIRED whole-state layout (one `snapshot/{v}` row
 * holding the full `DatastoreGrainState` plus the `head` row naming it - written directly through
 * the same storage provider the grain uses, exactly as the pre-rework grain laid it out) must be
 * migrated IN PLACE by the reworked grain's first activation: reads serve the migrated data exactly
 * (including MVCC time travel over a dead row and caveat context), per-key shard rows and the
 * `meta/{v}` row now exist, the legacy snapshot row is cleared, and subsequent commits flush
 * normally through the new protocol.
 */
describe.sequential("LegacyMigrationDurabilityTests", () => {
  it("LegacyWholeStateSnapshot_IsMigratedInPlace_AndCommitsFlushNormally", async (ctx) => {
    ctx.skip(!adoNetDatastoreAvailable, adoNetDatastoreSkipReason);
    const { pool } = fixture();
    const table = freshTable();
    const storage = new PostgresGrainStorage(pool, { tableName: table });
    await storage.start();
    try {
      // The legacy state, stamped with plausible recent timestamp revisions (nanos since epoch):
      // two live rows (one caveated), one DEAD row (created then deleted - MVCC history the
      // migration must preserve for time travel), a schema version whose hash is computed exactly
      // as the write path computes it, and one registered counter.
      const head = nowNanos();
      const createdAt = head - 2_000_000n; // 2ms before head
      const deletedAt = head - 1_000_000n; // 1ms before head
      const schemaBytes = new TextEncoder().encode(SCHEMA);
      const schemaHash = computeStoredSchemaHash(schemaBytes);

      const stored = (
        rel: Relationship,
        created: bigint,
        deleted?: bigint,
      ): StoredRelationshipWire => ({
        relationship: toWire(rel),
        createdRevision: created,
        deletedRevision: deleted,
      });

      const plain = row("legacy-plain", "alice");
      const caveated = createRelationship(
        { objectType: "doc", objectId: "legacy-caveated", relation: "viewer" },
        { objectType: "user", objectId: "bob", relation: ELLIPSIS },
        { caveatName: "is_active", context: caveatContext() },
      );
      const dead = row("legacy-dead", "eve");

      const counters: readonly CounterVersionWire[] = [
        {
          revision: createdAt,
          name: "doc_viewers",
          filter: toFullFilter({
            optionalResourceType: "doc",
            optionalResourceRelation: "viewer",
          }),
        },
      ];
      const legacy: DatastoreGrainState = {
        headRevision: head,
        relationships: [
          stored(plain, createdAt),
          stored(caveated, createdAt),
          stored(dead, createdAt, deletedAt),
        ],
        schemas: [{ revision: createdAt, bytes: schemaBytes, hash: schemaHash }],
        counters,
        gcFloor: 0n,
      };
      // The pre-rework layout: head names snapshot/{v} with logVersion == v.
      const legacyVersion = 3;

      // --- Phase 1: seed the database in the OLD layout through the storage provider directly,
      // WITHOUT ever activating the datastore grain. ---
      const seedGrainId = datastoreGrainId();
      await writeRow(storage, seedGrainId, `snapshot/${legacyVersion}`, legacy);
      await writeRow<LogHeadEntry>(storage, seedGrainId, "head", {
        logVersion: legacyVersion,
        headRevision: head,
        snapshotVersion: legacyVersion,
      });

      // --- Phase 2: activate the reworked grain against the legacy store (a brand-new cluster). ---
      const c = await buildCluster(storage, SCHEMA);
      try {
        const ds = c.datastore;

        // The migrated head/schema-hash are exactly the legacy ones (not a re-seeded empty state).
        const headRead = await ds.headRevision();
        expect(nanos(headRead.revision)).toBe(head);
        expect(headRead.schemaHash).toBe(schemaHash);

        // Reads serve the migrated data exactly: live rows at head, the dead row invisible ...
        const reader = ds.snapshotReader(headRead.revision);
        const ids: string[] = [];
        for await (const rel of reader.queryRelationships({ optionalResourceType: "doc" }))
          ids.push(rel.reference.resource.objectId);
        ids.sort();
        expect(ids).toEqual(["legacy-caveated", "legacy-plain"]);

        // ... including payload fidelity (caveat context through migration) ...
        const caveatedRead: Relationship[] = [];
        for await (const rel of reader.queryRelationships({
          optionalResourceType: "doc",
          optionalResourceIds: ["legacy-caveated"],
        }))
          caveatedRead.push(rel);
        expect(caveatedRead).toHaveLength(1);
        const cav = caveatedRead[0]!.optionalCaveat!;
        expect(cav.caveatName).toBe("is_active");
        expect(cav.context!.get("region")).toBe("eu");
        expect(cav.context!.get("level")).toBe(7);

        // ... and MVCC time travel: pinned between the dead row's create and delete, it is visible.
        const timeTravel = ds.snapshotReader(new TimestampRevision(head - 1_500_000n));
        const atPast: string[] = [];
        for await (const rel of timeTravel.queryRelationships({ optionalResourceType: "doc" }))
          atPast.push(rel.reference.resource.objectId);
        expect(atPast).toContain("legacy-dead");

        // Schema bytes and the counter migrated whole.
        const migratedSchema = await reader.readStoredSchema();
        expect(migratedSchema).toEqual(schemaBytes);
        const counterFilter = await reader.readCounterFilter("doc_viewers");
        expect(counterFilter!.optionalResourceType).toBe("doc");
        expect(await reader.countRelationships("doc_viewers")).toBe(2n);

        // The store is now the NEW layout: meta + per-key shard rows (both directions) exist and
        // the legacy snapshot row is cleared.
        const metaRow = await readRow<DatastoreMetaEntry>(
          storage,
          c.grainId,
          `meta/${legacyVersion}`,
        );
        expect(liveMeta(metaRow), "migration did not write the meta/{v} row").toBe(true);
        expect(metaRow.value.flushedThroughLogVersion).toBe(legacyVersion);

        // The v0 migration lands DIRECTLY on durable layout v2: the meta row is slim (no inline
        // key maps), carries the chunked-index layout with FULL bucket coverage at the migration
        // version (deltaFloorVersion starts there; no pending deltas), and the bucket holding
        // doc:legacy-plain's forward key maps it to the migration version. Full coverage means
        // even a bucket holding NO migrated key has an (empty) row.
        expect(metaRow.value.indexLayout).toBeDefined();
        expect([...metaRow.value.meta.forwardKeys]).toEqual([]);
        expect([...metaRow.value.meta.reverseKeys]).toEqual([]);
        const layout = metaRow.value.indexLayout!;
        expect(layout.deltaFloorVersion).toBe(legacyVersion);
        expect(layout.deltaVersions).toEqual([]);
        for (const v of layout.forwardBucketVersions) expect(v).toBe(legacyVersion);
        const plainForwardKey = graphShardGrainKeyBuild(
          graphShardKeyForResource("doc", "legacy-plain"),
        );
        const plainBucket = keyIndexLayoutBucketOf(plainForwardKey, layout.bucketCount);
        const plainBucketRow = await readRow<KeyIndexBucketEntry>(
          storage,
          c.grainId,
          `indexb/${legacyVersion}/f/${plainBucket}`,
        );
        expect(liveBucket(plainBucketRow), "migration did not write the forward bucket row").toBe(
          true,
        );
        expect(plainBucketRow.value.entries.get(plainForwardKey)).toBe(legacyVersion);
        const occupiedForwardBuckets = new Set(
          ["legacy-plain", "legacy-caveated", "legacy-dead"].map((id) =>
            keyIndexLayoutBucketOf(
              graphShardGrainKeyBuild(graphShardKeyForResource("doc", id)),
              layout.bucketCount,
            ),
          ),
        );
        const emptyBucket = [...Array(layout.bucketCount).keys()].find(
          (b) => !occupiedForwardBuckets.has(b),
        )!;
        const emptyBucketRow = await readRow<KeyIndexBucketEntry>(
          storage,
          c.grainId,
          `indexb/${legacyVersion}/f/${emptyBucket}`,
        );
        expect(liveBucket(emptyBucketRow), "migration did not write full bucket coverage").toBe(
          true,
        );
        expect([...emptyBucketRow.value.entries]).toEqual([]);
        expect(
          liveShard(
            await readRow<GraphShardState>(
              storage,
              c.grainId,
              shardRowKey(legacyVersion, graphShardKeyForResource("doc", "legacy-plain")),
            ),
          ),
          "migration did not split out the forward shard row",
        ).toBe(true);

        // REVERSE ROW CONTENT, not just liveness: the reverse split of user:alice must carry
        // exactly the stored rows derivable from the FORWARD data - the legacy snapshot's rows
        // whose subject is user:alice, with identical payloads and MVCC stamps.
        const reverseAlice = await readRow<GraphShardState>(
          storage,
          c.grainId,
          shardRowKey(legacyVersion, graphShardKeyForSubject("user", "alice")),
        );
        expect(liveShard(reverseAlice), "migration did not split out the reverse shard row").toBe(
          true,
        );
        expect(rowMultiset(reverseAlice.value.rows)).toEqual(
          rowMultiset(
            legacy.relationships.filter(
              (r) => r.relationship.subjectType === "user" && r.relationship.subjectId === "alice",
            ),
          ),
        );

        // And the DEAD row's reverse split: the created+deleted stamps must migrate intact too.
        const reverseEve = await readRow<GraphShardState>(
          storage,
          c.grainId,
          shardRowKey(legacyVersion, graphShardKeyForSubject("user", "eve")),
        );
        expect(
          liveShard(reverseEve),
          "migration did not split out the dead row's reverse shard row",
        ).toBe(true);
        expect(rowMultiset(reverseEve.value.rows)).toEqual(
          rowMultiset(
            legacy.relationships.filter(
              (r) => r.relationship.subjectType === "user" && r.relationship.subjectId === "eve",
            ),
          ),
        );
        expect(
          liveSnapshot(
            await readRow<DatastoreGrainState>(storage, c.grainId, `snapshot/${legacyVersion}`),
          ),
          "the legacy whole-state snapshot row was not cleared",
        ).toBe(false);

        // Subsequent commits flush normally: enough commits to cross the next 64-boundary, then the
        // head row must name a NEW meta version, the old meta is cleared, and reads stay exact.
        for (let i = 0; i < FLUSH_INTERVAL; i += 1) {
          await write(ds, row(`post-${i}`, `u${i}`));
        }

        const headRow = await readRow<LogHeadEntry>(storage, c.grainId, "head");
        expect(headRow.exists).toBe(true);
        expect(
          headRow.value.snapshotVersion > legacyVersion,
          `no post-migration flush happened: snapshotVersion still ${headRow.value.snapshotVersion}`,
        ).toBe(true);
        expect(headRow.value.snapshotVersion).toBe(
          headRow.value.logVersion - (headRow.value.logVersion % FLUSH_INTERVAL),
        );
        expect(
          liveMeta(
            await readRow<DatastoreMetaEntry>(
              storage,
              c.grainId,
              `meta/${headRow.value.snapshotVersion}`,
            ),
          ),
        ).toBe(true);
        expect(
          liveMeta(await readRow<DatastoreMetaEntry>(storage, c.grainId, `meta/${legacyVersion}`)),
          "the superseded migration meta row was not cleared by the flush",
        ).toBe(false);

        // Post-migration flushes speak the v2 protocol: the flush wrote its delta row and rotated
        // bucket 0 in both directions (the migration resets the rotation cursor to 0).
        expect(
          liveDelta(
            await readRow<KeyIndexDeltaEntry>(
              storage,
              c.grainId,
              `indexd/${headRow.value.snapshotVersion}`,
            ),
          ),
          "the post-migration flush wrote no indexd/{v} delta row",
        ).toBe(true);
        expect(
          liveBucket(
            await readRow<KeyIndexBucketEntry>(
              storage,
              c.grainId,
              `indexb/${headRow.value.snapshotVersion}/f/0`,
            ),
          ),
          "the post-migration flush wrote no rotated forward bucket row",
        ).toBe(true);
        expect(
          liveBucket(
            await readRow<KeyIndexBucketEntry>(
              storage,
              c.grainId,
              `indexb/${headRow.value.snapshotVersion}/r/0`,
            ),
          ),
          "the post-migration flush wrote no rotated reverse bucket row",
        ).toBe(true);

        const newHead = await ds.headRevision();
        const finalReader = ds.snapshotReader(newHead.revision);
        let finalCount = 0;
        for await (const _ of finalReader.queryRelationships({ optionalResourceType: "doc" }))
          finalCount += 1;
        // The two live legacy rows plus every post-migration row.
        expect(finalCount).toBe(2 + FLUSH_INTERVAL);

        // The caveated legacy row's context survived the post-migration flush cycle too.
        const caveatedAfter: Relationship[] = [];
        for await (const rel of finalReader.queryRelationships({
          optionalResourceType: "doc",
          optionalResourceIds: ["legacy-caveated"],
        }))
          caveatedAfter.push(rel);
        expect(caveatedAfter).toHaveLength(1);
        expect(caveatedAfter[0]!.optionalCaveat!.context!.get("region")).toBe("eu");
      } finally {
        await c.cluster.dispose();
      }
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }, 600_000);
});

/**
 * The v1-to-v2 MIGRATION gate: a database seeded in the RETIRED v1 thin-sequencer layout - per-key
 * shard rows plus a `meta/{v}` row carrying the key-index maps INLINE (the old-shape
 * `DatastoreMetaEntry` with no `indexLayout`), written directly through the same storage provider
 * the grain uses - must be migrated in place by the reworked grain's first activation: reads serve
 * the migrated data exactly (including MVCC time travel over a dead row), the meta row is rewritten
 * SLIM with full bucket-row coverage at the migration version, shard rows are untouched (row-level
 * content equality), and subsequent commits flush through the v2 protocol (delta + rotated bucket
 * rows).
 */
describe.sequential("InlineIndexMigrationDurabilityTests", () => {
  const INLINE_SCHEMA = `definition user {}

definition doc {
  relation viewer: user
}`;

  it("V1InlineIndexMeta_IsChunkedInPlace_AndCommitsFlushThroughV2", async (ctx) => {
    ctx.skip(!adoNetDatastoreAvailable, adoNetDatastoreSkipReason);
    const { pool } = fixture();
    const table = freshTable();
    const storage = new PostgresGrainStorage(pool, { tableName: table });
    await storage.start();
    try {
      // The v1 state: one live row, one DEAD row (created then deleted - MVCC history the migration
      // must preserve), a schema version hashed exactly as the write path hashes it, and the inline
      // key-index maps pointing every key at the shard rows' version.
      const head = nowNanos();
      const createdAt = head - 2_000_000n;
      const deletedAt = head - 1_000_000n;
      const schemaBytes = new TextEncoder().encode(INLINE_SCHEMA);
      const schemaHash = computeStoredSchemaHash(schemaBytes);

      const plain = row("v1-plain", "alice");
      const dead = row("v1-dead", "eve");
      const plainStored: StoredRelationshipWire = {
        relationship: toWire(plain),
        createdRevision: createdAt,
        deletedRevision: undefined,
      };
      const deadStored: StoredRelationshipWire = {
        relationship: toWire(dead),
        createdRevision: createdAt,
        deletedRevision: deletedAt,
      };

      // v1 layout: head names meta/{v} with logVersion == v, maps inline.
      const v1Version = 5;

      const shardRows: ReadonlyArray<readonly [GraphShardKeyWire, StoredRelationshipWire]> = [
        [graphShardKeyForResource("doc", "v1-plain"), plainStored],
        [graphShardKeyForResource("doc", "v1-dead"), deadStored],
        [graphShardKeyForSubject("user", "alice"), plainStored],
        [graphShardKeyForSubject("user", "eve"), deadStored],
      ];
      const forward = new Map<string, number>();
      const reverse = new Map<string, number>();
      for (const [key] of shardRows) {
        const keyString = graphShardGrainKeyBuild(key);
        if (keyString.startsWith("f/")) forward.set(keyString, v1Version);
        else reverse.set(keyString, v1Version);
      }
      const v1Meta: DatastoreMetaState = {
        headRevision: head,
        schemas: [{ revision: createdAt, bytes: schemaBytes, hash: schemaHash }],
        counters: [],
        gcFloor: 0n,
        forwardKeys: forward,
        reverseKeys: reverse,
      };

      // --- Phase 1: seed the database in the v1 layout through the storage provider directly (the
      // old-shape meta entry: inline maps, no indexLayout), WITHOUT activating the grain. ---
      const seedGrainId = datastoreGrainId();
      for (const [key, rowValue] of shardRows) {
        await writeRow<GraphShardState>(storage, seedGrainId, shardRowKey(v1Version, key), {
          appliedRevision: head,
          gcFloor: 0n,
          rows: [rowValue],
        });
      }
      await writeRow<DatastoreMetaEntry>(storage, seedGrainId, `meta/${v1Version}`, {
        meta: v1Meta,
        flushedThroughLogVersion: v1Version,
      });
      await writeRow<LogHeadEntry>(storage, seedGrainId, "head", {
        logVersion: v1Version,
        headRevision: head,
        snapshotVersion: v1Version,
      });

      // --- Phase 2: activate the grain against the v1 store (a brand-new cluster). ---
      const c = await buildCluster(storage, INLINE_SCHEMA);
      try {
        const ds = c.datastore;

        // Migrated head/schema-hash exactly the seeded ones (not a re-seeded empty state).
        const headRead = await ds.headRevision();
        expect(nanos(headRead.revision)).toBe(head);
        expect(headRead.schemaHash).toBe(schemaHash);

        // Reads serve the migrated data exactly: the live row at head, the dead row only via
        // MVCC time travel between its create and delete.
        const reader = ds.snapshotReader(headRead.revision);
        const ids: string[] = [];
        for await (const rel of reader.queryRelationships({ optionalResourceType: "doc" }))
          ids.push(rel.reference.resource.objectId);
        expect(ids).toEqual(["v1-plain"]);
        const timeTravel = ds.snapshotReader(new TimestampRevision(head - 1_500_000n));
        const atPast: string[] = [];
        for await (const rel of timeTravel.queryRelationships({ optionalResourceType: "doc" }))
          atPast.push(rel.reference.resource.objectId);
        atPast.sort();
        expect(atPast).toEqual(["v1-dead", "v1-plain"]);

        // The meta row was rewritten SLIM in place: no inline maps, a layout with full bucket
        // coverage at the migration version (deltaFloorVersion there, no pending deltas), and the
        // bucket holding the live row's forward key maps it to the shard rows' UNCHANGED version.
        const metaRow = await readRow<DatastoreMetaEntry>(storage, c.grainId, `meta/${v1Version}`);
        expect(liveMeta(metaRow), "the migrated meta/{v} row is missing").toBe(true);
        expect(metaRow.value.flushedThroughLogVersion).toBe(v1Version);
        expect(metaRow.value.indexLayout).toBeDefined();
        expect([...metaRow.value.meta.forwardKeys]).toEqual([]);
        expect([...metaRow.value.meta.reverseKeys]).toEqual([]);
        const layout = metaRow.value.indexLayout!;
        expect(layout.deltaFloorVersion).toBe(v1Version);
        expect(layout.deltaVersions).toEqual([]);
        for (const v of layout.forwardBucketVersions) expect(v).toBe(v1Version);
        for (const v of layout.reverseBucketVersions) expect(v).toBe(v1Version);
        const plainForwardKey = graphShardGrainKeyBuild(
          graphShardKeyForResource("doc", "v1-plain"),
        );
        const plainBucketRow = await readRow<KeyIndexBucketEntry>(
          storage,
          c.grainId,
          `indexb/${v1Version}/f/${keyIndexLayoutBucketOf(plainForwardKey, layout.bucketCount)}`,
        );
        expect(liveBucket(plainBucketRow), "the migration wrote no forward bucket row").toBe(true);
        expect(plainBucketRow.value.entries.get(plainForwardKey)).toBe(v1Version);

        // Shard rows are UNTOUCHED by the index migration: row-level content equality against the
        // seeded rows, forward and reverse, dead-row stamps included.
        for (const [key, rowValue] of shardRows) {
          const shardRow = await readRow<GraphShardState>(
            storage,
            c.grainId,
            shardRowKey(v1Version, key),
          );
          expect(
            shardRow.exists,
            `seeded shard row for ${graphShardGrainKeyBuild(key)} vanished`,
          ).toBe(true);
          expect(rowMultiset(shardRow.value.rows)).toEqual(rowMultiset([rowValue]));
        }

        // Subsequent commits flush through the v2 protocol: cross the next 64-boundary, then the
        // head names a new slim meta, the migration meta is cleared, and the flush wrote its delta
        // row plus the rotated bucket pair (cursor reset to 0 by the migration).
        for (let i = 0; i < FLUSH_INTERVAL; i += 1) {
          await write(ds, row(`post-${i}`, `u${i}`));
        }

        const headRow = await readRow<LogHeadEntry>(storage, c.grainId, "head");
        expect(headRow.exists).toBe(true);
        const flushVersion = headRow.value.snapshotVersion;
        expect(
          flushVersion > v1Version,
          `no post-migration flush happened: snapshotVersion ${flushVersion}`,
        ).toBe(true);
        const flushedMeta = await readRow<DatastoreMetaEntry>(
          storage,
          c.grainId,
          `meta/${flushVersion}`,
        );
        expect(liveMeta(flushedMeta)).toBe(true);
        expect(flushedMeta.value.indexLayout).toBeDefined();
        expect([...flushedMeta.value.meta.forwardKeys]).toEqual([]);
        expect(
          liveMeta(await readRow<DatastoreMetaEntry>(storage, c.grainId, `meta/${v1Version}`)),
          "the superseded migration meta row was not cleared by the flush",
        ).toBe(false);
        expect(
          liveDelta(
            await readRow<KeyIndexDeltaEntry>(storage, c.grainId, `indexd/${flushVersion}`),
          ),
          "the post-migration flush wrote no indexd/{v} delta row",
        ).toBe(true);
        expect(
          liveBucket(
            await readRow<KeyIndexBucketEntry>(storage, c.grainId, `indexb/${flushVersion}/f/0`),
          ),
          "the post-migration flush wrote no rotated forward bucket row",
        ).toBe(true);
        expect(
          liveBucket(
            await readRow<KeyIndexBucketEntry>(storage, c.grainId, `indexb/${flushVersion}/r/0`),
          ),
          "the post-migration flush wrote no rotated reverse bucket row",
        ).toBe(true);

        // Reads stay exact across the whole cycle: the live migrated row plus every post row.
        const finalReader = ds.snapshotReader((await ds.headRevision()).revision);
        let finalCount = 0;
        for await (const _ of finalReader.queryRelationships({ optionalResourceType: "doc" }))
          finalCount += 1;
        expect(finalCount).toBe(1 + FLUSH_INTERVAL);
      } finally {
        await c.cluster.dispose();
      }
    } finally {
      await pool.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }, 600_000);
});
