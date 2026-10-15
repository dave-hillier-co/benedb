import { describe, expect, it } from "vitest";

import { FaultHarnessDivergenceError, runFaultHarness } from "./fault-harness";

/**
 * The deterministic fault-injection harness (Spiceport docs/transaction-system.md §2 step 3, stage
 * 2): seeded workloads against the real sequencer and shard mesh, with storage failures,
 * deactivations, GC rounds and silo kills injected at seeded points, every commit outcome and every
 * read checked against `ReferenceDatastore`.
 *
 * Port decision: the seeds draw from `createSeededRandom` (mulberry32), not .NET's `System.Random`,
 * so a seed names a different workload here than in Spiceport. The gates are the same: a seed
 * reproduces its own run, and every seed agrees with the reference.
 */
describe("FaultInjectionHarnessTests", () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const clusterSeeds = [1, 2, 3, 4];

  /**
   * The harness's own gate: storage that acknowledges shard-projection writes but drops them is a
   * lost-write bug the oracle must report, naming the seed so the run can be replayed.
   */
  it("A_lost_shard_write_is_reported_as_a_divergence", async () => {
    const error = await runFaultHarness({ seed: 1, steps: 30, loseShardWrites: true }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(FaultHarnessDivergenceError);
    expect((error as Error).message).toContain("seed 1");
  }, 60_000);

  it.each(seeds)(
    "Seeded_runs_agree_with_the_reference_under_injected_faults (seed %i)",
    async (seed) => {
      const run = await runFaultHarness({ seed, steps: 80 });

      // Every run must actually inject faults and recover from them, or it proves nothing.
      expect(run.sequencerFaultsFired, "no sequencer write failure fired").toBeGreaterThan(0);
      expect(run.shardFaultsFired, "no shard-projection write failure fired").toBeGreaterThan(0);
      expect(run.trace.some((line) => line.startsWith("deactivate"))).toBe(true);
    },
    60_000,
  );

  /**
   * Four silos over stores every silo shares: a seeded schedule also hard-kills non-primary silos
   * (whichever activations they held, the sequencer's included) and runs GC rounds under a short
   * retention window, so recovery runs from storage alone and reads compare only at revisions the
   * floor still covers.
   */
  it.each(clusterSeeds)(
    "Seeded_runs_agree_with_the_reference_across_silo_kills_and_gc_rounds (seed %i)",
    async (seed) => {
      const run = await runFaultHarness({
        seed,
        steps: 60,
        silos: 4,
        killSilos: true,
        gcWindow: { ms: 200 },
      });

      expect(run.silosKilled, "no silo was killed").toBeGreaterThan(0);
      expect(run.sequencerKills, "no kill took the sequencer's activation down").toBeGreaterThan(0);
      expect(run.gcRounds, "no GC round advanced the floor").toBeGreaterThan(0);
    },
    120_000,
  );

  it("A_seed_reproduces_its_run", async () => {
    const first = await runFaultHarness({ seed: 3, steps: 40 });
    const second = await runFaultHarness({ seed: 3, steps: 40 });

    expect(second.trace).toEqual(first.trace);
  }, 60_000);
});
