import type { Relationship } from "@benedb/core/relationship";
import { TimestampRevision } from "@benedb/core/timestamp-revision";

import type { RegisteredCounter } from "./counters";
import { CounterNotRegisteredException, RevisionNotFoundException } from "./datastore-exceptions";
import {
  counterFilterAt,
  liveAt,
  liveCountersAt,
  schemaAt,
  type DatastoreState,
} from "./datastore-state";
import type { IDatastoreReader } from "./i-datastore";
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

const NANOS_PER_MILLISECOND = 1_000_000n;

/**
 * Wall-clock "now" as nanoseconds since the Unix epoch, to compare against core's
 * `Relationship.optionalExpiration`.
 *
 * The C# samples `DateTimeOffset.UtcNow`, whose resolution is 100ns ticks; `Date.now()` is
 * MILLISECONDS, so an expiration falling inside the current millisecond reads as not-yet-expired
 * here where the C# might already have expired it. That is the only observable difference, and it
 * is sub-millisecond.
 */
function nowNanos(): bigint {
  return BigInt(Date.now()) * NANOS_PER_MILLISECOND;
}

/** `exp <= now` - INCLUSIVE: an expiration exactly at the sampled now is expired. */
function isExpired(rel: Relationship, now: bigint): boolean {
  return rel.optionalExpiration !== undefined && rel.optionalExpiration <= now;
}

/** Read-only snapshot accessor over an immutable `DatastoreState` at a fixed revision. */
export class MvccSnapshotReader implements IDatastoreReader {
  private readonly state: DatastoreState;
  private readonly revision: bigint;
  private readonly isValidAt: (revision: bigint) => boolean;

  /**
   * @param state The immutable state to read.
   * @param revision The pinned revision.
   * @param isValid A LIVE callback into the datastore's validity check - the C# `Func<long, bool>`
   * - re-invoked on every `isValid` read, never a boolean captured here.
   * @throws RevisionNotFoundException If `revision` is strictly below `state.gcFloor`.
   */
  constructor(state: DatastoreState, revision: bigint, isValid: (revision: bigint) => boolean) {
    // A revision below the collected floor cannot be read exactly: `collectBelow` may already have
    // dropped rows that would have been visible at it (rows dead-below-floor, or
    // expired-at-or-before-floor). Reject outright rather than silently serving a partial view.
    if (revision < state.gcFloor)
      throw new RevisionNotFoundException(new TimestampRevision(revision));

    this.state = state;
    this.revision = revision;
    this.isValidAt = isValid;
  }

  /** @inheritdoc */
  get isValid(): boolean {
    return this.isValidAt(this.revision);
  }

  /** @inheritdoc */
  async *queryRelationships(
    filter: RelationshipsFilter,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship> {
    // Sampled ONCE per query, before the scan, not per row: a long scan must not straddle an
    // expiry mid-result.
    const now = nowNanos();
    for (const rel of liveAt(this.state, this.revision)) {
      signal?.throwIfAborted();
      if (isExpired(rel, now)) continue;
      if (relationshipsFilterMatches(filter, rel)) yield rel;
    }
  }

  /** @inheritdoc */
  async *reverseQueryRelationships(
    subjectsFilter: SubjectsFilter,
    options?: ReverseQueryOptions | undefined,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship> {
    const now = nowNanos();

    // An absent `sort` is the C# record's `ReverseQuerySort.Unsorted` default argument.
    if (options === undefined || options.sort === undefined || options.sort === "unsorted") {
      // Fast path: stream in storage order, no materialization.
      for (const rel of liveAt(this.state, this.revision)) {
        signal?.throwIfAborted();
        if (isExpired(rel, now)) continue;
        if (subjectsFilterMatches(subjectsFilter, rel)) yield rel;
      }
      return;
    }

    // Ordered path: materialize matching rows, sort by the requested key, then apply the exclusive
    // keyset so resumption sees only strictly-greater rows. The six-tuple is unique, so there are
    // no ties and the order is total.
    const matches: Relationship[] = [];
    for (const rel of liveAt(this.state, this.revision)) {
      signal?.throwIfAborted();
      if (isExpired(rel, now)) continue;
      if (subjectsFilterMatches(subjectsFilter, rel)) matches.push(rel);
    }

    matches.sort(compareRelationshipsBySubject);

    for (const rel of matches) {
      signal?.throwIfAborted();
      const after = options.after;
      if (after !== undefined && compareReferencesBySubject(rel.reference, after) <= 0) continue;
      yield rel;
    }
  }

  /** @inheritdoc */
  readStoredSchema(_signal?: AbortSignal | undefined): Promise<Uint8Array | undefined> {
    return Promise.resolve(schemaAt(this.state, this.revision));
  }

  /** @inheritdoc */
  readCounterFilter(
    name: string,
    _signal?: AbortSignal | undefined,
  ): Promise<RelationshipsFilter | undefined> {
    return Promise.resolve(counterFilterAt(this.state, name, this.revision));
  }

  /** @inheritdoc */
  async countRelationships(name: string, signal?: AbortSignal | undefined): Promise<bigint> {
    const filter = counterFilterAt(this.state, name, this.revision);
    if (filter === undefined) throw new CounterNotRegisteredException(name);
    // `ulong` on this seam is `bigint`, the choice `IDatastoreReader` already made.
    let count = 0n;
    for await (const _ of this.queryRelationships(filter, signal)) count++;
    return count;
  }

  /** @inheritdoc */
  async *lookupCounters(signal?: AbortSignal | undefined): AsyncIterable<RegisteredCounter> {
    for (const counter of liveCountersAt(this.state, this.revision)) {
      signal?.throwIfAborted();
      yield counter;
    }
  }
}
