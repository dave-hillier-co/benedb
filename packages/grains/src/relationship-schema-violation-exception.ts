import type { RelationshipTypeReason } from "@benedb/engine/relationship-schema-validator";
import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * Thrown when a `WriteRelationships` / `ImportBulkRelationships` update does not match the schema
 * the commit is gated on: an unknown resource or subject definition, an unknown relation or
 * subrelation, a write to a permission, or a subject type / caveat / expiration the relation does
 * not allow. Nothing from the request commits. Mirrors SpiceDB's write-time
 * `relationships.ValidateRelationshipUpdates` (`internal/services/v1/relationships.go`), which
 * validates every update against the schema reader inside the same transaction that applies them.
 *
 * `RelationshipsGrain` re-wraps `@benedb/engine`'s `RelationshipTypeException` in this one
 * boundary-crossing exception (the same shape `WriteConflictException` uses), carrying the
 * {@link RelationshipTypeReason} the gRPC front door needs to pick SpiceDB's status code:
 * FAILED_PRECONDITION for an unknown definition/relation, INVALID_ARGUMENT for a write to a
 * permission or a disallowed subject type.
 */
export class RelationshipSchemaViolationException extends Error {
  /** Which SpiceDB validation error this is. */
  readonly reason: RelationshipTypeReason;

  /** Creates the exception carrying the schema-validator's reason and message, verbatim. */
  constructor(reason: RelationshipTypeReason, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "RelationshipSchemaViolationException";
    this.reason = reason;
  }
}

registerSurrogate<RelationshipSchemaViolationException>({
  tag: "benedb.relationshipSchemaViolationException",
  test: (value) => value instanceof RelationshipSchemaViolationException,
  encode: (error) => ({ reason: error.reason, message: error.message }),
  decode: (fields) =>
    new RelationshipSchemaViolationException(
      fields.reason as RelationshipTypeReason,
      fields.message as string,
    ),
});
