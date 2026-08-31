import { afterEach, describe, expect, it, vi } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { Relationship } from "@benedb/core/relationship";
import { createRelationship } from "@benedb/core/relationship";
import type { RelationshipReference } from "@benedb/core/relationship-reference";

import { CounterNotRegisteredException, RevisionNotFoundException } from "./datastore-exceptions";
import type {
  CounterVersion,
  DatastoreState,
  SchemaVersion,
  StoredRelationship,
} from "./datastore-state";
import { MvccSnapshotReader } from "./mvcc-snapshot-reader";
import type { RelationshipsFilter, SubjectsFilter } from "./relationships-filter";

// Characterization of Spiceport's `MvccSnapshotReader`. `DatastoreStateGcTests` gates only the
// constructor's below-the-floor guard; every other path is covered in Spiceport sociably, from
// `ReferenceDatastoreTests`, so these direct tests are the reader's only own gate.
//
// Port decisions pinned here:
//
// 1. `DateTimeOffset.UtcNow` is sampled ONCE per query, before the scan, never per row - a long
//    scan must not straddle an expiry mid-result. The "sampled once" cases below advance the
//    clock mid-enumeration to prove it.
//
// 2. That `now` is nanos-since-epoch `bigint`, to compare against core's `optionalExpiration`.
//    The port reads it as `BigInt(Date.now()) * 1_000_000n`, so its resolution is MILLISECONDS
//    against the C#'s 100ns ticks: an expiration inside the current millisecond is treated as
//    not-yet-expired where the C# might have expired it. Stated at the site and pinned here.
//
// 3. `IsExpired` is `exp <= now` - INCLUSIVE. An expiration exactly equal to the sampled now is
//    expired.
//
// 4. `[EnumeratorCancellation] CancellationToken` becomes an optional `AbortSignal` and the
//    per-row `ThrowIfCancellationRequested` becomes a per-row `signal?.throwIfAborted()`,
//    including in the post-sort loop of the ordered reverse path.
//
// 5. The unsorted reverse path streams in storage order with no materialization and ignores
//    `after` entirely; the sorted path materializes, sorts, and applies the exclusive keyset
//    AFTER the sort. The two paths stay distinct.
//
// 6. `Func<long, bool> isValid` is a LIVE callback `(revision: bigint) => boolean`, re-invoked
//    on every `isValid` read - not a boolean captured at construction.
//
// 7. `CountRelationships` counts as `ulong`, which this port represents as `bigint` (the choice
//    `IDatastoreReader` already made for every count on the seam).

const NANOS_PER_MILLISECOND = 1_000_000n;
const BASE_MS = 1_700_000_000_000;
const BASE_NANOS = BigInt(BASE_MS) * NANOS_PER_MILLISECOND;

afterEach(() => {
  vi.useRealTimers();
});

function freezeClockAtBase(): void {
  // Only `Date` is faked: faking the microtask queue would deadlock the `await`s below.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(BASE_MS));
}

function rel(
  rid: string,
  sid: string,
  expiration?: bigint | undefined,
  relation = "viewer",
): Relationship {
  return {
    ...createRelationship(
      { objectType: "doc", objectId: rid, relation },
      { objectType: "user", objectId: sid, relation: ELLIPSIS },
    ),
    optionalExpiration: expiration,
  };
}

function row(
  relationship: Relationship,
  created = 10n,
  deleted?: bigint | undefined,
): StoredRelationship {
  return { relationship, createdRevision: created, deletedRevision: deleted };
}

function state(
  relationships: readonly StoredRelationship[] = [],
  schemas: readonly SchemaVersion[] = [],
  counters: readonly CounterVersion[] = [],
  gcFloor = 0n,
): DatastoreState {
  return { headRevision: 100n, relationships, schemas, counters, gcFloor };
}

const ALL_DOCS: RelationshipsFilter = { optionalResourceType: "doc" };
const ALL_USERS: SubjectsFilter = { subjectType: "user" };

async function collect<T>(source: AsyncIterable<T>): Promise<readonly T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

function subjectIds(relationships: readonly Relationship[]): readonly string[] {
  return relationships.map((r) => r.reference.subject.objectId);
}

