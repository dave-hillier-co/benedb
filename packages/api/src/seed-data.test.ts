import type { IDatastore } from "@spacedb/datastore/i-datastore";
import { MeshTestCluster } from "@spacedb/grains/mesh-test-cluster";

import { describe, expect, it } from "vitest";

import { SEED_SCHEMA_TEXT, seedAsync } from "./seed-data";

/**
 * PORT-LOCAL suite, deliberately separate from `seed-data-tests.test.ts`, which transliterates
 * `SeedDataTests.cs` and must not grow cases the C# does not have.
 *
 * WHAT IT GATES. The API host seeds on start (`apiHostSteps`' seed step), and once clustering is
 * configurable there can be TWO API hosts in one cluster - both running that step. `seedAsync`'s
 * emptiness check used to sit OUTSIDE the transaction: a check-then-write with no precondition, so
 * two silos starting together both saw an empty store, both wrote, and the fixture relationship was
 * re-stamped at a second revision. That is exactly the MVCC churn the check exists to prevent, and
 * nothing below this layer could see it, because the check reads through a snapshot and the write
 * goes through the cluster-singleton datastore grain.
 *
 * The mechanism that makes it exactly-once already existed: `GrainBackedDatastore.readWriteTx` is
 * an optimistic CAS on `expectedHead` against that singleton, whose append is "the sole
 * serialization point". The loser of the CAS reloads and re-runs the WHOLE lambda against a base
 * that now contains the relationship - so moving the check INSIDE the lambda is all it takes.
 *
 * NO HOST IS BOOTED. `MeshTestCluster` is Thresh's `TestCluster`, which is the sanctioned way to
 * run several silos in ONE process; every silo delegates to the one singleton datastore grain, so
 * two `IDatastore` facades here race exactly the way two API hosts' facades would.
 */

/** The C# `CountRelationships`: drains an unfiltered snapshot query at head. */
async function countRelationships(datastore: IDatastore): Promise<number> {
  const head = await datastore.headRevision();
  const reader = datastore.snapshotReader(head.revision);
  let count = 0;
  for await (const _ of reader.queryRelationships({})) {
    count++;
  }
  return count;
}

describe("seedAsync across a multi-silo cluster", () => {
  it("writes exactly once when two silos seed concurrently", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(SEED_SCHEMA_TEXT, 2);
    try {
      const results = await Promise.all([
        seedAsync(cluster.datastoreForSilo(0)),
        seedAsync(cluster.datastoreForSilo(1)),
      ]);

      expect(results.filter((seeded) => seeded)).toHaveLength(1);
      expect(results.filter((seeded) => !seeded)).toHaveLength(1);
      expect(await countRelationships(cluster.datastore)).toBe(1);
    } finally {
      await cluster.dispose();
    }
  });

  it("does not advance head for the silo that loses the race", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(SEED_SCHEMA_TEXT, 2);
    try {
      await Promise.all([
        seedAsync(cluster.datastoreForSilo(0)),
        seedAsync(cluster.datastoreForSilo(1)),
      ]);
      const headAfterSeeding = (await cluster.datastore.headRevision()).revision;

      // A losing lambda that staged nothing would still commit an EMPTY, head-advancing revision;
      // aborting the commit is what keeps the second seed from churning MVCC history.
      const seededAgain = await seedAsync(cluster.datastoreForSilo(1));

      expect(seededAgain).toBe(false);
      const headNow = (await cluster.datastore.headRevision()).revision;
      expect(headAfterSeeding.equals(headNow)).toBe(true);
    } finally {
      await cluster.dispose();
    }
  });
});
