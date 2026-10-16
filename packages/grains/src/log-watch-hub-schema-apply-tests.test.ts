import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainKeyKind } from "@thresh/core/grain-key";
import type { KeyTypeOf } from "@thresh/core/key-kinds";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitReply, CommitRequest } from "./commit-contract";
import type { DatastoreHeadWire } from "./datastore-dtos";
import type { DatastoreGrainState } from "./datastore-grain-state";
import type { ShardTailWire } from "./datastore-meta-state";
import type { GraphShardKeyWire } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import type { IDatastoreGrain } from "./i-datastore-grain";
import type { LogSegment } from "./log-event";
import { LogWatchHub } from "./log-watch-hub";

// Ported from Spiceport `tests/Spiceport.Grains.Tests/LogWatchHubSchemaApplyTests.cs`, case for case.
//
// The `LogWatchHub` schema-apply dedup: a stored hash is recorded as applied only once the apply has
// succeeded, so a transient apply failure is retried by the next push (or heartbeat) carrying the
// same hash instead of pinning the silo on its stale schema. The first two cases are pure unit
// tests: the constructor never touches the grain or the grain factory, and `schemaAdvanced` only
// drives the apply callback, so the C#'s `null!` collaborators become casts.
//
// Port decisions:
//   * Timers are vitest's fake timers, as in `log-watch-hub.test.ts`, so "the next heartbeat" is an
//     exact clock advance rather than the C#'s real 10ms cadence and a 10s `WaitAsync` bound.
//   * THE RACING CASE. The C# races two applies on two threads: the h2 apply stalls (a blocked
//     `ManualResetEventSlim`) after swapping the provider while an h1 apply runs. The port's apply
//     callback is synchronous and JavaScript has one thread, so an apply cannot be suspended
//     mid-way; the dedup check, apply and record are one synchronous block, which is what the C#'s
//     `_schemaApplyLock` makes them. The interleaving that DOES exist here is the heartbeat's: it
//     checks the reply's hash, then awaits `readSchemaAt` before applying, and a push can land in
//     that gap. So the port races a push of h2 against a heartbeat parked on its h1 fetch, the
//     JavaScript form of "a stale heartbeat-style apply of h1 runs meanwhile", and asserts the C#'s
//     invariant: provider and record never disagree, so the stale apply is only a mismatch that the
//     next push or heartbeat of the current hash repairs.

const utf8 = new TextEncoder();

function bytes(text: string): Uint8Array {
  return utf8.encode(text);
}

/** Runs pending microtasks (and any already-due timers) without advancing the clock. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** The C#'s `grain: null!, grainFactory: null!`: collaborators the case never reaches. */
function detachedHub(applySchema: (schema: string) => void): LogWatchHub {
  return new LogWatchHub(
    undefined as unknown as IDatastoreGrain,
    undefined as unknown as GrainFactoryAccess,
    undefined,
    applySchema,
  );
}

