import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship } from "@spacedb/core/relationship";
import { describe, expect, it } from "vitest";

import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/SeededFixtureMeshTests.cs`.
 *
 * Replays the API's seeded document/viewer fixture THROUGH the grain mesh: with
 * `document:readme#viewer @ user:alice` seeded and the `view = viewer + editor` permission,
 * `user:alice` must resolve to a member and an unseeded `user:bob` to a non-member. This is the
 * exact behaviour the gRPC front door serves via the root dispatcher.
 *
 * It is also the CHEAPEST possible end-to-end proof that the harness, the DI wiring, the write path
 * and the check mesh work together, which is why it is pointed at a brand-new `MeshTestCluster`
 * FIRST: the schema is inline rather than from the corpus, and the seeding goes through
 * `datastore.readWriteTx`, so nothing corpus-shaped stands between a failure and its cause.
 *
 * PORT NOTES.
 *  - `[Collection(MeshClusterCollection.Name)]` maps to nothing; see `mesh-cluster-collection.ts`
 *    for why vitest's per-file isolation already provides what the xunit collection was asked for.
 *  - `await using var cluster` -> an explicit `try/finally`. A leaked cluster is the orphaned-host
 *    hazard in miniature, so the teardown is not optional.
 *  - `Membership.Member` / `Membership.NotMember` are string-literal members in this port.
 */

const SCHEMA_TEXT = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

function user(id: string): ObjectAndRelation {
  return { objectType: "user", objectId: id, relation: ELLIPSIS };
}

describe("SeededFixtureMeshTests", () => {
  it("DocumentViewer_Fixture_Through_Mesh_Yields_Alice_Member_Bob_NotMember", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA_TEXT);
    try {
      const rel = createRelationship(
        { objectType: "document", objectId: "readme", relation: "viewer" },
        user("alice"),
      );
      await cluster.datastore.readWriteTx(async (tx) => {
        await tx.writeRelationships([{ relationship: rel, operation: "touch" }]);
      });

      const alice = await cluster.checker.check(
        "document",
        "readme",
        "view",
        user("alice"),
        undefined,
      );

      const bob = await cluster.checker.check("document", "readme", "view", user("bob"), undefined);

      expect(alice.verdict).toBe("member");
      expect(bob.verdict).toBe("notMember");
    } finally {
      await cluster.dispose();
    }
  });
});
