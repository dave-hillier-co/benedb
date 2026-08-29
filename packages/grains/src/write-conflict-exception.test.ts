import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import { WriteConflictException, type WriteConflictKind } from "./write-conflict-exception";

// No covering C# test. The kind is the whole point of the type: the relationships grain re-wraps
// the datastore's `CreateRelationshipExistsException` / `SerializationException` in this one
// boundary-crossing exception, and the two kinds map to DIFFERENT gRPC codes -
//
//   createExisting -> AlreadyExists (permanent; a client must NOT blindly retry it)
//   serialization  -> Aborted       (retry the whole transaction)
//
// - so a kind that collapses or fails to round-trip makes `zed` either retry a permanent duplicate
// forever or give up on a genuinely retryable conflict.
describe("write conflict exception", () => {
  it("carries the conflict kind and message", () => {
    const error = new WriteConflictException("serialization", "conflict");

    expect(error.kind).toBe("serialization");
    expect(error.message).toBe("conflict");
  });

  it("is an Error with its own name and survives instanceof", () => {
    const error = new WriteConflictException("createExisting", "already exists");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(WriteConflictException);
    expect(error.name).toBe("WriteConflictException");
  });

  it.each<WriteConflictKind>(["createExisting", "serialization"])(
    "keeps the %s kind distinct, because the two map to different gRPC codes",
    (kind) => {
      expect(new WriteConflictException(kind, "m").kind).toBe(kind);
    },
  );

  it.each<WriteConflictKind>(["createExisting", "serialization"])(
    "round-trips the %s kind through Thresh's value codec as its own class",
    (kind) => {
      const original = new WriteConflictException(kind, "conflict");

      const revived = deserializeValue<WriteConflictException>(serializeValue(original));

      expect(revived).toBeInstanceOf(WriteConflictException);
      expect(revived.kind).toBe(kind);
      expect(revived.message).toBe("conflict");
    },
  );
});