describe("LogWatchHub schema apply", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a failed apply on the next push of the same hash", async () => {
    let invocations = 0;
    const applied: string[] = [];
    const hub = detachedHub((text) => {
      invocations++;
      if (invocations === 1) throw new Error("transient provider failure");
      applied.push(text);
    });

    await hub.schemaAdvanced(bytes("schema-A"), "h1");
    await hub.schemaAdvanced(bytes("schema-A"), "h1");

    expect(invocations).toBe(2);
    expect(applied).toEqual(["schema-A"]);
  });

  it("does not repeat a successful apply for the same hash", async () => {
    let invocations = 0;
    const hub = detachedHub(() => {
      invocations++;
    });

    await hub.schemaAdvanced(bytes("schema-A"), "h1");
    await hub.schemaAdvanced(bytes("schema-A"), "h1");

    expect(invocations).toBe(1);
  });

  // The heartbeat backstop: a failed apply leaves the hash unrecorded, so the next heartbeat whose
  // `subscribeWatch` reply carries the same stored hash fetches the bytes again via `readSchemaAt`
  // and retries the apply.
  it("retries a failed apply on the next heartbeat reporting the same hash", async () => {
    const grain = new HeartbeatFakeGrain(7n, "h1", bytes("schema-A"));
    let invocations = 0;
    const applied: string[] = [];
    const hub = new LogWatchHub(grain, new ObserverOnlyGrainFactory(), { ms: 10 }, (text) => {
      invocations++;
      if (invocations === 1) throw new Error("transient provider failure");
      applied.push(text);
    });
    try {
      hub.ensureStarted();
      await flush();
      expect(applied).toEqual([]);

      await vi.advanceTimersByTimeAsync(10);

      expect(applied).toEqual(["schema-A"]);
      expect(grain.readSchemaAtCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await hub.dispose();
    }
  });

  // Two applies of different hashes racing: the provider and the recorded hash must never
  // disagree. Were they to (the provider holding h1 while h2 is recorded), every later push or
  // heartbeat of h2 would be deduplicated away. With apply and record atomic, whichever schema the
  // provider ends up holding is the one recorded, so a later push of h2 is applied. See the file
  // header for why the race is the heartbeat's fetch gap rather than a stalled apply.
  it("leaves provider and record consistent when applies of different hashes race", async () => {
    const grain = new HeartbeatFakeGrain(7n, "h1", bytes("schema-1"));
    const fetch = grain.gateReadSchemaAt();
    let current = "";
    const hub = new LogWatchHub(grain, new ObserverOnlyGrainFactory(), { ms: 1_000 }, (text) => {
      current = text;
    });
    try {
      // A heartbeat reporting h1 passes its hash check and parks on the h1 fetch.
      hub.ensureStarted();
      await flush();
      expect(grain.readSchemaAtCalls).toBe(1);

      // Push of h2 lands meanwhile and swaps the provider.
      await hub.schemaAdvanced(bytes("schema-2"), "h2");
      expect(current).toBe("schema-2");

      // The stale heartbeat apply of h1 then lands last.
      fetch.release();
      await flush();
      expect(current).toBe("schema-1");

      // The next push (or heartbeat) of the current stored hash must leave the provider on h2.
      await hub.schemaAdvanced(bytes("schema-2"), "h2");

      expect(current).toBe("schema-2");
    } finally {
      await hub.dispose();
    }
  });
});

/**
 * An `IDatastoreGrain` whose heartbeat reply always reports the same head and stored schema hash,
 * and whose `readSchemaAt` returns the matching bytes - optionally held until a gate is released.
 * Everything else is unused.
 */
class HeartbeatFakeGrain implements IDatastoreGrain {
  readSchemaAtCalls = 0;
  #gate: Promise<void> | undefined = undefined;

  constructor(
    private readonly head: bigint,
    private readonly schemaHash: string,
    private readonly schemaBytes: Uint8Array,
  ) {}

  /** Holds every `readSchemaAt` reply until the returned gate is released. */
  gateReadSchemaAt(): { release(): void } {
    let release!: () => void;
    this.#gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { release };
  }

  subscribeWatch(): Promise<DatastoreHeadWire> {
    return Promise.resolve({ head: this.head, schemaHash: this.schemaHash });
  }

  unsubscribeWatch(): Promise<void> {
    return Promise.resolve();
  }

  async readSchemaAt(): Promise<Uint8Array | undefined> {
    this.readSchemaAtCalls++;
    if (this.#gate !== undefined) await this.#gate;
    return this.schemaBytes;
  }

  getHead(): Promise<DatastoreHeadWire> {
    return Promise.resolve({ head: this.head, schemaHash: this.schemaHash });
  }
  readState(): Promise<DatastoreGrainState> {
    throw new Error("not supported");
  }
  readShard(_key: GraphShardKeyWire): Promise<GraphShardState> {
    throw new Error("not supported");
  }
  readShardTail(_key: GraphShardKeyWire): Promise<ShardTailWire> {
    throw new Error("not supported");
  }
  flushProjection(): Promise<void> {
    throw new Error("not supported");
  }
  commit(_request: CommitRequest): Promise<CommitReply> {
    throw new Error("not supported");
  }
  readFrom(_afterRevision: bigint, _maxCount: number): Promise<LogSegment> {
    throw new Error("not supported");
  }
  runGc(): Promise<bigint | undefined> {
    throw new Error("not supported");
  }
}

/**
 * A grain factory that supports only the observer-reference calls the hub makes: the "reference"
 * is the observer itself (in-process, no runtime), and deletion is a no-op.
 */
class ObserverOnlyGrainFactory implements GrainFactoryAccess {
  getGrain<T, K extends GrainKeyKind>(_def: GrainInterface<T, K>, _key: KeyTypeOf<K>): T {
    throw new Error("not supported");
  }

  createObjectReference<T>(_def: GrainInterface<T>, obj: object): T {
    return obj as T;
  }

  deleteObjectReference(_ref: object): void {
    // No runtime, nothing to release.
  }
}
