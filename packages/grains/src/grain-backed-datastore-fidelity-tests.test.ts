import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { CreateRelationshipExistsException } from "@spacedb/datastore/datastore-exceptions";
import type { DeleteRelationshipsResult, IDatastore } from "@spacedb/datastore/i-datastore";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import type { RelationshipsFilter } from "@spacedb/datastore/relationships-filter";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainStorage } from "@thresh/core/grain-storage";
import type { GrainKeyFor } from "@thresh/core/key-kinds";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { TestCluster } from "@thresh/testing/test-cluster";
import { describe, expect, it } from "vitest";

import { DatastoreGrain } from "./datastore-grain";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import { IDatastoreGrain } from "./i-datastore-grain";
import { createIsolatedWatchHub } from "./isolated-watch-hub";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/GrainBackedDatastoreFidelityTests.cs`.
 *
 * Proves the LIVE grain-backed datastore is faithful to the {@link ReferenceDatastore} reference
 * model through the `IDatastore` contract: an identical ordered sequence of write transactions
 * through (a) a plain `ReferenceDatastore` and (b) a `GrainBackedDatastore` over the singleton
 * `DatastoreGrain` yields equal live relationship sets at head, plus matching delete counts and
 * schema/counter state. This exercises the seam the conformance corpus does not isolate: the
 * optimistic compare-and-swap commit and the `DatastoreState` <-> `DatastoreGrainState` conversion
 * round-trip, including caveat context and expiration stamps.
 *
 * Uses its OWN single-silo {@link TestCluster}. Revisions are timestamp-monotonic and differ between
 * the two backends; the assertion is over the live SET (identity + payload), revision-independent.
 * Both sides read via `queryRelationships`, so expiration is sheared symmetrically by the same code
 * path - never swap one side to a raw row scan.
 *
 * Port decisions: identical to `stage1-journaled-write-path-tests.test.ts`'s - the C#'s
 * `AddMemoryGrainStorage("datastore")` is registered here directly (S5's `DatastoreStorageConfig` is
 * NOT pulled forward), the custom-storage log-consistency provider is Thresh's
 * `bindJournaledGrain` detecting the grain's own `CustomStorageInterface`, and the grain's keyed
 * `IGrainStorage` dependency arrives through a `GrainActivator` because Thresh has no constructor
 * DI.
 */

type Op = "create" | "touch" | "delete";

function rel(rt: string, rid: string, rrel: string, st: string, sid: string): Relationship {
  const resource: ObjectAndRelation = { objectType: rt, objectId: rid, relation: rrel };
  const subject: ObjectAndRelation = { objectType: st, objectId: sid, relation: ELLIPSIS };
  return createRelationship(resource, subject);
}

/** Epoch NANOS for a UTC calendar date - core's `Relationship.optionalExpiration` representation. */
function utcNanos(year: number, month: number, day: number): bigint {
  return BigInt(Date.UTC(year, month - 1, day)) * 1_000_000n;
}

async function newCluster(storage: GrainStorage): Promise<TestCluster> {
  return TestCluster.start({
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
}

/** See the same helper in `stage1-journaled-write-path-tests.test.ts`: no watch is started here. */
function grainFactory(cluster: TestCluster): GrainFactoryAccess {
  return {
    getGrain<T>(def: GrainInterface<T>, key: GrainKeyFor<T>): T {
      return cluster.primary.host.getGrain(def, key);
    },
    createObjectReference<T>(): T {
      throw new Error("observer references are not reached by this gate");
    },
    deleteObjectReference(): void {
      throw new Error("observer references are not reached by this gate");
    },
  };
}

// --- helpers ---

async function writeBoth(
  inMem: IDatastore,
  grain: IDatastore,
  ...ops: ReadonlyArray<readonly [Op, Relationship]>
): Promise<void> {
  const updates: RelationshipUpdate[] = ops.map(([operation, relationship]) => ({
    relationship,
    operation,
  }));
  await inMem.readWriteTx(async (tx) => {
    await tx.writeRelationships(updates);
  });
  await grain.readWriteTx(async (tx) => {
    await tx.writeRelationships(updates);
  });
}

async function deleteMatching(
  ds: IDatastore,
  filter: RelationshipsFilter,
  limit: bigint | undefined,
): Promise<DeleteRelationshipsResult> {
  let result: DeleteRelationshipsResult = { count: 0n, reachedLimit: false };
  await ds.readWriteTx(async (tx) => {
    result = await tx.deleteRelationships(filter, limit);
  });
  return result;
}

/** `IReadOnlyDictionary` context rendered ordinally by key, for a canonical payload comparison. */
function contextString(ctx: ReadonlyMap<string, unknown> | undefined): string {
  if (ctx === undefined || ctx.size === 0) return "";
  return [...ctx.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(",");
}

function canonicalize(relationship: Relationship): string {
  const cav = relationship.optionalCaveat;
  const caveat = cav !== undefined ? `[${cav.caveatName}:${contextString(cav.context)}]` : "";
  const exp =
    relationship.optionalExpiration !== undefined ? `@exp=${relationship.optionalExpiration}` : "";
  const { resource, subject } = relationship.reference;
  return (
    `${resource.objectType}:${resource.objectId}#${resource.relation}` +
    `@${subject.objectType}:${subject.objectId}#${subject.relation}${caveat}${exp}`
  );
}

