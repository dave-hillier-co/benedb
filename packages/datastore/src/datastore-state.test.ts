import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { Relationship } from "@spacedb/core/relationship";
import { createRelationship } from "@spacedb/core/relationship";

import {
  changesAt,
  counterFilterAt,
  emptyDatastoreState,
  liveAt,
  liveCountersAt,
  schemaAt,
  schemaChangedAt,
  schemaHashAt,
  storedRelationshipIsVisibleAt,
  type CounterVersion,
  type DatastoreState,
  type SchemaVersion,
  type StoredRelationship,
} from "./datastore-state";
import type { RelationshipsFilter } from "./relationships-filter";

// Characterization of the read side of Spiceport's `DatastoreState`. `DatastoreStateGcTests`
// covers `CollectBelow` directly; `LiveAt`, `ChangesAt`, `SchemaChangedAt`, `SchemaAt`,
// `SchemaHashAt`, `CounterFilterAt` and `LiveCountersAt` are covered in Spiceport only
// sociably, through `ReferenceDatastore`, so these are their only direct gate.
//
// Port decisions pinned here:
//
// 1. Revisions are `bigint` everywhere, matching core's `TimestampRevision`.
//
// 2. `LiveAt` is a lazy C# iterator that several call sites enumerate MORE THAN ONCE. A
//    TypeScript generator is single-pass, so handing the same exhausted iterator to two
//    consumers would silently yield nothing the second time. The port returns an ARRAY - a
//    deliberate loss of laziness, asserted below by consuming the same result twice.
//
// 3. `ChangesAt`'s `HashSet<RelationshipKey>` keys a C# record struct by value; a TypeScript
//    `Set` keys by reference, so the port must key on the canonical `relationshipKeyString`.
//    The touch-over-an-existing-key case is what catches a reference-keyed `Set`.
//
// 4. `SchemaAt` / `SchemaHashAt` `break` out of the loop at the first version ABOVE the
//    revision, which is only equivalent to "the last version at or below" while `schemas` is
//    append-ordered ascending. The degenerate out-of-order case below pins the `break`, so a
//    rewrite into `filter(...).at(-1)` is caught.
//
// 5. `LiveCountersAt` folds into a `Dictionary<string, RelationshipsFilter?>` in which a NULL
//    VALUE IS MEANINGFUL: it is the tombstone that hides an earlier registration. In the port
//    that is a `Map<string, RelationshipsFilter | undefined>` where presence must be
//    distinguished from a defined value, and the tombstone must not be `??`-coalesced away.

function rel(rid: string, sid: string): Relationship {
  return createRelationship(
    { objectType: "doc", objectId: rid, relation: "viewer" },
    { objectType: "user", objectId: sid, relation: ELLIPSIS },
  );
}

function row(
  rid: string,
  sid: string,
  created: bigint,
  deleted?: bigint | undefined,
): StoredRelationship {
  return { relationship: rel(rid, sid), createdRevision: created, deletedRevision: deleted };
}

function state(
  headRevision: bigint,
  relationships: readonly StoredRelationship[] = [],
  schemas: readonly SchemaVersion[] = [],
  counters: readonly CounterVersion[] = [],
): DatastoreState {
  return { headRevision, relationships, schemas, counters, gcFloor: 0n };
}

function schemaVersion(revision: bigint, body: string, hash: string): SchemaVersion {
  return { revision, bytes: new TextEncoder().encode(body), hash };
}

function subjectIds(relationships: Iterable<Relationship>): readonly string[] {
  return [...relationships].map((r) => r.reference.subject.objectId);
}

describe("emptyDatastoreState", () => {
  it("starts at the given revision with no rows, schemas or counters and a zero floor", () => {
    const s = emptyDatastoreState(42n);

    expect(s.headRevision).toBe(42n);
    expect(s.relationships).toEqual([]);
    expect(s.schemas).toEqual([]);
    expect(s.counters).toEqual([]);
    expect(s.gcFloor).toBe(0n);
  });
});

describe("storedRelationshipIsVisibleAt", () => {
  it("is visible from its creation revision inclusive", () => {
    const r = row("a", "alice", 10n);

    expect(storedRelationshipIsVisibleAt(r, 9n)).toBe(false);
    expect(storedRelationshipIsVisibleAt(r, 10n)).toBe(true);
    expect(storedRelationshipIsVisibleAt(r, 11n)).toBe(true);
  });

  it("stops being visible AT the deletion revision, not after it", () => {
    const r = row("a", "alice", 10n, 20n);

    expect(storedRelationshipIsVisibleAt(r, 19n)).toBe(true);
    expect(storedRelationshipIsVisibleAt(r, 20n)).toBe(false);
    expect(storedRelationshipIsVisibleAt(r, 21n)).toBe(false);
  });

  it("is never visible when created and deleted at the same revision", () => {
    const r = row("a", "alice", 10n, 10n);

    expect(storedRelationshipIsVisibleAt(r, 10n)).toBe(false);
  });
});

