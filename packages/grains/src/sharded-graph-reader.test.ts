import type { IRevision } from "@benedb/core/i-revision";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { Relationship } from "@benedb/core/relationship";
import type { RelationshipReference } from "@benedb/core/relationship-reference";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { formatRelationship, parseRelationship } from "@benedb/core/tuple-strings";
import { InvalidRevisionException } from "@benedb/datastore/datastore-exceptions";
import type { RelationshipsFilter, SubjectsFilter } from "@benedb/datastore/relationships-filter";
import type { ReverseQueryOptions } from "@benedb/datastore/reverse-query-options";
import type { GrainInterface } from "@thresh/core/grain-interface";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FullRelationshipsFilterWire } from "./datastore-dtos";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { graphShardKeyForResource, graphShardKeyForSubject } from "./graph-shard-key";
import { ShardedGraphReaderSource } from "./i-graph-reader-source";
import { IGraphShardGrain } from "./i-graph-shard-grain";
import type { RelationshipWire } from "./relationships-dtos";
import { NotSupportedError, ShardedGraphReader } from "./sharded-graph-reader";
import { toFullFilter, toWire } from "./wire-convert";

/**
 * No covering C# test that can RUN yet: every consumer of `Grains/ShardedGraphReader.cs` and
 * `Grains/IGraphReaderSource.cs` in Spiceport reaches them through a `MeshTestCluster`, and the
 * grain implementations behind that cluster are a later slice. This is therefore a
 * CHARACTERIZATION of the two files, plus the three shape-guard assertions that
 * `ShardedReaderEquivalenceTests` (section "(e) Shape guards", lines 194-204) and its
 * "(d) Absent keys" section pin, ported here because they are reachable without a cluster.
 *
 * The property the whole file exists to protect: `ShardedGraphReader` must be ROW-FOR-ROW
 * interchangeable with `MvccSnapshotReader` over the same data (that is what
 * `ShardedReaderEquivalenceTests` proves once the mesh lands). So wherever the C# reader mirrors
 * the snapshot reader - the once-per-enumeration "now", the `<=` expiry boundary, the
 * materialize/sort/exclusive-keyset shape of the ordered reverse path - the expectation below is
 * derived from `mvcc-snapshot-reader.ts`, not from this reader's own code.
 *
 * The five things easiest to lose in translation, and what pins each:
 *
 *   1. The shape guards are OR-joined and checked FIRST, and - because the C# methods are
 *      iterators - the throw is DEFERRED to the first MoveNext. `ShardedReaderEquivalenceTests`
 *      observes them by draining (`Drain(sharded.QueryRelationships(...))`).
 *   2. `now` is captured ONCE per enumeration, BEFORE the shard loop, so every row of one read
 *      sees the same expiration cutoff. Capturing per row is a real behaviour change.
 *   3. Both paths are lazy async generators - the DTOs are pages precisely so no
 *      `IAsyncEnumerable` crosses a grain boundary. Only the SORTED reverse path materialises.
 *   4. The forward path pushes `WireConvert.ToFullFilter(filter)` down AND keeps the client-side
 *      expiry skip and `filter.Matches` re-check; the reverse path pushes NOTHING (`null`) and
 *      keeps `subjectsFilter.Matches` client-side.
 *   5. `ct.ThrowIfCancellationRequested()` sits at the top of every per-id loop, every per-row
 *      loop, and the sorted yield loop - six sites, not one check at entry.
 */

// --- fixtures -------------------------------------------------------------------------------

/** One recorded `IGraphShardGrain.rowsAt` call. */
interface MeshCall {
  readonly key: string;
  readonly revision: bigint;
  readonly filter: FullRelationshipsFilterWire | undefined;
  readonly signal: AbortSignal | undefined;
}

interface Mesh {
  /** The `{ getGrain }` slice of `GrainRuntime` the reader takes. */
  readonly seam: { getGrain<T>(definition: GrainInterface<T>, key: never): T };
  readonly calls: MeshCall[];
  /** The grain definition each `getGrain` was asked for. */
  readonly definitions: unknown[];
}

interface MeshOptions {
  /** Rows per SHARD GRAIN KEY (`graphShardGrainKeyBuild(...)`). A missing key is a cold shard. */
  readonly rows?: Readonly<Record<string, readonly RelationshipWire[]>>;
  /** Runs on every `rowsAt`, before the reply resolves - the seam for moving the clock. */
  readonly onCall?: (key: string) => void;
}

