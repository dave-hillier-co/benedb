import { ELLIPSIS } from "@benedb/core/core-constants";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import type { RelationshipUpdateWire } from "@benedb/grains/relationships-dtos";
import {
  CheckPermissionRequest,
  CheckPermissionResponse_Permissionship,
  type Consistency,
} from "@benedb/protos/permissions";
import { describe, expect, it } from "vitest";

import { PermissionsGrpcService } from "./permissions-grpc-service";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/SchemaAtRevisionMeshTests.cs`.
 *
 * Proves that a permission check evaluates under the schema PERSISTED AT THE PINNED REVISION, not
 * the silo-local ambient `ISchemaProvider.current`. This is the multi-silo correctness property
 * behind the schema@revision dispatch: the schema bytes are folded into the datastore log on every
 * silo, so a `CheckGrain` resolves the schema its grain key names from the log rather than trusting
 * whichever `writeSchema` happened to land on its own silo. A single-process
 * {@link MeshTestCluster} cannot manufacture cross-silo divergence directly, but the SAME code path
 * is exercised by pinning an OLD revision whose persisted schema differs from the current one:
 * before this change the grain used the (current) ambient schema and returned the wrong verdict for
 * an at-exact historical read.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@benedb/grains` does not depend on `@benedb/api`. See `data-plane-grpc-service-tests.test.ts`.
 *  - The `FakeContext : ServerCallContext` class DISAPPEARS: the ported methods take a trailing
 *    optional `AbortSignal`, so every call passes nothing.
 *  - The case mixes the two vocabularies deliberately: the seed goes through the WIRE DTOs
 *    (`RelationshipUpdateWire` / `RelationshipWire` via `cluster.relationships.writeRelationships`)
 *    while the checks go through PROTO requests to the service. The positional C# record fields are
 *    named explicitly on the wire side so no argument can slide one position.
 *  - The write reply's token round-trips as `{ token: writeReply.writtenAtToken }` into
 *    `consistency.atExactSnapshot`.
 *  - The SEQUENCE is load-bearing: install view = viewer + editor, write the editor edge, capture
 *    the token, sanity-check HasPermission at that token, narrow to view = viewer, confirm
 *    NoPermission at head, THEN re-check at the old token and require HasPermission.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 */

const EmptySchema = "definition user {}";

// view is granted to BOTH viewer and editor.
const ViewerOrEditorSchema = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

// view is granted to viewer ONLY (an editor no longer has view).
const ViewerOnlySchema = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
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

function touchEditor(res: string, subj: string): RelationshipUpdateWire {
  return {
    operation: "touch",
    relationship: {
      resourceType: "document",
      resourceId: res,
      resourceRelation: "editor",
      subjectType: "user",
      subjectId: subj,
      subjectRelation: ELLIPSIS,
    },
  };
}

function checkView(res: string, subj: string, consistency: Consistency): CheckPermissionRequest {
  return CheckPermissionRequest.fromPartial({
    resource: { objectType: "document", objectId: res },
    permission: "view",
    subject: { object: { objectType: "user", objectId: subj } },
    consistency,
  });
}

describe("SchemaAtRevisionMeshTests", () => {
  it("a check at an exact old token uses the schema persisted at that revision", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      // 1. Install `view = viewer + editor` and make alice an EDITOR of readme. The write's token pins
      //    a revision at which the persisted schema is ViewerOrEditor AND the editor edge is visible.
      await cluster.writeSchema(ViewerOrEditorSchema);
      const writeReply = await cluster.relationships.writeRelationships({
        updates: [touchEditor("readme", "alice")],
      });
      const oldToken = { token: writeReply.writtenAtToken };

      // Sanity: at that revision alice (an editor) HAS view under ViewerOrEditor.
      const atOldBefore = await svc.checkPermission(
        checkView("readme", "alice", { atExactSnapshot: oldToken }),
      );
      expect(atOldBefore.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );

      // 2. Narrow the persisted schema to `view = viewer` only. This advances the head; the ambient
      //    current schema on the silo is now ViewerOnly.
      await cluster.writeSchema(ViewerOnlySchema);

      // At HEAD, alice (still only an editor) no longer has view - confirms the narrow took effect.
      const atHead = await svc.checkPermission(
        checkView("readme", "alice", { fullyConsistent: true }),
      );
      expect(atHead.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );

      // 3. THE PROPERTY: a check pinned to the OLD token must evaluate under the schema persisted at
      //    that revision (ViewerOrEditor), so alice - an editor there - still HAS view. Evaluating
      //    under the ambient current schema (ViewerOnly) would wrongly return NoPermission.
      const atOldAfter = await svc.checkPermission(
        checkView("readme", "alice", { atExactSnapshot: oldToken }),
      );
      expect(atOldAfter.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });
});
