import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GrainCallAbortedError } from "@thresh/core/errors";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainKeyFor } from "@thresh/core/key-kinds";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import type { CommitReply, CommitRequest } from "./commit-contract";
import type { DatastoreHeadWire } from "./datastore-dtos";
import type { DatastoreGrainState } from "./datastore-grain-state";
import type { GraphShardKeyWire } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import type { IDatastoreGrain } from "./i-datastore-grain";
import { IDatastoreWatcher } from "./i-datastore-watcher";
import type { LogSegment } from "./log-event";
import { LogWatchHub } from "./log-watch-hub";

/**
 * Characterization tests for the port of Spiceport `Datastore/LogWatchHub.cs`, which has NO
 * covering C# test of its own: in Spiceport it is exercised only indirectly, from
 * `Stage3WatchOverLogTests` / `Stage3WatchPushMeshTests` (a later batch) and incidentally by
 * `GrainBackedDatastoreWriteBaseTests`, which constructs one and never starts it. Until those land
 * this file is the hub's only gate, so it pins the behaviour the C# actually has - the signal
 * swap order, the monotonic pulse, the four-jobs-in-one-hop heartbeat, the deliberate
 * hash-before-apply ordering, and the swallow-never-throw teardown - rather than any particular
 * implementation of them.
 *
 * Port decisions this file pins deliberately:
 *   * `TaskCompletionSource` -> a `{ promise, resolve }` pair, swapped in a SYNCHRONOUS block that
 *     contains no await. The swap-before-complete order is load-bearing: completing first would
 *     let a waiter re-enter `waitForChangeAfter` and grab the already-completed signal, which
 *     `swapsTheSignalBeforeCompletingIt` catches directly.
 *   * `signal.WaitAsync(ct)` REJECTS on cancellation, so the parked wait is `raceSignal`, whose
 *     rejection is Thresh's `GrainCallAbortedError` - the very type `GrainBackedDatastore.watch`
 *     catches to `yield break`. A flag check that merely returns would turn a cancelled wait into
 *     a spurious wake-up, and a bare stored promise would leave the wait pending forever.
 *   * DEVIATION - `DisposeAsync`'s `_signal.TrySetResult()` releases stragglers on the assumption
 *     that their own token is cancelled too; a straggler with a live token re-enters the loop,
 *     re-captures the SAME (now completed) signal and spins. Under threads that is a hot loop;
 *     on a single-threaded event loop it is an infinite microtask loop that starves everything,
 *     so this port makes disposal a RELEASING exit: a parked `waitForChangeAfter` RETURNS. If
 *     `releasesParkedStragglersOnDispose` hangs rather than fails, that is the spin.
 *   * `Task.Run` -> a detached loop whose handle is held, so disposal actually stops it. An
 *     orphaned heartbeat is the Node analogue of the orphaned-host hazard CLAUDE.md forbids, which
 *     `stopsTheHeartbeatLoop` pins.
 */

/** The default heartbeat cadence (`DefaultHeartbeatInterval`), a deliberate 10x under the grain's 10s WatcherExpiry. */
const DEFAULT_HEARTBEAT_MS = 1_000;

/** The heartbeat cadence used wherever the test only cares about "one more hop". */
const FAST_HEARTBEAT_MS = 50;

const utf8 = new TextEncoder();

/** An `IDatastoreGrain` stub carrying only the three members the hub actually calls. */
class WatchFakeGrain implements IDatastoreGrain {
  /** Every observed call, in order, so teardown ORDER can be asserted, not just membership. */
  readonly calls: string[] = [];

  subscribeCalls = 0;
  readSchemaAtCalls = 0;
  /** The reference the hub minted and handed to `subscribeWatch`, as received by the grain. */
  readonly subscribedWith: IDatastoreWatcher[] = [];
  readonly readSchemaAtRevisions: bigint[] = [];

  head: DatastoreHeadWire = { head: 0n, gcFloor: 0n };
  schemaBytes: Uint8Array | undefined = undefined;

  /** Set to make the next `subscribeWatch` reject once (a transient grain unavailability). */
  failSubscribeTimes = 0;
  /** Set to make `unsubscribeWatch` reject (teardown must swallow it). */
  failUnsubscribe = false;

