import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * Thrown when a DeleteRelationships with a limit but WITHOUT partial deletions allowed matches more
 * relationships than the limit: the whole delete is rejected transactionally (nothing applied).
 * Maps to gRPC `InvalidArgument`. Mirrors SpiceDB's `CouldNotTransactionallyDeleteError` (reason
 * `ERROR_REASON_TOO_MANY_RELATIONSHIPS_FOR_TRANSACTIONAL_DELETE`) with the same message text.
 *
 * The C#'s `[GenerateSerializer]` becomes the surrogate registered below: it round-trips across the
 * grain boundary (the grain throws it; the gRPC front door catches it and maps to InvalidArgument).
 */
export class DeleteLimitExceededException extends Error {
  /** The requested delete limit that the matching row count exceeded (`ulong`). */
  readonly limit: bigint;

  /** Creates the exception for the exceeded limit (SpiceDB-verbatim message). */
  constructor(limit: bigint) {
    super(
      `found more than ${limit} relationships to be deleted and partial deletion was not requested`,
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "DeleteLimitExceededException";
    this.limit = limit;
  }
}

registerSurrogate<DeleteLimitExceededException>({
  tag: "benedb.deleteLimitExceededException",
  test: (value) => value instanceof DeleteLimitExceededException,
  encode: (error) => ({ limit: error.limit }),
  decode: (fields) => new DeleteLimitExceededException(fields.limit as bigint),
});
