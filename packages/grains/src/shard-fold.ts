import type { StoredRelationshipWire } from "./datastore-dtos";
import type { GraphShardKeyWire } from "./graph-shard-key";
import { graphShardKeyMatches } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import type { LogEvent } from "./log-event";
import type { RelationshipWire } from "./relationships-dtos";
import { toRelationship, toWire } from "./wire-convert";

/**
 * The per-key restriction of `log-fold.ts`: folds the same committed {@link LogEvent} sequence, but
 * keeps only the relationship rows of one adjacency slice (a {@link GraphShardKeyWire}). The
 * sharding lemma - `fold(log) == merge over keys of fold(log|key)` - is what makes this a FILTER
 * rather than a re-derivation, and it is pinned by `shard-fold-lemma-tests.test.ts`: per key, a
 * shard's rows equal the whole fold's rows restricted to that key, and the union over all forward
 * (or all reverse) shards reproduces the whole live set at every readable revision.
 *
 * Within one event the staged apply/remove/commit semantics of `MvccReadWriteTransaction` are
 * mirrored exactly (repeated touches of one identity collapse to a single appended row; a
 * touch-then-delete leaves no new row), and GC events mirror
 * `packages/datastore/src/datastore-state.ts`'s `collectBelow` relationship rules exactly - that is
 * what makes the lemma an equality, not an approximation. Schema and counter changes are not shard
 * state and are ignored. A Create is treated identically to a Touch: the write path only ever logs
 * Touch/Delete (creates surface as Touch via `changesAt`), and the shard fold has no
 * create-conflict to enforce.
 */

/**
 * The storage identity of a row - the six-tuple mirroring `RelationshipKey`. Caveat and expiration
 * are payload, not identity.
 *
 * The C# is a `readonly record struct` used as a `HashSet`/`Dictionary` key, where record equality
 * answers the lookup. A JS `Map`/`Set` keys by REFERENCE, so this is a canonical string - and
 * LENGTH-PREFIXED, because relationship ids may contain any character at all, so a `/`-joined key
 * would not be injective.
 */
function rowIdentityOf(rel: RelationshipWire): string {
  return [
    rel.resourceType,
    rel.resourceId,
    rel.resourceRelation,
    rel.subjectType,
    rel.subjectId,
    rel.subjectRelation,
  ]
    .map((part) => `${part.length}:${part}`)
    .join("");
}

/**
 * Folds one committed {@link LogEvent} into the shard state for `key`. The watermark
 * (`appliedRevision`) advances to the event's revision even when nothing in the event matches the
 * key.
 */
export function shardFoldApplyEvent(
  state: GraphShardState,
  ev: LogEvent,
  key: GraphShardKeyWire,
): GraphShardState {
  // Never a truthiness test: 0n is a legal floor. See the same guard in `logFoldApplyEvent`.
  if (ev.gcFloor !== undefined) return applyGc(state, ev.revision, ev.gcFloor);

  let rows = state.rows;

  // Stage the event's matching updates with the same per-identity semantics as
  // `MvccReadWriteTransaction` (apply/remove), then commit them the same way, so within-event
  // sequences fold identically to the whole-state replay.
  const baseLive = new Set<string>();
  for (const row of rows) {
    if (row.deletedRevision === undefined) baseLive.add(rowIdentityOf(row.relationship));
  }

  const live = new Set<string>(baseLive);
  const deleted = new Set<string>();
  // `created` answers membership AND is projected back out to append rows, so the payload it names
  // is carried alongside in `payloads` rather than re-parsed out of the key.
  const created = new Set<string>();
  const payloads = new Map<string, RelationshipWire>();

  for (const update of ev.relationshipChanges) {
    if (!graphShardKeyMatches(key, update.relationship)) continue;

    // The whole fold stores the wire payload after a round trip through the core relationship
    // (which normalizes an empty subject relation to the ellipsis and an empty caveat name to
    // "no caveat"); apply the identical normalization so the restricted rows compare equal.
    const rel = toWire(toRelationship(update.relationship));
    const identity = rowIdentityOf(rel);

    if (update.operation === "delete") {
      if (!live.delete(identity)) continue;
      created.delete(identity);
      payloads.delete(identity);
      if (baseLive.has(identity)) deleted.add(identity);
    } else {
      // Touch and Create alike: create-or-replace the identity.
      if (!created.has(identity) && baseLive.has(identity)) deleted.add(identity);
      created.add(identity);
      live.add(identity);
      payloads.set(identity, rel);
    }
  }

  if (deleted.size > 0) {
    // The C# writes `builder[i] = row with { DeletedRevision = ev.Revision }` - a COPY into a
    // COPIED list. Here a new array holds a REPLACED element: the row objects are shared with
    // snapshot readers and must never be mutated in place (the same hazard `commit()` documents).
    const builder: StoredRelationshipWire[] = [...rows];
    for (let i = 0; i < builder.length; i++) {
      const row = builder[i] as StoredRelationshipWire;
      if (row.deletedRevision === undefined && deleted.has(rowIdentityOf(row.relationship)))
        builder[i] = { ...row, deletedRevision: ev.revision };
    }
    rows = builder;
  }

  // Rows are appended in `created`-set ITERATION ORDER. .NET's `HashSet` order is unspecified while
  // a JS `Set` is insertion-ordered; row order is observable through `IGraphShardGrain.rowsAt`, so
  // insertion order is kept as-is and no sort is added.
  for (const identity of created) {
    const rel = payloads.get(identity);
    if (rel !== undefined)
      rows = [
        ...rows,
        { relationship: rel, createdRevision: ev.revision, deletedRevision: undefined },
      ];
  }

  return { ...state, appliedRevision: ev.revision, rows };
}

