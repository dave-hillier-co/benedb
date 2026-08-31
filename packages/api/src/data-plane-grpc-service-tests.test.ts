import { status } from "@grpc/grpc-js";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import {
  CheckPermissionRequest,
  CheckPermissionResponse_Permissionship,
  DeleteRelationshipsRequest,
  ReadRelationshipsRequest,
  ReadSchemaRequest,
  RelationshipUpdate,
  RelationshipUpdate_Operation,
  WriteRelationshipsRequest,
  WriteSchemaRequest,
} from "@benedb/protos/permissions";
import { describe, expect, it } from "vitest";

import { PermissionsGrpcService } from "./permissions-grpc-service";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/DataPlaneGrpcServiceTests.cs`.
 *
 * Drives the full data-plane lifecycle THROUGH the gRPC {@link PermissionsGrpcService} IN-PROCESS
 * (no listener, no socket): the service is constructed directly with the in-process
 * {@link MeshTestCluster}'s grain factory and the silo's `IPermissionChecker`, then its proto RPCs
 * (writeSchema / writeRelationships / checkPermission / readRelationships / deleteRelationships)
 * are invoked and their proto responses asserted. This verifies the proto <-> grain <-> datastore
 * mapping end to end across the real grain mesh.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: the ledger row targets `packages/grains/src/...`, but `@benedb/grains` does
 *    NOT depend on `@benedb/api` (the dependency runs api -> grains), so a suite driving
 *    `PermissionsGrpcService` cannot live in grains without inverting the graph. It lands here and
 *    the ledger row is amended - the same deviation `mesh-test-cluster.ts` already took.
 *  - The `FakeContext : ServerCallContext` class DISAPPEARS: the ported methods take a trailing
 *    optional `AbortSignal` (the C# reads nothing from the context but its `CancellationToken`), so
 *    every call passes nothing.
 *  - `[Collection(MeshClusterCollection.Name)]` maps to nothing; vitest isolates per file.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - `Assert.Equal(1UL, delResp.DeletedCount)` - uint64 renders as a STRING in the generated
 *    ts-proto tree, so the expectation is `"1"`, never `1` or `1n`.
 *  - `Assert.ThrowsAsync<RpcException>` + `ex.StatusCode` becomes an {@link RpcError} instance
 *    check plus `error.code`.
 *  - THE CONSISTENCY COMMENTS ARE LOAD-BEARING: the reads after a write/delete deliberately ask for
 *    full consistency, because a minimize-latency read resolves to the window-stable optimized
 *    revision. Never "simplify" those to a default consistency.
 */

const EmptySchema = "definition user {}";

const ViewerOnlySchema = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer
}`;

const ViewerOrEditorSchema = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

function service(cluster: MeshTestCluster): PermissionsGrpcService {
  return new PermissionsGrpcService(
    cluster.services.checker,
    cluster.grainFactory,
    cluster.reverseOps,
    cluster.relationshipReads,
  );
}

function touch(res: string, rel: string, subj: string): RelationshipUpdate {
  return RelationshipUpdate.fromPartial({
    operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
    relationship: {
      resource: { objectType: "document", objectId: res },
      resourceRelation: rel,
      subject: { object: { objectType: "user", objectId: subj } },
    },
  });
}

function checkOf(res: string, perm: string, subj: string): CheckPermissionRequest {
  return CheckPermissionRequest.fromPartial({
    resource: { objectType: "document", objectId: res },
    permission: perm,
    subject: { object: { objectType: "user", objectId: subj } },
  });
}

