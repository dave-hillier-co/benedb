import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { UpdateOperation } from "@benedb/core/relationship-update";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import type { RevisionChange } from "@benedb/datastore/watch";
import { WatchContent } from "@benedb/datastore/watch";
import type { StorageBackend } from "@thresh/hosting/storage-backend";
import { TestCluster } from "@thresh/testing/test-cluster";

import type { DatastoreGcOptions } from "./datastore-gc-options";
import {
  durableBackendAvailable,
  durableBackendSkipReason,
  useDurableBackend,
} from "./durable-backend-fixture";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { graphShardKeyForResource } from "./graph-shard-key";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { IGraphShardGrain, IShardIndexGrain } from "./i-graph-shard-grain";
import type { SpiceportGrainServices } from "./service-collection-extensions";
import {
  addSpiceportGrainServices,
  SPICEPORT_GRAIN_REGISTRATIONS,
} from "./service-collection-extensions";
import { shardIndexBucketOf, shardIndexKeyBuild } from "./shard-index-grain";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/Durability/ProjectionDurabilityTests.cs`.
 *
 * Durability gate for the journaled sequencer and its shard projection against a REAL durable
 * backend (`durable-backend-fixture`, skip-without-backend): a mixed load committed past a
 * projection flush through cluster A must be served with full fidelity by a BRAND-NEW cluster B
 * over the same backend - reads, schema, counters, the GC floor's below-floor rejection, and a
 * Watch cursor replay - with probes pinning that cluster B's shard grains and shard index recovered
 * the projection from storage.
 *
 * PORT DECISIONS.
 *
 *  1. The backend is Thresh's, handed to `TestCluster.start({ storageBackend })`; cluster A and B
 *     share a fresh service id, which every Thresh provider keys its rows by.
 *  2. Caveat context is a decoded `ReadonlyMap`, so `JsonElement.GetRawText()` comparisons become
 *     plain lookups (`"eu"`, `7`).
 *  3. Port decision 11 of the retired layout suite survives: a ONE-HOUR GC window makes `runGc`
 *     append a REAL GC event without invalidating the Watch cursor.
 */

const SCHEMA = `definition user {}

caveat is_active(level int) {
  level > 0
}

definition doc {
  relation viewer: user | user with is_active
}`;

/** `new DateTimeOffset(2032, 3, 1, 0, 0, 0, TimeSpan.Zero)`. */
const EXPIRY = BigInt(Date.UTC(2032, 2, 1, 0, 0, 0)) * 1_000_000n;

const fixture = useDurableBackend();

/** One cluster's handles. */
interface DurabilityCluster {
  readonly cluster: TestCluster;
  readonly datastore: IDatastore;
  readonly grain: IDatastoreGrain;
}

async function buildCluster(
  backend: StorageBackend,
  serviceId: string,
  gcOptions: DatastoreGcOptions,
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
        datastore: () =>
          (datastore ??= new GrainBackedDatastore(
            services.grainFactory,
            services.hub,
            undefined,
            undefined,
            gcOptions,
          )),
        datastoreGcOptions: gcOptions,
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

function caveatContext(): ReadonlyMap<string, unknown> {
  return new Map<string, unknown>([
    ["region", "eu"],
    ["level", 7],
  ]);
}

describe.sequential("ProjectionRestartDurabilityTests", () => {
  it("Projection_FullFidelity_Survives_TrueReactivation_PastAFlushBoundary", async (ctx) => {
    ctx.skip(!durableBackendAvailable, durableBackendSkipReason);
    const backend = fixture();
    const serviceId = `benedb-projection-restart-${randomUUID()}`;
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
      const a = await buildCluster(backend, serviceId, gcOptions);
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

      // --- Phase 2: a BRAND-NEW cluster over the same backend (true reactivation). ---
      const b = await buildCluster(backend, serviceId, gcOptions);
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

        // What B recovered rows from really is the projection: doc:plain was projected at the
        // flush, so its freshly activated shard grain reads its rows back from the backend, and
        // the shard index lists it.
        const client = await b.cluster.client;
        const plain = await client
          .getGrain(
            IGraphShardGrain,
            graphShardGrainKeyBuild(graphShardKeyForResource("doc", "plain")),
          )
          .readProjected();
        expect(plain.rows).toHaveLength(1);
        expect(plain.rows[0]!.relationship.subjectId).toBe("alice");
        const listed = await client
          .getGrain(
            IShardIndexGrain,
            shardIndexKeyBuild("forward", "doc", shardIndexBucketOf("plain")),
          )
          .readIds();
        expect(listed).toContain("plain");
      } finally {
        await b.cluster.dispose();
      }
    } finally {
      clearTimeout(deadline);
    }
  }, 600_000);
});
