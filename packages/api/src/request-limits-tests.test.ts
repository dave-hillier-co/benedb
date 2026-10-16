import { status } from "@grpc/grpc-js";
import {
  RelationshipUpdate_Operation,
  type Relationship,
} from "@benedb/protos/authzed/api/v1/core";
import {
  DeleteRelationshipsRequest,
  Precondition_Operation,
  WriteRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { describe, expect, it } from "vitest";

import { validateDeleteRelationships, validateWriteRelationships } from "./request-limits";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/RequestLimitsTests.cs`.
 *
 * Pure request-shape tests for `request-limits.ts` (no cluster). An unset proto3 message field is
 * `undefined` under ts-proto (`null` in C#); SpiceDB rejects a missing required submessage with
 * INVALID_ARGUMENT in its request validation before any handler runs, so the boundary must too,
 * rather than letting a `TypeError` surface as an UNKNOWN status.
 *
 * PORT NOTES.
 *  - DETAIL TEXT DIVERGES FROM SPICEPORT ON PURPOSE. Spiceport words the detail in protovalidate's
 *    `ValidationError` format (`validation error: updates[0].relationship: value is required`).
 *    BeneDB already rejected the update shapes with the text a real `authzed/spicedb:v1.49.2`
 *    container returns - protoc-gen-validate's `invalid WriteRelationshipsRequest.Updates[0]:
 *    embedded message failed validation | caused by: ...` - and its differential suite pins that
 *    against the container. The C#'s `Assert.Contains($"{fieldPath}: value is required")` therefore
 *    becomes an exact assertion of the protoc-gen-validate text for the same field.
 *  - `rel.Resource = null` becomes building the relationship without that field, since a ts-proto
 *    message is a plain object.
 *  - The DeleteRelationships cases have no C# counterpart in this file (Spiceport pins them only
 *    at the service); they are added here beside their WriteRelationships twins.
 */

const EMBEDDED = "embedded message failed validation | caused by: ";

function validRelationship(): Relationship {
  return {
    resource: { objectType: "document", objectId: "doc1" },
    relation: "viewer",
    subject: { object: { objectType: "user", objectId: "alice" }, optionalRelation: "" },
    optionalCaveat: undefined,
    optionalExpiresAt: undefined,
  };
}

function writeOf(relationship: Relationship | undefined): WriteRelationshipsRequest {
  return WriteRelationshipsRequest.fromPartial({
    updates: [{ operation: RelationshipUpdate_Operation.OPERATION_TOUCH, relationship }],
  });
}

function assertInvalidArgument(validate: () => void, detail: string): void {
  let caught: unknown;
  try {
    validate();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RpcError);
  expect((caught as RpcError).code).toBe(status.INVALID_ARGUMENT);
  expect((caught as RpcError).details).toBe(detail);
}

describe("RequestLimitsTests", () => {
  it("ValidateWriteRelationships_update_without_relationship_is_invalid_argument", () => {
    assertInvalidArgument(
      () => validateWriteRelationships(writeOf(undefined)),
      `invalid WriteRelationshipsRequest.Updates[0]: ${EMBEDDED}` +
        "invalid RelationshipUpdate.Relationship: value is required",
    );
  });

  it("ValidateWriteRelationships_relationship_without_resource_is_invalid_argument", () => {
    const rel = { ...validRelationship(), resource: undefined };
    assertInvalidArgument(
      () => validateWriteRelationships(writeOf(rel)),
      `invalid WriteRelationshipsRequest.Updates[0]: ${EMBEDDED}` +
        `invalid RelationshipUpdate.Relationship: ${EMBEDDED}` +
        "invalid Relationship.Resource: value is required",
    );
  });

  it("ValidateWriteRelationships_relationship_without_subject_is_invalid_argument", () => {
    const rel = { ...validRelationship(), subject: undefined };
    assertInvalidArgument(
      () => validateWriteRelationships(writeOf(rel)),
      `invalid WriteRelationshipsRequest.Updates[0]: ${EMBEDDED}` +
        `invalid RelationshipUpdate.Relationship: ${EMBEDDED}` +
        "invalid Relationship.Subject: value is required",
    );
  });

  it("ValidateWriteRelationships_subject_without_object_is_invalid_argument", () => {
    const rel = { ...validRelationship(), subject: { object: undefined, optionalRelation: "" } };
    assertInvalidArgument(
      () => validateWriteRelationships(writeOf(rel)),
      `invalid WriteRelationshipsRequest.Updates[0]: ${EMBEDDED}` +
        `invalid RelationshipUpdate.Relationship: ${EMBEDDED}` +
        `invalid Relationship.Subject: ${EMBEDDED}invalid SubjectReference.Object: value is required`,
    );
  });

  it("ValidateWriteRelationships_names_the_index_of_the_malformed_update", () => {
    const request = writeOf(validRelationship());
    request.updates.push({
      operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
      relationship: undefined,
    });
    assertInvalidArgument(
      () => validateWriteRelationships(request),
      `invalid WriteRelationshipsRequest.Updates[1]: ${EMBEDDED}` +
        "invalid RelationshipUpdate.Relationship: value is required",
    );
  });

  it("ValidateWriteRelationships_precondition_without_filter_is_invalid_argument", () => {
    const request = writeOf(validRelationship());
    request.optionalPreconditions.push({
      operation: Precondition_Operation.OPERATION_MUST_MATCH,
      filter: undefined,
    });
    assertInvalidArgument(
      () => validateWriteRelationships(request),
      `invalid WriteRelationshipsRequest.OptionalPreconditions[0]: ${EMBEDDED}` +
        "invalid Precondition.Filter: value is required",
    );
  });

  it("ValidateWriteRelationships_accepts_a_well_formed_request", () => {
    const request = writeOf(validRelationship());
    request.optionalPreconditions.push({
      operation: Precondition_Operation.OPERATION_MUST_MATCH,
      filter: {
        resourceType: "document",
        optionalResourceId: "",
        optionalResourceIdPrefix: "",
        optionalRelation: "",
        optionalSubjectFilter: undefined,
      },
    });
    validateWriteRelationships(request);
  });

  it("ValidateDeleteRelationships_without_relationship_filter_is_invalid_argument", () => {
    assertInvalidArgument(
      () => validateDeleteRelationships(DeleteRelationshipsRequest.fromPartial({})),
      "invalid DeleteRelationshipsRequest.RelationshipFilter: value is required",
    );
  });

  it("ValidateDeleteRelationships_precondition_without_filter_is_invalid_argument", () => {
    const request = DeleteRelationshipsRequest.fromPartial({
      relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
      optionalPreconditions: [{ operation: Precondition_Operation.OPERATION_MUST_MATCH }],
    });
    assertInvalidArgument(
      () => validateDeleteRelationships(request),
      `invalid DeleteRelationshipsRequest.OptionalPreconditions[0]: ${EMBEDDED}` +
        "invalid Precondition.Filter: value is required",
    );
  });

  it("ValidateDeleteRelationships_accepts_a_well_formed_request", () => {
    validateDeleteRelationships(
      DeleteRelationshipsRequest.fromPartial({
        relationshipFilter: { resourceType: "document" },
        optionalPreconditions: [
          {
            operation: Precondition_Operation.OPERATION_MUST_MATCH,
            filter: { resourceType: "document" },
          },
        ],
      }),
    );
  });
});
