import { status } from "@grpc/grpc-js";
import {
  ContextualizedCaveat,
  type ObjectReference,
  Relationship,
} from "@benedb/protos/authzed/api/v1/core";
import { ErrorReason } from "@benedb/protos/authzed/api/v1/error_reason";
import type { WriteRelationshipsRequest } from "@benedb/protos/authzed/api/v1/permission_service";
import { Struct } from "@benedb/protos/google/protobuf/struct";

import { full, withoutCaveatOrExpiration } from "./go-relationship-strings";
import { RpcError } from "./rpc-error";
import { rpcErrorWithReason } from "./rpc-errors";

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
 * `INVALID_ARGUMENT` for, in SpiceDB's order: transaction metadata over
 * {@link MAX_TRANSACTION_METADATA_SIZE} bytes, more than {@link MAX_UPDATES_PER_WRITE} updates
 * (ERROR_REASON_TOO_MANY_UPDATES_IN_REQUEST), more than {@link MAX_PRECONDITIONS_COUNT}
 * preconditions, a relationship appearing in more than one update (NewDuplicateRelationshipErr),
 * or a per-relationship caveat context larger than {@link MAX_RELATIONSHIP_CONTEXT_SIZE} bytes.
 * Mirrors SpiceDB's `WriteRelationships` handler. The request must already have passed
 * `validateRequest` (`request-validation.ts`), as it has in SpiceDB by the time its handler runs,
 * so every update carries its required submessages.
 */
export function validateWriteRelationships(request: WriteRelationshipsRequest): void {
  const relationships = request.updates.map((update) => update.relationship as ShapedRelationship);

  // The handler then checks the metadata size ahead of the update and precondition limits.
  validateTransactionMetadataSize(request.optionalTransactionMetadata);

  if (request.updates.length > MAX_UPDATES_PER_WRITE)
    throw rpcErrorWithReason(
      status.INVALID_ARGUMENT,
      `too many updates (${request.updates.length}) for WriteRelationships call ` +
        `(maximum: ${MAX_UPDATES_PER_WRITE}); consider using ImportBulkRelationships API instead`,
      ErrorReason.ERROR_REASON_TOO_MANY_UPDATES_IN_REQUEST,
      [
        ["update_count", String(request.updates.length)],
        ["maximum_updates_allowed", String(MAX_UPDATES_PER_WRITE)],
      ],
    );

  if (request.optionalPreconditions.length > MAX_PRECONDITIONS_COUNT)
    throw rpcErrorWithReason(
      status.INVALID_ARGUMENT,
      `precondition count of ${request.optionalPreconditions.length} is greater than ` +
        `maximum allowed of ${MAX_PRECONDITIONS_COUNT}`,
      ErrorReason.ERROR_REASON_TOO_MANY_PRECONDITIONS_IN_REQUEST,
      [
        ["precondition_count", String(request.optionalPreconditions.length)],
        // SpiceDB's ExceedsMaximumPreconditionsError reuses the updates key for its maximum.
        ["maximum_updates_allowed", String(MAX_PRECONDITIONS_COUNT)],
      ],
    );

  // A relationship can be specified in an update only once per overall request. The key ignores the
  // caveat and expiration (SpiceDB: V1StringRelationshipWithoutCaveatOrExpiration), so a CREATE and a
  // DELETE of the same tuple in one request is also a duplicate.
  const seen = new Set<string>();
  for (const relationship of relationships) {
    const key = withoutCaveatOrExpiration(relationship);
    if (seen.has(key))
      throw rpcErrorWithReason(
        status.INVALID_ARGUMENT,
        `found more than one update with relationship \`${key}\` in this request; ` +
          "a relationship can only be specified in an update once per overall " +
          "WriteRelationships request",
        ErrorReason.ERROR_REASON_UPDATES_ON_SAME_RELATIONSHIP,
        [
          ["definition_name", relationship.resource.objectType],
          ["relationship", full(relationship)],
        ],
      );
    seen.add(key);

    // proto.Size of the caveat: a relationship with no caveat is size 0 and is always allowed.
    const caveat = relationship.optionalCaveat;
    const contextSize =
      caveat === undefined ? 0 : ContextualizedCaveat.encode(caveat).finish().length;
    if (contextSize > MAX_RELATIONSHIP_CONTEXT_SIZE)
      throw rpcErrorWithReason(
        status.INVALID_ARGUMENT,
        `provided relationship \`${key}\` exceeded maximum allowed caveat size of ` +
          `${MAX_RELATIONSHIP_CONTEXT_SIZE}`,
        ErrorReason.ERROR_REASON_MAX_RELATIONSHIP_CONTEXT_SIZE,
        [
          ["relationship", key],
          ["max_allowed_size", String(MAX_RELATIONSHIP_CONTEXT_SIZE)],
          // SpiceDB reports proto.Size of the whole relationship here, not of its caveat.
          ["context_size", String(Relationship.encode(relationship).finish().length)],
        ],
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
    throw rpcErrorWithReason(
      status.INVALID_ARGUMENT,
      `metadata size of ${size} is greater than maximum allowed of ${MAX_TRANSACTION_METADATA_SIZE}`,
      ErrorReason.ERROR_REASON_TRANSACTION_METADATA_TOO_LARGE,
      [
        ["metadata_byte_size", String(size)],
        ["maximum_allowed_metadata_byte_size", String(MAX_TRANSACTION_METADATA_SIZE)],
      ],
    );
}
