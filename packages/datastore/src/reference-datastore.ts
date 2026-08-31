import { randomUUID } from "node:crypto";

import type { IRevision } from "@benedb/core/i-revision";
import type { IRevisionParser } from "@benedb/core/i-revision-parser";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import type { Duration } from "@thresh/core/duration";
import { durationToMs } from "@thresh/core/duration";

import {
  InvalidRevisionException,
  RevisionNotFoundException,
  SerializationException,
} from "./datastore-exceptions";
import {
  changesAt,
  emptyDatastoreState,
  schemaChangedAt,
  schemaHashAt,
  type DatastoreState,
} from "./datastore-state";
import type {
  IDatastore,
  IDatastoreReader,
  IReadWriteTransaction,
  RevisionWithSchemaHash,
} from "./i-datastore";
import { MvccReadWriteTransaction } from "./mvcc-read-write-transaction";
import { MvccSnapshotReader } from "./mvcc-snapshot-reader";
import { TimestampRevisionParser } from "./timestamp-revision-parser";
import { watchOptionsContent, WatchContent, type RevisionChange, type WatchOptions } from "./watch";

const NANOS_PER_MILLISECOND = 1_000_000n;

/**
 * The datastore's revision clock, in nanoseconds since the Unix epoch.
 *
 * THE RISKIEST CLOCK DECISION IN THIS FILE. The C# is `(UtcNow - UnixEpoch).Ticks * 100`, i.e.
 * 100ns resolution. JavaScript has no epoch-nanosecond clock at all - `Date.now()` is
 * milliseconds and `performance.now()` is not epoch-based - so the port samples milliseconds and
 * scales. The consequence is that two commits inside the same millisecond sample the SAME now and
 * separate only through `nextRevision`'s `lastRevision + 1` monotonic bump, which therefore fires
 * far more often here than in the C#. That is correct - revisions need only be monotonically
 * increasing - but it means nothing may assume a revision's magnitude tracks wall-clock closely
 * at sub-millisecond scale.
 */
function nowNanos(): bigint {
  return BigInt(Date.now()) * NANOS_PER_MILLISECOND;
}

/**
 * A `TaskCompletionSource`-alike: a promise plus its resolver, swapped wholesale on every commit.
 * `RunContinuationsAsynchronously` needs no counterpart - promise continuations are always
 * scheduled as microtasks.
 */
interface CommitSignal {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function newCommitSignal(): CommitSignal {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Waits for the next commit or for `signal` to abort, whichever comes first. Returns true if the
 * wait ended because of the abort.
 *
 * The C# is `Task.WhenAny(signal.Task, Task.Delay(Timeout.Infinite, ct))`. The port must not use
 * `raceSignal`, which REJECTS on abort - the C# treats cancellation as a clean `yield break`, not
 * a throw. It leaves no timer behind and the abort listener is removed on the normal path, so
 * neither a dangling timer nor an unhandled rejection survives the end of a watch.
 */
function waitForCommitOrAbort(
  commit: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal === undefined) return commit.then(() => false);
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const onAbort = (): void => {
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void commit.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    });
  });
}

/**
 * The revision's type name for the unsupported-revision message.
 *
 * The C# reads `revision.GetType().Name`. `constructor.name` is minification-fragile, and
 * `IRevision` carries no stable type brand, so the shape of the message is preserved while its
 * exactness is not depended on anywhere.
 */
function revisionTypeName(revision: IRevision): string {
  const ctor = (revision as { constructor?: { readonly name?: string } }).constructor;
  return ctor?.name ?? "unknown";
}

function toNanos(revision: IRevision): bigint {
  if (revision instanceof TimestampRevision) return revision.timestampNanosSinceEpoch;
  throw new InvalidRevisionException(`unsupported revision type: ${revisionTypeName(revision)}`);
}