function mesh(options: MeshOptions = {}): Mesh {
  const calls: MeshCall[] = [];
  const definitions: unknown[] = [];
  const rows = options.rows ?? {};
  return {
    seam: {
      getGrain<T>(definition: GrainInterface<T>, key: never): T {
        definitions.push(definition);
        const shardKey = key as unknown as string;
        const grain = {
          rowsAt(
            revision: bigint,
            filter: FullRelationshipsFilterWire | undefined,
            signal?: AbortSignal | undefined,
          ): Promise<{ readonly rows: readonly RelationshipWire[] }> {
            calls.push({ key: shardKey, revision, filter, signal });
            options.onCall?.(shardKey);
            return Promise.resolve({ rows: rows[shardKey] ?? [] });
          },
        };
        return grain as unknown as T;
      },
    },
    calls,
    definitions,
  };
}

const forwardKey = (type: string, id: string): string =>
  graphShardGrainKeyBuild(graphShardKeyForResource(type, id));
const reverseKey = (type: string, id: string): string =>
  graphShardGrainKeyBuild(graphShardKeyForSubject(type, id));

/** A wire row from a tuple string, optionally expiring at the given nanos-since-epoch. */
function wire(text: string, expiration?: bigint): RelationshipWire {
  return { ...toWire(parseRelationship(text)), expiration };
}

function reference(text: string): RelationshipReference {
  return parseRelationship(text).reference;
}

async function collect(source: AsyncIterable<Relationship>): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of source) out.push(formatRelationship(rel));
  return out;
}

const REVISION = 4242n;

/** Set the fake wall clock and return the nanos-since-epoch the readers will compute from it. */
function setClock(millis: number): bigint {
  vi.setSystemTime(new Date(millis));
  return BigInt(millis) * 1_000_000n;
}

afterEach(() => {
  vi.useRealTimers();
});

// --- shape guards ---------------------------------------------------------------------------

/**
 * The message is verbatim from BOTH throw sites; `ShardedReaderEquivalenceTests` only asserts the
 * exception type, but the string is the operator-facing explanation of the narrow seam and is
 * duplicated in the C#, so it is pinned here.
 */
const SCAN_SHAPED =
  "scan-shaped filter on the sharded graph reader; broad scans stay on the IDatastoreReader/snapshot path";

describe("ShardedGraphReader shape guards", () => {
  const okFilter: RelationshipsFilter = {
    optionalResourceType: "document",
    optionalResourceIds: ["a"],
  };

  it("defers the rejection to the first pull, as a C# iterator does", async () => {
    // `ShardedReaderEquivalenceTests` observes the guard with `Drain(...)`: calling the method
    // only builds the iterator. A port that throws SYNCHRONOUSLY fails on the first line here.
    const m = mesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);

    const forward = reader.queryRelationships({ optionalResourceType: "document" });
    const reverse = reader.reverseQueryRelationships({ subjectType: "user" });
    expect(m.calls).toHaveLength(0);

    await expect(collect(forward)).rejects.toThrow(NotSupportedError);
    await expect(collect(reverse)).rejects.toThrow(NotSupportedError);
    // The guard is BEFORE anything else, so no shard is ever contacted.
    expect(m.calls).toHaveLength(0);
  });

  it("rejects a forward filter with no resource type", async () => {
    // `filter.OptionalResourceType is null` - the first disjunct.
    const m = mesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);
    await expect(
      collect(reader.queryRelationships({ optionalResourceIds: ["a"] })),
    ).rejects.toThrow(SCAN_SHAPED);
  });

  it("rejects a forward filter with absent or empty resource ids", async () => {
    // `filter.OptionalResourceIds is not { Count: > 0 }` - absent AND empty both fail the pattern.
    // The empty case is the one that differs from `relationshipsFilterMatches`, where an empty
    // list places NO constraint; here it is a scan.
    const m = mesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);
    await expect(
      collect(reader.queryRelationships({ optionalResourceType: "document" })),
    ).rejects.toThrow(NotSupportedError);
    await expect(
      collect(
        reader.queryRelationships({ optionalResourceType: "document", optionalResourceIds: [] }),
      ),
    ).rejects.toThrow(NotSupportedError);
  });

  it("rejects a forward filter carrying a resource id prefix, even an empty one", async () => {
    // `filter.OptionalResourceIdPrefix is not null` - the test is against NULL, not emptiness, so
    // an empty prefix (which `relationshipsFilterMatches` treats as no constraint) still rejects.
    const m = mesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);
    await expect(
      collect(reader.queryRelationships({ ...okFilter, optionalResourceIdPrefix: "p" })),
    ).rejects.toThrow(NotSupportedError);
    await expect(
      collect(reader.queryRelationships({ ...okFilter, optionalResourceIdPrefix: "" })),
    ).rejects.toThrow(NotSupportedError);
  });

  it("rejects a reverse filter with absent or empty subject ids", async () => {
    // `subjectsFilter.OptionalSubjectIds is not { Count: > 0 }`. The only no-subject-ids caller in
    // Spiceport is SchemaChangeValidator, which stays on IDatastoreReader.
    const m = mesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);
    await expect(
      collect(reader.reverseQueryRelationships({ subjectType: "user" })),
    ).rejects.toThrow(SCAN_SHAPED);
    await expect(
      collect(reader.reverseQueryRelationships({ subjectType: "user", optionalSubjectIds: [] })),
    ).rejects.toThrow(NotSupportedError);
  });

  it("rejects a missing filter before contacting any shard", async () => {
    // `ArgumentNullException.ThrowIfNull(filter);` is the first statement of each iterator, so it
    // too is deferred to the first pull.
    const m = mesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);
    await expect(
      collect(reader.queryRelationships(undefined as unknown as RelationshipsFilter)),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      collect(reader.reverseQueryRelationships(undefined as unknown as SubjectsFilter)),
    ).rejects.toThrow(InvalidArgumentError);
    expect(m.calls).toHaveLength(0);
  });

  it("rejects a missing grain factory at construction", () => {
    // `ArgumentNullException.ThrowIfNull(grainFactory);` - the constructor's first statement.
    expect(
      () =>
        new ShardedGraphReader(
          undefined as unknown as { getGrain<T>(d: GrainInterface<T>, k: never): T },
          REVISION,
        ),
    ).toThrow(InvalidArgumentError);
  });
});

