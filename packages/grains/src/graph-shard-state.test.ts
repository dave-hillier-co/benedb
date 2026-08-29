import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import type { StoredRelationshipWire } from "./datastore-dtos";
import { GRAPH_SHARD_STATE_EMPTY, type GraphShardState } from "./graph-shard-state";
import type { RelationshipWire } from "./relationships-dtos";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/GraphShardState.cs`.
//
// Its C# gate is `ShardFoldLemmaTests`, which drives `ShardFold` (a later batch); this file pins
// only the value type, and above all the ONE hazard the C# does not have. `GraphShardState.Empty`
// is a `static ... { get; }` singleton that `ShardFold` copies with `state with { ... }`. Ported
// naively that becomes a shared module object which the fold ASSIGNS INTO, corrupting every later
// shard from a line far away from the failure. The port guide's answer is `Object.freeze` plus a
// spread at every site, and freezing is what turns that silent corruption into a loud throw.
describe("the empty graph shard", () => {
  it("is the empty slice at revision zero", () => {
    expect(GRAPH_SHARD_STATE_EMPTY).toEqual({ appliedRevision: 0n, gcFloor: 0n, rows: [] });
  });

  it("carries the watermark and floor as bigints, matching every other revision in the port", () => {
    expect(typeof GRAPH_SHARD_STATE_EMPTY.appliedRevision).toBe("bigint");
    expect(typeof GRAPH_SHARD_STATE_EMPTY.gcFloor).toBe("bigint");
  });

  it("is frozen, so a fold that assigns into it throws instead of corrupting later shards", () => {
    expect(Object.isFrozen(GRAPH_SHARD_STATE_EMPTY)).toBe(true);
    expect(() => {
      (GRAPH_SHARD_STATE_EMPTY as { appliedRevision: bigint }).appliedRevision = 7n;
    }).toThrow(TypeError);
  });

  it("has a frozen rows array too, so `rows.push` cannot mutate the shared empty", () => {
    // `Object.freeze` on the state does not freeze the array it points at; the array must be
    // frozen in its own right, or `state.rows.push(row)` still writes through to every reader.
    expect(Object.isFrozen(GRAPH_SHARD_STATE_EMPTY.rows)).toBe(true);
    expect(() => {
      (GRAPH_SHARD_STATE_EMPTY.rows as StoredRelationshipWire[]).push(storedRow());
    }).toThrow(TypeError);
  });

  it("spreads into a new state without touching the shared one", () => {
    // `state with { AppliedRevision = 5 }` ports to a spread; the untouched members stay shared by
    // reference and are never mutated.
    const advanced: GraphShardState = { ...GRAPH_SHARD_STATE_EMPTY, appliedRevision: 5n };

    expect(advanced.appliedRevision).toBe(5n);
    expect(advanced.rows).toBe(GRAPH_SHARD_STATE_EMPTY.rows);
    expect(GRAPH_SHARD_STATE_EMPTY.appliedRevision).toBe(0n);
  });
});

describe("a populated graph shard", () => {
  it("round trips through the value codec, rows and revisions intact", () => {
    const state: GraphShardState = {
      appliedRevision: 42n,
      gcFloor: 7n,
      rows: [storedRow(), { ...storedRow(), createdRevision: 40n, deletedRevision: 41n }],
    };

    const back = deserializeValue<GraphShardState>(serializeValue(state));

    expect(back.appliedRevision).toBe(42n);
    expect(back.gcFloor).toBe(7n);
    expect(back.rows).toHaveLength(2);
    expect(back.rows[0]?.createdRevision).toBe(10n);
    expect(back.rows[0]?.deletedRevision).toBeUndefined();
    expect(back.rows[1]?.deletedRevision).toBe(41n);
  });
});

function storedRow(): StoredRelationshipWire {
  const relationship: RelationshipWire = {
    resourceType: "doc",
    resourceId: "1",
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: "...",
  };

  return { relationship, createdRevision: 10n };
}
