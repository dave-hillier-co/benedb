import { status } from "@grpc/grpc-js";
import type { ObjectReference, SubjectReference } from "@benedb/protos/authzed/api/v1/core";
import {
  CheckBulkPermissionsRequest,
  CheckPermissionRequest,
  DeleteRelationshipsRequest,
  ExpandPermissionTreeRequest,
  ExportBulkRelationshipsRequest,
  ImportBulkRelationshipsRequest,
  LookupResourcesRequest,
  LookupSubjectsRequest,
  ReadRelationshipsRequest,
  type RelationshipFilter,
  WriteRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { RelationshipUpdate_Operation } from "@benedb/protos/authzed/api/v1/core";
import {
  ComputablePermissionsRequest,
  DependentRelationsRequest,
  DiffSchemaRequest,
  ReflectSchemaRequest,
  WriteSchemaRequest,
} from "@benedb/protos/authzed/api/v1/schema_service";
import {
  ExperimentalCountRelationshipsRequest,
  ExperimentalRegisterRelationshipCounterRequest,
  ExperimentalUnregisterRelationshipCounterRequest,
} from "@benedb/protos/authzed/api/v1/experimental_service";
import { describe, expect, it } from "vitest";

import { AuthzedExperimentalV1Service } from "./authzed-experimental-v1-service";
import { AuthzedPermissionsV1Service } from "./authzed-permissions-v1-service";
import { AuthzedSchemaV1Service } from "./authzed-schema-v1-service";
import { RpcError } from "./rpc-error";
import type { ServerStreamWriter } from "./server-stream-writer";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/RequestValidationWiringTests.cs`.
 *
 * Every `authzed.api.v1` handler validates its request (`request-validation.ts`) before doing
 * anything else, as SpiceDB's interceptors do before its handlers run. The services are built with
 * no collaborators at all: a rejected request must never reach one, so no cluster is needed. Each
 * request carries one malformed field, and the detail is SpiceDB's text for it.
 *
 * PORT NOTES.
 *  - The C#'s `null!` collaborators become `undefined as never`.
 */

const BAD_TYPE = "Document";

const TYPE_VIOLATION =
  "invalid ObjectReference.ObjectType: value does not match regex pattern " +
  '"^([a-z][a-z0-9_]{1,61}[a-z0-9]/)*[a-z][a-z0-9_]{1,62}[a-z0-9]$"';

const OPTIONAL_TYPE_VIOLATION =
  "invalid RelationshipFilter.ResourceType: value does not match regex pattern " +
  '"^(([a-z][a-z0-9_]{1,61}[a-z0-9]/)*[a-z][a-z0-9_]{1,62}[a-z0-9])?$"';

const NAME_VIOLATION = 'value does not match regex pattern "^([a-z][a-z0-9_]{1,62}[a-z0-9])?$"';

const EMBEDDED = "embedded message failed validation | caused by: ";

const NONE = undefined as never;
const permissions = new AuthzedPermissionsV1Service(NONE, NONE, NONE, NONE, NONE);
const schema = new AuthzedSchemaV1Service(NONE, NONE);
const experimental = new AuthzedExperimentalV1Service(NONE, permissions, schema);

function badResource(): ObjectReference {
  return { objectType: BAD_TYPE, objectId: "doc1" };
}

function alice(): SubjectReference {
  return { object: { objectType: "user", objectId: "alice" }, optionalRelation: "" };
}

function badFilter(): RelationshipFilter {
  return {
    resourceType: BAD_TYPE,
    optionalResourceId: "",
    optionalResourceIdPrefix: "",
    optionalRelation: "",
    optionalSubjectFilter: undefined,
  };
}

function discarding<T>(): ServerStreamWriter<T> {
  return { write: () => Promise.resolve() };
}

async function* stream<T>(...messages: T[]): AsyncIterable<T> {
  for (const message of messages) yield await Promise.resolve(message);
}

async function assertRejected(
  call: () => Promise<unknown>,
  detail: string,
  code: status = status.INVALID_ARGUMENT,
): Promise<void> {
  const caught = await call().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(RpcError);
  expect((caught as RpcError).code).toBe(code);
  expect((caught as RpcError).details).toBe(detail);
}

/** SpiceDB's consistency middleware, which runs ahead of field validation, on an empty Consistency. */
const UNHANDLED_CONSISTENCY = "missing handling of consistency case in ";

describe("RequestValidationWiringTests", () => {
  it("CheckPermission", () =>
    assertRejected(
      () =>
        permissions.checkPermission(
          CheckPermissionRequest.fromPartial({
            resource: badResource(),
            permission: "view",
            subject: alice(),
          }),
        ),
      `invalid CheckPermissionRequest.Resource: ${EMBEDDED}${TYPE_VIOLATION}`,
    ));

  it("CheckBulkPermissions", () =>
    assertRejected(
      () =>
        permissions.checkBulkPermissions(
          CheckBulkPermissionsRequest.fromPartial({
            items: [{ resource: badResource(), permission: "view", subject: alice() }],
          }),
        ),
      `invalid CheckBulkPermissionsRequest.Items[0]: ${EMBEDDED}invalid CheckBulkPermissionsRequestItem.Resource: ${EMBEDDED}${TYPE_VIOLATION}`,
    ));

  it("ExpandPermissionTree", () =>
    assertRejected(
      () =>
        permissions.expandPermissionTree(
          ExpandPermissionTreeRequest.fromPartial({ resource: badResource(), permission: "view" }),
        ),
      `invalid ExpandPermissionTreeRequest.Resource: ${EMBEDDED}${TYPE_VIOLATION}`,
    ));

  it("WriteRelationships", () =>
    assertRejected(
      () =>
        permissions.writeRelationships(
          WriteRelationshipsRequest.fromPartial({
            updates: [
              {
                operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
                relationship: { resource: badResource(), relation: "viewer", subject: alice() },
              },
            ],
          }),
        ),
      `invalid WriteRelationshipsRequest.Updates[0]: ${EMBEDDED}invalid RelationshipUpdate.Relationship: ${EMBEDDED}` +
        `invalid Relationship.Resource: ${EMBEDDED}${TYPE_VIOLATION}`,
    ));

  it("DeleteRelationships", () =>
    assertRejected(
      () =>
        permissions.deleteRelationships(
          DeleteRelationshipsRequest.fromPartial({ relationshipFilter: badFilter() }),
        ),
      `invalid DeleteRelationshipsRequest.RelationshipFilter: ${EMBEDDED}${OPTIONAL_TYPE_VIOLATION}`,
    ));

  it("ReadRelationships", () =>
    assertRejected(
      () =>
        permissions.readRelationships(
          ReadRelationshipsRequest.fromPartial({ relationshipFilter: badFilter() }),
          discarding(),
        ),
      `invalid ReadRelationshipsRequest.RelationshipFilter: ${EMBEDDED}${OPTIONAL_TYPE_VIOLATION}`,
    ));

  it("LookupResources", () =>
    assertRejected(
      () =>
        permissions.lookupResources(
          LookupResourcesRequest.fromPartial({
            resourceObjectType: BAD_TYPE,
            permission: "view",
            subject: alice(),
          }),
          discarding(),
        ),
      "invalid LookupResourcesRequest.ResourceObjectType: value does not match regex pattern " +
        '"^([a-z][a-z0-9_]{1,61}[a-z0-9]/)*[a-z][a-z0-9_]{1,62}[a-z0-9]$"',
    ));

  it("LookupSubjects", () =>
    assertRejected(
      () =>
        permissions.lookupSubjects(
          LookupSubjectsRequest.fromPartial({
            resource: badResource(),
            permission: "view",
            subjectObjectType: "user",
          }),
          discarding(),
        ),
      `invalid LookupSubjectsRequest.Resource: ${EMBEDDED}${TYPE_VIOLATION}`,
    ));

  it("ImportBulkRelationships_validates_each_received_message", () =>
    assertRejected(
      () =>
        permissions.importBulkRelationships(
          stream(
            ImportBulkRelationshipsRequest.fromPartial({}),
            ImportBulkRelationshipsRequest.fromPartial({
              relationships: [{ resource: badResource(), relation: "viewer", subject: alice() }],
            }),
          ),
        ),
      `invalid ImportBulkRelationshipsRequest.Relationships[0]: ${EMBEDDED}invalid Relationship.Resource: ${EMBEDDED}${TYPE_VIOLATION}`,
    ));

  it("ExportBulkRelationships", () =>
    assertRejected(
      () =>
        permissions.exportBulkRelationships(
          ExportBulkRelationshipsRequest.fromPartial({ optionalRelationshipFilter: badFilter() }),
          discarding(),
        ),
      `invalid ExportBulkRelationshipsRequest.OptionalRelationshipFilter: ${EMBEDDED}${OPTIONAL_TYPE_VIOLATION}`,
    ));

  it("WriteSchema", () =>
    assertRejected(
      () => schema.writeSchema(WriteSchemaRequest.fromPartial({ schema: "x".repeat(4_194_305) })),
      "invalid WriteSchemaRequest.Schema: value length must be at most 4194304 bytes",
    ));

  it("ReflectSchema", () =>
    assertRejected(
      () => schema.reflectSchema(ReflectSchemaRequest.fromPartial({ consistency: {} })),
      UNHANDLED_CONSISTENCY,
      status.INTERNAL,
    ));

  it("DiffSchema", () =>
    assertRejected(
      () => schema.diffSchema(DiffSchemaRequest.fromPartial({ consistency: {} })),
      UNHANDLED_CONSISTENCY,
      status.INTERNAL,
    ));

  it("ComputablePermissions", () =>
    assertRejected(
      () =>
        schema.computablePermissions(ComputablePermissionsRequest.fromPartial({ consistency: {} })),
      UNHANDLED_CONSISTENCY,
      status.INTERNAL,
    ));

  it("DependentRelations", () =>
    assertRejected(
      () => schema.dependentRelations(DependentRelationsRequest.fromPartial({ consistency: {} })),
      UNHANDLED_CONSISTENCY,
      status.INTERNAL,
    ));

  it("RegisterRelationshipCounter", () =>
    assertRejected(
      () =>
        experimental.experimentalRegisterRelationshipCounter(
          ExperimentalRegisterRelationshipCounterRequest.fromPartial({ name: "Bad" }),
        ),
      `invalid ExperimentalRegisterRelationshipCounterRequest.Name: ${NAME_VIOLATION}; ` +
        "invalid ExperimentalRegisterRelationshipCounterRequest.RelationshipFilter: value is required",
    ));

  it("UnregisterRelationshipCounter", () =>
    assertRejected(
      () =>
        experimental.experimentalUnregisterRelationshipCounter(
          ExperimentalUnregisterRelationshipCounterRequest.fromPartial({ name: "Bad" }),
        ),
      `invalid ExperimentalUnregisterRelationshipCounterRequest.Name: ${NAME_VIOLATION}`,
    ));

  it("CountRelationships", () =>
    assertRejected(
      () =>
        experimental.experimentalCountRelationships(
          ExperimentalCountRelationshipsRequest.fromPartial({ name: "Bad" }),
        ),
      `invalid ExperimentalCountRelationshipsRequest.Name: ${NAME_VIOLATION}`,
    ));
});
