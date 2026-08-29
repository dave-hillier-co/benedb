import { describe, expect, it } from "vitest";

import {
  addDispatchMetricsSnapshots,
  createDispatchMetricsSnapshot,
  DispatchMetrics,
  type DispatchMetricsSnapshot,
} from "./i-dispatch-metrics";

// CHARACTERIZATION test for `src/Spiceport.Server/Grains/IDispatchMetrics.cs`.
//
// The C# has no covering test of its own: it is exercised only from the mesh suites
// (DispatchMeshMetricsTests, CheckDispatchFiltersTests), which need grain implementations this
// slice deliberately does not have. So these cases are read straight off the C# and pin what it
// actually does, not what a counter "obviously" does:
//
//   * six independent counters, each Record* touching exactly one of them;
//   * `Snapshot()` is a `readonly record struct` returned BY VALUE - a fresh copy every call, so a
//     caller that snapshots, runs a workload and compares sees two DIFFERENT values. A TypeScript
//     port that handed back the live counter store would make every such comparison vacuous;
//   * the positional constructor's field ORDER is LoopBypass, MemoHit, MemoMiss, Dispatch,
//     FrontierMemoHit, FrontierMemoMiss - five of them C#-defaulted to 0 - because the mesh tests
//     build snapshots positionally;
//   * `operator +` is a component-wise sum on all six, which is what makes per-silo snapshots
//     summable into a cluster total.
describe("DispatchMetricsSnapshot", () => {
  it("defaults every field but LoopBypass to zero, as the C# positional record struct does", () => {
    // C#: `DispatchMetricsSnapshot(long LoopBypass, long MemoHit = 0, ... long FrontierMemoMiss = 0)`.
    const snapshot = createDispatchMetricsSnapshot(7);

    expect(snapshot).toEqual({
      loopBypass: 7,
      memoHit: 0,
      memoMiss: 0,
      dispatch: 0,
      frontierMemoHit: 0,
      frontierMemoMiss: 0,
    });
  });

  it("binds the positional arguments in the C# declaration order", () => {
    // The order is load-bearing: the mesh tests construct these positionally, so swapping (say)
    // Dispatch and MemoMiss would silently re-label every assertion downstream.
    const snapshot = createDispatchMetricsSnapshot(1, 2, 3, 4, 5, 6);

    expect(snapshot.loopBypass).toBe(1);
    expect(snapshot.memoHit).toBe(2);
    expect(snapshot.memoMiss).toBe(3);
    expect(snapshot.dispatch).toBe(4);
    expect(snapshot.frontierMemoHit).toBe(5);
    expect(snapshot.frontierMemoMiss).toBe(6);
  });

  it("sums component-wise across all six fields, so per-silo snapshots aggregate", () => {
    // C# `operator +`. There is no operator overloading in TypeScript, hence the free function.
    const a = createDispatchMetricsSnapshot(1, 2, 3, 4, 5, 6);
    const b = createDispatchMetricsSnapshot(10, 20, 30, 40, 50, 60);

    expect(addDispatchMetricsSnapshots(a, b)).toEqual(
      createDispatchMetricsSnapshot(11, 22, 33, 44, 55, 66),
    );
  });

  it("leaves both operands untouched - the C# operands are value-type copies", () => {
    const a = createDispatchMetricsSnapshot(1, 1, 1, 1, 1, 1);
    const b = createDispatchMetricsSnapshot(2, 2, 2, 2, 2, 2);

    addDispatchMetricsSnapshots(a, b);

    expect(a).toEqual(createDispatchMetricsSnapshot(1, 1, 1, 1, 1, 1));
    expect(b).toEqual(createDispatchMetricsSnapshot(2, 2, 2, 2, 2, 2));
  });

  it("is associative and commutative over a three-silo aggregation", () => {
    const a = createDispatchMetricsSnapshot(1, 0, 0, 3);
    const b = createDispatchMetricsSnapshot(0, 5, 0, 1);
    const c = createDispatchMetricsSnapshot(2, 0, 7, 0);

    const left = addDispatchMetricsSnapshots(addDispatchMetricsSnapshots(a, b), c);
    const right = addDispatchMetricsSnapshots(a, addDispatchMetricsSnapshots(b, c));

    expect(left).toEqual(right);
    expect(addDispatchMetricsSnapshots(a, b)).toEqual(addDispatchMetricsSnapshots(b, a));
  });
});

