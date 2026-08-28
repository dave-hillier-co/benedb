import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import { InvalidConsistencyTokenException } from "./invalid-consistency-token-exception";

// Characterization of Spiceport `InvalidConsistencyTokenException` (no covering C# test).
//
// Port decisions pinned here:
//
// 1. The C# carries NO discriminator for which gRPC status it maps to: the doc comment says
//    InvalidArgument (a malformed token) or FailedPrecondition (a snapshot no longer available),
//    and the choice belongs to the call site that catches it. The port preserves that - no `kind`
//    enum is invented here, unlike `CaveatEvaluationException` where the C# does carry one.
//
// 2. The resolver throws it inside a grain, so it crosses the grain boundary. Thresh serializes a
//    bare Error subclass down to an empty object, so the implementation registers a surrogate
//    with the value codec, as `CaveatEvaluationException` does. Without it the message - the only
//    thing distinguishing "malformed ZedToken" from "references a different datastore instance" -
//    is lost, and the caller cannot choose a status. Importing this module registers it.
describe("invalid consistency token exception", () => {
  it("carries a human-readable reason", () => {
    const error = new InvalidConsistencyTokenException("at_least_as_fresh: malformed ZedToken");

    expect(error.message).toBe("at_least_as_fresh: malformed ZedToken");
  });

  it("is an Error with its own name", () => {
    const error = new InvalidConsistencyTokenException("boom");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(InvalidConsistencyTokenException);
    expect(error.name).toBe("InvalidConsistencyTokenException");
  });

  it("round-trips through Thresh's value codec as its own class", () => {
    const original = new InvalidConsistencyTokenException(
      "at_exact_snapshot: ZedToken references a different datastore instance",
    );

    const revived = deserializeValue<InvalidConsistencyTokenException>(serializeValue(original));

    expect(revived).toBeInstanceOf(InvalidConsistencyTokenException);
    expect(revived.message).toBe(original.message);
  });

  it("is throwable and catchable as itself", () => {
    expect(() => {
      throw new InvalidConsistencyTokenException("at_exact_snapshot: malformed ZedToken");
    }).toThrow(InvalidConsistencyTokenException);
  });
});
