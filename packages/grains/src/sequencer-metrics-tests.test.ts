import { describe, expect, it } from "vitest";

import { FULLY_CONSISTENT } from "@benedb/core/consistency-requirement";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship } from "@benedb/core/relationship";

import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/SequencerMetricsTests.cs`.
 *
 * Proves the Phase 0 sequencer observability seam end to end (`docs/scalability-program.md`):
 * `ISequencerMetrics` is wired into the production grain services (`addSpiceportGrainServices`),
 * the singleton `DatastoreGrain` records into it, and `MeshTestCluster.sequencerMetricsSnapshot`
 * sums it across silos exactly like the dispatch counters - the seam the bench harness reads.
 *
 * PORT NOTES.
 *  - `[Collection(MeshClusterCollection.Name)]` -> nothing: see `mesh-cluster-collection.ts` for
 *    why the ported harness needs no cross-file serialization.
 *  - `await using var cluster` -> an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - `Assert.True(cond, msg)` -> `expect(cond, msg).toBe(true)`: vitest takes the message as
 *    `expect`'s SECOND argument. Dropping it would lose the observed counter value, which is the
 *    only thing that makes a failure here diagnosable.
 *  - `ConsistencyRequirement.FullyConsistent` is the ENGINE consistency value `FULLY_CONSISTENT`
 *    (distinct from the wire `ConsistencyWire`).
 *  - The second case asserts `readSchemaAt === 0` EXACTLY, exactly as the C# `Assert.Equal(0, ...)`
 *    does. A seed-window resolver that misses even once fails it, and that is the point: the
 *    regression it gates was a per-dispatch singleton hop.
 */
const SCHEMA = `definition user {}

definition doc {
  relation viewer: user
}`;

function subject(id: string): ObjectAndRelation {
  return { objectType: "user", objectId: id, relation: ELLIPSIS };
}

describe("SequencerMetricsTests", () => {
  it("Write_and_fully_consistent_check_surface_in_the_sequencer_counters", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      // One write: exactly one declarative Commit through the sequencer.
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              { objectType: "doc", objectId: "d1", relation: "viewer" },
              subject("u1"),
            ),
            operation: "create",
          },
        ]),
      );

      // One fully-consistent check: the revision resolver must sample the real head (getHead), and
      // the engine's graph read hits a COLD GraphShardGrain (fresh cluster, first activation for
      // f/doc/d1), which always hydrates via the sequencer's readShard - the forced cold shard read.
      const result = await cluster.checker.check(
        "doc",
        "d1",
        "viewer",
        subject("u1"),
        undefined,
        FULLY_CONSISTENT,
      );
      expect(result.verdict).toBe("member");

      const m = cluster.sequencerMetricsSnapshot();

      expect(
        m.commit >= 1,
        `expected at least the test's own commit; saw commit = ${m.commit}`,
      ).toBe(true);
      expect(
        m.getHead >= 1,
        `expected the fully-consistent head sample; saw getHead = ${m.getHead}`,
      ).toBe(true);
      expect(
        m.readShard >= 1,
        `expected the cold shard hydration; saw readShard = ${m.readShard}`,
      ).toBe(true);

      // The Commit-only observables ride along: a single-relationship commit resolves exactly one
      // candidate key (its resource's forward key), and a real commit's serialized turn takes
      // measurable time, so the duration totals are nonzero and internally consistent.
      expect(
        m.commitCandidates1 >= 1,
        `expected the single-update commit in the at-most-one-candidate bucket; saw ${m.commitCandidates1}`,
      ).toBe(true);
      expect(m.commitMicrosTotal > 0, "expected a nonzero total commit duration").toBe(true);
      expect(
        m.commitMicrosTotal >= m.commitMicrosMax,
        `total (${m.commitMicrosTotal}) must cover the max (${m.commitMicrosMax})`,
      ).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  /**
   * The seed window (schema embedded at silo startup, no `writeSchema` persisted) must resolve
   * schemas from the seeded per-silo cache, never by calling the sequencer: before the fix the
   * resolver missed on the seed hash on EVERY dispatch, fetched nothing from `readSchemaAt`, and
   * fell back without caching - a per-dispatch singleton hop the measurement harness observed at
   * ~16k calls/second.
   */
  it("Seed_window_checks_never_call_ReadSchemaAt", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              { objectType: "doc", objectId: "d2", relation: "viewer" },
              subject("u2"),
            ),
            operation: "create",
          },
        ]),
      );

      for (let i = 0; i < 10; i++) {
        const result = await cluster.checker.check(
          "doc",
          "d2",
          "viewer",
          subject("u2"),
          undefined,
          FULLY_CONSISTENT,
        );
        expect(result.verdict).toBe("member");
      }

      const m = cluster.sequencerMetricsSnapshot();
      expect(m.readSchemaAt).toBe(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
