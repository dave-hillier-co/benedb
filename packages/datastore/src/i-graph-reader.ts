import type { Relationship } from "@benedb/core/relationship";

import type { RelationshipsFilter, SubjectsFilter } from "./relationships-filter";
import type { ReverseQueryOptions } from "./reverse-query-options";

/**
 * The graph-shaped read seam the evaluation engines consume: forward reads keyed by resource,
 * reverse reads keyed by subject, at a fixed pinned revision.
 *
 * This is the narrow surface the graph-sharded datastore (`docs/graph-sharded-datastore.md`)
 * serves per key. `IDatastoreReader` extends it with the snapshot-wide reads (schema, counters,
 * validity).
 *
 * Port notes, settled once here because they propagate into every implementation:
 *
 * - `IAsyncEnumerable<Relationship>` becomes `AsyncIterable<Relationship>`, produced by an
 *   `async function*`. The iterable is returned SYNCHRONOUSLY and is lazy: nothing runs until it
 *   is iterated, and a consumer that stops early must not have paid for the rest.
 * - `IAsyncEnumerable` has NO Thresh equivalent ACROSS a grain boundary. In-process
 *   (`MvccSnapshotReader`, the reference datastore) it maps directly, which is what this
 *   interface describes. The sharded reader / graph-shard grain serve this same interface per
 *   key across grains, so that layer needs a paged/cursor protocol - decided there, at the grain
 *   seam, not by weakening this interface into something page-shaped that every in-process
 *   consumer then has to unwrap.
 * - `CancellationToken cancellationToken = default` becomes an optional `AbortSignal`. There is
 *   no ambient token: this is a plain interface, not a grain.
 */
export interface IGraphReader {
  /** Queries relationships from the resource side, matching the given filter. */
  queryRelationships(
    filter: RelationshipsFilter,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship>;

  /**
   * Queries relationships from the subject side, matching the given subject filter.
   *
   * @param subjectsFilter The subject-side filter to match.
   * @param options Optional ordering and keyset-resume controls. When `undefined` (the C# `null`
   * default) the query is unordered and unbounded - the original behaviour. A `bySubject` sort
   * yields a deterministic total order that `ReverseQueryOptions.after` can resume after.
   * @param signal A cancellation signal.
   */
  reverseQueryRelationships(
    subjectsFilter: SubjectsFilter,
    options?: ReverseQueryOptions | undefined,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship>;
}
