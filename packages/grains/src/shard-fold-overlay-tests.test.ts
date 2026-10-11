import { ELLIPSIS } from "@benedb/core/core-constants";
import { describe, expect, it } from "vitest";

import { graphShardKeyForResource } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import { GRAPH_SHARD_STATE_EMPTY } from "./graph-shard-state";
import type { LogEvent } from "./log-event";
import type { RelationshipWire } from "./relationships-dtos";
import { shardFoldApplyEvent, shardFoldOverlay } from "./shard-fold";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ShardFoldOverlayTests.cs`.
 *
 * The label rule `shardFoldOverlay` rests on: a key's current state is its projected state with
 * the pending events ABOVE the projected label folded over. Events at or below the label are
 * already projected and must not fold twice; events above it must; and the result is relabeled to
 * the head with the current floor applied. This is what makes a projection that lands between
 * reading the pending tail and reading the projected state harmless.
 */
const KEY = graphShardKeyForResource("doc", "d");

function rel(subject: string, resourceId = "d"): RelationshipWire {
  return {
    resourceType: "doc",
    resourceId,
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: subject,
    subjectRelation: ELLIPSIS,
  };
}

function touch(revision: bigint, subject: string, resourceId = "d"): LogEvent {
  return {
    revision,
    relationshipChanges: [{ operation: "touch", relationship: rel(subject, resourceId) }],
    schemaChange: undefined,
    counterChanges: [],
    gcFloor: undefined,
  };
}

function remove(revision: bigint, subject: string): LogEvent {
  return {
    revision,
    relationshipChanges: [{ operation: "delete", relationship: rel(subject) }],
    schemaChange: undefined,
    counterChanges: [],
    gcFloor: undefined,
  };
}

function fold(...events: LogEvent[]): GraphShardState {
  return events.reduce((state, ev) => shardFoldApplyEvent(state, ev, KEY), GRAPH_SHARD_STATE_EMPTY);
}

function rows(state: GraphShardState): string[] {
  return state.rows
    .map((r) => `${r.relationship.subjectId}|${r.createdRevision}|${r.deletedRevision ?? "live"}`)
    .sort();
}

describe("ShardFoldOverlayTests", () => {
  it("folds pending events above the label and relabels to the head", () => {
    const projected = { ...fold(touch(10n, "alice")), appliedRevision: 10n };
    const pending = [touch(20n, "bob"), remove(30n, "alice")];

    const current = shardFoldOverlay(projected, pending, KEY, 40n, 0n);

    expect(rows(current)).toEqual(
      rows(fold(touch(10n, "alice"), touch(20n, "bob"), remove(30n, "alice"))),
    );
    expect(current.appliedRevision).toBe(40n);
  });

  it("skips pending events the projection already holds", () => {
    // The projection landed after the tail was captured: it already holds revision 20.
    const projected = { ...fold(touch(10n, "alice"), touch(20n, "bob")), appliedRevision: 25n };
    const pending = [touch(20n, "bob"), touch(30n, "carol")];

    const current = shardFoldOverlay(projected, pending, KEY, 30n, 0n);

    expect(rows(current)).toEqual(
      rows(fold(touch(10n, "alice"), touch(20n, "bob"), touch(30n, "carol"))),
    );
  });

  it("ignores pending events for other keys", () => {
    const current = shardFoldOverlay(
      GRAPH_SHARD_STATE_EMPTY,
      [touch(20n, "x", "other")],
      KEY,
      20n,
      0n,
    );

    expect(current.rows).toEqual([]);
    expect(current.appliedRevision).toBe(20n);
  });

  it("applies the current floor to rows dead below it", () => {
    const projected = {
      ...fold(touch(10n, "alice"), remove(20n, "alice"), touch(30n, "bob")),
      appliedRevision: 30n,
    };

    const current = shardFoldOverlay(projected, [], KEY, 50n, 25n);

    expect(rows(current)).toEqual(["bob|30|live"]);
    expect(current.gcFloor).toBe(25n);
    expect(current.appliedRevision).toBe(50n);
  });
});
