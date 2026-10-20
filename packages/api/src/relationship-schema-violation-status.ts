import { status } from "@grpc/grpc-js";
import type { RelationshipSchemaViolationException } from "@benedb/grains/relationship-schema-violation-exception";
import { ErrorReason } from "@benedb/protos/authzed/api/v1/error_reason";

import type { RpcError } from "./rpc-error";
import { rpcErrorWithReason } from "./rpc-errors";

/**
 * Maps a write-time schema violation to SpiceDB's status code for it
 * (`internal/services/shared/errors.go` and `internal/relationships/errors.go`): an unknown
 * definition or relation is FAILED_PRECONDITION (`NamespaceNotFoundError` /
 * `RelationNotFoundError`); a write to a permission or a disallowed subject type is
 * INVALID_ARGUMENT (`CannotWriteToPermissionError` / `InvalidSubjectTypeError`). The message is
 * carried verbatim.
 *
 * Each carries the `ErrorInfo` its SpiceDB error type does (Spiceport's
 * `AuthzedPermissionsV1Service.ToRpc(RelationshipValidationException)`): UNKNOWN_DEFINITION /
 * UNKNOWN_RELATION_OR_PERMISSION (through `rewriteError`), CANNOT_UPDATE_PERMISSION, or
 * INVALID_SUBJECT_TYPE with the subject type and, when it lacked a required caveat, the allowed
 * caveats.
 */
export function relationshipSchemaViolationRpcError(
  error: RelationshipSchemaViolationException,
): RpcError {
  const facts = error.facts;
  switch (error.reason) {
    case "unknownDefinition":
      return rpcErrorWithReason(
        status.FAILED_PRECONDITION,
        error.message,
        ErrorReason.ERROR_REASON_UNKNOWN_DEFINITION,
        [["definition_name", facts.definitionName]],
      );
    case "unknownRelation":
      return rpcErrorWithReason(
        status.FAILED_PRECONDITION,
        error.message,
        ErrorReason.ERROR_REASON_UNKNOWN_RELATION_OR_PERMISSION,
        [
          ["definition_name", facts.definitionName],
          ["relation_or_permission_name", facts.relationName ?? ""],
        ],
      );
    case "cannotWriteToPermission":
      return rpcErrorWithReason(
        status.INVALID_ARGUMENT,
        error.message,
        ErrorReason.ERROR_REASON_CANNOT_UPDATE_PERMISSION,
        [
          ["definition_name", facts.definitionName],
          ["permission_name", facts.relationName ?? ""],
        ],
      );
    case "invalidSubjectType": {
      const metadata: [string, string][] = [
        ["definition_name", facts.definitionName],
        ["relation_name", facts.relationName ?? ""],
        ["subject_type", facts.subjectType ?? ""],
      ];
      if (facts.allowedCaveats !== undefined)
        metadata.push(["allowed_caveats", facts.allowedCaveats]);
      return rpcErrorWithReason(
        status.INVALID_ARGUMENT,
        error.message,
        ErrorReason.ERROR_REASON_INVALID_SUBJECT_TYPE,
        metadata,
      );
    }
  }
}
