import type { IRevision } from "@spacedb/core/i-revision";
import type { IRevisionParser } from "@spacedb/core/i-revision-parser";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import type { RegisteredCounter } from "@spacedb/datastore/counters";
import {
  InvalidRevisionException,
  RevisionNotFoundException,
  SerializationException,
} from "@spacedb/datastore/datastore-exceptions";
import type { DatastoreState } from "@spacedb/datastore/datastore-state";
import type {
  IDatastore,
  IDatastoreReader,
  IReadWriteTransaction,
  RevisionWithSchemaHash,
} from "@spacedb/datastore/i-datastore";
import { MvccReadWriteTransaction } from "@spacedb/datastore/mvcc-read-write-transaction";
import { MvccSnapshotReader } from "@spacedb/datastore/mvcc-snapshot-reader";
import type { RelationshipsFilter, SubjectsFilter } from "@spacedb/datastore/relationships-filter";
import type { ReverseQueryOptions } from "@spacedb/datastore/reverse-query-options";
import { TimestampRevisionParser } from "@spacedb/datastore/timestamp-revision-parser";
import {
  watchOptionsContent,
  WatchContent,
  type RevisionChange,
  type WatchOptions,
} from "@spacedb/datastore/watch";
import { durationToMs, type Duration } from "@thresh/core/duration";
import { GrainCallAbortedError } from "@thresh/core/errors";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import type { CommitRequest } from "./commit-contract";
import { datastoreHeadWireGcFloor } from "./datastore-dtos";
import type { DatastoreGcOptions } from "./datastore-gc-options";
import { toMemoryState } from "./datastore-state-converters";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import type { LogEvent } from "./log-event";
import { eventFromState } from "./log-event-factory";
import type { LogWatchHub } from "./log-watch-hub";
import { stateCovering } from "./sequencer-state-fetch";
import { toUpdate } from "./wire-convert";

const NANOS_PER_MILLISECOND = 1_000_000n;

/**
 * The datastore's revision clock, in nanoseconds since the Unix epoch.
 *
 * The C# is `(UtcNow - UnixEpoch).Ticks * 100`, i.e. 100ns resolution. JavaScript has no
 * epoch-nanosecond clock - `Date.now()` is milliseconds and `performance.now()` is not epoch-based
 * - so this samples milliseconds and scales, EXACTLY as `ReferenceDatastore` already does (the two
 * mint revisions into the same conformance corpus, so they must not diverge in resolution). The
 * consequence: two commits inside one millisecond mint the same `now`, and separate through the
 * `expectedHead + 1n` branch below far more often than in the C#. Still monotonic, hence still
 * correct; nothing may assume a revision's magnitude tracks wall-clock at sub-millisecond scale.
 */
function nowNanos(): bigint {
  return BigInt(Date.now()) * NANOS_PER_MILLISECOND;
}

/**
 * The revision's type name for the unsupported-revision message, matching `ReferenceDatastore`'s
 * port of the same `revision.GetType().Name`.
 */
function revisionTypeName(revision: IRevision): string {
  const ctor = (revision as { constructor?: { readonly name?: string } }).constructor;
  return ctor?.name ?? "unknown";
}

function toNanos(revision: IRevision): bigint {
  if (revision instanceof TimestampRevision) return revision.timestampNanosSinceEpoch;
  throw new InvalidRevisionException(`unsupported revision type: ${revisionTypeName(revision)}`);
}

/**
 * `(long)(ts.TotalMilliseconds) * 1_000_000L` - the cast TRUNCATES fractional milliseconds BEFORE
 * scaling, so a sub-millisecond quantization quantizes to 0 and takes the disabled branch, and a
 * zero duration keeps meaning "no quantization" / "zero-width GC window" rather than falling back
 * to the default. A mechanical `ms * 1_000_000n` on a fractional value would be wrong.
 */
function toTruncatedNanos(duration: Duration): bigint {
  return BigInt(Math.trunc(durationToMs(duration))) * NANOS_PER_MILLISECOND;
}

