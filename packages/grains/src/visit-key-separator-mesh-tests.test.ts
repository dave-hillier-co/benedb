import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import { createRelationship } from "@benedb/core/relationship";

import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/VisitKeySeparatorMeshTests.cs`.
 *
 * The injective `VisitKey` rendering through the path where its absence surfaced: an object id
 * containing U+001F rides the exact visited set from the dispatcher into `CheckGrain` as a
 * canonical `VisitKey` string in the ambient request context, and the grain must parse it back
 * rather than fail the Check.
 *
 * PORT NOTES.
 *  - `await using` -> an explicit `try/finally` around `cluster.dispose()`.
 *  - `CreateMultiSiloAsync(Schema, siloCount: 2)` -> `MeshTestCluster.createMultiSilo(SCHEMA, 2)`.
 */
const SCHEMA = `definition user {}

definition group {
    relation member: user | group#member
}`;

const SEPARATOR_ID = `a${String.fromCharCode(0x1f)}b`;

describe("VisitKeySeparatorMeshTests", () => {
  it("Check_on_an_id_containing_the_unit_separator_resolves_across_the_mesh", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(SCHEMA, 2);
    try {
      // group:a<US>b#member -> group:c#member -> user:x. The second hop is a grain call whose
      // ambient visited set carries the separator-bearing root key.
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              { objectType: "group", objectId: SEPARATOR_ID, relation: "member" },
              { objectType: "group", objectId: "c", relation: "member" },
            ),
            operation: "create",
          },
          {
            relationship: createRelationship(
              { objectType: "group", objectId: "c", relation: "member" },
              { objectType: "user", objectId: "x", relation: ELLIPSIS },
            ),
            operation: "create",
          },
        ]),
      );

      const result = await cluster.checker.check(
        "group",
        SEPARATOR_ID,
        "member",
        { objectType: "user", objectId: "x", relation: ELLIPSIS },
        undefined,
      );

      expect(result.verdict).toBe("member");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