  subscribeWatch(watcher: IDatastoreWatcher): Promise<DatastoreHeadWire> {
    this.calls.push("subscribeWatch");
    this.subscribeCalls += 1;
    this.subscribedWith.push(watcher);
    if (this.failSubscribeTimes > 0) {
      this.failSubscribeTimes -= 1;
      return Promise.reject(new Error("grain momentarily unavailable"));
    }
    return Promise.resolve(this.head);
  }

  unsubscribeWatch(_watcher: IDatastoreWatcher): Promise<void> {
    this.calls.push("unsubscribeWatch");
    if (this.failUnsubscribe) return Promise.reject(new Error("runtime already stopped"));
    return Promise.resolve();
  }

  readSchemaAt(revision: bigint): Promise<Uint8Array | undefined> {
    this.calls.push("readSchemaAt");
    this.readSchemaAtCalls += 1;
    this.readSchemaAtRevisions.push(revision);
    return Promise.resolve(this.schemaBytes);
  }

  readState(): Promise<DatastoreGrainState> {
    throw new Error("not supported");
  }
  getHead(): Promise<DatastoreHeadWire> {
    throw new Error("not supported");
  }
  readShard(_key: GraphShardKeyWire): Promise<GraphShardState> {
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

/** A grain factory recording the observer-reference lifecycle the hub drives. */
class RecordingFactory implements GrainFactoryAccess {
  readonly created: Array<{ readonly def: GrainInterface<unknown>; readonly obj: object }> = [];
  readonly deleted: object[] = [];
  failDelete = false;

  constructor(private readonly grain: IDatastoreGrain) {}

  getGrain<T>(_def: GrainInterface<T>, _key: GrainKeyFor<T>): T {
    return this.grain as unknown as T;
  }

  createObjectReference<T>(def: GrainInterface<T>, obj: object): T {
    this.created.push({ def: def as GrainInterface<unknown>, obj });
    // A DISTINCT object, as Thresh's `createObjectReference` returns: what reaches the grain must
    // be the reference, never the hub itself.
    return { observerReference: this.created.length } as unknown as T;
  }

  deleteObjectReference(ref: object): void {
    this.deleted.push(ref);
    if (this.failDelete) throw new Error("runtime already stopped");
  }
}

interface Tracked {
  readonly promise: Promise<void>;
  settled(): boolean;
  error(): unknown;
}

/** Observes a promise's settlement without letting a rejection escape as unhandled. */
function track(promise: Promise<void>): Tracked {
  let done = false;
  let failure: unknown = undefined;
  const observed = promise.then(
    () => {
      done = true;
    },
    (err: unknown) => {
      done = true;
      failure = err;
    },
  );
  return {
    promise: observed,
    settled: () => done,
    error: () => failure,
  };
}

/** Runs pending microtasks (and any already-due timers) without advancing the clock. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("LogWatchHub", () => {
  let grain: WatchFakeGrain;
  let factory: RecordingFactory;

  beforeEach(() => {
    vi.useFakeTimers();
    grain = new WatchFakeGrain();
    factory = new RecordingFactory(grain);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function newHub(applySchema?: (schema: string) => void): LogWatchHub {
    return new LogWatchHub(grain, factory, { ms: FAST_HEARTBEAT_MS }, applySchema);
  }

  describe("pulse / waitForChangeAfter", () => {
    it("returnsImmediatelyWhenTheObservedHeadIsAlreadyPastTheCursor", async () => {
      const hub = newHub();
      hub.pulse(5n);

      const wait = track(hub.waitForChangeAfter(4n));
      await flush();

      expect(wait.settled()).toBe(true);
      expect(wait.error()).toBeUndefined();
      await hub.dispose();
    });

    it("parksUntilAPulseAdvancesTheHeadPastTheCursor", async () => {
      const hub = newHub();

      const wait = track(hub.waitForChangeAfter(5n));
      await flush();
      expect(wait.settled()).toBe(false);

      hub.pulse(6n);
      await flush();
      expect(wait.settled()).toBe(true);
      expect(wait.error()).toBeUndefined();
      await hub.dispose();
    });

    it("ignoresAPulseAtOrBelowTheObservedHead", async () => {
      const hub = newHub();
      hub.pulse(5n);

      // Monotonic: neither a repeat nor a LOWER head may wake a waiter parked at the current head,
      // and neither may lower the observed head (racing sources are harmless).
      const wait = track(hub.waitForChangeAfter(5n));
      await flush();
      expect(wait.settled()).toBe(false);

      hub.pulse(5n);
      hub.pulse(3n);
      await flush();
      expect(wait.settled()).toBe(false);

      // The observed head is still 5, so a cursor below it is already satisfied.
      const past = track(hub.waitForChangeAfter(4n));
      await flush();
      expect(past.settled()).toBe(true);

      hub.pulse(6n);
      await flush();
      expect(wait.settled()).toBe(true);
      await hub.dispose();
    });

    it("swapsTheSignalBeforeCompletingIt", async () => {
      const hub = newHub();

      // Parked at a cursor no pulse below 11 can satisfy. The pulse to 5 completes the signal the
      // waiter holds; the waiter re-enters the loop, finds 5 is not past 10, and must park on a
      // FRESH signal. Completing before swapping would hand it the already-completed prior one and
      // spin the loop forever instead of parking.
      const wait = track(hub.waitForChangeAfter(10n));
      await flush();

      hub.pulse(5n);
      await flush();
      expect(wait.settled()).toBe(false);

      hub.pulse(11n);
      await flush();
      expect(wait.settled()).toBe(true);
      await hub.dispose();
    });

    it("headAdvancedPushDeliveryPulsesTheHub", async () => {
      const hub = newHub();

      await hub.headAdvanced(9n);

      const wait = track(hub.waitForChangeAfter(8n));
      await flush();
      expect(wait.settled()).toBe(true);
      await hub.dispose();
    });

    it("rejectsAParkedWaitWhenItsSignalAborts", async () => {
      const hub = newHub();
      const controller = new AbortController();

      const wait = track(hub.waitForChangeAfter(5n, controller.signal));
      await flush();
      expect(wait.settled()).toBe(false);

      controller.abort();
      await flush();

      expect(wait.settled()).toBe(true);
      expect(wait.error()).toBeInstanceOf(GrainCallAbortedError);
      await hub.dispose();
    });

    it("rejectsImmediatelyForAnAlreadyAbortedSignal", async () => {
      const hub = newHub();
      const controller = new AbortController();
      controller.abort();

      const wait = track(hub.waitForChangeAfter(5n, controller.signal));
      await flush();

      expect(wait.settled()).toBe(true);
      expect(wait.error()).toBeInstanceOf(GrainCallAbortedError);
      await hub.dispose();
    });
  });

  describe("schemaAdvanced", () => {
    it("decodesTheSchemaBytesAsUtf8", async () => {
      const applied: string[] = [];
      const hub = newHub((s) => applied.push(s));

      // Multi-byte on purpose: the bytes arrive as a Uint8Array through the observer argument, and
      // a latin1/binary-string decode would mangle exactly this.
      const schema = "definition dócument/日本 {}";
      await hub.schemaAdvanced(utf8.encode(schema), "hash-1");

      expect(applied).toEqual([schema]);
      await hub.dispose();
    });

    it("appliesEachStoredHashOnlyOnce", async () => {
      const applied: string[] = [];
      const hub = newHub((s) => applied.push(s));

      await hub.schemaAdvanced(utf8.encode("one"), "hash-1");
      await hub.schemaAdvanced(utf8.encode("one-again"), "hash-1");
      await hub.schemaAdvanced(utf8.encode("two"), "hash-2");

      // Monotonic by stored hash, so a racing push and heartbeat repair can never double-apply.
      expect(applied).toEqual(["one", "two"]);
      await hub.dispose();
    });

    it("marksAThrowingApplyAsAppliedAndSwallowsTheFailure", async () => {
      let calls = 0;
      const hub = newHub(() => {
        calls += 1;
        throw new Error("poison schema");
      });

      // DELIBERATE, not a bug to "fix" into a rollback: the hash is recorded BEFORE the apply runs,
      // so a poison schema is never retried forever. The failure is logged and swallowed, so a bad
      // push can never kill this observer callback or the heartbeat loop.
      await expect(hub.schemaAdvanced(utf8.encode("bad"), "hash-1")).resolves.toBeUndefined();
      await hub.schemaAdvanced(utf8.encode("bad"), "hash-1");

      expect(calls).toBe(1);
      await hub.dispose();
    });
  });

  describe("ensureStarted / heartbeat", () => {
    it("doesNothingUntilEnsureStarted", async () => {
      const hub = newHub();
      hub.pulse(3n);

      await vi.advanceTimersByTimeAsync(FAST_HEARTBEAT_MS * 4);

      expect(factory.created).toEqual([]);
      expect(grain.subscribeCalls).toBe(0);
      await hub.dispose();
    });

    it("isIdempotentAndRunsExactlyOneLoop", async () => {
      const hub = newHub();

      hub.ensureStarted();
      hub.ensureStarted();
      await flush();
      expect(factory.created).toHaveLength(1);
      expect(grain.subscribeCalls).toBe(1);

      hub.ensureStarted();
      await vi.advanceTimersByTimeAsync(FAST_HEARTBEAT_MS);
      // One loop, so one hop per interval - not two, and not four.
      expect(grain.subscribeCalls).toBe(2);
      expect(factory.created).toHaveLength(1);
      await hub.dispose();
    });

    it("mintsAnObserverReferenceForTheWatcherInterfaceAndSubscribesWithIt", async () => {
      const hub = newHub();

      hub.ensureStarted();
      await flush();

      expect(factory.created[0]?.def).toBe(IDatastoreWatcher);
      expect(factory.created[0]?.obj).toBe(hub);
      // The grain must receive the REFERENCE, never the hub itself: only a reference can be called
      // back across the silo boundary.
      expect(grain.subscribedWith[0]).not.toBe(hub);
      expect(grain.subscribedWith).toHaveLength(1);
      await hub.dispose();
    });

    it("pulsesTheHeadCarriedByTheHeartbeatReply", async () => {
      const hub = newHub();
      grain.head = { head: 7n, gcFloor: 0n };

      const wait = track(hub.waitForChangeAfter(0n));
      hub.ensureStarted();
      await flush();

      // The missed-push backstop: a stream parked on a commit whose push never arrived still wakes
      // within one heartbeat.
      expect(wait.settled()).toBe(true);
      await hub.dispose();
    });

    it("beatsAtTheDefaultOneSecondCadenceWhenNoIntervalIsGiven", async () => {
      // The default is a deliberate 10x under `DatastoreGrain`'s 10s WatcherExpiry, so a silo must
      // miss many heartbeats before its registration is dropped. Do not drift the two apart.
      const hub = new LogWatchHub(grain, factory);

      hub.ensureStarted();
      await flush();
      expect(grain.subscribeCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_MS - 1);
      expect(grain.subscribeCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(grain.subscribeCalls).toBe(2);
      await hub.dispose();
    });

    it("repairsAMissedSchemaPushFromTheReplyHash", async () => {
      const applied: string[] = [];
      const hub = newHub((s) => applied.push(s));
      grain.head = { head: 7n, schemaHash: "hash-1", gcFloor: 0n };
      grain.schemaBytes = utf8.encode("definition user {}");

      hub.ensureStarted();
      await flush();

      // One hop, four jobs - and the schema half of the missed-push backstop costs exactly one
      // extra `readSchemaAt`, at the head the reply carried.
      expect(grain.readSchemaAtCalls).toBe(1);
      expect(grain.readSchemaAtRevisions).toEqual([7n]);
      expect(applied).toEqual(["definition user {}"]);

      // The hash is now applied, so later heartbeats pay no fetch hop at all.
      await vi.advanceTimersByTimeAsync(FAST_HEARTBEAT_MS * 3);
      expect(grain.readSchemaAtCalls).toBe(1);
      expect(applied).toEqual(["definition user {}"]);
      await hub.dispose();
    });

    it("paysNoSchemaFetchWhenTheReplyCarriesNoHash", async () => {
      const hub = newHub(() => undefined);
      grain.head = { head: 7n, gcFloor: 0n };

      hub.ensureStarted();
      await vi.advanceTimersByTimeAsync(FAST_HEARTBEAT_MS * 2);

      expect(grain.subscribeCalls).toBeGreaterThanOrEqual(2);
      expect(grain.readSchemaAtCalls).toBe(0);
      await hub.dispose();
    });

    it("recordsTheAppliedHashEvenWithNoApplySchemaCallback", async () => {
      // `applySchema` is optional (a hub built only to observe head advances). The hash is still
      // recorded before the null check, so the cheap pre-check stops fetching after the first hop.
      const hub = newHub();
      grain.head = { head: 7n, schemaHash: "hash-1", gcFloor: 0n };
      grain.schemaBytes = utf8.encode("definition user {}");

      hub.ensureStarted();
      await vi.advanceTimersByTimeAsync(FAST_HEARTBEAT_MS * 3);

      expect(grain.readSchemaAtCalls).toBe(1);
      await hub.dispose();
    });

    it("refetchesWhenTheSchemaReadReturnedNothing", async () => {
      const applied: string[] = [];
      const hub = newHub((s) => applied.push(s));
      grain.head = { head: 7n, schemaHash: "hash-1", gcFloor: 0n };
      grain.schemaBytes = undefined;

      hub.ensureStarted();
      await flush();
      expect(applied).toEqual([]);

      // Nothing was applied, so the hash stays unapplied and the next heartbeat tries again.
      await vi.advanceTimersByTimeAsync(FAST_HEARTBEAT_MS);
      expect(grain.readSchemaAtCalls).toBe(2);
      await hub.dispose();
    });

    it("backsOffOneIntervalAndRetriesAfterATransientGrainFailure", async () => {
      const hub = newHub();
      grain.head = { head: 4n, gcFloor: 0n };
      grain.failSubscribeTimes = 1;

      const wait = track(hub.waitForChangeAfter(0n));
      hub.ensureStarted();
      await flush();

      // The failed hop pulses nothing, and must NOT tear down every Watch stream on the silo.
      expect(grain.subscribeCalls).toBe(1);
      expect(wait.settled()).toBe(false);

      await vi.advanceTimersByTimeAsync(FAST_HEARTBEAT_MS);
      expect(grain.subscribeCalls).toBe(2);
      expect(wait.settled()).toBe(true);
      await hub.dispose();
    });

    it("survivesAThrowingSchemaApplyAndKeepsBeating", async () => {
      const hub = newHub(() => {
        throw new Error("poison schema");
      });
      grain.head = { head: 7n, schemaHash: "hash-1", gcFloor: 0n };
      grain.schemaBytes = utf8.encode("definition user {}");

      hub.ensureStarted();
      await flush();
      const afterFirst = grain.subscribeCalls;

      await vi.advanceTimersByTimeAsync(FAST_HEARTBEAT_MS * 2);
      expect(grain.subscribeCalls).toBeGreaterThan(afterFirst);
      await hub.dispose();
    });
  });

  describe("dispose", () => {
    it("stopsTheHeartbeatLoop", async () => {
      const hub = newHub();

      hub.ensureStarted();
      await flush();
      await hub.dispose();
      const afterDispose = grain.subscribeCalls;

      await vi.advanceTimersByTimeAsync(FAST_HEARTBEAT_MS * 10);
      // An orphaned heartbeat would keep hopping (and, in Node, keep the process alive).
      expect(grain.subscribeCalls).toBe(afterDispose);
    });

    it("unsubscribesTheMintedReferenceThenDeletesIt", async () => {
      const hub = newHub();

      hub.ensureStarted();
      await flush();
      const minted = grain.subscribedWith[0];

      await hub.dispose();

      expect(grain.calls.at(-1)).toBe("unsubscribeWatch");
      expect(factory.deleted).toEqual([minted]);
    });

    it("swallowsAFailingUnsubscribeAndAFailingDeleteObjectReference", async () => {
      const hub = newHub();
      grain.failUnsubscribe = true;
      factory.failDelete = true;

      hub.ensureStarted();
      await flush();

      // Disposal runs at container teardown, possibly AFTER the runtime has stopped: both steps are
      // best-effort and neither may fail teardown, and the delete must still be ATTEMPTED after the
      // unsubscribe threw (its own try/catch, not one shared with the unsubscribe).
      await expect(hub.dispose()).resolves.toBeUndefined();
      expect(factory.deleted).toHaveLength(1);
    });

    it("doesNothingWhenTheHubWasNeverStarted", async () => {
      const hub = newHub();

      await expect(hub.dispose()).resolves.toBeUndefined();

      expect(grain.calls).toEqual([]);
      expect(factory.created).toEqual([]);
      expect(factory.deleted).toEqual([]);
    });

    it("releasesParkedStragglersOnDispose", async () => {
      const hub = newHub();

      const wait = track(hub.waitForChangeAfter(99n));
      await flush();
      expect(wait.settled()).toBe(false);

      // See the file header: the C# releases the signal and relies on the straggler's own token
      // being cancelled; this port makes disposal a releasing EXIT so the wait cannot spin. A HANG
      // here rather than a failure is that spin.
      await hub.dispose();
      await flush();

      expect(wait.settled()).toBe(true);
    });
  });
});