function computeQuantizationNanos(quantization: Duration | undefined): bigint {
  return toTruncatedNanos(quantization ?? { seconds: 5 });
}

function computeGcWindowNanos(
  gcWindow: Duration | undefined,
  gcOptions: DatastoreGcOptions | undefined,
): bigint {
  return toTruncatedNanos(gcWindow ?? gcOptions?.window ?? { hours: 24 });
}

/**
 * Ported from Spiceport `src/Spiceport.Server/Datastore/GrainBackedDatastore.cs`.
 *
 * An {@link IDatastore} that delegates all state to the cluster-singleton {@link IDatastoreGrain}
 * (the single source of truth) and reuses the in-memory MVCC mechanics
 * (`MvccReadWriteTransaction`, `MvccSnapshotReader`, the `DatastoreState` fold) by converting the
 * grain wire state to/from the in-memory state. Snapshot reads fetch the sequencer's materialized
 * state (`IDatastoreGrain.readState`) once per reader; the engines' per-Check graph reads do NOT
 * come through here - they go through the `IGraphReaderSource` shard mesh (`ShardedGraphReader`).
 * What remains on this facade is revision resolution (head/optimized/check), token minting, Watch,
 * and the compatibility write path ({@link GrainBackedDatastore.readWriteTx}) that
 * tests/BulkImport/SeedData drive. Writes use an optimistic compare-and-swap retry loop.
 *
 * This instance never owns the per-silo {@link LogWatchHub} it pulses and parks Watch streams on;
 * the hub is a per-silo singleton whose lifetime belongs to the container that registered it, which
 * disposes it on silo teardown. This type therefore has nothing of its own to dispose.
 *
 * Port decisions:
 *   * `IGrainFactory` -> Thresh's `GrainFactoryAccess`.
 *   * `IOptions<DatastoreGcOptions>` -> the plain `DatastoreGcOptions` record. Thresh has no
 *     `Microsoft.Extensions.Options`, and the guide's options row is a plain injected value; the
 *     precedence (`gcWindow` beats `gcOptions.window` beats 24h) is preserved exactly.
 *   * `lock (_optLock)` and `Volatile.Read` / `InterlockedMax` COLLAPSE: JavaScript is
 *     single-threaded, so a synchronous block is atomic and a plain read/write is a volatile one.
 *     `_observedCommittedHead` still needs its monotonic MAX, because two `readWriteTx` calls DO
 *     interleave at their awaits and may complete out of revision order.
 *   * `ConfigureAwait(false)` has no counterpart and is dropped throughout (the guide's row).
 */
export class GrainBackedDatastore implements IDatastore {
  /** Bound on CAS retries before surfacing a serialization conflict. */
  private static readonly maxCasAttempts = 50;

  /** Log-tail page size for the Watch changefeed. */
  private static readonly watchBatchSize = 256;

  /**
   * A stable, cluster-wide datastore id. It must be identical on every silo so a token minted on
   * one silo decodes Valid on another (a per-instance uuid would make every cross-silo token
   * mismatch). There is exactly one logical datastore (the singleton grain), so a fixed id is
   * correct - it is a CONSTANT, never generated.
   */
  private static readonly uniqueId = "grain-backed-datastore";

  private readonly grainFactory: GrainFactoryAccess;
  private readonly quantizationNanos: bigint;
  private readonly gcWindowNanos: bigint;

  // Per-silo Watch notifier. The local write path pulses it on commit for instant same-silo Watch
  // latency; cross-silo commits arrive by observer push from the datastore grain, with the hub's
  // slow heartbeat as the missed-push backstop. The container owns its lifecycle (see the class
  // remarks).
  private readonly hub: LogWatchHub;

  // Cached optimized-revision candidate (mirrors ReferenceDatastore's CachedOptimizedRevisions): a
  // real head sampled when a window opens, held stable until the bucket boundary so near-in-time
  // minimize-latency checks WITHIN THIS SILO share one revision (and therefore one dispatch cache
  // key). NOTE: this cache is per-silo, so two silos can sample the grain head at slightly
  // different times in the same window and key under different revisions - bounded min-latency
  // staleness, never a stale-under-fresh-token serve (each value is a real committed head).
  // Cross-mesh parity would need a quantized getHead on the grain; left as a later optimization.
  private optimizedCache: RevisionWithSchemaHash | undefined = undefined;
  private optimizedValidThroughNanos = 0n;