describe("MvccSnapshotReader constructor", () => {
  it("rejects a revision strictly below the collected floor", () => {
    const collected = state([], [], [], 50n);

    expect(() => new MvccSnapshotReader(collected, 49n, () => true)).toThrow(
      RevisionNotFoundException,
    );
  });

  it("names the rejected revision on the exception", () => {
    const collected = state([], [], [], 50n);

    // `RevisionNotFoundException(new TimestampRevision(revision))` - the message carries the
    // bare nanos string, so a plain `number` revision would render differently.
    expect(() => new MvccSnapshotReader(collected, 49n, () => true)).toThrow(/\b49\b/);
  });

  it("accepts a revision exactly at the floor and above it", () => {
    const collected = state([], [], [], 50n);

    expect(() => new MvccSnapshotReader(collected, 50n, () => true)).not.toThrow();
    expect(() => new MvccSnapshotReader(collected, 51n, () => true)).not.toThrow();
  });

  it("accepts any revision when nothing has been collected", () => {
    expect(() => new MvccSnapshotReader(state(), 0n, () => true)).not.toThrow();
  });
});

describe("MvccSnapshotReader.isValid", () => {
  it("re-invokes the callback with this reader's revision on every read", () => {
    let valid = true;
    const seen: bigint[] = [];
    const reader = new MvccSnapshotReader(state(), 42n, (revision) => {
      seen.push(revision);
      return valid;
    });

    expect(reader.isValid).toBe(true);
    valid = false;
    expect(reader.isValid).toBe(false);
    expect(seen).toEqual([42n, 42n]);
  });
});

describe("MvccSnapshotReader.queryRelationships", () => {
  it("yields only rows MVCC-visible at the reader's revision and matching the filter", async () => {
    const s = state([
      row(rel("d1", "alice"), 10n, 20n),
      row(rel("d2", "bob"), 10n),
      row(rel("d3", "carol"), 30n),
    ]);
    const reader = new MvccSnapshotReader(s, 25n, () => true);

    expect(subjectIds(await collect(reader.queryRelationships(ALL_DOCS)))).toEqual(["bob"]);
    expect(
      subjectIds(
        await collect(reader.queryRelationships({ ...ALL_DOCS, optionalResourceIds: ["d9"] })),
      ),
    ).toEqual([]);
  });

  it("treats an expiration exactly equal to now as expired (inclusive)", async () => {
    freezeClockAtBase();
    const s = state([
      row(rel("d1", "atNow", BASE_NANOS)),
      row(rel("d2", "justAfter", BASE_NANOS + 1n)),
      row(rel("d3", "justBefore", BASE_NANOS - 1n)),
    ]);
    const reader = new MvccSnapshotReader(s, 100n, () => true);

    expect(subjectIds(await collect(reader.queryRelationships(ALL_DOCS)))).toEqual(["justAfter"]);
  });

  it("samples now ONCE per query, so a row cannot expire mid-scan", async () => {
    freezeClockAtBase();
    const s = state([
      row(rel("d1", "alice")),
      row(rel("d2", "bob", BASE_NANOS + 10n * NANOS_PER_MILLISECOND)),
    ]);
    const reader = new MvccSnapshotReader(s, 100n, () => true);

    const iterator = reader.queryRelationships(ALL_DOCS)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.reference.subject.objectId).toBe("alice");

    // The clock moves past bob's expiration between rows. A per-row `now` would drop him.
    vi.setSystemTime(new Date(BASE_MS + 60_000));
    const second = await iterator.next();

    expect(second.done).toBe(false);
    expect(second.value?.reference.subject.objectId).toBe("bob");
  });

  it("re-samples now on each fresh query", async () => {
    freezeClockAtBase();
    const s = state([row(rel("d1", "bob", BASE_NANOS + 10n * NANOS_PER_MILLISECOND))]);
    const reader = new MvccSnapshotReader(s, 100n, () => true);

    expect(await collect(reader.queryRelationships(ALL_DOCS))).toHaveLength(1);
    vi.setSystemTime(new Date(BASE_MS + 60_000));
    expect(await collect(reader.queryRelationships(ALL_DOCS))).toHaveLength(0);
  });

  it("checks the abort signal per row", async () => {
    const s = state([row(rel("d1", "alice")), row(rel("d2", "bob"))]);
    const reader = new MvccSnapshotReader(s, 100n, () => true);

    const preAborted = AbortSignal.abort();
    await expect(collect(reader.queryRelationships(ALL_DOCS, preAborted))).rejects.toThrow();

    const controller = new AbortController();
    const iterator = reader.queryRelationships(ALL_DOCS, controller.signal)[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
  });

  it("is lazy: nothing is scanned until the iterable is enumerated", async () => {
    const s = state([row(rel("d1", "alice"))]);
    const reader = new MvccSnapshotReader(s, 100n, () => true);

    const iterable = reader.queryRelationships(ALL_DOCS, AbortSignal.abort());

    // Returned synchronously without throwing; the abort only surfaces on the first pull.
    await expect(collect(iterable)).rejects.toThrow();
  });
});

