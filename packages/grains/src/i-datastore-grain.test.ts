import type { GrainKeyFor } from "@thresh/core/key-kinds";
import { describe, expect, it } from "vitest";

import type { CommitReply, CommitRequest } from "./commit-contract";
import type { DatastoreHeadWire } from "./datastore-dtos";
import type { DatastoreGrainState } from "./datastore-grain-state";
import type { GraphShardKeyWire } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import type { IDatastoreWatcher } from "./i-datastore-watcher";
import type { LogSegment } from "./log-event";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/IDatastoreGrain.cs`, which
// has no covering C# test of its own. NOTHING HERE ACTIVATES A GRAIN: `DatastoreGrain` is a later
// slice.
//
// The options map is the most fragile thing in this batch, so it is what this file guards hardest.

function unimplemented(): never {
  throw new Error("IDatastoreGrain has no implementation in this slice");
}

describe("IDatastoreGrain", () => {
  it("is both a type and a registered GrainInterface VALUE named for the C# interface", () => {
    expect(IDatastoreGrain.name).toBe("IDatastoreGrain");
  });

  it("marks EXACTLY the five pure reads alwaysInterleave - including the INHERITED readFrom", () => {
    // Five methods carry [AlwaysInterleave] in the C#: ReadState, GetHead, ReadSchemaAt, ReadShard,
    // and ReadFrom, the last declared on IDatastoreLog and inherited. Thresh's per-method options
    // live on the CONCRETE GrainInterface value and are NOT inherited from an extended interface,
    // so `readFrom` must be REPEATED here. A dropped flag on any of the five parks a Watch stream
    // or a shard hydration behind an in-flight commit - a deadlock or a timeout storm that no unit
    // test would otherwise show, which is why it is asserted structurally rather than per key.
    expect(IDatastoreGrain.options).toEqual({
      readState: { alwaysInterleave: true },
      getHead: { alwaysInterleave: true },
      readSchemaAt: { alwaysInterleave: true },
      readShard: { alwaysInterleave: true },
      readFrom: { alwaysInterleave: true },
    });
  });

  it("gives commit NO options at all - its non-interleaving is what makes the CAS exact", () => {
    // The head read at the top of a commit and the append at the bottom stay atomic with respect
    // to every other write precisely because Commit carries no interleave attribute. Adding one
    // would let the head move under a declarative commit and make the ExpectedHead compare
    // inexact. Nor do SubscribeWatch, UnsubscribeWatch or RunGc carry anything.
    for (const method of ["commit", "subscribeWatch", "unsubscribeWatch", "runGc"]) {
      expect(IDatastoreGrain.options[method]).toBeUndefined();
    }
  });

  it("never uses readOnly, which would not interleave past the non-read-only commit", () => {
    // The C# says so on every one of the five, in as many words. `readOnly` interleaves only when
    // BOTH the blocking and the incoming turn are read-only.
    for (const options of Object.values(IDatastoreGrain.options)) {
      expect(options.readOnly).toBeUndefined();
    }
  });

  it("is integer-keyed, and the single activation's fixed key is a bigint zero", () => {
    // `IGrainWithIntegerKey` -> `GrainWithIntegerKey` (bigint keys). The C#'s
    // `public const long Key = 0` folds to a module constant. Unlike IRelationshipsGrain this key
    // IS an identity: one activation cluster-wide is what makes the revision it mints the
    // cluster-wide serialization point.
    const key: GrainKeyFor<IDatastoreGrain> = DATASTORE_GRAIN_KEY;

    expect(key).toBe(0n);
    expect(typeof DATASTORE_GRAIN_KEY).toBe("bigint");
  });

  it("declares readSchemaAt as returning Uint8Array | undefined for the seed-only window", () => {
    // `Task<byte[]?>`: undefined means no schema was persisted at or before that revision, which
    // is a legitimate state, not a failure.
    const fake: Pick<IDatastoreGrain, "readSchemaAt"> = {
      readSchemaAt: (revision: bigint) =>
        Promise.resolve(revision > 0n ? new TextEncoder().encode("definition user {}") : undefined),
    };

    return Promise.all([fake.readSchemaAt(0n), fake.readSchemaAt(1n)]).then(([seed, later]) => {
      expect(seed).toBeUndefined();
      expect(later).toBeInstanceOf(Uint8Array);
    });
  });

  it("declares runGc as returning bigint | undefined, where 0n is a LEGAL floor", () => {
    // `Task<long?>`: undefined means "no collection was needed" (the computed floor did not
    // advance). Zero is a real floor, so a falsy check here would report a genuine collection to
    // revision 0 as no collection at all.
    const fake: Pick<IDatastoreGrain, "runGc"> = { runGc: () => Promise.resolve(0n) };

    return fake.runGc().then((floor) => {
      expect(floor).toBe(0n);
      expect(floor).not.toBeUndefined();
    });
  });

  it("declares exactly the four inherited-plus-own reads, the commit, the watch pair and the gc", () => {
    // `readFrom` is inherited from IDatastoreLog and so is part of the implemented surface, even
    // though it is declared elsewhere - which is exactly why its option has to be repeated above.
    const fake: IDatastoreGrain = {
      readState: (): Promise<DatastoreGrainState> => unimplemented(),
      getHead: (): Promise<DatastoreHeadWire> => unimplemented(),
      readSchemaAt: (_revision: bigint): Promise<Uint8Array | undefined> => unimplemented(),
      readShard: (_key: GraphShardKeyWire): Promise<GraphShardState> => unimplemented(),
      commit: (_request: CommitRequest): Promise<CommitReply> => unimplemented(),
      subscribeWatch: (_watcher: IDatastoreWatcher): Promise<DatastoreHeadWire> => unimplemented(),
      unsubscribeWatch: (_watcher: IDatastoreWatcher): Promise<void> => unimplemented(),
      runGc: (): Promise<bigint | undefined> => unimplemented(),
      readFrom: (_afterRevision: bigint, _maxCount: number): Promise<LogSegment> => unimplemented(),
    };

    expect(Object.keys(fake)).toEqual([
      "readState",
      "getHead",
      "readSchemaAt",
      "readShard",
      "commit",
      "subscribeWatch",
      "unsubscribeWatch",
      "runGc",
      "readFrom",
    ]);
  });
});