  // The freshest committed head THIS instance has observed (its own successful commits). A stale
  // duplicate activation of the sequencer during membership churn can serve a readState below it,
  // and a write base folded from such a state would violate read-your-writes (the lambda would
  // stage against a snapshot missing this instance's own committed writes). The base fetch gates on
  // it via `stateCovering` - the closed-timestamp gate, formerly the projection watermark wait.
  private observedCommittedHead = 0n;

  /**
   * Creates a grain-backed datastore over the cluster-singleton datastore grain, sharing the
   * per-silo `hub` for Watch wake-ups. This instance never owns the hub's lifetime; see the class
   * remarks.
   *
   * @param grainFactory The grain factory used to reach the singleton datastore grain.
   * @param hub The per-silo Watch notifier (a singleton the container disposes).
   * @param quantization Quantization window for {@link GrainBackedDatastore.optimizedRevision}
   * (default 5s).
   * @param gcWindow How long old revisions remain valid. Takes priority over `gcOptions` when
   * supplied (a test seam for pinning an exact value); otherwise falls back to `gcOptions.window`,
   * and only defaults to 24h when neither is given. This MUST track the same
   * `DatastoreGcOptions.window` the singleton `DatastoreGrain` was configured with - that value is
   * what actually drives the grain's real GC floor - so a caller that configures a non-default
   * window for the grain must pass the SAME options here. A mismatched, independently-hardcoded
   * window would wrongly reject (or wrongly accept) a still-valid revision relative to the real
   * per-host retention policy.
   * @param gcOptions The same `DatastoreGcOptions` the singleton `DatastoreGrain` is configured
   * with. Optional so a host/test that never registers it still gets the 24h default.
   */
  constructor(
    grainFactory: GrainFactoryAccess,
    hub: LogWatchHub,
    quantization?: Duration | undefined,
    gcWindow?: Duration | undefined,
    gcOptions?: DatastoreGcOptions | undefined,
  ) {
    // The C# `ArgumentNullException.ThrowIfNull` guards, kept even though the TypeScript types are
    // non-optional: the caller may be untyped.
    if (grainFactory === undefined || grainFactory === null)
      throw new InvalidArgumentError("grainFactory must not be null");
    if (hub === undefined || hub === null) throw new InvalidArgumentError("hub must not be null");

    this.grainFactory = grainFactory;
    this.quantizationNanos = computeQuantizationNanos(quantization);
    this.gcWindowNanos = computeGcWindowNanos(gcWindow, gcOptions);
    this.hub = hub;
  }

  private get grain(): IDatastoreGrain {
    return this.grainFactory.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
  }

  /** @inheritdoc */
  snapshotReader(revision: IRevision): IDatastoreReader {
    const rev = toNanos(revision);
    // The (async) state acquisition defers to the first read; every subsequent query is served
    // in-process via one MvccSnapshotReader over the sequencer's materialized state
    // (IDatastoreGrain.readState - a full-state fetch, deliberately: this reader serves
    // snapshot-wide reads such as the fold-equivalence oracle and BulkExport, never the per-Check
    // hot path, which goes through the IGraphShardGrain mesh). The state is at the grain's
    // confirmed head, which is at or past any resolvable pinned revision (revisions are minted by
    // the grain and confirmed before their token exists), and MVCC row visibility makes the head
    // state exact for any retained pinned revision.
    //
    // GC-floor rejection (MvccSnapshotReader's ctor guard) is enforced from the FETCHED state's own
    // floor, which always carries the sequencer's current floor, so a below-floor pin is rejected
    // on the reader's first query.
    //
    // Closed-timestamp gate on the fetch itself: a stale duplicate activation during membership
    // churn can serve an old head, and a reader pinned at R must never be built over state whose
    // head < R (rows committed at or below R could be silently missing). `stateCovering` refetches
    // until the head covers the pin - the successor of the retired projection's watermark wait.
    const grain = this.grain;
    return new DeferredReader(
      async (signal) =>
        new MvccSnapshotReader(
          toMemoryState(await stateCovering(grain, rev, signal)),
          rev,
          () => true,
        ),
    );
  }

