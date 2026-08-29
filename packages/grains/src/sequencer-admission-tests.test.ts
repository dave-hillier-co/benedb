import { describe, expect, it } from "vitest";

import { SequencerMetrics } from "./i-sequencer-metrics";
import { SequencerAdmission } from "./sequencer-admission";
import { SequencerOverloadedException } from "./sequencer-overloaded-exception";

/**
 * Ported from `tests/Spiceport.Grains.Tests/SequencerAdmissionTests.cs`, class
 * `SequencerAdmissionGateTests` (lines 20-73) - the only class in that file that runs on a plain
 * instance with no cluster. Its sibling `SequencerAdmissionMeshTests` needs `RelationshipsGrain`,
 * the gRPC front door and a `MeshTestCluster`, none of which exist in this slice; it is deferred
 * with the rest of the mesh suites.
 *
 * `IDisposable` has no equivalent under this repo's ES2022 lib (no `Symbol.dispose`, no `using`),
 * so the C#'s `using var` and its explicit double-`Dispose()` become explicit `slot.dispose()`
 * calls here. The behaviour under test is unchanged - the double release is exactly what the
 * second fact exists to forbid.
 */
describe("SequencerAdmissionGateTests", () => {
  it("Full_gate_sheds_and_a_released_slot_readmits", () => {
    const metrics = new SequencerMetrics();
    const gate = new SequencerAdmission({ maxInFlightCommits: 2 }, metrics);

    const first = gate.enter();
    const second = gate.enter();

    expect(() => gate.enter()).toThrow(SequencerOverloadedException);
    expect(metrics.snapshot().commitShed).toBe(1);

    first.dispose();
    const readmitted = gate.enter();

    second.dispose();
    // The readmitted entry took a slot rather than shedding, so the shed count has not moved.
    expect(metrics.snapshot().commitShed).toBe(1);

    readmitted.dispose(); // the C#'s `using var readmitted`.
  });

  it("Disposing_a_slot_twice_releases_it_only_once", () => {
    const gate = new SequencerAdmission({ maxInFlightCommits: 1 }, new SequencerMetrics());

    const slot = gate.enter();
    slot.dispose();
    slot.dispose();

    // A double release would have grown capacity past the bound: both entries would now succeed.
    const only = gate.enter();
    expect(() => gate.enter()).toThrow(SequencerOverloadedException);

    only.dispose();
  });

  it("Non_positive_limit_disables_the_gate", () => {
    const metrics = new SequencerMetrics();
    const gate = new SequencerAdmission({ maxInFlightCommits: 0 }, metrics);

    for (let i = 0; i < 1000; i++) gate.enter().dispose();

    expect(metrics.snapshot().commitShed).toBe(0);
  });
});
