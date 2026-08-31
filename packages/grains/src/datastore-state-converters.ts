import type {
  CounterVersion,
  DatastoreState,
  SchemaVersion,
  StoredRelationship,
} from "@benedb/datastore/datastore-state";

import type {
  CounterVersionWire,
  SchemaVersionWire,
  StoredRelationshipWire,
} from "./datastore-dtos";
import type { DatastoreGrainState } from "./datastore-grain-state";
import { toCoreFilter, toFullFilter, toRelationship, toWire } from "./wire-convert";

/**
 * Converts between the serializable {@link DatastoreGrainState} (read from / written to the
 * singleton datastore grain) and the in-memory MVCC `DatastoreState` (whose fold, transaction and
 * reader mechanics the grain-backed datastore reuses). Relationship payload and counter-filter
 * conversions delegate to `wire-convert.ts` so there is exactly ONE copy of that logic.
 *
 * The two directions must be EXACT INVERSES: `DatastoreGcFoldTests` uses
 * `toGrainState(collectBelow(toMemoryState(state), floor))` as the independent reference the fold
 * is compared against, so any asymmetry - a dropped `gcFloor`, a reordered list - makes that gate
 * pass vacuously or fail spuriously.
 *
 * `ImmutableList.Select(...).ToImmutableList()` becomes `.map(...)`, producing a FRESH readonly
 * array; ORDER IS PRESERVED, because the schema and counter histories are write-ordered and
 * `datastoreGrainStateSchemaVersionAt` breaks on the first row above the revision.
 */

/** Grain wire state to in-memory MVCC state. */
export function toMemoryState(g: DatastoreGrainState): DatastoreState {
  return {
    headRevision: g.headRevision,
    relationships: g.relationships.map(toMemoryRow),
    schemas: g.schemas.map(toMemorySchema),
    counters: g.counters.map(toMemoryCounter),
    gcFloor: g.gcFloor,
  };
}

/** In-memory MVCC state to grain wire state (for the CAS payload). */
export function toGrainState(s: DatastoreState): DatastoreGrainState {
  return {
    headRevision: s.headRevision,
    relationships: s.relationships.map(toWireRow),
    schemas: s.schemas.map(toWireSchema),
    counters: s.counters.map(toWireCounter),
    gcFloor: s.gcFloor,
  };
}

function toMemoryRow(w: StoredRelationshipWire): StoredRelationship {
  return {
    relationship: toRelationship(w.relationship),
    createdRevision: w.createdRevision,
    deletedRevision: w.deletedRevision,
  };
}

function toWireRow(r: StoredRelationship): StoredRelationshipWire {
  return {
    relationship: toWire(r.relationship),
    createdRevision: r.createdRevision,
    deletedRevision: r.deletedRevision,
  };
}

function toMemorySchema(w: SchemaVersionWire): SchemaVersion {
  return { revision: w.revision, bytes: w.bytes, hash: w.hash };
}

function toWireSchema(v: SchemaVersion): SchemaVersionWire {
  return { revision: v.revision, bytes: v.bytes, hash: v.hash };
}

function toMemoryCounter(w: CounterVersionWire): CounterVersion {
  return {
    revision: w.revision,
    name: w.name,
    // An ABSENT filter is a TOMBSTONE, not a missing value: it must stay absent, never defaulted.
    filter: w.filter === undefined ? undefined : toCoreFilter(w.filter),
  };
}

function toWireCounter(v: CounterVersion): CounterVersionWire {
  return {
    revision: v.revision,
    name: v.name,
    filter: v.filter === undefined ? undefined : toFullFilter(v.filter),
  };
}
