import { describe, expect, it } from "vitest";

import { raceSignal } from "@thresh/core/abort";
import { grain } from "@thresh/core/decorators";
import { isCancellationError } from "@thresh/core/errors";
import { Grain } from "@thresh/core/grain";
import { defineGrainInterface } from "@thresh/core/grain-interface";
import type { GrainRegistrationSpec } from "@thresh/core/grain-registration-spec";
import type { GrainWithStringKey } from "@thresh/core/key-kinds";
import { TestCluster } from "@thresh/testing/test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/NativeCancellationProbeTests.cs`.
 *
 * A throwaway grain used only to prove that the runtime's grain-call path accepts a plain
 * cancellation parameter on a unary (non-streaming) grain method, and that caller cancellation
 * actually propagates to the CALLEE's own signal rather than only abandoning the caller-side await.
 * In Spiceport this was the gate for replacing Orleans' legacy grain-cancellation-token type with a
 * plain `CancellationToken` across the unary grain interfaces; here it is the same gate for the
 * ported `signal?: AbortSignal` parameter every dispatch interface carries.
 *
 * PORT NOTES.
 *  - Deliberately NOT `MeshTestCluster` (no schema or datastore is needed for this probe): the C#
 *    builds a bare `TestClusterBuilder` with an `ISiloConfigurator` that registers nothing, so this
 *    builds a bare `TestCluster.start` and REGISTERS ITS OWN probe grain. `GrainRegistrationSpec`
 *    is exported by Thresh, so the registration needs no cast.
 *  - `[Collection(MeshClusterCollection.Name)]` -> nothing: see `mesh-cluster-collection.ts`. This
 *    file stands up its own cluster per case and disposes it in a `finally`; no host is ever booted.
 *  - `CancellationToken` parameter -> a trailing `signal?: AbortSignal`. Thresh converts a signal
 *    argument into the cancellation shape the wire carries and hands the callee an `AbortSignal`
 *    back, so the callee's view does not depend on placement and an abort raised AFTER the call was
 *    sent still reaches the activation.
 *  - `Task.Delay(delayMs, cancellationToken)` -> a `setTimeout` promise wrapped in `raceSignal`,
 *    with the timer cleared in a `finally` (the guide's mapping). It REJECTS on abort, which is
 *    what makes the cancellation observable to the caller at all.
 *  - `OperationCanceledException` -> the cancellation family, tested with `isCancellationError`:
 *    TypeScript has no single base covering both Thresh's own cancellation errors and a DOM
 *    `AbortError`, so the predicate is the faithful counterpart of one `catch`.
 *  - `ILocalSiloDetails.SiloAddress` -> the activation's own silo address off `GrainRuntime`;
 *    `cluster.Primary!.SiloAddress` -> `cluster.primary.address`.
 *  - `cluster.GrainFactory` is the CLIENT's factory in Orleans, so this uses `await cluster.client`
 *    rather than `cluster.getGrain` (which issues the call from the primary silo).
 *  - The 64-key probe loop for a non-primary activation is KEPT: Thresh's default placement makes no
 *    spread guarantee either, so a fixed key would make the cross-silo case luck.
 *  - `WaitAsync(TimeSpan.FromSeconds(10))` is LOAD-BEARING, not decoration: a regression that
 *    ignores the signal must FAIL, never hang. The bound is reproduced by racing the call against a
 *    timer that rejects with a DISTINGUISHABLE error, so a timeout reports itself as one.
 */

/** The address of the silo hosting this activation, for asserting cross-silo placement. */
interface INativeCancellationProbeGrain extends GrainWithStringKey {
  whereAmI(): Promise<string>;
  /**
   * Awaits a delay of `delayMs` honouring `signal`, and reports completion. A fired signal rejects
   * the delay rather than letting it run out - a cheap signal that cancellation reached the
   * activation promptly rather than merely abandoning the caller's await.
   */
  delayHonoringCancellation(delayMs: number, signal?: AbortSignal | undefined): Promise<boolean>;
}

const INativeCancellationProbeGrain = defineGrainInterface<INativeCancellationProbeGrain>(
  "INativeCancellationProbeGrain",
);

/** `Task.Delay(ms, ct)`: a bounded delay that observes the signal and rejects when it fires. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sleep = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return raceSignal(sleep, signal).finally(() => {
    // The losing timer must never keep the process alive.
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** See {@link INativeCancellationProbeGrain}. */
@grain()
class NativeCancellationProbeGrain extends Grain implements INativeCancellationProbeGrain {
  whereAmI(): Promise<string> {
    return Promise.resolve(this.runtime.localSiloAddress().toString());
  }

  async delayHonoringCancellation(
    delayMs: number,
    signal?: AbortSignal | undefined,
  ): Promise<boolean> {
    await delay(delayMs, signal);
    return true;
  }
}

const PROBE_REGISTRATION: GrainRegistrationSpec = {
  ctor: NativeCancellationProbeGrain,
  interfaces: [INativeCancellationProbeGrain],
};

/** The C#'s `CreateClusterAsync(siloCount)`: a bare cluster hosting only the probe grain. */
function createCluster(siloCount: number): Promise<TestCluster> {
  return TestCluster.start({
    initialSilos: siloCount,
    // The probe grain carries no persisted state, so no storage/journaling providers are needed.
    grains: [PROBE_REGISTRATION],
  });
}

/** The load-bearing `WaitAsync(TimeSpan.FromSeconds(10))` bound. */
const WAIT_BUDGET_MS = 10_000;

class ProbeTimeoutError extends Error {
  constructor() {
    super(`the probe call did not settle within ${WAIT_BUDGET_MS}ms`);
    this.name = "ProbeTimeoutError";
  }
}

/**
 * `task.WaitAsync(timeout)`: settle with `work`, or reject with a DISTINGUISHABLE
 * {@link ProbeTimeoutError} once the budget elapses - so a callee that ignores its signal fails
 * this suite instead of hanging it.
 */
function waitAsync<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** `Assert.ThrowsAnyAsync<OperationCanceledException>` over the bounded wait. */
async function expectCancelled(call: Promise<unknown>): Promise<void> {
  const error = await waitAsync(call, WAIT_BUDGET_MS).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the cancelled call to reject, but it resolved").toBeDefined();
  expect(
    isCancellationError(error),
    `expected a cancellation error; saw ${String(error instanceof Error ? error.stack : error)}`,
  ).toBe(true);
}

describe("NativeCancellationProbeTests", () => {
  it("Uncancelled_call_completes_normally", async () => {
    const cluster = await createCluster(1);
    try {
      const client = await cluster.client;
      const grain = client.getGrain(INativeCancellationProbeGrain, "uncancelled");

      const completed = await grain.delayHonoringCancellation(50, undefined);

      expect(completed).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Caller_cancellation_propagates_to_the_grain_token_same_silo", async () => {
    const cluster = await createCluster(1);
    try {
      const client = await cluster.client;
      const grain = client.getGrain(INativeCancellationProbeGrain, "same-silo");

      const controller = new AbortController();
      const call = grain.delayHonoringCancellation(60_000, controller.signal);
      controller.abort();

      await expectCancelled(call);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Caller_cancellation_propagates_to_the_grain_token_cross_silo", async () => {
    const cluster = await createCluster(3);
    try {
      const client = await cluster.client;

      // Placement makes no spread guarantee, so probe several keys and use the first activation
      // this test process finds on a NON-primary silo (mirroring MeshTestCluster's documented
      // rationale for opting into spread rather than trusting a placement heuristic to scatter a
      // handful of calls).
      const primaryAddress = cluster.primary.address.toString();
      let remote: INativeCancellationProbeGrain | undefined;
      for (let i = 0; i < 64 && remote === undefined; i++) {
        const candidate = client.getGrain(INativeCancellationProbeGrain, `probe-${i}`);
        const where = await candidate.whereAmI();
        if (where !== primaryAddress) remote = candidate;
      }

      expect(remote).toBeDefined();

      const controller = new AbortController();
      const call = remote!.delayHonoringCancellation(60_000, controller.signal);
      controller.abort();

      await expectCancelled(call);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
