import { status } from "@grpc/grpc-js";
import {
  ContextualizedCaveat,
  type ObjectReference,
  type Relationship,
  type RelationshipUpdate,
} from "@benedb/protos/authzed/api/v1/core";
import type { WriteRelationshipsRequest } from "@benedb/protos/authzed/api/v1/permission_service";
import { Struct } from "@benedb/protos/google/protobuf/struct";

import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `src/Spiceport.Api/RequestLimits.cs`.
 *
 * Request-shape limit validation at the gRPC service boundary, mirroring SpiceDB's
 * `permissionServer` request contract (see `internal/services/v1/relationships.go`
 * `WriteRelationships` and `internal/services/v1/permissions.go` `GetCaveatContext`).
 *
 * SpiceDB validates a request's shape BEFORE applying/evaluating it and returns `InvalidArgument`
 * for an over-limit or malformed request. Without these guards an oversized or duplicate-bearing
 * request is silently accepted, diverging from what `zed` and other clients expect. The limit
 * values are SpiceDB's defaults.
 *
 * Port decisions:
 *   * A C# `internal static class` is a namespace, not a value, so it becomes sibling `const` and
 *     `function` bindings; the constants are SCREAMING_SNAKE per this repo's convention.
 *   * `CalculateSize()` is the SERIALIZED protobuf byte length. In ts-proto that is
 *     `Message.encode(x).finish().length` - never a string length and never a UTF-16 char count.
 *   * A `Struct`-typed proto field is auto-unwrapped by ts-proto to a plain object, so the
 *     caveat-context size is measured by wrapping it back into a `Struct` before encoding.
 */

/** Maximum updates per `WriteRelationships` call (SpiceDB default). */
export const MAX_UPDATES_PER_WRITE = 1000;

/** Maximum preconditions per write/delete call (SpiceDB default). */
export const MAX_PRECONDITIONS_COUNT = 1000;

/** Maximum serialized bytes of a single relationship's caveat context (SpiceDB default). */
export const MAX_RELATIONSHIP_CONTEXT_SIZE = 25_000;

/** Maximum serialized bytes of a request's caveat context (SpiceDB default). */
export const MAX_CAVEAT_CONTEXT_SIZE = 4096;

/**
 * Maximum bytes of a request's `optional_transaction_metadata`, serialized as JSON (SpiceDB:
 * `MaximumTransactionMetadataSize`, `internal/services/v1/relationships.go`) - "Limited by the BLOB
 * size used in MySQL driver".
 */
export const MAX_TRANSACTION_METADATA_SIZE = 65_000;

/**
 * Validates the shape of a `WriteRelationships` request, throwing an {@link RpcError} with
 * `INVALID_ARGUMENT` for: more than {@link MAX_UPDATES_PER_WRITE} updates
 * (ERROR_REASON_TOO_MANY_UPDATES_IN_REQUEST), more than {@link MAX_PRECONDITIONS_COUNT}
 * preconditions, a missing `relationship`/`relationship.resource`/`relationship.subject`/
 * `relationship.subject.object` submessage, a relationship appearing in more than one update
 * (NewDuplicateRelationshipErr), or a per-relationship caveat context larger than
 * {@link MAX_RELATIONSHIP_CONTEXT_SIZE} bytes. Mirrors SpiceDB's `WriteRelationships` validation.
 */
export function validateWriteRelationships(request: WriteRelationshipsRequest): void {
  // SpiceDB validates the request message (protoc-gen-validate) before its handler runs, so a
  // missing required submessage is reported ahead of the update-count and precondition limits.
  const relationships = request.updates.map(requireRelationshipShape);

  // The handler then checks the metadata size ahead of the update and precondition limits.
  validateTransactionMetadataSize(request.optionalTransactionMetadata);

  if (request.updates.length > MAX_UPDATES_PER_WRITE)
    throw new RpcError(
      status.INVALID_ARGUMENT,
      `too many updates (${request.updates.length}) for WriteRelationships call ` +
        `(maximum: ${MAX_UPDATES_PER_WRITE}); consider using ImportBulkRelationships API instead`,
    );

  if (request.optionalPreconditions.length > MAX_PRECONDITIONS_COUNT)
    throw new RpcError(
      status.INVALID_ARGUMENT,
      `precondition count of ${request.optionalPreconditions.length} is greater than ` +
        `maximum allowed of ${MAX_PRECONDITIONS_COUNT}`,
    );

  // A relationship can be specified in an update only once per overall request. The key ignores the
  // caveat and expiration (SpiceDB: V1StringRelationshipWithoutCaveatOrExpiration), so a CREATE and a
  // DELETE of the same tuple in one request is also a duplicate.
  const seen = new Set<string>();
  for (const relationship of relationships) {
    const key = relationshipKeyWithoutCaveatOrExpiration(relationship);
    if (seen.has(key))
      throw new RpcError(
        status.INVALID_ARGUMENT,
        `found more than one update with relationship \`${key}\` in this request; ` +
          "a relationship can only be specified in an update once per overall " +
          "WriteRelationships request",
      );
    seen.add(key);

    // proto.Size of the caveat: a relationship with no caveat is size 0 and is always allowed.
    const caveat = relationship.optionalCaveat;
    const contextSize =
      caveat === undefined ? 0 : ContextualizedCaveat.encode(caveat).finish().length;
    if (contextSize > MAX_RELATIONSHIP_CONTEXT_SIZE)
      throw new RpcError(
        status.INVALID_ARGUMENT,
        `provided relationship \`${key}\` exceeded maximum allowed caveat size of ` +
          `${MAX_RELATIONSHIP_CONTEXT_SIZE}`,
      );
  }
}

