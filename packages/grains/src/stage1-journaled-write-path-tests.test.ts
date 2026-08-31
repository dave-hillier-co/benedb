import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainStorage } from "@thresh/core/grain-storage";
import type { GrainKeyFor } from "@thresh/core/key-kinds";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { TestCluster } from "@thresh/testing/test-cluster";
import { constructGrain } from "@thresh/runtime/construct-grain";
import { describe, expect, it } from "vitest";

import type { FullRelationshipsFilterWire } from "./datastore-dtos";
import { datastoreGrainStateEmpty, type DatastoreGrainState } from "./datastore-grain-state";
import { DatastoreGrain } from "./datastore-grain";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { createIsolatedWatchHub } from "./isolated-watch-hub";
import type { LogEvent } from "./log-event";
import { logFoldApplyEvent } from "./log-fold";
import type { RelationshipWire } from "./relationships-dtos";
// Registers the `RevisionNotFoundException` value-codec surrogate. `ReadFrom_BelowGcWindow_Throws`
// is the only gate in this file that lets a domain exception cross the grain boundary, and it
// asserts the CLASS, not the message - so the import is load-bearing, not decorative.
import "./revision-not-found-surrogate";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/Stage1JournaledWritePathTests.cs`.
 *
 * Stage-1 gates for the journaled (event-sourced) datastore write path: the append-only
 * {@link LogEvent} log is the source of truth, persisted via the grain's `CustomStorageInterface`
 * over a Thresh grain-storage provider. Drives writes through the real
 * `GrainBackedDatastore.readWriteTx` against a single-silo in-memory {@link TestCluster}, then
 * asserts the log feed (`IDatastoreLog.readFrom`) and the fold reproduce the state.
 *
 * Port decisions (the C# silo configurator does not transliterate; see CLAUDE.md's "Thresh is what
 * it is" rule):
 *
 *  1. `AddDatastoreGrainStorage(new ConfigurationBuilder().Build())` is the PRODUCTION registration
 *     taking its in-memory branch, and `DatastoreStorageConfig` is an S5 (packages/silo) ledger
 *     row. S5 is NOT pulled forward: this file registers a Thresh `MemoryGrainStorage` under the
 *     name `datastore` itself. The intent of the C# call - "the provider under this name must
 *     round-trip the state EXACTLY" - is carried by the workload, which deliberately writes a
 *     caveated relationship (`is_active` with `level: 7`) and an expiring one, the two shapes the
 *     C#'s Newtonsoft-JSON default silently corrupted. Thresh's `MemoryGrainStorage` uses
 *     `structuredClone`, which round-trips `Uint8Array`, `Map` and `bigint`, so there is no
 *     serializer to force - but the gate stays, because the persisted-value codec is exactly what a
 *     Redis/Postgres provider would swap in underneath.
 *  2. `AddCustomStorageBasedLogConsistencyProvider("CustomStorage")` has no counterpart either:
 *     Thresh's `bindJournaledGrain` DETECTS a `CustomStorageInterface` host and installs the
 *     custom-storage adaptor instead of the journal substrate, so the wiring is the grain's own
 *     shape rather than a named provider. `TestCluster` already calls `useMemoryJournaling`, which
 *     is what makes the binder run at all.
 *  3. Thresh has no constructor DI. The C#'s `[FromKeyedServices("datastore")] IGrainStorage` is
 *     supplied through a `GrainActivator` (Thresh's `IGrainActivator`), the same seam
 *     `GrainActivatorTests` uses upstream; the activator falls through to `new ctor()` for every
 *     other grain type on the silo (the management grain among them).
 *  4. `[Collection("MeshCluster")]` -> nothing. See `mesh-cluster-collection.ts`: vitest isolates
 *     each test FILE, and this file's cluster is built and disposed per case, so there is no
 *     process-wide state for a sibling file to race.
 *  5. `await using var scope` -> `try { ... } finally { await cluster.dispose(); }`, and the hub is
 *     disposed the same way. A leaked hub leaves a heartbeat loop running past the test.
 */

/** The fixed 2030-01-01T00:00:00Z expiration, as epoch NANOS (core's representation). */
const EXPIRY = BigInt(Date.UTC(2030, 0, 1)) * 1_000_000n;

function rel(rt: string, rid: string, relation: string, st: string, sid: string): Relationship {
  const resource: ObjectAndRelation = { objectType: rt, objectId: rid, relation };
  const subject: ObjectAndRelation = { objectType: st, objectId: sid, relation: ELLIPSIS };
  return createRelationship(resource, subject);
}

function update(
  relationship: Relationship,
  operation: RelationshipUpdate["operation"],
): RelationshipUpdate {
  return { relationship, operation };
}

/**
 * A single-silo cluster hosting the real `DatastoreGrain` over `storage`, registered under the
 * `datastore` provider name for parity with the C# even though the grain reaches it through the
 * activator rather than a keyed lookup.
 */
async function newCluster(storage: GrainStorage): Promise<TestCluster> {
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

/**
 * `TestCluster.GrainFactory`. `SiloHost` offers `getGrain` but not the observer members, and the
 * cases below never start the watch hub (only `LogWatchHub.ensureStarted` reaches them), so the two
 * observer members throw rather than pretending - exactly as the C# fakes in this suite's siblings
 * do for the parts of `IGrainFactory` they never reach.
 */
function grainFactory(cluster: TestCluster): GrainFactoryAccess {
  return {
    getGrain<T>(def: GrainInterface<T>, key: GrainKeyFor<T>): T {
      return cluster.primary.host.getGrain(def, key);
    },
    createObjectReference<T>(): T {
      throw new Error("observer references are not reached by these gates");
    },
    deleteObjectReference(): void {
      throw new Error("observer references are not reached by these gates");
    },
  };
}

function grain(cluster: TestCluster): IDatastoreGrain {
  return cluster.primary.host.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
}

/** Runs a representative spread of writes through the grain-backed datastore. */
async function runWorkload(ds: IDatastore): Promise<void> {
  // Schema + counter + creates.
  await ds.readWriteTx(async (tx) => {
    await tx.writeStoredSchema(
      new TextEncoder().encode("definition user {}\ndefinition doc { relation viewer: user }"),
    );
    await tx.writeRelationships([
      update(rel("doc", "a", "viewer", "user", "alice"), "create"),
      update(rel("doc", "b", "viewer", "user", "bob"), "create"),
    ]);
    await tx.writeCounter("doc_viewers", {
      optionalResourceType: "doc",
      optionalResourceRelation: "viewer",
    });
  });

  // A caveated + an expiring relationship.
  await ds.readWriteTx(async (tx) => {
    const caveated = createRelationship(
      { objectType: "doc", objectId: "c", relation: "viewer" },
      { objectType: "user", objectId: "carol", relation: ELLIPSIS },
      { caveatName: "is_active", context: new Map<string, unknown>([["level", 7]]) },
    );
    const expiring: Relationship = {
      ...rel("doc", "d", "viewer", "user", "dave"),
      optionalExpiration: EXPIRY,
    };
    await tx.writeRelationships([update(caveated, "create"), update(expiring, "create")]);
  });

  // A touch-over-existing + a delete.
  await ds.readWriteTx(async (tx) => {
    await tx.writeRelationships([
      update(rel("doc", "a", "viewer", "user", "alice"), "touch"),
      update(rel("doc", "b", "viewer", "user", "bob"), "delete"),
    ]);
  });
}

// --- helpers ---

async function drainPaged(
  target: IDatastoreGrain,
  from: bigint,
  pageSize: number,
): Promise<LogEvent[]> {
  const all: LogEvent[] = [];
  let cursor = from;
  for (;;) {
    const segment = await target.readFrom(cursor, pageSize);
    if (segment.events.length === 0) break;
    all.push(...segment.events);
    cursor = segment.events[segment.events.length - 1]!.revision;
  }
  return all;
}

/**
 * The C#'s `Canonical`: a per-event string that ignores the parts that legitimately differ between
 * pagings and depends on nothing but content. `OrderBy` is a STABLE sort in .NET and
 * `Array.prototype.sort` is stable too, so ties keep request order on both sides.
 */
function canonical(events: readonly LogEvent[]): string[] {
  return events.map((e) => {
    const changes = [...e.relationshipChanges]
      .sort((a, b) =>
        a.relationship.resourceId < b.relationship.resourceId
          ? -1
          : a.relationship.resourceId > b.relationship.resourceId
            ? 1
            : 0,
      )
      .map(
        (u) =>
          `${u.operation}:${u.relationship.resourceType}:${u.relationship.resourceId}#${u.relationship.resourceRelation}@${u.relationship.subjectType}:${u.relationship.subjectId}`,
      )
      .join(",");
    const counters = [...e.counterChanges]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((c) => `${c.name}:${c.filter !== undefined}`)
      .join(",");
    return `r${e.revision}|schema=${e.schemaChange !== undefined}|${changes}|${counters}`;
  });
}