// --- forward path ---------------------------------------------------------------------------

describe("ShardedGraphReader queryRelationships", () => {
  const filter: RelationshipsFilter = {
    optionalResourceType: "document",
    optionalResourceIds: ["a", "b"],
  };

  it("calls one forward shard per DISTINCT resource id, in first-seen order", async () => {
    // `resourceIds.Distinct()` - dedupe preserving first-seen order, one grain call each.
    const m = mesh({
      rows: {
        [forwardKey("document", "b")]: [wire("document:b#viewer@user:alice")],
        [forwardKey("document", "a")]: [wire("document:a#viewer@user:alice")],
        [forwardKey("document", "c")]: [wire("document:c#viewer@user:alice")],
      },
    });
    const reader = new ShardedGraphReader(m.seam, REVISION);

    const found = await collect(
      reader.queryRelationships({
        optionalResourceType: "document",
        optionalResourceIds: ["b", "a", "b", "c", "a"],
      }),
    );

    expect(m.calls.map((c) => c.key)).toEqual([
      forwardKey("document", "b"),
      forwardKey("document", "a"),
      forwardKey("document", "c"),
    ]);
    // Rows arrive shard by shard, in that same order - no reordering on the forward path.
    expect(found).toEqual([
      "document:b#viewer@user:alice",
      "document:a#viewer@user:alice",
      "document:c#viewer@user:alice",
    ]);
    expect(m.definitions).toEqual([IGraphShardGrain, IGraphShardGrain, IGraphShardGrain]);
  });

  it("pushes the WHOLE filter down and passes the pinned revision", async () => {
    // `var wireFilter = WireConvert.ToFullFilter(filter);` computed ONCE, before the loop, and
    // `shard.RowsAt(_revisionNanos, wireFilter, ct)`.
    const m = mesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);

    await collect(reader.queryRelationships(filter));

    expect(m.calls).toHaveLength(2);
    for (const call of m.calls) {
      expect(call.revision).toBe(REVISION);
      expect(call.filter).toEqual(toFullFilter(filter));
    }
    // The same wire filter object travels to every shard (hoisted out of the loop).
    expect(m.calls[1]?.filter).toBe(m.calls[0]?.filter);
  });

  it("still applies filter.Matches client-side after the pushdown", async () => {
    // The C# comment is explicit: the client-side expiry skip AND `filter.Matches` deliberately
    // STAY - "cheap belt-and-braces that keeps the equivalence argument trivial". A shard that
    // over-returns must not widen the answer. Do NOT delete this as an optimisation.
    const m = mesh({
      rows: {
        [forwardKey("document", "a")]: [
          wire("document:a#viewer@user:alice"),
          wire("document:a#editor@user:bob"),
        ],
      },
    });
    const reader = new ShardedGraphReader(m.seam, REVISION);

    const found = await collect(
      reader.queryRelationships({
        optionalResourceType: "document",
        optionalResourceIds: ["a"],
        optionalResourceRelation: "viewer",
      }),
    );

    expect(found).toEqual(["document:a#viewer@user:alice"]);
  });

  it("converts rows with WireConvert.ToRelationship, normalising an empty subject relation", async () => {
    // `var rel = WireConvert.ToRelationship(row);` - the empty subject relation becomes ELLIPSIS,
    // which is what makes the yielded row compare equal to the snapshot reader's.
    const m = mesh({
      rows: {
        [forwardKey("document", "a")]: [
          { ...toWire(parseRelationship("document:a#viewer@user:alice")), subjectRelation: "" },
        ],
      },
    });
    const reader = new ShardedGraphReader(m.seam, REVISION);

    expect(
      await collect(reader.queryRelationships({ ...filter, optionalResourceIds: ["a"] })),
    ).toEqual(["document:a#viewer@user:alice"]);
  });

  it("returns nothing for a cold, never-written shard", async () => {
    // ShardedReaderEquivalenceTests section (d): an absent key activates an empty shard and both
    // readers must return nothing - not throw, not invent rows.
    const m = mesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);

    expect(
      await collect(
        reader.queryRelationships({
          optionalResourceType: "document",
          optionalResourceIds: ["spiceport-never-written"],
        }),
      ),
    ).toEqual([]);
    expect(m.calls).toHaveLength(1);
  });

  it("is lazy: it contacts the next shard only when the consumer asks for more", async () => {
    // An `async IAsyncEnumerable` iterator runs no shard call until MoveNext, and one shard at a
    // time. Materialising the forward path would pull every shard up front.
    const m = mesh({
      rows: {
        [forwardKey("document", "a")]: [
          wire("document:a#viewer@user:alice"),
          wire("document:a#viewer@user:bob"),
        ],
        [forwardKey("document", "b")]: [wire("document:b#viewer@user:alice")],
      },
    });
    const reader = new ShardedGraphReader(m.seam, REVISION);

    const iterator = reader.queryRelationships(filter)[Symbol.asyncIterator]();
    expect(m.calls).toHaveLength(0);

    const first = await iterator.next();
    expect(formatRelationship(first.value as Relationship)).toBe("document:a#viewer@user:alice");
    expect(m.calls.map((c) => c.key)).toEqual([forwardKey("document", "a")]);

    await iterator.next(); // second row of shard a - still no new call
    expect(m.calls).toHaveLength(1);

    await iterator.next();
    expect(m.calls.map((c) => c.key)).toEqual([
      forwardKey("document", "a"),
      forwardKey("document", "b"),
    ]);
  });
});

