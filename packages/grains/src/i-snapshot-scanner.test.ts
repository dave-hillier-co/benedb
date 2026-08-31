import type { IRevision } from "@benedb/core/i-revision";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { Relationship } from "@benedb/core/relationship";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { formatRelationship, parseRelationship } from "@benedb/core/tuple-strings";
import type { RegisteredCounter } from "@benedb/datastore/counters";
import type { CounterVersion, DatastoreState } from "@benedb/datastore/datastore-state";
import {
  CounterNotRegisteredException,
  InvalidRevisionException,
  RevisionNotFoundException,
} from "@benedb/datastore/datastore-exceptions";
import type { RelationshipsFilter } from "@benedb/datastore/relationships-filter";
import type { GrainInterface } from "@thresh/core/grain-interface";
import { describe, expect, it } from "vitest";

import type { DatastoreGrainState } from "./datastore-grain-state";
import { toGrainState } from "./datastore-state-converters";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { GrainSnapshotScanner } from "./i-snapshot-scanner";

/**
 * No covering C# test - a characterization of `Grains/ISnapshotScanner.cs` (the seam plus the
 * internal `GrainSnapshotScanner`). Every C# consumer of this class reaches it through a
 * TestCluster, so nothing else gates it here.
 *
 * The three behaviours that are easiest to lose in translation, and what pins each:
 *
 *   1. `ReaderAt` runs ONCE PER CALL - one `ReadState` hop per Scan / CountRelationships /
 *      ReadCounterFilter / LookupCounters, never one per row.
 *   2. `Scan` and `LookupCounters` are C# ITERATOR methods, so `await ReaderAt(...)` happens at
 *      the first MoveNext, not at the call. A port that awaits the fetch before returning an
 *      iterable moves the sequencer hop (and the RevisionNotFoundException) earlier.
 *   3. `ReaderAt`'s order of operations: null-check the revision, `ThrowIfCancellationRequested`,
 *      ToNanos, `SequencerStateFetch.StateCovering`, then the `MvccSnapshotReader` constructor -
 *      whose own GC-floor guard, NOT the permissive `_ => true` validity delegate, is what raises
 *      RevisionNotFoundException.
 */

interface Recorder {
  readonly seam: { getGrain<T>(definition: GrainInterface<T>, key: never): T };
  readonly lookups: { definition: unknown; key: unknown }[];
  /** One entry per `readState` call. */
  readonly reads: number[];
}

/** A `{ getGrain }` seam over a scripted `readState`; the last state repeats forever. */
function fakeRuntime(states: readonly DatastoreGrainState[]): Recorder {
  const lookups: { definition: unknown; key: unknown }[] = [];
  const reads: number[] = [];
  const grain = {
    readState(): Promise<DatastoreGrainState> {
      const index = reads.length;
      reads.push(index);
      return Promise.resolve(states[Math.min(index, states.length - 1)]!);
    },
  };
  return {
    seam: {
      getGrain<T>(definition: GrainInterface<T>, key: never): T {
        lookups.push({ definition, key });
        return grain as unknown as T;
      },
    },
    lookups,
    reads,
  };
}

function rel(text: string): Relationship {
  return parseRelationship(text);
}

interface Row {
  readonly text: string;
  readonly created: bigint;
  readonly deleted?: bigint | undefined;
}

