import type { CounterVersionWire, SchemaVersionWire } from "./datastore-dtos";
import type { DatastoreJournalEntry, DatastoreMetaState } from "./datastore-meta-state";
import { datastoreMetaStateEmpty } from "./datastore-meta-state";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { graphShardKeyForResource, graphShardKeyForSubject } from "./graph-shard-key";
import type { LogEvent } from "./log-event";
import type { RelationshipWire } from "./relationships-dtos";

/**
 * The SMALL-STATE restriction of the whole-state reference fold (`log-fold.ts`, a test helper): folds the same committed {@link LogEvent} sequence,
 * but keeps only what `DatastoreMetaState` carries - head, schema versions, counter versions, GC
 * floor, the types seen, and the pending (not yet projected) tail. Relationship row content is
 * deliberately NOT folded here; it belongs to the per-key `shard-fold.ts` (the shard grains'
 * projections). Together,
 * `metaFold + shardFold-per-touched-key` is exactly `logFold` split along the sharding lemma:
 * `fold(log) == merge(fold(log | key) for all keys)` for the rows, plus this fold for everything
 * else.
 *
 * Counter versions are appended DIRECTLY from the event's net deltas (never replayed through the
 * guarded register/unregister ops) - the same direct-append stance `logFoldApplyEvent` takes, for
 * the same reason: a same-commit register+unregister nets to a delta whose guard is false in the
 * fold base. Schema versions append the event's self-contained `schemaChange` as-is (revision +
 * bytes + hash), which is byte-identical to what the whole fold's transaction replay produces. GC
 * events compact the schema/counter histories exactly as `collectBelow` does (latest version
 * at-or-below the floor kept - for counters, per name and only when NOT a tombstone - plus
 * everything above), so the small state and the whole fold converge on identical histories.
 */
export function metaFoldApplyEvent(state: DatastoreMetaState, ev: LogEvent): DatastoreMetaState {
  const pending = [...state.pending, ev];

  // Never a truthiness test: 0n is a legal floor. Same guard as the other two folds.
  if (ev.gcFloor !== undefined) {
    const floor = ev.gcFloor;
    if (floor <= state.gcFloor) return { ...state, headRevision: ev.revision, pending };
    return {
      ...state,
      headRevision: ev.revision,
      gcFloor: floor,
      schemas: compactSchemas(state.schemas, floor),
      counters: compactCounters(state.counters, floor),
      pending,
    };
  }

  const schemas =
    ev.schemaChange !== undefined ? [...state.schemas, ev.schemaChange] : state.schemas;

  let counters: readonly CounterVersionWire[] = state.counters;
  for (const counter of ev.counterChanges)
    counters = [...counters, { revision: ev.revision, name: counter.name, filter: counter.filter }];

  // Record the types the event names: the shard index's enumeration roots. Add-only, and the
  // arrays are COPIED ON WRITE, so the caller's state is never mutated.
  let forwardTypes = state.forwardTypes;
  let reverseTypes = state.reverseTypes;
  for (const change of ev.relationshipChanges) {
    forwardTypes = withType(forwardTypes, change.relationship.resourceType);
    reverseTypes = withType(reverseTypes, change.relationship.subjectType);
  }

  return {
    ...state,
    headRevision: ev.revision,
    schemas,
    counters,
    pending,
    forwardTypes,
    reverseTypes,
  };
}

/**
 * Folds one journal entry into the small state. A committed event advances the head, the
 * schema/counter histories and the GC floor exactly as the whole-state fold does, records the types
 * it names, and joins the pending tail; a projection checkpoint drops the pending events it covers;
 * the seed entry starts an empty store at its revision. Pure and deterministic, as the
 * log-consistency adaptor requires.
 */
export function metaFoldApplyEntry(
  state: DatastoreMetaState,
  entry: DatastoreJournalEntry,
): DatastoreMetaState {
  switch (entry.kind) {
    case "seeded":
      return datastoreMetaStateEmpty(entry.revision);
    case "committed":
      return metaFoldApplyEvent(state, entry.event);
    case "projected":
      if (entry.through <= state.projectedThrough) return state;
      return {
        ...state,
        pending: state.pending.filter((e) => e.revision > entry.through),
        projectedThrough: entry.through,
      };
    default:
      return assertNever(entry);
  }
}

