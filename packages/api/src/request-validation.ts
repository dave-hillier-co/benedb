import { status } from "@grpc/grpc-js";
import type { ObjectReference, SubjectReference } from "@benedb/protos/authzed/api/v1/core";
import type {
  CheckPermissionRequest,
  DeleteRelationshipsRequest,
  ExpandPermissionTreeRequest,
  Precondition,
  RelationshipFilter,
  WriteRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";

import { validateAll } from "./proto-validation";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `src/Spiceport.Api/RequestValidation.cs`.
 *
 * The request-message validation SpiceDB's service interceptors run before any handler:
 * go-grpc-middleware's `validator` (protoc-gen-validate's `ValidateAll`, see `proto-validation.ts`)
 * and then SpiceDB's `handwrittenvalidation` interceptor, which calls the `HandwrittenValidate`
 * methods authzed-go adds to a few messages (`proto/authzed/api/v1/00_handwritten_validation.go`).
 * Either failure is INVALID_ARGUMENT with the error text as the detail.
 *
 * Every `authzed.api.v1` handler calls {@link validateRequest} first, as SpiceDB's interceptor chain
 * does; a client-streaming handler calls it on each message it receives.
 *
 * Port decisions:
 *   * A ts-proto message carries no type, so the caller names it: `typeName` is the message's name
 *     within `authzed.api.v1` (`"CheckPermissionRequest"`). The C# switches on the CLR type for the
 *     handwritten rules; here they switch on the same name.
 */

/** The request messages `validateRequest` accepts, by their name within `authzed.api.v1`. */
export type RequestTypeName =
  | "CheckPermissionRequest"
  | "CheckBulkPermissionsRequest"
  | "ExpandPermissionTreeRequest"
  | "WriteRelationshipsRequest"
  | "DeleteRelationshipsRequest"
  | "ReadRelationshipsRequest"
  | "LookupResourcesRequest"
  | "LookupSubjectsRequest"
  | "ImportBulkRelationshipsRequest"
  | "ExportBulkRelationshipsRequest"
  | "ReadSchemaRequest"
  | "WriteSchemaRequest"
  | "ReflectSchemaRequest"
  | "DiffSchemaRequest"
  | "ComputablePermissionsRequest"
  | "DependentRelationsRequest"
  | "ExperimentalRegisterRelationshipCounterRequest"
  | "ExperimentalUnregisterRelationshipCounterRequest"
  | "ExperimentalCountRelationshipsRequest"
  | "WatchRequest";

/**
 * Rejects `request` with INVALID_ARGUMENT when it breaks a `(validate.rules)` annotation or one of
 * authzed-go's handwritten rules.
 */
export function validateRequest(typeName: RequestTypeName, request: object): void {
  const violation =
    validateAll(`authzed.api.v1.${typeName}`, request) ?? handwritten(typeName, request);
  if (violation !== undefined) throw new RpcError(status.INVALID_ARGUMENT, violation);
}

const ALPHANUMERIC_REQUIRED = "alphanumeric value is required";

const WILDCARD_RELATION = "optionalrelation must be empty on subject if object ID is a wildcard";

/**
 * authzed-go's `HandwrittenValidate` for the top-level request types that have one; `undefined`
 * when the request passes or its type has none. Each reports the first failure only, as Go's does.
 */
function handwritten(typeName: RequestTypeName, request: object): string | undefined {
  switch (typeName) {
    case "CheckPermissionRequest": {
      const r = request as CheckPermissionRequest;
      return wildcardResource(r.resource) ?? subject(r.subject);
    }
    case "ExpandPermissionTreeRequest":
      return wildcardResource((request as ExpandPermissionTreeRequest).resource);
    case "DeleteRelationshipsRequest": {
      const r = request as DeleteRelationshipsRequest;
      return preconditions(r.optionalPreconditions) ?? filter(r.relationshipFilter);
    }
    case "WriteRelationshipsRequest": {
      const r = request as WriteRelationshipsRequest;
      return preconditions(r.optionalPreconditions) ?? updates(r);
    }
    default:
      return undefined;
  }
}

function preconditions(list: readonly Precondition[]): string | undefined {
  for (const precondition of list) {
    const error = filter(precondition.filter);
    if (error !== undefined) return error;
  }
  return undefined;
}

function updates(request: WriteRelationshipsRequest): string | undefined {
  for (const update of request.updates) {
    const relationship = update.relationship;
    if (relationship === undefined) continue;
    const error = wildcardResource(relationship.resource) ?? subject(relationship.subject);
    if (error !== undefined) return error;
  }
  return undefined;
}

function wildcardResource(resource: ObjectReference | undefined): string | undefined {
  return resource?.objectId === "*"
    ? `invalid ObjectReference.ObjectId: ${ALPHANUMERIC_REQUIRED}`
    : undefined;
}

function subject(reference: SubjectReference | undefined): string | undefined {
  return reference?.object?.objectId === "*" && (reference.optionalRelation ?? "") !== ""
    ? `invalid SubjectReference.OptionalRelation: ${WILDCARD_RELATION}`
    : undefined;
}

function filter(relationshipFilter: RelationshipFilter | undefined): string | undefined {
  if (relationshipFilter === undefined) return undefined;
  if (relationshipFilter.optionalResourceId === "*")
    return `invalid RelationshipFilter.OptionalResourceId: ${ALPHANUMERIC_REQUIRED}`;

  const subjectFilter = relationshipFilter.optionalSubjectFilter;
  return subjectFilter?.optionalSubjectId === "*" &&
    (subjectFilter.optionalRelation?.relation ?? "") !== ""
    ? `invalid SubjectFilter.OptionalRelation: ${WILDCARD_RELATION}`
    : undefined;
}
