import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { Relationship } from "@spacedb/core/relationship";
import { createRelationship } from "@spacedb/core/relationship";
import { collectBelow } from "@spacedb/datastore/datastore-state";
import { describe, expect, it } from "vitest";

import type { DatastoreGrainState } from "./datastore-grain-state";
import { datastoreGrainStateEmpty } from "./datastore-grain-state";
import { toGrainState, toMemoryState } from "./datastore-state-converters";
import type { CounterDeltaWire, LogEvent } from "./log-event";
import { logFoldApplyEvent } from "./log-fold";
import type { RelationshipUpdateWire } from "./relationships-dtos";
import { toWire } from "./wire-convert";

/**
 * Ported from `tests/Spiceport.Grains.Tests/DatastoreGcFoldTests.cs`.
 *
 * Fold-level gates for GC `LogEvent`s (a PRESENT `gcFloor`): proves `logFoldApplyEvent` on a GC
 * event is exactly "collect below the floor, then advance the head to the event's revision" - the
 * same equivalence `log-event-equivalence-tests.test.ts` establishes for ordinary events. A GC event
 * carries no relationship/schema/counter changes, so any log-tail consumer (the shard grains'
 * `ShardFold`, the Watch feed) folds it harmlessly.
 *
 * The independent reference is `toGrainState(collectBelow(toMemoryState(state), floor))`, so the
 * gate is only meaningful while `toMemoryState`/`toGrainState` are exact inverses: an asymmetry
 * (a dropped `gcFloor`, a reordered list) makes it pass vacuously or fail spuriously. The
 * converter round trip is therefore pinned here too.
 */
describe("datastore gc fold", () => {
  const seed = 1_000n;

  const rel = (rid: string, sid: string): Relationship =>
    createRelationship(
      { objectType: "doc", objectId: rid, relation: "viewer" },
      { objectType: "user", objectId: sid, relation: ELLIPSIS },
    );

  const noCounterChanges: readonly CounterDeltaWire[] = [];

  const changeEvent = (
    revision: bigint,
    operation: RelationshipUpdateWire["operation"],
    rid: string,
    sid: string,
  ): LogEvent => ({
    revision,
    relationshipChanges: [{ operation, relationship: toWire(rel(rid, sid)) }],
    schemaChange: undefined,
    counterChanges: noCounterChanges,
    gcFloor: undefined,
  });

  const touchEvent = (revision: bigint, rid: string, sid: string): LogEvent =>
    changeEvent(revision, "touch", rid, sid);

  const deleteEvent = (revision: bigint, rid: string, sid: string): LogEvent =>
    changeEvent(revision, "delete", rid, sid);

  const gcEvent = (revision: bigint, floor: bigint): LogEvent => ({
    revision,
    relationshipChanges: [],
    schemaChange: undefined,
    counterChanges: noCounterChanges,
    gcFloor: floor,
  });

  const liveSet = (state: DatastoreGrainState, atRevision: bigint): readonly string[] => {
    const set = new Set<string>();
    for (const row of state.relationships) {
      if (
        row.createdRevision <= atRevision &&
        (row.deletedRevision === undefined || row.deletedRevision > atRevision)
      )
        set.add(`${row.relationship.resourceId}:${row.relationship.subjectId}`);
    }
    return [...set].sort();
  };

  it("applying a gc event equals collectBelow plus a head advance", () => {
    let state = datastoreGrainStateEmpty(seed);
    state = logFoldApplyEvent(state, touchEvent(seed + 1n, "a", "alice"));
    state = logFoldApplyEvent(state, touchEvent(seed + 2n, "b", "bob"));
    state = logFoldApplyEvent(state, deleteEvent(seed + 3n, "a", "alice")); // "a" now dead

    const floor = seed + 3n; // collects everything dead at/before this revision
    const gcRevision = seed + 4n;

    const viaFold = logFoldApplyEvent(state, gcEvent(gcRevision, floor));

    const viaDirect: DatastoreGrainState = {
      ...toGrainState(collectBelow(toMemoryState(state), floor)),
      headRevision: gcRevision,
    };

    expect(viaFold.headRevision).toBe(gcRevision);
    expect(viaFold.gcFloor).toBe(floor);
    expect(viaFold.gcFloor).toBe(viaDirect.gcFloor);
    expect(liveSet(viaFold, gcRevision)).toEqual(liveSet(viaDirect, gcRevision));
    // "a" (dead at seed+3 <= floor) collected; "b" (still live) survives.
    expect(viaFold.relationships.some((r) => r.relationship.resourceId === "a")).toBe(false);
    expect(viaFold.relationships.some((r) => r.relationship.resourceId === "b")).toBe(true);
  });

  it("a gc event carries no relationship, schema or counter changes", () => {
    const ev = gcEvent(seed + 1n, seed);

    expect(ev.relationshipChanges).toEqual([]);
    expect(ev.schemaChange).toBeUndefined();
    expect(ev.counterChanges).toEqual([]);
  });

  // Not in the C#, which gets the inverse property for free from record equality. The reference
  // the gate above compares against is built by running state THROUGH both converters, so a
  // one-sided drop would make it agree with a wrong fold.
  it("the memory/grain converters are exact inverses", () => {
    let state = datastoreGrainStateEmpty(seed);
    state = logFoldApplyEvent(state, touchEvent(seed + 1n, "a", "alice"));
    state = logFoldApplyEvent(state, touchEvent(seed + 2n, "b", "bob"));
    state = logFoldApplyEvent(state, deleteEvent(seed + 3n, "a", "alice"));
    state = logFoldApplyEvent(state, gcEvent(seed + 4n, seed + 3n));

    expect(toGrainState(toMemoryState(state))).toEqual(state);
  });
});
