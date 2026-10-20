import { describe, expect, it } from "vitest";
import { AuthzedPermissionsV1Service } from "@benedb/api/authzed-permissions-v1-service";
import { AuthzedSchemaV1Service } from "@benedb/api/authzed-schema-v1-service";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import { RelationshipUpdate_Operation } from "@benedb/protos/authzed/api/v1/core";
import {
  CheckPermissionRequest,
  WriteRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { WriteSchemaRequest } from "@benedb/protos/authzed/api/v1/schema_service";

import { normalizePermissionship } from "./differential-comparison";
import {
  spiceDbAvailable,
  spiceDbSkipReason,
  useSpiceDbContainer,
} from "./spice-db-container-fixture";
import { SpiceDbGrpcClient } from "./spice-db-grpc-client";
import { resetSpiceDb } from "./spice-db-reset";

/**
 * BeneDB-only: no Spiceport counterpart.
 *
 * Directed differential coverage for caveat bodies whose text `@bufbuild/cel` parses differently
 * from cel-go. Each case writes the same schema to a real SpiceDB container and to BeneDB's
 * in-process services over the grain mesh, writes one caveated relationship to both, and asserts
 * both sides return the same permissionship for a Check under each context.
 *
 * The schema parser stores a caveat body trimmed, so a body whose last line is a `//` comment is
 * stored ending in that comment with no newline after it; SpiceDB accepts and evaluates it.
 *
 * All cases share one container and each writes its own schema, so the file is
 * `describe.sequential` and {@link resetSpiceDb} runs before each `WriteSchema`.
 */

const fixture = useSpiceDbContainer();

/** The schema every cluster is constructed with: the schema under test is written through the service. */
const MinimalSchema = "definition user {}";

interface CaveatCase {
  readonly label: string;
  readonly body: string;
  readonly contexts: readonly Record<string, unknown>[];
}

const Cases: readonly CaveatCase[] = [
  {
    label: "trailing-line-comment",
    body: "b // note",
    contexts: [{ b: true }, { b: false }, {}],
  },
  {
    label: "line-comment-on-last-line",
    body: "b\n  // note",
    contexts: [{ b: true }, { b: false }, {}],
  },
];

function schemaFor(body: string): string {
  return `definition user {}

caveat c(b bool) {
  ${body}
}

definition document {
    relation viewer: user with c
    permission view = viewer
}`;
}

const Write = WriteRelationshipsRequest.fromPartial({
  updates: [
    {
      operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
      relationship: {
        resource: { objectType: "document", objectId: "readme" },
        relation: "viewer",
        subject: { object: { objectType: "user", objectId: "alice" }, optionalRelation: "" },
        optionalCaveat: { caveatName: "c" },
      },
    },
  ],
});

function checkRequest(context: Record<string, unknown>): CheckPermissionRequest {
  return CheckPermissionRequest.fromPartial({
    resource: { objectType: "document", objectId: "readme" },
    permission: "view",
    subject: { object: { objectType: "user", objectId: "alice" }, optionalRelation: "" },
    context,
    consistency: { fullyConsistent: true },
  });
}

describe.sequential("CaveatExpressionDifferentialTests", () => {
  for (const { label, body, contexts } of Cases) {
    it(`Caveat evaluation agrees with SpiceDB [${label}]`, async (ctx) => {
      ctx.skip(!spiceDbAvailable, spiceDbSkipReason);
      const schema = schemaFor(body);

      const expected: string[] = [];
      const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
      try {
        await resetSpiceDb(spiceDbClient);
        await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema }));
        await spiceDbClient.writeRelationships(Write);
        for (const context of contexts) {
          const response = await spiceDbClient.checkPermission(checkRequest(context));
          expected.push(normalizePermissionship(response.permissionship));
        }
        await resetSpiceDb(spiceDbClient);
      } finally {
        spiceDbClient.close();
      }

      const actual: string[] = [];
      const cluster = await MeshTestCluster.create(MinimalSchema);
      try {
        await new AuthzedSchemaV1Service(cluster.grainFactory, cluster.schemaProvider).writeSchema({
          schema,
        });
        const permissions = new AuthzedPermissionsV1Service(
          cluster.checker,
          cluster.grainFactory,
          cluster.reverseOps,
          cluster.relationshipReads,
          cluster.schemaProvider,
        );
        await permissions.writeRelationships(Write);
        for (const context of contexts) {
          const response = await permissions.checkPermission(checkRequest(context));
          actual.push(normalizePermissionship(response.permissionship));
        }
      } finally {
        await cluster.dispose();
      }

      expect(actual, `[${label}] contexts ${JSON.stringify(contexts)}`).toEqual(expected);
    });
  }
});
