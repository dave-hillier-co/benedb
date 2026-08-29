import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import {
  PreconditionFailedException,
  type PreconditionFailureKind,
} from "./precondition-failed-exception";

// No covering C# test of its own: `DispatchErrorMapperTests` constructs one but asserts only that
// the mapper passes it through. This characterizes what the type must actually preserve.
//
// `PreconditionFailureKind` is NOT wire-numeric - the API layer turns the whole exception into a
// gRPC FailedPrecondition and the kind only picks the message - so it is a string-literal union
// with no wire map, per the port guide.
//
// The surrogate carries all three fields because the reconstruction is byte-exact: the grain
// returns the message as `CommitFailureWire.Detail`, the client parses it back with
// `tryParsePreconditionFailure`, and the exception a caller observes must be indistinguishable
// from the one an inline evaluation would have thrown.
describe("precondition failed exception", () => {
  it("carries the kind, the zero-based index and the message", () => {
    const error = new PreconditionFailedException("mustMatchFoundNone", 3, "p");

    expect(error.kind).toBe("mustMatchFoundNone");
    expect(error.preconditionIndex).toBe(3);
    expect(error.message).toBe("p");
  });

  it("is an Error with its own name and survives instanceof", () => {
    const error = new PreconditionFailedException("mustNotMatchFoundOne", 0, "p");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PreconditionFailedException);
    expect(error.name).toBe("PreconditionFailedException");
  });

  it("accepts index zero - the first precondition in the request", () => {
    expect(new PreconditionFailedException("mustMatchFoundNone", 0, "p").preconditionIndex).toBe(0);
  });

  it.each<PreconditionFailureKind>(["mustMatchFoundNone", "mustNotMatchFoundOne"])(
    "keeps the %s kind distinct",
    (kind) => {
      expect(new PreconditionFailedException(kind, 1, "p").kind).toBe(kind);
    },
  );

  it("round-trips through Thresh's value codec as its own class, all three fields intact", () => {
    const original = new PreconditionFailedException(
      "mustNotMatchFoundOne",
      12,
      "precondition 12 failed: MUST_NOT_MATCH filter [resource_type=document] matched at least one relationship",
    );

    const revived = deserializeValue<PreconditionFailedException>(serializeValue(original));

    expect(revived).toBeInstanceOf(PreconditionFailedException);
    expect(revived.kind).toBe(original.kind);
    expect(revived.preconditionIndex).toBe(original.preconditionIndex);
    expect(revived.message).toBe(original.message);
  });
});
