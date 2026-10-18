import { Metadata, status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { AuthzedPermissionsV1Service } from "@benedb/api/authzed-permissions-v1-service";
import { RpcError } from "@benedb/api/rpc-error";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import type { Relationship } from "@benedb/protos/authzed/api/v1/core";
import { RelationshipUpdate_Operation } from "@benedb/protos/authzed/api/v1/core";
import {
  CheckPermissionRequest,
  DeleteRelationshipsRequest,
  Precondition_Operation,
  WriteRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { WriteSchemaRequest } from "@benedb/protos/authzed/api/v1/schema_service";
import { ErrorInfo } from "@benedb/protos/google/rpc/error_info";
import { Status } from "@benedb/protos/google/rpc/status";

import {
  spiceDbAvailable,
  spiceDbSkipReason,
  useSpiceDbContainer,
} from "./spice-db-container-fixture";
import { SpiceDbGrpcClient } from "./spice-db-grpc-client";
import { resetSpiceDb } from "./spice-db-reset";

/**
 * Directed differential gate for BeneDB issues #1 and #4. Issue #1: `WriteRelationships` validates every update
 * against the schema (SpiceDB `relationships.ValidateRelationshipUpdates`) before persisting it.
 * Each case submits the SAME request to a real `authzed/spicedb` container and to BeneDB's
 * in-process `AuthzedPermissionsV1Service`, and asserts both give the same outcome: the same gRPC
 * status code and the same detail text, or success on both. Issue #4: a missing required
 * submessage is INVALID_ARGUMENT with SpiceDB's own protoc-gen-validate text, never an UNKNOWN fault.
 * Both sides' `google.rpc.ErrorInfo` details are compared too (spiceport#46).
 */

const fixture = useSpiceDbContainer();

const Schema = `use expiration

definition user {}

definition group {
    relation member: user
}

caveat only_on_tuesday(day string) {
    day == "tuesday"
}

definition document {
    relation viewer: user | group#member
    relation caveated_viewer: user with only_on_tuesday
    relation expiring_viewer: user with expiration
    relation public_viewer: user:*
    permission view = viewer + caveated_viewer
}`;

interface RelSpec {
  readonly resourceType?: string;
  readonly relation: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly subjectRelation?: string;
  readonly caveat?: string;
  readonly expires?: boolean;
}

function rel(spec: RelSpec): Relationship {
  return {
    resource: { objectType: spec.resourceType ?? "document", objectId: "readme" },
    relation: spec.relation,
    subject: {
      object: { objectType: spec.subjectType ?? "user", objectId: spec.subjectId ?? "alice" },
      optionalRelation: spec.subjectRelation ?? "",
    },
    optionalCaveat:
      spec.caveat === undefined ? undefined : { caveatName: spec.caveat, context: undefined },
    optionalExpiresAt: spec.expires === true ? new Date(Date.UTC(2099, 0, 1)) : undefined,
  };
}

function req(operation: RelationshipUpdate_Operation, spec: RelSpec): WriteRelationshipsRequest {
  return WriteRelationshipsRequest.fromPartial({
    updates: [{ operation, relationship: rel(spec) }],
  });
}

const TOUCH = RelationshipUpdate_Operation.OPERATION_TOUCH;
const DELETE = RelationshipUpdate_Operation.OPERATION_DELETE;

const Cases: readonly (readonly [
  name: string,
  expected: status,
  build: () => WriteRelationshipsRequest,
])[] = [
  [
    "unknown_resource_definition",
    status.FAILED_PRECONDITION,
    () => req(TOUCH, { resourceType: "folder", relation: "viewer" }),
  ],
  [
    "unknown_resource_relation",
    status.FAILED_PRECONDITION,
    () => req(TOUCH, { relation: "owner" }),
  ],
  [
    "unknown_subject_definition",
    status.FAILED_PRECONDITION,
    () => req(TOUCH, { relation: "viewer", subjectType: "team" }),
  ],
  [
    "unknown_subject_relation",
    status.FAILED_PRECONDITION,
    () => req(TOUCH, { relation: "viewer", subjectType: "group", subjectRelation: "admin" }),
  ],
  ["write_to_permission", status.INVALID_ARGUMENT, () => req(TOUCH, { relation: "view" })],
  [
    "disallowed_subject_type",
    status.INVALID_ARGUMENT,
    () =>
      req(TOUCH, { relation: "public_viewer", subjectType: "group", subjectRelation: "member" }),
  ],
  [
    "missing_required_caveat",
    status.INVALID_ARGUMENT,
    () => req(TOUCH, { relation: "caveated_viewer" }),
  ],
  [
    "disallowed_caveat",
    status.INVALID_ARGUMENT,
    () => req(TOUCH, { relation: "viewer", caveat: "only_on_tuesday" }),
  ],
  [
    "disallowed_expiration",
    status.INVALID_ARGUMENT,
    () => req(TOUCH, { relation: "viewer", expires: true }),
  ],
  [
    "missing_expiration_trait_suggestion",
    status.INVALID_ARGUMENT,
    () => req(TOUCH, { relation: "expiring_viewer" }),
  ],
  [
    "disallowed_wildcard",
    status.INVALID_ARGUMENT,
    () => req(TOUCH, { relation: "viewer", subjectId: "*" }),
  ],
  ["allowed_touch", status.OK, () => req(TOUCH, { relation: "viewer" })],
  [
    "uncaveated_delete_of_caveated_relation",
    status.OK,
    () => req(DELETE, { relation: "caveated_viewer" }),
  ],
  [
    "uncaveated_delete_of_expiring_relation",
    status.OK,
    () => req(DELETE, { relation: "expiring_viewer" }),
  ],
  [
    "delete_of_disallowed_subject_type",
    status.INVALID_ARGUMENT,
    () =>
      req(DELETE, { relation: "public_viewer", subjectType: "group", subjectRelation: "member" }),
  ],
];

const Malformed: readonly (readonly [
  name: string,
  relationship: Partial<Relationship> | undefined,
])[] = [
  ["missing_relationship", undefined],
  [
    "missing_resource",
    {
      relation: "viewer",
      subject: { object: { objectType: "user", objectId: "a" }, optionalRelation: "" },
    },
  ],
  ["missing_subject", { resource: { objectType: "document", objectId: "d" }, relation: "viewer" }],
  [
    "missing_subject_object",
    {
      resource: { objectType: "document", objectId: "d" },
      relation: "viewer",
      subject: { object: undefined, optionalRelation: "" },
    },
  ],
];

/**
 * Requests missing a required filter (spiceport#54): a precondition with no `filter` on a write or
 * a delete, and a delete with no `relationship_filter`. Each is sent to both servers.
 */
const MissingFilter: readonly (readonly [
  name: string,
  send: (target: {
    writeRelationships(request: WriteRelationshipsRequest): Promise<unknown>;
    deleteRelationships(request: DeleteRelationshipsRequest): Promise<unknown>;
  }) => Promise<unknown>,
])[] = [
  [
    "write_precondition_without_filter",
    (target) =>
      target.writeRelationships(
        WriteRelationshipsRequest.fromPartial({
          updates: [
            {
              operation: TOUCH,
              relationship: {
                resource: { objectType: "document", objectId: "d" },
                relation: "viewer",
                subject: { object: { objectType: "user", objectId: "a" }, optionalRelation: "" },
              },
            },
          ],
          optionalPreconditions: [{ operation: Precondition_Operation.OPERATION_MUST_MATCH }],
        }),
      ),
  ],
  [
    "delete_without_relationship_filter",
    (target) => target.deleteRelationships(DeleteRelationshipsRequest.fromPartial({})),
  ],
  [
    "delete_precondition_without_filter",
    (target) =>
      target.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document" },
          optionalPreconditions: [{ operation: Precondition_Operation.OPERATION_MUST_MATCH }],
        }),
      ),
  ],
];

