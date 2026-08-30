import { raceSignal } from "@thresh/core/abort";
import { durationToMs, type Duration } from "@thresh/core/duration";
import { GrainCallAbortedError } from "@thresh/core/errors";
import type { Logger } from "@thresh/core/logger";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import type { IDatastoreGrain } from "./i-datastore-grain";
import { IDatastoreWatcher } from "./i-datastore-watcher";

/**
 * Ported from Spiceport `src/Spiceport.Server/Datastore/LogWatchHub.cs`.
 *
 * A per-silo notifier that lets every `GrainBackedDatastore.watch` stream on the silo learn when
 * the datastore head advances WITHOUT each stream polling the grain on its own timer. The primary
 * signal is PUSH: the hub registers itself as an {@link IDatastoreWatcher} grain observer, so a
 * commit on any silo notifies it directly; in addition the local write path pulses it on commit
 * (zero-hop same-silo latency). Because observer delivery is best-effort (non-durable references,
 * dropped on grain reactivation), ONE slow background loop per silo calls
 * `IDatastoreGrain.subscribeWatch` as a combined heartbeat: it refreshes the registration,
 * resubscribes after grain reactivation, and pulses the returned head - so a missed push costs at
 * most one heartbeat of latency, never a lost event. Streams await the signal and then pull their
 * own diffs from the log (`IDatastoreLog.readFrom`) from their own cursor - so the per-stream cost
 * is one log-tail read per change, never a full-state fetch and never a private timer.
 *
 * The SAME channel also propagates schema changes to this silo's live schema provider (the
 * constructor's `applySchema` callback): a `writeSchema` commit anywhere in the cluster pushes
 * `IDatastoreWatcher.schemaAdvanced` to every registered hub, and the heartbeat's
 * `subscribeWatch` reply carries the CURRENT stored schema hash (`DatastoreHeadWire.schemaHash`)
 * as the same missed-push backstop - a hash mismatch against the last one applied triggers one
 * `IDatastoreGrain.readSchemaAt` fetch to repair it. Without this, a silo that never ran the
 * WriteSchema RPC itself would keep serving its stale `ISchemaProvider.current` forever (a live
 * wrong-verdict divergence, not just added latency).
 *
 * Port decisions:
 *   * `lock (_lock)` COLLAPSES: JavaScript is single-threaded, so a synchronous block that
 *     contains no await is already atomic. The blocks are kept as synchronous units precisely so
 *     no future edit can slip an await into one.
 *   * `TaskCompletionSource` -> a `{ promise, resolve }` pair (the guide's row, and the same shape
 *     `ReferenceDatastore` uses). `RunContinuationsAsynchronously` needs no counterpart: promise
 *     continuations are always microtasks. The swap-BEFORE-complete order in `pulse` is
 *     load-bearing.
 *   * `signal.Task.WaitAsync(ct)` -> `raceSignal`, which REJECTS with `GrainCallAbortedError` -
 *     the very type `GrainBackedDatastore.watch` catches to end its stream. A flag check that
 *     merely returned would turn a cancelled wait into a spurious wake-up.
 *   * `CancellationTokenSource` -> an `AbortController`; `Task.Delay(ts, ct)` -> a `setTimeout`
 *     raced against its signal, with the timer cleared either way (an uncleared timer keeps the
 *     Node process alive).
 *   * `Task.Run(...)` -> a detached async loop whose PROMISE HANDLE IS HELD, so disposal actually
 *     stops it. An orphaned heartbeat is the Node analogue of the orphaned-host hazard CLAUDE.md
 *     forbids.
 *   * `IGrainFactory` -> `GrainFactoryAccess`, whose `createObjectReference` /
 *     `deleteObjectReference` are Thresh's `IGrainObserver` reference surface. `ClientNode`
 *     satisfies the same shape structurally.
 *   * DEVIATION - `DisposeAsync`'s `_signal.TrySetResult()` releases stragglers on the assumption
 *     that each straggler's own token is cancelled too. A straggler with a live token re-enters
 *     the loop, re-captures the SAME (now completed) signal and spins; under threads that is a hot
 *     loop, but on a single-threaded event loop it is an infinite microtask loop that starves the
 *     process. So disposal here is a RELEASING EXIT: a parked `waitForChangeAfter` RETURNS once
 *     the hub is disposed. Callers already treat a wake-up as advisory (they re-read the log), and
 *     a disposed hub will never pulse again, so returning is the only non-spinning option.
 */
export class LogWatchHub implements IDatastoreWatcher {
  /**
   * Default heartbeat cadence: a liveness backstop for missed pushes and the observer-registration
   * refresh (the grain expires registrations not refreshed within several heartbeats). A
   * deliberate 10x under `DatastoreGrain`'s 10s watcher expiry - do not drift the two apart.
   */
  private static readonly defaultHeartbeatInterval: Duration = { seconds: 1 };