// --- expiration -----------------------------------------------------------------------------

describe("ShardedGraphReader expiration filtering", () => {
  const filter: RelationshipsFilter = {
    optionalResourceType: "document",
    optionalResourceIds: ["a"],
  };

  it("excludes an expiration AT now and includes one one nanosecond later", async () => {
    // `rel.OptionalExpiration is { } exp && exp <= now` - AT OR BEFORE now excludes. `<` instead
    // of `<=` diverges on exactly this boundary row, and `MvccSnapshotReader.IsExpired` is `<=`.
    vi.useFakeTimers();
    const now = setClock(1_000);
    const m = mesh({
      rows: {
        [forwardKey("document", "a")]: [
          wire("document:a#viewer@user:before", now - 1n),
          wire("document:a#viewer@user:at", now),
          wire("document:a#viewer@user:after", now + 1n),
          wire("document:a#viewer@user:none"),
        ],
      },
    });
    const reader = new ShardedGraphReader(m.seam, REVISION);

    expect(await collect(reader.queryRelationships(filter))).toEqual([
      // `formatRelationship` renders the expiration, so the surviving row carries its suffix.
      "document:a#viewer@user:after[expiration:1970-01-01T00:00:01.0000000Z]",
      "document:a#viewer@user:none",
    ]);
  });

  it("captures now ONCE per enumeration, before the first shard call", async () => {
    // `var now = DateTimeOffset.UtcNow;` sits BEFORE the loop. Here the clock jumps forward while
    // the enumeration is in flight: under the once-captured cutoff the second shard's row is still
    // live; a per-row capture would drop it. Mirrors MvccSnapshotReader, which samples once "so a
    // long scan must not straddle an expiry mid-result".
    vi.useFakeTimers();
    const start = setClock(1_000);
    const m = mesh({
      rows: {
        [forwardKey("document", "a")]: [wire("document:a#viewer@user:alice")],
        [forwardKey("document", "b")]: [wire("document:b#viewer@user:bob", start + 500_000n)],
      },
      onCall: (key) => {
        if (key === forwardKey("document", "b")) setClock(2_000);
      },
    });
    const reader = new ShardedGraphReader(m.seam, REVISION);

    expect(
      await collect(
        reader.queryRelationships({
          optionalResourceType: "document",
          optionalResourceIds: ["a", "b"],
        }),
      ),
    ).toEqual([
      "document:a#viewer@user:alice",
      "document:b#viewer@user:bob[expiration:1970-01-01T00:00:01.0005000Z]",
    ]);
  });

  it("captures now once on the reverse path too, in both branches", async () => {
    vi.useFakeTimers();
    const start = setClock(1_000);
    const rows = {
      [reverseKey("user", "alice")]: [wire("document:a#viewer@user:alice")],
      [reverseKey("user", "bob")]: [wire("document:b#viewer@user:bob", start + 500_000n)],
    };
    const advance = (key: string): void => {
      if (key === reverseKey("user", "bob")) setClock(2_000);
    };
    const subjects: SubjectsFilter = {
      subjectType: "user",
      optionalSubjectIds: ["alice", "bob"],
    };

    const unsorted = mesh({ rows, onCall: advance });
    expect(
      await collect(
        new ShardedGraphReader(unsorted.seam, REVISION).reverseQueryRelationships(subjects),
      ),
    ).toEqual([
      "document:a#viewer@user:alice",
      "document:b#viewer@user:bob[expiration:1970-01-01T00:00:01.0005000Z]",
    ]);

    setClock(1_000);
    const sorted = mesh({ rows, onCall: advance });
    expect(
      await collect(
        new ShardedGraphReader(sorted.seam, REVISION).reverseQueryRelationships(subjects, {
          sort: "bySubject",
        }),
      ),
    ).toEqual([
      "document:a#viewer@user:alice",
      "document:b#viewer@user:bob[expiration:1970-01-01T00:00:01.0005000Z]",
    ]);
  });
});

