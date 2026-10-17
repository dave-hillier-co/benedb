import { status } from "@grpc/grpc-js";
import { createFileRegistry, fromBinary } from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { AUTHZED_API_V1_DESCRIPTOR_SET } from "@benedb/protos/authzed-api-v1-descriptor-set";
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
  WriteRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";
import {
  ExperimentalCountRelationshipsRequest,
  ExperimentalRegisterRelationshipCounterRequest,
  ExperimentalUnregisterRelationshipCounterRequest,
} from "@benedb/protos/authzed/api/v1/experimental_service";
import {
  DiffSchemaRequest,
  ReadSchemaRequest,
  ReflectSchemaRequest,
  WriteSchemaRequest,
} from "@benedb/protos/authzed/api/v1/schema_service";
import { describe, expect, it } from "vitest";

import { ensureSupported, goName, goRegex } from "./proto-validation";
import { validateRequest, type RequestTypeName } from "./request-validation";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/RequestValidationTests.cs`.
 *
 * Pure tests (no cluster) for `request-validation.ts`: the protoc-gen-validate rules annotated on
 * the vendored `authzed.api.v1` protos and authzed-go's handwritten rules, which SpiceDB enforces in
 * its interceptors before any handler runs. Each expected detail is the exact text SpiceDB v1.49.2
 * returns: the output of authzed-go v1.7.0's generated `ValidateAll` (then `HandwrittenValidate`)
 * for the same message. Requests are written as protobuf JSON so the field paths read as they do on
 * the wire.
 *
 * PORT NOTES.
 *  - `JsonParser.Default.Parse<T>(json)` becomes ts-proto's `T.fromJSON(JSON.parse(json))`. An
 *    undefined enum number parses to ts-proto's `UNRECOGNIZED` (-1) rather than keeping 99; both are
 *    outside the enum, so the detail is the same.
 *  - `Every_request_message_has_a_supported_plan` enumerates the services' input types from the
 *    embedded descriptor set (C# reads them from the generated reflection descriptors).
 */

const EMBEDDED = "embedded message failed validation | caused by: ";

/** PGV's reason for a pattern mismatch: the pattern as Go's `%q` prints it. */
function pattern(goQuoted: string): string {
  return `value does not match regex pattern "${goQuoted}"`;
}

const TYPE_PATTERN = pattern(
  String.raw`^([a-z][a-z0-9_]{1,61}[a-z0-9]/)*[a-z][a-z0-9_]{1,62}[a-z0-9]$`,
);
const OPTIONAL_TYPE_PATTERN = pattern(
  String.raw`^(([a-z][a-z0-9_]{1,61}[a-z0-9]/)*[a-z][a-z0-9_]{1,62}[a-z0-9])?$`,
);
const ID_PATTERN = pattern(String.raw`^(([a-zA-Z0-9/_|\\-=+]{1,})|\\*)$`);
const FILTER_ID_PATTERN = pattern(String.raw`^([a-zA-Z0-9/_|\\-=+]{1,})?$`);
const RELATION_PATTERN = pattern(String.raw`^[a-z][a-z0-9_]{1,62}[a-z0-9]$`);
const OPTIONAL_RELATION_PATTERN = pattern(String.raw`^([a-z][a-z0-9_]{1,62}[a-z0-9])?$`);
const CAVEAT_PATTERN = pattern(String.raw`^([a-zA-Z0-9_][a-zA-Z0-9/_|-]{0,127})$`);

const ALICE = `{"object":{"objectType":"user","objectId":"alice"}}`;

interface FromJson<T> {
  fromJSON(object: unknown): T;
}

function parse<T>(type: FromJson<T>, json: string): T {
  return type.fromJSON(JSON.parse(json));
}

function check(resource: string, permission = "view", subject = ALICE, consistency = ""): string {
  return `{${consistency}"resource":${resource},"permission":"${permission}","subject":${subject}}`;
}

function doc(id: string): string {
  return `{"objectType":"document","objectId":"${id}"}`;
}

function update(relationship: string, operation = '"OPERATION_TOUCH"'): string {
  return `{"operation":${operation},"relationship":${relationship}}`;
}

function rel(resource: string, relation = "viewer", subject = ALICE, extra = ""): string {
  return `{"resource":${resource},"relation":"${relation}","subject":${subject}${extra}}`;
}

function assertRejected(typeName: RequestTypeName, request: object, detail: string): void {
  let caught: unknown;
  try {
    validateRequest(typeName, request);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RpcError);
  expect((caught as RpcError).code).toBe(status.INVALID_ARGUMENT);
  expect((caught as RpcError).details).toBe(detail);
}

describe("RequestValidationTests", () => {
  it("Valid_requests_pass", () => {
    validateRequest(
      "CheckPermissionRequest",
      parse(
        CheckPermissionRequest,
        check(
          `{"objectType":"org/document","objectId":"a/b_c|d-e=f+g"}`,
          "view",
          `{"object":{"objectType":"user","objectId":"*"}}`,
        ),
      ),
    );
    validateRequest(
      "ReadRelationshipsRequest",
      parse(ReadRelationshipsRequest, `{"relationshipFilter":{"resourceType":""}}`),
    );
    validateRequest("ReadSchemaRequest", parse(ReadSchemaRequest, "{}"));
    validateRequest("WriteSchemaRequest", parse(WriteSchemaRequest, `{"schema":""}`));
  });

  it("Object_type_and_id_must_match_their_grammar", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(CheckPermissionRequest, check(`{"objectType":"Document","objectId":"doc 1"}`)),
      `invalid CheckPermissionRequest.Resource: ${EMBEDDED}invalid ObjectReference.ObjectType: ${TYPE_PATTERN}; ` +
        `invalid ObjectReference.ObjectId: ${ID_PATTERN}`,
    );
  });

  it("A_trailing_newline_does_not_satisfy_an_anchored_pattern", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(CheckPermissionRequest, check(`{"objectType":"document\\n","objectId":"doc1"}`)),
      `invalid CheckPermissionRequest.Resource: ${EMBEDDED}invalid ObjectReference.ObjectType: ${TYPE_PATTERN}`,
    );
  });

  it("A_non_ascii_object_id_is_rejected", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(CheckPermissionRequest, check(doc("dóc"))),
      `invalid CheckPermissionRequest.Resource: ${EMBEDDED}invalid ObjectReference.ObjectId: ${ID_PATTERN}`,
    );
  });

  it("Object_id_is_at_most_1024_bytes", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(CheckPermissionRequest, check(doc("a".repeat(1025)))),
      `invalid CheckPermissionRequest.Resource: ${EMBEDDED}invalid ObjectReference.ObjectId: ` +
        "value length must be at most 1024 bytes",
    );
  });

  it("Object_type_over_128_bytes_reports_length_then_pattern", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(CheckPermissionRequest, check(`{"objectType":"${"a".repeat(129)}","objectId":"x"}`)),
      `invalid CheckPermissionRequest.Resource: ${EMBEDDED}` +
        "invalid ObjectReference.ObjectType: value length must be at most 128 bytes; " +
        `invalid ObjectReference.ObjectType: ${TYPE_PATTERN}`,
    );
  });

  it("Permission_and_subject_relation_must_match_the_relation_grammar", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(
        CheckPermissionRequest,
        check(
          doc("doc1"),
          "View",
          `{"object":{"objectType":"user","objectId":"alice"},"optionalRelation":"Member"}`,
        ),
      ),
      `invalid CheckPermissionRequest.Permission: ${OPTIONAL_RELATION_PATTERN}; ` +
        `invalid CheckPermissionRequest.Subject: ${EMBEDDED}invalid SubjectReference.OptionalRelation: ${OPTIONAL_RELATION_PATTERN}`,
    );
  });

  it("Permission_is_at_most_64_bytes", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(CheckPermissionRequest, check(doc("doc1"), "v".repeat(65))),
      "invalid CheckPermissionRequest.Permission: value length must be at most 64 bytes; " +
        `invalid CheckPermissionRequest.Permission: ${OPTIONAL_RELATION_PATTERN}`,
    );
  });

  it("Missing_resource_and_subject_are_both_reported", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(CheckPermissionRequest, `{"permission":"view"}`),
      "invalid CheckPermissionRequest.Resource: value is required; " +
        "invalid CheckPermissionRequest.Subject: value is required",
    );
  });

  it("An_empty_consistency_needs_a_requirement", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(CheckPermissionRequest, check(doc("doc1"), "view", ALICE, `"consistency":{},`)),
      `invalid CheckPermissionRequest.Consistency: ${EMBEDDED}invalid Consistency.Requirement: value is required`,
    );
  });

  it("Minimize_latency_false_is_rejected", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(
        CheckPermissionRequest,
        check(doc("doc1"), "view", ALICE, `"consistency":{"minimizeLatency":false},`),
      ),
      `invalid CheckPermissionRequest.Consistency: ${EMBEDDED}invalid Consistency.MinimizeLatency: value must equal true`,
    );
  });

  it("Fully_consistent_false_is_rejected", () => {
    assertRejected(
      "ExpandPermissionTreeRequest",
      parse(
        ExpandPermissionTreeRequest,
        `{"consistency":{"fullyConsistent":false},"resource":{"objectType":"document","objectId":"doc1"},"permission":"view"}`,
      ),
      `invalid ExpandPermissionTreeRequest.Consistency: ${EMBEDDED}invalid Consistency.FullyConsistent: value must equal true`,
    );
  });

  it("An_empty_zed_token_is_rejected", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(
        CheckPermissionRequest,
        check(doc("doc1"), "view", ALICE, `"consistency":{"atLeastAsFresh":{}},`),
      ),
      `invalid CheckPermissionRequest.Consistency: ${EMBEDDED}invalid Consistency.AtLeastAsFresh: ${EMBEDDED}` +
        "invalid ZedToken.Token: value length must be at least 1 bytes",
    );
  });

  it("A_check_on_a_wildcard_resource_is_rejected", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(CheckPermissionRequest, check(doc("*"))),
      "invalid ObjectReference.ObjectId: alphanumeric value is required",
    );
  });

  it("A_wildcard_subject_with_a_relation_is_rejected", () => {
    assertRejected(
      "CheckPermissionRequest",
      parse(
        CheckPermissionRequest,
        check(
          doc("doc1"),
          "view",
          `{"object":{"objectType":"user","objectId":"*"},"optionalRelation":"member"}`,
        ),
      ),
      "invalid SubjectReference.OptionalRelation: optionalrelation must be empty on subject if object ID is a wildcard",
    );
  });

  it("Relationship_relation_must_match_the_relation_grammar", () => {
    assertRejected(
      "WriteRelationshipsRequest",
      parse(WriteRelationshipsRequest, `{"updates":[${update(rel(doc("doc1"), "Viewer"))}]}`),
      `invalid WriteRelationshipsRequest.Updates[0]: ${EMBEDDED}invalid RelationshipUpdate.Relationship: ${EMBEDDED}` +
        `invalid Relationship.Relation: ${RELATION_PATTERN}`,
    );
  });

  it("Update_operation_must_be_a_defined_non_zero_value", () => {
    const unspecified = update(rel(doc("doc1")), '"OPERATION_UNSPECIFIED"');
    const undefinedOperation = update(
      rel(doc("doc1"), "viewer", `{"object":{"objectType":"user","objectId":"bob"}}`),
      "99",
    );
    assertRejected(
      "WriteRelationshipsRequest",
      parse(WriteRelationshipsRequest, `{"updates":[${unspecified},${undefinedOperation}]}`),
      `invalid WriteRelationshipsRequest.Updates[0]: ${EMBEDDED}` +
        "invalid RelationshipUpdate.Operation: value must not be in list [OPERATION_UNSPECIFIED]; " +
        `invalid WriteRelationshipsRequest.Updates[1]: ${EMBEDDED}` +
        "invalid RelationshipUpdate.Operation: value must be one of the defined enum values",
    );
  });

  it("Caveat_name_must_match_its_grammar", () => {
    assertRejected(
      "WriteRelationshipsRequest",
      parse(
        WriteRelationshipsRequest,
        `{"updates":[${update(rel(doc("doc1"), "viewer", ALICE, `,"optionalCaveat":{"caveatName":"bad name"}`))}]}`,
      ),
      `invalid WriteRelationshipsRequest.Updates[0]: ${EMBEDDED}invalid RelationshipUpdate.Relationship: ${EMBEDDED}` +
        `invalid Relationship.OptionalCaveat: ${EMBEDDED}invalid ContextualizedCaveat.CaveatName: ${CAVEAT_PATTERN}`,
    );
  });

  it("Writing_a_wildcard_resource_is_rejected", () => {
    assertRejected(
      "WriteRelationshipsRequest",
      parse(WriteRelationshipsRequest, `{"updates":[${update(rel(doc("*")))}]}`),
      "invalid ObjectReference.ObjectId: alphanumeric value is required",
    );
  });

  it("Writing_a_wildcard_subject_with_a_relation_is_rejected", () => {
    assertRejected(
      "WriteRelationshipsRequest",
      parse(
        WriteRelationshipsRequest,
        `{"updates":[${update(rel(doc("doc1"), "viewer", `{"object":{"objectType":"user","objectId":"*"},"optionalRelation":"member"}`))}]}`,
      ),
      "invalid SubjectReference.OptionalRelation: optionalrelation must be empty on subject if object ID is a wildcard",
    );
  });

  it("A_precondition_filter_on_a_wildcard_resource_id_breaks_the_filter_id_grammar", () => {
    assertRejected(
      "WriteRelationshipsRequest",
      parse(
        WriteRelationshipsRequest,
        `{"optionalPreconditions":[{"operation":"OPERATION_MUST_MATCH","filter":{"resourceType":"document","optionalResourceId":"*"}}]}`,
      ),
      `invalid WriteRelationshipsRequest.OptionalPreconditions[0]: ${EMBEDDED}invalid Precondition.Filter: ${EMBEDDED}` +
        `invalid RelationshipFilter.OptionalResourceId: ${FILTER_ID_PATTERN}`,
    );
  });

  it("A_precondition_needs_an_operation_and_a_valid_filter", () => {
    assertRejected(
      "WriteRelationshipsRequest",
      parse(
        WriteRelationshipsRequest,
        `{"optionalPreconditions":[{"filter":{"resourceType":"Document"}}]}`,
      ),
      `invalid WriteRelationshipsRequest.OptionalPreconditions[0]: ${EMBEDDED}` +
        "invalid Precondition.Operation: value must not be in list [OPERATION_UNSPECIFIED]; " +
        `invalid Precondition.Filter: ${EMBEDDED}invalid RelationshipFilter.ResourceType: ${OPTIONAL_TYPE_PATTERN}`,
    );
  });

  it("A_wildcard_subject_filter_with_a_relation_is_rejected", () => {
    assertRejected(
      "DeleteRelationshipsRequest",
      parse(
        DeleteRelationshipsRequest,
        `{"relationshipFilter":{"resourceType":"document","optionalSubjectFilter":{"subjectType":"user","optionalSubjectId":"*","optionalRelation":{"relation":"member"}}}}`,
      ),
      "invalid SubjectFilter.OptionalRelation: optionalrelation must be empty on subject if object ID is a wildcard",
    );
  });

  it("Subject_filter_fields_must_match_their_grammar", () => {
    assertRejected(
      "DeleteRelationshipsRequest",
      parse(
        DeleteRelationshipsRequest,
        `{"relationshipFilter":{"resourceType":"document","optionalSubjectFilter":{"subjectType":"","optionalRelation":{"relation":"Member"}}}}`,
      ),
      `invalid DeleteRelationshipsRequest.RelationshipFilter: ${EMBEDDED}invalid RelationshipFilter.OptionalSubjectFilter: ${EMBEDDED}` +
        `invalid SubjectFilter.SubjectType: ${TYPE_PATTERN}; ` +
        `invalid SubjectFilter.OptionalRelation: ${EMBEDDED}invalid SubjectFilter_RelationFilter.Relation: ${OPTIONAL_RELATION_PATTERN}`,
    );
  });

  it("Every_relationship_filter_field_is_checked_in_order", () => {
    assertRejected(
      "ReadRelationshipsRequest",
      parse(
        ReadRelationshipsRequest,
        `{"relationshipFilter":{"resourceType":"Document","optionalResourceId":"a b","optionalResourceIdPrefix":"c d","optionalRelation":"X"}}`,
      ),
      `invalid ReadRelationshipsRequest.RelationshipFilter: ${EMBEDDED}` +
        `invalid RelationshipFilter.ResourceType: ${OPTIONAL_TYPE_PATTERN}; ` +
        `invalid RelationshipFilter.OptionalResourceId: ${FILTER_ID_PATTERN}; ` +
        `invalid RelationshipFilter.OptionalResourceIdPrefix: ${FILTER_ID_PATTERN}; ` +
        `invalid RelationshipFilter.OptionalRelation: ${OPTIONAL_RELATION_PATTERN}`,
    );
  });

  it("A_cursor_token_must_be_between_1_and_102400_bytes", () => {
    const reason = "value length must be between 1 and 102400 bytes, inclusive";
    assertRejected(
      "ReadRelationshipsRequest",
      parse(
        ReadRelationshipsRequest,
        `{"relationshipFilter":{"resourceType":"document"},"optionalCursor":{}}`,
      ),
      `invalid ReadRelationshipsRequest.OptionalCursor: ${EMBEDDED}invalid Cursor.Token: ${reason}`,
    );
    assertRejected(
      "ReadRelationshipsRequest",
      parse(
        ReadRelationshipsRequest,
        `{"relationshipFilter":{"resourceType":"document"},"optionalCursor":{"token":"${"x".repeat(102401)}"}}`,
      ),
      `invalid ReadRelationshipsRequest.OptionalCursor: ${EMBEDDED}invalid Cursor.Token: ${reason}`,
    );
  });

  it("Lookup_resources_checks_resource_type_and_requires_a_subject", () => {
    assertRejected(
      "LookupResourcesRequest",
      parse(
        LookupResourcesRequest,
        `{"resourceObjectType":"Document","permission":"view","subject":${ALICE}}`,
      ),
      `invalid LookupResourcesRequest.ResourceObjectType: ${TYPE_PATTERN}`,
    );
    assertRejected(
      "LookupResourcesRequest",
      parse(LookupResourcesRequest, `{"resourceObjectType":"document","permission":"view"}`),
      "invalid LookupResourcesRequest.Subject: value is required",
    );
  });

  it("Lookup_subjects_checks_subject_type_and_relation", () => {
    assertRejected(
      "LookupSubjectsRequest",
      parse(
        LookupSubjectsRequest,
        `{"resource":{"objectType":"document","objectId":"doc1"},"permission":"view","subjectObjectType":"User","optionalSubjectRelation":"Member"}`,
      ),
      `invalid LookupSubjectsRequest.SubjectObjectType: ${TYPE_PATTERN}; ` +
        `invalid LookupSubjectsRequest.OptionalSubjectRelation: ${OPTIONAL_RELATION_PATTERN}`,
    );
  });

  it("Expand_rejects_a_wildcard_resource", () => {
    assertRejected(
      "ExpandPermissionTreeRequest",
      parse(
        ExpandPermissionTreeRequest,
        `{"resource":{"objectType":"document","objectId":"*"},"permission":"view"}`,
      ),
      "invalid ObjectReference.ObjectId: alphanumeric value is required",
    );
  });

  it("Check_bulk_reports_each_item_by_index", () => {
    assertRejected(
      "CheckBulkPermissionsRequest",
      parse(
        CheckBulkPermissionsRequest,
        `{"items":[${check(doc("doc1"))},{"resource":{"objectType":"Document","objectId":"doc1"},"permission":"view"}]}`,
      ),
      `invalid CheckBulkPermissionsRequest.Items[1]: ${EMBEDDED}` +
        `invalid CheckBulkPermissionsRequestItem.Resource: ${EMBEDDED}invalid ObjectReference.ObjectType: ${TYPE_PATTERN}; ` +
        "invalid CheckBulkPermissionsRequestItem.Subject: value is required",
    );
  });

  it("Import_bulk_reports_each_relationship_by_index", () => {
    assertRejected(
      "ImportBulkRelationshipsRequest",
      parse(
        ImportBulkRelationshipsRequest,
        `{"relationships":[${rel(doc("doc1"))},{"resource":{"objectType":"document","objectId":"doc 2"},"relation":"viewer"}]}`,
      ),
      `invalid ImportBulkRelationshipsRequest.Relationships[1]: ${EMBEDDED}` +
        `invalid Relationship.Resource: ${EMBEDDED}invalid ObjectReference.ObjectId: ${ID_PATTERN}; ` +
        "invalid Relationship.Subject: value is required",
    );
  });

  it("Export_bulk_checks_fields_in_declaration_order", () => {
    assertRejected(
      "ExportBulkRelationshipsRequest",
      parse(
        ExportBulkRelationshipsRequest,
        `{"optionalRelationshipFilter":{"resourceType":"Document"},"optionalCursor":{}}`,
      ),
      `invalid ExportBulkRelationshipsRequest.OptionalCursor: ${EMBEDDED}` +
        "invalid Cursor.Token: value length must be between 1 and 102400 bytes, inclusive; " +
        `invalid ExportBulkRelationshipsRequest.OptionalRelationshipFilter: ${EMBEDDED}` +
        `invalid RelationshipFilter.ResourceType: ${OPTIONAL_TYPE_PATTERN}`,
    );
  });

  it("Counter_names_must_match_the_relation_grammar", () => {
    assertRejected(
      "ExperimentalRegisterRelationshipCounterRequest",
      parse(ExperimentalRegisterRelationshipCounterRequest, `{"name":"Bad"}`),
      `invalid ExperimentalRegisterRelationshipCounterRequest.Name: ${OPTIONAL_RELATION_PATTERN}; ` +
        "invalid ExperimentalRegisterRelationshipCounterRequest.RelationshipFilter: value is required",
    );
    assertRejected(
      "ExperimentalCountRelationshipsRequest",
      parse(ExperimentalCountRelationshipsRequest, `{"name":"Bad"}`),
      `invalid ExperimentalCountRelationshipsRequest.Name: ${OPTIONAL_RELATION_PATTERN}`,
    );
    assertRejected(
      "ExperimentalUnregisterRelationshipCounterRequest",
      parse(ExperimentalUnregisterRelationshipCounterRequest, `{"name":"Bad"}`),
      `invalid ExperimentalUnregisterRelationshipCounterRequest.Name: ${OPTIONAL_RELATION_PATTERN}`,
    );
  });

  it("Schema_requests_validate_their_consistency_and_size", () => {
    assertRejected(
      "ReflectSchemaRequest",
      parse(ReflectSchemaRequest, `{"consistency":{}}`),
      `invalid ReflectSchemaRequest.Consistency: ${EMBEDDED}invalid Consistency.Requirement: value is required`,
    );
    assertRejected(
      "DiffSchemaRequest",
      parse(DiffSchemaRequest, `{"comparisonSchema":"x","consistency":{}}`),
      `invalid DiffSchemaRequest.Consistency: ${EMBEDDED}invalid Consistency.Requirement: value is required`,
    );
    assertRejected(
      "WriteSchemaRequest",
      WriteSchemaRequest.fromPartial({ schema: "x".repeat(4_194_305) }),
      "invalid WriteSchemaRequest.Schema: value length must be at most 4194304 bytes",
    );
  });

  /**
   * Every rule on every message an `authzed.api.v1` service receives is one the validator
   * implements, so a re-vendored proto that adds a new kind of rule fails here rather than going
   * unenforced.
   */
  it("Every_request_message_has_a_supported_plan", () => {
    const registry = createFileRegistry(
      fromBinary(FileDescriptorSetSchema, Buffer.from(AUTHZED_API_V1_DESCRIPTOR_SET, "base64")),
    );
    const inputTypes = [
      "authzed.api.v1.PermissionsService",
      "authzed.api.v1.SchemaService",
      "authzed.api.v1.WatchService",
      "authzed.api.v1.ExperimentalService",
    ].flatMap(
      (name) => registry.getService(name)?.methods.map((method) => method.input.typeName) ?? [],
    );
    expect(inputTypes.length).toBeGreaterThan(20);
    for (const inputType of inputTypes) ensureSupported(inputType);
  });

  it.each([
    ["object_id", "ObjectId"],
    ["optional_resource_id_prefix", "OptionalResourceIdPrefix"],
    ["requirement", "Requirement"],
    ["a_1", "A_1"],
  ])("Go_names_follow_protoc_gen_go(%s)", (proto, go) => {
    expect(goName(proto)).toBe(go);
  });

  it.each([
    ["^a$", "a", true],
    ["^a$", "a\n", false],
    ["^[$]$", "$", true],
  ])("Go_patterns_anchor_at_the_very_end(%j, %j)", (regex, input, matches) => {
    expect(goRegex(regex).test(input)).toBe(matches);
  });
});
