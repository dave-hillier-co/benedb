import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import { DispatchFailedException, type DispatchErrorCode } from "./dispatch-failed-exception";

// No covering C# test - `DispatchFailedException.cs` is exercised only indirectly, through
// `DispatchErrorMapperTests` (which asserts the mapper's classification, not this type). This is a
// characterization of the two things that are load-bearing about it:
//
//   1. The CODE. `DispatchErrorCode` is a plain (non-wire) enum in the C# - the API layer maps its
//      members onto gRPC status codes separately - so the port renders it as a string-literal
//      union with no wire map. The MEMBERS still matter enormously: Unavailable makes `zed` retry
//      a transient hop failure, Internal makes it fail outright, so the two must never collapse
//      into one another.
//   2. The ROUND TRIP. `DispatchErrorMapper` deliberately passes an already-classified
//      DispatchFailedException THROUGH, so its code survives further dispatch hops. If the
//      surrogate lost the code (or the class), a deep Unavailable would silently degrade to
//      Internal at the front door and a retryable failure would look fatal.
describe("dispatch failed exception", () => {
  it("carries the settled dispatch error code and reason", () => {
    const error = new DispatchFailedException("unavailable", "transient");

    expect(error.code).toBe("unavailable");
    expect(error.message).toBe("transient");
  });

  it("is an Error with its own name, so a logger prints the type", () => {
    const error = new DispatchFailedException("internal", "boom");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("DispatchFailedException");
  });

  it("survives instanceof after downlevelling (the setPrototypeOf guard)", () => {
    expect(new DispatchFailedException("cancelled", "x")).toBeInstanceOf(DispatchFailedException);
  });

  it("wraps an inner exception as the ES2022 cause (the C# two-arg overload)", () => {
    const inner = new Error("underlying");

    const error = new DispatchFailedException("unavailable", "transient", inner);

    expect(error.cause).toBe(inner);
  });

  it("accepts a non-Error inner cause, because a rejected promise can carry anything", () => {
    const error = new DispatchFailedException("internal", "boom", "a bare string");

    expect(error.cause).toBe("a bare string");
  });

  it("leaves cause absent when no inner exception is given (the one-arg overload)", () => {
    expect(new DispatchFailedException("internal", "boom").cause).toBeUndefined();
  });

  it.each<DispatchErrorCode>(["unavailable", "cancelled", "deadlineExceeded", "internal"])(
    "keeps the %s code distinct - the four map to four different gRPC statuses",
    (code) => {
      expect(new DispatchFailedException(code, "m").code).toBe(code);
    },
  );

  it("round-trips through Thresh's value codec as its own class, code intact", () => {
    const original = new DispatchFailedException("unavailable", "transient");

    const revived = deserializeValue<DispatchFailedException>(serializeValue(original));

    expect(revived).toBeInstanceOf(DispatchFailedException);
    expect(revived.code).toBe("unavailable");
    expect(revived.message).toBe("transient");
  });

  it("round-trips the code even when the original wrapped an inner exception", () => {
    // The surrogate encodes only `code` and `message`: the inner cause is a local diagnostic, and
    // an arbitrary exception from a remote silo may not itself be encodable. What must survive the
    // hop is the classification.
    const original = new DispatchFailedException("cancelled", "cancelled", new Error("inner"));

    const revived = deserializeValue<DispatchFailedException>(serializeValue(original));

    expect(revived.code).toBe("cancelled");
    expect(revived.message).toBe("cancelled");
  });
});
