import { defineGrainInterface } from "@thresh/core/grain-interface";
import type { GrainWithStringKey } from "@thresh/core/key-kinds";

import type { FullRelationshipsFilterWire } from "./datastore-dtos";
import type { RelationshipWire } from "./relationships-dtos";

/**
 * The relationship rows of one graph shard visible at a requested revision.
 *
 * The C# reply is `[Immutable]` so a same-silo call hands out the snapshot BY REFERENCE without
 * copying - the property the graph-sharded design relies on for hot shards
 * (`docs/graph-sharded-datastore.md` section 4). That property SURVIVES the port for free: Thresh's
 * local dispatch path has no serialization or clone step, so a same-silo call already passes the
 * reply by reference and `[Immutable]` maps to nothing at all.
 *
 * The divergence runs the other way, and callers must respect it: Orleans deep-copies a
 * NON-immutable argument or reply on a local call and Thresh does not, so a caller that mutates
 * `rows` mutates the shard's own snapshot. The `readonly` array type is the whole guard.
 */
export interface GraphShardRowsReply {
  /** The visible rows. C# `ImmutableList<RelationshipWire>`. */
  readonly rows: readonly RelationshipWire[];
}

/**
 * A grain holding one adjacency slice of the graph - the versioned MVCC rows of a single
 * `GraphShardKeyWire`, folded from the datastore's event log restricted to that key. It is keyed by
 * the shard key's string form (see `graph-shard-grain-key.ts`) and serves point-in-time reads at
 * any revision its GC window still covers.
 */
export interface IGraphShardGrain extends GrainWithStringKey {
  /**
   * Returns the shard's rows VISIBLE at `revision` (half-open MVCC window `[created, deleted)`),
   * catching the shard up on demand until its watermark covers the revision - the closed-timestamp
   * gate, enforced per shard key. Visibility is filtered shard-side; EXPIRATION deliberately is NOT
   * - it is a query-time concern of the caller (the evaluation "now", a caller-clock concern),
   * mirroring `MvccSnapshotReader`, so the same shard reply serves callers with different clocks.
   * Throws `RevisionNotFoundException` when the revision has fallen below the shard's GC floor.
   *
   * `filter` is the subject-filter pushdown (scalability-program 3.2): undefined returns EVERY
   * visible row; a filter returns only the visible rows matching it, applied server-side over the
   * in-memory rows, so a point-membership read against a large userset returns O(matches) rows over
   * the wire instead of O(userset). Filtering is a strict restriction of the same visible row set -
   * callers keeping their own client-side `matches` re-check see identical results either way.
   */
  rowsAt(
    revision: bigint,
    filter: FullRelationshipsFilterWire | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<GraphShardRowsReply>;
}

/**
 * The runtime value for `IGraphShardGrain`.
 *
 * `rowsAt` is `[AlwaysInterleave]`, NOT `readOnly`: `readOnly` interleaves a blocking request only
 * when BOTH turns are read-only, so against a non-read-only fold or commit it does nothing, and
 * hot-shard readers would queue behind it. (The same lesson `IDatastoreLog.readFrom` records.)
 */
export const IGraphShardGrain = defineGrainInterface<IGraphShardGrain>("IGraphShardGrain", {
  options: { rowsAt: { alwaysInterleave: true } },
});
