import type { GrainId } from "@thresh/core/grain-id";
import type { GrainStorage, StateHolder } from "@thresh/core/grain-storage";
import type { JournalEntry, JournalSegment, JournalStorage } from "@thresh/core/journal-storage";

/**
 * The faults the fault-injecting stores inject, and how many actually fired. A module-level handle,
 * because the stores are constructed once per harness run and a run owns the handle until it
 * resets it; vitest runs one file's tests serially.
 *
 * Port decision: the C# `FaultInjectingGrainStorage` fails the sequencer's state write, because
 * Spiceport's sequencer is journaled through state-storage log consistency. BeneDB's sequencer
 * appends to a Thresh journal, so the sequencer fault is a failed journal append, the same commit
 * point.
 */
export const storageFaults = {
  failSequencerWrites: 0,
  failShardWrites: 0,
  loseShardWrites: false,
  injectedSequencerFaults: 0,
  injectedShardFaults: 0,

  reset(): void {
    this.failSequencerWrites = 0;
    this.failShardWrites = 0;
    this.loseShardWrites = false;
    this.injectedSequencerFaults = 0;
    this.injectedShardFaults = 0;
  },
};

const INJECTED = "(fault harness)";

/** Whether `error` is, or wraps, one of the injected failures. */
export function isInjectedFault(error: unknown): boolean {
  for (
    let e: unknown = error;
    e !== undefined && e !== null;
    e = (e as { cause?: unknown }).cause
  ) {
    if (e instanceof Error && e.message.includes(INJECTED)) return true;
  }
  return false;
}

function isShard(grainId: GrainId): boolean {
  return String(grainId.type).toLowerCase().includes("graphshard");
}

/**
 * Wraps the `datastore` grain-storage provider (the shard projections and the shard index) so the
 * harness can fail shard-projection writes or silently drop them. Reads are never faulted.
 */
export class FaultInjectingGrainStorage implements GrainStorage {
  constructor(private readonly inner: GrainStorage) {}

  read<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inner.read(stateName, grainId, state, signal);
  }

  async write<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (isShard(grainId)) {
      if (storageFaults.failShardWrites > 0) {
        storageFaults.failShardWrites -= 1;
        storageFaults.injectedShardFaults += 1;
        throw new Error(`injected shard-projection write failure ${INJECTED}`);
      }
      if (storageFaults.loseShardWrites) return;
    }
    return this.inner.write(stateName, grainId, state, signal);
  }

  clear<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inner.clear(stateName, grainId, state, signal);
  }
}

/** Wraps the sequencer's journal so the harness can fail its appends, the commit point. */
export class FaultInjectingJournal implements JournalStorage {
  constructor(private readonly inner: JournalStorage) {}

  read(logName: string, grainId: GrainId, signal?: AbortSignal): Promise<JournalSegment> {
    return this.inner.read(logName, grainId, signal);
  }

  async append(
    logName: string,
    grainId: GrainId,
    entries: readonly JournalEntry[],
    expectedVersion: number | undefined,
    signal?: AbortSignal,
  ): Promise<number> {
    if (storageFaults.failSequencerWrites > 0) {
      storageFaults.failSequencerWrites -= 1;
      storageFaults.injectedSequencerFaults += 1;
      throw new Error(`injected sequencer write failure ${INJECTED}`);
    }
    return this.inner.append(logName, grainId, entries, expectedVersion, signal);
  }

  replace(
    logName: string,
    grainId: GrainId,
    entries: readonly JournalEntry[],
    expectedVersion: number | undefined,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.inner.replace(logName, grainId, entries, expectedVersion, signal);
  }

  clear(logName: string, grainId: GrainId, signal?: AbortSignal): Promise<void> {
    return this.inner.clear(logName, grainId, signal);
  }
}
