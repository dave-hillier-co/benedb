/**
 * Ported from Spiceport `Grains/ISequencerMetrics.cs` (the `ISequencerMetrics` seam, the
 * `SequencerMetricsSnapshot` record struct and the `SequencerMetrics` counter implementation).
 *
 * Port decisions - the same idiom as `i-dispatch-metrics.ts`, deliberately:
 *   * The C# doc records that `System.Diagnostics.Metrics` was ASSESSED AND REJECTED for this
 *     repo's metrics seams. Nothing here reaches for `@thresh/observability` or any meter API;
 *     the counters are transliterated as plain fields.
 *   * `Interlocked.Increment` / `Add` / `Read` / `Exchange` map to `+= 1` / `+=` / a read / `= 0`.
 *     A silo runs on a single-threaded event loop, so there is no atomicity to wrap.
 *   * The lock-free CAS retry loop of `RecordCommit`'s running max collapses to a single
 *     `if (elapsed > max) max = elapsed` - with no concurrent writer there is nothing to retry.
 *     The `>` stays STRICT, exactly as the C# loop condition is, so an equal observation never
 *     writes; the observable value is identical either way.
 *   * The counters are C# `long`. `number` is exact to 2^53, which covers any real workload, so
 *     there is no `bigint` here.
 *   * `SequencerMetricsSnapshot` is a `readonly record struct` with a POSITIONAL constructor
 *     whose thirteen trailing parameters default to 0; the mesh tests build it positionally, so
 *     the port keeps a positional factory and the C# field ORDER exactly.
 *   * `operator +` has no TypeScript counterpart, so it becomes the free function
 *     {@link addSequencerMetricsSnapshots}.
 */

/**
 * An immutable snapshot of {@link ISequencerMetrics} counters.
 *
 * A C# STRUCT: `Snapshot()` hands back a copy, so a caller that snapshots, runs a workload and
 * compares sees two different values. {@link SequencerMetrics.snapshot} therefore returns a fresh
 * frozen object each call, never a live view of the counter store.
 */
export interface SequencerMetricsSnapshot {
  /** Inbound `Commit` calls (accepted, rejected, or thrown). */
  readonly commit: number;
  /** Inbound `ReadFrom` log-tail calls. */
  readonly readFrom: number;
  /** Inbound `ReadShard` cold-hydration calls. */
  readonly readShard: number;
  /** Inbound `GetHead` calls. */
  readonly getHead: number;
  /** Inbound `ReadState` admin-plane assembly calls. */
  readonly readState: number;
  /** Inbound `ReadSchemaAt` calls. */
  readonly readSchemaAt: number;
  /** Sum of every Commit call's duration, in microseconds. */
  readonly commitMicrosTotal: number;
  /**
   * The single longest Commit call's duration in microseconds. Combined via MAX (not sum) by
   * {@link addSequencerMetricsSnapshots}, so the cluster-wide value is still "the longest commit
   * anywhere" - a maximum is not additive.
   */
  readonly commitMicrosMax: number;
  /** Commits whose candidate-key set resolved to at most one key. */
  readonly commitCandidates1: number;
  /** Commits whose candidate-key set resolved to 2-8 keys. */
  readonly commitCandidates2To8: number;
  /** Commits whose candidate-key set resolved to 9-64 keys. */
  readonly commitCandidates9To64: number;
  /** Commits whose candidate-key set resolved to 65 or more keys. */
  readonly commitCandidates65Plus: number;
  /** Flush boundaries written (dirty-buffer flush + meta row durable). */
  readonly flush: number;
  /** Commits shed by the per-silo admission gate (recorded on the submitting silo). */
  readonly commitShed: number;
}

/**
 * The C# positional constructor `SequencerMetricsSnapshot(long Commit, long ReadFrom = 0, ...,
 * long CommitShed = 0)`. The parameter ORDER is load-bearing: the mesh tests construct snapshots
 * positionally, so swapping any two silently re-labels every assertion downstream.
 */
