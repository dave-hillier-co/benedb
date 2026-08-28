import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * Thrown when a consistency requirement cannot be honoured: a malformed token, a token from a
 * different datastore where that is an error (at-exact-snapshot), or an exact snapshot revision
 * that is no longer available. Maps to gRPC `InvalidArgument` / `FailedPrecondition`.
 *
 * The C# carries NO discriminator for which of the two applies - the choice belongs to the call
 * site that catches it - so the port invents no `kind` enum here.
 *
 * The resolver throws this inside a grain, so it crosses the grain boundary. Thresh serializes a
 * bare `Error` subclass down to an empty object, so the surrogate registered at the bottom of
 * this module is what keeps the message - the only thing distinguishing the two cases - alive in
 * transit. Importing this module performs the registration.
 */
export class InvalidConsistencyTokenException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConsistencyTokenException";
  }
}

registerSurrogate<InvalidConsistencyTokenException>({
  tag: "spacedb.invalidConsistencyTokenException",
  test: (value) => value instanceof InvalidConsistencyTokenException,
  encode: (error) => ({ message: error.message }),
  decode: (fields) => new InvalidConsistencyTokenException(fields.message as string),
});
