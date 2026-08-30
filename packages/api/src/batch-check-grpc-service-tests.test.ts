import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { MeshTestCluster } from "@spacedb/grains/mesh-test-cluster";
import {
  BatchCheckPermissionRequest,
  BatchCheckPermissionRequestItem,
  CheckPermissionResponse_Permissionship,
} from "@spacedb/protos/permissions";
import { describe, expect, it } from "vitest";

import { PermissionsGrpcService } from "./permissions-grpc-service";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/BatchCheckGrpcServiceTests.cs`.
 *
 * Drives `batchCheckPermission` THROUGH the gRPC {@link PermissionsGrpcService} IN-PROCESS (no
 * listener, no socket): the service is constructed with the in-process cluster's grain factory and
 * `IPermissionChecker`, then the proto RPC is invoked and its response asserted. Verifies pairs are
 * index-aligned to the request, per-item permissionship / missing-fields map correctly (including a
 * caveated item whose per-item context collapses over a shared cached branch), and that there is ONE
 * batch-level `checked_at` token.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@spacedb/grains` does not depend on `@spacedb/api`. See `data-plane-grpc-service-tests.test.ts`.
 *  - The `FakeBatchContext : ServerCallContext` class DISAPPEARS: the ported method takes a trailing
 *    optional `AbortSignal`, so the call passes nothing.
 *  - `Assert.Equal(request.Items[i], resp.Pairs[i].Request)` is protobuf STRUCTURAL equality, so it
 *    is `toEqual` on the decoded message object, never an identity check.
 *  - `BatchCheckPermissionPair.ResponseOneofCase.Item`: ts-proto renders the oneof as an optional
 *    sibling field, so the assertion is that `item` is present.
 *  - A `Struct` context (`Value.ForString("eu")`) arrives auto-unwrapped by ts-proto as the plain
 *    object `{ region: "eu" }`; the grains DTOs take a `ReadonlyMap` and the SERVICE does that
 *    conversion, so the test only builds the plain object.
 *  - Items 2 and 3 (same tuple, one without context and one with the eu context) must stay in ONE
 *    request: the case pins that a per-item context collapses over a shared cached branch.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 */

const SchemaText = `definition user {}

caveat allow_region(region string) {
    region == "eu"
}

definition group {
    relation member: user
}

definition document {
    relation parent: group
    relation restricted: group with allow_region
    permission view = parent->member
    permission restricted_view = restricted->member
}`;

function onr(objectType: string, objectId: string, relation: string): ObjectAndRelation {
  return { objectType, objectId, relation };
}

function service(cluster: MeshTestCluster): PermissionsGrpcService {
  return new PermissionsGrpcService(
    cluster.services.checker,
    cluster.grainFactory,
    cluster.reverseOps,
    cluster.relationshipReads,
  );
}

function item(
  doc: string,
  permission: string,
  subject: string,
  context?: Record<string, unknown> | undefined,
): BatchCheckPermissionRequestItem {
  return BatchCheckPermissionRequestItem.fromPartial({
    resource: { objectType: "document", objectId: doc },
    permission,
    subject: { object: { objectType: "user", objectId: subject } },
    ...(context !== undefined ? { context } : {}),
  });
}

describe("BatchCheckGrpcServiceTests", () => {
  it("batchCheckPermission returns index-aligned pairs with one checkedAt", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const updates: RelationshipUpdate[] = [
        {
          relationship: createRelationship(
            onr("group", "eng", "member"),
            onr("user", "alice", ELLIPSIS),
          ),
          operation: "touch",
        },
        {
          relationship: createRelationship(
            onr("document", "doc1", "parent"),
            onr("group", "eng", ELLIPSIS),
          ),
          operation: "touch",
        },
        {
          relationship: createRelationship(
            onr("document", "doc0", "restricted"),
            onr("group", "eng", ELLIPSIS),
            { caveatName: "allow_region" },
          ),
          operation: "touch",
        },
      ];
      await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(updates));

      const euContext = { region: "eu" };

      const request = BatchCheckPermissionRequest.fromPartial({});
      request.items.push(item("doc1", "view", "alice")); // 0: HasPermission
      request.items.push(item("doc1", "view", "bob")); // 1: NoPermission
      request.items.push(item("doc0", "restricted_view", "alice")); // 2: Conditional (no context)
      request.items.push(item("doc0", "restricted_view", "alice", euContext)); // 3: HasPermission

      const resp = await svc.batchCheckPermission(request);

      // Pairs index-aligned to request order, request echoed back.
      expect(resp.pairs).toHaveLength(request.items.length);
      for (let i = 0; i < request.items.length; i += 1) {
        expect(resp.pairs[i]?.request).toEqual(request.items[i]);
        // `ResponseOneofCase.Item`: `response` is a SINGLE-member oneof in this proto (`item`; there
        // is no `error` sibling), so ts-proto renders it as one optional field and the case
        // assertion is exactly "item is present".
        expect(resp.pairs[i]?.item).toBeDefined();
      }

      expect(resp.pairs[0]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
      expect(resp.pairs[1]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );
      expect(resp.pairs[2]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION,
      );
      expect(resp.pairs[2]?.item?.partialCaveatMissingFields).toContain("region");
      expect(resp.pairs[3]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );

      // ONE batch-level checked_at token.
      expect(resp.checkedAt).toBeDefined();
      expect(resp.checkedAt?.token ?? "").not.toBe("");
    } finally {
      await cluster.dispose();
    }
  });
});
