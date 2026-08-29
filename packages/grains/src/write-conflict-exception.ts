import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * Distinguishes the two write-conflict conditions SpiceDB maps to DIFFERENT gRPC codes.
 *
 * - `createExisting`: a CREATE update targeted an already-existing relationship. A permanent
 *   duplicate-create (SpiceDB's `CreateRelationshipExistsError`); maps to gRPC `AlreadyExists`. The
 *   client must NOT blindly retry it as a transient conflict.
 * - `serialization`: a genuine write-write serialization failure at commit (SpiceDB's
 *   `SerializationError`); maps to gRPC `Aborted` so the client retries the whole transaction.
 *
 * PORT DECISION. Not wire-numeric; a string-literal union with no wire map, per the port guide.
 */
export type WriteConflictKind = "createExisting" | "serialization";

/**
 * Thrown by the relationships grain when a write fails to commit because of a conflict. The
 * underlying datastore exceptions (`CreateRelationshipExistsException` / `SerializationException`)
 * belong to a layer that must not take a runtime dependency, so the grain re-wraps them in this one
 * boundary-crossing exception, preserving the {@link WriteConflictKind} the gRPC front door needs to
 * pick the correct status code (AlreadyExists vs. Aborted).
 */
export class WriteConflictException extends Error {
  /** Which conflict condition occurred. */
  readonly kind: WriteConflictKind;

  /** Creates the exception for the given conflict kind and message. */
  constructor(kind: WriteConflictKind, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "WriteConflictException";
    this.kind = kind;
  }
}

registerSurrogate<WriteConflictException>({
  tag: "spacedb.writeConflictException",
  test: (value) => value instanceof WriteConflictException,
  encode: (error) => ({ kind: error.kind, message: error.message }),
  decode: (fields) =>
    new WriteConflictException(fields.kind as WriteConflictKind, fields.message as string),
});
