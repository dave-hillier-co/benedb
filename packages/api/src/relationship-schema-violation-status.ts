import { status } from "@grpc/grpc-js";
import type { RelationshipSchemaViolationException } from "@benedb/grains/relationship-schema-violation-exception";

import { RpcError } from "./rpc-error";

/**
 * Maps a write-time schema violation to SpiceDB's status code for it
 * (`internal/services/shared/errors.go` and `internal/relationships/errors.go`): an unknown
 * definition or relation is FAILED_PRECONDITION (`NamespaceNotFoundError` /
 * `RelationNotFoundError`); a write to a permission or a disallowed subject type is
 * INVALID_ARGUMENT (`CannotWriteToPermissionError` / `InvalidSubjectTypeError`). The message is
 * carried verbatim.
 */
export function relationshipSchemaViolationRpcError(
  error: RelationshipSchemaViolationException,
): RpcError {
  switch (error.reason) {
    case "unknownDefinition":
    case "unknownRelation":
      return new RpcError(status.FAILED_PRECONDITION, error.message);
    case "cannotWriteToPermission":
    case "invalidSubjectType":
      return new RpcError(status.INVALID_ARGUMENT, error.message);
  }
}
