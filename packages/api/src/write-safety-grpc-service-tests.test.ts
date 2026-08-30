import { status } from "@grpc/grpc-js";
import { MeshTestCluster } from "@spacedb/grains/mesh-test-cluster";
import {
  DeleteRelationshipsRequest,
  Precondition,
  Precondition_Operation,
  ReadRelationshipsRequest,
  ReadSchemaRequest,
  RelationshipFilter,
  RelationshipUpdate,
  RelationshipUpdate_Operation,
  WriteRelationshipsRequest,
  WriteSchemaRequest,
} from "@spacedb/protos/permissions";
import { describe, expect, it } from "vitest";

import { PermissionsGrpcService } from "./permissions-grpc-service";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/WriteSafetyGrpcServiceTests.cs`.
 *
 * Write-safety verification driven THROUGH the gRPC {@link PermissionsGrpcService} in-process (no
 * listener, no socket): WriteRelationships / DeleteRelationships preconditions (MUST_MATCH /
 * MUST_NOT_MATCH, checked atomically inside the write tx - satisfied commits, violated rejects with
 * FAILED_PRECONDITION and nothing changes) and WriteSchema change validation (removing a still-
 * referenced definition / relation / allowed subject type is rejected; removing an unreferenced one
 * is allowed).
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: the ledger row targets `packages/grains/src/...`, but `@spacedb/grains` does
 *    NOT depend on `@spacedb/api` (the dependency runs api -> grains), so a suite driving
 *    `PermissionsGrpcService` cannot live in grains without inverting the graph. It lands here, the
 *    same deviation `data-plane-grpc-service-tests.test.ts` already took.
 *  - The `FakeContext : ServerCallContext` class DISAPPEARS: the ported methods take a trailing
 *    optional `AbortSignal` (the C# reads nothing from the context but its `CancellationToken`), so
 *    every call passes nothing.
 *  - `[Collection(MeshClusterCollection.Name)]` maps to nothing; vitest isolates per file.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - THE STATUS CODES ARE THE ASSERTION. A violated precondition is FAILED_PRECONDITION, never
 *    INVALID_ARGUMENT; and every rejected schema change is ALSO FAILED_PRECONDITION, with the
 *    offending name CONTAINED in the details string (`Assert.Contains` is a substring check).
 *    Note the contrast this file preserves against `DataPlaneGrpcServiceTests`, which requires
 *    INVALID_ARGUMENT for a schema that fails to COMPILE: a schema that compiles but would orphan
 *    live data is a different failure class with a different, wire-visible code.
 *  - `Assert.Equal(1UL, resp.DeletedCount)` - uint64 renders as a STRING in the generated ts-proto
 *    tree, so the expectation is `"1"`, never `1` or `1n`.
 *  - `Touch(...)`'s `subjRel = ""` default is preserved literally: the empty string means "no
 *    subject relation" on the proto surface and must NOT be turned into ELLIPSIS here - the service
 *    is what does that defaulting. The `group#member` case passes `"member"` explicitly.
 *  - The C# sets NO consistency on the reads that assert atomicity; neither does the port.
 */