  private readonly grain: IDatastoreGrain;
  private readonly grainFactory: GrainFactoryAccess;
  private readonly heartbeatIntervalMs: number;
  private readonly applySchemaCallback: ((schema: string) => void) | undefined;
  private readonly logger: Logger | undefined;
  private readonly cts = new AbortController();

  private signal: WatchSignal = newWatchSignal();
  private observedHead = 0n;
  private lastAppliedSchemaHash: string | undefined = undefined;
  private loop: Promise<void> | undefined = undefined;
  private selfRef: IDatastoreWatcher | undefined = undefined;
  private disposed = false;

  /**
   * @param grain The cluster-singleton sequencer grain this hub subscribes to.
   * @param grainFactory Used to mint this hub's own {@link IDatastoreWatcher} object reference.
   * @param heartbeatInterval Overrides the default heartbeat cadence (tests only).
   * @param applySchema Applies a pushed / heartbeat-repaired schema text to this silo's live
   * schema provider. Absent in contexts that never propagate schema changes (e.g. a hub built only
   * to observe head advances). Kept as an injected callback rather than a direct schema-provider
   * dependency: this class lives in the datastore layer and must not depend on the grains-layer
   * schema-compilation seam.
   * @param logger Optional; used only to log-and-swallow a schema apply failure.
   */
  constructor(
    grain: IDatastoreGrain,
    grainFactory: GrainFactoryAccess,
    heartbeatInterval?: Duration | undefined,
    applySchema?: ((schema: string) => void) | undefined,
    logger?: Logger | undefined,
  ) {
    this.grain = grain;
    this.grainFactory = grainFactory;
    this.heartbeatIntervalMs = durationToMs(
      heartbeatInterval ?? LogWatchHub.defaultHeartbeatInterval,
    );
    this.applySchemaCallback = applySchema;
    this.logger = logger;
  }

  /** Push delivery from the datastore grain: a commit advanced the head. */
  headAdvanced(head: bigint): Promise<void> {
    this.pulse(head);
    return Promise.resolve();
  }

  /** Push delivery from the datastore grain: a commit changed the schema. See the interface doc. */
  schemaAdvanced(schemaBytes: Uint8Array, storedHash: string): Promise<void> {
    this.applySchema(schemaBytes, storedHash);
    return Promise.resolve();
  }

  /**
   * Applies `schemaBytes` to the live schema provider, monotonically: a `storedHash` already
   * applied (by an earlier push or heartbeat) is a no-op, so a racing push and heartbeat repair can
   * never double-apply or thrash. A poison schema cannot reach here in practice (it would have
   * failed `writeSchema`'s own validation before ever committing), but the update can still throw -
   * caught and logged so a bad push can never kill the heartbeat loop or this observer callback.
   *
   * The hash is recorded BEFORE the apply runs, so a THROWING apply still marks it applied. That is
   * deliberate - it stops a poison schema being retried forever - and is not to be "fixed" into a
   * rollback.
   */
  private applySchema(schemaBytes: Uint8Array, storedHash: string): void {
    // The C# `lock` block: synchronous, no await.
    if (storedHash === this.lastAppliedSchemaHash) return;
    this.lastAppliedSchemaHash = storedHash;

    if (this.applySchemaCallback === undefined) return;

    try {
      // `Encoding.UTF8.GetString`. The bytes arrive as a Uint8Array through the observer argument,
      // so a latin1/binary-string decode would mangle every multi-byte definition name.
      this.applySchemaCallback(new TextDecoder("utf-8").decode(schemaBytes));
    } catch (error) {
      this.logger?.warn("Discarding schema apply: update failed", { storedHash, error });
    }
  }

  /** Registers the observer reference and starts the heartbeat loop on first use (idempotent). */
  ensureStarted(): void {
    if (this.loop !== undefined) return;
    if (this.selfRef === undefined)
      this.selfRef = this.grainFactory.createObjectReference<IDatastoreWatcher>(
        IDatastoreWatcher,
        this,
      );
    const selfRef = this.selfRef;
    this.loop = this.heartbeatLoop(selfRef, this.cts.signal);
  }

  /**
   * Records that the head advanced to `head` and wakes every waiter. Called by the local write path
   * on commit (instant same-silo latency), by the observer push (cross-silo commits), and by the
   * heartbeat (missed-push backstop). Monotonic, so racing sources are harmless.
   */
  pulse(head: bigint): void {
    // ONE synchronous block, no await: the swap must be complete before the prior signal resolves,
    // or a waiter woken by it could re-enter `waitForChangeAfter` and capture the very signal that
    // has already completed.
    if (head <= this.observedHead) return;
    this.observedHead = head;
    const prior = this.signal;
    this.signal = newWatchSignal();
    prior.resolve();
  }

