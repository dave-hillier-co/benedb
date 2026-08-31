import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";

import type { BatchCheckItem } from "./i-permission-checker";
import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/BatchCheckMeshTests.cs`, case for case.
 *
 * Exercises `IPermissionChecker.batchCheck` THROUGH the real grain mesh: every item's root
 * sub-problem fans out over the shared dispatcher against ONE pinned revision. Verifies (1)
 * per-item verdicts equal the per-item `IPermissionChecker.check` for each item (including a
 * caveated item and a not-member item), all index-aligned and sharing ONE evaluated token; and (2)
 * a batch sharing a common sub-problem performs materially fewer underlying dispatches than the
 * naive sum of independent checks, observed via the shared sub-problem's `CheckGrain` activation
 * memo hit/miss counters (every sub-problem is always a real grain call - there is no in-process
 * local-recurse shortcut to bypass).
 *
 * PORT NOTES.
 *  - `[Collection(MeshClusterCollection.Name)]` -> nothing (see `mesh-cluster-collection.ts`);
 *    `await using var cluster` -> an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - `Dictionary<string, object?> { ["region"] = "eu" }` -> a `Map`, because the ported caveat
 *    context type is `ReadonlyMap<string, unknown>` (see `json-element-surrogate.ts`). A plain
 *    object literal is NOT the same type and would be read as an empty context.
 *  - `batchConcurrency: 1` on the second test is load-bearing and is carried across verbatim: it
 *    serializes the fan-out so no two items race the same grain key before either populates its
 *    activation memo. Without it the exact memo equalities below are a flake, not a gate.
 *  - `MissingFields` is a collection, so the per-item cross-check compares with `toEqual`, not
 *    `toBe`.
 *  - `UpdateOperation.Touch` in the seeds is deliberate (the shared group edge is written by two
 *    separate transactions in the first test), and is kept.
 */

// Each document's `view` depends on the SAME shared sub-problem: group:eng#member@user:alice.
// `restricted` additionally gates membership on a caveat so we can exercise a per-item caveated
// verdict.
const SCHEMA_TEXT = `definition user {}

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

