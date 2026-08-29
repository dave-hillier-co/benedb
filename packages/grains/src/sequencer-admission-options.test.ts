import { describe, expect, it } from "vitest";

import { resolveSequencerAdmissionOptions } from "./sequencer-admission-options";

/**
 * No covering C# test - a characterization of `SequencerAdmissionOptions`.
 *
 * `MaxInFlightCommits` bounds this silo's contribution to the cluster-singleton sequencer's queue;
 * a commit arriving beyond it is shed with RESOURCE_EXHAUSTED rather than queueing without bound.
 * ZERO OR NEGATIVE DISABLES THE GATE - which is the guide's default-parameter trap in options
 * form: a `||` default would turn the documented "unbounded" sentinel back into 128, quietly
 * re-enabling a gate a host deliberately turned off.
 */
describe("resolveSequencerAdmissionOptions", () => {
  it("defaults to 128 in-flight commits", () => {
    expect(resolveSequencerAdmissionOptions().maxInFlightCommits).toBe(128);
    expect(resolveSequencerAdmissionOptions({}).maxInFlightCommits).toBe(128);
  });

  it("keeps an explicit zero, which disables the gate", () => {
    expect(resolveSequencerAdmissionOptions({ maxInFlightCommits: 0 }).maxInFlightCommits).toBe(0);
  });

  it("keeps an explicit negative value, which also disables the gate", () => {
    expect(resolveSequencerAdmissionOptions({ maxInFlightCommits: -1 }).maxInFlightCommits).toBe(
      -1,
    );
  });

  it("carries a configured bound through unchanged", () => {
    expect(resolveSequencerAdmissionOptions({ maxInFlightCommits: 4 }).maxInFlightCommits).toBe(4);
  });

  it("keeps the bound a plain number, not a bigint", () => {
    expect(typeof resolveSequencerAdmissionOptions().maxInFlightCommits).toBe("number");
  });

  it("carries no other members", () => {
    expect(Object.keys(resolveSequencerAdmissionOptions())).toEqual(["maxInFlightCommits"]);
  });
});