function identityOfWire(r: RelationshipWire): string {
  return `${r.resourceType}:${r.resourceId}#${r.resourceRelation}@${r.subjectType}:${r.subjectId}#${r.subjectRelation}`;
}

function identityOf(r: Relationship): string {
  const { resource, subject } = r.reference;
  return `${resource.objectType}:${resource.objectId}#${resource.relation}@${subject.objectType}:${subject.objectId}#${subject.relation}`;
}

/** `SortedSet<string>` -> a de-duplicated, ordinally sorted array. */
function sortedSet(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function liveSet(state: DatastoreGrainState, atRevision: bigint): string[] {
  const live: string[] = [];
  for (const row of state.relationships) {
    if (
      row.createdRevision <= atRevision &&
      (row.deletedRevision === undefined || row.deletedRevision > atRevision)
    )
      live.push(identityOfWire(row.relationship));
  }
  return sortedSet(live);
}

function grainLiveIdentities(state: DatastoreGrainState): string[] {
  return liveSet(state, state.headRevision);
}

/** The C#'s base64 comparison of the effective schema bytes, as a hex string. */
function schemaBytesAt(state: DatastoreGrainState, atRevision: bigint): string | undefined {
  let result: string | undefined;
  for (const s of [...state.schemas].sort((a, b) => compareRevisions(a.revision, b.revision)))
    if (s.revision <= atRevision)
      result = [...s.bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return result;
}

/**
 * The C#'s `CounterResource`: the last version at or below `atRevision`, rendered as
 * `{resourceType}#{resourceRelation}` - or `undefined` when the counter ends tombstoned. C#
 * interpolates a null string as EMPTY, so an absent component must render as "" and never
 * "undefined".
 */
function counterResource(
  state: DatastoreGrainState,
  name: string,
  atRevision: bigint,
): string | undefined {
  let filter: FullRelationshipsFilterWire | undefined;
  let found = false;
  for (const c of [...state.counters].sort((a, b) => compareRevisions(a.revision, b.revision)))
    if (c.name === name && c.revision <= atRevision) {
      filter = c.filter;
      found = true;
    }
  return found && filter !== undefined
    ? `${filter.optionalResourceType ?? ""}#${filter.optionalResourceRelation ?? ""}`
    : undefined;
}

/**
 * `long.CompareTo` -> an explicit bigint comparator. `Array.prototype.sort` defaults to STRING
 * comparison and rejects the bigint a subtraction would return, so this must return -1/0/1.
 */
function compareRevisions(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function withCluster(body: (cluster: TestCluster) => Promise<void>): Promise<void> {
  const cluster = await newCluster(new MemoryGrainStorage());
  try {
    await body(cluster);
  } finally {
    await cluster.dispose();
  }
}

describe("Stage1JournaledWritePathTests", () => {
  /**
   * Gate 1: paged readFrom equivalence. `readFrom(0, inf)` in page sizes 1, 7 and inf must yield ONE
   * identical ordered event list (revision-ascending), proving paging is stable.
   */
  it("ReadFrom_IsPageSizeInvariant", async () => {
    await withCluster(async (cluster) => {
      const hub = createIsolatedWatchHub(grainFactory(cluster));
      try {
        const ds: IDatastore = new GrainBackedDatastore(grainFactory(cluster), hub);
        const target = grain(cluster);
        // The "from the beginning" cursor: the pre-first-write head. Revisions are timestamp-nanos,
        // so 0 is below the GC window; the seed head is the earliest valid cursor that precedes
        // every event.
        const from = (await target.getHead()).head;
        await runWorkload(ds);

        const whole = (await target.readFrom(from, Number.MAX_SAFE_INTEGER)).events;
        const byOne = await drainPaged(target, from, 1);
        const bySeven = await drainPaged(target, from, 7);

        expect(whole.length).toBeGreaterThan(0);
        expect(canonical(byOne)).toEqual(canonical(whole));
        expect(canonical(bySeven)).toEqual(canonical(whole));

        // Revisions are strictly ascending (the log offset order).
        const revs = whole.map((e) => e.revision);
        expect([...revs].sort(compareRevisions)).toEqual(revs);
      } finally {
        await hub.dispose();
      }
    });
  });

  /**
   * Gate 2: folding the event list from EMPTY via the same `applyEvent` the grain uses reproduces
   * the grain's materialized state (live-at-head, schema, counters) AND matches an independent
   * `ReferenceDatastore` reference-model run with the same ops.
   */
  it("Replay_FromEmpty_ReconstructsGrainStateAndMatchesReferenceModel", async () => {
    await withCluster(async (cluster) => {
      const hub = createIsolatedWatchHub(grainFactory(cluster));
      try {
        const ds: IDatastore = new GrainBackedDatastore(grainFactory(cluster), hub);
        const target = grain(cluster);
        const from = (await target.getHead()).head;
        await runWorkload(ds);

        const events = (await target.readFrom(from, Number.MAX_SAFE_INTEGER)).events;

        // Fold from empty (seeded at the pre-first-write head) via the production fold.
        let folded = datastoreGrainStateEmpty(from);
        for (const ev of events) folded = logFoldApplyEvent(folded, ev);

        const grainState = await target.readState();

        // The fold's live set == the grain's live set at head.
        expect(liveSet(folded, grainState.headRevision)).toEqual(
          liveSet(grainState, grainState.headRevision),
        );
        // Schema bytes effective at head match.
        expect(schemaBytesAt(folded, grainState.headRevision)).toEqual(
          schemaBytesAt(grainState, grainState.headRevision),
        );
        // Counter filter survives the fold (resource type + relation).
        expect(counterResource(folded, "doc_viewers", grainState.headRevision)).toEqual(
          counterResource(grainState, "doc_viewers", grainState.headRevision),
        );

        // Independent reference model: the SAME ops through a fresh ReferenceDatastore yield the
        // same live set.
        const reference = new ReferenceDatastore();
        await runWorkload(reference);
        const referenceHead = await reference.headRevision();
        const referenceReader = reference.snapshotReader(referenceHead.revision);
        const referenceSet: string[] = [];
        for await (const r of referenceReader.queryRelationships({}))
          referenceSet.push(identityOf(r));
        // Compare identity sets (revisions differ between backends; expiration is dropped
        // symmetrically by the same queryRelationships path).
        expect(sortedSet(referenceSet)).toEqual(grainLiveIdentities(grainState));
      } finally {
        await hub.dispose();
      }
    });
  });

  /** Gate 4: a cursor older than the GC window throws RevisionNotFoundException. */
  it("ReadFrom_BelowGcWindow_Throws", async () => {
    await withCluster(async (cluster) => {
      const hub = createIsolatedWatchHub(grainFactory(cluster));
      try {
        const ds: IDatastore = new GrainBackedDatastore(grainFactory(cluster), hub);
        await runWorkload(ds);
        const target = grain(cluster);

        const head = (await target.getHead()).head;
        // One nanosecond past 24h before head is outside the retained window. The 24h constant is
        // COMPUTED the way the grain computes it - `(long)TotalMilliseconds * 1_000_000` - not
        // written as a literal, so a change to the truncation rule breaks both together.
        const gcWindowNanos = BigInt(Math.trunc(24 * 60 * 60 * 1000)) * 1_000_000n;
        const tooOld = head - gcWindowNanos - 1n;

        await expect(target.readFrom(tooOld, Number.MAX_SAFE_INTEGER)).rejects.toBeInstanceOf(
          RevisionNotFoundException,
        );
      } finally {
        await hub.dispose();
      }
    });
  });

  /**
   * Gate 5: a net counter delta whose guard precondition is false in the fold base (same-commit
   * register+unregister, and the inverse) must fold WITHOUT throwing. The fold appends the net
   * counter version directly (matching commit), not via the guarded writeCounter/deleteCounter -
   * otherwise the journaled append and the reactivation replay would throw on a perfectly valid
   * commit.
   */
  it("CounterNetDelta_FoldsWithoutThrowing", async () => {
    await withCluster(async (cluster) => {
      const hub = createIsolatedWatchHub(grainFactory(cluster));
      try {
        const ds: IDatastore = new GrainBackedDatastore(grainFactory(cluster), hub);
        const target = grain(cluster);
        const from = (await target.getHead()).head;

        // Case 1: register then unregister "x" in ONE commit over a base where "x" was never
        // registered -> net tombstone. Pre-fix the fold replayed deleteCounter("x") over a base with
        // no live "x" and threw.
        await ds.readWriteTx(async (tx) => {
          await tx.writeCounter("x", { optionalResourceType: "doc" });
          await tx.deleteCounter("x");
        });

        // Case 2: "y" live, then unregister+register "y" in ONE commit -> net live over existing.
        // Pre-fix the fold replayed writeCounter("y", ...) over a base with "y" still live and threw
        // already-registered.
        await ds.readWriteTx(async (tx) => {
          await tx.writeCounter("y", { optionalResourceType: "doc" });
        });
        await ds.readWriteTx(async (tx) => {
          await tx.deleteCounter("y");
          await tx.writeCounter("y", { optionalResourceType: "folder" });
        });

        // Re-folding every event from empty must not throw, and must reproduce the grain's counter
        // state.
        const events = (await target.readFrom(from, Number.MAX_SAFE_INTEGER)).events;
        let folded = datastoreGrainStateEmpty(from);
        for (const ev of events) folded = logFoldApplyEvent(folded, ev);

        const grainState = await target.readState();
        // Ends tombstoned.
        expect(counterResource(grainState, "x", grainState.headRevision)).toBeUndefined();
        expect(counterResource(folded, "x", grainState.headRevision)).toBeUndefined();
        // Ends live (folder).
        expect(counterResource(grainState, "y", grainState.headRevision)).toBe("folder#");
        expect(counterResource(folded, "y", grainState.headRevision)).toBe("folder#");
      } finally {
        await hub.dispose();
      }
    });
  });
});
