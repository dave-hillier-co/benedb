import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import { GrainCallAbortedError } from "@thresh/core/errors";
import { describe, expect, it } from "vitest";

import { datastoreGrainStateEmpty, type DatastoreGrainState } from "./datastore-grain-state";
import type { IDatastoreGrain } from "./i-datastore-grain";
import { stateCovering } from "./sequencer-state-fetch";

/**
 * No covering C# test - a characterization of `Datastore/SequencerStateFetch.cs`.
 *
 * Every constant in that file is private and load-bearing, and this file is the ONLY gate they
 * will have until the mesh suites land, so each is pinned BEHAVIOURALLY (call counts and elapsed
 * time), exactly as the C# loop makes them observable:
 *
 *     for (var attempt = 0; ; attempt++)
 *     {
 *         var state = await grain.ReadState();            // no cancellation token
 *         if (state.HeadRevision >= requiredRevision) return state;
 *         if (attempt + 1 >= MaxAttempts) throw new RevisionNotFoundException(new TimestampRevision(required));
 *         await Task.Delay(RetryDelay, ct);
 *     }
 *
 * with `MaxAttempts = 50` and `RetryDelay = 20ms`. So exhaustion costs exactly 50 `ReadState`
 * calls and 49 delays - not 51, and not 50 delays. An off-by-one either way is invisible to
 * every other test in this repository.
 *
 * PINNED CHOICE (the C# leaves no counterpart): `Task.Delay(RetryDelay, ct)` OBSERVES the token
 * and throws when it fires. The port must therefore reject when the signal aborts mid-delay; a
 * bare `setTimeout` leaves an unkillable 20ms window per attempt (a whole second across the
 * budget). The rejection is `GrainCallAbortedError`, which is what the port guide's
 * `raceSignal(promise, signal)` row produces for a wait that observes a token.
 */

/** A `DatastoreGrainState` whose only interesting field is its head. */
function stateAt(head: bigint): DatastoreGrainState {
  return { ...datastoreGrainStateEmpty(head), gcFloor: 0n };
}

interface FakeGrain {
  /** The grain, typed as the interface `StateCovering` takes. */
  readonly grain: IDatastoreGrain;
  /** One entry per `readState` call, holding the ARGUMENTS it was given. */
  readonly calls: unknown[][];
}

/** A grain whose `readState` answers from a script; the last entry repeats forever. */
function fakeGrain(heads: readonly bigint[], onCall?: (index: number) => void): FakeGrain {
  const calls: unknown[][] = [];
  const grain = {
    readState(...args: unknown[]): Promise<DatastoreGrainState> {
      const index = calls.length;
      calls.push(args);
      onCall?.(index);
      const head = heads[Math.min(index, heads.length - 1)] ?? 0n;
      return Promise.resolve(stateAt(head));
    },
  };
  return { grain: grain as unknown as IDatastoreGrain, calls };
}

describe("stateCovering", () => {
  it("returns the first state whose head is ABOVE the required revision", async () => {
    const { grain, calls } = fakeGrain([100n]);

    const state = await stateCovering(grain, 50n);

    expect(state.headRevision).toBe(100n);
    // One read, and - since the guard passed - no delay was ever reached.
    expect(calls).toHaveLength(1);
  });

  it("treats an EQUAL head as covering (`state.HeadRevision >= requiredRevision`)", async () => {
    const { grain, calls } = fakeGrain([50n]);

    const state = await stateCovering(grain, 50n);

    expect(state.headRevision).toBe(50n);
    expect(calls).toHaveLength(1);
  });

  it("calls ReadState WITHOUT the cancellation token (the C# writes `grain.ReadState()`)", async () => {
    const controller = new AbortController();
    const { grain, calls } = fakeGrain([7n]);

    await stateCovering(grain, 7n, controller.signal);

    expect(calls).toEqual([[]]);
  });

  it("refetches while the head is below the pin and returns the covering state", async () => {
    const { grain, calls } = fakeGrain([1n, 2n, 9n]);

    const state = await stateCovering(grain, 9n);

    // Three reads: two below the pin, then the one that covers - and the covering one is what is
    // returned, never the stale first read.
    expect(calls).toHaveLength(3);
    expect(state.headRevision).toBe(9n);
  });

  it("compares heads as bigints, so a one-nanosecond shortfall above 2^53 still refetches", async () => {
    // `long` -> bigint. These two are DIFFERENT nanosecond values that collapse to the SAME
    // double, so a Number narrowing anywhere in the comparison would accept the stale head.
    const required = 9_007_199_254_740_993n;
    const oneShort = 9_007_199_254_740_992n;
    expect(Number(required)).toBe(Number(oneShort));

    const { grain, calls } = fakeGrain([oneShort, oneShort, required]);
    const state = await stateCovering(grain, required);

    expect(calls).toHaveLength(3);
    expect(state.headRevision).toBe(required);
  });

  it("reads exactly 50 times and then throws RevisionNotFoundException for the pinned revision", async () => {
    // MaxAttempts = 50: the throw happens when `attempt + 1 >= 50`, i.e. AFTER the 50th read,
    // with 49 delays of 20ms in between.
    const { grain, calls } = fakeGrain([0n]);
    const started = Date.now();

    await expect(stateCovering(grain, 42n)).rejects.toThrow(RevisionNotFoundException);

    const elapsed = Date.now() - started;
    expect(calls).toHaveLength(50);
    // 49 * 20ms = 980ms; the lower bound is what pins RetryDelay (a 1ms delay would finish in
    // ~50ms, a 51st attempt would need another read).
    expect(elapsed).toBeGreaterThanOrEqual(900);
  }, 15_000);

  it("names the REQUIRED revision in the thrown exception, as a TimestampRevision", async () => {
    // `throw new RevisionNotFoundException(new TimestampRevision(requiredRevision));`
    const { grain } = fakeGrain([0n]);

    const error = await stateCovering(grain, 42n).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RevisionNotFoundException);
    const revision = (error as RevisionNotFoundException).revision;
    expect(revision).toBeInstanceOf(TimestampRevision);
    expect((revision as TimestampRevision).timestampNanosSinceEpoch).toBe(42n);
    expect((error as Error).message).toBe("revision 42 is no longer available");
  });

  it("aborts the wait when the signal fires between attempts", async () => {
    // The abort lands during the FIRST delay, so exactly one read has happened and the loop must
    // not run its 49 remaining 20ms windows.
    const controller = new AbortController();
    const { grain, calls } = fakeGrain([0n], () => controller.abort());
    const started = Date.now();

    await expect(stateCovering(grain, 1n, controller.signal)).rejects.toThrow(
      GrainCallAbortedError,
    );

    expect(calls).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("still returns when the signal is ALREADY aborted but the first head covers", async () => {
    // There is no `ThrowIfCancellationRequested` at the top of the C# loop: the token is observed
    // only by `Task.Delay`, which a covering first read never reaches.
    const controller = new AbortController();
    controller.abort();
    const { grain, calls } = fakeGrain([100n]);

    const state = await stateCovering(grain, 100n, controller.signal);

    expect(state.headRevision).toBe(100n);
    expect(calls).toHaveLength(1);
  });
});
