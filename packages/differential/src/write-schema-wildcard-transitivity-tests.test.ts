import { status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { AuthzedSchemaV1Service } from "@benedb/api/authzed-schema-v1-service";
import { RpcError } from "@benedb/api/rpc-error";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
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
 * Ported from Spiceport `tests/Spiceport.Differential.Tests/WriteSchemaWildcardTransitivityTests.cs`.
 *
 * Directed (non-random) differential coverage for spiceport issue #33: SpiceDB rejects
 * `WriteSchema` when a wildcard is reachable through a userset reference ("wildcard relations
 * cannot be transitively included"), and accepts a handful of adjacent shapes that must NOT be
 * over-rejected. Unlike the random-world and corpus suites, this one targets specific, hand-written
 * schema shapes chosen to pin the accept/reject boundary the type validator has to reproduce
 * exactly.
 *
 * Each case writes the SAME schema text to a real SpiceDB container and to BeneDB's in-process
 * `AuthzedSchemaV1Service` (over the real grain mesh, via `MeshTestCluster`), and asserts both
 * sides reach the same accept/reject verdict - and, when rejecting, the same gRPC status code
 * (`FAILED_PRECONDITION`).
 *
 * PORT DECISIONS.
 *
 *  1. C# raw string literals (`"""`) STRIP the common leading indentation; a TS template literal
 *     does NOT. Every schema is written FLUSH-LEFT so the bytes handed to both systems are the
 *     same. The parser is whitespace-tolerant, so this is not expected to change a verdict - the
 *     point is that both sides see identical input.
 *  2. TypeScript has no `await using`, so each case disposes its cluster in an explicit `finally`.
 *  3. `[Collection(SpiceDbCollection.Name)]` -> {@link useSpiceDbContainer}; all cases share one
 *     container and each mutates its schema, so the file is `describe.sequential` and
 *     {@link resetSpiceDb} runs BEFORE each `WriteSchema`, never after.
 *  4. ERROR SHAPES DIFFER BY SIDE: the real-SpiceDB side rejects with a grpc-js `ServiceError`
 *     (numeric `.code`), the BeneDB side with an `RpcError`. Each is asserted against its own
 *     shape; a shared matcher would silently pass on one of them.
 */

const fixture = useSpiceDbContainer();

/** The schema every cluster is CONSTRUCTED with: the schema under test is written through the service. */
const MinimalSchema = "definition user {}";

const RejectedShapes: readonly (readonly [label: string, schema: string])[] = [
  [
    "wildcard-one-level-via-userset",
    `definition user {}
definition group {
    relation member: user:*
}
definition document {
    relation viewer: group#member
}`,
  ],
  [
    "wildcard-two-levels-via-userset",
    `definition user {}
definition group {
    relation member: user:*
}
definition team {
    relation groupmember: group#member
}
definition document {
    relation viewer: team#groupmember
}`,
  ],
  [
    "wildcard-on-left-of-arrow",
    `definition user {}
definition document {
    relation parent: user:*
    permission view = parent->view
}`,
  ],
];

const AcceptedShapes: readonly (readonly [label: string, schema: string])[] = [
  [
    "direct-wildcard-on-defining-relation",
    `definition user {}
definition document {
    relation viewer: user:*
}`,
  ],
  [
    "wildcard-reachable-only-through-a-permission",
    `definition user {}
definition group {
    relation member: user:*
}
definition team {
    relation groupmember: group
    permission allmembers = groupmember->member
}
definition document {
    relation viewer: team#allmembers
}`,
  ],
  [
    "wildcard-reachable-through-same-definition-cross-relation",
    `definition user {}
definition group {
    relation adminwildcard: user:*
    relation member: group#adminwildcard
}`,
  ],
];

/** `Assert.ThrowsAsync<RpcException>` - returns the caught reason so the caller can assert on it. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe.sequential("WriteSchemaWildcardTransitivityTests", () => {
  for (const [label, schema] of RejectedShapes) {
    it(`Rejected by real SpiceDB is also rejected by BeneDB [${label}]`, async (ctx) => {
      ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

      const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
      try {
        await resetSpiceDb(spiceDbClient);
        const spiceDbError = await caught(
          spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema })),
        );
        expect(spiceDbError, `[${label}] expected real SpiceDB to reject`).toBeInstanceOf(Error);
        expect(
          (spiceDbError as { code?: unknown }).code,
          `[${label}] real SpiceDB: ${String((spiceDbError as { details?: unknown }).details)}`,
        ).toBe(status.FAILED_PRECONDITION);
      } finally {
        spiceDbClient.close();
      }

      const cluster = await MeshTestCluster.create(MinimalSchema);
      try {
        const service = new AuthzedSchemaV1Service(cluster.grainFactory, cluster.schemaProvider);

        const benedbError = await caught(service.writeSchema({ schema }));
        expect(benedbError, `[${label}] expected BeneDB to reject`).toBeInstanceOf(RpcError);
        expect(
          (benedbError as RpcError).code,
          `[${label}] expected FAILED_PRECONDITION, got ${(benedbError as RpcError).code}: ${(benedbError as RpcError).details}`,
        ).toBe(status.FAILED_PRECONDITION);
      } finally {
        await cluster.dispose();
      }
    });
  }

  for (const [label, schema] of AcceptedShapes) {
    it(`Accepted by real SpiceDB is also accepted by BeneDB [${label}]`, async (ctx) => {
      ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

      const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
      try {
        await resetSpiceDb(spiceDbClient);
        // Must not throw - real SpiceDB accepts this shape.
        await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema }));
      } finally {
        spiceDbClient.close();
      }

      const cluster = await MeshTestCluster.create(MinimalSchema);
      try {
        const service = new AuthzedSchemaV1Service(cluster.grainFactory, cluster.schemaProvider);

        const error = await caught(service.writeSchema({ schema }));

        expect(
          error === undefined,
          `[${label}] expected BeneDB to accept, got: ${String(error)}`,
        ).toBe(true);
      } finally {
        await cluster.dispose();
      }
    });
  }

  /**
   * Deterministic regression for the reset itself: plants residue the way another suite sharing
   * this container could leave it (a data-bearing relation under a type the next schema does not
   * define), then asserts the reset-then-write path succeeds anyway. Without the reset, real
   * SpiceDB rejects the write outright ("cannot delete object definition ... as at least one
   * relationship exists under it"), which is exactly the order-dependent failure the cases above
   * must be immune to.
   */
  it("Reset makes schema write verdict independent of residual relationships", async (ctx) => {
    ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

    const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
    try {
      await resetSpiceDb(spiceDbClient);

      await spiceDbClient.writeSchema(
        WriteSchemaRequest.fromPartial({
          schema: `definition user {}
definition residuewidget {
    relation owner: user
}`,
        }),
      );
      await spiceDbClient.writeRelationships(
        WriteRelationshipsRequest.fromPartial({
          updates: [
            {
              operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
              relationship: {
                resource: { objectType: "residuewidget", objectId: "w1" },
                relation: "owner",
                subject: { object: { objectType: "user", objectId: "u1" } },
              },
            },
          ],
        }),
      );

      await resetSpiceDb(spiceDbClient);
      // Must not throw: with the residue cleared, dropping residuewidget is a pure schema transition.
      await spiceDbClient.writeSchema(
        WriteSchemaRequest.fromPartial({ schema: "definition user {}" }),
      );
    } finally {
      spiceDbClient.close();
    }
  });
});