describe("DispatchMetrics counters", () => {
  it("starts at zero on every counter", () => {
    expect(new DispatchMetrics().snapshot()).toEqual(createDispatchMetricsSnapshot(0));
  });

  // Each Record* is `Interlocked.Increment` on its OWN field: one call must move exactly one
  // counter. Table-driven so a copy-paste slip in the port (two methods incrementing the same
  // field) cannot hide.
  const recorders: readonly [keyof DispatchMetrics & string, keyof DispatchMetricsSnapshot][] = [
    ["recordLoopBypass", "loopBypass"],
    ["recordDispatch", "dispatch"],
    ["recordMemoHit", "memoHit"],
    ["recordMemoMiss", "memoMiss"],
    ["recordFrontierMemoHit", "frontierMemoHit"],
    ["recordFrontierMemoMiss", "frontierMemoMiss"],
  ];

  for (const [method, field] of recorders) {
    it(`${method} increments only ${field}`, () => {
      const metrics = new DispatchMetrics();

      (metrics[method] as () => void).call(metrics);
      const snapshot = metrics.snapshot();

      expect(snapshot[field]).toBe(1);
      const others = Object.entries(snapshot).filter(([name]) => name !== field);
      expect(others.map(([, value]) => value)).toEqual([0, 0, 0, 0, 0]);
    });
  }

  it("accumulates repeated records", () => {
    const metrics = new DispatchMetrics();

    metrics.recordDispatch();
    metrics.recordDispatch();
    metrics.recordDispatch();

    expect(metrics.snapshot().dispatch).toBe(3);
  });

  it("returns a fresh snapshot value each call, never a live view of the counters", () => {
    // C# `Snapshot()` returns a record STRUCT: the caller holds a copy. This is the property the
    // benchmark/mesh tests rest on - snapshot, run a workload, compare - and a TypeScript port
    // that returned the counter store would make every such comparison compare a value with
    // itself.
    const metrics = new DispatchMetrics();
    metrics.recordMemoHit();

    const before = metrics.snapshot();
    metrics.recordMemoHit();
    const after = metrics.snapshot();

    expect(before.memoHit).toBe(1);
    expect(after.memoHit).toBe(2);
    expect(before).not.toBe(after);
  });

  it("hands out a frozen snapshot, so a caller cannot write back into a reading", () => {
    const snapshot = new DispatchMetrics().snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("zeroes every counter on reset, so a benchmark workload can be bracketed", () => {
    const metrics = new DispatchMetrics();
    metrics.recordLoopBypass();
    metrics.recordDispatch();
    metrics.recordMemoHit();
    metrics.recordMemoMiss();
    metrics.recordFrontierMemoHit();
    metrics.recordFrontierMemoMiss();

    metrics.reset();

    expect(metrics.snapshot()).toEqual(createDispatchMetricsSnapshot(0));
  });

  it("keeps counting from zero after a reset", () => {
    const metrics = new DispatchMetrics();
    metrics.recordDispatch();
    metrics.reset();

    metrics.recordDispatch();

    expect(metrics.snapshot().dispatch).toBe(1);
  });

  it("sums two silos' snapshots into the cluster total", () => {
    // The whole point of the summable snapshot: DispatchMetrics is a per-silo singleton.
    const siloA = new DispatchMetrics();
    const siloB = new DispatchMetrics();
    siloA.recordDispatch();
    siloA.recordLoopBypass();
    siloB.recordDispatch();
    siloB.recordFrontierMemoMiss();

    const total = addDispatchMetricsSnapshots(siloA.snapshot(), siloB.snapshot());

    expect(total).toEqual(createDispatchMetricsSnapshot(1, 0, 0, 2, 0, 1));
  });
});
