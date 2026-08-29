import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import type { SchemaVersionWire } from "./datastore-dtos";
import {
  createEmptyKeyIndexLayout,
  datastoreMetaStateEmpty,
  datastoreMetaStateSchemaHashAt,
  datastoreMetaStateSchemaVersionAt,
  DatastoreMetaHolder,
  DEFAULT_BUCKET_COUNT,
  KEY_INDEX_TOMBSTONE,
  keyIndexLayoutBucketOf,
  NO_BUCKET_ROW,
  NO_ROW_VERSION,
  type DatastoreMetaEntry,
  type DatastoreMetaState,
  type KeyIndexBucketEntry,
  type KeyIndexDeltaEntry,
} from "./datastore-meta-state";
import { fnv1a64 } from "./stable-hash";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/DatastoreMetaState.cs`, which
// has NO covering C# test: Spiceport reaches these five types only through `ThinSequencerTests` and
// `ThinLayoutDurabilityTests`, both mesh suites belonging to a later slice. Until those land this is
// the only gate the thin-sequencer layout has, so it pins the DURABLE contract - the bucket
// function above all - rather than any implementation detail.
describe("datastoreMetaStateEmpty", () => {
  it("seeds an empty small state at the given initial revision", () => {
    const state = datastoreMetaStateEmpty(1234n);

    expect(state.headRevision).toBe(1234n);
    expect(state.schemas).toEqual([]);
    expect(state.counters).toEqual([]);
    expect(state.gcFloor).toBe(0n);
    expect([...state.forwardKeys]).toEqual([]);
    expect([...state.reverseKeys]).toEqual([]);
  });

  it("keys the index by the escaped grain-key string, mapped to a row VERSION", () => {
    // `ImmutableDictionary<string, int>` becomes a `ReadonlyMap<string, number>`: the values are
    // storage versions (`int`), NOT revisions, so they stay `number` while head and floor are
    // `bigint`. Mixing the two is the easiest silent bug in this layout.
    const state: DatastoreMetaState = {
      ...datastoreMetaStateEmpty(1n),
      forwardKeys: new Map([["f/doc/1", 3]]),
      reverseKeys: new Map([["r/user/alice", NO_ROW_VERSION]]),
    };

    const back = deserializeValue<DatastoreMetaState>(serializeValue(state));

    expect(back.forwardKeys).toBeInstanceOf(Map);
    expect(back.forwardKeys.get("f/doc/1")).toBe(3);
    expect(back.reverseKeys.get("r/user/alice")).toBe(NO_ROW_VERSION);
    expect(typeof back.forwardKeys.get("f/doc/1")).toBe("number");
    expect(typeof back.headRevision).toBe("bigint");
  });
});

describe("the key-index sentinels", () => {
  it("keeps NoRowVersion and the delta Tombstone distinct", () => {
    // -1 means "indexed but no durable row yet" and lives ONLY in memory; -2 means "removed at
    // this flush" and appears only in a durable delta row. Collapsing them would make recovery
    // either resurrect a dropped key or dereference a row that was never written.
    expect(NO_ROW_VERSION).toBe(-1);
    expect(KEY_INDEX_TOMBSTONE).toBe(-2);
    expect(NO_ROW_VERSION).not.toBe(KEY_INDEX_TOMBSTONE);
  });

  it("keeps NoBucketRow distinct from both: 0 is 'no bucket row ever written'", () => {
    expect(NO_BUCKET_ROW).toBe(0);
    expect(DEFAULT_BUCKET_COUNT).toBe(256);
  });
});

describe("datastoreMetaStateSchemaVersionAt", () => {
  const schema = (revision: bigint, hash: string): SchemaVersionWire => ({
    revision,
    bytes: new TextEncoder().encode(hash),
    hash,
  });

  const stateWith = (schemas: readonly SchemaVersionWire[]): DatastoreMetaState => ({
    ...datastoreMetaStateEmpty(100n),
    schemas,
  });

  it("returns nothing when no schema was persisted at or before the revision", () => {
    expect(datastoreMetaStateSchemaVersionAt(stateWith([]), 50n)).toBeUndefined();
    expect(datastoreMetaStateSchemaHashAt(stateWith([schema(10n, "h1")]), 9n)).toBeUndefined();
  });

  it("returns the last version written at or before the revision, inclusive", () => {
    const state = stateWith([schema(10n, "h1"), schema(20n, "h2"), schema(30n, "h3")]);

    expect(datastoreMetaStateSchemaVersionAt(state, 19n)?.hash).toBe("h1");
    expect(datastoreMetaStateSchemaVersionAt(state, 20n)?.hash).toBe("h2");
    expect(datastoreMetaStateSchemaHashAt(state, 999n)).toBe("h3");
  });

  it("BREAKS at the first schema above the revision, exactly as the grain-state scan does", () => {
    // The identical loop to `DatastoreGrainState.SchemaVersionAt`. The break relies on ascending
    // write order, which MetaFold's compaction preserves; keeping it means an out-of-order list
    // fails loudly rather than silently disagreeing with the whole-state fold.
    const outOfOrder = stateWith([schema(10n, "h1"), schema(50n, "h5"), schema(20n, "h2")]);

    expect(datastoreMetaStateSchemaVersionAt(outOfOrder, 30n)?.hash).toBe("h1");
  });
});

// The bucket of a key is part of the DURABLE layout: change the hash or the modulo and every
// stored `indexb/{version}/{dir}/{bucket}` row is stranded. These vectors are therefore pinned
// literals, computed from the FNV-1a-64 the C# `StableHash.Fnv1a64` defines, not derived from the
// implementation under test.
describe("keyIndexLayoutBucketOf", () => {
  const vectors: readonly (readonly [string, string, number])[] = [
    ["", "14695981039346656037", 37],
    ["a", "12638187200555641996", 140],
    ["f/doc/1", "7241917916086835800", 88],
    ["r/user/alice", "1508139466035810986", 170],
    ["f/document/somewhat%2Flong%2Fid", "3093155037552348923", 251],
  ];

  it.each(vectors)("hashes %o to %s and buckets it at %i of 256", (key, hash, bucket) => {
    expect(fnv1a64(key)).toBe(BigInt(hash));
    expect(keyIndexLayoutBucketOf(key, DEFAULT_BUCKET_COUNT)).toBe(bucket);
  });

  it("does the modulo UNSIGNED, so a hash above 2^63 does not go negative", () => {
    // `StableHash.Fnv1a64(key) % (ulong)bucketCount` in the C#. The first two vectors above hash
    // above 2^63 - as a SIGNED int64 they are negative, and a signed modulo would return a
    // negative bucket (or, in JS, a different one after a lossy `Number` narrowing). Every bucket
    // must land in [0, bucketCount).
    for (const [key] of vectors) {
      const bucket = keyIndexLayoutBucketOf(key, DEFAULT_BUCKET_COUNT);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(DEFAULT_BUCKET_COUNT);
      expect(Number.isInteger(bucket)).toBe(true);
    }

    expect(fnv1a64("")).toBeGreaterThan(1n << 63n);
    expect(fnv1a64("a")).toBeGreaterThan(1n << 63n);
  });

  it("narrows to a number only AFTER the bigint modulo", () => {
    // Doing the modulo in `number` would round the 64-bit hash past 2^53 first and silently
    // reassign keys to different buckets. A non-power-of-two count is the case that shows it.
    expect(keyIndexLayoutBucketOf("f/doc/1", 7)).toBe(Number(fnv1a64("f/doc/1") % 7n));
    expect(keyIndexLayoutBucketOf("", 1000)).toBe(Number(fnv1a64("") % 1000n));
  });

  it("puts every key in bucket 0 when there is exactly one bucket", () => {
    expect(keyIndexLayoutBucketOf("anything", 1)).toBe(0);
  });
});

describe("createEmptyKeyIndexLayout", () => {
  it("creates a layout with no bucket rows written and no pending deltas", () => {
    const layout = createEmptyKeyIndexLayout(4);

    expect(layout.bucketCount).toBe(4);
    expect(layout.forwardBucketVersions).toEqual([
      NO_BUCKET_ROW,
      NO_BUCKET_ROW,
      NO_BUCKET_ROW,
      NO_BUCKET_ROW,
    ]);
    expect(layout.reverseBucketVersions).toEqual(layout.forwardBucketVersions);
    expect(layout.nextBucket).toBe(0);
    expect(layout.deltaFloorVersion).toBe(0);
    expect(layout.deltaVersions).toEqual([]);
  });

  it("gives each direction its OWN version array, so bumping one does not bump the other", () => {
    // The C# builds one `ImmutableArray` and passes it twice, which is safe there because it is
    // immutable. A shared JS array is not, and the rotation writes one direction at a time.
    const layout = createEmptyKeyIndexLayout(4);

    expect(layout.forwardBucketVersions).not.toBe(layout.reverseBucketVersions);
  });

  it("rejects a bucket count below one", () => {
    // `ArgumentOutOfRangeException.ThrowIfLessThan(bucketCount, 1)`; the port's counterpart is
    // `InvalidArgumentError`. Without the guard `% 0n` throws a RangeError from deep inside the
    // bucket function instead, at the far end of the store's life.
    expect(() => createEmptyKeyIndexLayout(0)).toThrow(InvalidArgumentError);
    expect(() => createEmptyKeyIndexLayout(-1)).toThrow(InvalidArgumentError);
    expect(() => createEmptyKeyIndexLayout(1)).not.toThrow();
  });

  it("round trips through the value codec", () => {
    const layout = createEmptyKeyIndexLayout(3);

    expect(deserializeValue<typeof layout>(serializeValue(layout))).toEqual(layout);
  });
});

describe("the durable index rows", () => {
  it("carries a bucket row's entries as an absolute key -> rowVersion map", () => {
    const entry: KeyIndexBucketEntry = { entries: new Map([["f/doc/1", 3]]) };

    const back = deserializeValue<KeyIndexBucketEntry>(serializeValue(entry));

    expect(back.entries).toBeInstanceOf(Map);
    expect(back.entries.get("f/doc/1")).toBe(3);
  });

  it("carries a delta row's two directions separately, tombstones included", () => {
    const delta: KeyIndexDeltaEntry = {
      forwardEntries: new Map([
        ["f/doc/1", 5],
        ["f/doc/gone", KEY_INDEX_TOMBSTONE],
      ]),
      reverseEntries: new Map([["r/user/alice", 5]]),
    };

    const back = deserializeValue<KeyIndexDeltaEntry>(serializeValue(delta));

    expect(back.forwardEntries.get("f/doc/1")).toBe(5);
    expect(back.forwardEntries.get("f/doc/gone")).toBe(KEY_INDEX_TOMBSTONE);
    expect(back.reverseEntries.get("r/user/alice")).toBe(5);
  });
});

describe("DatastoreMetaEntry", () => {
  it("treats an ABSENT index layout as the v1 layout, to be migrated in place", () => {
    // The nullability of `IndexLayout` IS the layout-version discriminant: a v1 row has no such
    // field at all and Orleans deserializes the absent field as null. The port needs the same
    // thing to reach it as `undefined`, so a v1 row read by a v2 build still says "v1".
    const v1Row = { meta: datastoreMetaStateEmpty(0n), flushedThroughLogVersion: 4 };

    const back = deserializeValue<DatastoreMetaEntry>(serializeValue(v1Row));

    expect(back.indexLayout).toBeUndefined();
    expect(back.flushedThroughLogVersion).toBe(4);
    expect(typeof back.flushedThroughLogVersion).toBe("number");
  });

  it("carries the layout on a v2 row", () => {
    const v2Row: DatastoreMetaEntry = {
      meta: datastoreMetaStateEmpty(0n),
      flushedThroughLogVersion: 4,
      indexLayout: createEmptyKeyIndexLayout(2),
    };

    const back = deserializeValue<DatastoreMetaEntry>(serializeValue(v2Row));

    expect(back.indexLayout?.bucketCount).toBe(2);
  });
});

// OPEN QUESTION, deliberately not settled here. `DatastoreMetaHolder` is a MUTABLE class that
// exists only because Orleans' `JournaledGrain<TState,TEvent>` mutates its state object in place
// via `TransitionState`. Thresh's `bindJournaledGrain` takes a `transition` that RETURNS new state,
// so the holder may well be droppable - but the grain that would answer that is a later slice, so
// the type is ported as-is and the fold signature is kept free of it.
describe("DatastoreMetaHolder", () => {
  it("holds a replaceable immutable small state", () => {
    const holder = new DatastoreMetaHolder();
    const next = datastoreMetaStateEmpty(9n);

    holder.value = next;

    expect(holder.value).toBe(next);
  });

  it("defaults to an empty state at revision zero", () => {
    expect(new DatastoreMetaHolder().value.headRevision).toBe(0n);
  });
});
