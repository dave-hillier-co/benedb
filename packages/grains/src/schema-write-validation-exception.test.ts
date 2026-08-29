import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import { SchemaWriteValidationException } from "./schema-write-validation-exception";

// No covering C# test. A message-only exception whose whole job is to reach the gRPC front door as
// its own class: the front door maps it to FailedPrecondition, and the message (which names the
// offending definition/relation and an example dangling relationship) is the only state there is.
// If it did not round-trip as itself it would collapse to Internal at the dispatch mapper.
describe("schema write validation exception", () => {
  it("carries the message naming the offending definition and an example relationship", () => {
    const error = new SchemaWriteValidationException(
      "cannot remove relation `document#viewer`: relationship `document:doc1#viewer@user:alice` still references it",
    );

    expect(error.message).toBe(
      "cannot remove relation `document#viewer`: relationship `document:doc1#viewer@user:alice` still references it",
    );
  });

  it("is an Error with its own name and survives instanceof", () => {
    const error = new SchemaWriteValidationException("dangling");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SchemaWriteValidationException);
    expect(error.name).toBe("SchemaWriteValidationException");
  });

  it("round-trips through Thresh's value codec as its own class", () => {
    const original = new SchemaWriteValidationException("dangling");

    const revived = deserializeValue<SchemaWriteValidationException>(serializeValue(original));

    expect(revived).toBeInstanceOf(SchemaWriteValidationException);
    expect(revived.message).toBe("dangling");
  });
});