// --- reverse: unsorted ----------------------------------------------------------------------

describe("ShardedGraphReader reverseQueryRelationships unsorted", () => {
  const subjects: SubjectsFilter = {
    subjectType: "user",
    optionalSubjectIds: ["alice", "bob"],
  };

  function twoSubjects(): Mesh {
    return mesh({
      rows: {
        [reverseKey("user", "alice")]: [
          wire("document:a#viewer@user:alice"),
          wire("document:b#viewer@user:alice"),
        ],
        [reverseKey("user", "bob")]: [wire("document:c#viewer@user:bob")],
      },
    });
  }

  it("calls one REVERSE shard per distinct subject id and pushes NO filter down", async () => {
    // `RowsOfSubject` builds `GraphShardKeyWire.ForSubject(...)` and calls
    // `shard.RowsAt(_revisionNanos, null, ct)` - "No pushdown on the reverse path: reverse shards
    // are already subject-narrow". A filter here would be a behaviour change, not a speed-up.
    const m = twoSubjects();
    const reader = new ShardedGraphReader(m.seam, REVISION);

    const found = await collect(
      reader.reverseQueryRelationships({
        subjectType: "user",
        optionalSubjectIds: ["alice", "bob", "alice"],
      }),
    );

    expect(m.calls.map((c) => c.key)).toEqual([
      reverseKey("user", "alice"),
      reverseKey("user", "bob"),
    ]);
    for (const call of m.calls) {
      expect(call.filter).toBeUndefined();
      expect(call.revision).toBe(REVISION);
    }
    expect(found).toEqual([
      "document:a#viewer@user:alice",
      "document:b#viewer@user:alice",
      "document:c#viewer@user:bob",
    ]);
  });

  it("takes the fast path when options are absent OR the sort is unsorted", async () => {
    // `options is null || options.Sort == ReverseQuerySort.Unsorted`. TypeScript's `sort` is
    // OPTIONAL where the C# record parameter is required, and `mvcc-snapshot-reader.ts` treats an
    // absent sort as unsorted - so an `after` with no sort is IGNORED here exactly as it is there.
    // The two readers must agree, so this parity is the pin.
    const cases: (ReverseQueryOptions | undefined)[] = [
      undefined,
      { sort: "unsorted" },
      { sort: undefined, after: reference("document:z#viewer@user:zed") },
      { sort: "unsorted", after: reference("document:z#viewer@user:zed") },
    ];
    for (const options of cases) {
      const m = twoSubjects();
      const reader = new ShardedGraphReader(m.seam, REVISION);
      expect(await collect(reader.reverseQueryRelationships(subjects, options))).toEqual([
        "document:a#viewer@user:alice",
        "document:b#viewer@user:alice",
        "document:c#viewer@user:bob",
      ]);
    }
  });

  it("applies subjectsFilter.Matches client-side", async () => {
    // The reverse path has no pushdown, so `subjectsFilter.Matches(rel)` is the ONLY filter: a
    // reverse shard holds every row with that subject, whatever the resource type or relation.
    const m = mesh({
      rows: {
        [reverseKey("user", "alice")]: [
          wire("document:a#viewer@user:alice"),
          wire("folder:f#viewer@user:alice"),
          wire("document:b#editor@user:alice"),
        ],
      },
    });
    const reader = new ShardedGraphReader(m.seam, REVISION);

    expect(
      await collect(
        reader.reverseQueryRelationships({
          subjectType: "user",
          optionalSubjectIds: ["alice"],
          optionalResourceType: "document",
          optionalResourceRelation: "viewer",
        }),
      ),
    ).toEqual(["document:a#viewer@user:alice"]);
  });

  it("returns nothing for a never-written subject", async () => {
    // ShardedReaderEquivalenceTests section (d), the reverse half.
    const m = mesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);
    expect(
      await collect(
        reader.reverseQueryRelationships({
          subjectType: "user",
          optionalSubjectIds: ["spiceport-never-written"],
        }),
      ),
    ).toEqual([]);
  });

  it("streams shard by shard with no materialization", async () => {
    // "Fast path: stream shard by shard, no materialization (mirrors MvccSnapshotReader)."
    const m = twoSubjects();
    const reader = new ShardedGraphReader(m.seam, REVISION);

    const iterator = reader.reverseQueryRelationships(subjects)[Symbol.asyncIterator]();
    await iterator.next();
    expect(m.calls.map((c) => c.key)).toEqual([reverseKey("user", "alice")]);
  });
});

