import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import { createRelationship } from "@spacedb/core/relationship";

import {
  collectBelow,
  counterFilterAt,
  liveAt,
  schemaHashAt,
  type CounterVersion,
  type DatastoreState,
  type SchemaVersion,
  type StoredRelationship,
} from "./datastore-state";
import { RevisionNotFoundException } from "./datastore-exceptions";
import { MvccSnapshotReader } from "./mvcc-snapshot-reader";
import type { RelationshipsFilter } from "./relationships-filter";

// Port of Spiceport's `DatastoreStateGcTests` - the unit gates for `CollectBelow`, the single
// shared MVCC-collection fold primitive a GC log event applies. Cases and assertions are kept
// one-for-one with the C#.
//
// Port decisions pinned here:
//
// 1. Every C# `long` revision is a `bigint`, consistent with core's `TimestampRevision`. Mixing
//    a `number` literal into any of these comparisons is a type error at best and a silently
//    wrong comparison at worst, so every revision literal below carries the `n` suffix.
//
// 2. `CollectBelow` returns `this` when the floor does not advance. The C# asserts that with
//    `Assert.Same`, so the port must return the SAME OBJECT REFERENCE and the test uses `toBe`,
//    never `toEqual` - an equal-but-fresh copy would pass a deep compare and lose the contract.
//
// 3. `ImmutableList<T>` becomes a `readonly T[]` copied on write. The base arrays are shared
//    with live snapshot readers, so collection must never mutate in place; the "reads at or
//    above the floor are identical before and after collection" case is what catches that,
//    because it reads the ORIGINAL state after collecting from it.
//
// 4. `NanosSinceEpoch(DateTimeOffset)` vanishes: core's ported `Relationship` already stores
//    `optionalExpiration` as nanos-since-epoch `bigint`, so the sweep compares it against the
//    floor directly. The C# value is always a multiple of 100 (tick truncation) and the ported
//    one need not be, which the `<=` comparison is indifferent to.

const NANOS_PER_MILLISECOND = 1_000_000n;
const NANOS_PER_SECOND = 1_000_000_000n;
const NANOS_PER_DAY = 86_400_000_000_000n;

function nowNanos(): bigint {
  return BigInt(Date.now()) * NANOS_PER_MILLISECOND;
}

function rel(rid: string, sid: string) {
  return createRelationship(
    { objectType: "doc", objectId: rid, relation: "viewer" },
    { objectType: "user", objectId: sid, relation: ELLIPSIS },
  );
}

function row(
  rid: string,
  sid: string,
  created: bigint,
  deleted: bigint | undefined,
  expiration?: bigint | undefined,
): StoredRelationship {
  return {
    relationship: { ...rel(rid, sid), optionalExpiration: expiration },
    createdRevision: created,
    deletedRevision: deleted,
  };
}

// The C# test constructs `DatastoreState` positionally and leans on `GcFloor = 0`'s default
// argument; the ported record makes `gcFloor` an explicit member, so this helper supplies it.
function state(
  headRevision: bigint,
  relationships: readonly StoredRelationship[],
  schemas: readonly SchemaVersion[] = [],
  counters: readonly CounterVersion[] = [],
): DatastoreState {
  return { headRevision, relationships, schemas, counters, gcFloor: 0n };
}

function schemaVersion(revision: bigint, body: string, hash: string): SchemaVersion {
  return { revision, bytes: new TextEncoder().encode(body), hash };
}

/**
 * The C# helper: the MVCC-live rows at a revision, minus anything the wall clock has already
 * expired, keyed as "resourceId:subjectId" in a `SortedSet<string>`. A sorted array is the
 * TypeScript equivalent - `Set` has no ordering and `toEqual` over one would not pin order.
 */
function liveIds(s: DatastoreState, atRevision: bigint): readonly string[] {
  const ids: string[] = [];
  for (const r of liveAt(s, atRevision)) {
    const now = nowNanos();
    if (r.optionalExpiration !== undefined && r.optionalExpiration <= now) continue;
    ids.push(`${r.reference.resource.objectId}:${r.reference.subject.objectId}`);
  }
  return [...new Set(ids)].sort();
}