describe("MvccSnapshotReader.reverseQueryRelationships", () => {
  const carol = rel("d3", "carol");
  const alice = rel("d1", "alice");
  const bob = rel("d2", "bob");
  const storageOrder = state([row(carol), row(alice), row(bob)]);

  it("streams in storage order when no options are given", async () => {
    const reader = new MvccSnapshotReader(storageOrder, 100n, () => true);

    expect(subjectIds(await collect(reader.reverseQueryRelationships(ALL_USERS)))).toEqual([
      "carol",
      "alice",
      "bob",
    ]);
  });

  it("streams in storage order when the sort is explicitly unsorted", async () => {
    const reader = new MvccSnapshotReader(storageOrder, 100n, () => true);

    expect(
      subjectIds(await collect(reader.reverseQueryRelationships(ALL_USERS, { sort: "unsorted" }))),
    ).toEqual(["carol", "alice", "bob"]);
  });

  it("ignores `after` on the unsorted fast path", async () => {
    const reader = new MvccSnapshotReader(storageOrder, 100n, () => true);

    // The keyset guard lives only in the ordered path; the fast path has no materialization and
    // no filtering, so a stray `after` must not silently truncate the stream.
    const result = await collect(
      reader.reverseQueryRelationships(ALL_USERS, { sort: "unsorted", after: bob.reference }),
    );

    expect(subjectIds(result)).toEqual(["carol", "alice", "bob"]);
  });

  it("sorts by the subject-first total order", async () => {
    const reader = new MvccSnapshotReader(storageOrder, 100n, () => true);

    expect(
      subjectIds(await collect(reader.reverseQueryRelationships(ALL_USERS, { sort: "bySubject" }))),
    ).toEqual(["alice", "bob", "carol"]);
  });

  it("applies `after` as an EXCLUSIVE keyset over the sorted order", async () => {
    const reader = new MvccSnapshotReader(storageOrder, 100n, () => true);

    const afterAlice: RelationshipReference = alice.reference;
    expect(
      subjectIds(
        await collect(
          reader.reverseQueryRelationships(ALL_USERS, { sort: "bySubject", after: afterAlice }),
        ),
      ),
    ).toEqual(["bob", "carol"]);

    expect(
      subjectIds(
        await collect(
          reader.reverseQueryRelationships(ALL_USERS, {
            sort: "bySubject",
            after: carol.reference,
          }),
        ),
      ),
    ).toEqual([]);
  });

  it("honours MVCC visibility, the subject filter and expiration on both paths", async () => {
    freezeClockAtBase();
    const s = state([
      row(rel("d1", "alice"), 10n, 20n), // deleted before the pinned revision
      row(rel("d2", "bob", BASE_NANOS)), // expired exactly at now
      row(rel("d3", "carol")),
      row({
        ...createRelationship(
          { objectType: "doc", objectId: "d4", relation: "viewer" },
          { objectType: "group", objectId: "eng", relation: "member" },
        ),
      }), // wrong subject type
    ]);
    const reader = new MvccSnapshotReader(s, 50n, () => true);

    expect(subjectIds(await collect(reader.reverseQueryRelationships(ALL_USERS)))).toEqual([
      "carol",
    ]);
    expect(
      subjectIds(await collect(reader.reverseQueryRelationships(ALL_USERS, { sort: "bySubject" }))),
    ).toEqual(["carol"]);
  });

  it("checks the abort signal per row on the unsorted path", async () => {
    const reader = new MvccSnapshotReader(storageOrder, 100n, () => true);

    await expect(
      collect(reader.reverseQueryRelationships(ALL_USERS, undefined, AbortSignal.abort())),
    ).rejects.toThrow();
  });

  it("checks the abort signal per row in the post-sort loop", async () => {
    const reader = new MvccSnapshotReader(storageOrder, 100n, () => true);

    const controller = new AbortController();
    const ordered = reader.reverseQueryRelationships(
      ALL_USERS,
      { sort: "bySubject" },
      controller.signal,
    );
    const iterator = ordered[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.reference.subject.objectId).toBe("alice");

    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
  });
});

