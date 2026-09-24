import { status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { AuthzedPermissionsV1Service } from "@benedb/api/authzed-permissions-v1-service";
import { RpcError } from "@benedb/api/rpc-error";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import type { Relationship } from "@benedb/protos/authzed/api/v1/core";
import { RelationshipUpdate_Operation } from "@benedb/protos/authzed/api/v1/core";
import { WriteRelationshipsRequest } from "@benedb/protos/authzed/api/v1/permission_service";
import { WriteSchemaRequest } from "@benedb/protos/authzed/api/v1/schema_service";

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

interface Outcome {
  readonly code: number;
  readonly details: string;
}

async function outcome(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    () => ({ code: status.OK, details: "" }),
    (reason: unknown) => {
      const error = reason as { code?: unknown; details?: unknown };
      return { code: Number(error.code), details: String(error.details) };
    },
  );
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
});
