import { describe, expect, it } from "vitest";

import { IDatastoreWatcher } from "./i-datastore-watcher";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/IDatastoreWatcher.cs`, which
// has no covering C# test of its own.
//
// THIS IS THE ONE FILE IN THE BATCH WITH NO CLEAN THRESH MAPPING. Orleans' `IGrainObserver` - a
// non-durable CLIENT REFERENCE a grain can call back on - has no Thresh counterpart. Thresh has
// `ObserverManager` (the snapshot/TTL fan-out COLLECTION, ported from Orleans) but no observer
// reference type, so there is nothing for `IDatastoreGrain.SubscribeWatch(IDatastoreWatcher)` to
// take. That is a Thresh question, to be answered test-first in ../thresh before the subscribe
// side is wired in a later slice; it is deliberately NOT worked around here.
//
// What survives the gap intact is the method SHAPE and the one-way delivery contract, which is
// what this file pins. Delivery is best-effort BY DESIGN - a missed push costs one heartbeat of
// latency, never a lost event, because streams always read their own diffs from the log - and that
// tolerance is what makes a temporarily weaker mapping survivable at all.

describe("IDatastoreWatcher", () => {
  it("is both a type and a registered GrainInterface VALUE named for the C# interface", () => {
    expect(IDatastoreWatcher.name).toBe("IDatastoreWatcher");
  });

  it("marks BOTH notifies one-way: a notify must never block the commit that raised it", () => {
    // Orleans' [OneWay] on both members. This one attribute DOES map cleanly, and it is the
    // load-bearing half: a two-way notify would put the commit's latency at the mercy of every
    // registered watcher.
    expect(IDatastoreWatcher.options).toEqual({
      headAdvanced: { oneWay: true },
      schemaAdvanced: { oneWay: true },
    });
  });

  it("declares headAdvanced(head: bigint) - the revision is a long and must not become a number", () => {
    const seen: bigint[] = [];
    const fake: IDatastoreWatcher = {
      headAdvanced: (head: bigint) => {
        seen.push(head);
        return Promise.resolve();
      },
      schemaAdvanced: (_schemaBytes: Uint8Array, _storedHash: string) => Promise.resolve(),
    };

    // A revision beyond 2^53: the whole reason the C# `long` becomes a bigint rather than a number.
    const beyondSafeInteger = 9_007_199_254_740_993n;
    return fake.headAdvanced(beyondSafeInteger).then(() => {
      expect(seen).toEqual([beyondSafeInteger]);
    });
  });

  it("pushes the FULL schema payload alongside its stored-bytes hash, not just the hash", () => {
    // The C# remark: schema changes are rare, so pushing the payload is cheaper than forcing a
    // fetch hop on every recipient. `byte[]` -> Uint8Array; the hash is `StoredSchemaHash.Compute`,
    // the same hash `DatastoreHeadWire.SchemaHash` carries, so the heartbeat backstop can diff it.
    let received: { bytes: Uint8Array; hash: string } | undefined;
    const fake: IDatastoreWatcher = {
      headAdvanced: (_head: bigint) => Promise.resolve(),
      schemaAdvanced: (schemaBytes: Uint8Array, storedHash: string) => {
        received = { bytes: schemaBytes, hash: storedHash };
        return Promise.resolve();
      },
    };

    const bytes = new TextEncoder().encode("definition user {}");
    return fake.schemaAdvanced(bytes, "hash-abc").then(() => {
      expect(received).toEqual({ bytes, hash: "hash-abc" });
    });
  });

  it("declares exactly the two notifies, and nothing else", () => {
    const fake: IDatastoreWatcher = {
      headAdvanced: (_head: bigint) => Promise.resolve(),
      schemaAdvanced: (_schemaBytes: Uint8Array, _storedHash: string) => Promise.resolve(),
    };

    expect(Object.keys(fake)).toEqual(["headAdvanced", "schemaAdvanced"]);
  });
});