/** The C# `SeedSharedGroupFixture`. */
async function seedSharedGroupFixture(cluster: MeshTestCluster, docCount: number): Promise<void> {
  const updates: RelationshipUpdate[] = [
    // The shared sub-problem every document depends on.
    {
      relationship: createRelationship(
        onr("group", "eng", "member"),
        onr("user", "alice", ELLIPSIS),
      ),
      operation: "touch",
    },
  ];

  for (let i = 0; i < docCount; i++) {
    updates.push({
      relationship: createRelationship(
        onr("document", `doc${i}`, "parent"),
        onr("group", "eng", ELLIPSIS),
      ),
      operation: "touch",
    });
  }

  await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

describe("BatchCheckMeshTests", () => {
  it("BatchCheck_per_item_equals_Check_with_caveated_and_not_member_items_and_one_token", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA_TEXT);
    try {
      await seedSharedGroupFixture(cluster, 3);

      // restricted edge gated on the caveat, so restricted_view collapses per item context.
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              onr("document", "doc0", "restricted"),
              onr("group", "eng", ELLIPSIS),
              { caveatName: "allow_region" },
            ),
            operation: "touch",
          },
        ]),
      );

      const alice = onr("user", "alice", ELLIPSIS);
      const bob = onr("user", "bob", ELLIPSIS);
      const euContext: ReadonlyMap<string, unknown> = new Map<string, unknown>([["region", "eu"]]);

      const items: readonly BatchCheckItem[] = [
        // Member: alice via group on doc1.
        {
          resourceType: "document",
          resourceId: "doc1",
          permission: "view",
          subject: alice,
          caveatContext: undefined,
        },
        // Not a member: bob is in no group.
        {
          resourceType: "document",
          resourceId: "doc1",
          permission: "view",
          subject: bob,
          caveatContext: undefined,
        },
        // Caveated member: alice via the restricted edge, NO context supplied -> Caveated.
        {
          resourceType: "document",
          resourceId: "doc0",
          permission: "restricted_view",
          subject: alice,
          caveatContext: undefined,
        },
        // Same restricted edge, WITH eu context -> Member (shared branch, per-item context collapse).
        {
          resourceType: "document",
          resourceId: "doc0",
          permission: "restricted_view",
          subject: alice,
          caveatContext: euContext,
        },
      ];

      const batch = await cluster.checker.batchCheck(items);

      // Index-aligned + per-item correctness.
      expect(batch.items.length).toBe(items.length);
      expect(batch.items[0]!.verdict).toBe("member");
      expect(batch.items[1]!.verdict).toBe("notMember");
      expect(batch.items[2]!.verdict).toBe("caveated");
      expect(batch.items[2]!.missingFields).toContain("region");
      expect(batch.items[3]!.verdict).toBe("member");

      // ONE shared evaluated token for the whole batch.
      expect(batch.evaluatedToken.length > 0).toBe(true);

      // Batch result equals the per-item Check for each item.
      for (let i = 0; i < items.length; i++) {
        const it_ = items[i]!;
        const single = await cluster.checker.check(
          it_.resourceType,
          it_.resourceId,
          it_.permission,
          it_.subject,
          it_.caveatContext,
        );
        expect(batch.items[i]!.verdict).toBe(single.verdict);
        expect(batch.items[i]!.missingFields).toEqual(single.missingFields);
      }
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("BatchCheck_sharing_a_common_subproblem_does_fewer_dispatches_than_naive_sum", async () => {
    const docCount = 20;

    // Serialize the fan-out (concurrency = 1) so the shared sub-problem's activation-memo behaviour
    // is deterministic: no two items race on the same grain key before either populates its memo.
    // Every sub-problem is always a real grain call now (there is no in-process local-recurse
    // shortcut), so the activation memo is the dedup layer being exercised here.
    const cluster = await MeshTestCluster.createMultiSilo(SCHEMA_TEXT, 1, { batchConcurrency: 1 });
    try {
      await seedSharedGroupFixture(cluster, docCount);
      const alice = onr("user", "alice", ELLIPSIS);

      // docCount distinct documents whose `view` arrow ALL depend on the SAME shared sub-problem
      // group:eng#member@user:alice.
      const items: readonly BatchCheckItem[] = Array.from({ length: docCount }, (_, i) => ({
        resourceType: "document",
        resourceId: `doc${i}`,
        permission: "view",
        subject: alice,
        caveatContext: undefined,
      }));

      cluster.resetMetrics();

      const batch = await cluster.checker.batchCheck(items);
      for (const item of batch.items) expect(item.verdict).toBe("member");

      const snapshot = cluster.metricsSnapshot();

      // The NAIVE sum: each of the docCount documents independently expands its `view` arrow, which
      // dispatches the shared group:eng#member@user:alice leaf once per document => docCount
      // underlying leaf dispatches, on top of each document's own distinct root sub-problem.
      const naiveSharedLeafDispatches = docCount;

      // Because all items share ONE pinned revision + schema hash, the common group leaf resolves to
      // the SAME CheckGrain activation: it is computed ONCE (a single memo miss) and served from that
      // activation's memo for the other docCount-1 documents (docCount-1 memo hits). That is
      // materially fewer underlying dispatches than the naive sum.
      expect(snapshot.memoHit).toBe(docCount - 1);
      expect(snapshot.memoHit > 0, `expected memo hits > 0, got ${snapshot.memoHit}`).toBe(true);

      // Distinct misses (= distinct sub-problems actually dispatched) is the docCount distinct
      // document roots plus the ONE shared leaf = docCount + 1, strictly fewer than the naive sum
      // which would dispatch the shared leaf docCount times.
      expect(
        snapshot.memoMiss < docCount + naiveSharedLeafDispatches,
        `expected memo misses (${snapshot.memoMiss}) materially below the naive dispatch sum`,
      ).toBe(true);
      expect(snapshot.memoMiss).toBe(docCount + 1);

      // Corroborating single-revision proof: every item shares ONE evaluated token.
      expect(batch.evaluatedToken.length > 0).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