/**
 * Requests that break the `authzed.api.v1` id, type and name grammar (spiceport#46): SpiceDB rejects
 * each in its protoc-gen-validate or handwritten validation interceptor, before any handler runs.
 */
const Ungrammatical: readonly (readonly [
  name: string,
  expected: status,
  send: (target: {
    writeRelationships(request: WriteRelationshipsRequest): Promise<unknown>;
    deleteRelationships(request: DeleteRelationshipsRequest): Promise<unknown>;
    checkPermission(request: CheckPermissionRequest): Promise<unknown>;
  }) => Promise<unknown>,
])[] = [
  [
    "write_uppercase_resource_type",
    status.INVALID_ARGUMENT,
    (target) =>
      target.writeRelationships(req(TOUCH, { resourceType: "Document", relation: "viewer" })),
  ],
  [
    "write_malformed_relation_and_subject_id",
    status.INVALID_ARGUMENT,
    (target) => target.writeRelationships(req(TOUCH, { relation: "Viewer", subjectId: "a b" })),
  ],
  [
    "write_wildcard_subject_with_relation",
    status.INVALID_ARGUMENT,
    (target) =>
      target.writeRelationships(
        req(TOUCH, {
          relation: "viewer",
          subjectType: "group",
          subjectId: "*",
          subjectRelation: "member",
        }),
      ),
  ],
  [
    "write_unspecified_operation",
    status.INVALID_ARGUMENT,
    (target) =>
      target.writeRelationships(
        req(RelationshipUpdate_Operation.OPERATION_UNSPECIFIED, { relation: "viewer" }),
      ),
  ],
  [
    "delete_wildcard_resource_id",
    status.INVALID_ARGUMENT,
    (target) =>
      target.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "*" },
        }),
      ),
  ],
  [
    "check_wildcard_resource",
    status.INVALID_ARGUMENT,
    (target) =>
      target.checkPermission(
        CheckPermissionRequest.fromPartial({
          resource: { objectType: "document", objectId: "*" },
          permission: "view",
          subject: { object: { objectType: "user", objectId: "alice" } },
        }),
      ),
  ],
  // SpiceDB's consistency middleware runs before field validation, so an empty Consistency is its
  // INTERNAL "missing handling of consistency case in " even though the object id is also too long.
  // The message ends in a space, so a grpc-js client receives it as "" (see asReceivedOverGrpcJs).
  [
    "check_overlong_object_id_and_empty_consistency",
    status.INTERNAL,
    (target) =>
      target.checkPermission(
        CheckPermissionRequest.fromPartial({
          consistency: {},
          resource: { objectType: "document", objectId: "a".repeat(1025) },
          permission: "view",
          subject: { object: { objectType: "user", objectId: "alice" } },
        }),
      ),
  ],
  [
    "check_overlong_object_id",
    status.INVALID_ARGUMENT,
    (target) =>
      target.checkPermission(
        CheckPermissionRequest.fromPartial({
          resource: { objectType: "document", objectId: "a".repeat(1025) },
          permission: "view",
          subject: { object: { objectType: "user", objectId: "alice" } },
        }),
      ),
  ],
];

