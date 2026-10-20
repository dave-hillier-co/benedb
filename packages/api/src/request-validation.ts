import { status } from "@grpc/grpc-js";
import type { Cursor, ObjectReference, SubjectReference } from "@benedb/protos/authzed/api/v1/core";
import type {
  CheckPermissionRequest,
  Consistency,
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
 * The request-message validation SpiceDB's interceptors run before any handler, in their order: the
 * consistency middleware's checks (`pkg/middleware/consistency`, in the default chain ahead of the
 * service-specific interceptors), then go-grpc-middleware's `validator` (protoc-gen-validate's `ValidateAll`, see `proto-validation.ts`)
 * and then SpiceDB's `handwrittenvalidation` interceptor, which calls the `HandwrittenValidate`
 * methods authzed-go adds to a few messages (`proto/authzed/api/v1/00_handwritten_validation.go`).
 * Either failure is INVALID_ARGUMENT with the error text as the detail.
 *
 * Every `authzed.api.v1` handler calls {@link validateRequest} first, as SpiceDB's interceptor chain
 * does; a client-streaming handler calls it on each message it receives.
 *
 * Port decisions:
 *   * The C# finds the `consistency` and `optional_cursor` fields from the message descriptor; here
 *     the request types carrying them are listed (they are the types authzed-go gives a
 *     `GetConsistency` / `GetOptionalCursor`).
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
  | "BulkCheckPermissionRequest"
  | "BulkImportRelationshipsRequest"
  | "BulkExportRelationshipsRequest"
  | "ExperimentalReflectSchemaRequest"
  | "ExperimentalDiffSchemaRequest"
  | "ExperimentalComputablePermissionsRequest"
  | "ExperimentalDependentRelationsRequest"
  | "ExperimentalRegisterRelationshipCounterRequest"
  | "ExperimentalUnregisterRelationshipCounterRequest"
  | "ExperimentalCountRelationshipsRequest"
  | "WatchRequest";

/**
 * Rejects `request` with INVALID_ARGUMENT when it breaks a `(validate.rules)` annotation or one of
 * authzed-go's handwritten rules.
 */
export function validateRequest(typeName: RequestTypeName, request: object): void {
  checkConsistency(typeName, request);

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

/** The request types SpiceDB's consistency middleware reads a revision for. */
const HAS_CONSISTENCY: ReadonlySet<RequestTypeName> = new Set<RequestTypeName>([
  "CheckPermissionRequest",
  "CheckBulkPermissionsRequest",
  "ExpandPermissionTreeRequest",
  "ReadRelationshipsRequest",
  "LookupResourcesRequest",
  "LookupSubjectsRequest",
  "ExportBulkRelationshipsRequest",
  "ReflectSchemaRequest",
  "DiffSchemaRequest",
  "ComputablePermissionsRequest",
  "DependentRelationsRequest",
  "BulkCheckPermissionRequest",
  "BulkExportRelationshipsRequest",
  "ExperimentalReflectSchemaRequest",
  "ExperimentalDiffSchemaRequest",
  "ExperimentalComputablePermissionsRequest",
  "ExperimentalDependentRelationsRequest",
]);

/** Of those, the types whose `optional_cursor` supplies the revision when present. */
const HAS_OPTIONAL_CURSOR: ReadonlySet<RequestTypeName> = new Set<RequestTypeName>([
  "ReadRelationshipsRequest",
  "LookupResourcesRequest",
  "LookupSubjectsRequest",
  "ExportBulkRelationshipsRequest",
  "BulkExportRelationshipsRequest",
]);

/**
 * The request checks of SpiceDB's consistency middleware (`addRevisionToContextFromConsistency`),
 * which picks the revision a request with a `consistency` field reads at before the
 * protoc-gen-validate interceptor runs. A present `optional_cursor` supplies the revision and wins;
 * otherwise an absent consistency or `minimize_latency` or `fully_consistent` needs nothing; a
 * ZedToken must decode; and anything else falls to the middleware's default case, INTERNAL
 * `missing handling of consistency case in %v`.
 *
 * Each code and message here is observed from a running SpiceDB v1.49.2 server (`spicedb serve`
 * over memdb, called with an authzed-go v1.7.0 client); none carries status details. The
 * empty-consistency message ends in a space (Go's `%v` of an empty message is empty): a Go client
 * such as `zed` receives it whole, while a grpc-js client receives an empty detail, because Node's
 * HTTP/2 layer drops a header value with leading or trailing whitespace (RFC 9113 section 8.2.1).
 *
 * Only what can be decided without the datastore is reproduced here: the default case, an empty
 * ZedToken (which never decodes: INVALID_ARGUMENT `invalid revision requested`), and an empty cursor
 * token (which decodes to a cursor with no version: INTERNAL `unexpected consistency middleware
 * error: cursor pointer was nil`). A non-empty token or cursor is still resolved in the handler,
 * after field validation, so an undecodable one on an otherwise malformed request reports the field
 * violation where SpiceDB would report the token. Spiceport's cursors are its own format, so
 * SpiceDB's cursor decoding cannot be reproduced at all.
 */
function checkConsistency(typeName: RequestTypeName, request: object): void {
  if (!HAS_CONSISTENCY.has(typeName)) return;

  if (HAS_OPTIONAL_CURSOR.has(typeName)) {
    const cursor = (request as { optionalCursor?: Cursor | undefined }).optionalCursor;
    if (cursor !== undefined) {
      if (cursor.token === "")
        throw new RpcError(
          status.INTERNAL,
          "unexpected consistency middleware error: cursor pointer was nil",
        );
      return;
    }
  }

  const consistency = (request as { consistency?: Consistency | undefined }).consistency;
  if (consistency === undefined) return;
  if (consistency.minimizeLatency === true || consistency.fullyConsistent === true) return;

  const token = consistency.atLeastAsFresh ?? consistency.atExactSnapshot;
  if (token !== undefined) {
    if (token.token === "")
      throw new RpcError(status.INVALID_ARGUMENT, "invalid revision requested");
    return;
  }

  throw new RpcError(
    status.INTERNAL,
    `missing handling of consistency case in ${goText(consistency)}`,
  );
}

/**
 * Go's `%v` of a `*v1.Consistency` that reaches the middleware's default case: the compact text
 * form, which is empty for no requirement and the one boolean field otherwise.
 */
function goText(consistency: Consistency): string {
  if (consistency.minimizeLatency !== undefined)
    return `minimize_latency:${String(consistency.minimizeLatency)}`;
  if (consistency.fullyConsistent !== undefined)
    return `fully_consistent:${String(consistency.fullyConsistent)}`;
  return "";
}
