import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import {
  CounterAlreadyRegisteredException,
  CounterNotRegisteredException,
  CreateRelationshipExistsException,
  DatastoreException,
  InvalidRevisionException,
  RevisionNotFoundException,
  SerializationException,
  WatchDisabledException,
} from "./datastore-exceptions";

// Port of Spiceport `DatastoreExceptions.cs`.
//
// Spiceport's tests assert only the THROWN TYPE - ReferenceDatastoreTests throws
// CreateRelationshipExistsException, RevisionNotFoundException and SerializationException;
// ReferenceDatastoreCounterTests throws CounterAlreadyRegisteredException and
// CounterNotRegisteredException and reads back `ex.CounterName` - and never the message. Those
// tests belong to the MVCC layer this port has not reached; the type identity, the carried data
// and the message text they depend on are pinned here instead.
//
// The messages are load-bearing even though no C# test asserts them:
// CreateRelationshipExistsException reproduces real SpiceDB's `CreateRelationshipExistsError`
// verbatim (observed v1.49.2, identical on WriteRelationships and ImportBulkRelationships)
// because clients key on the string. So it is pinned here, exactly.
//
// Port decisions pinned here:
//
// 1. This is a deliberately MULTI-EXPORT file, per the port ledger - the one exception to the
//    one-primary-export rule, because the hierarchy only makes sense together.
//
// 2. The `...Exception` names are kept rather than renamed to `...Error`, following core's
//    precedent (CaveatEvaluationException, InvalidConsistencyTokenException).
//
// 3. Every class needs `Object.setPrototypeOf(this, new.target.prototype)` and an explicit
//    `this.name`, so `instanceof` survives downlevelling - that is what every "is an instance
//    of" assertion below is really gating.
//
// 4. The four that cross a grain boundary as reply data - SerializationException,
//    CreateRelationshipExistsException (carrying Relationship), CounterAlreadyRegistered /
//    CounterNotRegistered (carrying CounterName) - must be registered with Thresh's value codec
//    or they arrive as plain Errors and the caller can no longer choose a gRPC status.
//
// 5. `DatastoreException`'s two-arg (message, inner) form maps onto the ES2022 `{ cause }`
//    option.
describe("datastore exception", () => {
  it("carries a message", () => {
    const error = new DatastoreException("boom");

    expect(error.message).toBe("boom");
    expect(error.name).toBe("DatastoreException");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DatastoreException);
  });

  it("carries an inner exception as the ES2022 cause", () => {
    const inner = new Error("underlying");
    const error = new DatastoreException("boom", inner);

    expect(error.message).toBe("boom");
    expect(error.cause).toBe(inner);
  });

  it("is not sealed - it is the base every datastore error derives from", () => {
    expect(new RevisionNotFoundException(new TimestampRevision(1n))).toBeInstanceOf(
      DatastoreException,
    );
    expect(new SerializationException()).toBeInstanceOf(DatastoreException);
    expect(new CreateRelationshipExistsException("x")).toBeInstanceOf(DatastoreException);
    expect(new InvalidRevisionException("x")).toBeInstanceOf(DatastoreException);
    expect(new CounterAlreadyRegisteredException("c")).toBeInstanceOf(DatastoreException);
    expect(new WatchDisabledException("x")).toBeInstanceOf(DatastoreException);
    expect(new CounterNotRegisteredException("c")).toBeInstanceOf(DatastoreException);
  });

  it("is catchable as itself", () => {
    expect(() => {
      throw new SerializationException();
    }).toThrow(DatastoreException);
    expect(() => {
      throw new SerializationException();
    }).toThrow(SerializationException);
  });
});

describe("revision not found exception", () => {
  it("interpolates the revision by its string form", () => {
    // `$"revision {revision} is no longer available"` calls ToString(), which for a
    // TimestampRevision is the bare nanos - never the object.
    const revision = new TimestampRevision(1700000000000000000n);
    const error = new RevisionNotFoundException(revision);

    expect(error.message).toBe("revision 1700000000000000000 is no longer available");
  });

  it("carries the revision that could not be found", () => {
    const revision = new TimestampRevision(42n);
    const error = new RevisionNotFoundException(revision);

    expect(error.revision).toBe(revision);
    expect(error.name).toBe("RevisionNotFoundException");
  });
});