function state(options: {
  readonly head: bigint;
  readonly rows?: readonly Row[] | undefined;
  readonly counters?: readonly CounterVersion[] | undefined;
  readonly gcFloor?: bigint | undefined;
}): DatastoreGrainState {
  const memory: DatastoreState = {
    headRevision: options.head,
    relationships: (options.rows ?? []).map((row) => ({
      relationship: rel(row.text),
      createdRevision: row.created,
      deletedRevision: row.deleted,
    })),
    schemas: [],
    counters: options.counters ?? [],
    gcFloor: options.gcFloor ?? 0n,
  };
  return toGrainState(memory);
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

const ANY_FILTER: RelationshipsFilter = {};

describe("GrainSnapshotScanner routing and fetch discipline", () => {
  it("routes to the cluster-singleton datastore grain under its constant key", async () => {
    // `grainFactory.GetGrain<IDatastoreGrain>(IDatastoreGrain.Key)`.
    const runtime = fakeRuntime([state({ head: 10n })]);

    await collect(
      new GrainSnapshotScanner(runtime.seam).scan(ANY_FILTER, new TimestampRevision(10n)),
    );

    expect(runtime.lookups.length).toBeGreaterThanOrEqual(1);
    expect(runtime.lookups[0]?.definition).toBe(IDatastoreGrain);
    expect(runtime.lookups[0]?.key).toBe(DATASTORE_GRAIN_KEY);
  });

  it("fetches the state ONCE PER CALL, not once per row", async () => {
    const runtime = fakeRuntime([
      state({
        head: 10n,
        rows: [
          { text: "document:doc1#viewer@user:alice", created: 1n },
          { text: "document:doc2#viewer@user:bob", created: 1n },
          { text: "document:doc3#viewer@user:carol", created: 1n },
        ],
      }),
    ]);

    const found = await collect(
      new GrainSnapshotScanner(runtime.seam).scan(ANY_FILTER, new TimestampRevision(10n)),
    );

    expect(found).toHaveLength(3);
    expect(runtime.reads).toHaveLength(1);
  });

  it("fetches the state once for each of the four call shapes, and once for each REPEAT call", async () => {
    const counters: CounterVersion[] = [{ revision: 1n, name: "c", filter: {} }];
    const runtime = fakeRuntime([state({ head: 10n, counters })]);
    const scanner = new GrainSnapshotScanner(runtime.seam);
    const at = new TimestampRevision(10n);

    await collect(scanner.scan(ANY_FILTER, at));
    await scanner.countRelationships("c", at);
    await scanner.readCounterFilter("c", at);
    await collect(scanner.lookupCounters(at));

    expect(runtime.reads).toHaveLength(4);

    await scanner.readCounterFilter("c", at);
    expect(runtime.reads).toHaveLength(5);
  });

  it("defers the fetch on Scan until the first element is pulled (a C# iterator method)", async () => {
    const runtime = fakeRuntime([state({ head: 10n })]);

    const iterable = new GrainSnapshotScanner(runtime.seam).scan(
      ANY_FILTER,
      new TimestampRevision(10n),
    );
    // Merely obtaining the iterable must not have hopped to the sequencer.
    expect(runtime.reads).toHaveLength(0);

    await iterable[Symbol.asyncIterator]().next();

    expect(runtime.reads).toHaveLength(1);
  });

  it("defers the fetch on LookupCounters until the first element is pulled", async () => {
    const runtime = fakeRuntime([state({ head: 10n })]);

    const iterable = new GrainSnapshotScanner(runtime.seam).lookupCounters(
      new TimestampRevision(10n),
    );
    expect(runtime.reads).toHaveLength(0);

    await iterable[Symbol.asyncIterator]().next();

    expect(runtime.reads).toHaveLength(1);
  });

  it("refetches until the fetched head covers the pinned revision", async () => {
    // The closed-timestamp gate: `SequencerStateFetch.StateCovering(Grain, pinned, ct)`. The first
    // reply is a stale duplicate activation's head, below the pin, and must not be folded over.
    const runtime = fakeRuntime([
      state({ head: 5n, rows: [] }),
      state({ head: 20n, rows: [{ text: "document:doc1#viewer@user:alice", created: 9n }] }),
    ]);

    const found = await collect(
      new GrainSnapshotScanner(runtime.seam).scan(ANY_FILTER, new TimestampRevision(10n)),
    );

    expect(runtime.reads).toHaveLength(2);
    expect(found.map(formatRelationship)).toEqual(["document:doc1#viewer@user:alice"]);
  });
});

describe("GrainSnapshotScanner ReaderAt guards", () => {
  const NOTHING = [state({ head: 10n })];

  it("rejects a missing revision before any grain hop", async () => {
    // `ArgumentNullException.ThrowIfNull(revision);` - the FIRST statement of ReaderAt.
    const runtime = fakeRuntime(NOTHING);
    const scanner = new GrainSnapshotScanner(runtime.seam);
    const missing = undefined as unknown as IRevision;

    await expect(scanner.countRelationships("c", missing)).rejects.toThrow(InvalidArgumentError);
    await expect(scanner.readCounterFilter("c", missing)).rejects.toThrow(InvalidArgumentError);
    await expect(collect(scanner.scan(ANY_FILTER, missing))).rejects.toThrow(InvalidArgumentError);
    await expect(collect(scanner.lookupCounters(missing))).rejects.toThrow(InvalidArgumentError);
    expect(runtime.reads).toHaveLength(0);
  });

  it("throws the signal's reason before any grain hop when already aborted", async () => {
    // `ct.ThrowIfCancellationRequested();` sits BEFORE ToNanos and before the fetch.
    const runtime = fakeRuntime(NOTHING);
    const scanner = new GrainSnapshotScanner(runtime.seam);
    const reason = new Error("caller went away");
    const controller = new AbortController();
    controller.abort(reason);

    await expect(
      scanner.countRelationships("c", new TimestampRevision(10n), controller.signal),
    ).rejects.toBe(reason);
    await expect(
      collect(scanner.scan(ANY_FILTER, new TimestampRevision(10n), controller.signal)),
    ).rejects.toBe(reason);
    expect(runtime.reads).toHaveLength(0);
  });

  it("rejects a revision that is not a timestamp revision, naming its type", async () => {
    // `_ => throw new InvalidRevisionException($"unsupported revision type: {revision.GetType().Name}")`.
    class FakeRevision {
      toString(): string {
        return "fake";
      }
    }
    const runtime = fakeRuntime(NOTHING);
    const scanner = new GrainSnapshotScanner(runtime.seam);
    const bogus = new FakeRevision() as unknown as IRevision;

    const error = await scanner.countRelationships("c", bogus).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidRevisionException);
    expect((error as Error).message).toBe("unsupported revision type: FakeRevision");
    expect(runtime.reads).toHaveLength(0);
  });

  it("surfaces the GC-floor rejection from the MvccSnapshotReader constructor", async () => {
    // The head covers the pin, so the closed-timestamp gate passes; the reader's own constructor
    // guard is what rejects a revision below the collected floor. The permissive `_ => true`
    // validity delegate must not be replaced by a real predicate - it is not what decides this.
    const runtime = fakeRuntime([state({ head: 200n, gcFloor: 100n })]);
    const scanner = new GrainSnapshotScanner(runtime.seam);

    await expect(scanner.countRelationships("c", new TimestampRevision(50n))).rejects.toThrow(
      RevisionNotFoundException,
    );
    // For the streaming shape it surfaces at the first pull, not at the call.
    const iterable = scanner.scan(ANY_FILTER, new TimestampRevision(50n));
    await expect(iterable[Symbol.asyncIterator]().next()).rejects.toThrow(
      RevisionNotFoundException,
    );
  });
});

