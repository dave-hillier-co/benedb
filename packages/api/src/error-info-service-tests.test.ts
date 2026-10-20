import { status } from "@grpc/grpc-js";
import { MaxDepthExceededException } from "@benedb/core/max-depth-exceeded-exception";
import type {
  BatchCheckItem,
  BatchCheckResult,
  IPermissionChecker,
  PermissionCheckResult,
} from "@benedb/grains/i-permission-checker";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import {
  type Relationship,
  RelationshipUpdate_Operation,
} from "@benedb/protos/authzed/api/v1/core";
import {
  CheckBulkPermissionsRequest,
  CheckPermissionRequest,
  DeleteRelationshipsRequest,
  ImportBulkRelationshipsRequest,
  Precondition_Operation,
  type RelationshipFilter,
  WriteRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { ErrorInfo } from "@benedb/protos/google/rpc/error_info";
import { describe, expect, it } from "vitest";

import { AuthzedExperimentalV1Service } from "./authzed-experimental-v1-service";
import { AuthzedPermissionsV1Service } from "./authzed-permissions-v1-service";
import { AuthzedSchemaV1Service } from "./authzed-schema-v1-service";
import { assertErrorInfo } from "./error-info-assertions";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ErrorInfoServiceTests.cs`.
 *
 * The `google.rpc.ErrorInfo` SpiceDB attaches to the reasoned errors that originate past the
 * request checks - in the schema, the datastore, the dispatcher - driven through the
 * `authzed.api.v1` services in-process over the test cluster. Each test names the SpiceDB v1.49.2
 * error type it mirrors.
 *
 * PORT NOTES.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - The C#'s `null!` collaborators become `undefined as never`.
 */

const SCHEMA = `definition user {}

definition group {
    relation member: user
}

caveat only_on_tuesday(day string) {
    day == "tuesday"
}

definition document {
    relation viewer: user | group#member
    relation caveated_viewer: user with only_on_tuesday
    permission view = viewer
}`;

function permissions(
  cluster: MeshTestCluster,
  checker?: IPermissionChecker,
): AuthzedPermissionsV1Service {
  return new AuthzedPermissionsV1Service(
    checker ?? cluster.checker,
    cluster.grainFactory,
    cluster.reverseOps,
    cluster.relationshipReads,
    cluster.schemaProvider,
  );
}

function experimental(cluster: MeshTestCluster): AuthzedExperimentalV1Service {
  return new AuthzedExperimentalV1Service(
    cluster.grainFactory,
    permissions(cluster),
    schemaService(cluster),
  );
}

function schemaService(cluster: MeshTestCluster): AuthzedSchemaV1Service {
  return new AuthzedSchemaV1Service(cluster.grainFactory, cluster.schemaProvider);
}

function rel(
  relation: string,
  subjectType = "user",
  subjectId = "alice",
  subjectRelation = "",
  resourceType = "document",
): Relationship {
  return {
    resource: { objectType: resourceType, objectId: "readme" },
    relation,
    subject: {
      object: { objectType: subjectType, objectId: subjectId },
      optionalRelation: subjectRelation,
    },
    optionalCaveat: undefined,
    optionalExpiresAt: undefined,
  };
}

function write(
  relationship: Relationship,
  operation = RelationshipUpdate_Operation.OPERATION_TOUCH,
): WriteRelationshipsRequest {
  return WriteRelationshipsRequest.fromPartial({ updates: [{ operation, relationship }] });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (error: unknown) => error,
  );
}

async function withCluster(body: (cluster: MeshTestCluster) => Promise<void>): Promise<void> {
  const cluster = await MeshTestCluster.create(SCHEMA);
  try {
    await body(cluster);
  } finally {
    await cluster.dispose();
  }
}

async function* asyncStream<T>(...messages: readonly T[]): AsyncIterable<T> {
  for (const message of messages) yield await Promise.resolve(message);
}

/** An {@link IPermissionChecker} that always throws the supplied error. */
class ThrowingChecker implements IPermissionChecker {
  readonly #error: unknown;

  constructor(error: unknown) {
    this.#error = error;
  }

  check(): Promise<PermissionCheckResult> {
    throw this.#error;
  }

  batchCheck(_items: readonly BatchCheckItem[]): Promise<BatchCheckResult> {
    throw this.#error;
  }
}

const RECREATED_README: readonly (readonly [string, string])[] = [
  ["relationship", "document:readme#viewer@group:eng#member"],
  ["resource_type", "document"],
  ["resource_object_id", "readme"],
  ["resource_relation", "viewer"],
  ["subject_type", "group"],
  ["subject_object_id", "eng"],
  ["subject_relation", "member"],
];

function counterFilter(): RelationshipFilter {
  return {
    resourceType: "document",
    optionalResourceId: "",
    optionalResourceIdPrefix: "",
    optionalRelation: "viewer",
    optionalSubjectFilter: {
      subjectType: "user",
      optionalSubjectId: "",
      optionalRelation: undefined,
    },
  };
}

describe("ErrorInfoServiceTests", () => {
  // namespace.NewNamespaceNotFoundErr through rewriteError
  it("Writing_to_an_unknown_definition_is_unknown_definition", () =>
    withCluster(async (cluster) => {
      assertErrorInfo(
        await rejection(
          permissions(cluster).writeRelationships(
            write(rel("viewer", "user", "alice", "", "folder")),
          ),
        ),
        status.FAILED_PRECONDITION,
        "ERROR_REASON_UNKNOWN_DEFINITION",
        ["definition_name", "folder"],
      );
    }));

  // namespace.NewRelationNotFoundErr through rewriteError, for the subject's relation
  it("Writing_an_unknown_subject_relation_is_unknown_relation_or_permission", () =>
    withCluster(async (cluster) => {
      assertErrorInfo(
        await rejection(
          permissions(cluster).writeRelationships(write(rel("viewer", "group", "eng", "admin"))),
        ),
        status.FAILED_PRECONDITION,
        "ERROR_REASON_UNKNOWN_RELATION_OR_PERMISSION",
        ["definition_name", "group"],
        ["relation_or_permission_name", "admin"],
      );
    }));

  // CannotWriteToPermissionError
  it("Writing_to_a_permission_is_cannot_update_permission", () =>
    withCluster(async (cluster) => {
      assertErrorInfo(
        await rejection(permissions(cluster).writeRelationships(write(rel("view")))),
        status.INVALID_ARGUMENT,
        "ERROR_REASON_CANNOT_UPDATE_PERMISSION",
        ["definition_name", "document"],
        ["permission_name", "view"],
      );
    }));

  // InvalidSubjectTypeError
  it("Writing_a_disallowed_subject_type_is_invalid_subject_type", () =>
    withCluster(async (cluster) => {
      assertErrorInfo(
        await rejection(
          permissions(cluster).writeRelationships(write(rel("viewer", "group", "eng"))),
        ),
        status.INVALID_ARGUMENT,
        "ERROR_REASON_INVALID_SUBJECT_TYPE",
        ["definition_name", "document"],
        ["relation_name", "viewer"],
        ["subject_type", "group"],
      );
    }));

  // InvalidSubjectTypeError with the caveats the subject needed
  it("Writing_without_a_required_caveat_names_the_allowed_caveats", () =>
    withCluster(async (cluster) => {
      assertErrorInfo(
        await rejection(permissions(cluster).writeRelationships(write(rel("caveated_viewer")))),
        status.INVALID_ARGUMENT,
        "ERROR_REASON_INVALID_SUBJECT_TYPE",
        ["definition_name", "document"],
        ["relation_name", "caveated_viewer"],
        ["subject_type", "user"],
        ["allowed_caveats", "only_on_tuesday"],
      );
    }));

  // PreconditionFailedError
  it("An_unmet_write_precondition_is_a_precondition_failure", () =>
    withCluster(async (cluster) => {
      const request = write(rel("viewer"));
      request.optionalPreconditions.push({
        operation: Precondition_Operation.OPERATION_MUST_MATCH,
        filter: {
          resourceType: "document",
          optionalResourceId: "",
          optionalResourceIdPrefix: "read",
          optionalRelation: "",
          optionalSubjectFilter: {
            subjectType: "group",
            optionalSubjectId: "",
            optionalRelation: { relation: "" },
          },
        },
      });

      assertErrorInfo(
        await rejection(permissions(cluster).writeRelationships(request)),
        status.FAILED_PRECONDITION,
        "ERROR_REASON_WRITE_OR_DELETE_PRECONDITION_FAILURE",
        ["precondition_operation", "OPERATION_MUST_MATCH"],
        ["precondition_resource_type", "document"],
        ["precondition_resource_id_prefix", "read"],
        ["precondition_subject_type", "group"],
        ["precondition_subject_relation", ""],
      );
    }));

  // PreconditionFailedError on a delete
  it("An_unmet_delete_precondition_is_a_precondition_failure", () =>
    withCluster(async (cluster) => {
      const request = DeleteRelationshipsRequest.fromPartial({
        relationshipFilter: { resourceType: "document" },
        optionalPreconditions: [
          {
            operation: Precondition_Operation.OPERATION_MUST_MATCH,
            filter: {
              resourceType: "document",
              optionalResourceId: "readme",
              optionalRelation: "viewer",
              optionalSubjectFilter: { subjectType: "user", optionalSubjectId: "alice" },
            },
          },
        ],
      });

      assertErrorInfo(
        await rejection(permissions(cluster).deleteRelationships(request)),
        status.FAILED_PRECONDITION,
        "ERROR_REASON_WRITE_OR_DELETE_PRECONDITION_FAILURE",
        ["precondition_operation", "OPERATION_MUST_MATCH"],
        ["precondition_resource_type", "document"],
        ["precondition_resource_id", "readme"],
        ["precondition_relation", "viewer"],
        ["precondition_subject_type", "user"],
        ["precondition_subject_id", "alice"],
      );
    }));

  // CreateRelationshipExistsError
  it("Creating_an_existing_relationship_is_an_attempt_to_recreate_it", () =>
    withCluster(async (cluster) => {
      const relationship = rel("viewer", "group", "eng", "member");
      await permissions(cluster).writeRelationships(write(relationship));

      assertErrorInfo(
        await rejection(
          permissions(cluster).writeRelationships(
            write(relationship, RelationshipUpdate_Operation.OPERATION_CREATE),
          ),
        ),
        status.ALREADY_EXISTS,
        "ERROR_REASON_ATTEMPT_TO_RECREATE_RELATIONSHIP",
        ...RECREATED_README,
      );
    }));

  // CreateRelationshipExistsError from a bulk import
  it("Importing_an_existing_relationship_is_an_attempt_to_recreate_it", () =>
    withCluster(async (cluster) => {
      const relationship = rel("viewer", "group", "eng", "member");
      await permissions(cluster).writeRelationships(write(relationship));

      assertErrorInfo(
        await rejection(
          permissions(cluster).importBulkRelationships(
            asyncStream(
              ImportBulkRelationshipsRequest.fromPartial({ relationships: [relationship] }),
            ),
          ),
        ),
        status.ALREADY_EXISTS,
        "ERROR_REASON_ATTEMPT_TO_RECREATE_RELATIONSHIP",
        ...RECREATED_README,
      );
    }));

  // CouldNotTransactionallyDeleteError
  it("A_transactional_delete_over_its_limit_names_the_filter", () =>
    withCluster(async (cluster) => {
      await permissions(cluster).writeRelationships(
        WriteRelationshipsRequest.fromPartial({
          updates: ["alice", "bob"].map((user) => ({
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: rel("viewer", "user", user),
          })),
        }),
      );

      const request = DeleteRelationshipsRequest.fromPartial({
        relationshipFilter: {
          resourceType: "document",
          optionalRelation: "viewer",
          optionalSubjectFilter: { subjectType: "user", optionalRelation: { relation: "" } },
        },
        optionalLimit: 1,
      });
      assertErrorInfo(
        await rejection(permissions(cluster).deleteRelationships(request)),
        status.INVALID_ARGUMENT,
        "ERROR_REASON_TOO_MANY_RELATIONSHIPS_FOR_TRANSACTIONAL_DELETE",
        ["limit", "1"],
        ["filter_resource_type", "document"],
        ["filter_relation", "viewer"],
        ["filter_subject_type", "user"],
        ["filter_subject_relation", ""],
      );
    }));

  // dispatch.MaxDepthExceededError
  it("A_check_past_the_maximum_depth_is_maximum_depth_exceeded", () =>
    withCluster(async (cluster) => {
      const service = permissions(cluster, new ThrowingChecker(new MaxDepthExceededException()));
      assertErrorInfo(
        await rejection(
          service.checkPermission(
            CheckPermissionRequest.fromPartial({
              resource: { objectType: "document", objectId: "readme" },
              permission: "view",
              subject: rel("viewer").subject,
            }),
          ),
        ),
        status.FAILED_PRECONDITION,
        "ERROR_REASON_MAXIMUM_DEPTH_EXCEEDED",
      );
    }));

  // A bulk-check pair error carries its ErrorInfo in the pair's google.rpc.Status.
  it("A_bulk_check_pair_error_carries_its_error_info", () =>
    withCluster(async (cluster) => {
      const response = await permissions(cluster).checkBulkPermissions(
        CheckBulkPermissionsRequest.fromPartial({
          items: [
            {
              resource: { objectType: "folder", objectId: "readme" },
              permission: "view",
              subject: rel("viewer").subject,
            },
          ],
        }),
      );

      expect(response.pairs).toHaveLength(1);
      const error = response.pairs[0]?.error;
      expect(error?.code).toBe(status.FAILED_PRECONDITION);
      expect(error?.details).toHaveLength(1);
      const info = ErrorInfo.decode(error?.details[0]?.value ?? new Uint8Array());
      expect(info.reason).toBe("ERROR_REASON_UNKNOWN_DEFINITION");
      expect(info.metadata["definition_name"]).toBe("folder");
    }));

  // CounterAlreadyRegisteredError through rewriteError: the metadata describes the NEW filter.
  it("Registering_a_counter_twice_is_counter_already_registered", () =>
    withCluster(async (cluster) => {
      const register = { name: "viewers", relationshipFilter: counterFilter() };
      await experimental(cluster).experimentalRegisterRelationshipCounter(register);

      assertErrorInfo(
        await rejection(experimental(cluster).experimentalRegisterRelationshipCounter(register)),
        status.FAILED_PRECONDITION,
        "ERROR_REASON_COUNTER_ALREADY_REGISTERED",
        ["counter_name", "viewers"],
        ["new_filter_resource_type", "document"],
        ["new_filter_resource_id", ""],
        ["new_filter_resource_id_prefix", ""],
        ["new_filter_relation", "viewer"],
        ["new_filter_subject_type", "user"],
        ["new_filter_subject_id", ""],
        ["new_filter_subject_relation", ""],
      );
    }));

  // CounterNotRegisteredError through rewriteError
  it("Counting_an_unregistered_counter_is_counter_not_registered", () =>
    withCluster(async (cluster) => {
      assertErrorInfo(
        await rejection(experimental(cluster).experimentalCountRelationships({ name: "missing" })),
        status.FAILED_PRECONDITION,
        "ERROR_REASON_COUNTER_NOT_REGISTERED",
        ["counter_name", "missing"],
      );
      assertErrorInfo(
        await rejection(
          experimental(cluster).experimentalUnregisterRelationshipCounter({ name: "missing" }),
        ),
        status.FAILED_PRECONDITION,
        "ERROR_REASON_COUNTER_NOT_REGISTERED",
        ["counter_name", "missing"],
      );
    }));

  // spiceerrors.WithCodeAndReason(errors.New("name must be provided"), InvalidArgument,
  // UNSPECIFIED): the counter-name pattern admits the empty string, so the handlers reject it
  // themselves.
  it("A_counter_without_a_name_is_rejected_before_the_datastore", async () => {
    const service = new AuthzedExperimentalV1Service(
      undefined as never,
      undefined as never,
      undefined as never,
    );
    assertErrorInfo(
      await rejection(
        service.experimentalRegisterRelationshipCounter({
          name: "",
          relationshipFilter: counterFilter(),
        }),
      ),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_UNSPECIFIED",
    );
    assertErrorInfo(
      await rejection(service.experimentalUnregisterRelationshipCounter({ name: "" })),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_UNSPECIFIED",
    );
    const count = await rejection(service.experimentalCountRelationships({ name: "" }));
    assertErrorInfo(count, status.INVALID_ARGUMENT, "ERROR_REASON_UNSPECIFIED");
    expect((count as { details: string }).details).toBe("name must be provided");
  });

  // schema.NewRelationNotFoundErr through rewriteError
  it("Introspecting_an_unknown_relation_is_unknown_relation_or_permission", () =>
    withCluster(async (cluster) => {
      assertErrorInfo(
        await rejection(
          schemaService(cluster).dependentRelations({
            consistency: undefined,
            definitionName: "document",
            permissionName: "edit",
          }),
        ),
        status.FAILED_PRECONDITION,
        "ERROR_REASON_UNKNOWN_RELATION_OR_PERMISSION",
        ["definition_name", "document"],
        ["relation_or_permission_name", "edit"],
      );
    }));

  // NotAPermissionError
  it("Asking_for_the_dependents_of_a_relation_is_not_a_permission", () =>
    withCluster(async (cluster) => {
      assertErrorInfo(
        await rejection(
          schemaService(cluster).dependentRelations({
            consistency: undefined,
            definitionName: "document",
            permissionName: "viewer",
          }),
        ),
        status.INVALID_ARGUMENT,
        "ERROR_REASON_UNKNOWN_RELATION_OR_PERMISSION",
        ["relationName", "viewer"],
      );
    }));
});
