import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import { SequencerOverloadedException } from "./sequencer-overloaded-exception";

// No covering C# test - `SequencerAdmissionTests` exercises `SequencerAdmission`, not this type.
//
// Two facts worth pinning, both from the C# doc comment rather than from any assertion:
//   * it maps to gRPC RESOURCE_EXHAUSTED, a deliberate retryable overload signal, in place of the
//     opaque Unknown a response-timeout storm used to produce; and
//   * `DispatchErrorMapper` deliberately does NOT list it as a domain exception, because it is
//     thrown at the WRITE surface (the relationships grain, to its gRPC caller), never across a
//     check dispatch. That asymmetry is transliterated, not repaired - see
//     `dispatch-error-mapper.test.ts`, which pins the consequence.
describe("sequencer overloaded exception", () => {
  it("carries the shed diagnostic message", () => {
    const error = new SequencerOverloadedException(
      "sequencer admission is full: 64 commits already in flight",
    );

    expect(error.message).toBe("sequencer admission is full: 64 commits already in flight");
  });

  it("is an Error with its own name and survives instanceof", () => {
    const error = new SequencerOverloadedException("shed");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SequencerOverloadedException);
    expect(error.name).toBe("SequencerOverloadedException");
  });

  it("round-trips through Thresh's value codec as its own class", () => {
    const original = new SequencerOverloadedException("shed");

    const revived = deserializeValue<SequencerOverloadedException>(serializeValue(original));

    expect(revived).toBeInstanceOf(SequencerOverloadedException);
    expect(revived.message).toBe("shed");
  });
});
