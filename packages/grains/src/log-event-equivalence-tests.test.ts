import { ELLIPSIS } from "@benedb/core/core-constants";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { changesAt, schemaChangedAt } from "@benedb/datastore/datastore-state";
import { describe, expect, it } from "vitest";

import type { DatastoreGrainState } from "./datastore-grain-state";
import { toMemoryState } from "./datastore-state-converters";
import { eventFromState } from "./log-event-factory";
import type { RelationshipUpdateWire, RelationshipWire } from "./relationships-dtos";

/**
 * Ported from `tests/Spiceport.Grains.Tests/LogEventEquivalenceTests.cs`.
 *
 * Freezes the event-log payload contract before any consumer depends on it: for every committed
 * revision, `eventFromState` must reproduce exactly the per-revision diff the Watch changefeed
 * already emits (`changesAt` / `schemaChangedAt`). Proven three ways per revision - the factory
 * output, the in-memory `changesAt`, and an independent re-derivation of the touch/delete rule over
 * the public wire rows - which must all agree.
 *
 * DIVERGENCE, cosmetic: the canonical strings carry the port's operation spelling ("touch",
 * "delete") where the C# interpolates the enum member names ("Touch", "Delete"). Nothing outside
 * this test reads those strings; all three derivations use the same spelling, which is what the
 * comparison needs.
 */
describe("log event equivalence", () => {
  const relA: RelationshipWire = {
    resourceType: "doc",
    resourceId: "a",
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: ELLIPSIS,
  };
  const relB: RelationshipWire = { ...relA, resourceId: "b", subjectId: "bob" };
  const relC: RelationshipWire = {
    ...relA,
    resourceId: "c",
    resourceRelation: "editor",
    subjectId: "carol",
  };

  // rev10: create A and B. rev20: create C + write schema + register counter c1.
  // rev30: touch A (close A@10..30 AND re-create A@30 with the same identity) -> changesAt must
  //        emit a single touch (the live result), never a delete, for A at rev30.
  const grainState: DatastoreGrainState = {
    headRevision: 30n,
    relationships: [
      { relationship: relA, createdRevision: 10n, deletedRevision: 30n },
      { relationship: relB, createdRevision: 10n, deletedRevision: undefined },
      { relationship: relC, createdRevision: 20n, deletedRevision: undefined },
      { relationship: relA, createdRevision: 30n, deletedRevision: undefined },
    ],
    schemas: [
      {
        revision: 20n,
        bytes: new TextEncoder().encode("definition doc {}"),
        hash: "h20",
      },
    ],
    counters: [
      {
        revision: 20n,
        name: "c1",
        filter: {
          optionalResourceType: "doc",
          optionalResourceRelation: "viewer",
          optionalExpirationOption: 0,
        },
      },
    ],
    gcFloor: 0n,
  };

  const keyOf = (r: RelationshipWire): string =>
    `${r.resourceType}:${r.resourceId}#${r.resourceRelation}@${r.subjectType}:${r.subjectId}#${r.subjectRelation}`;

  const canonicalWire = (u: RelationshipUpdateWire): string =>
    `${u.operation}:${keyOf(u.relationship)}`;

  const canonicalCore = (u: RelationshipUpdate): string => {
    const operation = u.operation === "delete" ? "delete" : "touch";
    const resource = u.relationship.reference.resource;
    const subject = u.relationship.reference.subject;
    return (
      `${operation}:${resource.objectType}:${resource.objectId}#${resource.relation}` +
      `@${subject.objectType}:${subject.objectId}#${subject.relation}`
    );
  };

  const expectedFromWire = (state: DatastoreGrainState, rev: bigint): readonly string[] => {
    const touched = new Set(
      state.relationships
        .filter((r) => r.createdRevision === rev)
        .map((r) => keyOf(r.relationship)),
    );
    const result: string[] = [];
    for (const r of state.relationships.filter((row) => row.createdRevision === rev))
      result.push(`touch:${keyOf(r.relationship)}`);
    for (const r of state.relationships)
      if (r.deletedRevision === rev && !touched.has(keyOf(r.relationship)))
        result.push(`delete:${keyOf(r.relationship)}`);
    return result.sort();
  };

  it("eventFromState matches changesAt for every revision", () => {
    const state = toMemoryState(grainState);

    for (const rev of [10n, 20n, 30n]) {
      const ev = eventFromState(state, rev);

      // 1. factory vs the in-memory changesAt the Watch path already uses.
      const fromFactory = ev.relationshipChanges.map(canonicalWire).sort();
      const fromChangesAt = changesAt(state, rev).map(canonicalCore).sort();
      expect(fromFactory).toEqual(fromChangesAt);

      // 2. factory vs an independent re-derivation of the touch/delete rule over the wire rows.
      expect(fromFactory).toEqual(expectedFromWire(grainState, rev));

      // 3. the schema flag matches (derived from the self-contained schemaChange payload).
      expect(ev.schemaChange !== undefined).toBe(schemaChangedAt(state, rev));
    }

    // Spot-check the tricky cases explicitly.
    expect(eventFromState(state, 10n).relationshipChanges.map(canonicalWire).sort()).toEqual([
      "touch:doc:a#viewer@user:alice#...",
      "touch:doc:b#viewer@user:bob#...",
    ]);
    expect(eventFromState(state, 20n).schemaChange).toBeDefined();

    const rev30 = eventFromState(state, 30n).relationshipChanges;
    expect(rev30).toHaveLength(1); // touch-over-existing yields one touch, not a touch + delete
    expect(canonicalWire(rev30[0] as RelationshipUpdateWire)).toBe(
      "touch:doc:a#viewer@user:alice#...",
    );

    // Counter delta surfaces at its revision.
    const c20 = eventFromState(state, 20n).counterChanges;
    expect(c20.some((c) => c.name === "c1" && c.filter !== undefined)).toBe(true);
  });

  it("carries the full schema version so the event is self-contained", () => {
    const ev = eventFromState(toMemoryState(grainState), 20n);

    expect(ev.schemaChange?.revision).toBe(20n);
    expect(ev.schemaChange?.hash).toBe("h20");
    expect(new TextDecoder().decode(ev.schemaChange?.bytes)).toBe("definition doc {}");
  });

  it("mints an ordinary event, never a gc one", () => {
    expect(eventFromState(toMemoryState(grainState), 30n).gcFloor).toBeUndefined();
  });

  it("keeps a counter tombstone distinguishable from no counter change", () => {
    const withTombstone: DatastoreGrainState = {
      ...grainState,
      counters: [
        ...grainState.counters,
        { revision: 30n, name: "c1", filter: undefined }, // unregistered at 30
      ],
    };
    const state = toMemoryState(withTombstone);

    const tombstoned = eventFromState(state, 30n).counterChanges;

    expect(tombstoned).toHaveLength(1);
    expect(tombstoned[0]?.name).toBe("c1");
    expect(tombstoned[0]?.filter).toBeUndefined();
    // A revision with no counter version at all carries no delta, which is a different thing.
    expect(eventFromState(state, 10n).counterChanges).toHaveLength(0);
  });
});
