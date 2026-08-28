import type { Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";

import type { RegisteredCounter } from "./counters";
import { relationshipKeyOf, relationshipKeyString } from "./relationship-key";
import type { RelationshipsFilter } from "./relationships-filter";

// A deliberately MULTI-EXPORT module, per the port ledger: `DatastoreState.cs` carries
// `StoredRelationship`, `SchemaVersion`, `CounterVersion` and `DatastoreState` together, and the
// four only make sense as one MVCC fold, so they stay in one file.
//
// The C# types are `internal`, visible to the grain layer and the gate tests through
// `[InternalsVisibleTo]`. TypeScript has no friend-assembly grant, so they are exported normally;
// nothing outside `@spacedb/datastore` and the grain layer should import them.
//
// Port decisions settled once, here:
//
// - Every C# `long` revision is a `bigint`, consistent with core's `TimestampRevision`. Mixing a
//   `number` into any of these comparisons is a type error at best and a wrong answer at worst.
// - `ImmutableList<T>` becomes `readonly T[]`, COPIED ON WRITE. The base arrays are shared with
//   live snapshot readers, so nothing here may ever mutate one in place.
// - The C# record members become an interface plus free functions, per the port guide: an
//   instance property that is really a predicate (`IsVisibleAt`) becomes a free function.
// - `DatastoreState` identity is load-bearing downstream (`ReferenceDatastore`'s serialization
//   check is `ReferenceEquals`), so the port compares states with `===`, never a deep equal.

/** A relationship row with the revision range over which it is live. */
export interface StoredRelationship {
  /** The stored relationship (payload + identity). */
  readonly relationship: Relationship;
  /** The revision at which the row became live. */
  readonly createdRevision: bigint;
  /** The revision at which the row was deleted, or absent if still live. */
  readonly deletedRevision?: bigint | undefined;
}

/** True if this row is visible when reading at `atRevision`. */
export function storedRelationshipIsVisibleAt(
  row: StoredRelationship,
  atRevision: bigint,
): boolean {
  return (
    row.createdRevision <= atRevision &&
    (row.deletedRevision === undefined || row.deletedRevision > atRevision)
  );
}

/** A schema bytes version stamped with the revision at which it was written. */
export interface SchemaVersion {
  /** The revision at which this version was written. */
  readonly revision: bigint;
  /** The serialized schema bytes. */
  readonly bytes: Uint8Array;
  /** The hash of the schema bytes. */
  readonly hash: string;
}

/**
 * An MVCC version of a registered counter, stamped with the revision at which it was written. An
 * ABSENT `filter` marks a tombstone (the counter was unregistered at this revision) - it is not a
 * missing value to be defaulted away.
 */
export interface CounterVersion {
  /** The revision at which this version was written. */
  readonly revision: bigint;
  /** The counter's name. */
  readonly name: string;
  /** The registered filter, or absent for a tombstone. */
  readonly filter?: RelationshipsFilter | undefined;
}

/**
 * An immutable point-in-time state of the datastore. Each committed transaction produces a new
 * instance; snapshot readers capture a reference and remain correct regardless of later writes.
 */
export interface DatastoreState {
  /** The freshest committed revision. */
  readonly headRevision: bigint;
  /** The relationship rows, in storage order. */
  readonly relationships: readonly StoredRelationship[];
  /** The schema versions, append-ordered ascending by revision. */
  readonly schemas: readonly SchemaVersion[];
  /** The counter versions, append-ordered ascending by revision. */
  readonly counters: readonly CounterVersion[];
  /**
   * The revision below which MVCC history has been garbage-collected (0 = nothing collected yet).
   * Reads pinned strictly below this floor are rejected (see the `MvccSnapshotReader` constructor
   * guard) - their result could otherwise silently omit rows `collectBelow` has already dropped.
   *
   * The C# has this as a defaulted record parameter (`long GcFloor = 0`); the ported interface
   * makes it an explicit required member, so every construction site states it.
   */
  readonly gcFloor: bigint;
}

/** Port of `DatastoreState.Empty`. */
export function emptyDatastoreState(initialRevision: bigint): DatastoreState {
  return {
    headRevision: initialRevision,
    relationships: [],
    schemas: [],
    counters: [],
    gcFloor: 0n,
  };
}

/**
 * Returns the relationships live at the given revision.
 *
 * The C# is a lazy iterator that several call sites enumerate MORE THAN ONCE. A TypeScript
 * generator is single-pass, so handing the same exhausted iterator to two consumers would
 * silently yield nothing the second time; the port returns an ARRAY instead - a deliberate loss
 * of laziness in exchange for a result that behaves like the C# `IEnumerable` did.
 */
export function liveAt(state: DatastoreState, atRevision: bigint): readonly Relationship[] {
  const live: Relationship[] = [];
  for (const row of state.relationships) {
    if (storedRelationshipIsVisibleAt(row, atRevision)) live.push(row.relationship);
  }
  return live;
}

/**
 * Returns the relationship changes committed AT the given revision, reconstructed from the row
 * created/deleted stamps. A row created at the revision surfaces as a touch (carrying the
 * payload); a row deleted at the revision surfaces as a delete (carrying the removed
 * relationship). A touch over an existing key produces both a delete of the old payload and a
 * touch of the new - we emit only the touch (the live result), matching SpiceDB's per-revision
 * update semantics.
 *
 * The C# `HashSet<RelationshipKey>` keys a record struct by value; a TypeScript `Set` keys by
 * reference, so the port keys on the canonical `relationshipKeyString`.
 */
export function changesAt(
  state: DatastoreState,
  atRevision: bigint,
): readonly RelationshipUpdate[] {
  const changes: RelationshipUpdate[] = [];
  const touchedKeys = new Set<string>();

  for (const row of state.relationships) {
    if (row.createdRevision === atRevision) {
      changes.push({ relationship: row.relationship, operation: "touch" });
      touchedKeys.add(relationshipKeyString(relationshipKeyOf(row.relationship)));
    }
  }

  for (const row of state.relationships) {
    if (
      row.deletedRevision === atRevision &&
      !touchedKeys.has(relationshipKeyString(relationshipKeyOf(row.relationship)))
    )
      changes.push({ relationship: row.relationship, operation: "delete" });
  }

  return changes;
}

/** True if the unified schema was (re)written exactly at the given revision. */
export function schemaChangedAt(state: DatastoreState, atRevision: bigint): boolean {
  for (const schema of state.schemas) {
    if (schema.revision === atRevision) return true;
  }
  return false;
}

/**
 * Returns the schema bytes effective at the given revision, or `undefined` if none.
 *
 * The `break` on the first version ABOVE the revision is load-bearing: it is only equivalent to
 * "the last version at or below" while `schemas` is append-ordered ascending. Keep it rather than
 * rewriting as a filter-and-last.
 */
export function schemaAt(state: DatastoreState, atRevision: bigint): Uint8Array | undefined {
  let result: Uint8Array | undefined = undefined;
  for (const schema of state.schemas) {
    if (schema.revision <= atRevision) result = schema.bytes;
    else break;
  }
  return result;
}

/** Returns the schema hash effective at the given revision, or `undefined` if none. */
export function schemaHashAt(state: DatastoreState, atRevision: bigint): string | undefined {
  let result: string | undefined = undefined;
  for (const schema of state.schemas) {
    if (schema.revision <= atRevision) result = schema.hash;
    else break;
  }
  return result;
}

/**
 * Returns the filter registered for the named counter live at the given revision (last-wins fold
 * over versions with `revision <= atRevision`), or `undefined` if the last version is a tombstone
 * / none.
 *
 * The `found` flag is redundant - both branches return `undefined` when nothing matched - but it
 * is transliterated rather than simplified away.
 */
export function counterFilterAt(
  state: DatastoreState,
  name: string,
  atRevision: bigint,
): RelationshipsFilter | undefined {
  let result: RelationshipsFilter | undefined = undefined;
  let found = false;
  for (const version of state.counters) {
    if (version.name === name && version.revision <= atRevision) {
      result = version.filter;
      found = true;
    }
  }
  return found ? result : undefined;
}

/**
 * Returns the counters live at the given revision.
 *
 * The C# folds into a `Dictionary<string, RelationshipsFilter?>` in which a NULL VALUE IS
 * MEANINGFUL: it is the tombstone that hides an earlier registration. The port's
 * `Map<string, RelationshipsFilter | undefined>` therefore distinguishes presence from a defined
 * value, and the tombstone must never be `??`-coalesced away.
 *
 * Like `liveAt`, this returns an array rather than a generator, so the result may be enumerated
 * more than once.
 */
export function liveCountersAt(
  state: DatastoreState,
  atRevision: bigint,
): readonly RegisteredCounter[] {
  const latest = new Map<string, RelationshipsFilter | undefined>();
  for (const version of state.counters) {
    if (version.revision <= atRevision) latest.set(version.name, version.filter);
  }
  const live: RegisteredCounter[] = [];
  for (const [name, filter] of latest) {
    if (filter !== undefined) live.push({ name, filter });
  }
  return live;
}

/**
 * Collects MVCC history strictly below `floor`: this is the ONE fold definition GC events apply
 * (see `LogFold.applyEvent` in the grain layer), so the grain state and any other fold of the
 * same log all converge on the identical collected state.
 *
 * A no-op - returning THE SAME OBJECT REFERENCE, which callers check with `===` - when `floor`
 * does not advance the current `gcFloor`; GC only ever moves forward. `headRevision` is
 * untouched: the head advances through the normal per-revision fold, not through collection.
 *
 * RELATIONSHIPS: a row is dropped when it is fully dead below the floor (`deletedRevision <=
 * floor` - invisible to every reader at or above the floor, and readers below the floor are
 * rejected outright) OR when it is expired at/before the floor (see the expiration-sweep
 * justification below). Every other row - in particular one created at/below the floor that is
 * still live, or deleted only after the floor - is kept unchanged, so every read at a revision
 * >= floor is byte-identical before and after collection.
 *
 * EXPIRATION SWEEP - justification: the only read paths that consult
 * `Relationship.optionalExpiration` (`MvccSnapshotReader`/`MvccReadWriteTransaction`'s
 * `isExpired`) compare it against the wall clock AT QUERY TIME - never against the pinned MVCC
 * revision. Revisions and expirations both live on the same nanos-since-Unix-epoch clock, and
 * `floor` is always a timestamp that has ALREADY elapsed by the time collection runs (the caller
 * derives it as `min(head, nowNanos() - window)`). Because wall-clock time only moves forward,
 * every future query's "now" is >= floor. So any row whose expiration is <= floor is GUARANTEED
 * to satisfy `exp <= now` for every future query regardless of which revision is pinned - it
 * would never be yielded again even if kept. Dropping it therefore cannot change any
 * still-servable read. (Rows reconstructed via `changesAt` for Watch-style replay are a different
 * path - but the grain-backed Watch feed replays raw relationship-change log events, never
 * `changesAt` over the folded/collected state, so that path is unaffected by this sweep.)
 *
 * The C#'s `NanosSinceEpoch(DateTimeOffset)` VANISHES here: core's ported `Relationship` already
 * stores `optionalExpiration` as nanos-since-epoch `bigint`, so the sweep compares it against the
 * floor directly. The C# value is always a multiple of 100 (tick truncation) and the ported one
 * need not be, which the `<=` comparison is indifferent to.
 *
 * SCHEMAS: kept are the single LATEST version with `revision <= floor` (the version effective at
 * the floor, needed by any read/fold at a revision >= floor with no later schema write) plus
 * every version above the floor.
 *
 * COUNTERS: compacted PER NAME using the same rule as schemas - the latest version with
 * `revision <= floor` per counter name, plus everything above the floor - EXCEPT that a kept
 * latest-at-or-below version that is itself a tombstone (absent filter) is dropped entirely:
 * nothing above the floor can need to consult it (a tombstone and "no version at all" both
 * resolve to "not registered" for every consumer of `counterFilterAt`/`liveCountersAt`).
 */
export function collectBelow(state: DatastoreState, floor: bigint): DatastoreState {
  if (floor <= state.gcFloor) return state;

  const keptRelationships = state.relationships.filter((row) => {
    if (row.deletedRevision !== undefined && row.deletedRevision <= floor) return false; // fully dead below the floor
    if (
      row.relationship.optionalExpiration !== undefined &&
      row.relationship.optionalExpiration <= floor
    )
      return false; // expired at/before the floor: see the justification above
    return true;
  });

  const keptSchemas = compactLatestAtOrBelow(state.schemas, (s) => s.revision, floor);
  const keptCounters = compactCountersPerName(state, floor);

  return {
    ...state,
    relationships: keptRelationships,
    schemas: keptSchemas,
    counters: keptCounters,
    gcFloor: floor,
  };
}

function compactCountersPerName(state: DatastoreState, floor: bigint): readonly CounterVersion[] {
  // The latest revision <= floor per counter name (counters is append-ordered, so the last match
  // per name IS its latest revision <= floor).
  const latestAtOrBelowByName = new Map<string, bigint>();
  for (const c of state.counters) {
    if (c.revision <= floor) latestAtOrBelowByName.set(c.name, c.revision);
  }

  return state.counters.filter((c) => {
    if (c.revision > floor) return true; // everything above the floor is kept unconditionally
    // The unique latest-at-or-below version for this name: keep it UNLESS it is a tombstone (a
    // dropped tombstone and "no version at all" are indistinguishable to every consumer).
    // The C# indexes the dictionary directly; under `noUncheckedIndexedAccess` the lookup is
    // `bigint | undefined`, and this branch guarantees presence, so it is an explicit guard
    // rather than a non-null assertion.
    const latest = latestAtOrBelowByName.get(c.name);
    return latest !== undefined && latest === c.revision && c.filter !== undefined;
  });
}

function compactLatestAtOrBelow<T>(
  versions: readonly T[],
  revisionOf: (version: T) => bigint,
  floor: bigint,
): readonly T[] {
  let latestAtOrBelow: bigint | undefined = undefined;
  for (const v of versions) {
    if (revisionOf(v) <= floor) latestAtOrBelow = revisionOf(v);
  }

  return versions.filter((v) => revisionOf(v) > floor || revisionOf(v) === latestAtOrBelow);
}
