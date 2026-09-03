import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * Thrown when a client resumes a LookupResources/LookupSubjects stream with a cursor that cannot be
 * honoured: a malformed token, or a well-formed token minted for a request with a different shape
 * (resource type, permission, subject, or caveat context). Maps to gRPC `InvalidArgument` -
 * mirrors SpiceDB's "cursor does not apply to this request" error.
 *
 * The C#'s `[GenerateSerializer]` (annotated for symmetry with the other typed front-door
 * exceptions) becomes the surrogate registered below, so it round-trips the grain boundary should
 * a grain-hosted caller ever surface it.
 */
export class InvalidCursorException extends Error {
  /** Creates the exception with a human-readable reason. */
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "InvalidCursorException";
  }
}

registerSurrogate<InvalidCursorException>({
  tag: "benedb.invalidCursorException",
  test: (value) => value instanceof InvalidCursorException,
  encode: (error) => ({ message: error.message }),
  decode: (fields) => new InvalidCursorException(fields.message as string),
});