  /** @inheritdoc */
  async headRevision(_signal?: AbortSignal | undefined): Promise<RevisionWithSchemaHash> {
    const head = await this.grain.getHead();
    return { revision: new TimestampRevision(head.head), schemaHash: head.schemaHash };
  }

  /** @inheritdoc */
  async optimizedRevision(_signal?: AbortSignal | undefined): Promise<RevisionWithSchemaHash> {
    const now = nowNanos();
    {
      const cached = this.optimizedCache;
      if (
        this.quantizationNanos > 0n &&
        cached !== undefined &&
        now < this.optimizedValidThroughNanos
      )
        return cached;
    }

    // Cache miss: sample the real head from the grain (the await is OUTSIDE the synchronous blocks).
    const head = await this.grain.getHead();
    const sampled: RevisionWithSchemaHash = {
      revision: new TimestampRevision(head.head),
      schemaHash: head.schemaHash,
    };
    // Recompute now AFTER the grain hop so the window boundary is not skewed past its bucket by hop
    // latency (ReferenceDatastore samples with no intervening await).
    const nowAfter = nowNanos();

    // Re-check: another caller may have populated an in-window candidate while we fetched (the
    // await above IS a real interleave point even without threads). Keep it so all callers in one
    // window (within this silo) share a single value.
    const cached = this.optimizedCache;
    if (
      this.quantizationNanos > 0n &&
      cached !== undefined &&
      nowAfter < this.optimizedValidThroughNanos
    )
      return cached;
    if (this.quantizationNanos > 0n) {
      this.optimizedCache = sampled;
      this.optimizedValidThroughNanos =
        nowAfter - (nowAfter % this.quantizationNanos) + this.quantizationNanos;
    }
    return sampled;
  }