// --- reverse: sorted ------------------------------------------------------------------------

describe("ShardedGraphReader reverseQueryRelationships sorted", () => {
  /**
   * Subject ids chosen so ORDINAL and locale order disagree: 'Z' (U+005A) sorts BEFORE 'a'
   * (U+0061) ordinally, while `localeCompare` puts 'a' first. `ReverseQueryOptions.CompareBySubject`
   * is `string.CompareOrdinal`, so 'Z' must lead - and the shards are visited in the opposite
   * (first-seen) order, so a port that forgot to sort also fails here.
   */
  const subjects: SubjectsFilter = {
    subjectType: "user",
    optionalSubjectIds: ["a", "Z"],
  };

  function orderedMesh(): Mesh {
    return mesh({
      rows: {
        [reverseKey("user", "a")]: [
          wire("document:d2#viewer@user:a"),
          wire("document:d1#viewer@user:a"),
        ],
        [reverseKey("user", "Z")]: [wire("document:d3#viewer@user:Z")],
      },
    });
  }

  it("sorts the materialized rows by the ordinal BySubject total order", async () => {
    // `matches.Sort(ReverseQueryOptions.CompareBySubject)` - the RELATIONSHIP overload
    // (`compareRelationshipsBySubject`), subject-first, ordinal. Note `List<T>.Sort` is unstable
    // and `Array.prototype.sort` is stable; the six-tuple is unique so there are no ties.
    const m = orderedMesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);

    expect(
      await collect(reader.reverseQueryRelationships(subjects, { sort: "bySubject" })),
    ).toEqual([
      "document:d3#viewer@user:Z",
      "document:d1#viewer@user:a",
      "document:d2#viewer@user:a",
    ]);
    // Still one call per distinct id, in first-seen order - the sort is over the RESULT, not the ids.
    expect(m.calls.map((c) => c.key)).toEqual([reverseKey("user", "a"), reverseKey("user", "Z")]);
  });

  it("materializes every shard before yielding the first row", async () => {
    // The ordered path cannot stream: the sort needs all rows. This is the ONE place the reader
    // materializes, and only because it must.
    const m = orderedMesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);

    const ordered = reader.reverseQueryRelationships(subjects, { sort: "bySubject" });
    const iterator = ordered[Symbol.asyncIterator]();
    await iterator.next();
    expect(m.calls).toHaveLength(2);
  });

  it("applies the keyset skip EXCLUSIVELY, so the row equal to `after` is not re-seen", async () => {
    // `if (options.After is { } after && ReverseQueryOptions.CompareBySubject(rel.Reference, after) <= 0) continue;`
    // - the REFERENCE overload (`compareReferencesBySubject`), and `<= 0` continues, so resumption
    // sees only STRICTLY greater rows. ShardedReaderEquivalenceTests pins the same meaning for the
    // sequencer reader: "everything after row 0".
    const m = orderedMesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);

    expect(
      await collect(
        reader.reverseQueryRelationships(subjects, {
          sort: "bySubject",
          after: reference("document:d3#viewer@user:Z"),
        }),
      ),
    ).toEqual(["document:d1#viewer@user:a", "document:d2#viewer@user:a"]);
  });

  it("skips a keyset that lands between two rows, and nothing when it precedes them all", async () => {
    // A synthetic keyset strictly between two rows resumes at the later one - the shape
    // ShardedReaderEquivalenceTests builds with its `synthetic` reference.
    const m = orderedMesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);

    expect(
      await collect(
        reader.reverseQueryRelationships(subjects, {
          sort: "bySubject",
          after: reference("document:d1#viewer@user:a"),
        }),
      ),
    ).toEqual(["document:d2#viewer@user:a"]);

    const before = mesh({
      rows: {
        [reverseKey("user", "a")]: [wire("document:d1#viewer@user:a")],
        [reverseKey("user", "Z")]: [wire("document:d3#viewer@user:Z")],
      },
    });
    expect(
      await collect(
        new ShardedGraphReader(before.seam, REVISION).reverseQueryRelationships(subjects, {
          sort: "bySubject",
          // Ordinally before 'Z', so nothing is skipped.
          after: reference("document:d0#viewer@user:A"),
        }),
      ),
    ).toEqual(["document:d3#viewer@user:Z", "document:d1#viewer@user:a"]);
  });

  it("takes the sorted path with no skip when `after` is absent", async () => {
    // `options` present but `After` absent is still the SORTED path; the skip is guarded on
    // `options.After is { } after`, not on the sort.
    const m = orderedMesh();
    const reader = new ShardedGraphReader(m.seam, REVISION);
    expect(
      await collect(
        reader.reverseQueryRelationships(subjects, { sort: "bySubject", after: undefined }),
      ),
    ).toHaveLength(3);
  });
});

