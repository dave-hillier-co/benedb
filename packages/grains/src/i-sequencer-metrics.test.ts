import { describe, expect, it } from "vitest";

import {
  addSequencerMetricsSnapshots,
  createSequencerMetricsSnapshot,
  SequencerMetrics,
} from "./i-sequencer-metrics";

// CHARACTERIZATION test for `src/Spiceport.Server/Grains/ISequencerMetrics.cs`.
//
// `SequencerMetricsTests.cs` is entirely mesh (it needs a TestCluster and the DatastoreGrain), and
// the only non-mesh C# assertions that touch this file are the three `CommitShed` ones in
// `SequencerAdmissionGateTests` - ported in `sequencer-admission-tests.test.ts`. So these cases are
// read off the C# itself and pin what it actually does:
//
//   * FOURTEEN snapshot fields with a POSITIONAL constructor whose order the mesh tests rely on;
//   * `operator +` sums thirteen of them but combines `CommitMicrosMax` with `Math.Max` - a
//     maximum is not additive, and summing it would make "the longest commit anywhere" wrong the
//     moment a second silo reports;
//   * `RecordCommit` does THREE things (count, add to the total, raise a running max);
//   * `RecordCommitCandidates` buckets by `<= 1`, `<= 8`, `<= 64`, else - the first bucket is "at
//     most one key", so it also catches 0 and negatives;
//   * `Snapshot()` is a `readonly record struct` returned by value, so it is a COPY;
//   * `Reset()` zeroes all fourteen, `CommitMicrosMax` included.

describe("SequencerMetricsSnapshot", () => {
  it("defaults every field but Commit to zero, as the C# positional record struct does", () => {
    // C#: `SequencerMetricsSnapshot(long Commit, long ReadFrom = 0, ... long CommitShed = 0)`.
    const snapshot = createSequencerMetricsSnapshot(9);

    expect(snapshot).toEqual({
      commit: 9,
      readFrom: 0,
      readShard: 0,
      getHead: 0,
      readState: 0,
      readSchemaAt: 0,
      commitMicrosTotal: 0,
      commitMicrosMax: 0,
      commitCandidates1: 0,
      commitCandidates2To8: 0,
      commitCandidates9To64: 0,
      commitCandidates65Plus: 0,
      flush: 0,
      commitShed: 0,
    });
  });

  it("binds the fourteen positional arguments in the C# declaration order", () => {
    // The order is load-bearing: the mesh tests construct these positionally, so swapping any two
    // silently re-labels every assertion downstream.
    const snapshot = createSequencerMetricsSnapshot(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14);

    expect(snapshot.commit).toBe(1);
    expect(snapshot.readFrom).toBe(2);
    expect(snapshot.readShard).toBe(3);
    expect(snapshot.getHead).toBe(4);
    expect(snapshot.readState).toBe(5);
    expect(snapshot.readSchemaAt).toBe(6);
    expect(snapshot.commitMicrosTotal).toBe(7);
    expect(snapshot.commitMicrosMax).toBe(8);
    expect(snapshot.commitCandidates1).toBe(9);
    expect(snapshot.commitCandidates2To8).toBe(10);
    expect(snapshot.commitCandidates9To64).toBe(11);
    expect(snapshot.commitCandidates65Plus).toBe(12);
    expect(snapshot.flush).toBe(13);
    expect(snapshot.commitShed).toBe(14);
  });

  it("sums every field EXCEPT CommitMicrosMax, which combines via max", () => {
    // C# `operator +`: thirteen component-wise sums and `Math.Max(a.CommitMicrosMax,
    // b.CommitMicrosMax)`. 8 and 80 would sum to 88; the max is 80.
    const a = createSequencerMetricsSnapshot(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14);
    const b = createSequencerMetricsSnapshot(
      10,
      20,
      30,
      40,
      50,
      60,
      70,
      80,
      90,
      100,
      110,
      120,
      130,
      140,
    );

    expect(addSequencerMetricsSnapshots(a, b)).toEqual(
      createSequencerMetricsSnapshot(11, 22, 33, 44, 55, 66, 77, 80, 99, 110, 121, 132, 143, 154),
    );
  });

  it("takes the larger CommitMicrosMax whichever side it is on, and is order-insensitive", () => {
    const bigger = createSequencerMetricsSnapshot(0, 0, 0, 0, 0, 0, 0, 500);
    const smaller = createSequencerMetricsSnapshot(0, 0, 0, 0, 0, 0, 0, 4);

    expect(addSequencerMetricsSnapshots(bigger, smaller).commitMicrosMax).toBe(500);
    expect(addSequencerMetricsSnapshots(smaller, bigger).commitMicrosMax).toBe(500);
  });
});

