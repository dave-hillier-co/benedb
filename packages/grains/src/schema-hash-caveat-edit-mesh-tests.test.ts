import { describe, expect, it } from "vitest";

import { atExactSnapshot } from "@benedb/core/consistency-requirement";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { Membership } from "@benedb/engine/membership";
import { createRelationship } from "@benedb/core/relationship";

import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/SchemaHashCaveatEditMeshTests.cs`.
 *
 * The consequence of the structural `SchemaHash`, not just its value. A `writeSchema` token
 * carries the structural hash, a check at that token pins it, and the per-silo `SchemaResolver`
 * serves whatever snapshot it already cached under that hash. A schema edit the hash cannot see
 * therefore keeps evaluating under the OLD compiled schema. A caveat-body edit is exactly such an
 * edit unless the hash covers the caveat's expression and parameter types.
 *
 * PORT NOTES.
 *  - `await using` -> an explicit `try/finally` around `cluster.dispose()`.
 *  - `new ZedToken(token)` -> `{ token }`; the caveat context dictionary becomes a `Map`.
 */
function schemaWithThreshold(threshold: number): string {
  return `caveat over(x int) {
  x > ${threshold}
}

definition user {}

definition document {
  relation viewer: user with over
  permission view = viewer
}`;
}

async function checkView(cluster: MeshTestCluster, token: string): Promise<Membership> {
  const result = await cluster.checker.check(
    "document",
    "doc1",
    "view",
    { objectType: "user", objectId: "alice", relation: ELLIPSIS },
    new Map<string, unknown>([["x", 50]]),
    atExactSnapshot({ token }),
  );
  return result.verdict;
}

describe("SchemaHashCaveatEditMeshTests", () => {
  it("Check_at_the_token_of_a_caveat_body_edit_evaluates_the_new_body", async () => {
    const cluster = await MeshTestCluster.create(schemaWithThreshold(1));
    try {
      await cluster.writeSchema(schemaWithThreshold(1));
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              { objectType: "document", objectId: "doc1", relation: "viewer" },
              { objectType: "user", objectId: "alice", relation: ELLIPSIS },
              { caveatName: "over", context: new Map<string, unknown>() },
            ),
            operation: "create",
          },
        ]),
      );
      const before = await cluster.writeSchema(schemaWithThreshold(1));

      // Warm the resolver under the original caveat body (x > 1).
      expect(await checkView(cluster, before.writtenAtToken)).toBe("member");

      const after = await cluster.writeSchema(schemaWithThreshold(100));

      expect(await checkView(cluster, after.writtenAtToken)).toBe("notMember");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
