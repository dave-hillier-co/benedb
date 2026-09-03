import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import { InvalidCursorException } from "./invalid-cursor-exception";

// No covering C# test - the type is exercised end-to-end by the cursor-rejection cases in
// `reverse-ops-mesh-tests.test.ts` and the codec's own characterization tests. Pinned here: the
// value-codec round trip that stands in for the C#'s `[GenerateSerializer]`.
describe("invalid cursor exception", () => {
  it("is an Error with its own name and survives instanceof", () => {
    const error = new InvalidCursorException("invalid cursor: token is malformed");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(InvalidCursorException);
    expect(error.name).toBe("InvalidCursorException");
    expect(error.message).toBe("invalid cursor: token is malformed");
  });

  it("round-trips through Thresh's value codec as its own class", () => {
    const original = new InvalidCursorException(
      "cursor does not apply to this request: it was created for a different set of arguments",
    );

    const revived = deserializeValue<InvalidCursorException>(serializeValue(original));

    expect(revived).toBeInstanceOf(InvalidCursorException);
    expect(revived.message).toBe(original.message);
  });
});
