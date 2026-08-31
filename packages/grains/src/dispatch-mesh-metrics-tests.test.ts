import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import type { IDatastore } from "@benedb/datastore/i-datastore";

import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/DispatchMeshMetricsTests.cs`.
 *
 * Anti-hollow proof that the mesh is REAL now that there is no custom placement director, no
 * local-recurse shortcut and no caller-side branch cache: a deep chain check must fan out into many
 * distinct `CheckGrain` activations, and on a multi-silo cluster those activations must genuinely
 * spread across more than one silo's process (the runtime's placement + grain directory, not a
 * hand-rolled consistent-hash ring, is doing the routing).
 *
 * PORT NOTES.
 *  - `CreateMultiSiloAsync(schema, siloCount: 3)` -> `MeshTestCluster.createMultiSilo(schema, 3)`;
 *    `await using` -> an explicit `try/finally`.
 *  - `useRandomPlacement: true` is carried across as the real `MeshTestClusterOptions` field it is.
 *    See that harness' port decision 7 for why it is inert on Thresh (whose default placement is
 *    already a spread-making pick rather than Orleans 10's load-statistics heuristic) - it is kept
 *    because the C# comment records WHY the second case must not assert spread under a placement
 *    strategy that makes no spread promise.
 *  - The per-silo read is `cluster.allSiloServices.map(...)`, NOT `cluster.metricsSnapshot()`:
 *    the latter SUMS across silos and would destroy the very spread claim this case exists to make.
 *  - The depths are kept exactly (20 for the fan-out count, 30 for the spread case): `dispatch`
 *    counts filter crossings at the incoming-call filter, not memo bookkeeping, so a shallower
 *    chain would make the assertion vacuous.
 */
const CHAIN_SCHEMA = `definition user {}

definition group {
    relation direct_member: user
    relation parent: group
    permission member = direct_member + parent->member
}`;

function subject(id: string): ObjectAndRelation {
  return { objectType: "user", objectId: id, relation: ELLIPSIS };
}

/** Seeds a chain g0 -> g1 -> ... -> g(n-1), with user u a direct member of g(n-1). */
async function seedChain(datastore: IDatastore, depth: number): Promise<void> {
  const updates: RelationshipUpdate[] = [];
  for (let i = 0; i < depth - 1; i++) {
    updates.push({
      relationship: createRelationship(
        { objectType: "group", objectId: `g${i}`, relation: "parent" },
        { objectType: "group", objectId: `g${i + 1}`, relation: ELLIPSIS },
      ),
      operation: "create",
    });
  }
  updates.push({
    relationship: createRelationship(
      { objectType: "group", objectId: `g${depth - 1}`, relation: "direct_member" },
      subject("u"),
    ),
    operation: "create",
  });
  await datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

describe("DispatchMeshMetricsTests", () => {
  it("Deep_chain_check_fans_out_into_many_distinct_grain_activations", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(CHAIN_SCHEMA, 3);
    try {
      await seedChain(cluster.datastore, 20);

      cluster.resetMetrics();
      const result = await cluster.checker.check("group", "g0", "member", subject("u"), undefined);
      expect(result.verdict).toBe("member");

      const m = cluster.metricsSnapshot();

      // Every sub-problem is a real grain call (no in-process local-recurse shortcut left), so a
      // 20-deep chain must cross the check-dispatch incoming call filter's boundary at least that
      // many times - one real dispatch hop per distinct CheckGrain key, counted at the filter
      // itself rather than inferred from the grain's own (memo-dependent) hit/miss bookkeeping.
      expect(
        m.dispatch >= 20,
        `Expected the chain to fan into at least 20 real dispatch hops; saw ${m.dispatch}.`,
      ).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Multi_silo_cluster_genuinely_spreads_activations_across_more_than_one_silo", async () => {
    // Random placement (an explicit opt-in for THIS assertion): Orleans 10's default placement is
    // ResourceOptimizedPlacement, a load-statistics heuristic whose local-silo preference margin may
    // legitimately keep a whole chain on the calling silo - it makes no spread guarantee, so a
    // spread ASSERTION under it would be asserting behavior the runtime does not promise. Random
    // placement does guarantee spread (statistically overwhelming for 30 keys over 3 silos), keeping
    // this test's real claim - recursion crosses genuine process boundaries with no custom router -
    // sound and deterministic.
    const cluster = await MeshTestCluster.createMultiSilo(CHAIN_SCHEMA, 3, {
      useRandomPlacement: true,
    });
    try {
      await seedChain(cluster.datastore, 30);

      cluster.resetMetrics();
      const result = await cluster.checker.check("group", "g0", "member", subject("u"), undefined);
      expect(result.verdict).toBe("member");

      // With shard co-location OFF (the default), the graph grains' placement director is a uniform
      // random pick, so the runtime's placement + the grain directory decide where each of the
      // chain's many distinct grain keys activates. Anti-hollow: on a real 3-silo cluster that
      // routing must genuinely land activations on more than one silo's own process, not collapse
      // the whole chain onto a single silo.
      const perSiloDispatches = cluster.allSiloServices.map(
        (services) => services.dispatchMetrics.snapshot().dispatch,
      );

      expect(
        perSiloDispatches.filter((count) => count > 0).length > 1,
        `Expected activations to spread across more than one silo; per-silo dispatch hops were ` +
          `[${perSiloDispatches.join(", ")}].`,
      ).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