interface Outcome {
  readonly code: number;
  readonly details: string;
  /** The `google.rpc.ErrorInfo` in the status details (spiceport#46), when the error carries one. */
  readonly errorInfo: ErrorInfo | undefined;
}

async function outcome(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    () => ({ code: status.OK, details: "", errorInfo: undefined }),
    (reason: unknown) => {
      const error = reason as { code?: unknown; details?: unknown; metadata?: unknown };
      return {
        code: Number(error.code),
        details: asReceivedOverGrpcJs(String(error.details)),
        errorInfo: errorInfoIn(error.metadata),
      };
    },
  );
}

/**
 * A status message as a grpc-js client receives it. Node's HTTP/2 layer drops a header field whose
 * value starts or ends with whitespace (RFC 9113 section 8.2.1), so such a `grpc-message` trailer
 * never arrives and grpc-js reports an empty detail. Observed against a running SpiceDB v1.49.2:
 * its INTERNAL "missing handling of consistency case in " (trailing space) reaches a Go client
 * whole and a grpc-js client as "". BeneDB's in-process error is the server's status, so it is
 * compared as it would arrive over the same transport.
 */
function asReceivedOverGrpcJs(details: string): string {
  return /^\s|\s$/u.test(details) ? "" : details;
}

/** Decodes the `ErrorInfo` from a `grpc-status-details-bin` trailer, as a client reads it. */
function errorInfoIn(metadata: unknown): ErrorInfo | undefined {
  if (!(metadata instanceof Metadata)) return undefined;
  const trailer = metadata.get("grpc-status-details-bin")[0];
  if (!(trailer instanceof Buffer)) return undefined;
  const detail = Status.decode(trailer).details.find(
    (d) => d.typeUrl === "type.googleapis.com/google.rpc.ErrorInfo",
  );
  return detail === undefined ? undefined : ErrorInfo.decode(detail.value);
}

