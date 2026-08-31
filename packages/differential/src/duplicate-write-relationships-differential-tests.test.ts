import { status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { AuthzedPermissionsV1Service } from "@benedb/api/authzed-permissions-v1-service";
import { RpcError } from "@benedb/api/rpc-error";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import type { Relationship, RelationshipUpdate } from "@benedb/protos/authzed/api/v1/core";
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
 * Ported from Spiceport
 * `tests/Spiceport.Differential.Tests/DuplicateWriteRelationshipsDifferentialTests.cs`.
 *
 * Directed differential regression for spiceport issue #34: a request with two updates for the same
 * relationship (varying only operation kind and/or caveat) must be rejected as `INVALID_ARGUMENT`,
 * not silently tolerated. Runs the SAME requests against a real `authzed/spicedb` container and
 * against BeneDB's in-process `AuthzedPermissionsV1Service` and asserts both reject with the SAME
 * gRPC status.
 *
 * Real SpiceDB (authzed/spicedb v1.49.2), empirically observed by driving `WriteRelationships`
 * directly over gRPC:
 *  - two TOUCH updates for the identical tuple -> `InvalidArgument`: "found more than one update
 *    with relationship `document:readme#editor@user:alice` in this request; a relationship can only
 *    be specified in an update once per overall WriteRelationships request".
 *  - a TOUCH and a DELETE for the same tuple -> the same `InvalidArgument` message (operation kind
 *    is NOT part of the dedup key).
 *  - a CREATE and a TOUCH for the same tuple -> the same `InvalidArgument` message.
 *  - two updates for the same (resource, relation, subject) differing only in caveat name/context
 *    -> the same `InvalidArgument` message (the dedup key excludes the caveat, matching SpiceDB's
 *    `V1StringRelationshipWithoutCaveatOrExpiration`).
 *
 * By contrast, `ImportBulkRelationships` (a distinct RPC, distinct client-streaming semantics) does
 * NOT apply this same-request dedup check: two identical rows in one streamed batch instead surface
 * as a CREATE-conflict `AlreadyExists` ("could not CREATE relationship ..., as it already
 * existed"), because SpiceDB's bulk-import path applies each row with create semantics rather than
 * pre-validating the whole batch for duplicates. BeneDB's `importBulkRelationships` matches that
 * CREATE-style bulk import (issue #35); `import-bulk-relationships-differential-tests.test.ts` is
 * the differential gate for it.
 *
 * PORT DECISIONS.
 *
 *  1. THE REQUEST FACTORY IS KEPT. The C# passes each case a `Func<WriteRelationshipsRequest>`, not
 *     a request, because the same request is submitted twice (once per system): the factory
 *     guarantees neither side can observe a mutation the other made, and it is free.
 *  2. `Struct` AUTO-UNWRAPS under ts-proto, so the caveat context is a PLAIN JS object on
 *     `context`. The C#'s `Struct`/`Value.ForNumber` API has no counterpart and hand-building
 *     `{ fields: { value: { numberValue: 1 } } }` would be wrong.
 *  3. ERROR SHAPES DIFFER BY SIDE: real SpiceDB yields a grpc-js `ServiceError` (numeric `.code`,
 *     `.details`); BeneDB throws `RpcError`. Each is asserted against its own shape.
 *  4. `[Collection(SpiceDbCollection.Name)]` -> `useSpiceDbContainer` + `describe.sequential`, with
 *     `resetSpiceDb` then `WriteSchema` before each case. Clusters dispose in an explicit `finally`
 *     (TypeScript has no `await using`).
 */

const fixture = useSpiceDbContainer();

const Schema = `definition user {}

caveat somecaveat(value int) {
    value > 0
}

definition document {
    relation viewer: user | user with somecaveat
    relation editor: user
}`;

function rel(relation: string, caveatName?: string, caveatValue?: number): Relationship {
  return {
    resource: { objectType: "document", objectId: "readme" },
    relation,
    subject: {
      object: { objectType: "user", objectId: "alice" },
      optionalRelation: "",
    },
    optionalCaveat:
      caveatName === undefined
        ? undefined
        : {
            caveatName,
            // `Struct` auto-unwraps under ts-proto: a plain object, not Struct/Value (decision 2).
            context: caveatValue === undefined ? undefined : { value: caveatValue },
          },
    optionalExpiresAt: undefined,
  };
}

function upd(
  operation: RelationshipUpdate_Operation,
  relationship: Relationship,
): RelationshipUpdate {
  return { operation, relationship };
}

function req(...updates: readonly RelationshipUpdate[]): WriteRelationshipsRequest {
  return WriteRelationshipsRequest.fromPartial({ updates: [...updates] });
}

const DuplicateCases: readonly (readonly [
  caseName: string,
  buildRequest: () => WriteRelationshipsRequest,
])[] = [
  [
    "two_touch_same_tuple",
    () =>
      req(
        upd(RelationshipUpdate_Operation.OPERATION_TOUCH, rel("editor")),
        upd(RelationshipUpdate_Operation.OPERATION_TOUCH, rel("editor")),
      ),
  ],
  [
    "touch_and_delete_same_tuple",
    () =>
      req(
        upd(RelationshipUpdate_Operation.OPERATION_TOUCH, rel("editor")),
        upd(RelationshipUpdate_Operation.OPERATION_DELETE, rel("editor")),
      ),
  ],
  [
    "create_then_touch_same_tuple",
    () =>
      req(
        upd(RelationshipUpdate_Operation.OPERATION_CREATE, rel("editor")),
        upd(RelationshipUpdate_Operation.OPERATION_TOUCH, rel("editor")),
      ),
  ],
  [
    "differ_only_by_caveat_context",
    () =>
      req(
        upd(RelationshipUpdate_Operation.OPERATION_TOUCH, rel("viewer", "somecaveat", 1)),
        upd(RelationshipUpdate_Operation.OPERATION_TOUCH, rel("viewer", "somecaveat", 2)),
      ),
  ],
];

/** `Assert.ThrowsAsync<RpcException>` - returns the caught reason so the caller can assert on it. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe.sequential("DuplicateWriteRelationshipsDifferentialTests", () => {
  for (const [caseName, buildRequest] of DuplicateCases) {
    it(`WriteRelationships duplicate update rejected by both systems [${caseName}]`, async (ctx) => {
      ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

      const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
      try {
        // Residual relationships from sibling suites in the shared container would make this schema
        // write fail on data-orphan grounds, order-dependently - see spice-db-reset.ts.
        await resetSpiceDb(spiceDbClient);
        await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema: Schema }));

        const spiceDbError = await caught(spiceDbClient.writeRelationships(buildRequest()));
        expect(spiceDbError).toBeInstanceOf(Error);
        expect((spiceDbError as { code?: unknown }).code).toBe(status.INVALID_ARGUMENT);
        expect(String((spiceDbError as { details?: unknown }).details)).toContain(
          "more than one update with relationship",
        );
      } finally {
        spiceDbClient.close();
      }

      const cluster = await MeshTestCluster.create(Schema);
      try {
        const permissionsService = new AuthzedPermissionsV1Service(
          cluster.checker,
          cluster.grainFactory,
          cluster.reverseOps,
          cluster.relationshipReads,
          cluster.schemaProvider,
        );

        const benedbError = await caught(permissionsService.writeRelationships(buildRequest()));
        expect(benedbError).toBeInstanceOf(RpcError);
        expect((benedbError as RpcError).code).toBe(status.INVALID_ARGUMENT);
        expect((benedbError as RpcError).details).toContain(
          "more than one update with relationship",
        );
      } finally {
        await cluster.dispose();
      }
    });
  }
});
