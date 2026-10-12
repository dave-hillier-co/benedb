import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import { createRelationship } from "@benedb/core/relationship";
import type { TimestampRevision } from "@benedb/core/timestamp-revision";

import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { graphShardKeyForResource } from "./graph-shard-key";
import { IGraphShardGrain } from "./i-graph-shard-grain";
import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/GraphShardCatchUpTests.cs`.
 *
 * A shard's catch-up is single-flight: readers that arrive together at a revision the shard has
 * not yet folded share one pull from the sequencer's log rather than each pulling it.
 */
const SCHEMA = `definition user {}

definition doc {
  relation viewer: user
}`;

async function write(cluster: MeshTestCluster, subject: string): Promise<void> {
  await cluster.datastore.readWriteTx((tx) =>
    tx.writeRelationships([
      {
        relationship: createRelationship(
          { objectType: "doc", objectId: "d1", relation: "viewer" },
          { objectType: "user", objectId: subject, relation: ELLIPSIS },
        ),
        operation: "touch",
      },
    ]),
  );
}

async function headNanos(cluster: MeshTestCluster): Promise<bigint> {
  const head = await cluster.datastore.headRevision();
  return (head.revision as TimestampRevision).timestampNanosSinceEpoch;
}

describe("GraphShardCatchUpTests", () => {
  it("Concurrent_readers_share_one_catch_up", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      const shard = cluster.grainFactory.getGrain(
        IGraphShardGrain,
        graphShardGrainKeyBuild(graphShardKeyForResource("doc", "d1")),
      );

      await write(cluster, "u0");
      await shard.rowsAt(await headNanos(cluster), undefined);

      for (let i = 1; i <= 5; i++) await write(cluster, `u${i}`);
      const head = await headNanos(cluster);

      const before = cluster.sequencerMetricsSnapshot().readFrom;
      const replies = await Promise.all(
        Array.from({ length: 20 }, () => shard.rowsAt(head, undefined)),
      );
      const pulls = cluster.sequencerMetricsSnapshot().readFrom - before;

      for (const reply of replies) expect(reply.rows).toHaveLength(6);
      expect(pulls).toBe(1);
    } finally {
      await cluster.dispose();
    }
  });
});
