import { changesAt, type DatastoreState } from "@spacedb/datastore/datastore-state";

import type { CounterDeltaWire, LogEvent } from "./log-event";
import type { RelationshipUpdateWire } from "./relationships-dtos";
import { toFullFilter, toWire } from "./wire-convert";

/**
 * Builds a {@link LogEvent} for a single committed revision from the in-memory `DatastoreState`,
 * reusing the existing per-revision diff logic (`changesAt` / `schemaChangedAt`) so the event-log
 * feed is byte-equivalent to the Watch changefeed. This is the SINGLE definition of "what changed
 * at revision R"; Watch and the graph shard grains' log-tail folds both consume the resulting
 * events.
 *
 * The Delete-vs-Touch collapse is deliberate: a committed event only ever carries the RESOLVED
 * operation, so a Create never appears in a logged event (`changesAt` already surfaces a
 * touch-over-existing as ONE touch, never a touch plus a delete).
 *
 * ORDER: the C#'s enumeration order is kept rather than sorted. `LogEventEquivalenceTests` compares
 * sorted canonical strings and so does not pin it, but the event's `relationshipChanges` order
 * feeds the folds and the Watch feed, where it IS observable.
 */
export function eventFromState(state: DatastoreState, revision: bigint): LogEvent {
  const relationshipChanges: RelationshipUpdateWire[] = changesAt(state, revision).map((u) => ({
    operation: u.operation === "delete" ? "delete" : "touch",
    relationship: toWire(u.relationship),
  }));

  // Bigint equality over the whole history. An ABSENT filter is the tombstone case and must stay
  // distinguishable from "no counter change at this revision" (which produces no delta at all).
  const counterChanges: CounterDeltaWire[] = state.counters
    .filter((c) => c.revision === revision)
    .map((c) => ({
      name: c.name,
      filter: c.filter === undefined ? undefined : toFullFilter(c.filter),
    }));

  // The schema written exactly at this revision (absent = no schema change). Carrying the full
  // version (revision + bytes + hash) makes the event self-contained: a fold can append the schema
  // version without re-reading the source state. There is at most one schema version per revision.
  //
  // `.FirstOrDefault()` on a reference type returns null, so this is `?? undefined`; with
  // `noUncheckedIndexedAccess` the index already yields `SchemaVersion | undefined`.
  const schema = state.schemas.filter((s) => s.revision === revision)[0];
  const schemaChange =
    schema === undefined
      ? undefined
      : { revision: schema.revision, bytes: schema.bytes, hash: schema.hash };

  return { revision, relationshipChanges, schemaChange, counterChanges, gcFloor: undefined };
}
