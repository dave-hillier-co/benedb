import type { GrainKeyFor } from "@thresh/core/key-kinds";
import { describe, expect, it } from "vitest";

import type { FullRelationshipsFilterWire } from "./datastore-dtos";
import { IGraphShardGrain, type GraphShardRowsReply } from "./i-graph-shard-grain";
import type { RelationshipWire } from "./relationships-dtos";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/IGraphShardGrain.cs`, which
// has no covering C# test of its own. NOTHING HERE ACTIVATES A GRAIN: `GraphShardGrain` is a later
// slice, and the shard fold it replays is gated by `ShardFoldLemmaTests`, not by this file.

describe("IGraphShardGrain", () => {
  it("is both a type and a registered GrainInterface VALUE named for the C# interface", () => {
    expect(IGraphShardGrain.name).toBe("IGraphShardGrain");
  });

  it("marks RowsAt alwaysInterleave, NOT readOnly", () => {
    // The C# carries [AlwaysInterleave] and the remark says why in as many words: `readOnly`
    // interleaves a blocking request only when BOTH turns are read-only, so against a
    // non-read-only fold or commit it does nothing, and hot-shard readers would queue behind it.
    expect(IGraphShardGrain.options).toEqual({ rowsAt: { alwaysInterleave: true } });
  });

  it("is string-keyed by the shard key's string form (see graph-shard-grain-key.ts)", () => {
    const key: GrainKeyFor<IGraphShardGrain> = "f/document/readme";

    expect(typeof key).toBe("string");
  });

  it("declares rowsAt(revision: bigint, filter | undefined, signal?)", () => {
    // `long revision` -> bigint. The nullable filter is the subject-filter pushdown, and undefined
    // is MEANINGFUL there: it returns EVERY visible row, where a filter returns a strict subset.
    const rows: readonly RelationshipWire[] = [];
    const reply: GraphShardRowsReply = { rows };
    const calls: { revision: bigint; filter: FullRelationshipsFilterWire | undefined }[] = [];
    const fake: IGraphShardGrain = {
      rowsAt: (
        revision: bigint,
        filter: FullRelationshipsFilterWire | undefined,
        _signal?: AbortSignal,
      ) => {
        calls.push({ revision, filter });
        return Promise.resolve(reply);
      },
    };

    expect(Object.keys(fake)).toEqual(["rowsAt"]);

    const filter: FullRelationshipsFilterWire = {
      optionalResourceType: "document",
      optionalExpirationOption: 0,
    };
    return Promise.all([
      fake.rowsAt(9_007_199_254_740_993n, undefined),
      fake.rowsAt(7n, filter, new AbortController().signal),
    ]).then(() => {
      expect(calls).toEqual([
        { revision: 9_007_199_254_740_993n, filter: undefined },
        { revision: 7n, filter },
      ]);
    });
  });

  it("returns the rows as a plain readonly array snapshot", () => {
    // C# `ImmutableList<RelationshipWire>` -> `readonly RelationshipWire[]`. The C# reply is
    // [Immutable] so Orleans hands a same-silo caller the snapshot BY REFERENCE without copying -
    // the property the graph-sharded design relies on for hot shards. Whether Thresh deep-copies a
    // local call is a THRESH question (recorded at the port site); this test pins only the shape.
    const reply: GraphShardRowsReply = { rows: [] };

    expect(Array.isArray(reply.rows)).toBe(true);
  });
});
