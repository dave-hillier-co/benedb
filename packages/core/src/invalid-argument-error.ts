import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * The port's stand-in for C# `ArgumentException`: an argument was missing, empty, or otherwise
 * not usable. One class, reused everywhere Spiceport throws `ArgumentException`, so the API
 * layer has a single thing to map onto gRPC `InvalidArgument`.
 *
 * It CROSSES GRAIN BOUNDARIES - `RelationshipsGrain.writeSchema` converts a compile failure into
 * one, exactly as the C# grain converts it into an `ArgumentException` - and Orleans round-trips
 * `ArgumentException` as its own type, so the caller's `catch (ArgumentException)` holds. Thresh
 * degrades an unregistered `Error` subclass to a `GrainCallError` carrying only the message, which
 * makes `PermissionsGrpcService`'s `instanceof InvalidArgumentError` arm miss and an invalid
 * schema surface UNMAPPED instead of as `INVALID_ARGUMENT`. The surrogate below is what keeps the
 * class alive in transit; importing this module performs the registration.
 */
export class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidArgumentError";
  }
}

// The message is the sole distinguishing state.
registerSurrogate<InvalidArgumentError>({
  tag: "benedb.invalidArgumentError",
  test: (value) => value instanceof InvalidArgumentError,
  encode: (error) => ({ message: error.message }),
  decode: (fields) => new InvalidArgumentError(fields.message as string),
});