describe("collectBelow - structural relationship collection", () => {
  it("drops rows dead below the floor", () => {
    const s = state(100n, [
      row("a", "alice", 10n, 20n), // dead at 20, well below floor 50
      row("b", "bob", 10n, undefined), // still live
    ]);

    const collected = collectBelow(s, 50n);

    expect(collected.relationships).toHaveLength(1);
    expect(collected.relationships[0]?.relationship.reference.subject.objectId).toBe("bob");
    expect(collected.gcFloor).toBe(50n);
  });

  it("keeps rows created at or below the floor that are still live or straddling", () => {
    const s = state(100n, [
      row("a", "alice", 10n, undefined), // created below floor, still live: KEEP
      row("b", "bob", 10n, 60n), // created below floor, deleted AFTER floor: KEEP (straddles)
    ]);

    const collected = collectBelow(s, 50n);

    expect(collected.relationships).toHaveLength(2);
  });

  it("leaves reads at or above the floor identical before and after collection", () => {
    const s = state(100n, [
      row("a", "alice", 10n, 20n),
      row("b", "bob", 10n, undefined),
      row("c", "carol", 30n, 70n),
      row("d", "dave", 60n, undefined),
    ]);

    const collected = collectBelow(s, 50n);

    for (const revision of [50n, 60n, 70n, 100n])
      expect(liveIds(collected, revision)).toEqual(liveIds(s, revision));
  });

  it("rejects reads below the floor via MvccSnapshotReader", () => {
    const s = state(100n, [row("a", "alice", 10n, undefined)]);
    const collected = collectBelow(s, 50n);

    // Synchronous throw from the constructor, matching the C# `Assert.Throws`.
    expect(() => new MvccSnapshotReader(collected, 49n, () => true)).toThrow(
      RevisionNotFoundException,
    );
    // At/above the floor is fine.
    expect(() => new MvccSnapshotReader(collected, 50n, () => true)).not.toThrow();
  });

  it("is a no-op at or below the current floor", () => {
    const s = state(100n, [row("a", "alice", 10n, 20n)]);

    const collectedOnce = collectBelow(s, 50n);
    const collectedAgainLower = collectBelow(collectedOnce, 30n);
    const collectedAgainSame = collectBelow(collectedOnce, 50n);

    // `Assert.Same`: reference identity, not a deep compare.
    expect(collectedAgainLower).toBe(collectedOnce);
    expect(collectedAgainSame).toBe(collectedOnce);
    expect(collectedOnce.gcFloor).toBe(50n);
  });

  it("only ever advances the floor", () => {
    const s = state(100n, [
      row("a", "alice", 10n, 20n), // dead by revision 20
      row("b", "bob", 60n, 90n), // dead by revision 90
      row("c", "carol", 70n, undefined), // never dies
    ]);

    const first = collectBelow(s, 30n);
    expect(first.gcFloor).toBe(30n);
    expect(first.relationships).toHaveLength(2); // "a" collected; "b" (dead@90) and "c" survive

    const second = collectBelow(first, 95n);
    expect(second.gcFloor).toBe(95n);
    expect(second.relationships).toHaveLength(1); // "b" (dead@90 <= 95) collected; only "c" remains
    expect(second.relationships[0]?.relationship.reference.subject.objectId).toBe("carol");
  });
});

describe("collectBelow - expiration sweep", () => {
  it("drops expired rows without changing any servable read", () => {
    const floor = nowNanos() - NANOS_PER_DAY; // already elapsed

    const s = state(floor + NANOS_PER_SECOND, [
      row("a", "alice", 10n, undefined, floor - NANOS_PER_SECOND), // expired at/before floor
      row("b", "bob", 10n, undefined), // never expires
    ]);

    // Both rows are MVCC-visible at every revision >= floor before collection; "a" is filtered
    // out of every query-shaped read regardless (the real wall clock has already passed its
    // expiration), so removing it changes nothing observable.
    const before = liveIds(s, s.headRevision);
    const collected = collectBelow(s, floor);
    const after = liveIds(collected, collected.headRevision);

    expect(after).toEqual(before);
    expect(
      collected.relationships.some((r) => r.relationship.reference.subject.objectId === "alice"),
    ).toBe(false);
    expect(
      collected.relationships.some((r) => r.relationship.reference.subject.objectId === "bob"),
    ).toBe(true);
  });

  it("keeps rows expiring after the floor", () => {
    const floor = nowNanos() - NANOS_PER_DAY;

    const s = state(floor + NANOS_PER_SECOND, [
      row("a", "alice", 10n, undefined, floor + 30n * NANOS_PER_DAY),
    ]);

    const collected = collectBelow(s, floor);

    expect(collected.relationships).toHaveLength(1);
  });
});

