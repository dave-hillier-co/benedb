import type { CounterVersionWire, SchemaVersionWire } from "./datastore-dtos";
import type { DatastoreMetaState } from "./datastore-meta-state";
import { NO_ROW_VERSION } from "./datastore-meta-state";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { graphShardKeyForResource, graphShardKeyForSubject } from "./graph-shard-key";
import type { LogEvent } from "./log-event";
import type { RelationshipWire } from "./relationships-dtos";

/**
 * The SMALL-STATE restriction of `log-fold.ts`: folds the same committed {@link LogEvent} sequence,
 * but keeps only what `DatastoreMetaState` carries - head, schema versions, counter versions, GC
 * floor, and the key index. Relationship row content is deliberately NOT folded here; it belongs to
 * the per-key `shard-fold.ts` (the dirty buffer / shard rows). Together,
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
  // Never a truthiness test: 0n is a legal floor. Same guard as the other two folds.
  if (ev.gcFloor !== undefined) {
    const floor = ev.gcFloor;
    if (floor <= state.gcFloor) return { ...state, headRevision: ev.revision };
    return {
      ...state,
      headRevision: ev.revision,
      gcFloor: floor,
      schemas: compactSchemas(state.schemas, floor),
      counters: compactCounters(state.counters, floor),
    };
  }

  const schemas =
    ev.schemaChange !== undefined ? [...state.schemas, ev.schemaChange] : state.schemas;

  let counters: readonly CounterVersionWire[] = state.counters;
  for (const counter of ev.counterChanges)
    counters = [...counters, { revision: ev.revision, name: counter.name, filter: counter.filter }];

  // Index every touched key. Add-only here, and VERSION-NEUTRAL: a key not yet indexed is added at
  // `NO_ROW_VERSION` (it has no durable row - its state lives in the dirty buffer until a flush
  // writes one), and an already-indexed key KEEPS its recorded row version. The fold must stay a
  // pure function of the event sequence - it cannot know which storage version a row will land
  // under - so the version bump happens exclusively at the flush, on the meta entry the flush
  // persists; keys whose shard state becomes empty are pruned there too, never mid-fold.
  //
  // `ImmutableDictionary` becomes a `ReadonlyMap` COPIED ON WRITE, so the caller's state is never
  // mutated. The copy is taken lazily, exactly where the C# would have rebound its local.
  let forward = state.forwardKeys;
  let reverse = state.reverseKeys;
  for (const change of ev.relationshipChanges) {
    const forwardKey = metaFoldForwardKeyOf(change.relationship);
    if (!forward.has(forwardKey)) forward = new Map(forward).set(forwardKey, NO_ROW_VERSION);
    const reverseKey = metaFoldReverseKeyOf(change.relationship);
    if (!reverse.has(reverseKey)) reverse = new Map(reverse).set(reverseKey, NO_ROW_VERSION);
  }

  return {
    ...state,
    headRevision: ev.revision,
    schemas,
    counters,
    forwardKeys: forward,
    reverseKeys: reverse,
  };
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