  /** @inheritdoc */
  async readWriteTx(
    transaction: (tx: IReadWriteTransaction) => Promise<void>,
    signal?: AbortSignal | undefined,
  ): Promise<IRevision> {
    if (transaction === undefined || transaction === null)
      throw new InvalidArgumentError("transaction must not be null");

    // COMPATIBILITY PATH - honest cost note: each attempt fetches the sequencer's FULL materialized
    // state (readState) as its write base. That is acceptable because production writes are
    // declarative through IDatastoreGrain.commit (preconditions/updates/deleteByFilter evaluated at
    // the sequencer); this lambda-shaped path survives only for tests, BulkImport and SeedData,
    // where per-write cost is not a scaling concern. The grain's CAS append remains the sole
    // serialization point.
    for (let attempt = 0; ; attempt++) {
      // 1. Fetch the write base. readState returns the grain's confirmed fold, so its headRevision
      //    is the freshest committed head this attempt can observe; taking expectedHead from the
      //    SAME state keeps the CAS and the diff base exactly in agreement. Read-your-writes across
      //    successive calls on this same instance holds because the grain's commit only returns
      //    after it has confirmed the new head, so the next attempt's readState observes it. The
      //    fetch is gated on the freshest head this instance has itself committed (see
      //    `observedCommittedHead`): a stale duplicate activation during membership churn must not
      //    hand us a base missing our own writes.
      const baseState = toMemoryState(
        await stateCovering(this.grain, this.observedCommittedHead, signal),
      );
      const expectedHead = baseState.headRevision;

      // 2. Mint a provisional revision monotonically over the observed head (mirrors
      //    ReferenceDatastore). This revision pins the local tx so the staged view and
      //    preconditions are evaluated at a fixed point; the grain mints the AUTHORITATIVE revision
      //    when it appends the event.
      const now = nowNanos();
      const newRevision = now > expectedHead ? now : expectedHead + 1n;

      // 3. Run the caller lambda over an in-memory tx pinned to this base. Preconditions and
      //    schema-change validation read the tx reader (the staged view over the snapshot). Any
      //    exception thrown by the lambda (create-conflict, precondition, schema-validation, counter
      //    conflict) propagates AS-IS and aborts the whole call - it is NOT a retry.
      const tx = new MvccReadWriteTransaction(baseState, newRevision);
      await transaction(tx);

      // 4. Derive the declarative commit from the committed state: the net relationship/schema/
      //    counter diff at this revision (reusing the single per-revision diff definition). The
      //    grain re-mints the revision and stamps it, so the request carries no final revision.
      const committed = tx.commit();
      const request = commitFromState(committed, newRevision, expectedHead);

      // 5. Submit to the sequencer's commit with the compatibility CAS (expectedHead): applies only
      //    if the grain head still equals expectedHead. No preconditions ride along - the lambda
      //    already evaluated its own reads client-side against this exact base, and the expectedHead
      //    compare keeps them race-free. Returns the AUTHORITATIVE revision the grain minted.
      const reply = await this.grain.commit(request);
      const revision = reply.revision;
      if (revision !== undefined) {
        // Record our own committed head so the next call's base fetch cannot be served below it
        // (read-your-writes across calls on this instance). Monotonic max under interleaving.
        if (revision > this.observedCommittedHead) this.observedCommittedHead = revision;
        // Wake any local Watch stream immediately (same-silo commits skip the poll latency).
        this.hub.pulse(revision);
        return new TimestampRevision(revision);
      }

      // Anything other than a lost CAS is unexpected on this path: the lambda staged every guarded
      // operation client-side against the very base the expectedHead pins, so the grain's
      // re-execution can only reach the same outcome. Surface it loudly rather than retry.
      const failure = reply.failure;
      if (failure !== undefined && failure.kind !== "headMoved")
        throw new Error(
          `unexpected commit failure on the compatibility write path: ${failure.kind}: ${failure.detail ?? ""}`,
        );

      // 6. Head moved under us. Reload and re-run the WHOLE lambda (so preconditions and validation
      //    re-evaluate against the new base - race-free). Bounded retries; on exhaustion surface the
      //    same exception type ReferenceDatastore throws on a concurrent write.
      if (attempt + 1 >= GrainBackedDatastore.maxCasAttempts) throw new SerializationException();
    }
  }

  /** @inheritdoc */
  async checkRevision(revision: IRevision, _signal?: AbortSignal | undefined): Promise<boolean> {
    const head = await this.grain.getHead();
    const rev = toNanos(revision);
    // The REAL GC floor is the hard bound (below it, MVCC rows are actually gone); the nominal
    // window is kept as an additional, stricter-or-equal bound for API-parity with
    // ReferenceDatastore/SpiceDB even before GC has caught up to it (e.g. right after activation,
    // when the floor is still 0).
    return (
      rev <= head.head &&
      rev >= head.head - this.gcWindowNanos &&
      rev >= datastoreHeadWireGcFloor(head)
    );
  }