describe("serialization exception", () => {
  it("defaults its message", () => {
    // A write-write conflict at commit; SpiceDB maps it to gRPC Aborted so the client retries
    // the whole transaction.
    expect(new SerializationException().message).toBe(
      "transaction conflicted with a concurrent write",
    );
  });

  it("accepts an explicit message", () => {
    expect(new SerializationException("touch conflicted").message).toBe("touch conflicted");
  });

  it("is distinct from a create conflict", () => {
    // Deliberately distinct types: this is transient (Aborted, retry), while
    // CreateRelationshipExistsException is permanent (AlreadyExists, do NOT retry).
    expect(new SerializationException()).not.toBeInstanceOf(CreateRelationshipExistsException);
    expect(new CreateRelationshipExistsException("x")).not.toBeInstanceOf(SerializationException);
  });

  it("round-trips through Thresh's value codec as its own class", () => {
    const revived = deserializeValue<SerializationException>(
      serializeValue(new SerializationException()),
    );

    expect(revived).toBeInstanceOf(SerializationException);
    expect(revived.message).toBe("transaction conflicted with a concurrent write");
  });
});

describe("create relationship exists exception", () => {
  it("reproduces real SpiceDB's CreateRelationshipExistsError message verbatim", () => {
    const error = new CreateRelationshipExistsException("document:doc1#viewer@user:alice");

    expect(error.message).toBe(
      "could not CREATE relationship `document:doc1#viewer@user:alice`, as it already existed. " +
        "If this is persistent, please switch to TOUCH operations or specify a precondition",
    );
  });

  it("carries the already-formatted relationship as data", () => {
    // Carried so a caller shipping the failure across a grain boundary can rebuild this exact
    // exception - the constructor derives the message from it deterministically.
    const error = new CreateRelationshipExistsException("document:doc1#viewer@user:alice");

    expect(error.relationship).toBe("document:doc1#viewer@user:alice");
    expect(error.name).toBe("CreateRelationshipExistsException");
  });

  it("round-trips through Thresh's value codec as its own class", () => {
    const original = new CreateRelationshipExistsException("document:doc1#viewer@user:alice");

    const revived = deserializeValue<CreateRelationshipExistsException>(serializeValue(original));

    expect(revived).toBeInstanceOf(CreateRelationshipExistsException);
    expect(revived.relationship).toBe(original.relationship);
    expect(revived.message).toBe(original.message);
  });
});

describe("invalid revision exception", () => {
  it("carries a message", () => {
    const error = new InvalidRevisionException("malformed revision `nope`");

    expect(error.message).toBe("malformed revision `nope`");
    expect(error.name).toBe("InvalidRevisionException");
  });

  it("is distinct from a missing revision", () => {
    // Malformed (InvalidArgument) versus garbage-collected (FailedPrecondition): different
    // statuses, so they must not collapse into one type.
    expect(new InvalidRevisionException("x")).not.toBeInstanceOf(RevisionNotFoundException);
  });
});

describe("watch disabled exception", () => {
  it("carries a message", () => {
    // SpiceDB's WatchDisabledErr: Postgres must run with track_commit_timestamp=on.
    const error = new WatchDisabledException("watch is disabled on this datastore");

    expect(error.message).toBe("watch is disabled on this datastore");
    expect(error.name).toBe("WatchDisabledException");
  });
});

describe("counter already registered exception", () => {
  it("interpolates and carries the counter name", () => {
    const error = new CounterAlreadyRegisteredException("c");

    expect(error.message).toBe("counter with name `c` is already registered");
    expect(error.counterName).toBe("c");
    expect(error.name).toBe("CounterAlreadyRegisteredException");
  });

  it("round-trips through Thresh's value codec as its own class", () => {
    const revived = deserializeValue<CounterAlreadyRegisteredException>(
      serializeValue(new CounterAlreadyRegisteredException("viewers")),
    );

    expect(revived).toBeInstanceOf(CounterAlreadyRegisteredException);
    expect(revived.counterName).toBe("viewers");
    expect(revived.message).toBe("counter with name `viewers` is already registered");
  });
});

describe("counter not registered exception", () => {
  it("interpolates and carries the counter name", () => {
    // Note the message is NOT symmetric with the already-registered one: "not found", not "is
    // not registered".
    const error = new CounterNotRegisteredException("nope");

    expect(error.message).toBe("counter with name `nope` not found");
    expect(error.counterName).toBe("nope");
    expect(error.name).toBe("CounterNotRegisteredException");
  });

  it("is distinct from the already-registered exception", () => {
    expect(new CounterNotRegisteredException("c")).not.toBeInstanceOf(
      CounterAlreadyRegisteredException,
    );
  });

  it("round-trips through Thresh's value codec as its own class", () => {
    const revived = deserializeValue<CounterNotRegisteredException>(
      serializeValue(new CounterNotRegisteredException("nope")),
    );

    expect(revived).toBeInstanceOf(CounterNotRegisteredException);
    expect(revived.counterName).toBe("nope");
    expect(revived.message).toBe("counter with name `nope` not found");
  });
});