function buildChange(
  state: DatastoreState,
  revision: bigint,
  options: WatchOptions,
): RevisionChange | undefined {
  const rev = new TimestampRevision(revision);
  const content = watchOptionsContent(options);
  const includeRels = (content & WatchContent.relationships) !== 0;
  const includeSchema = (content & WatchContent.schema) !== 0;

  const relChanges = includeRels ? changesAt(state, revision) : [];
  const schemaChanged = includeSchema && schemaChangedAt(state, revision);

  // Suppress empty checkpoints: only emit a revision that actually carries requested content.
  if (relChanges.length === 0 && !schemaChanged) return undefined;

  return { revision: rev, relationshipChanges: relChanges, schemaChanged };
}

/**
 * The reference model: an independent, executable specification of the MVCC semantics, used by
 * conformance and engine tests: an in-memory MVCC implementation deliberately NOT built from the
 * event-sourced datastore-grain path, so the two can disagree and catch bugs. It is not a
 * deployable backend. Revisions are monotonically increasing nanosecond timestamps. Each committed
 * transaction produces a new immutable `DatastoreState`; snapshot readers capture a state
 * reference and read correctly regardless of subsequent writes.
 *
 * THE LOCKS ARE GONE. The C# serializes writes with `lock (_writeLock)`, which guards state shared
 * between CALLERS rather than grain state - so the port had to verify, not assume, that every lock
 * body is fully synchronous. It is: `SnapshotReader`, `HeadRevision`, `OptimizedRevision`,
 * `CheckRevision`, `Watch`'s snapshot block and BOTH halves of `ReadWriteTx` contain no `await`,
 * so on a single-threaded event loop each is already atomic and the locks simply disappear.
 *
 * What still bites is the serialization check, because the user callback is awaited BETWEEN the
 * two critical sections of `readWriteTx` and another transaction can interleave exactly there.
 * That check is a REFERENCE comparison (`current !== baseState`) and must stay one: a deep
 * equality would call two structurally-identical states equal and stop catching anything.
 */
export class ReferenceDatastore implements IDatastore {
  /**
   * `Guid.NewGuid().ToString("n")` - 32 lowercase hex digits with NO dashes. The format is
   * wire-visible: it feeds ZedToken encoding.
   */
  private readonly uniqueId: string = randomUUID().replace(/-/g, "");
  private readonly quantizationNanos: bigint;
  private readonly gcWindowNanos: bigint;

  private lastRevision: bigint;
  private current: DatastoreState;

  // Cached optimized-revision candidate (SpiceDB's CachedOptimizedRevisions): a real head snapshot
  // held stable for the quantization window so near-in-time minimize-latency checks share a single
  // revision - and therefore a single cache key.
  private optimizedCache: RevisionWithSchemaHash | undefined = undefined;
  private optimizedValidThroughNanos = 0n;

  // Ordered list of revisions that have been committed by a write transaction (the changefeed).
  // The datastore's initial empty revision is not a write and is not listed. Used by watch to
  // enumerate which revisions carry changes after a cursor. Pruned in lockstep with the GC window
  // on each commit: a revision older than (head - gcWindow) can no longer be a valid watch cursor
  // (`isRevisionValid` rejects it), so retaining it only grows the list unbounded and slows the
  // per-poll re-scan.
  private committedRevisions: readonly bigint[] = [];

  // A signal resolved whenever a new revision commits, so live watch tailers wake without polling.
  // Swapped on every commit; waiters capture the current instance before re-checking.
  private commitSignal: CommitSignal = newCommitSignal();

  /**
   * Creates an in-memory datastore.
   *
   * @param quantization Quantization window for `optimizedRevision` (default 5s).
   * @param gcWindow How long old revisions remain valid (default 24h). Snapshots before this
   * window are rejected.
   *
   * The C# TRUNCATES to whole milliseconds before scaling (`(long)ts.TotalMilliseconds *
   * 1_000_000`), so a sub-millisecond quantization quantizes to 0 and takes the disabled branch,
   * and `TimeSpan.Zero` - `{ ms: 0 }` here - keeps meaning "no quantization" / "zero-width GC
   * window" rather than falling back to the default.
   */
  constructor(quantization?: Duration | undefined, gcWindow?: Duration | undefined) {
    this.quantizationNanos =
      BigInt(Math.trunc(durationToMs(quantization ?? { seconds: 5 }))) * NANOS_PER_MILLISECOND;
    this.gcWindowNanos =
      BigInt(Math.trunc(durationToMs(gcWindow ?? { hours: 24 }))) * NANOS_PER_MILLISECOND;
    this.lastRevision = nowNanos();
    this.current = emptyDatastoreState(this.lastRevision);
  }

