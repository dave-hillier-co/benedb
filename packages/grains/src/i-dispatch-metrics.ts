/**
 * Ported from Spiceport `Grains/IDispatchMetrics.cs` (the `IDispatchMetrics` seam, the
 * `DispatchMetricsSnapshot` record struct and the `DispatchMetrics` counter implementation).
 *
 * Port decisions:
 *   * The C# doc records that `System.Diagnostics.Metrics` was ASSESSED AND REJECTED for this
 *     seam: it is a plain interface over six counters, deliberately not a meter. So nothing here
 *     reaches for `@thresh/observability` or any meter API - the counters are transliterated.
 *   * `Interlocked.Increment` / `Read` / `Exchange` map to plain `+= 1` / a read / `= 0`. A grain
 *     silo runs on a single-threaded event loop, so there is no atomicity to wrap.
 *   * The counters are C# `long`. `number` is exact to 2^53, which covers any real workload (a
 *     dispatch every nanosecond for 100 days), so there is no `bigint` here - consistent with
 *     `i-sequencer-metrics.ts`.
 *   * `DispatchMetricsSnapshot` is a `readonly record struct` with a POSITIONAL constructor, five
 *     of whose six parameters default to 0; the mesh tests build it positionally, so the port
 *     keeps a positional factory and the C# field ORDER.
 *   * `operator +` has no TypeScript counterpart, so it becomes the free function
 *     {@link addDispatchMetricsSnapshots}. The component-wise sum is what makes per-silo snapshots
 *     aggregate into a cluster total.
 */

/**
 * An immutable snapshot of {@link IDispatchMetrics} counters.
 *
 * A C# STRUCT: `Snapshot()` hands back a copy, so a caller that snapshots, runs a workload and
 * compares sees two different values. {@link DispatchMetrics.snapshot} therefore returns a fresh
 * frozen object each call, never a live view of the counter store.
 */
export interface DispatchMetricsSnapshot {
  /** Exact visited-set loop-bypass hits (the grain call is still made, the result force-cut). */
  readonly loopBypass: number;
  /** `CheckGrain` per-activation reply-memo hits. */
  readonly memoHit: number;
  /** `CheckGrain` per-activation reply-memo misses. */
  readonly memoMiss: number;
  /**
   * Real grain-call boundary crossings recorded by the incoming check-dispatch filter - every
   * incoming `ICheckGrain.dispatchCheck` call, accepted or rejected.
   */
  readonly dispatch: number;
  /** `SubjectFrontierGrain` per-activation frontier-memo hits. */
  readonly frontierMemoHit: number;
  /** `SubjectFrontierGrain` per-activation frontier-memo misses. */
  readonly frontierMemoMiss: number;
}

/**
 * The C# positional constructor
 * `DispatchMetricsSnapshot(long LoopBypass, long MemoHit = 0, long MemoMiss = 0, long Dispatch = 0,
 * long FrontierMemoHit = 0, long FrontierMemoMiss = 0)`. The parameter ORDER is load-bearing: the
 * mesh tests construct snapshots positionally.
 */
export function createDispatchMetricsSnapshot(
  loopBypass: number,
  memoHit = 0,
  memoMiss = 0,
  dispatch = 0,
  frontierMemoHit = 0,
  frontierMemoMiss = 0,
): DispatchMetricsSnapshot {
  return Object.freeze({
    loopBypass,
    memoHit,
    memoMiss,
    dispatch,
    frontierMemoHit,
    frontierMemoMiss,
  });
}

/** Component-wise sum, for aggregating snapshots across silos. The C#'s `operator +`. */
export function addDispatchMetricsSnapshots(
  a: DispatchMetricsSnapshot,
  b: DispatchMetricsSnapshot,
): DispatchMetricsSnapshot {
  return createDispatchMetricsSnapshot(
    a.loopBypass + b.loopBypass,
    a.memoHit + b.memoHit,
    a.memoMiss + b.memoMiss,
    a.dispatch + b.dispatch,
    a.frontierMemoHit + b.frontierMemoHit,
    a.frontierMemoMiss + b.frontierMemoMiss,
  );
}

/**
 * Silo-singleton dispatch counters, aggregated across every grain/dispatch on a silo: how often
 * the exact visited-set loop bypass fired ({@link recordLoopBypass}), plus the `CheckGrain`
 * activation-memo hit/miss. Summing the snapshot from every silo yields cluster-wide totals.
 *
 * An OPTIONAL dependency everywhere it is taken (`IDispatchMetrics? metrics = null` in the C#), so
 * every call site is `metrics?.record...`.
 */
export interface IDispatchMetrics {
  /**
   * A sub-problem whose (resource, subject) key was already in the exact visited set (a genuine
   * same-key loop): the grain call still happens as normal (the grain is reentrant), but the
   * caller forces `cycleCut` on the returned result so it is never memoized.
   */
  recordLoopBypass(): void;

  /**
   * A real grain-call boundary crossing: the incoming check-dispatch filter records one for EVERY
   * incoming `ICheckGrain.dispatchCheck` call it sees, before the grain body runs and regardless
   * of whether the call is then accepted or rejected by the depth-budget boundary guard.
   */
  recordDispatch(): void;

  /** A `CheckGrain` per-activation reply-memo hit. */
  recordMemoHit(): void;

  /** A `CheckGrain` per-activation reply-memo miss. */
  recordMemoMiss(): void;

  /** A `SubjectFrontierGrain` per-activation frontier-memo hit. */
  recordFrontierMemoHit(): void;

  /** A `SubjectFrontierGrain` per-activation frontier-memo miss. */
  recordFrontierMemoMiss(): void;

  /** An immutable point-in-time snapshot of the counters. */
  snapshot(): DispatchMetricsSnapshot;

  /** Resets all counters to zero (to bracket one benchmark workload). */
  reset(): void;
}

/** Counter-backed {@link IDispatchMetrics}. The C#'s `DispatchMetrics`. */
export class DispatchMetrics implements IDispatchMetrics {
  #loopBypass = 0;
  #memoHit = 0;
  #memoMiss = 0;
  #dispatch = 0;
  #frontierMemoHit = 0;
  #frontierMemoMiss = 0;

  /** @inheritdoc */
  recordLoopBypass(): void {
    this.#loopBypass += 1;
  }

  /** @inheritdoc */
  recordDispatch(): void {
    this.#dispatch += 1;
  }

  /** @inheritdoc */
  recordMemoHit(): void {
    this.#memoHit += 1;
  }

  /** @inheritdoc */
  recordMemoMiss(): void {
    this.#memoMiss += 1;
  }

  /** @inheritdoc */
  recordFrontierMemoHit(): void {
    this.#frontierMemoHit += 1;
  }

  /** @inheritdoc */
  recordFrontierMemoMiss(): void {
    this.#frontierMemoMiss += 1;
  }

  /**
   * @inheritdoc
   *
   * A FRESH value every call, mirroring the C# struct copy: a caller holding an earlier snapshot
   * must not see it move underneath them.
   */
  snapshot(): DispatchMetricsSnapshot {
    return createDispatchMetricsSnapshot(
      this.#loopBypass,
      this.#memoHit,
      this.#memoMiss,
      this.#dispatch,
      this.#frontierMemoHit,
      this.#frontierMemoMiss,
    );
  }

  /** @inheritdoc */
  reset(): void {
    this.#loopBypass = 0;
    this.#memoHit = 0;
    this.#memoMiss = 0;
    this.#dispatch = 0;
    this.#frontierMemoHit = 0;
    this.#frontierMemoMiss = 0;
  }
}
