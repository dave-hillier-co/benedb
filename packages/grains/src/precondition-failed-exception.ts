import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * Which way a precondition can fail: a MUST_MATCH whose filter matched nothing, or a
 * MUST_NOT_MATCH whose filter matched something.
 *
 * PORT DECISION. Not wire-numeric - the API layer turns the whole exception into a gRPC
 * `FailedPrecondition` and the kind only picks the message - so a string-literal union with no wire
 * map, per the port guide.
 *
 * - `mustMatchFoundNone`: the filter was required to match at least one relationship, but matched
 *   none.
 * - `mustNotMatchFoundOne`: the filter was required to match nothing, but matched at least one
 *   relationship.
 */
export type PreconditionFailureKind = "mustMatchFoundNone" | "mustNotMatchFoundOne";

/**
 * Thrown inside a write transaction when a precondition is not satisfied against the snapshot the
 * writes would commit at. The transaction is abandoned (nothing commits). Maps to gRPC
 * `FailedPrecondition`. Mirrors SpiceDB's precondition-failed error.
 *
 * The C#'s `[GenerateSerializer]` becomes the surrogate registered below: the grain throws it, and
 * the gRPC front door catches it and maps it to FailedPrecondition.
 */
export class PreconditionFailedException extends Error {
  /** How the precondition failed. */
  readonly kind: PreconditionFailureKind;

  /** The zero-based index of the failing precondition within the request. */
  readonly preconditionIndex: number;

  /** Creates the exception describing the failing precondition. */
  constructor(kind: PreconditionFailureKind, preconditionIndex: number, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "PreconditionFailedException";
    this.kind = kind;
    this.preconditionIndex = preconditionIndex;
  }
}

// All three fields cross, unlike the datastore exceptions whose messages are derived: the
// reconstruction here is byte-exact. `DatastoreGrain.commit` returns the message as
// `CommitFailureWire.detail`, the relationships grain parses it back with
// `tryParsePreconditionFailure`, and the exception a caller observes must be indistinguishable from
// the one an inline evaluation would have thrown - so the message is distinguishing state, not a
// derivable convenience.
registerSurrogate<PreconditionFailedException>({
  tag: "spacedb.preconditionFailedException",
  test: (value) => value instanceof PreconditionFailedException,
  encode: (error) => ({
    kind: error.kind,
    preconditionIndex: error.preconditionIndex,
    message: error.message,
  }),
  decode: (fields) =>
    new PreconditionFailedException(
      fields.kind as PreconditionFailureKind,
      fields.preconditionIndex as number,
      fields.message as string,
    ),
});
