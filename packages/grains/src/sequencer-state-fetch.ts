import { RevisionNotFoundException } from "@spacedb/datastore/datastore-exceptions";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { raceSignal } from "@thresh/core/abort";

import type { DatastoreGrainState } from "./datastore-grain-state";
import type { IDatastoreGrain } from "./i-datastore-grain";

/**
 * Ported from Spiceport `Datastore/SequencerStateFetch.cs`.
 *
 * The closed-timestamp gate for sequencer-snapshot fetches (the successor of the retired per-silo
 * projection's watermark wait): a reader pinned at revision R must never be built over a fetched
 * state whose head is below R. During cluster membership churn a stale DUPLICATE activation of the
 * singleton can briefly serve an old head (its storage-version CAS keeps it from ever committing,
 * but a pure `IDatastoreGrain.readState` against it answers from the stale fold) - so a
 * below-required head is refetched with a bounded retry, and on exhaustion surfaces as
 * `RevisionNotFoundException` rather than a silently-stale snapshot.
 *
 * Port decisions:
 *   * `internal static class` -> a module-level function, per the port guide's static-class rule.
 *   * `long` -> `bigint` on BOTH sides of the `>=`; a `number` narrowing loses nanosecond
 *     precision above 2^53 and would accept a stale head one nanosecond short of the pin.
 *   * `Task.Delay(RetryDelay, ct)` OBSERVES the token, so the delay is raced against the signal
 *     with `raceSignal` (the guide's `task.WaitAsync(token)` row), which rejects with
 *     `GrainCallAbortedError`. A bare `setTimeout` would leave a 20ms unkillable window per
 *     attempt - a whole second across the retry budget.
 *   * `grain.ReadState()` is called WITHOUT the token in the C#, so the signal is not forwarded
 *     there, and there is no `ThrowIfCancellationRequested` at the top of the loop.
 */

/** Bound on refetch attempts before surfacing the pinned revision as unresolvable. */
const MAX_ATTEMPTS = 50;

/** Delay between refetch attempts, in milliseconds (churn settles within the retry budget). */
const RETRY_DELAY_MS = 20;

/** `Task.Delay(ms, ct)`: a timer whose WAIT is abandoned when the signal fires. */
function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sleep = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return raceSignal(sleep, signal).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Fetches the sequencer's materialized state, requiring its head to cover `requiredRevision`.
 *
 * Exhaustion costs exactly `MAX_ATTEMPTS` reads and `MAX_ATTEMPTS - 1` delays: the throw fires on
 * the check `attempt + 1 >= MAX_ATTEMPTS`, which is reached only after that attempt's read.
 */
export async function stateCovering(
  grain: IDatastoreGrain,
  requiredRevision: bigint,
  signal?: AbortSignal | undefined,
): Promise<DatastoreGrainState> {
  for (let attempt = 0; ; attempt++) {
    const state = await grain.readState();
    if (state.headRevision >= requiredRevision) return state;

    if (attempt + 1 >= MAX_ATTEMPTS) {
      throw new RevisionNotFoundException(new TimestampRevision(requiredRevision));
    }
    await delay(RETRY_DELAY_MS, signal);
  }
}