const Schema = `definition user {}
definition group {
    relation member: user
}
definition document {
    relation viewer: user | group#member
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

function touch(
  resType: string,
  res: string,
  rel: string,
  subjType: string,
  subj: string,
  subjRel = "",
): RelationshipUpdate {
  return RelationshipUpdate.fromPartial({
    operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
    relationship: {
      resource: { objectType: resType, objectId: res },
      resourceRelation: rel,
      subject: {
        object: { objectType: subjType, objectId: subj },
        optionalRelation: subjRel,
      },
    },
  });
}

async function seed(
  svc: PermissionsGrpcService,
  ...updates: readonly RelationshipUpdate[]
): Promise<void> {
  await svc.writeRelationships(WriteRelationshipsRequest.fromPartial({ updates: [...updates] }));
}

function docFilter(rel: string): RelationshipFilter {
  return RelationshipFilter.fromPartial({
    resourceType: "document",
    optionalResourceRelation: rel,
  });
}

describe("WriteSafetyGrpcServiceTests", () => {
  // ---- A) Preconditions ----

  it("mustNotMatch satisfied commits the write", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      // Precondition: editor#bob must NOT already exist (it does not) -> write proceeds.
      const req = WriteRelationshipsRequest.fromPartial({
        updates: [touch("document", "readme", "viewer", "user", "alice")],
        optionalPreconditions: [
          Precondition.fromPartial({
            operation: Precondition_Operation.OPERATION_MUST_NOT_MATCH,
            filter: docFilter("editor"),
          }),
        ],
      });

      const resp = await svc.writeRelationships(req);
      expect(resp.writtenAt?.token ?? "").not.toBe("");

      const read = await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({ filter: docFilter("viewer") }),
      );
      expect(read.relationships).toHaveLength(1);
    } finally {
      await cluster.dispose();
    }
  });

  it("mustNotMatch violated rejects and nothing changes", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await seed(svc, touch("document", "readme", "editor", "user", "bob"));

      // Precondition: editor#* must NOT exist (it does) -> reject; the new viewer must NOT be written.
      const req = WriteRelationshipsRequest.fromPartial({
        updates: [touch("document", "readme", "viewer", "user", "alice")],
        optionalPreconditions: [
          Precondition.fromPartial({
            operation: Precondition_Operation.OPERATION_MUST_NOT_MATCH,
            filter: docFilter("editor"),
          }),
        ],
      });

      const error = await svc.writeRelationships(req).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(status.FAILED_PRECONDITION);

      // Nothing committed: the viewer relationship is absent, the editor one is untouched.
      const viewers = await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({ filter: docFilter("viewer") }),
      );
      expect(viewers.relationships).toHaveLength(0);
      const editors = await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({ filter: docFilter("editor") }),
      );
      expect(editors.relationships).toHaveLength(1);
    } finally {
      await cluster.dispose();
    }
  });

  it("mustMatch satisfied commits the write", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await seed(svc, touch("document", "readme", "editor", "user", "bob"));

      const req = WriteRelationshipsRequest.fromPartial({
        updates: [touch("document", "readme", "viewer", "user", "alice")],
        optionalPreconditions: [
          Precondition.fromPartial({
            operation: Precondition_Operation.OPERATION_MUST_MATCH,
            filter: docFilter("editor"),
          }),
        ],
      });

      const resp = await svc.writeRelationships(req);
      expect(resp.writtenAt?.token ?? "").not.toBe("");
    } finally {
      await cluster.dispose();
    }
  });

  it("mustMatch violated rejects and nothing changes", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      // Precondition: editor must MATCH (none exists) -> reject.
      const req = WriteRelationshipsRequest.fromPartial({
        updates: [touch("document", "readme", "viewer", "user", "alice")],
        optionalPreconditions: [
          Precondition.fromPartial({
            operation: Precondition_Operation.OPERATION_MUST_MATCH,
            filter: docFilter("editor"),
          }),
        ],
      });

      const error = await svc.writeRelationships(req).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(status.FAILED_PRECONDITION);

      const viewers = await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({ filter: docFilter("viewer") }),
      );
      expect(viewers.relationships).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("delete precondition violated rejects and deletes nothing", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await seed(svc, touch("document", "readme", "viewer", "user", "alice"));

      // Delete all viewers, but only if NO editor exists; seed an editor so the precondition fails.
      await seed(svc, touch("document", "readme", "editor", "user", "bob"));

      const del = DeleteRelationshipsRequest.fromPartial({
        filter: docFilter("viewer"),
        optionalPreconditions: [
          Precondition.fromPartial({
            operation: Precondition_Operation.OPERATION_MUST_NOT_MATCH,
            filter: docFilter("editor"),
          }),
        ],
      });

      const error = await svc.deleteRelationships(del).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(status.FAILED_PRECONDITION);

      // Nothing deleted.
      const viewers = await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({ filter: docFilter("viewer") }),
      );
      expect(viewers.relationships).toHaveLength(1);
    } finally {
      await cluster.dispose();
    }
  });

  it("delete precondition satisfied commits the delete", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await seed(svc, touch("document", "readme", "viewer", "user", "alice"));

      const del = DeleteRelationshipsRequest.fromPartial({
        filter: docFilter("viewer"),
        optionalPreconditions: [
          Precondition.fromPartial({
            operation: Precondition_Operation.OPERATION_MUST_NOT_MATCH,
            filter: docFilter("editor"),
          }),
        ],
      });

      const resp = await svc.deleteRelationships(del);
      expect(resp.deletedCount).toBe("1");
    } finally {
      await cluster.dispose();
    }
  });

  // ---- B) Schema change validation ----

  it("removing a still-referenced definition is rejected", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await seed(svc, touch("document", "readme", "viewer", "user", "alice"));

      // Drop the `document` definition while a relationship is written under it.
      const withoutDocument = `definition user {}