// --- cancellation ---------------------------------------------------------------------------

describe("ShardedGraphReader cancellation", () => {
  const filter: RelationshipsFilter = {
    optionalResourceType: "document",
    optionalResourceIds: ["a", "b"],
  };
  const subjects: SubjectsFilter = {
    subjectType: "user",
    optionalSubjectIds: ["alice", "bob"],
  };

  it("throws the signal's reason before the first shard call, on every path", async () => {
    // `ct.ThrowIfCancellationRequested()` at the TOP of each per-id loop, so an already-cancelled
    // read never reaches a grain.
    const reason = new Error("caller went away");
    const controller = new AbortController();
    controller.abort(reason);

    for (const build of [
      (r: ShardedGraphReader) => r.queryRelationships(filter, controller.signal),
      (r: ShardedGraphReader) =>
        r.reverseQueryRelationships(subjects, undefined, controller.signal),
      (r: ShardedGraphReader) =>
        r.reverseQueryRelationships(subjects, { sort: "bySubject" }, controller.signal),
    ]) {
      const m = mesh();
      const reader = new ShardedGraphReader(m.seam, REVISION);
      await expect(collect(build(reader))).rejects.toBe(reason);
      expect(m.calls).toHaveLength(0);
    }
  });

  it("checks again per ROW on the forward path", async () => {
    // The second `ThrowIfCancellationRequested` is inside `foreach (var row in reply.Rows)`, so a
    // cancellation arriving mid-shard stops before the next row. A single entry check would let
    // the whole shard drain.
    const m = mesh({
      rows: {
        [forwardKey("document", "a")]: [
          wire("document:a#viewer@user:alice"),
          wire("document:a#viewer@user:bob"),
        ],
      },
    });
    const reader = new ShardedGraphReader(m.seam, REVISION);
    const reason = new Error("stop");
    const controller = new AbortController();

    const iterator = reader.queryRelationships(filter, controller.signal)[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    // The abort landed between two rows of the SAME shard, so shard b was never contacted.
    expect(m.calls).toHaveLength(1);
  });

  it("checks again per ROW on the unsorted reverse path", async () => {
    const m = mesh({
      rows: {
        [reverseKey("user", "alice")]: [
          wire("document:a#viewer@user:alice"),
          wire("document:b#viewer@user:alice"),
        ],
      },
    });
    const reader = new ShardedGraphReader(m.seam, REVISION);
    const reason = new Error("stop");
    const controller = new AbortController();

    const unsorted = reader.reverseQueryRelationships(subjects, undefined, controller.signal);
    const iterator = unsorted[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    expect(m.calls).toHaveLength(1);
  });

  it("checks once more in the sorted YIELD loop, after every shard has answered", async () => {
    // The sixth site: `foreach (var rel in matches) { ct.ThrowIfCancellationRequested(); ... }`.
    // By then the materialize loop has finished, so the shard calls are all in - which is what
    // distinguishes this check from the per-id and per-row ones.
    const m = mesh({
      rows: {
        [reverseKey("user", "alice")]: [
          wire("document:a#viewer@user:alice"),
          wire("document:b#viewer@user:alice"),
        ],
        [reverseKey("user", "bob")]: [wire("document:c#viewer@user:bob")],
      },
    });
    const reader = new ShardedGraphReader(m.seam, REVISION);
    const reason = new Error("stop");
    const controller = new AbortController();

    const ordered = reader.reverseQueryRelationships(
      subjects,
      { sort: "bySubject" },
      controller.signal,
    );
    const iterator = ordered[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(formatRelationship(first.value as Relationship)).toBe("document:a#viewer@user:alice");
    expect(m.calls).toHaveLength(2);

    controller.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
  });

  it("forwards the signal to every shard call", async () => {
    // `shard.RowsAt(_revisionNanos, wireFilter, cancellationToken)` - the token travels, so a
    // cancelled read is also cancelled shard-side.
    const controller = new AbortController();
    const forward = mesh();
    await collect(
      new ShardedGraphReader(forward.seam, REVISION).queryRelationships(filter, controller.signal),
    );
    expect(forward.calls.map((c) => c.signal)).toEqual([controller.signal, controller.signal]);

    const reverse = mesh();
    await collect(
      new ShardedGraphReader(reverse.seam, REVISION).reverseQueryRelationships(
        subjects,
        undefined,
        controller.signal,
      ),
    );
    expect(reverse.calls.map((c) => c.signal)).toEqual([controller.signal, controller.signal]);
  });
});

// --- IGraphReaderSource ---------------------------------------------------------------------

describe("ShardedGraphReaderSource", () => {
  it("returns a reader SYNCHRONOUSLY, pinned at the revision's nanos", async () => {
    // `IGraphReader GraphReaderAt(IRevision revision)` returns the reader, NOT a Task: making it
    // async would change every call site in the reverse-ops path and IPermissionChecker.
    const m = mesh();
    const source = new ShardedGraphReaderSource(m.seam);

    const reader = source.graphReaderAt(new TimestampRevision(777n));
    expect(reader).not.toBeInstanceOf(Promise);
    expect(typeof reader.queryRelationships).toBe("function");

    await collect(
      reader.queryRelationships({ optionalResourceType: "document", optionalResourceIds: ["a"] }),
    );
    expect(m.calls[0]?.revision).toBe(777n);
    expect(m.calls[0]?.key).toBe(forwardKey("document", "a"));
  });

  it("mints a NEW reader per call", () => {
    // `return new ShardedGraphReader(_grainFactory, nanos);` - no caching, so two revisions can
    // never share a pin.
    const source = new ShardedGraphReaderSource(mesh().seam);
    const a = source.graphReaderAt(new TimestampRevision(1n));
    const b = source.graphReaderAt(new TimestampRevision(1n));
    expect(a).not.toBe(b);
  });

  it("rejects a revision that is not a timestamp revision, naming its type", () => {
    // The switch's default arm: `throw new InvalidRevisionException($"unsupported revision type:
    // {revision.GetType().Name}")` - a THIRD verbatim copy of the same throw in ISchemaSource.cs
    // and ISnapshotScanner.cs, kept as-is rather than extracted.
    class FakeRevision {
      toString(): string {
        return "fake";
      }
      equalsRevision(): boolean {
        return false;
      }
      compareTo(): number {
        return 0;
      }
    }
    const source = new ShardedGraphReaderSource(mesh().seam);
    expect(() => source.graphReaderAt(new FakeRevision() as unknown as IRevision)).toThrow(
      InvalidRevisionException,
    );
    expect(() => source.graphReaderAt(new FakeRevision() as unknown as IRevision)).toThrow(
      "unsupported revision type: FakeRevision",
    );
  });

  it("throws rather than returning a reader for a missing revision", () => {
    // GraphReaderAt does NOT null-check: the C# falls straight into the switch, where null reaches
    // the default arm and `revision.GetType()` raises NullReferenceException. The port reaches the
    // same place through the constructor-name lookup. The pin is that it THROWS - a missing
    // revision must never yield a reader pinned at nothing.
    const source = new ShardedGraphReaderSource(mesh().seam);
    expect(() => source.graphReaderAt(undefined as unknown as IRevision)).toThrow();
  });

  it("rejects a missing grain factory at construction", () => {
    // `ArgumentNullException.ThrowIfNull(grainFactory);` before the assignment.
    expect(
      () =>
        new ShardedGraphReaderSource(
          undefined as unknown as { getGrain<T>(d: GrainInterface<T>, k: never): T },
        ),
    ).toThrow(InvalidArgumentError);
  });
});
