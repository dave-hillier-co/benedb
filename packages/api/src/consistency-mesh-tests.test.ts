import { status } from "@grpc/grpc-js";
import { decodeRevision, zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import { MeshTestCluster } from "@spacedb/grains/mesh-test-cluster";
import {
  CheckPermissionRequest,
  CheckPermissionResponse_Permissionship,
  RelationshipUpdate,
  RelationshipUpdate_Operation,
  WriteRelationshipsRequest,
  type Consistency,
  type ZedToken,
} from "@spacedb/protos/permissions";
import { describe, expect, it } from "vitest";

import { PermissionsGrpcService } from "./permissions-grpc-service";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ConsistencyMeshTests.cs`.
 *
 * End-to-end consistency verification through the in-process gRPC {@link PermissionsGrpcService}
 * over the real grain mesh (no listener, no socket): the four `Consistency` modes,
 * read-your-writes, exact-snapshot isolation from later writes, the cache-not-stale-under-exact
 * seam, mismatched-datastore handling, and response-token chaining. All assertions are
 * deterministic (no timing flake): they rely on the head-pinning / exact-key invariants, not on
 * wall-clock windows.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@spacedb/grains` does not depend on `@spacedb/api`. See `data-plane-grpc-service-tests.test.ts`.
 *  - The `FakeContext : ServerCallContext` class DISAPPEARS: the ported methods take a trailing
 *    optional `AbortSignal`, so every call passes nothing.
 *  - `ZedTokens.FromRevision` / `ZedTokens.DecodeRevision` become the free functions
 *    `zedTokenFromRevision` / `decodeRevision`; the parser comes from `datastore.getRevisionParser()`.
 *  - `secondRev.CompareTo(firstRev) >= 0` is a REVISION comparison, not a numeric one: it goes
 *    through the revision's own `compareTo` (a `TimestampRevision`'s nanos are `bigint`, and
 *    comparing via `Number()` would quantise them).
 *  - The two foreign-datastore-token cases are ASYMMETRIC BY DESIGN and stay that way:
 *    at_exact_snapshot with a foreign id is INVALID_ARGUMENT, while at_least_as_fresh with the same
 *    token silently falls back to full consistency and succeeds.
 *  - The pre-write token in the exact-snapshot case is harvested from a FULLY CONSISTENT check's
 *    `checkedAt` - never `headRevision()` - because the point is that the RESPONSE token is usable
 *    as a snapshot pin.
 *  - The cross-silo case keeps its 12 iterations (they shake out the catch-up race) and gets an
 *    explicit generous timeout. It still boots no host and binds no port.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 */

const ViewerSchema = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

function service(cluster: MeshTestCluster): PermissionsGrpcService {
  return new PermissionsGrpcService(
    cluster.services.checker,
    cluster.grainFactory,
    cluster.reverseOps,
    cluster.relationshipReads,
  );
}

function touchViewer(res: string, subj: string): RelationshipUpdate {
  return RelationshipUpdate.fromPartial({
    operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
    relationship: {
      resource: { objectType: "document", objectId: res },
      resourceRelation: "viewer",
      subject: { object: { objectType: "user", objectId: subj } },
    },
  });
}

function check(
  res: string,
  subj: string,
  consistency?: Consistency | undefined,
): CheckPermissionRequest {
  return CheckPermissionRequest.fromPartial({
    resource: { objectType: "document", objectId: res },
    permission: "view",
    subject: { object: { objectType: "user", objectId: subj } },
    ...(consistency !== undefined ? { consistency } : {}),
  });
}

async function writeViewer(
  svc: PermissionsGrpcService,
  res: string,
  subj: string,
): Promise<ZedToken> {
  const resp = await svc.writeRelationships(
    WriteRelationshipsRequest.fromPartial({ updates: [touchViewer(res, subj)] }),
  );
  const written = resp.writtenAt;
  if (written === undefined) throw new Error("writeRelationships returned no writtenAt token");
  return written;
}

