import { describe, expect, it } from "vitest";

import type { ISequencerMetrics, SequencerMetricsSnapshot } from "./i-sequencer-metrics";
import { SequencerMetrics } from "./i-sequencer-metrics";
import { SequencerAdmission } from "./sequencer-admission";
import { SequencerOverloadedException } from "./sequencer-overloaded-exception";

// CHARACTERIZATION test for `src/Spiceport.Server/Grains/SequencerAdmission.cs`, beyond the three
// facts of `SequencerAdmissionGateTests` ported verbatim in `sequencer-admission-tests.test.ts`.
//
// What the C# actually does, as opposed to what "an admission gate" suggests:
//
//   * `_slots` is null when `MaxInFlightCommits > 0` is false, so a NON-POSITIVE limit disables the
//     gate entirely - `Enter()` returns the shared no-op slot and records NO shed metric, ever;
//   * the shed path records the metric FIRST and throws second;
//   * `_limit` is captured at construction (a `readonly` field initialized from the options), so a
//     later mutation of the options object does not retune the gate - and it is the captured value
//     that is interpolated into the message;
//   * admission is NON-BLOCKING: `SemaphoreSlim.Wait(0)` either takes a slot immediately or sheds.
//     There is no waiting tier, which is the whole point - waiting is the latency ramp the gate
//     exists to cut off.

/** Records nothing but the call order, to pin what happens before the throw. */
class ThrowingMetrics implements ISequencerMetrics {
  recordCommitShed(): never {
    throw new Error("recordCommitShed ran");
  }

  recordCommit(): void {}
  recordCommitCandidates(): void {}
  recordReadFrom(): void {}
  recordReadShard(): void {}
  recordGetHead(): void {}
  recordReadState(): void {}
  recordReadSchemaAt(): void {}
  recordFlush(): void {}
  snapshot(): SequencerMetricsSnapshot {
    throw new Error("not used");
  }
  reset(): void {}
}

describe("SequencerAdmission", () => {
  it("admits exactly the configured number of concurrent commits", () => {
    const gate = new SequencerAdmission({ maxInFlightCommits: 3 }, new SequencerMetrics());

    const held = [gate.enter(), gate.enter(), gate.enter()];

    expect(() => gate.enter()).toThrow(SequencerOverloadedException);
    for (const slot of held) slot.dispose();
  });

  it("readmits one commit per released slot, not more", () => {
    const gate = new SequencerAdmission({ maxInFlightCommits: 2 }, new SequencerMetrics());
    const first = gate.enter();
    const second = gate.enter();

    first.dispose();

    const readmitted = gate.enter();
    expect(() => gate.enter()).toThrow(SequencerOverloadedException);

    second.dispose();
    readmitted.dispose();
  });

  it("sheds with the C#'s verbatim message, naming the configured limit", () => {
    // C#: `$"the sequencer write queue is full on this silo ({_limit} commits in flight); " +
    //      "the write was shed to keep overload retryable — back off and retry"`. Two C# string
    // pieces with the space at the join, and an EM DASH (U+2014) in the source.
    const gate = new SequencerAdmission({ maxInFlightCommits: 1 }, new SequencerMetrics());
    const held = gate.enter();

    expect(() => gate.enter()).toThrow(
      "the sequencer write queue is full on this silo (1 commits in flight); " +
        "the write was shed to keep overload retryable — back off and retry",
    );

    held.dispose();
  });

  it("records the shed metric BEFORE throwing", () => {
    // C# shed path order: `metrics.RecordCommitShed(); throw new SequencerOverloadedException(...)`.
    // A metrics implementation that throws proves the record ran first: its error is what escapes,
    // not the overload exception.
    const gate = new SequencerAdmission({ maxInFlightCommits: 1 }, new ThrowingMetrics());
    const held = gate.enter();

    expect(() => gate.enter()).toThrow("recordCommitShed ran");

    held.dispose();
  });

  it("counts one shed per rejected entry", () => {
    const metrics = new SequencerMetrics();
    const gate = new SequencerAdmission({ maxInFlightCommits: 1 }, metrics);
    const held = gate.enter();

    for (let i = 0; i < 4; i++) expect(() => gate.enter()).toThrow(SequencerOverloadedException);

    expect(metrics.snapshot().commitShed).toBe(4);
    held.dispose();
  });

  it("captures the limit at construction, so retuning the options object does nothing", () => {
    // `private readonly int _limit = options.MaxInFlightCommits;` - read once, in the constructor.
    const options = { maxInFlightCommits: 1 };
    const gate = new SequencerAdmission(options, new SequencerMetrics());

    options.maxInFlightCommits = 50;

    const held = gate.enter();
    expect(() => gate.enter()).toThrow("(1 commits in flight)");
    held.dispose();
  });

  it("is disabled by a negative limit as well as by zero, and never records a shed", () => {
    // `options.MaxInFlightCommits > 0 ? new SemaphoreSlim(...) : null` - anything non-positive
    // leaves `_slots` null, which is the disabled gate. The slots are deliberately NOT released
    // here: with the gate off there is no capacity to exhaust.
    const metrics = new SequencerMetrics();
    const gate = new SequencerAdmission({ maxInFlightCommits: -1 }, metrics);

    for (let i = 0; i < 1000; i++) gate.enter();

    expect(metrics.snapshot().commitShed).toBe(0);
  });

  it("hands the disabled gate a no-op slot whose disposal is harmless and repeatable", () => {
    const gate = new SequencerAdmission({ maxInFlightCommits: 0 }, new SequencerMetrics());

    const slot = gate.enter();
    slot.dispose();
    slot.dispose();

    expect(() => gate.enter()).not.toThrow();
  });

  it("defaults to the resolved SequencerAdmissionOptions limit when none is given", () => {
    // The C# gate reads `SequencerAdmissionOptions.MaxInFlightCommits`, whose own default (128,
    // already ported in `sequencer-admission-options.ts`) is what decides here - the gate applies
    // no default of its own.
    const gate = new SequencerAdmission({}, new SequencerMetrics());

    const held = [];
    for (let i = 0; i < 128; i++) held.push(gate.enter());

    expect(() => gate.enter()).toThrow("(128 commits in flight)");
    for (const slot of held) slot.dispose();
  });

  it("throws an error a caller can recognise by type, not a sentinel return", () => {
    // The gRPC front door maps this exception to RESOURCE_EXHAUSTED; the type is the whole signal.
    const gate = new SequencerAdmission({ maxInFlightCommits: 1 }, new SequencerMetrics());
    const held = gate.enter();

    let caught: unknown;
    try {
      gate.enter();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SequencerOverloadedException);
    held.dispose();
  });
});