describe("SequencerMetrics", () => {
  it("starts at zero on every counter", () => {
    expect(new SequencerMetrics().snapshot()).toEqual(
      createSequencerMetricsSnapshot(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    );
  });

  it("records a commit as a count, a duration sum, and a running max at once", () => {
    // C# `RecordCommit`: Increment(_commit); Add(_commitMicrosTotal, elapsed); CAS the max upward.
    const metrics = new SequencerMetrics();

    metrics.recordCommit(120);
    metrics.recordCommit(30);

    const snapshot = metrics.snapshot();
    expect(snapshot.commit).toBe(2);
    expect(snapshot.commitMicrosTotal).toBe(150);
    // A running max, not the last value: the second (shorter) commit must not lower it.
    expect(snapshot.commitMicrosMax).toBe(120);
  });

  it("raises the max only for a strictly larger duration", () => {
    // The C# loop condition is `elapsed > current`, so an equal observation never writes. The
    // observable value is the same either way; the strictness is what makes that so.
    const metrics = new SequencerMetrics();

    metrics.recordCommit(7);
    metrics.recordCommit(7);
    metrics.recordCommit(9);

    expect(metrics.snapshot().commitMicrosMax).toBe(9);
    expect(metrics.snapshot().commitMicrosTotal).toBe(23);
    expect(metrics.snapshot().commit).toBe(3);
  });

  it("counts a zero-microsecond commit and leaves the max at zero", () => {
    const metrics = new SequencerMetrics();

    metrics.recordCommit(0);

    expect(metrics.snapshot().commit).toBe(1);
    expect(metrics.snapshot().commitMicrosTotal).toBe(0);
    expect(metrics.snapshot().commitMicrosMax).toBe(0);
  });

  it("buckets candidate counts at the C# boundaries 1 / 8 / 64", () => {
    // C#: `<= 1` -> CommitCandidates1, `<= 8` -> 2To8, `<= 64` -> 9To64, else 65Plus. Every
    // boundary is asserted from both sides, because an off-by-one here silently moves a commit
    // between buckets and nothing downstream would notice.
    const metrics = new SequencerMetrics();

    for (const count of [1, 2, 8, 9, 64, 65]) metrics.recordCommitCandidates(count);

    const snapshot = metrics.snapshot();
    expect(snapshot.commitCandidates1).toBe(1);
    expect(snapshot.commitCandidates2To8).toBe(2);
    expect(snapshot.commitCandidates9To64).toBe(2);
    expect(snapshot.commitCandidates65Plus).toBe(1);
  });

  it("puts zero and negative candidate counts in the 'at most one key' bucket", () => {
    // `candidateKeyCount <= 1` is the first branch, so 0 and -1 land there too.
    const metrics = new SequencerMetrics();

    metrics.recordCommitCandidates(0);
    metrics.recordCommitCandidates(-1);

    expect(metrics.snapshot().commitCandidates1).toBe(2);
    expect(metrics.snapshot().commitCandidates2To8).toBe(0);
  });

  it("does not touch the Commit counter when only candidates are recorded", () => {
    // The C# doc: commits rejected BEFORE candidate resolution count in RecordCommit but in no
    // bucket, so the two counters are deliberately independent.
    const metrics = new SequencerMetrics();

    metrics.recordCommitCandidates(3);

    expect(metrics.snapshot().commit).toBe(0);
    expect(metrics.snapshot().commitCandidates2To8).toBe(1);
  });

  it("gives each remaining Record method its own counter and nothing else's", () => {
    const metrics = new SequencerMetrics();

    metrics.recordReadFrom();
    metrics.recordReadShard();
    metrics.recordReadShard();
    metrics.recordGetHead();
    metrics.recordReadState();
    metrics.recordReadSchemaAt();
    metrics.recordFlush();
    metrics.recordCommitShed();

    expect(metrics.snapshot()).toEqual(
      createSequencerMetricsSnapshot(0, 1, 2, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1),
    );
  });

  it("returns a snapshot COPY, so an earlier snapshot never moves underneath its holder", () => {
    // The C# returns a record STRUCT by value. A port handing back a live view would make every
    // before/after comparison in the mesh benchmarks vacuous.
    const metrics = new SequencerMetrics();
    metrics.recordFlush();
    const before = metrics.snapshot();

    metrics.recordFlush();

    expect(before.flush).toBe(1);
    expect(metrics.snapshot().flush).toBe(2);
    expect(metrics.snapshot()).not.toBe(before);
  });

  it("zeroes all fourteen counters on Reset, CommitMicrosMax included", () => {
    // C# `Reset()` calls `Interlocked.Exchange(..., 0)` on every field. The max is easy to forget:
    // it is the one field the aggregation operator treats differently.
    const metrics = new SequencerMetrics();
    metrics.recordCommit(5000);
    metrics.recordCommitCandidates(1);
    metrics.recordCommitCandidates(4);
    metrics.recordCommitCandidates(40);
    metrics.recordCommitCandidates(400);
    metrics.recordReadFrom();
    metrics.recordReadShard();
    metrics.recordGetHead();
    metrics.recordReadState();
    metrics.recordReadSchemaAt();
    metrics.recordFlush();
    metrics.recordCommitShed();

    metrics.reset();

    expect(metrics.snapshot()).toEqual(
      createSequencerMetricsSnapshot(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    );
  });

  it("keeps counting after a Reset", () => {
    const metrics = new SequencerMetrics();
    metrics.recordCommit(11);
    metrics.reset();

    metrics.recordCommit(3);

    expect(metrics.snapshot().commit).toBe(1);
    expect(metrics.snapshot().commitMicrosTotal).toBe(3);
    expect(metrics.snapshot().commitMicrosMax).toBe(3);
  });
});
