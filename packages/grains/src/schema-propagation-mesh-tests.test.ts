import { describe, expect, it } from "vitest";

import { FULLY_CONSISTENT } from "@spacedb/core/consistency-requirement";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship } from "@spacedb/core/relationship";

import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/SchemaPropagationMeshTests.cs`.
 *
 * Proves the cross-silo schema-propagation fix: a `writeSchema` commit lands on exactly one silo's
 * `RelationshipsGrain` activation, which swaps only THAT silo's `ISchemaProvider` directly - every
 * other silo must instead learn about it over the watch hub's push/heartbeat channel
 * (`IDatastoreWatcher.schemaAdvanced` and the heartbeat's stored-schema-hash diff). A real
 * multi-process rig exposed this as a silent wrong-verdict divergence - silos other than the writer
 * kept serving the stale schema forever, with no error. The in-process
 * `MeshTestCluster.createMultiSilo` reproduces it faithfully because each silo gets its own wiring
 * (and hence its own `MutableSchemaProvider` instance), exactly like separate processes.
 *
 * PORT NOTES.
 *  - `AllSiloServices.Select(sp => sp.GetRequiredService<ISchemaProvider>().Current.SchemaHash)` ->
 *    `cluster.allSiloServices.map(s => s.schemaProvider.current.schemaHash)`. Reading the PER-SILO
 *    providers is the entire proof; `cluster.schemaProvider` alone reads only the primary and would
 *    prove nothing.
 *  - The convergence loop is a REAL wall-clock poll (`Date.now()` + a real `setTimeout` sleep)
 *    against a push/heartbeat channel. Vitest fake timers would freeze the hub's heartbeat and the
 *    test would deadlock, so they are deliberately not used.
 *  - `hashes.Distinct().Count() == 1` -> `new Set(hashes).size === 1`.
 *  - `cluster.WriteSchema(text)` -> `cluster.writeSchema(text)` (the ported signature takes the
 *    DSL text).
 *  - `Assert.True(cond, msg)` -> `expect(cond, msg).toBe(true)` (the message is `expect`'s second
 *    argument in vitest).
 *  - `await using` -> an explicit `try/finally`.
 */
const SEED_SCHEMA = `definition user {}

definition doc {
  relation viewer: user
}`;

const UPDATED_SCHEMA = `definition user {}

definition doc {
  relation viewer: user
  relation editor: user
}`;

const CONVERGENCE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 100;

function currentHashes(cluster: MeshTestCluster): (string | undefined)[] {
  return cluster.allSiloServices.map((services) => services.schemaProvider.current.schemaHash);
}

function subject(id: string): ObjectAndRelation {
  return { objectType: "user", objectId: id, relation: ELLIPSIS };
}

/** `Task.Delay(PollInterval)`: a REAL sleep, deliberately not a fake timer (see the port notes). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("SchemaPropagationMeshTests", () => {
  /**
   * Layer 2: every silo's live `ISchemaProvider` must converge on the new schema's hash after a
   * `writeSchema`, even though the RPC only ever touches ONE silo's activation directly. Before the
   * fix, silos that never hosted the `RelationshipsGrain` activation for this call kept serving the
   * seed hash forever (no error, no timeout - a silent wrong-verdict divergence).
   */
  it("WriteSchema_converges_every_silos_live_schema_provider", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(SEED_SCHEMA, 3);
    try {
      const seedHashes = currentHashes(cluster);
      // Every silo starts on the identical embedded seed.
      expect(new Set(seedHashes).size).toBe(1);
      const seedHash = seedHashes[0];

      await cluster.writeSchema(UPDATED_SCHEMA);

      const deadline = Date.now() + CONVERGENCE_TIMEOUT_MS;
      let hashes: (string | undefined)[];
      do {
        hashes = currentHashes(cluster);
        if (new Set(hashes).size === 1 && hashes[0] !== seedHash) break;
        await sleep(POLL_INTERVAL_MS);
      } while (Date.now() < deadline);

      expect(
        new Set(hashes).size === 1,
        `expected every silo to converge on one schema hash within ${CONVERGENCE_TIMEOUT_MS}ms; ` +
          `saw: ${hashes.join(", ")}`,
      ).toBe(true);
      expect(hashes[0]).not.toBe(seedHash);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  /**
   * Layer 1 regression: once every silo's `SchemaResolver` has resolved the (structural) hash a
   * dispatch grain key pins at least once, further checks must NOT keep paying a sequencer
   * `readSchemaAt` hop. Before the fix, the resolver cached fetched bytes only under their
   * STORED-bytes hash, never under the STRUCTURAL hash dispatch keys actually pin - so every single
   * dispatch missed the cache and paid the hop, growing ~1:1 with check volume (measured at ~400
   * checks/s -> 3556 calls in 5s). This asserts the fixed shape: after a warm-up window, further
   * checks add at most a small constant, never one-per-check.
   */
  it("ReadSchemaAt_stays_bounded_after_WriteSchema_and_warmup", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(SEED_SCHEMA, 3);
    try {
      await cluster.writeSchema(UPDATED_SCHEMA);

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

      const runChecks = async (count: number): Promise<void> => {
        for (let i = 0; i < count; i++) {
          const result = await cluster.checker.check(
            "doc",
            "d1",
            "viewer",
            subject("u1"),
            undefined,
            FULLY_CONSISTENT,
          );
          expect(result.verdict).toBe("member");
        }
      };

      // Warm-up: enough checks that every silo's SchemaResolver has had the chance to miss-once and
      // cache the new hash (a fresh keyspace after the schema change).
      await runChecks(10);
      const baseline = cluster.sequencerMetricsSnapshot().readSchemaAt;

      const additionalChecks = 60;
      await runChecks(additionalChecks);
      const grew = cluster.sequencerMetricsSnapshot().readSchemaAt - baseline;

      expect(
        grew <= 5,
        `expected readSchemaAt to stay bounded after warm-up (a per-hash-per-silo miss, not ` +
          `per-check), but it grew by ${grew} over ${additionalChecks} additional checks - the ` +
          `Layer-1 dual-hash-key regression.`,
      ).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