definition group {
    relation member: user
}`;

      const error = await svc
        .writeSchema(WriteSchemaRequest.fromPartial({ schema: withoutDocument }))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(status.FAILED_PRECONDITION);
      expect((error as RpcError).details).toContain("document");

      // Live schema unchanged: the document relationship is still readable.
      const read = await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({ filter: docFilter("viewer") }),
      );
      expect(read.relationships).toHaveLength(1);
    } finally {
      await cluster.dispose();
    }
  });

  it("removing a still-referenced relation is rejected", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await seed(svc, touch("document", "readme", "viewer", "user", "alice"));

      // Drop the `viewer` relation while it is written.
      const withoutViewer = `definition user {}
definition group {
    relation member: user
}
definition document {
    relation editor: user
    permission view = editor
}`;

      const error = await svc
        .writeSchema(WriteSchemaRequest.fromPartial({ schema: withoutViewer }))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(status.FAILED_PRECONDITION);
      expect((error as RpcError).details).toContain("viewer");
    } finally {
      await cluster.dispose();
    }
  });

  it("removing a relation referenced as a subject is rejected", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      // document:readme#viewer @ group:eng#member -> group#member is referenced as a subject.
      await seed(svc, touch("document", "readme", "viewer", "group", "eng", "member"));

      // Drop group#member: it is referenced on the subject side of the viewer relationship.
      const withoutGroupMember = `definition user {}
definition group {}
definition document {
    relation viewer: user | group#member
    relation editor: user
    permission view = viewer + editor
}`;

      const error = await svc
        .writeSchema(WriteSchemaRequest.fromPartial({ schema: withoutGroupMember }))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(status.FAILED_PRECONDITION);
      expect((error as RpcError).details).toContain("member");
    } finally {
      await cluster.dispose();
    }
  });

  it("removing a still-referenced allowed subject type is rejected", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await seed(svc, touch("document", "readme", "viewer", "user", "alice"));

      // Keep `viewer` but remove `user` from its allowed subject types.
      const viewerWithoutUser = `definition user {}
definition group {
    relation member: user
}
definition document {
    relation viewer: group#member
    relation editor: user
    permission view = viewer + editor
}`;

      const error = await svc
        .writeSchema(WriteSchemaRequest.fromPartial({ schema: viewerWithoutUser }))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(status.FAILED_PRECONDITION);
    } finally {
      await cluster.dispose();
    }
  });

  it("removing an unreferenced definition is allowed", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      // Only document relationships exist; `group` has none, so dropping it is safe.
      await seed(svc, touch("document", "readme", "viewer", "user", "alice"));

      const withoutGroup = `definition user {}
definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

      const resp = await svc.writeSchema(WriteSchemaRequest.fromPartial({ schema: withoutGroup }));
      expect(resp.writtenAt?.token ?? "").not.toBe("");

      const read = await svc.readSchema(ReadSchemaRequest.fromPartial({}));
      expect(read.schemaText).toBe(withoutGroup);
    } finally {
      await cluster.dispose();
    }
  });

  it("removing an unreferenced relation is allowed", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      // Only viewer is written; editor has no relationships, so dropping editor is safe.
      await seed(svc, touch("document", "readme", "viewer", "user", "alice"));

      const withoutEditor = `definition user {}
definition group {
    relation member: user
}
definition document {
    relation viewer: user | group#member
    permission view = viewer
}`;

      const resp = await svc.writeSchema(WriteSchemaRequest.fromPartial({ schema: withoutEditor }));
      expect(resp.writtenAt?.token ?? "").not.toBe("");
    } finally {
      await cluster.dispose();
    }
  });

  it("a permission-only change is always allowed", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await seed(svc, touch("document", "readme", "viewer", "user", "alice"));

      // Change only the permission expression; relations are untouched.
      const permChanged = `definition user {}
definition group {
    relation member: user
}
definition document {
    relation viewer: user | group#member
    relation editor: user
    permission view = editor + viewer
}`;

      const resp = await svc.writeSchema(WriteSchemaRequest.fromPartial({ schema: permChanged }));
      expect(resp.writtenAt?.token ?? "").not.toBe("");
    } finally {
      await cluster.dispose();
    }
  });
});