/**
 * Rejects a request whose caveat context exceeds {@link MAX_CAVEAT_CONTEXT_SIZE} serialized bytes,
 * mirroring SpiceDB's `GetCaveatContext`. A zero-or-less limit means "no limit"; here the limit is
 * a positive constant so it always applies. Returns the (unchanged) context for fluent use.
 */
export function validateCaveatContextSize(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (context !== undefined) {
    const size = Struct.encode(Struct.wrap(context)).finish().length;
    if (size > MAX_CAVEAT_CONTEXT_SIZE)
      throw new RpcError(
        status.INVALID_ARGUMENT,
        `request caveat context should have less than ${MAX_CAVEAT_CONTEXT_SIZE} bytes ` +
          `but had ${size}`,
      );
  }

  return context;
}

/** A `Relationship` whose required submessages are known to be present. */
type ShapedRelationship = Relationship & { resource: ObjectReference; subject: ShapedSubject };
type ShapedSubject = { object: ObjectReference; optionalRelation: string };

/** protoc-gen-validate's separator between a failed field and the nested failure it wraps. */
const EMBEDDED = "embedded message failed validation | caused by: ";

/**
 * Rejects an update whose `relationship`, `relationship.resource`, `relationship.subject`, or
 * `relationship.subject.object` is missing, with SpiceDB's own INVALID_ARGUMENT message: its
 * protoc-gen-validate request validation at the service boundary (verified against a real SpiceDB
 * container). ts-proto leaves an absent required submessage as `undefined` rather than a default
 * instance, so without this guard a malformed request throws a raw `TypeError` - an UNKNOWN server
 * fault - before it can be reported.
 */
function requireRelationshipShape(update: RelationshipUpdate, index: number): ShapedRelationship {
  const invalid = (cause: string): RpcError =>
    new RpcError(
      status.INVALID_ARGUMENT,
      `invalid WriteRelationshipsRequest.Updates[${index}]: ${EMBEDDED}${cause}`,
    );
  const inRelationship = (cause: string): string =>
    `invalid RelationshipUpdate.Relationship: ${EMBEDDED}${cause}`;

  const relationship = update.relationship;
  if (relationship === undefined)
    throw invalid("invalid RelationshipUpdate.Relationship: value is required");

  if (relationship.resource === undefined)
    throw invalid(inRelationship("invalid Relationship.Resource: value is required"));

  if (relationship.subject === undefined)
    throw invalid(inRelationship("invalid Relationship.Subject: value is required"));

  if (relationship.subject.object === undefined)
    throw invalid(
      inRelationship(
        `invalid Relationship.Subject: ${EMBEDDED}invalid SubjectReference.Object: value is required`,
      ),
    );

  return relationship as ShapedRelationship;
}

/**
 * Rejects `optional_transaction_metadata` larger than {@link MAX_TRANSACTION_METADATA_SIZE} bytes,
 * mirroring SpiceDB's `validateTransactionMetadata`. The size is the metadata's JSON-serialized byte
 * length (`(*structpb.Struct).MarshalJSON`), NOT a protobuf-encoded size - a deliberate difference
 * from {@link validateCaveatContextSize}. An absent metadata is always allowed.
 */
export function validateTransactionMetadataSize(
  metadata: Record<string, unknown> | undefined,
): void {
  if (metadata === undefined) return;

  const size = new TextEncoder().encode(JSON.stringify(metadata)).length;
  if (size > MAX_TRANSACTION_METADATA_SIZE)
    throw new RpcError(
      status.INVALID_ARGUMENT,
      `metadata size of ${size} is greater than maximum allowed of ${MAX_TRANSACTION_METADATA_SIZE}`,
    );
}

function relationshipKeyWithoutCaveatOrExpiration(rel: ShapedRelationship): string {
  const subject = rel.subject;
  const subjectRelation = !subject.optionalRelation ? "" : "#" + subject.optionalRelation;
  return (
    `${rel.resource.objectType}:${rel.resource.objectId}#${rel.relation}@` +
    `${subject.object.objectType}:${subject.object.objectId}${subjectRelation}`
  );
}
