import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * The kind of caveat-evaluation failure, used to map onto a gRPC status code. The C# enum
 * becomes a string-literal union; these values are not themselves a wire enum, but the
 * kind -> status mapping at the API layer is load-bearing:
 *
 *   parameterTypeMismatch -> InvalidArgument    (SpiceDB `ParameterTypeError`)
 *   unknownCaveat         -> FailedPrecondition (SpiceDB `CaveatNameNotFoundErr`)
 *
 * Adding a kind without deciding its status silently degrades a caller to Unknown.
 */
export type CaveatEvaluationErrorKind = "parameterTypeMismatch" | "unknownCaveat";

/**
 * Thrown when a caveat cannot be evaluated because the request context is type-incompatible
 * with the caveat's declared parameters, or because a relationship references a caveat that
 * does not exist in the schema.
 *
 * A caveat may be evaluated on a remote silo, so this crosses the grain boundary. Thresh
 * serializes a bare `Error` subclass down to an empty object, so the surrogate registered at
 * the bottom of this module is what keeps `kind` (and therefore the status mapping) alive in
 * transit. Importing this module performs the registration.
 */
export class CaveatEvaluationException extends Error {
  /** The failure kind, used by the API layer to choose a gRPC status code. */
  readonly kind: CaveatEvaluationErrorKind;

  constructor(kind: CaveatEvaluationErrorKind, message: string) {
    super(message);
    this.name = "CaveatEvaluationException";
    this.kind = kind;
  }
}

registerSurrogate<CaveatEvaluationException>({
  tag: "benedb.caveatEvaluationException",
  test: (value) => value instanceof CaveatEvaluationException,
  encode: (error) => ({ kind: error.kind, message: error.message }),
  decode: (fields) =>
    new CaveatEvaluationException(
      fields.kind as CaveatEvaluationErrorKind,
      fields.message as string,
    ),
});