describe("liveAt", () => {
  const s = state(100n, [
    row("a", "alice", 10n, 20n),
    row("b", "bob", 10n),
    row("c", "carol", 30n),
  ]);

  it("returns the rows visible at the revision, in storage order", () => {
    expect(subjectIds(liveAt(s, 30n))).toEqual(["bob", "carol"]);
    expect(subjectIds(liveAt(s, 15n))).toEqual(["alice", "bob"]);
    expect(subjectIds(liveAt(s, 5n))).toEqual([]);
  });

  it("yields the stored relationship payload by reference", () => {
    const [only] = [...liveAt(s, 29n)];

    expect(only).toBe(s.relationships[1]?.relationship);
  });

  it("can be enumerated more than once (it is not a single-pass iterator)", () => {
    const result = liveAt(s, 100n);

    expect(subjectIds(result)).toEqual(["bob", "carol"]);
    expect(subjectIds(result)).toEqual(["bob", "carol"]);
  });
});

describe("changesAt", () => {
  it("surfaces a row created at the revision as a touch carrying the payload", () => {
    const s = state(100n, [row("a", "alice", 10n), row("b", "bob", 20n)]);

    expect(changesAt(s, 20n)).toEqual([
      { relationship: s.relationships[1]?.relationship, operation: "touch" },
    ]);
  });

  it("surfaces a row deleted at the revision as a delete carrying the removed relationship", () => {
    const s = state(100n, [row("a", "alice", 10n, 20n)]);

    expect(changesAt(s, 20n)).toEqual([
      { relationship: s.relationships[0]?.relationship, operation: "delete" },
    ]);
  });

  it("emits only the touch when a touch over an existing key deletes and recreates it", () => {
    // The identical six-tuple, deleted and recreated at revision 20. The delete must be
    // suppressed because the touch already covers the key - which requires keying the
    // touched-key set canonically, not by object reference.
    const s = state(100n, [row("a", "alice", 10n, 20n), row("a", "alice", 20n)]);

    const changes = changesAt(s, 20n);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.operation).toBe("touch");
    expect(changes[0]?.relationship).toBe(s.relationships[1]?.relationship);
  });

  it("suppresses only the deletes whose key was touched at the same revision", () => {
    const s = state(100n, [
      row("a", "alice", 10n, 20n), // key re-touched below: suppressed
      row("a", "alice", 20n),
      row("b", "bob", 10n, 20n), // key not touched: a real delete
    ]);

    expect(changesAt(s, 20n)).toEqual([
      { relationship: s.relationships[1]?.relationship, operation: "touch" },
      { relationship: s.relationships[2]?.relationship, operation: "delete" },
    ]);
  });

  it("emits every touch before any delete, each in storage order", () => {
    const s = state(100n, [
      row("a", "alice", 10n, 20n),
      row("b", "bob", 20n),
      row("c", "carol", 10n, 20n),
      row("d", "dave", 20n),
    ]);

    expect(
      changesAt(s, 20n).map((c) => [c.relationship.reference.subject.objectId, c.operation]),
    ).toEqual([
      ["bob", "touch"],
      ["dave", "touch"],
      ["alice", "delete"],
      ["carol", "delete"],
    ]);
  });

  it("returns nothing for a revision at which no row was created or deleted", () => {
    const s = state(100n, [row("a", "alice", 10n, 20n)]);

    expect(changesAt(s, 15n)).toEqual([]);
  });
});

describe("schemaChangedAt", () => {
  const s = state(100n, [], [schemaVersion(10n, "s10", "h10"), schemaVersion(60n, "s60", "h60")]);

  it("is true only at a revision at which a version was written", () => {
    expect(schemaChangedAt(s, 10n)).toBe(true);
    expect(schemaChangedAt(s, 60n)).toBe(true);
    expect(schemaChangedAt(s, 11n)).toBe(false);
    expect(schemaChangedAt(s, 100n)).toBe(false);
  });

  it("is false when no schema has ever been written", () => {
    expect(schemaChangedAt(state(100n), 10n)).toBe(false);
  });
});

describe("schemaAt / schemaHashAt", () => {
  const s = state(
    100n,
    [],
    [
      schemaVersion(10n, "s10", "h10"),
      schemaVersion(20n, "s20", "h20"),
      schemaVersion(60n, "s60", "h60"),
    ],
  );

  it("returns the version effective at the revision (at-or-below, last wins)", () => {
    expect(new TextDecoder().decode(schemaAt(s, 50n))).toBe("s20");
    expect(schemaHashAt(s, 50n)).toBe("h20");
    expect(schemaHashAt(s, 20n)).toBe("h20"); // the write revision itself is included
    expect(schemaHashAt(s, 19n)).toBe("h10");
    expect(schemaHashAt(s, 100n)).toBe("h60");
  });

  it("returns undefined below the first version and when none exist", () => {
    expect(schemaAt(s, 9n)).toBeUndefined();
    expect(schemaHashAt(s, 9n)).toBeUndefined();
    expect(schemaAt(state(100n), 100n)).toBeUndefined();
    expect(schemaHashAt(state(100n), 100n)).toBeUndefined();
  });

  it("stops at the first version above the revision rather than scanning the whole list", () => {
    // Degenerate, non-ascending input that only a `break` can distinguish from a filter+last:
    // the scan halts at revision 60 and never reaches the trailing 20.
    const outOfOrder = state(
      100n,
      [],
      [
        schemaVersion(10n, "s10", "h10"),
        schemaVersion(60n, "s60", "h60"),
        schemaVersion(20n, "s20", "h20"),
      ],
    );

    expect(schemaHashAt(outOfOrder, 50n)).toBe("h10");
    expect(new TextDecoder().decode(schemaAt(outOfOrder, 50n))).toBe("s10");
  });

  it("returns the stored bytes by reference", () => {
    expect(schemaAt(s, 50n)).toBe(s.schemas[1]?.bytes);
  });
});