/** `ImmutableHashSet<string>` -> a de-duplicated, ordinally sorted array (order-insensitive equality). */
async function liveSet(ds: IDatastore): Promise<string[]> {
  const head = await ds.headRevision();
  const reader = ds.snapshotReader(head.revision);
  const set = new Set<string>();
  for await (const relationship of reader.queryRelationships({}))
    set.add(canonicalize(relationship));
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function assertLiveSetsEqual(inMem: IDatastore, grain: IDatastore): Promise<void> {
  expect(await liveSet(grain)).toEqual(await liveSet(inMem));
}

async function single(
  ds: IDatastore,
  predicate: (relationship: Relationship) => boolean,
): Promise<Relationship> {
  const head = await ds.headRevision();
  const reader = ds.snapshotReader(head.revision);
  for await (const relationship of reader.queryRelationships({}))
    if (predicate(relationship)) return relationship;
  throw new Error("no matching relationship at head");
}

async function readSchema(ds: IDatastore): Promise<Uint8Array | undefined> {
  const head = await ds.headRevision();
  return ds.snapshotReader(head.revision).readStoredSchema();
}

async function readCounter(ds: IDatastore, name: string): Promise<RelationshipsFilter | undefined> {
  const head = await ds.headRevision();
  return ds.snapshotReader(head.revision).readCounterFilter(name);
}

/**
 * The C#'s `JsonSerializer.Deserialize<Dictionary<string, object?>>` of
 * `{ "level": 7, "name": "alice", "active": true }`, which yields BOXED `JsonElement` values - the
 * exact shape the grain-storage JSON default corrupted. The port's caveat context is a
 * `ReadonlyMap` of plain JSON values, so the deserialize is the literal below; what the gate proves
 * is unchanged - the values survive the CAS + conversion round-trip with their JSON types intact.
 */
function caveatContext(): ReadonlyMap<string, unknown> {
  return new Map<string, unknown>(
    Object.entries(JSON.parse('{ "level": 7, "name": "alice", "active": true }') as object),
  );
}

function withCaveatContext(
  relationship: Relationship,
  name: string,
  ctx: ReadonlyMap<string, unknown>,
): Relationship {
  return { ...relationship, optionalCaveat: { caveatName: name, context: ctx } };
}

async function* toAsync(source: readonly Relationship[]): AsyncIterable<Relationship> {
  for (const r of source) yield r;
}

describe("GrainBackedDatastoreFidelityTests", () => {
  it("GrainBackedDatastore_MatchesReferenceDatastore_AtLiveSetLevel", async () => {
    const inMem: IDatastore = new ReferenceDatastore();
    const cluster = await newCluster(new MemoryGrainStorage());
    try {
      const hub = createIsolatedWatchHub(grainFactory(cluster));
      try {
        const grainDs: IDatastore = new GrainBackedDatastore(grainFactory(cluster), hub);

        // Step 1: distinct creates.
        const a = rel("doc", "a", "viewer", "user", "alice");
        const b = rel("doc", "b", "viewer", "user", "bob");
        const c = rel("doc", "c", "editor", "user", "carol");
        await writeBoth(inMem, grainDs, ["create", a], ["create", b], ["create", c]);
        await assertLiveSetsEqual(inMem, grainDs);

        // Step 2: touch over an existing key (close-old + create-new) and a brand-new touch.
        const aTouched: Relationship = { ...a, optionalCaveat: { caveatName: "is_active" } };
        const d = rel("doc", "d", "viewer", "user", "dave");
        await writeBoth(inMem, grainDs, ["touch", aTouched], ["touch", d]);
        await assertLiveSetsEqual(inMem, grainDs);

        // Step 3: delete a base row, and create+delete the same key within one batch.
        const e = rel("doc", "e", "viewer", "user", "erin");
        await writeBoth(inMem, grainDs, ["delete", b], ["create", e], ["delete", e]);
        await assertLiveSetsEqual(inMem, grainDs);

        // Step 4: create an already-live key -> conflict on BOTH; live-set unchanged.
        await expect(
          inMem.readWriteTx(async (tx) => {
            await tx.writeRelationships([{ relationship: c, operation: "create" }]);
          }),
        ).rejects.toBeInstanceOf(CreateRelationshipExistsException);
        await expect(
          grainDs.readWriteTx(async (tx) => {
            await tx.writeRelationships([{ relationship: c, operation: "create" }]);
          }),
        ).rejects.toBeInstanceOf(CreateRelationshipExistsException);
        await assertLiveSetsEqual(inMem, grainDs);

        // Step 5: deleteRelationships with a limit smaller than the match count, then the remainder.
        const f = rel("trip", "x", "viewer", "user", "fred");
        const g = rel("trip", "y", "viewer", "user", "gina");
        const h = rel("trip", "z", "viewer", "user", "hank");
        await writeBoth(inMem, grainDs, ["create", f], ["create", g], ["create", h]);

        const tripFilter: RelationshipsFilter = {
          optionalResourceType: "trip",
          optionalResourceRelation: "viewer",
        };
        const inMemLimited = await deleteMatching(inMem, tripFilter, 2n);
        const grainLimited = await deleteMatching(grainDs, tripFilter, 2n);
        expect(grainLimited).toEqual(inMemLimited);
        expect(grainLimited).toEqual({ count: 2n, reachedLimit: true });
        await assertLiveSetsEqual(inMem, grainDs);

        const inMemRest = await deleteMatching(inMem, tripFilter, undefined);
        const grainRest = await deleteMatching(grainDs, tripFilter, undefined);
        expect(grainRest).toEqual(inMemRest);
        expect(grainRest.reachedLimit).toBe(false);
        await assertLiveSetsEqual(inMem, grainDs);

        // Step 6: a populated caveat CONTEXT survives the CAS + conversion round-trip.
        const ctxRel = withCaveatContext(
          rel("doc", "ctx", "viewer", "user", "ivan"),
          "is_active",
          caveatContext(),
        );
        await writeBoth(inMem, grainDs, ["touch", ctxRel]);
        await assertLiveSetsEqual(inMem, grainDs);

        const ctxStored = await single(grainDs, (r) => r.reference.resource.objectId === "ctx");
        expect(ctxStored.optionalCaveat?.context).toBeDefined();
        expect(ctxStored.optionalCaveat!.caveatName).toBe("is_active");
        // `JsonElement.GetRawText()` -> the value's JSON text. The port keeps plain JSON values, so
        // re-serializing one is the same assertion: the JSON TYPE survived, not just the digits.
        expect(JSON.stringify(ctxStored.optionalCaveat!.context!.get("level"))).toBe("7");
        expect(JSON.stringify(ctxStored.optionalCaveat!.context!.get("name"))).toBe('"alice"');
        expect(JSON.stringify(ctxStored.optionalCaveat!.context!.get("active"))).toBe("true");

        // Step 7: expiration round-trips; an already-expired row is dropped symmetrically (both read
        // via queryRelationships, which applies the same expiration filter), and a future expiration
        // survives.
        const future = utcNanos(2999, 1, 1);
        const past = utcNanos(2000, 1, 1);
        await writeBoth(
          inMem,
          grainDs,
          [
            "create",
            { ...rel("exp", "future", "viewer", "user", "nora"), optionalExpiration: future },
          ],
          ["create", { ...rel("exp", "past", "viewer", "user", "owen"), optionalExpiration: past }],
        );
        await assertLiveSetsEqual(inMem, grainDs);
        const futureStored = await single(
          grainDs,
          (r) => r.reference.resource.objectId === "future",
        );
        expect(futureStored.optionalExpiration).toBe(future);

        // Step 8: bulk import.
        const bulk = [
          rel("bulk", "1", "viewer", "user", "u1"),
          rel("bulk", "2", "viewer", "user", "u2"),
        ];
        await inMem.readWriteTx(async (tx) => {
          await tx.bulkLoad(toAsync(bulk));
        });
        await grainDs.readWriteTx(async (tx) => {
          await tx.bulkLoad(toAsync(bulk));
        });
        await assertLiveSetsEqual(inMem, grainDs);

        // Step 9: schema write -> same effective schema bytes at head.
        const schema = new TextEncoder().encode("definition doc { relation viewer: user }");
        await inMem.readWriteTx(async (tx) => {
          await tx.writeStoredSchema(schema);
        });
        await grainDs.readWriteTx(async (tx) => {
          await tx.writeStoredSchema(schema);
        });
        const inMemSchema = await readSchema(inMem);
        const grainSchema = await readSchema(grainDs);
        expect(inMemSchema).toBeDefined();
        expect(grainSchema).toBeDefined();
        expect([...grainSchema!]).toEqual([...inMemSchema!]);

        // Step 10: counter register -> filter live (present) at head on both.
        const counterFilter: RelationshipsFilter = {
          optionalResourceType: "doc",
          optionalResourceRelation: "viewer",
        };
        await inMem.readWriteTx(async (tx) => {
          await tx.writeCounter("c1", counterFilter);
        });
        await grainDs.readWriteTx(async (tx) => {
          await tx.writeCounter("c1", counterFilter);
        });
        expect(await readCounter(inMem, "c1")).toBeDefined();
        expect(await readCounter(grainDs, "c1")).toBeDefined();

        await assertLiveSetsEqual(inMem, grainDs);
      } finally {
        await hub.dispose();
      }
    } finally {
      await cluster.dispose();
    }
  });
});
