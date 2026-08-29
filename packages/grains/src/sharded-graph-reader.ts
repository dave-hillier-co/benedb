import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { Relationship } from "@spacedb/core/relationship";
import type { IGraphReader } from "@spacedb/datastore/i-graph-reader";
import {
  relationshipsFilterMatches,
  subjectsFilterMatches,
  type RelationshipsFilter,
  type SubjectsFilter,
} from "@spacedb/datastore/relationships-filter";
import {
  compareReferencesBySubject,
  compareRelationshipsBySubject,
  type ReverseQueryOptions,
} from "@spacedb/datastore/reverse-query-options";
import type { GrainRuntime } from "@thresh/core/grain-runtime";

import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { graphShardKeyForResource, graphShardKeyForSubject } from "./graph-shard-key";
import { IGraphShardGrain, type GraphShardRowsReply } from "./i-graph-shard-grain";
import { toFullFilter, toRelationship } from "./wire-convert";

/**
 * The port's stand-in for C# `NotSupportedException`: the operation is outside the seam's
 * deliberately narrow contract. TypeScript has no such built-in, and neither
 * `InvalidArgumentError` (which the API layer maps onto gRPC `InvalidArgument`) nor a bare
 * `Error` carries the same "caller bug, not a bad value" meaning, so this is its own class.
 *
 * A SECOND export from this module, against the house one-primary-export rule: it exists only to
 * name the two throws below, exactly as the C# names `NotSupportedException` inline, and moving it
 * to its own file would invent a shared vocabulary the C# does not have.
 */
export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}

/** The message both shape guards throw, verbatim from the C#, duplicated there and here. */
const SCAN_SHAPED_MESSAGE =
  "scan-shaped filter on the sharded graph reader; broad scans stay on the IDatastoreReader/snapshot path";

/** The `{ getGrain }` slice of Thresh's `GrainRuntime` standing in for `IGrainFactory`. */
export type GraphReaderGrainFactory = Pick<GrainRuntime, "getGrain">;

const NANOS_PER_MILLISECOND = 1_000_000n;

/**
 * `DateTimeOffset.UtcNow` as nanos since the epoch, matching `MvccSnapshotReader`'s own sampling
 * (millisecond resolution, so an expiration inside the current millisecond reads as not-yet
 * expired here where the C# might already have expired it - the only difference, and the two
 * readers agree with each other, which is the property that matters).
 */
function nowNanos(): bigint {
  return BigInt(Date.now()) * NANOS_PER_MILLISECOND;
}

/**
 * Mirrors `MvccSnapshotReader.IsExpired` exactly: an expiration AT OR BEFORE `now` excludes the
 * row. `<` instead of `<=` diverges on the boundary row.
 */
function isExpired(rel: Relationship, now: bigint): boolean {
  return rel.optionalExpiration !== undefined && rel.optionalExpiration <= now;
}

/**
 * An `IGraphReader` pinned at a revision that resolves each read to the matching
 * `IGraphShardGrain` - forward shards for resource-pinned queries, reverse shards for
 * subject-pinned queries - so no silo ever holds the whole graph
 * (`docs/graph-sharded-datastore.md` section 2/3).
 *
 * Deliberately NARROW: it serves only the two pinned call shapes the evaluation engines actually
 * produce (a `RelationshipsFilter` with explicit resource ids; a `SubjectsFilter` with explicit
 * subject ids) and throws `NotSupportedError` for anything scan-shaped - broad scans stay on the
 * `IDatastoreReader`/snapshot path (the design's scan seam), and the one no-subject-ids reverse
 * caller (`SchemaChangeValidator`) stays on `IDatastoreReader`. Shards filter VISIBILITY at the
 * pinned revision; EXPIRATION is filtered here at enumeration time ("now" captured once per
 * enumeration), and sorted reverse reads mirror `MvccSnapshotReader.reverseQueryRelationships`'s
 * ordered path exactly (same comparator, same exclusive keyset skip), so the two readers are
 * row-for-row interchangeable - the property the fold-equivalence gate asserts.
 *
 * Port notes:
 *   * Both methods are `async function*`, so - like a C# iterator method - the guards below do
 *     not run until the first pull. `ShardedReaderEquivalenceTests` relies on that: it observes
 *     the rejections by DRAINING the sequence.
 *   * `IAsyncEnumerable` never crosses the grain boundary; the DTOs are PAGES, so the reader is a
 *     generator over pages. Only the sorted reverse path materialises, and only because the sort
 *     requires it.
 *   * `CancellationToken` becomes an optional `AbortSignal`; `ct.ThrowIfCancellationRequested()`
 *     becomes `signal?.throwIfAborted()`, kept at all six C# sites.
 */
export class ShardedGraphReader implements IGraphReader {
  readonly #grainFactory: GraphReaderGrainFactory;
  readonly #revisionNanos: bigint;

  /** Creates a reader over the shard mesh, pinned at the given timestamp revision. */
  constructor(grainFactory: GraphReaderGrainFactory, revisionNanos: bigint) {
    // `ArgumentNullException.ThrowIfNull(grainFactory);`
    if (grainFactory === undefined || grainFactory === null) {
      throw new InvalidArgumentError("grainFactory is required");
    }
    this.#grainFactory = grainFactory;
    this.#revisionNanos = revisionNanos;
  }