/** `ImmutableSortedSet.Add`: the sorted set with `type` in it (the same array when already there). */
function withType(types: readonly string[], type: string): readonly string[] {
  if (types.includes(type)) return types;
  return [...types, type].sort(compareOrdinal);
}

function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertNever(value: never): never {
  throw new Error(`unknown datastore journal entry ${JSON.stringify(value)}`);
}

/**
 * The distinct shard keys (escaped `graphShardGrainKeyBuild` strings, both directions) an event's
 * relationship changes touch - the keys whose dirty-buffer entries must be seeded before the event
 * is folded. A GC event touches no keys (it folds into every already-present entry instead).
 * Type/id fields need no payload normalization: the wire round trip only normalizes the subject
 * relation and caveat, never the four key fields.
 *
 * The C# returns a `HashSet<string>` with `StringComparer.Ordinal`; a JS `Set<string>` already
 * compares string keys ordinally. The RETURNED ORDER differs - .NET's is unspecified, a JS `Set`
 * is insertion-ordered - and that is benign here, because the result only seeds dirty-buffer
 * entries. No sort is added to paper over it.
 */
export function metaFoldTouchedKeys(ev: LogEvent): ReadonlySet<string> {
  if (ev.gcFloor !== undefined || ev.relationshipChanges.length === 0) return new Set<string>();

  const keys = new Set<string>();
  for (const change of ev.relationshipChanges) {
    keys.add(metaFoldForwardKeyOf(change.relationship));
    keys.add(metaFoldReverseKeyOf(change.relationship));
  }
  return keys;
}

/** The forward shard key string (`f/type/id`) of a row's resource. Durable-layout-visible. */
export function metaFoldForwardKeyOf(rel: RelationshipWire): string {
  return graphShardGrainKeyBuild(graphShardKeyForResource(rel.resourceType, rel.resourceId));
}

/** The reverse shard key string (`r/type/id`) of a row's subject. Durable-layout-visible. */
export function metaFoldReverseKeyOf(rel: RelationshipWire): string {
  return graphShardGrainKeyBuild(graphShardKeyForSubject(rel.subjectType, rel.subjectId));
}

// Mirrors `collectBelow`'s SCHEMAS rule: keep the single latest version with `revision <= floor`
// (the version effective at the floor) plus every version above it.
function compactSchemas(
  schemas: readonly SchemaVersionWire[],
  floor: bigint,
): readonly SchemaVersionWire[] {
  let latestAtOrBelow: bigint | undefined = undefined;
  for (const s of schemas) {
    if (s.revision <= floor) latestAtOrBelow = s.revision;
  }

  return schemas.filter((s) => s.revision > floor || s.revision === latestAtOrBelow);
}

// Mirrors `collectBelow`'s COUNTERS rule: per name, keep the latest version with `revision <= floor`
// UNLESS it is a tombstone (a dropped tombstone and "no version at all" are indistinguishable to
// every consumer), plus everything above the floor.
function compactCounters(
  counters: readonly CounterVersionWire[],
  floor: bigint,
): readonly CounterVersionWire[] {
  const latestAtOrBelowByName = new Map<string, bigint>();
  for (const c of counters) {
    if (c.revision <= floor) latestAtOrBelowByName.set(c.name, c.revision);
  }

  return counters.filter((c) => {
    if (c.revision > floor) return true;
    // The C# indexes the dictionary directly, a read that cannot miss on this branch. Under
    // `noUncheckedIndexedAccess` the lookup types as `bigint | undefined`, so it is an EXPLICIT
    // guard - never `?? -1`, which would silently keep or drop rows.
    const latest = latestAtOrBelowByName.get(c.name);
    return latest !== undefined && latest === c.revision && c.filter !== undefined;
  });
}