export function createSequencerMetricsSnapshot(
  commit: number,
  readFrom = 0,
  readShard = 0,
  getHead = 0,
  readState = 0,
  readSchemaAt = 0,
  commitMicrosTotal = 0,
  commitMicrosMax = 0,
  commitCandidates1 = 0,
  commitCandidates2To8 = 0,
  commitCandidates9To64 = 0,
  commitCandidates65Plus = 0,
  flush = 0,
  commitShed = 0,
): SequencerMetricsSnapshot {
  return Object.freeze({
    commit,
    readFrom,
    readShard,
    getHead,
    readState,
    readSchemaAt,
    commitMicrosTotal,
    commitMicrosMax,
    commitCandidates1,
    commitCandidates2To8,
    commitCandidates9To64,
    commitCandidates65Plus,
    flush,
    commitShed,
  });
}

/**
 * Aggregation across silos - the C#'s `operator +`: component-wise sum, EXCEPT
 * `commitMicrosMax`, which combines via `Math.max`. Summing a maximum would make "the longest
 * commit anywhere" wrong the moment a second silo reports.
 */
export function addSequencerMetricsSnapshots(
  a: SequencerMetricsSnapshot,
  b: SequencerMetricsSnapshot,
): SequencerMetricsSnapshot {
  return createSequencerMetricsSnapshot(
    a.commit + b.commit,
    a.readFrom + b.readFrom,
    a.readShard + b.readShard,
    a.getHead + b.getHead,
    a.readState + b.readState,
    a.readSchemaAt + b.readSchemaAt,
    a.commitMicrosTotal + b.commitMicrosTotal,
    Math.max(a.commitMicrosMax, b.commitMicrosMax),
    a.commitCandidates1 + b.commitCandidates1,
    a.commitCandidates2To8 + b.commitCandidates2To8,
    a.commitCandidates9To64 + b.commitCandidates9To64,
    a.commitCandidates65Plus + b.commitCandidates65Plus,
    a.flush + b.flush,
    a.commitShed + b.commitShed,
  );
}

/**
 * Silo-singleton sequencer counters: inbound `DatastoreGrain` calls decomposed by method, plus
 * the Commit-only duration and candidate-key-count observables. Registered on every silo; only
 * the silo hosting the single sequencer activation ever records, so summing every silo's snapshot
 * yields the cluster-wide totals (the same aggregation contract as `DispatchMetricsSnapshot`).
 */
export interface ISequencerMetrics {
  /**
   * One inbound `DatastoreGrain.commit` call completed (accepted, rejected, or thrown - recorded
   * in a finally so every inbound call counts exactly once), carrying the call's own wall-clock
   * duration in microseconds. Feeds the Commit count and the total/max duration observables.
   */
  recordCommit(elapsedMicroseconds: number): void;

  /**
   * The candidate-key set of one Commit resolved to `candidateKeyCount` shard keys. Recorded at
   * the point candidate resolution completes, so commits rejected BEFORE resolution (head or
   * schema-hash CAS failures) count in {@link recordCommit} but in no bucket. Buckets: at most 1,
   * 2-8, 9-64, 65+.
   */
  recordCommitCandidates(candidateKeyCount: number): void;

  /** One inbound `DatastoreGrain.readFrom` (log-tail) call. */
  recordReadFrom(): void;

  /** One inbound `DatastoreGrain.readShard` (cold-shard hydration) call. */
  recordReadShard(): void;

  /** One inbound `DatastoreGrain.getHead` call. */
  recordGetHead(): void;

  /** One inbound `DatastoreGrain.readState` (admin-plane whole-state assembly) call. */
  recordReadState(): void;

  /** One inbound `DatastoreGrain.readSchemaAt` call. */
  recordReadSchemaAt(): void;

  /**
   * One flush boundary written (the every-`flushInterval` dirty-buffer flush + meta write inside
   * the datastore grain's storage apply), recorded once the boundary's meta row is durable.
   */
  recordFlush(): void;

  /**
   * One commit was SHED by this silo's `SequencerAdmission` gate (never submitted to the
   * sequencer, surfaced to the client as `RESOURCE_EXHAUSTED`). Unlike every other counter here,
   * this is recorded on the SUBMITTING silo - the gate is per-silo - so any silo's value can be
   * nonzero; the snapshot sum is still the cluster-wide total.
   */
  recordCommitShed(): void;

