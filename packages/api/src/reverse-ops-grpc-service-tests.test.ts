import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import { MeshTestCluster } from "@spacedb/grains/mesh-test-cluster";
import {
  ExpandPermissionTreeRequest,
  ExpandPermissionTreeRequest_ExpandMode,
  LookupResourcesRequest,
  LookupSubjectsRequest,
  PermissionTreeNode_SetOpNode_Operation,
  Permissionship_Kind,
} from "@spacedb/protos/permissions";
import { describe, expect, it } from "vitest";

import { PermissionsGrpcService } from "./permissions-grpc-service";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ReverseOpsGrpcServiceTests.cs`.
 *
 * Drives the gRPC {@link PermissionsGrpcService} IN-PROCESS (no listener, no socket): the service is
 * constructed directly with the in-process {@link MeshTestCluster}'s grain factory and the silo's
 * `IPermissionChecker`, then its reverse / tree RPCs are invoked and their proto responses asserted.
 * This verifies the proto <-> grain mapping end to end.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@spacedb/grains` does not depend on `@spacedb/api`. See the sibling
 *    `data-plane-grpc-service-tests.test.ts` for the full note.
 *  - The `FakeContext : ServerCallContext` class DISAPPEARS: the ported methods take a trailing
 *    optional `AbortSignal`, so every call passes nothing.
 *  - Seeding goes through the datastore with CORE types (`createRelationship` + `ObjectAndRelation`
 *    + `ELLIPSIS`), never the wire DTOs: the two vocabularies stay distinct.
 *  - `ToHashSet()` assertions are SET-shaped, so they compare with `Set` and never assume stream
 *    order.
 *  - `PermissionTreeNode.NodeOneofCase.SetOp`: ts-proto renders a oneof as optional SIBLING fields,
 *    so "the node is a SetOp" is `setOp !== undefined` plus the sibling `leaf` being undefined.
 *  - The four v0 read/reverse RPCs have no error mapping (spiceport#41). Nothing in this file feeds
 *    them a bad consistency token, so it neither confirms nor contradicts that concern, and no error
 *    mapping is added to the service on its account.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 */

const SchemaText = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

function onr(objectType: string, objectId: string, relation: string): ObjectAndRelation {
  return { objectType, objectId, relation };
}

async function seed(
  datastore: IDatastore,
  ...tuples: readonly (readonly [res: string, rel: string, subj: string])[]
): Promise<void> {
  const updates: RelationshipUpdate[] = tuples.map(([res, rel, subj]) => ({
    relationship: createRelationship(onr("document", res, rel), onr("user", subj, ELLIPSIS)),
    operation: "touch",
  }));
  await datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

function service(cluster: MeshTestCluster): PermissionsGrpcService {
  return new PermissionsGrpcService(
    cluster.services.checker,
    cluster.grainFactory,
    cluster.reverseOps,
    cluster.relationshipReads,
  );
}

describe("ReverseOpsGrpcServiceTests", () => {
  it("expandPermissionTree returns a union tree", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"], ["readme", "editor", "bob"]);

      const resp = await service(cluster).expandPermissionTree(
        ExpandPermissionTreeRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
          mode: ExpandPermissionTreeRequest_ExpandMode.EXPAND_MODE_SHALLOW,
        }),
      );

      expect(resp.treeRoot).toBeDefined();
      // `NodeOneofCase.SetOp`: the set-op sibling is present and the leaf sibling is not.
      expect(resp.treeRoot?.setOp).toBeDefined();
      expect(resp.treeRoot?.leaf).toBeUndefined();
      expect(resp.treeRoot?.setOp?.operation).toBe(
        PermissionTreeNode_SetOpNode_Operation.OPERATION_UNION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("lookupSubjects returns the holders", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"], ["readme", "editor", "bob"]);

      const resp = await service(cluster).lookupSubjects(
        LookupSubjectsRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
          subjectObjectType: "user",
        }),
      );

      const ids = new Set(resp.subjects.map((s) => s.subjectObjectId));
      expect(ids).toEqual(new Set(["alice", "bob"]));
      for (const s of resp.subjects) {
        expect(s.permissionship?.kind).toBe(Permissionship_Kind.KIND_HAS_PERMISSION);
      }
    } finally {
      await cluster.dispose();
    }
  });

  it("lookupResources returns the reachable resources", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "alice"],
        ["design", "editor", "alice"],
        ["secret", "viewer", "bob"],
      );

      const resp = await service(cluster).lookupResources(
        LookupResourcesRequest.fromPartial({
          resourceObjectType: "document",
          permission: "view",
          subject: { object: { objectType: "user", objectId: "alice" } },
        }),
      );

      const ids = new Set(resp.resources.map((r) => r.resourceObjectId));
      expect(ids).toEqual(new Set(["readme", "design"]));
    } finally {
      await cluster.dispose();
    }
  });
});