describe.sequential("WriteRelationshipsSchemaValidationDifferentialTests", () => {
  for (const [name, expected, build] of Cases) {
    it(`WriteRelationships schema validation agrees with SpiceDB [${name}]`, async (ctx) => {
      ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

      let spiceDb: Outcome;
      const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
      try {
        await resetSpiceDb(spiceDbClient);
        await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema: Schema }));
        spiceDb = await outcome(spiceDbClient.writeRelationships(build()));
        expect(spiceDb.code).toBe(expected);
      } finally {
        spiceDbClient.close();
      }

      const cluster = await MeshTestCluster.create(Schema);
      try {
        const service = new AuthzedPermissionsV1Service(
          cluster.checker,
          cluster.grainFactory,
          cluster.reverseOps,
          cluster.relationshipReads,
          cluster.schemaProvider,
        );
        const benedbPromise = service.writeRelationships(build());
        const benedb = await outcome(benedbPromise);
        await benedbPromise.catch((error: unknown) => {
          expect(error).toBeInstanceOf(RpcError);
        });

        expect(benedb).toEqual(spiceDb);
      } finally {
        await cluster.dispose();
      }
    });
  }

  for (const [name, relationship] of Malformed) {
    it(`WriteRelationships malformed submessage agrees with SpiceDB [${name}]`, async (ctx) => {
      ctx.skip(!spiceDbAvailable, spiceDbSkipReason);
      const build = (): WriteRelationshipsRequest =>
        WriteRelationshipsRequest.fromPartial({ updates: [{ operation: TOUCH, relationship }] });

      let spiceDb: Outcome;
      const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
      try {
        await resetSpiceDb(spiceDbClient);
        await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema: Schema }));
        spiceDb = await outcome(spiceDbClient.writeRelationships(build()));
        expect(spiceDb.code).toBe(status.INVALID_ARGUMENT);
      } finally {
        spiceDbClient.close();
      }

      const cluster = await MeshTestCluster.create(Schema);
      try {
        const service = new AuthzedPermissionsV1Service(
          cluster.checker,
          cluster.grainFactory,
          cluster.reverseOps,
          cluster.relationshipReads,
          cluster.schemaProvider,
        );
        expect(await outcome(service.writeRelationships(build()))).toEqual(spiceDb);
      } finally {
        await cluster.dispose();
      }
    });
  }

  for (const [name, send] of MissingFilter) {
    it(`Missing required filter agrees with SpiceDB [${name}]`, async (ctx) => {
      ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

      let spiceDb: Outcome;
      const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
      try {
        await resetSpiceDb(spiceDbClient);
        await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema: Schema }));
        spiceDb = await outcome(send(spiceDbClient));
        expect(spiceDb.code).toBe(status.INVALID_ARGUMENT);
      } finally {
        spiceDbClient.close();
      }

      const cluster = await MeshTestCluster.create(Schema);
      try {
        const service = new AuthzedPermissionsV1Service(
          cluster.checker,
          cluster.grainFactory,
          cluster.reverseOps,
          cluster.relationshipReads,
          cluster.schemaProvider,
        );
        expect(await outcome(send(service))).toEqual(spiceDb);
      } finally {
        await cluster.dispose();
      }
    });
  }

  for (const [name, expected, send] of Ungrammatical) {
    it(`Ungrammatical request agrees with SpiceDB [${name}]`, async (ctx) => {
      ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

      let spiceDb: Outcome;
      const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
      try {
        await resetSpiceDb(spiceDbClient);
        await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema: Schema }));
        spiceDb = await outcome(send(spiceDbClient));
        expect(spiceDb.code).toBe(expected);
      } finally {
        spiceDbClient.close();
      }

      const cluster = await MeshTestCluster.create(Schema);
      try {
        const service = new AuthzedPermissionsV1Service(
          cluster.checker,
          cluster.grainFactory,
          cluster.reverseOps,
          cluster.relationshipReads,
          cluster.schemaProvider,
        );
        expect(await outcome(send(service))).toEqual(spiceDb);
      } finally {
        await cluster.dispose();
      }
    });
  }
});