  /** @inheritdoc */
  snapshotReader(revision: IRevision): IDatastoreReader {
    const rev = toNanos(revision);
    if (!this.isRevisionValid(rev)) throw new RevisionNotFoundException(revision);
    const state = this.current;
    return new MvccSnapshotReader(state, rev, (r) => this.isRevisionValid(r));
  }

  /** @inheritdoc */
  headRevision(_signal?: AbortSignal | undefined): Promise<RevisionWithSchemaHash> {
    const head = this.current.headRevision;
    return Promise.resolve({
      revision: new TimestampRevision(head),
      schemaHash: schemaHashAt(this.current, head),
    });
  }

  /** @inheritdoc */
  optimizedRevision(_signal?: AbortSignal | undefined): Promise<RevisionWithSchemaHash> {
    // SpiceDB's optimized revision (revisions/optimized.go CachedOptimizedRevisions) is a CACHED
    // candidate: the real HEAD revision sampled when a window opens, then returned UNCHANGED for
    // the whole quantization window. It is a genuine committed snapshot (never floored BELOW head,
    // so minimize-latency never silently drops already-committed writes) AND it is stable for the
    // window so near-in-time checks share it. Crucially this exact value is used as BOTH the read
    // snapshot AND the cache key's atRevision (the key is NOT separately time-floored): all
    // requests in one window read at, and key by, the SAME cached head, so a write that advances
    // head mid-window cannot be served an older-snapshot result under a colliding bucket.
    const now = nowNanos();
    let cached = this.optimizedCache;
    if (
      this.quantizationNanos <= 0n ||
      cached === undefined ||
      now >= this.optimizedValidThroughNanos
    ) {
      const head = this.current.headRevision;
      cached = {
        revision: new TimestampRevision(head),
        schemaHash: schemaHashAt(this.current, head),
      };
      if (this.quantizationNanos > 0n) {
        // The disabled (<= 0) path refreshes the local and deliberately does NOT store it.
        this.optimizedCache = cached;
        // Hold this candidate until the end of the current bucket window so the cached value
        // aligns to a stable boundary that is shared across the mesh. `now` is positive, so the
        // bigint `%` truncating toward zero is the floor.
        this.optimizedValidThroughNanos =
          now - (now % this.quantizationNanos) + this.quantizationNanos;
      }
    }
    return Promise.resolve(cached);
  }

  /** @inheritdoc */
  async readWriteTx(
    transaction: (tx: IReadWriteTransaction) => Promise<void>,
    _signal?: AbortSignal | undefined,
  ): Promise<IRevision> {
    const baseState = this.current;
    const newRevision = this.nextRevision();

    const tx = new MvccReadWriteTransaction(baseState, newRevision);
    await transaction(tx);

    // REFERENCE comparison, never a deep equal - see the class remarks.
    if (this.current !== baseState) throw new SerializationException();
    this.current = tx.commit();
    this.committedRevisions = this.pruneExpiredRevisions(
      [...this.committedRevisions, newRevision],
      newRevision,
    );
    // Wake any live watch tailers, then arm a fresh signal for the next commit.
    const signal = this.commitSignal;
    this.commitSignal = newCommitSignal();
    signal.resolve();

    return new TimestampRevision(newRevision);
  }

  /** @inheritdoc */
  checkRevision(revision: IRevision, _signal?: AbortSignal | undefined): Promise<boolean> {
    return Promise.resolve(this.isRevisionValid(toNanos(revision)));
  }