/**
 * The rows of the shard visible at `revision` (half-open MVCC window `[created, deleted)`). Callers
 * must reject a revision below the shard's GC floor - see {@link shardFoldIsReadableAt}, mirroring
 * the `MvccSnapshotReader` constructor guard - because rows already collected below the floor would
 * be silently missing from the answer.
 *
 * The C# is a `yield return` `IEnumerable`, which is RE-ENUMERABLE; a TypeScript generator is
 * single-pass and would silently yield nothing on a second walk, so this returns an ARRAY.
 */
export function shardFoldVisibleAt(
  state: GraphShardState,
  revision: bigint,
): readonly RelationshipWire[] {
  const visible: RelationshipWire[] = [];
  for (const row of state.rows) {
    if (shardFoldIsVisibleAt(row, revision)) visible.push(row.relationship);
  }
  return visible;
}

/**
 * The per-row visibility predicate of {@link shardFoldVisibleAt} (half-open MVCC window
 * `[created, deleted)`), exposed so index-served reads apply the IDENTICAL predicate to their
 * candidate rows.
 */
export function shardFoldIsVisibleAt(row: StoredRelationshipWire, revision: bigint): boolean {
  return (
    row.createdRevision <= revision &&
    (row.deletedRevision === undefined || row.deletedRevision > revision)
  );
}

/** True if a read pinned at `revision` is still exact on this shard. */
export function shardFoldIsReadableAt(state: GraphShardState, revision: bigint): boolean {
  return revision >= state.gcFloor;
}

/**
 * Collects the shard's rows below `floor` and stamps the watermark to `revision` - the GC branch of
 * the fold, exposed for the thin sequencer's lazy row GC: stored rows are only compacted when next
 * dirtied and flushed, so every serve path re-applies the current floor through this function (a
 * floor at or below the shard's own is a pure relabel). Applying the LATEST floor once is
 * equivalent to applying every intermediate GC event's floor in sequence: a row is dropped iff it
 * is fully dead or expired at/below the final floor, which subsumes every lower floor's collection
 * (the same monotonicity `collectBelow` relies on).
 */
export function shardFoldCollectBelow(
  state: GraphShardState,
  revision: bigint,
  floor: bigint,
): GraphShardState {
  return applyGc(state, revision, floor);
}

// Mirrors `collectBelow`'s relationship rules exactly: drop a row when it is fully dead below the
// floor (`deletedRevision <= floor`) OR expired at/before the floor (the expiration sweep - see
// `collectBelow`'s remarks for why that cannot change any still-servable read). A floor that does
// not advance the shard's own floor is a no-op on the rows, but the watermark still advances,
// exactly as `logFoldApplyEvent` advances the head past a stale GC event.
//
// The C#'s `NanosSinceEpoch(exp) = (exp - UnixEpoch).Ticks * 100` VANISHES here: the port already
// stores the expiration as nanos-since-epoch `bigint`, so the comparison is against the floor
// directly - line for line with `collectBelow`'s own sweep.
function applyGc(state: GraphShardState, revision: bigint, floor: bigint): GraphShardState {
  // A spread of the (frozen) state, never an assignment into it.
  if (floor <= state.gcFloor) return { ...state, appliedRevision: revision };

  const kept = state.rows.filter((row) => {
    if (row.deletedRevision !== undefined && row.deletedRevision <= floor) return false;
    if (row.relationship.expiration !== undefined && row.relationship.expiration <= floor)
      return false;
    return true;
  });

  return { appliedRevision: revision, gcFloor: floor, rows: kept };
}
