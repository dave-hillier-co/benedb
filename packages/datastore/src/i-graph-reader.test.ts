import { describe, expect, expectTypeOf, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";

import type { IGraphReader } from "./i-graph-reader";
import {
  relationshipsFilterMatches,
  subjectsFilterMatches,
  type RelationshipsFilter,
  type SubjectsFilter,
} from "./relationships-filter";
import {
  compareReferencesBySubject,
  compareRelationshipsBySubject,
  type ReverseQueryOptions,
} from "./reverse-query-options";

// Port of Spiceport `IGraphReader.cs`. An interface with no test of its own in Spiceport, so
// this is a characterization test: it pins the SHAPE of the seam every datastore implementation
// and every engine consumer is typed against. The type-level assertions are the real gate (they
// fail `pnpm typecheck`); the runtime cases document the contract an implementation must honour,
// exercised through a minimal in-test reader.
//
// Decisions pinned here, once, because they propagate into every later file:
//
// 1. `IAsyncEnumerable<Relationship>` becomes `AsyncIterable<Relationship>`, produced by an
//    `async function*`. NOT `Promise<Relationship[]>`: the C# is lazy and streaming, and a
//    consumer that stops early must not have paid for the rest. The methods therefore return the
//    iterable SYNCHRONOUSLY - the returned value is not a promise and awaiting it is not part of
//    the protocol.
//
// 2. CRITICAL forward-looking constraint: `IAsyncEnumerable` has NO Thresh equivalent ACROSS a
//    grain boundary. In-process (MvccSnapshotReader, the reference datastore) it maps directly,
//    which is what this interface describes. S3's ShardedGraphReader / GraphShardGrain serve
//    this same interface per key ACROSS grains, so that layer needs a paged/cursor protocol -
//    decided there, at the grain seam, NOT by weakening this interface now into something
//    page-shaped that every in-process consumer then has to unwrap.
//
// 3. `CancellationToken cancellationToken = default` becomes an OPTIONAL `AbortSignal`. There is
//    no ambient token here: this is a plain interface, not a grain, so a caller that has one
//    passes it and a caller that does not omits the argument.
//
// 4. The `options` parameter on `reverseQueryRelationships` stays optional, and `undefined` -
//    never `null` - means unsorted and unbounded, which is the C# `null` default's meaning.
function rel(
  resourceType: string,
  resourceId: string,
  resourceRelation: string,
  subjectType: string,
  subjectId: string,
  subjectRelation: string = ELLIPSIS,
): Relationship {
  return createRelationship(
    { objectType: resourceType, objectId: resourceId, relation: resourceRelation },
    { objectType: subjectType, objectId: subjectId, relation: subjectRelation },
  );
}

/**
 * A minimal in-memory `IGraphReader` over a fixed set of relationships, standing in for
 * MvccSnapshotReader at a pinned revision. It exists to show what the seam obliges an
 * implementation to do, not to anticipate the reference datastore's storage.
 */
function readerOver(relationships: readonly Relationship[]): IGraphReader {
  return {
    async *queryRelationships(
      filter: RelationshipsFilter,
      signal?: AbortSignal,
    ): AsyncIterable<Relationship> {
      for (const candidate of relationships) {
        signal?.throwIfAborted();
        if (relationshipsFilterMatches(filter, candidate)) yield candidate;
      }
    },

    async *reverseQueryRelationships(
      subjectsFilter: SubjectsFilter,
      options?: ReverseQueryOptions | undefined,
      signal?: AbortSignal,
    ): AsyncIterable<Relationship> {
      const matched = relationships.filter((candidate) =>
        subjectsFilterMatches(subjectsFilter, candidate),
      );
      const ordered =
        options?.sort === "bySubject" ? [...matched].sort(compareRelationshipsBySubject) : matched;
      const after = options?.after;
      for (const candidate of ordered) {
        signal?.throwIfAborted();
        if (after !== undefined && compareReferencesBySubject(candidate.reference, after) <= 0) {
          continue;
        }
        yield candidate;
      }
    },
  };
}

async function collect(source: AsyncIterable<Relationship>): Promise<Relationship[]> {
  const collected: Relationship[] = [];
  for await (const item of source) collected.push(item);
  return collected;
}

const world = [
  rel("document", "doc1", "viewer", "user", "alice"),
  rel("document", "doc2", "viewer", "user", "alice"),
  rel("document", "doc3", "viewer", "user", "bob"),
  rel("folder", "f1", "editor", "group", "eng", "member"),
];

describe("IGraphReader shape", () => {
  it("declares both reads as AsyncIterable, not Promise of an array", () => {
    expectTypeOf<ReturnType<IGraphReader["queryRelationships"]>>().toEqualTypeOf<
      AsyncIterable<Relationship>
    >();
    expectTypeOf<ReturnType<IGraphReader["reverseQueryRelationships"]>>().toEqualTypeOf<
      AsyncIterable<Relationship>
    >();
  });

  it("takes the cancellation token as an optional AbortSignal", () => {
    expectTypeOf<Parameters<IGraphReader["queryRelationships"]>>().toEqualTypeOf<
      [filter: RelationshipsFilter, signal?: AbortSignal | undefined]
    >();
    expectTypeOf<Parameters<IGraphReader["reverseQueryRelationships"]>>().toEqualTypeOf<
      [
        subjectsFilter: SubjectsFilter,
        options?: ReverseQueryOptions | undefined,
        signal?: AbortSignal | undefined,
      ]
    >();
  });

  it("returns the iterable synchronously rather than a promise of one", () => {
    const reader = readerOver(world);

    const forward = reader.queryRelationships({ optionalResourceType: "document" });

    expect(Symbol.asyncIterator in forward).toBe(true);
    expect(typeof (forward as { then?: unknown }).then).toBe("undefined");
  });

  it("is lazy: no work happens until the stream is iterated", async () => {
    let started = false;
    const reader: IGraphReader = {
      async *queryRelationships(): AsyncIterable<Relationship> {
        started = true;
        yield* [];
      },
      async *reverseQueryRelationships(): AsyncIterable<Relationship> {
        yield* [];
      },
    };

    const stream = reader.queryRelationships({});
    expect(started).toBe(false);

    await collect(stream);
    expect(started).toBe(true);
  });
});

describe("queryRelationships", () => {
  it("reads from the resource side, yielding only filter matches", async () => {
    const reader = readerOver(world);

    const results = await collect(
      reader.queryRelationships({
        optionalResourceType: "document",
        optionalResourceIds: ["doc1"],
      }),
    );

    expect(results.map((r) => r.reference.resource.objectId)).toEqual(["doc1"]);
  });

  it("yields an empty stream, never an absent one, when nothing matches", async () => {
    const reader = readerOver(world);

    const results = await collect(reader.queryRelationships({ optionalResourceType: "nope" }));

    expect(results).toEqual([]);
  });

  it("places no constraint for an empty filter", async () => {
    const reader = readerOver(world);

    expect(await collect(reader.queryRelationships({}))).toHaveLength(world.length);
  });

  it("is callable without a signal", async () => {
    const reader = readerOver(world);

    await expect(collect(reader.queryRelationships({}))).resolves.toHaveLength(world.length);
  });

  it("aborts mid-stream when the supplied signal fires", async () => {
    const reader = readerOver(world);
    const controller = new AbortController();
    const seen: Relationship[] = [];

    await expect(async () => {
      for await (const item of reader.queryRelationships({}, controller.signal)) {
        seen.push(item);
        controller.abort();
      }
    }).rejects.toThrow();

    // The abort is observed at the next element, so exactly one was produced first.
    expect(seen).toHaveLength(1);
  });

  it("rejects immediately when handed an already-aborted signal", async () => {
    const reader = readerOver(world);

    await expect(collect(reader.queryRelationships({}, AbortSignal.abort()))).rejects.toThrow();
  });
});

describe("reverseQueryRelationships", () => {
  const subjects: SubjectsFilter = { subjectType: "user" };

  it("reads from the subject side, yielding only subject-filter matches", async () => {
    const reader = readerOver(world);

    const results = await collect(
      reader.reverseQueryRelationships({ subjectType: "user", optionalSubjectIds: ["alice"] }),
    );

    expect(results.map((r) => r.reference.resource.objectId)).toEqual(["doc1", "doc2"]);
  });

  it("treats omitted options as unsorted and unbounded, the C# null default", async () => {
    const reader = readerOver(world);

    const results = await collect(reader.reverseQueryRelationships(subjects));

    expect(results).toHaveLength(3);
  });

  it("treats an explicitly undefined options argument the same as an omitted one", async () => {
    // `undefined`, not `null`: the port uses `undefined` throughout for C# `null`.
    const reader = readerOver(world);

    const omitted = await collect(reader.reverseQueryRelationships(subjects));
    const explicit = await collect(reader.reverseQueryRelationships(subjects, undefined));

    expect(explicit).toEqual(omitted);
  });

  it("yields a deterministic total order under a bySubject sort", async () => {
    const shuffled = [world[2]!, world[1]!, world[0]!];
    const reader = readerOver(shuffled);

    const results = await collect(
      reader.reverseQueryRelationships(subjects, { sort: "bySubject" }),
    );

    expect(
      results.map((r) => `${r.reference.subject.objectId}/${r.reference.resource.objectId}`),
    ).toEqual(["alice/doc1", "alice/doc2", "bob/doc3"]);
  });

  it("resumes strictly after an `after` keyset position", async () => {
    const reader = readerOver(world);
    const page = await collect(reader.reverseQueryRelationships(subjects, { sort: "bySubject" }));

    const resumed = await collect(
      reader.reverseQueryRelationships(subjects, {
        sort: "bySubject",
        after: page[0]!.reference,
      }),
    );

    expect(resumed.map((r) => r.reference.resource.objectId)).toEqual(["doc2", "doc3"]);
  });

  it("takes the signal as the third argument, after options", async () => {
    const reader = readerOver(world);

    await expect(
      collect(reader.reverseQueryRelationships(subjects, undefined, AbortSignal.abort())),
    ).rejects.toThrow();
  });
});