describe("GrainSnapshotScanner delegation to MvccSnapshotReader", () => {
  const rows: Row[] = [
    { text: "document:doc1#viewer@user:alice", created: 1n },
    { text: "document:doc2#viewer@user:bob", created: 15n },
    { text: "folder:f1#viewer@user:alice", created: 1n },
    { text: "document:doc3#viewer@user:dan", created: 1n, deleted: 5n },
  ];

  it("Scan serves the MVCC view at the PINNED revision, in storage order", async () => {
    const runtime = fakeRuntime([state({ head: 20n, rows })]);

    const found = await collect(
      new GrainSnapshotScanner(runtime.seam).scan(ANY_FILTER, new TimestampRevision(10n)),
    );

    // doc2 is not yet created at 10; doc3 was deleted at 5. Order is the stored order.
    expect(found.map(formatRelationship)).toEqual([
      "document:doc1#viewer@user:alice",
      "folder:f1#viewer@user:alice",
    ]);
  });

  it("Scan applies the filter it is given", async () => {
    const runtime = fakeRuntime([state({ head: 20n, rows })]);

    const found = await collect(
      new GrainSnapshotScanner(runtime.seam).scan(
        { optionalResourceType: "folder" },
        new TimestampRevision(20n),
      ),
    );

    expect(found.map(formatRelationship)).toEqual(["folder:f1#viewer@user:alice"]);
  });

  it("passes the signal down into the reader's enumeration", async () => {
    // The C# hands `ct` to `reader.QueryRelationships(filter, ct)`, which checks it per row.
    const runtime = fakeRuntime([state({ head: 20n, rows })]);
    const controller = new AbortController();
    const reason = new Error("stop mid-scan");

    const iterable = new GrainSnapshotScanner(runtime.seam).scan(
      ANY_FILTER,
      new TimestampRevision(20n),
      controller.signal,
    );
    const iterator = iterable[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort(reason);

    await expect(iterator.next()).rejects.toBe(reason);
  });

  it("CountRelationships answers from the counter's registered filter, as a bigint", async () => {
    const counters: CounterVersion[] = [
      { revision: 1n, name: "documents", filter: { optionalResourceType: "document" } },
    ];
    const runtime = fakeRuntime([state({ head: 20n, rows, counters })]);

    const count = await new GrainSnapshotScanner(runtime.seam).countRelationships(
      "documents",
      new TimestampRevision(20n),
    );

    // `ulong` -> bigint: a Number return would be wrong at the top of the range, and `2n` is not
    // equal to `2` under toBe.
    expect(count).toBe(2n);
    expect(typeof count).toBe("bigint");
  });

  it("CountRelationships throws when the counter is not registered at the pinned revision", async () => {
    const counters: CounterVersion[] = [{ revision: 30n, name: "late", filter: {} }];
    const runtime = fakeRuntime([state({ head: 40n, rows, counters })]);

    await expect(
      new GrainSnapshotScanner(runtime.seam).countRelationships("late", new TimestampRevision(20n)),
    ).rejects.toThrow(CounterNotRegisteredException);
  });

  it("ReadCounterFilter returns the registered filter, and undefined when NOT registered", async () => {
    // null MEANS "not registered here" - never an empty filter, which would match everything.
    const filter: RelationshipsFilter = { optionalResourceType: "document" };
    const counters: CounterVersion[] = [{ revision: 1n, name: "documents", filter }];
    const runtime = fakeRuntime([state({ head: 20n, counters })]);
    const scanner = new GrainSnapshotScanner(runtime.seam);

    const found = await scanner.readCounterFilter("documents", new TimestampRevision(20n));
    // Compared field-wise, not with a whole-object equal: the state round-trips through
    // `DatastoreStateConverters`, which resolves the defaulted expiration option to "none".
    expect(found?.optionalResourceType).toBe("document");
    await expect(
      scanner.readCounterFilter("absent", new TimestampRevision(20n)),
    ).resolves.toBeUndefined();
  });

  it("LookupCounters streams the counters live at the revision, tombstones excluded", async () => {
    const counters: CounterVersion[] = [
      { revision: 1n, name: "kept", filter: { optionalResourceType: "document" } },
      { revision: 2n, name: "dropped", filter: { optionalResourceType: "folder" } },
      { revision: 3n, name: "dropped", filter: undefined },
      { revision: 30n, name: "later", filter: {} },
    ];
    const runtime = fakeRuntime([state({ head: 40n, counters })]);

    const live: RegisteredCounter[] = await collect(
      new GrainSnapshotScanner(runtime.seam).lookupCounters(new TimestampRevision(20n)),
    );

    expect(live.map((c) => c.name)).toEqual(["kept"]);
  });
});
