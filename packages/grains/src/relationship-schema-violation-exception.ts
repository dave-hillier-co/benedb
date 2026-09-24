import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * Thrown when a `WriteRelationships` update does not match the live schema: an unknown resource
 * definition, an unknown relation/permission, a subject type/subrelation the relation's schema does
 * not allow, or a caveat the relation does not permit. Nothing from the request commits. Mirrors
 * SpiceDB's write-time `relationships.ValidateRelationshipsForCreateOrTouch`
 * (`internal/services/v1/relationships.go`), which validates every update against the schema reader
 * inside the same transaction that applies them, before persisting.
 *
 * `RelationshipsGrain.writeRelationships` re-wraps `@benedb/engine`'s `RelationshipTypeException`
 * in this one boundary-crossing exception (the same shape `SchemaWriteValidationException` and
 * `WriteConflictException` already use) so the gRPC front door can map it without depending on the
 * engine package, and so it round-trips the grain boundary via the surrogate registered below.
 */
export class RelationshipSchemaViolationException extends Error {
  /** Creates the exception carrying the schema-validator's own message, verbatim. */
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "RelationshipSchemaViolationException";
  }
}

// The message is the sole distinguishing state.
registerSurrogate<RelationshipSchemaViolationException>({
  tag: "benedb.relationshipSchemaViolationException",
  test: (value) => value instanceof RelationshipSchemaViolationException,
  encode: (error) => ({ message: error.message }),
  decode: (fields) => new RelationshipSchemaViolationException(fields.message as string),
});