describe("MvccSnapshotReader.readStoredSchema", () => {
  const encoder = new TextEncoder();
  const s = state(
    [],
    [
      { revision: 10n, bytes: encoder.encode("s10"), hash: "h10" },
      { revision: 60n, bytes: encoder.encode("s60"), hash: "h60" },
    ],
  );

  it("returns the schema bytes effective at the reader's revision", async () => {
    const reader = new MvccSnapshotReader(s, 50n, () => true);

    expect(new TextDecoder().decode(await reader.readStoredSchema())).toBe("s10");
  });

  it("returns undefined when no schema is effective at the revision", async () => {
    const reader = new MvccSnapshotReader(s, 9n, () => true);

    expect(await reader.readStoredSchema()).toBeUndefined();
  });
});

describe("MvccSnapshotReader counters", () => {
  const docs: RelationshipsFilter = { optionalResourceType: "doc" };
  const folders: RelationshipsFilter = { optionalResourceType: "folder" };
  const counters: readonly CounterVersion[] = [
    { revision: 10n, name: "c1", filter: docs },
    { revision: 20n, name: "c2", filter: folders },
    { revision: 30n, name: "c2", filter: undefined }, // tombstone
  ];
  const rows: readonly StoredRelationship[] = [
    row(rel("d1", "alice")),
    row(rel("d2", "bob")),
    row(rel("d3", "carol"), 10n, 20n), // not visible at 50
  ];

  it("reads the counter filter live at the reader's revision", async () => {
    const reader = new MvccSnapshotReader(state(rows, [], counters), 50n, () => true);

    expect(await reader.readCounterFilter("c1")).toEqual(docs);
    expect(await reader.readCounterFilter("c2")).toBeUndefined(); // tombstoned at 30
    expect(await reader.readCounterFilter("nope")).toBeUndefined();
  });

  it("enumerates the counters live at the reader's revision", async () => {
    const reader = new MvccSnapshotReader(state(rows, [], counters), 50n, () => true);

    expect(await collect(reader.lookupCounters())).toEqual([{ name: "c1", filter: docs }]);

    const earlier = new MvccSnapshotReader(state(rows, [], counters), 25n, () => true);
    expect(await collect(earlier.lookupCounters())).toEqual([
      { name: "c1", filter: docs },
      { name: "c2", filter: folders },
    ]);
  });

  it("checks the abort signal per counter", async () => {
    const reader = new MvccSnapshotReader(state(rows, [], counters), 25n, () => true);

    await expect(collect(reader.lookupCounters(AbortSignal.abort()))).rejects.toThrow();
  });

  it("counts the relationships matching the registered filter at the same snapshot", async () => {
    const reader = new MvccSnapshotReader(state(rows, [], counters), 50n, () => true);

    // `ulong` on the seam is `bigint`, so the count must be a bigint, not a number.
    expect(await reader.countRelationships("c1")).toBe(2n);
  });

  it("counts zero when nothing matches", async () => {
    const empty: readonly CounterVersion[] = [
      { revision: 10n, name: "c1", filter: { optionalResourceType: "folder" } },
    ];
    const reader = new MvccSnapshotReader(state(rows, [], empty), 50n, () => true);

    expect(await reader.countRelationships("c1")).toBe(0n);
  });

  it("throws CounterNotRegisteredException for a counter that is not live here", async () => {
    const reader = new MvccSnapshotReader(state(rows, [], counters), 50n, () => true);

    await expect(reader.countRelationships("c2")).rejects.toThrow(CounterNotRegisteredException);
    await expect(reader.countRelationships("nope")).rejects.toThrow(CounterNotRegisteredException);
  });
});