describe("collectBelow - schema compaction", () => {
  it("keeps the latest version at or below the floor plus everything above", () => {
    const s = state(
      100n,
      [],
      [
        schemaVersion(10n, "s10", "h10"),
        schemaVersion(20n, "s20", "h20"), // latest <= floor: kept (10 is superseded, dropped)
        schemaVersion(60n, "s60", "h60"), // above floor: kept
      ],
    );

    const collected = collectBelow(s, 50n);

    expect(collected.schemas).toHaveLength(2);
    expect(schemaHashAt(collected, 50n)).toBe("h20"); // the version effective at the floor survived
    expect(schemaHashAt(collected, 100n)).toBe("h60");
    expect(schemaHashAt(collected, 50n)).toBe(schemaHashAt(s, 50n));
    expect(schemaHashAt(collected, 100n)).toBe(schemaHashAt(s, 100n));
  });
});

describe("collectBelow - counter compaction", () => {
  const filterA: RelationshipsFilter = { optionalResourceType: "doc" };
  const filterA2: RelationshipsFilter = {
    optionalResourceType: "doc",
    optionalResourceRelation: "viewer",
  };

  it("keeps the latest live version per name", () => {
    const s = state(
      100n,
      [],
      [],
      [
        { revision: 10n, name: "c1", filter: filterA }, // superseded below floor: dropped
        { revision: 20n, name: "c1", filter: filterA2 }, // latest <= floor for c1: kept
        { revision: 70n, name: "c2", filter: filterA }, // above floor: kept
      ],
    );

    const collected = collectBelow(s, 50n);

    expect(collected.counters).toHaveLength(2);
    expect(counterFilterAt(collected, "c1", 100n)).toEqual(filterA2);
    expect(counterFilterAt(collected, "c2", 100n)).toEqual(filterA);
    expect(counterFilterAt(collected, "c1", 100n)).toEqual(counterFilterAt(s, "c1", 100n));
  });

  it("drops a tombstoned counter entirely when it is the latest at or below the floor", () => {
    const s = state(
      100n,
      [],
      [],
      [
        { revision: 10n, name: "c1", filter: filterA },
        // Unregistered below the floor, never re-registered. The C# `Filter` is a nullable
        // record reference; the port uses `undefined`, and the tombstone must NOT be
        // `??`-coalesced away - absent-filter is the whole meaning of this row.
        { revision: 20n, name: "c1", filter: undefined },
      ],
    );

    const collected = collectBelow(s, 50n);

    expect(collected.counters).toHaveLength(0);
    expect(counterFilterAt(collected, "c1", 100n)).toBeUndefined();
    expect(counterFilterAt(collected, "c1", 100n)).toEqual(counterFilterAt(s, "c1", 100n));
  });

  it("keeps a tombstone re-registered above the floor", () => {
    const s = state(
      100n,
      [],
      [],
      [
        { revision: 10n, name: "c1", filter: filterA },
        { revision: 20n, name: "c1", filter: undefined }, // tombstone at/below floor: droppable alone
        { revision: 70n, name: "c1", filter: filterA }, // re-registered above the floor: must survive
      ],
    );

    const collected = collectBelow(s, 50n);

    // The tombstone itself may be dropped, but the re-registration above the floor must remain.
    expect(counterFilterAt(collected, "c1", 100n)).toEqual(filterA);
    expect(counterFilterAt(collected, "c1", 60n)).toBeUndefined(); // still unregistered at/above the floor
  });
});