  /**
   * Completes once the observed head is known to be strictly greater than `cursor` (a new commit
   * may be visible past the cursor). Spurious wake-ups are harmless: the caller re-reads the log and
   * simply finds nothing past its cursor, then waits again.
   *
   * Also returns - see the class remarks - once the hub is disposed.
   */
  async waitForChangeAfter(cursor: bigint, signal?: AbortSignal | undefined): Promise<void> {
    for (;;) {
      if (this.observedHead > cursor) return;
      if (this.disposed) return;
      const current = this.signal;
      await raceSignal(current.promise, signal);
    }
  }

  /** Cheap pre-check so the heartbeat only pays a `readSchemaAt` hop when the hash actually moved. */
  private needsApply(storedHash: string): boolean {
    return storedHash !== this.lastAppliedSchemaHash;
  }

  private async heartbeatLoop(selfRef: IDatastoreWatcher, ct: AbortSignal): Promise<void> {
    while (!ct.aborted) {
      try {
        // One hop doing four jobs: refresh the observer registration (so it never expires while
        // this hub lives), resubscribe after a grain reactivation dropped it, read the head as the
        // missed-push backstop, and - the schema counterpart of that same backstop - compare the
        // reply's current stored schema hash against the last one applied. Racing each call against
        // the token makes cancellation unblock the await IMMEDIATELY even if the grain call is
        // in-flight (e.g. the silo is shutting down), so disposal never waits on a hung hop.
        const reply = await raceSignal(this.grain.subscribeWatch(selfRef), ct);
        this.pulse(reply.head);

        const schemaHash = reply.schemaHash;
        if (schemaHash !== undefined && this.needsApply(schemaHash)) {
          // A missed `schemaAdvanced` push (or a hub that only just started, and so never saw the
          // original commit's push at all): fetch the bytes at head and apply them. This is the one
          // place the hub reads schema bytes itself rather than being handed them - the heartbeat
          // has no push payload to fall back on, only the hash.
          const bytes = await raceSignal(this.grain.readSchemaAt(reply.head), ct);
          if (bytes !== undefined) this.applySchema(bytes, schemaHash);
        }

        await delay(this.heartbeatIntervalMs, ct);
      } catch (error) {
        if (error instanceof GrainCallAbortedError) return; // Normal shutdown.
        // The grain may be momentarily unavailable (membership change, deactivation). Back off and
        // retry; a transient failure must not tear down every Watch stream on the silo.
        try {
          await delay(this.heartbeatIntervalMs, ct);
        } catch {
          return;
        }
      }
    }
  }

  /**
   * Stops the heartbeat, deregisters and releases the observer reference, and releases parked
   * waiters. Every step is best-effort: disposal runs at container teardown, possibly AFTER the
   * runtime has already stopped, and must never throw and never stall.
   *
   * The C# is `IAsyncDisposable.DisposeAsync`; this repo's TypeScript target has no
   * `Symbol.asyncDispose`, so callers wrap in `try { ... } finally { await hub.dispose(); }`.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cts.abort();

    const loop = this.loop;
    if (loop !== undefined) {
      // The loop observes cancellation between/within hops and exits promptly; bound the wait
      // anyway so a pathological in-flight hop can never deadlock silo teardown.
      await bounded(loop, 5_000);
    }

    // Best-effort deregistration (expiry would drop it anyway) + release of the reference.
    const selfRef = this.selfRef;
    if (selfRef !== undefined) {
      try {
        await bounded(this.grain.unsubscribeWatch(selfRef), 2_000);
      } catch {
        // The registration expires on its own; never let teardown fail on it.
      }

      try {
        this.grainFactory.deleteObjectReference(selfRef);
      } catch {
        // Deleting an object reference against a stopped runtime can throw. The reference dies
        // with the runtime anyway, so this stays inside the same bounded best-effort teardown
        // discipline as the unsubscribe above: never throw, never stall.
      }
    }

    // Release any straggler parked on the signal; `disposed` makes them EXIT rather than re-park.
    this.signal.resolve();
  }
}

/** A `TaskCompletionSource`-alike: a promise plus its resolver, swapped wholesale on every pulse. */
interface WatchSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function newWatchSignal(): WatchSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** `Task.Delay(ts, ct)`: a timer whose wait is abandoned (as a rejection) when the token fires. */
function delay(milliseconds: number, ct: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sleep = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return raceSignal(sleep, ct).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * `Task.WhenAny(work, Task.Delay(ms))` - and `task.WaitAsync(timeout)`, whose only difference is
 * that it throws on expiry, which every call site here wraps in a catch anyway. The timer is
 * cleared on the normal path so a bounded wait never keeps the process alive.
 */
function bounded<T>(work: Promise<T>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return Promise.race([work.then(() => undefined), expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
