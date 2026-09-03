import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import { DeleteLimitExceededException } from "./delete-limit-exceeded-exception";

// No covering C# test - the type is exercised end-to-end by the DeleteRelationships cases in
// `authzed-permissions-v1-service-tests.test.ts`. Pinned here: the SpiceDB-verbatim message the
// gRPC front door surfaces as InvalidArgument detail, and the value-codec round trip that stands
// in for the C#'s `[GenerateSerializer]`.
describe("delete limit exceeded exception", () => {
  it("carries the SpiceDB-verbatim message and the limit", () => {
    const error = new DeleteLimitExceededException(3n);

    expect(error.limit).toBe(3n);
    expect(error.message).toBe(
      "found more than 3 relationships to be deleted and partial deletion was not requested",
    );
  });

  it("is an Error with its own name and survives instanceof", () => {
    const error = new DeleteLimitExceededException(1n);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DeleteLimitExceededException);
    expect(error.name).toBe("DeleteLimitExceededException");
  });

  it("round-trips through Thresh's value codec as its own class", () => {
    const original = new DeleteLimitExceededException(42n);

    const revived = deserializeValue<DeleteLimitExceededException>(serializeValue(original));

    expect(revived).toBeInstanceOf(DeleteLimitExceededException);
    expect(revived.limit).toBe(42n);
    expect(revived.message).toBe(original.message);
  });
});
