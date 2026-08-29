import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * Thrown when a schema write would leave existing relationships dangling: a removed definition,
 * relation, or allowed subject type that written relationships still reference. The schema swap and
 * the persisting transaction are abandoned (nothing changes). Maps to gRPC `FailedPrecondition`.
 * Mirrors SpiceDB's schema-write data-validation error.
 *
 * The C#'s `[GenerateSerializer]` becomes the surrogate registered below - it crosses the grain
 * boundary, and if it did not come back as its own class the dispatch mapper would collapse it to
 * `internal`.
 */
export class SchemaWriteValidationException extends Error {
  /** Creates the exception naming the offending definition/relation and an example relationship. */
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "SchemaWriteValidationException";
  }
}

// The message is the sole distinguishing state.
registerSurrogate<SchemaWriteValidationException>({
  tag: "spacedb.schemaWriteValidationException",
  test: (value) => value instanceof SchemaWriteValidationException,
  encode: (error) => ({ message: error.message }),
  decode: (fields) => new SchemaWriteValidationException(fields.message as string),
});