  /** @inheritdoc */
  async *queryRelationships(
    filter: RelationshipsFilter,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship> {
    // `ArgumentNullException.ThrowIfNull(filter);`
    if (filter === undefined || filter === null) {
      throw new InvalidArgumentError("filter is required");
    }

    // The engine call-site inventory (design step 1) proves engines only produce pinned-resource
    // shapes; anything broader belongs on the snapshot path, not the shard mesh.
    const resourceIds = filter.optionalResourceIds;
    if (
      filter.optionalResourceType === undefined ||
      resourceIds === undefined ||
      resourceIds.length === 0 ||
      filter.optionalResourceIdPrefix !== undefined
    ) {
      throw new NotSupportedError(SCAN_SHAPED_MESSAGE);
    }
    const resourceType = filter.optionalResourceType;

    // 'now' is captured ONCE per enumeration, mirroring MvccSnapshotReader: every row of one read
    // sees the same expiration cutoff.
    const now = nowNanos();

    // Subject-filter pushdown (scalability-program 3.2): the whole filter travels to the shard so
    // matching happens server-side over the in-memory rows and the reply is O(matches), not
    // O(userset). The client-side expiry skip AND the client-side `relationshipsFilterMatches`
    // below deliberately STAY - cheap belt-and-braces that keeps the equivalence argument trivial
    // (the pushdown is a strict restriction, so with or without it the yielded rows are identical).
    const wireFilter = toFullFilter(filter);

    // `resourceIds.Distinct()` - first-seen order preserved, which a Set does.
    for (const id of new Set(resourceIds)) {
      signal?.throwIfAborted();
      const shard = this.#grainFactory.getGrain(
        IGraphShardGrain,
        graphShardGrainKeyBuild(graphShardKeyForResource(resourceType, id)),
      );
      const reply = await shard.rowsAt(this.#revisionNanos, wireFilter, signal);

      for (const row of reply.rows) {
        signal?.throwIfAborted();
        const rel = toRelationship(row);
        if (isExpired(rel, now)) continue;
        if (relationshipsFilterMatches(filter, rel)) yield rel;
      }
    }
  }

  /** @inheritdoc */
  async *reverseQueryRelationships(
    subjectsFilter: SubjectsFilter,
    options?: ReverseQueryOptions | undefined,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship> {
    // `ArgumentNullException.ThrowIfNull(subjectsFilter);`
    if (subjectsFilter === undefined || subjectsFilter === null) {
      throw new InvalidArgumentError("subjectsFilter is required");
    }

    // The only no-subject-ids caller is SchemaChangeValidator, which stays on IDatastoreReader.
    const subjectIds = subjectsFilter.optionalSubjectIds;
    if (subjectIds === undefined || subjectIds.length === 0) {
      throw new NotSupportedError(SCAN_SHAPED_MESSAGE);
    }

    const now = nowNanos();

    // `options is null || options.Sort == ReverseQuerySort.Unsorted`. The C# record parameter is
    // required where the port's `sort` is optional, and `MvccSnapshotReader` reads an absent sort
    // as unsorted - the two readers must agree, so this reads it the same way.
    if (options === undefined || options.sort === undefined || options.sort === "unsorted") {
      // Fast path: stream shard by shard, no materialization (mirrors MvccSnapshotReader).
      for (const id of new Set(subjectIds)) {
        signal?.throwIfAborted();
        const reply = await this.#rowsOfSubject(subjectsFilter.subjectType, id, signal);
        for (const row of reply.rows) {
          signal?.throwIfAborted();
          const rel = toRelationship(row);
          if (isExpired(rel, now)) continue;
          if (subjectsFilterMatches(subjectsFilter, rel)) yield rel;
        }
      }
      return;
    }

    // Ordered path - mirrors MvccSnapshotReader.reverseQueryRelationships exactly: materialize the
    // matching rows, sort by the BySubject total order, then apply the exclusive keyset so
    // resumption sees only strictly-greater rows (the six-tuple is unique, so there are no ties;
    // `List<T>.Sort` is unstable and `Array.prototype.sort` is stable, and with no ties that
    // difference is unobservable).
    const matches: Relationship[] = [];
    for (const id of new Set(subjectIds)) {
      signal?.throwIfAborted();
      const reply = await this.#rowsOfSubject(subjectsFilter.subjectType, id, signal);
      for (const row of reply.rows) {
        signal?.throwIfAborted();
        const rel = toRelationship(row);
        if (isExpired(rel, now)) continue;
        if (subjectsFilterMatches(subjectsFilter, rel)) matches.push(rel);
      }
    }

    // The RELATIONSHIP overload of `ReverseQueryOptions.CompareBySubject`.
    matches.sort(compareRelationshipsBySubject);

    for (const rel of matches) {
      signal?.throwIfAborted();
      const after = options.after;
      // The REFERENCE overload; `<= 0` continues, so the skip is EXCLUSIVE.
      if (after !== undefined && compareReferencesBySubject(rel.reference, after) <= 0) continue;
      yield rel;
    }
  }

  #rowsOfSubject(
    subjectType: string,
    subjectId: string,
    signal: AbortSignal | undefined,
  ): Promise<GraphShardRowsReply> {
    const shard = this.#grainFactory.getGrain(
      IGraphShardGrain,
      graphShardGrainKeyBuild(graphShardKeyForSubject(subjectType, subjectId)),
    );
    // No pushdown on the reverse path: reverse shards are already subject-narrow (the shard key IS
    // the subject), so there is no measured payload to shrink; undefined = every visible row.
    return shard.rowsAt(this.#revisionNanos, undefined, signal);
  }
}