  /** An immutable point-in-time snapshot of the counters. */
  snapshot(): SequencerMetricsSnapshot;

  /** Resets all counters to zero (to bracket one benchmark workload). */
  reset(): void;
}

/** Counter-backed {@link ISequencerMetrics}. The C#'s `SequencerMetrics`. */
export class SequencerMetrics implements ISequencerMetrics {
  #commit = 0;
  #readFrom = 0;
  #readShard = 0;
  #getHead = 0;
  #readState = 0;
  #readSchemaAt = 0;
  #commitMicrosTotal = 0;
  #commitMicrosMax = 0;
  #commitCandidates1 = 0;
  #commitCandidates2To8 = 0;
  #commitCandidates9To64 = 0;
  #commitCandidates65Plus = 0;
  #flush = 0;
  #commitShed = 0;

  /**
   * @inheritdoc
   *
   * THREE effects, as in the C#: the count, the duration total, and the running max. The C#'s
   * lock-free CAS retry loop is a single strict comparison here (see the file header).
   */
  recordCommit(elapsedMicroseconds: number): void {
    this.#commit += 1;
    this.#commitMicrosTotal += elapsedMicroseconds;
    if (elapsedMicroseconds > this.#commitMicrosMax) {
      this.#commitMicrosMax = elapsedMicroseconds;
    }
  }

  /** @inheritdoc */
  recordCommitCandidates(candidateKeyCount: number): void {
    // `<= 1` is the FIRST branch, so it is "at most one key": zero and negative land here too.
    if (candidateKeyCount <= 1) this.#commitCandidates1 += 1;
    else if (candidateKeyCount <= 8) this.#commitCandidates2To8 += 1;
    else if (candidateKeyCount <= 64) this.#commitCandidates9To64 += 1;
    else this.#commitCandidates65Plus += 1;
  }

  /** @inheritdoc */
  recordReadFrom(): void {
    this.#readFrom += 1;
  }

  /** @inheritdoc */
  recordReadShard(): void {
    this.#readShard += 1;
  }

  /** @inheritdoc */
  recordGetHead(): void {
    this.#getHead += 1;
  }

  /** @inheritdoc */
  recordReadState(): void {
    this.#readState += 1;
  }

  /** @inheritdoc */
  recordReadSchemaAt(): void {
    this.#readSchemaAt += 1;
  }

  /** @inheritdoc */
  recordFlush(): void {
    this.#flush += 1;
  }

  /** @inheritdoc */
  recordCommitShed(): void {
    this.#commitShed += 1;
  }

  /**
   * @inheritdoc
   *
   * A FRESH value every call, mirroring the C# struct copy: a caller holding an earlier snapshot
   * must not see it move underneath them.
   */
  snapshot(): SequencerMetricsSnapshot {
    return createSequencerMetricsSnapshot(
      this.#commit,
      this.#readFrom,
      this.#readShard,
      this.#getHead,
      this.#readState,
      this.#readSchemaAt,
      this.#commitMicrosTotal,
      this.#commitMicrosMax,
      this.#commitCandidates1,
      this.#commitCandidates2To8,
      this.#commitCandidates9To64,
      this.#commitCandidates65Plus,
      this.#flush,
      this.#commitShed,
    );
  }

  /** @inheritdoc - all fourteen, `commitMicrosMax` included. */
  reset(): void {
    this.#commit = 0;
    this.#readFrom = 0;
    this.#readShard = 0;
    this.#getHead = 0;
    this.#readState = 0;
    this.#readSchemaAt = 0;
    this.#commitMicrosTotal = 0;
    this.#commitMicrosMax = 0;
    this.#commitCandidates1 = 0;
    this.#commitCandidates2To8 = 0;
    this.#commitCandidates9To64 = 0;
    this.#commitCandidates65Plus = 0;
    this.#flush = 0;
    this.#commitShed = 0;
  }
}
