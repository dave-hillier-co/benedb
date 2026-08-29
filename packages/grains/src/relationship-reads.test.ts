import { FormatError } from "@spacedb/core/format-error";
import type { IRevision } from "@spacedb/core/i-revision";
import type { IRevisionParser } from "@spacedb/core/i-revision-parser";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { Relationship } from "@spacedb/core/relationship";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { formatRelationship, parseRelationship } from "@spacedb/core/tuple-strings";
import { zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import type { RegisteredCounter } from "@spacedb/datastore/counters";
import type {
  IDatastore,
  IDatastoreReader,
  RevisionWithSchemaHash,
} from "@spacedb/datastore/i-datastore";
import type { RelationshipsFilter } from "@spacedb/datastore/relationships-filter";
import { describe, expect, it } from "vitest";

import { encodeBulkExportCursor } from "./bulk-export-cursor";
import { MutableSchemaProvider } from "./i-schema-provider";
import type { ISnapshotScanner } from "./i-snapshot-scanner";
import { RelationshipReads } from "./relationship-reads";
import type {
  BulkExportRelationshipsArgs,
  ReadRelationshipsArgs,
  RelationshipsFilterWire,
  RelationshipStreamItem,
} from "./relationships-dtos";
import { toRelationship } from "./wire-convert";

/**
 * No covering C# test that can RUN yet: every Spiceport consumer of `Grains/RelationshipReads.cs`
 * reaches it through a `MeshTestCluster`, and the grain implementations behind that cluster are a
 * later slice. This is therefore a CHARACTERIZATION of the file, derived line by line from the C#.
 *
 * The five things that are wire-visible and easiest to lose in translation:
 *
 *   1. ORDINAL comparison, twice per method. `string.CompareOrdinal(tuple, a) <= 0` is the skip and
 *      `matched.Sort((x, y) => string.CompareOrdinal(x.Tuple, y.Tuple))` is the order. In
 *      TypeScript that is bare `<`/`>` on strings (UTF-16 code units); `localeCompare` reorders
 *      case and accents and would break every client cursor.
 *   2. The skip is EXCLUSIVE and happens WHILE STREAMING (`continue` inside the `await foreach`),
 *      the sort happens AFTER collecting. Sorting first, or filtering after, is observably
 *      different only in memory - but the `<= 0` boundary is observable in the results.
 *   3. `ReadRelationships` mints ONE token before the scan and stamps the SAME token on every item;
 *      its per-item cursor is the BARE canonical tuple. `BulkExportRelationships` mints NO token at
 *      all and its per-item cursor is `BulkExportCursor.Encode(pinned, tuple)`.
 *   4. Revision resolution differs. Read ALWAYS resolves. BulkExport tries the cursor FIRST and
 *      resolves only when the decode returns false - so a decoding cursor pins its own revision and
 *      `args.Consistency` is ignored entirely. `TryDecode` returns false ONLY for a null/empty
 *      cursor; a malformed one THROWS `FormatException` (see `BulkExportCursor.TryDecode`), so
 *      that does NOT fall back to a fresh revision.
 *   5. `ToFilter` builds the subject selector list only when SubjectType, SubjectIds or
 *      SubjectRelation is non-empty; otherwise `selectors` stays NULL, not `[]`. The C#
 *      `{ Length: > 0 }` pattern means non-null AND non-empty, so an EMPTY STRING takes the null
 *      branch - which is what a proto-default subject_type arrives as.
 */

const SCHEMA_TEXT = "definition user {}\n\ndefinition document {\n  relation viewer: user\n}";

const REVISION = new TimestampRevision(1_700_000_000_000_000_000n);
const CURSOR_REVISION = new TimestampRevision(1_600_000_000_000_000_000n);
const DATASTORE_ID = "ds-unique-id";

/** A datastore stub: only the four members `RevisionResolver` + `MintToken` actually touch. */
interface FakeDatastore {
  readonly datastore: IDatastore;
  /** Every method name, in call order - `PinRevision`/`MintToken` ordering is assertable. */
  readonly calls: string[];
}

function fakeDatastore(
  options: {
    readonly optimized?: RevisionWithSchemaHash | undefined;
    readonly head?: RevisionWithSchemaHash | undefined;
  } = {},
): FakeDatastore {
  const calls: string[] = [];
  const optimized = options.optimized ?? { revision: REVISION, schemaHash: undefined };
  const head = options.head ?? { revision: REVISION, schemaHash: undefined };
  const datastore = {
    snapshotReader(): IDatastoreReader {
      throw new Error("not used");
    },
    headRevision(): Promise<RevisionWithSchemaHash> {
      calls.push("headRevision");
      return Promise.resolve(head);
    },
    optimizedRevision(): Promise<RevisionWithSchemaHash> {
      calls.push("optimizedRevision");
      return Promise.resolve(optimized);
    },
    readWriteTx(): Promise<IRevision> {
      throw new Error("not used");
    },
    checkRevision(): Promise<boolean> {
      return Promise.resolve(true);
    },
    watch(): AsyncIterable<never> {
      throw new Error("not used");
    },
    getUniqueId(): Promise<string> {
      calls.push("getUniqueId");
      return Promise.resolve(DATASTORE_ID);
    },
    getRevisionParser(): Promise<IRevisionParser> {
      calls.push("getRevisionParser");
      return Promise.resolve({
        datastoreUniqueId: DATASTORE_ID,
        parse: (value: string) => new TimestampRevision(BigInt(value)),
      } as unknown as IRevisionParser);
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  return { datastore: datastore as unknown as IDatastore, calls };
}

/** One recorded `ISnapshotScanner.scan` call. */
interface ScanCall {
  readonly filter: RelationshipsFilter;
  readonly revision: IRevision;
  readonly signal: AbortSignal | undefined;
}

interface FakeScanner {
  readonly scanner: ISnapshotScanner;
  readonly calls: ScanCall[];
}

function fakeScanner(rows: readonly Relationship[]): FakeScanner {
  const calls: ScanCall[] = [];
  const scanner = {
    async *scan(
      filter: RelationshipsFilter,
      revision: IRevision,
      signal?: AbortSignal | undefined,
    ): AsyncGenerator<Relationship> {
      calls.push({ filter, revision, signal });
      for (const row of rows) yield row;
    },
    countRelationships(): Promise<bigint> {
      throw new Error("not used");
    },
    readCounterFilter(): Promise<RelationshipsFilter | undefined> {
      throw new Error("not used");
    },
    lookupCounters(): AsyncIterable<RegisteredCounter> {
      throw new Error("not used");
    },
  };
  return { scanner: scanner as unknown as ISnapshotScanner, calls };
}

function rel(tuple: string): Relationship {
  return parseRelationship(tuple);
}

async function drain(
  stream: AsyncIterable<RelationshipStreamItem>,
): Promise<RelationshipStreamItem[]> {
  const items: RelationshipStreamItem[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

/** The canonical tuple of each item, rebuilt from the WIRE payload the stream actually carries. */
function tuplesOf(items: readonly RelationshipStreamItem[]): string[] {
  return items.map((i) => formatRelationship(toRelationship(i.relationship)));
}

const EMPTY_FILTER: RelationshipsFilterWire = {};

function readArgs(overrides: Partial<ReadRelationshipsArgs> = {}): ReadRelationshipsArgs {
  return { filter: EMPTY_FILTER, ...overrides };
}

function exportArgs(
  overrides: Partial<BulkExportRelationshipsArgs> = {},
): BulkExportRelationshipsArgs {
  return { filter: EMPTY_FILTER, limit: 100, ...overrides };
}

function make(
  rows: readonly Relationship[],
  options: {
    readonly optimized?: RevisionWithSchemaHash | undefined;
    readonly schemaText?: string;
  } = {},
): {
  readonly reads: RelationshipReads;
  readonly store: FakeDatastore;
  readonly scan: FakeScanner;
  readonly provider: MutableSchemaProvider;
} {
  const store = fakeDatastore({ optimized: options.optimized });
  const scan = fakeScanner(rows);
  const provider = new MutableSchemaProvider(options.schemaText ?? SCHEMA_TEXT);
  return {
    reads: new RelationshipReads(store.datastore, provider, scan.scanner),
    store,
    scan,
    provider,
  };
}

// The three tuples below are deliberately NOT in canonical order in the scanner, and the two
// case-differing ids pin ORDINAL vs culture-aware ordering: ordinal puts every uppercase ASCII
// letter before every lowercase one ("Z" < "a"), while `localeCompare` interleaves them.
const OUT_OF_ORDER: readonly Relationship[] = [
  rel("document:doc2#viewer@user:alice"),
  rel("document:doc1#viewer@user:Zoe"),
  rel("document:doc1#viewer@user:alice"),
];

describe("RelationshipReads.readRelationships", () => {
  it("sorts the scanner's rows by canonical tuple with ORDINAL ordering", async () => {
    // `matched.Sort((x, y) => string.CompareOrdinal(x.Tuple, y.Tuple));` - the scanner
    // deliberately yields unsorted, since `ISnapshotScanner.Scan` guarantees no order.
    const { reads } = make(OUT_OF_ORDER);
    const items = await drain(reads.readRelationships(readArgs()));

    expect(tuplesOf(items)).toEqual([
      // "Z" (U+005A) sorts BEFORE "a" (U+0061) under CompareOrdinal. `localeCompare` would put
      // "alice" first and is therefore wrong here.
      "document:doc1#viewer@user:Zoe",
      "document:doc1#viewer@user:alice",
      "document:doc2#viewer@user:alice",
    ]);
    expect(items.map((i) => i.resumeCursor)).toEqual(tuplesOf(items));
  });

  it("skips tuples AT or before the cursor (exclusive resume)", async () => {
    // `if (after is { } a && string.CompareOrdinal(tuple, a) <= 0) continue;` - `<= 0`, so the
    // cursor tuple itself is NOT re-emitted.
    const { reads } = make(OUT_OF_ORDER);
    const items = await drain(
      reads.readRelationships(readArgs({ cursor: "document:doc1#viewer@user:alice" })),
    );

    expect(tuplesOf(items)).toEqual(["document:doc2#viewer@user:alice"]);
  });

  it("emits nothing when the cursor is at or past the last tuple", async () => {
    const { reads } = make(OUT_OF_ORDER);
    const items = await drain(
      reads.readRelationships(readArgs({ cursor: "document:doc2#viewer@user:alice" })),
    );
    expect(items).toEqual([]);
  });

  it("treats an EMPTY cursor as a real cursor, not as absent", async () => {
    // The C# tests `after is { } a` - a null check, not `IsNullOrEmpty`. An empty string is a
    // present cursor, and every non-empty tuple compares GREATER than it, so nothing is skipped.
    const { reads } = make(OUT_OF_ORDER);
    const items = await drain(reads.readRelationships(readArgs({ cursor: "" })));
    expect(items).toHaveLength(3);
  });

  it("yields nothing for an empty scan", async () => {
    const { reads } = make([]);
    expect(await drain(reads.readRelationships(readArgs()))).toEqual([]);
  });

  it("stamps the SAME token on every item, minted once BEFORE the scan", async () => {
    // `var token = await MintToken(...)` sits above the `await foreach`, and every item gets it.
    const { reads, store } = make(OUT_OF_ORDER);
    const items = await drain(reads.readRelationships(readArgs()));

    const expected = zedTokenFromRevision(
      REVISION,
      new MutableSchemaProvider(SCHEMA_TEXT).current.schemaHash,
      DATASTORE_ID,
    ).token;
    expect(new Set(items.map((i) => i.readAtToken))).toEqual(new Set([expected]));
    // One `GetUniqueId` for the whole stream, not one per row.
    expect(store.calls.filter((c) => c === "getUniqueId")).toHaveLength(1);
  });

  it("falls back to the AMBIENT schema hash when the resolved revision pins none", async () => {
    // `resolved.SchemaHash ?? schemaProvider.Current.SchemaHash` - unlike `ReverseOpsSupport.PinRevision`,
    // which passes `resolved.SchemaHash` through UNCHANGED (nullable).
    const { reads, provider } = make([rel("document:doc1#viewer@user:alice")], {
      optimized: { revision: REVISION, schemaHash: undefined },
    });
    const [item] = await drain(reads.readRelationships(readArgs()));

    expect(item?.readAtToken).toBe(
      zedTokenFromRevision(REVISION, provider.current.schemaHash, DATASTORE_ID).token,
    );
  });

  it("prefers the RESOLVED schema hash over the ambient one", async () => {
    const { reads } = make([rel("document:doc1#viewer@user:alice")], {
      optimized: { revision: REVISION, schemaHash: "pinned-hash" },
    });
    const [item] = await drain(reads.readRelationships(readArgs()));

    expect(item?.readAtToken).toBe(
      zedTokenFromRevision(REVISION, "pinned-hash", DATASTORE_ID).token,
    );
  });

  it("ALWAYS resolves a revision, defaulting absent consistency to minimize-latency", async () => {
    // `(args.Consistency ?? ConsistencyWire.MinimizeLatency).ToRequirement()` - minimize-latency
    // resolves via `OptimizedRevision`, never `HeadRevision`.
    const { reads, store, scan } = make(OUT_OF_ORDER);
    await drain(reads.readRelationships(readArgs()));

    expect(store.calls).toContain("optimizedRevision");
    expect(store.calls).not.toContain("headRevision");
    expect(scan.calls[0]?.revision).toBe(REVISION);
  });

  it("honours an explicit fully-consistent requirement", async () => {
    const { reads, store } = make(OUT_OF_ORDER);
    await drain(reads.readRelationships(readArgs({ consistency: { mode: "fullyConsistent" } })));

    expect(store.calls).toContain("headRevision");
    expect(store.calls).not.toContain("optimizedRevision");
  });

  it("scans exactly ONCE at the resolved revision", async () => {
    const { reads, scan } = make(OUT_OF_ORDER);
    await drain(reads.readRelationships(readArgs()));
    expect(scan.calls).toHaveLength(1);
  });
});

describe("RelationshipReads.bulkExportRelationships", () => {
  it("mints NO token: every item's readAtToken is absent", async () => {
    // The two-argument `new RelationshipStreamItem(ToWire(rel), BulkExportCursor.Encode(...))`
    // leaves the C# default-parameter token unset. `MintToken` is never called on this path.
    const { reads, store } = make(OUT_OF_ORDER);
    const items = await drain(reads.bulkExportRelationships(exportArgs()));

    expect(items.every((i) => i.readAtToken === undefined)).toBe(true);
    expect(store.calls).not.toContain("getUniqueId");
  });

  it("carries a revision-pinning cursor per item, not the bare tuple", async () => {
    const { reads } = make(OUT_OF_ORDER);
    const items = await drain(reads.bulkExportRelationships(exportArgs()));

    expect(items.map((i) => i.resumeCursor)).toEqual(
      tuplesOf(items).map((t) => encodeBulkExportCursor(REVISION, t)),
    );
  });

  it("sorts with the same ORDINAL comparator as the read path", async () => {
    const { reads } = make(OUT_OF_ORDER);
    const items = await drain(reads.bulkExportRelationships(exportArgs()));

    expect(tuplesOf(items)).toEqual([
      "document:doc1#viewer@user:Zoe",
      "document:doc1#viewer@user:alice",
      "document:doc2#viewer@user:alice",
    ]);
  });

  it("pins the revision the CURSOR encodes and ignores args.consistency entirely", async () => {
    // `if (BulkExportCursor.TryDecode(args.Cursor, out var decoded))` runs FIRST; the else-branch
    // resolver is never reached. That is what makes a reconnect read the same snapshot.
    const { reads, store, scan } = make(OUT_OF_ORDER);
    const cursor = encodeBulkExportCursor(CURSOR_REVISION, "document:doc1#viewer@user:alice");

    const items = await drain(
      reads.bulkExportRelationships(
        exportArgs({ cursor, consistency: { mode: "fullyConsistent" } }),
      ),
    );

    expect(scan.calls[0]?.revision.toString()).toBe(CURSOR_REVISION.toString());
    expect(store.calls).not.toContain("headRevision");
    expect(store.calls).not.toContain("optimizedRevision");
    // ...and the cursor's tuple is skipped exclusively, exactly as in the read path.
    expect(tuplesOf(items)).toEqual(["document:doc2#viewer@user:alice"]);
    // Every emitted cursor re-pins the CURSOR's revision, not a fresh one.
    expect(items[0]?.resumeCursor).toBe(
      encodeBulkExportCursor(CURSOR_REVISION, "document:doc2#viewer@user:alice"),
    );
  });

  it("falls back to a FRESH revision with no `after` when the cursor is absent", async () => {
    const { reads, store, scan } = make(OUT_OF_ORDER);
    await drain(reads.bulkExportRelationships(exportArgs()));

    expect(store.calls).toContain("optimizedRevision");
    expect(scan.calls[0]?.revision).toBe(REVISION);
  });

  it("treats an EMPTY cursor as absent (a first page), not as malformed", async () => {
    // `string.IsNullOrEmpty(cursor)` -> `TryDecode` returns false, so the resolver runs.
    const { reads, store } = make(OUT_OF_ORDER);
    const items = await drain(reads.bulkExportRelationships(exportArgs({ cursor: "" })));

    expect(store.calls).toContain("optimizedRevision");
    expect(items).toHaveLength(3);
  });

  it("THROWS on a malformed cursor rather than falling back to a fresh revision", async () => {
    // `TryDecode` throws `FormatException("invalid bulk export cursor")` for a malformed NON-EMPTY
    // cursor; only null/empty returns false. Swallowing this would silently restart a paged export
    // from the beginning at a different snapshot.
    const { reads, store } = make(OUT_OF_ORDER);
    await expect(
      drain(reads.bulkExportRelationships(exportArgs({ cursor: "!!!not base64!!!" }))),
    ).rejects.toThrow(FormatError);
    expect(store.calls).not.toContain("optimizedRevision");
  });
});

describe("RelationshipReads filter translation (`ToFilter`)", () => {
  async function filterFor(wire: RelationshipsFilterWire): Promise<RelationshipsFilter> {
    const { reads, scan } = make([]);
    await drain(reads.readRelationships(readArgs({ filter: wire })));
    return scan.calls[0]?.filter as RelationshipsFilter;
  }

  it("copies the four resource constraints straight across", async () => {
    const filter = await filterFor({
      resourceType: "document",
      resourceIds: ["doc1", "doc2"],
      resourceIdPrefix: "doc",
      resourceRelation: "viewer",
    });

    expect(filter.optionalResourceType).toBe("document");
    expect(filter.optionalResourceIds).toEqual(["doc1", "doc2"]);
    expect(filter.optionalResourceIdPrefix).toBe("doc");
    expect(filter.optionalResourceRelation).toBe("viewer");
  });

  it("leaves the selector list ABSENT (never empty) when no subject field is set", async () => {
    // `IReadOnlyList<SubjectsSelector>? selectors = null;` and the `if` never fires. An EMPTY list
    // is a different filter: `RelationshipsFilter.Matches` treats absent as "no constraint".
    const filter = await filterFor({ resourceType: "document" });
    expect(filter.optionalSubjectsSelectors).toBeUndefined();
  });

  it("treats an EMPTY subject type / relation as ABSENT for the guard", async () => {
    // `{ Length: > 0 }` is non-null AND non-empty, so "" takes the null branch. A proto-default
    // string field arrives as "" and must not manufacture a selector.
    const filter = await filterFor({ subjectType: "", subjectRelation: "" });
    expect(filter.optionalSubjectsSelectors).toBeUndefined();
  });

  it("treats an EMPTY subject id LIST as absent for the guard", async () => {
    // `{ Count: > 0 }` on the id list, same rule.
    const filter = await filterFor({ subjectIds: [] });
    expect(filter.optionalSubjectsSelectors).toBeUndefined();
  });

  it("builds ONE selector when only the subject type is set", async () => {
    const filter = await filterFor({ subjectType: "user" });

    expect(filter.optionalSubjectsSelectors).toHaveLength(1);
    const [selector] = filter.optionalSubjectsSelectors ?? [];
    expect(selector?.optionalSubjectType).toBe("user");
    // `wire.SubjectIds` is passed through even when absent.
    expect(selector?.optionalSubjectIds).toBeUndefined();
    // `relFilter` is null unless SubjectRelation is non-empty.
    expect(selector?.relationFilter).toBeUndefined();
  });

  it("builds a selector from the subject id list ALONE, carrying the absent type through", async () => {
    const filter = await filterFor({ subjectIds: ["alice"] });

    const [selector] = filter.optionalSubjectsSelectors ?? [];
    expect(selector?.optionalSubjectIds).toEqual(["alice"]);
    expect(selector?.optionalSubjectType).toBeUndefined();
  });

  it("builds a selector from the subject RELATION alone, with a non-ellipsis relation filter", async () => {
    // `new SubjectRelationFilter(NonEllipsisRelation: sr)` - and ONLY that member; the two
    // booleans keep their record defaults.
    const filter = await filterFor({ subjectRelation: "member" });

    const [selector] = filter.optionalSubjectsSelectors ?? [];
    expect(selector?.relationFilter?.nonEllipsisRelation).toBe("member");
    expect(selector?.relationFilter?.includeEllipsisRelation).toBeFalsy();
    expect(selector?.relationFilter?.onlyNonEllipsisRelations).toBeFalsy();
  });

  it("uses the identical translation on the bulk-export path", async () => {
    // Both methods call the SAME private `ToFilter`; one copy, so they cannot drift.
    const { reads, scan } = make([]);
    await drain(
      reads.bulkExportRelationships(
        exportArgs({ filter: { subjectType: "user", subjectRelation: "member" } }),
      ),
    );

    const [selector] = scan.calls[0]?.filter.optionalSubjectsSelectors ?? [];
    expect(selector?.optionalSubjectType).toBe("user");
    expect(selector?.relationFilter?.nonEllipsisRelation).toBe("member");
  });
});

describe("RelationshipReads guards and cancellation", () => {
  it("rejects absent args on both methods", async () => {
    // `ArgumentNullException.ThrowIfNull(args);` is the first statement of each iterator - and
    // because both are ITERATORS, the throw is deferred to the first move, not the call.
    const { reads } = make([]);
    const read = reads.readRelationships(undefined as unknown as ReadRelationshipsArgs);
    const exported = reads.bulkExportRelationships(
      undefined as unknown as BulkExportRelationshipsArgs,
    );

    await expect(drain(read)).rejects.toThrow(InvalidArgumentError);
    await expect(drain(exported)).rejects.toThrow(InvalidArgumentError);
  });

  it("does not touch the datastore until the stream is first moved", async () => {
    // Iterator semantics: the body runs on the first MoveNext, so nothing has been resolved yet.
    const { reads, store } = make(OUT_OF_ORDER);
    const stream = reads.readRelationships(readArgs());
    expect(store.calls).toEqual([]);

    await drain(stream);
    expect(store.calls.length).toBeGreaterThan(0);
  });

  it("throws at ENTRY when the signal is already aborted", async () => {
    // `cancellationToken.ThrowIfCancellationRequested();` immediately after the null guard, on
    // BOTH methods - before any revision resolution.
    const { reads, store } = make(OUT_OF_ORDER);
    const controller = new AbortController();
    controller.abort();

    await expect(drain(reads.readRelationships(readArgs(), controller.signal))).rejects.toThrow();
    await expect(
      drain(reads.bulkExportRelationships(exportArgs(), controller.signal)),
    ).rejects.toThrow();
    expect(store.calls).toEqual([]);
  });

  it("re-checks cancellation once per YIELDED row, aborting mid-stream", async () => {
    // `cancellationToken.ThrowIfCancellationRequested();` inside the final `foreach`, so a signal
    // raised after the first item stops the stream instead of draining it.
    const { reads } = make(OUT_OF_ORDER);
    const controller = new AbortController();

    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const item of reads.readRelationships(readArgs(), controller.signal)) {
          seen.push(item.resumeCursor);
          controller.abort();
        }
      })(),
    ).rejects.toThrow();

    expect(seen).toEqual(["document:doc1#viewer@user:Zoe"]);
  });

  it("re-checks cancellation once per yielded row on the export path too", async () => {
    const { reads } = make(OUT_OF_ORDER);
    const controller = new AbortController();

    let count = 0;
    await expect(
      (async () => {
        for await (const _ of reads.bulkExportRelationships(exportArgs(), controller.signal)) {
          void _;
          count += 1;
          controller.abort();
        }
      })(),
    ).rejects.toThrow();

    expect(count).toBe(1);
  });

  it("passes the caller's signal down to the scanner", async () => {
    const { reads, scan } = make(OUT_OF_ORDER);
    const controller = new AbortController();
    await drain(reads.readRelationships(readArgs(), controller.signal));
    expect(scan.calls[0]?.signal).toBe(controller.signal);
  });
});