describe("ConsistencyMeshTests", () => {
  // ---- 1. ZedToken round-trip through the datastore parser. ----

  it("writtenAt token decodes to a snapshotable revision", async () => {
    const cluster = await MeshTestCluster.create(ViewerSchema);
    try {
      const svc = service(cluster);

      const written = await writeViewer(svc, "readme", "alice");

      const parser = await cluster.datastore.getRevisionParser();
      const decoded = decodeRevision({ token: written.token }, parser);

      expect(decoded.status).toBe("valid");
      // The decoded revision is snapshot-able (does not throw / is valid).
      expect(await cluster.datastore.checkRevision(decoded.revision)).toBe(true);
      cluster.datastore.snapshotReader(decoded.revision);
    } finally {
      await cluster.dispose();
    }
  });

  // ---- 2. Read-your-writes via at_least_as_fresh. ----

  it("atLeastAsFresh with the write token sees the write", async () => {
    const cluster = await MeshTestCluster.create(ViewerSchema);
    try {
      const svc = service(cluster);

      const written = await writeViewer(svc, "readme", "alice");

      const resp = await svc.checkPermission(check("readme", "alice", { atLeastAsFresh: written }));

      expect(resp.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  // ---- 3. FullyConsistent immediately after a write is always fresh. ----

  it("fullyConsistent after a write is always fresh", async () => {
    const cluster = await MeshTestCluster.create(ViewerSchema);
    try {
      const svc = service(cluster);

      await writeViewer(svc, "readme", "alice");

      const resp = await svc.checkPermission(check("readme", "alice", { fullyConsistent: true }));

      expect(resp.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  // ---- 4. AtExactSnapshot ignores writes after the captured snapshot. ----

  it("atExactSnapshot reads exactly the captured snapshot", async () => {
    const cluster = await MeshTestCluster.create(ViewerSchema);
    try {
      const svc = service(cluster);

      // Capture a pre-write snapshot token (a fully consistent check returns the head it evaluated).
      const t0 = (await svc.checkPermission(check("readme", "alice", { fullyConsistent: true })))
        .checkedAt;
      expect(t0).toBeDefined();

      // Now grant the permission (advances head past t0).
      const t1 = await writeViewer(svc, "readme", "alice");

      // Exact snapshot at t0 must NOT see the later write.
      const atT0 = await svc.checkPermission(check("readme", "alice", { atExactSnapshot: t0 }));
      expect(atT0.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );

      // Exact snapshot at the post-write token sees it.
      const atT1 = await svc.checkPermission(check("readme", "alice", { atExactSnapshot: t1 }));
      expect(atT1.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  // ---- 5. Cache-not-stale-under-exact: the section 4 correctness seam. ----

  it("fullyConsistent is not shadowed by a stale optimized bucket entry", async () => {
    const cluster = await MeshTestCluster.create(ViewerSchema);
    try {
      const svc = service(cluster);

      // A minimize-latency check (the default) populates the optimized-bucket branch cache for this
      // sub-problem with NO_PERMISSION (alice is not yet a viewer).
      const before = await svc.checkPermission(check("readme", "alice"));
      expect(before.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );

      // Grant the permission. Head advances but (within the 5s window) stays in the SAME quantized
      // bucket, so a minimize-latency check could read the stale NO_PERMISSION entry.
      await writeViewer(svc, "readme", "alice");

      // FullyConsistent is keyed by the EXACT head revision, so it cannot read the stale optimized
      // bucket entry: it MUST return HAS_PERMISSION.
      const fresh = await svc.checkPermission(check("readme", "alice", { fullyConsistent: true }));
      expect(fresh.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  // ---- 6. Mismatched datastore id. ----

  it("atExactSnapshot with a foreign datastore token is InvalidArgument", async () => {
    const cluster = await MeshTestCluster.create(ViewerSchema);
    try {
      const svc = service(cluster);

      const head = await cluster.datastore.headRevision();
      const foreign = zedTokenFromRevision(
        head.revision,
        head.schemaHash,
        "some-other-datastore-id",
      );

      const error = await svc
        .checkPermission(check("readme", "alice", { atExactSnapshot: { token: foreign.token } }))
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

  it("atLeastAsFresh with a foreign datastore token falls back to full consistency", async () => {
    const cluster = await MeshTestCluster.create(ViewerSchema);
    try {
      const svc = service(cluster);

      await writeViewer(svc, "readme", "alice");

      const head = await cluster.datastore.headRevision();
      const foreign = zedTokenFromRevision(
        head.revision,
        head.schemaHash,
        "some-other-datastore-id",
      );

      // No error: it falls back to full consistency (head) and returns the fresh result.
      const resp = await svc.checkPermission(
        check("readme", "alice", { atLeastAsFresh: { token: foreign.token } }),
      );
      expect(resp.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  // ---- 7. Response-token chaining never goes backwards. ----

  it("the checkedAt token chains into atLeastAsFresh without going backwards", async () => {
    const cluster = await MeshTestCluster.create(ViewerSchema);
    try {
      const svc = service(cluster);

      await writeViewer(svc, "readme", "alice");

      // First (minimize-latency) check returns a checked_at token.
      const first = await svc.checkPermission(check("readme", "alice"));
      expect(first.checkedAt?.token ?? "").not.toBe("");

      // Feed it back as at_least_as_fresh: resolves without error and is at least as fresh.
      const second = await svc.checkPermission(
        check("readme", "alice", { atLeastAsFresh: first.checkedAt }),
      );
      expect(second.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );

      const parser = await cluster.datastore.getRevisionParser();
      const firstRev = decodeRevision({ token: first.checkedAt?.token ?? "" }, parser).revision;
      const secondRev = decodeRevision({ token: second.checkedAt?.token ?? "" }, parser).revision;
      // A REVISION comparison, through the revision's own compareTo.
      expect(secondRev.compareTo(firstRev)).toBeGreaterThanOrEqual(0);
    } finally {
      await cluster.dispose();
    }
  });

  // ---- 8. The closed-timestamp gate across silos. ----

  /**
   * On a two-silo mesh, a write is observed by a fully consistent and an at-least-as-fresh(token)
   * check IMMEDIATELY - the shard grain serving the sub-problem's graph reads blocks until its
   * watermark covers the pinned revision (the per-shard closed-timestamp gate) rather than serving a
   * stale snapshot. Repeated to shake out any catch-up race.
   */
  it("exact reads see writes immediately across silos", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(ViewerSchema, 2);
    try {
      const svc = service(cluster);

      for (let i = 0; i < 12; i += 1) {
        const doc = `doc${i}`;
        const token = await writeViewer(svc, doc, "alice");

        const fully = await svc.checkPermission(check(doc, "alice", { fullyConsistent: true }));
        expect(fully.permissionship).toBe(
          CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
        );

        const fresh = await svc.checkPermission(check(doc, "alice", { atLeastAsFresh: token }));
        expect(fresh.permissionship).toBe(
          CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
        );
      }
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