  /**
   * @inheritdoc
   *
   * An async generator, so the `RevisionNotFoundException` below fires on the FIRST ITERATION and
   * not at call time - exactly as the C# iterator method does.
   */
  async *watch(
    afterRevision: IRevision,
    options: WatchOptions,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<RevisionChange> {
    if (afterRevision === undefined || afterRevision === null)
      throw new InvalidArgumentError("afterRevision must not be null");
    if (options === undefined || options === null)
      throw new InvalidArgumentError("options must not be null");

    let cursor = toNanos(afterRevision);

    // Validate the cursor against the REAL GC floor (mirror ReferenceDatastore:
    // RevisionNotFoundException). The nominal window is kept alongside it as a stricter-or-equal
    // bound for API-parity even before GC has caught up (the floor starts at 0 on a fresh
    // datastore).
    const head0 = await this.grain.getHead();
    if (!(
      cursor <= head0.head &&
      cursor >= head0.head - this.gcWindowNanos &&
      cursor >= datastoreHeadWireGcFloor(head0)
    ))
      throw new RevisionNotFoundException(afterRevision);

    this.hub.ensureStarted();

    while (signal === undefined || !signal.aborted) {
      // Pull only the changes since the cursor straight from the log (the diff), not the whole
      // state.
      const segment = await this.grain.readFrom(cursor, GrainBackedDatastore.watchBatchSize);

      if (segment.events.length > 0) {
        for (const ev of segment.events) {
          const change = buildChange(ev, options);
          if (change !== undefined) yield change;
          cursor = ev.revision;
        }

        // The checkpoint rides the revision the feed has now progressed through, so a consumer
        // filtering to a content subset still observes liveness even if nothing matched its filter.
        if ((watchOptionsContent(options) & WatchContent.checkpoints) !== 0)
          yield {
            revision: new TimestampRevision(cursor),
            relationshipChanges: [],
            schemaChanged: false,
            isCheckpoint: true,
          };

        // Drain any further already-committed events before parking on the signal.
        continue;
      }

      // Caught up: park until a commit advances the head past the cursor (a local commit pulses the
      // hub directly; cross-silo commits arrive by observer push, backstopped by the hub's
      // heartbeat). No per-stream timer.
      try {
        await this.hub.waitForChangeAfter(cursor, signal);
      } catch (error) {
        if (error instanceof GrainCallAbortedError) return;
        throw error;
      }
    }
  }

  /** @inheritdoc */
  getUniqueId(_signal?: AbortSignal | undefined): Promise<string> {
    return Promise.resolve(GrainBackedDatastore.uniqueId);
  }

  /** @inheritdoc */
  getRevisionParser(_signal?: AbortSignal | undefined): Promise<IRevisionParser> {
    return Promise.resolve(new TimestampRevisionParser(GrainBackedDatastore.uniqueId));
  }

  /**
   * A no-op: this instance owns no lifetime of its own (see the class remarks) - the shared hub
   * belongs entirely to the container it was registered in.
   */
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// --- internals ---

/**
 * Maps a single `LogEvent` to the `RevisionChange` the Watch feed emits, honoring the requested
 * content flags. Returns `undefined` when nothing in the event matches the requested content (the
 * caller still rides a checkpoint at the revision if checkpoints were requested). This is the
 * Stage-0 payload equivalence (the log carries the same per-revision diff the state-derived feed
 * produced).
 */
function buildChange(ev: LogEvent, options: WatchOptions): RevisionChange | undefined {
  const content = watchOptionsContent(options);
  const includeRels = (content & WatchContent.relationships) !== 0;
  const includeSchema = (content & WatchContent.schema) !== 0;

  const relChanges: readonly RelationshipUpdate[] =
    includeRels && ev.relationshipChanges.length > 0 ? ev.relationshipChanges.map(toUpdate) : [];
  const schemaChanged = includeSchema && ev.schemaChange !== undefined;

  if (relChanges.length === 0 && !schemaChanged) return undefined;

  return {
    revision: new TimestampRevision(ev.revision),
    relationshipChanges: relChanges,
    schemaChanged,
  };
}

/**
 * Builds the compatibility-path {@link CommitRequest} for a committed transaction by reusing the
 * single per-revision diff (`eventFromState`) over the committed state: the resolved relationship
 * touch/delete changes, the schema bytes written at this revision (if any), and the counter deltas
 * - with `expectedHead` as the CAS and no preconditions (the lambda already evaluated its own reads
 * against this base). The grain re-mints the authoritative revision, so the request carries no
 * revision - only the net diff. This is the inverse of the grain's `applyEvent` fold, keeping the
 * write path and the fold provably equal.
 */
function commitFromState(
  committed: DatastoreState,
  revision: bigint,
  expectedHead: bigint,
): CommitRequest {
  const ev = eventFromState(committed, revision);
  return {
    preconditions: [],
    updates: ev.relationshipChanges,
    deleteByFilter: undefined,
    schemaBytes: ev.schemaChange?.bytes,
    expectedSchemaHash: undefined,
    counterChanges: ev.counterChanges,
    expectedHead,
  };
}

/**
 * An {@link IDatastoreReader} that acquires its inner `MvccSnapshotReader` ONCE, lazily on the
 * first query (via `acquire`), then serves all subsequent reads in-process. Because
 * `IDatastore.snapshotReader` is synchronous but acquiring the state is async, the acquisition is
 * deferred to the first (async) read. Callers pin one reader per operation and query it many times,
 * so the acquisition (one sequencer full-state fetch) happens exactly once per reader. The MVCC
 * fold is exact for any revision AT OR ABOVE the fetched state's collected floor, and
 * `MvccSnapshotReader`'s own constructor guard rejects (`RevisionNotFoundException`) a revision
 * below it, so a permissive `isValid` delegate there is sound - the hard floor check lives in the
 * reader itself, not this wrapper.
 *
 * `SemaphoreSlim(1, 1)` -> a memoised IN-FLIGHT PROMISE: the single-flight gate the semaphore
 * provided, with no lock to hold across the await. A second reader arriving while the first
 * acquisition is in flight awaits the same promise and so shares the one fetch.
 */
class DeferredReader implements IDatastoreReader {
  private innerReader: MvccSnapshotReader | undefined = undefined;
  private acquiring: Promise<MvccSnapshotReader> | undefined = undefined;

  constructor(
    private readonly acquire: (signal: AbortSignal | undefined) => Promise<MvccSnapshotReader>,
  ) {}

  private async inner(signal: AbortSignal | undefined): Promise<MvccSnapshotReader> {
    const existing = this.innerReader;
    if (existing !== undefined) return existing;
    // The C# is `_inner ??= await acquire(ct)`, which assigns ONLY on success: a throwing
    // acquisition leaves `_inner` null and the NEXT query re-attempts. Memoising the in-flight
    // promise must therefore clear it on rejection - otherwise one transient grain failure is
    // cached for the reader's whole life, and `snapshotReader`'s documented "pin one reader, query
    // it many times" callers (BulkExport paging, the fold-equivalence oracle) never recover.
    this.acquiring ??= this.acquire(signal).then(
      (reader) => {
        this.innerReader = reader;
        this.acquiring = undefined;
        return reader;
      },
      (error: unknown) => {
        this.acquiring = undefined;
        throw error;
      },
    );
    return this.acquiring;
  }

  /** @inheritdoc */
  async *queryRelationships(
    filter: RelationshipsFilter,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship> {
    const inner = await this.inner(signal);
    yield* inner.queryRelationships(filter, signal);
  }

  /** @inheritdoc */
  async *reverseQueryRelationships(
    subjectsFilter: SubjectsFilter,
    options?: ReverseQueryOptions | undefined,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship> {
    const inner = await this.inner(signal);
    yield* inner.reverseQueryRelationships(subjectsFilter, options, signal);
  }

  /** @inheritdoc */
  async readStoredSchema(signal?: AbortSignal | undefined): Promise<Uint8Array | undefined> {
    const inner = await this.inner(signal);
    return inner.readStoredSchema(signal);
  }

  /** @inheritdoc */
  async readCounterFilter(
    name: string,
    signal?: AbortSignal | undefined,
  ): Promise<RelationshipsFilter | undefined> {
    const inner = await this.inner(signal);
    return inner.readCounterFilter(name, signal);
  }

  /** @inheritdoc */
  async countRelationships(name: string, signal?: AbortSignal | undefined): Promise<bigint> {
    const inner = await this.inner(signal);
    return inner.countRelationships(name, signal);
  }

  /** @inheritdoc */
  async *lookupCounters(signal?: AbortSignal | undefined): AsyncIterable<RegisteredCounter> {
    const inner = await this.inner(signal);
    yield* inner.lookupCounters(signal);
  }

  /** @inheritdoc - an unacquired reader reports valid. */
  get isValid(): boolean {
    return this.innerReader === undefined || this.innerReader.isValid;
  }
}