describe("DataPlaneGrpcServiceTests", () => {
  it("full lifecycle: writeSchema, write, check, delete, check, read via the grpc service", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      // 1. WriteSchema over the gRPC surface.
      const schemaResp = await svc.writeSchema(
        WriteSchemaRequest.fromPartial({ schema: ViewerOrEditorSchema }),
      );
      expect(schemaResp.writtenAt?.token ?? "").not.toBe("");

      // ReadSchema round-trips the source text.
      const readSchema = await svc.readSchema(ReadSchemaRequest.fromPartial({}));
      expect(readSchema.schemaText).toBe(ViewerOrEditorSchema);

      // 2. WriteRelationships over the gRPC surface.
      const writeResp = await svc.writeRelationships(
        WriteRelationshipsRequest.fromPartial({ updates: [touch("readme", "viewer", "alice")] }),
      );
      expect(writeResp.writtenAt?.token ?? "").not.toBe("");

      // 3. CheckPermission -> HasPermission. Use full consistency to observe the relationship just
      // written above: a default (minimize-latency) check resolves to the optimized revision, a real
      // but window-stable cached head (matching SpiceDB's CachedOptimizedRevisions); the earlier
      // ReadSchema opened that window before this write committed, so a minimize-latency check could
      // still read the pre-write head. Read-your-writes is expressed via full consistency (or the
      // write's returned token).
      const checkReq = checkOf("readme", "view", "alice");
      checkReq.consistency = { fullyConsistent: true };
      const checkAfterWrite = await svc.checkPermission(checkReq);
      expect(checkAfterWrite.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );

      // ReadRelationships returns what was written (full consistency: read-your-writes within the
      // current quantization window, where the minimize-latency optimized revision may lag head).
      const readResp = await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({
          filter: { resourceType: "document", optionalResourceRelation: "viewer" },
          consistency: { fullyConsistent: true },
        }),
      );
      expect(readResp.relationships).toHaveLength(1);
      const r = readResp.relationships[0];
      expect(r).toBeDefined();
      expect(r?.resource?.objectId).toBe("readme");
      expect(r?.resourceRelation).toBe("viewer");
      expect(r?.subject?.object?.objectId).toBe("alice");

      // 4. DeleteRelationships over the gRPC surface.
      const delResp = await svc.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          filter: { resourceType: "document", optionalResourceRelation: "viewer" },
        }),
      );
      expect(delResp.deletedCount).toBe("1");

      // ReadRelationships now empty. Ask for full consistency so the read reflects the just-committed
      // delete: a default (minimize-latency) read resolves to the optimized revision - a real but
      // window-stable cached head (matching SpiceDB's CachedOptimizedRevisions) - which need not yet
      // include a mutation that landed within the current quantization window.
      const readAfterDelete = await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({
          filter: { resourceType: "document", optionalResourceRelation: "viewer" },
          consistency: { fullyConsistent: true },
        }),
      );
      expect(readAfterDelete.relationships).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("a schema change flips the grpc check outcome across the dispatch cache", async () => {
    // Schema A (view = viewer). Bob is editor (not viewer) -> NoPermission, cached under hash(A).
    const cluster = await MeshTestCluster.create(ViewerOnlySchema);
    try {
      const svc = service(cluster);

      await svc.writeRelationships(
        WriteRelationshipsRequest.fromPartial({ updates: [touch("readme", "editor", "bob")] }),
      );

      const before = await svc.checkPermission(checkOf("readme", "view", "bob"));
      expect(before.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );

      // Schema B (view = viewer + editor): swap the live schema -> new schema hash.
      await svc.writeSchema(WriteSchemaRequest.fromPartial({ schema: ViewerOrEditorSchema }));

      // Same check must now be HasPermission: every new cache/grain key is prefixed with hash(B),
      // so the stale hash(A) NoPermission entry can never be served.
      const after = await svc.checkPermission(checkOf("readme", "view", "bob"));
      expect(after.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("writeSchema with an invalid schema maps to InvalidArgument over grpc", async () => {
    const cluster = await MeshTestCluster.create(ViewerOrEditorSchema);
    try {
      const svc = service(cluster);

      const error = await svc
        .writeSchema(WriteSchemaRequest.fromPartial({ schema: "definition document { relation" }))
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(status.INVALID_ARGUMENT);
    } finally {
      await cluster.dispose();
    }
  });
});