describe("counterFilterAt", () => {
  const filter1: RelationshipsFilter = { optionalResourceType: "doc" };
  const filter2: RelationshipsFilter = { optionalResourceType: "folder" };

  it("folds last-wins over the versions at or below the revision, per name", () => {
    const s = state(
      100n,
      [],
      [],
      [
        { revision: 10n, name: "c1", filter: filter1 },
        { revision: 20n, name: "c2", filter: filter2 },
        { revision: 30n, name: "c1", filter: filter2 },
      ],
    );

    expect(counterFilterAt(s, "c1", 10n)).toBe(filter1);
    expect(counterFilterAt(s, "c1", 29n)).toBe(filter1);
    expect(counterFilterAt(s, "c1", 30n)).toBe(filter2);
    expect(counterFilterAt(s, "c2", 100n)).toBe(filter2);
  });

  it("returns undefined when the latest version at or below the revision is a tombstone", () => {
    const s = state(
      100n,
      [],
      [],
      [
        { revision: 10n, name: "c1", filter: filter1 },
        { revision: 20n, name: "c1", filter: undefined },
      ],
    );

    expect(counterFilterAt(s, "c1", 19n)).toBe(filter1);
    expect(counterFilterAt(s, "c1", 20n)).toBeUndefined();
    expect(counterFilterAt(s, "c1", 100n)).toBeUndefined();
  });

  it("returns undefined for an unknown name and for a revision below the first version", () => {
    const s = state(100n, [], [], [{ revision: 10n, name: "c1", filter: filter1 }]);

    expect(counterFilterAt(s, "nope", 100n)).toBeUndefined();
    expect(counterFilterAt(s, "c1", 9n)).toBeUndefined();
  });

  it("sees a re-registration after a tombstone", () => {
    const s = state(
      100n,
      [],
      [],
      [
        { revision: 10n, name: "c1", filter: filter1 },
        { revision: 20n, name: "c1", filter: undefined },
        { revision: 30n, name: "c1", filter: filter2 },
      ],
    );

    expect(counterFilterAt(s, "c1", 30n)).toBe(filter2);
  });
});

describe("liveCountersAt", () => {
  const filter1: RelationshipsFilter = { optionalResourceType: "doc" };
  const filter2: RelationshipsFilter = { optionalResourceType: "folder" };

  it("returns each name once, with its latest filter at or below the revision", () => {
    const s = state(
      100n,
      [],
      [],
      [
        { revision: 10n, name: "c1", filter: filter1 },
        { revision: 20n, name: "c2", filter: filter1 },
        { revision: 30n, name: "c1", filter: filter2 },
      ],
    );

    expect([...liveCountersAt(s, 100n)]).toEqual([
      { name: "c1", filter: filter2 },
      { name: "c2", filter: filter1 },
    ]);
    expect([...liveCountersAt(s, 25n)]).toEqual([
      { name: "c1", filter: filter1 },
      { name: "c2", filter: filter1 },
    ]);
  });

  it("omits a name whose latest version at or below the revision is a tombstone", () => {
    const s = state(
      100n,
      [],
      [],
      [
        { revision: 10n, name: "c1", filter: filter1 },
        { revision: 20n, name: "c2", filter: filter1 },
        { revision: 30n, name: "c1", filter: undefined },
      ],
    );

    expect([...liveCountersAt(s, 100n)]).toEqual([{ name: "c2", filter: filter1 }]);
    // The tombstone hides the earlier registration; it does not merely fail to add one.
    expect([...liveCountersAt(s, 29n)]).toEqual([
      { name: "c1", filter: filter1 },
      { name: "c2", filter: filter1 },
    ]);
  });

  it("includes a name re-registered after a tombstone", () => {
    const s = state(
      100n,
      [],
      [],
      [
        { revision: 10n, name: "c1", filter: filter1 },
        { revision: 20n, name: "c1", filter: undefined },
        { revision: 30n, name: "c1", filter: filter2 },
      ],
    );

    expect([...liveCountersAt(s, 100n)]).toEqual([{ name: "c1", filter: filter2 }]);
  });

  it("returns nothing when no counters are registered at the revision", () => {
    const s = state(100n, [], [], [{ revision: 30n, name: "c1", filter: filter1 }]);

    expect([...liveCountersAt(s, 29n)]).toEqual([]);
    expect([...liveCountersAt(state(100n), 100n)]).toEqual([]);
  });
});
