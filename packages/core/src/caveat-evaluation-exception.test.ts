import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import {
  CaveatEvaluationException,
  type CaveatEvaluationErrorKind,
} from "./caveat-evaluation-exception";

// Characterization of Spiceport `CaveatEvaluationException` (no covering C# test).
//
// Port decisions pinned here:
//
// 1. The `CaveatEvaluationErrorKind` enum becomes a string-literal union. Its values are NOT a
//    wire enum (unlike `UpdateOperation`), but the kind -> gRPC status mapping is load-bearing
//    and lives at the API layer: parameterTypeMismatch -> InvalidArgument (SpiceDB
//    ParameterTypeError), unknownCaveat -> FailedPrecondition (SpiceDB CaveatNameNotFoundErr).
//    Adding a kind without deciding its status silently degrades a caller to Unknown.
//
// 2. The C# remarks say this crosses the Orleans grain boundary. Thresh serializes a bare Error
//    subclass down to an empty object, so the port MUST register a surrogate with Thresh's value
//    codec; otherwise the kind is lost in transit and the status mapping degrades. The
//    round-trip test below is that registration's gate. Importing this module performs the
//    registration.
describe("caveat evaluation exception", () => {
  it("carries a kind and a message", () => {
    const error = new CaveatEvaluationException(
      "unknownCaveat",
      "caveat with name `somecaveat` not found",
    );

    expect(error.kind).toBe("unknownCaveat");
    expect(error.message).toBe("caveat with name `somecaveat` not found");
  });

  it("is an Error with its own name", () => {
    const error = new CaveatEvaluationException("parameterTypeMismatch", "boom");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CaveatEvaluationException);
    expect(error.name).toBe("CaveatEvaluationException");
  });

  it("pins the two kinds whose gRPC status mapping is load-bearing", () => {
    const kinds: CaveatEvaluationErrorKind[] = ["parameterTypeMismatch", "unknownCaveat"];

    for (const kind of kinds) {
      expect(new CaveatEvaluationException(kind, "m").kind).toBe(kind);
    }
  });

  it("round-trips through Thresh's value codec as its own class", () => {
    const original = new CaveatEvaluationException(
      "parameterTypeMismatch",
      "could not convert context parameter `age`: a int value is required, but found String `x`",
    );

    const revived = deserializeValue<CaveatEvaluationException>(serializeValue(original));

    expect(revived).toBeInstanceOf(CaveatEvaluationException);
    expect(revived.kind).toBe("parameterTypeMismatch");
    expect(revived.message).toBe(original.message);
  });

  it("round-trips the other kind too, so the status mapping survives a remote evaluation", () => {
    const original = new CaveatEvaluationException(
      "unknownCaveat",
      "caveat with name `c` not found",
    );

    const revived = deserializeValue<CaveatEvaluationException>(serializeValue(original));

    expect(revived.kind).toBe("unknownCaveat");
  });
});