  /**
   * @inheritdoc
   *
   * An async generator, so the `RevisionNotFoundException` below fires on the FIRST ITERATION and
   * not at call time - exactly as the C# iterator method does. Do not "improve" it into an eager
   * validate-then-return-a-generator.
   */
  async *watch(
    afterRevision: IRevision,
    options: WatchOptions,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<RevisionChange> {
    // The C# `ArgumentNullException.ThrowIfNull` guards, kept even though the TypeScript types are
    // non-optional: the caller may be untyped.
    if (afterRevision === undefined || afterRevision === null)
      throw new InvalidArgumentError("afterRevision must not be null");
    if (options === undefined || options === null)
      throw new InvalidArgumentError("options must not be null");

    let cursor = toNanos(afterRevision);
    // Cannot resume from a revision older than the retained GC window.
    if (!this.isRevisionValid(cursor)) throw new RevisionNotFoundException(afterRevision);

    while (signal?.aborted !== true) {
      // Snapshot the state to read changes from, the revisions committed after the cursor, and the
      // signal to await if there is nothing new. In the C# all three are taken under one lock,
      // which makes the "check then wait" race-free; here the same three reads are one synchronous
      // run of the event loop, which gives the identical guarantee: any commit after this point
      // either is in our list, or will resolve the signal we captured.
      const state = this.current;
      const commitSignal = this.commitSignal;
      const pending: bigint[] = [];
      for (const rev of this.committedRevisions) {
        if (rev > cursor) pending.push(rev);
      }

      // pending is already in ascending order (revisions are appended monotonically).
      for (const rev of pending) {
        const change = buildChange(state, rev, options);
        if (change !== undefined) yield change;
        cursor = rev;
      }

      // When checkpoints are requested, emit one after the batch so a consumer watching only a
      // subset of content still observes that the revision advanced. Mirrors SpiceDB's watch
      // checkpoint emission (postgres watch.go:184-194; memdb behaves equivalently).
      if (pending.length > 0 && (watchOptionsContent(options) & WatchContent.checkpoints) !== 0) {
        yield {
          revision: new TimestampRevision(cursor),
          relationshipChanges: [],
          schemaChanged: false,
          isCheckpoint: true,
        };
      }

      if (pending.length === 0) {
        // Nothing new: wait for the next commit or cancellation.
        const aborted = await waitForCommitOrAbort(commitSignal.promise, signal);
        if (aborted) return;
      }
    }
  }

  /** @inheritdoc */
  getUniqueId(_signal?: AbortSignal | undefined): Promise<string> {
    return Promise.resolve(this.uniqueId);
  }

  /** @inheritdoc */
  getRevisionParser(_signal?: AbortSignal | undefined): Promise<IRevisionParser> {
    return Promise.resolve(new TimestampRevisionParser(this.uniqueId));
  }

  /** @inheritdoc */
  close(): Promise<void> {
    return Promise.resolve();
  }

  // --- internals ---

  private nextRevision(): bigint {
    const now = nowNanos();
    const next = now > this.lastRevision ? now : this.lastRevision + 1n;
    this.lastRevision = next;
    return next;
  }

  /**
   * Drops changefeed entries that have fallen out of the GC window. A revision STRICTLY BELOW the
   * GC floor (head - gcWindow) can never again be a valid watch cursor, so it carries no
   * information for any future tailer and is safe to discard. The list stays in ascending order,
   * so the survivors are a contiguous suffix.
   */
  private pruneExpiredRevisions(revisions: readonly bigint[], head: bigint): readonly bigint[] {
    const floor = head - this.gcWindowNanos;
    let firstKept = 0;
    while (firstKept < revisions.length && revisions[firstKept]! < floor) firstKept++;
    return firstKept === 0 ? revisions : revisions.slice(firstKept);
  }

  /** `rev <= head && rev >= head - gcWindow`; the subtraction may go negative, which is fine. */
  private isRevisionValid(rev: bigint): boolean {
    if (rev > this.current.headRevision) return false;
    return rev >= this.current.headRevision - this.gcWindowNanos;
  }
}
