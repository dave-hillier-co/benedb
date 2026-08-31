import { TimestampRevision } from "@benedb/core/timestamp-revision";
import {
  CounterAlreadyRegisteredException,
  CounterNotRegisteredException,
  CreateRelationshipExistsException,
  RevisionNotFoundException,
} from "@benedb/datastore/datastore-exceptions";
import { MvccReadWriteTransaction } from "@benedb/datastore/mvcc-read-write-transaction";
import { grain } from "@thresh/core/decorators";
import type { Duration } from "@thresh/core/duration";
import { durationToMs } from "@thresh/core/duration";
import { InconsistentStateError } from "@thresh/core/errors";
import { grainReferenceIdentity } from "@thresh/core/grain-reference";
import type { GrainStorage, StateHolder } from "@thresh/core/grain-storage";
import { JournaledGrain, type CustomStorageInterface } from "@thresh/core/journaled-grain";
import type { Logger } from "@thresh/core/logger";
import { noopLogger } from "@thresh/core/logger";
import { ObserverManager } from "@thresh/core/observer-manager";
import type { Remindable, TickStatus } from "@thresh/core/reminder";
import { systemTimeProvider } from "@thresh/core/time-provider";

import type { CommitFailureKind, CommitReply, CommitRequest } from "./commit-contract";
import type {
  DatastoreHeadWire,
  FullRelationshipsFilterWire,
  LogHeadEntry,
  StoredRelationshipWire,
} from "./datastore-dtos";
import type { DatastoreGcOptions, ResolvedDatastoreGcOptions } from "./datastore-gc-options";
import { MINIMUM_REMINDER_PERIOD, resolveDatastoreGcOptions } from "./datastore-gc-options";
import type { DatastoreGrainState } from "./datastore-grain-state";
import type {
  DatastoreMetaEntry,
  DatastoreMetaState,
  KeyIndexBucketEntry,
  KeyIndexDeltaEntry,
  KeyIndexLayout,
} from "./datastore-meta-state";
import {
  createEmptyKeyIndexLayout,
  datastoreMetaStateEmpty,
  datastoreMetaStateSchemaHashAt,
  datastoreMetaStateSchemaVersionAt,
  DEFAULT_BUCKET_COUNT,
  KEY_INDEX_TOMBSTONE,
  keyIndexLayoutBucketOf,
  NO_BUCKET_ROW,
} from "./datastore-meta-state";
import { toMemoryState } from "./datastore-state-converters";
import { graphShardGrainKeyBuild, graphShardGrainKeyParse } from "./graph-shard-grain-key";
import type { GraphShardKeyWire } from "./graph-shard-key";
import { graphShardKeyForResource, graphShardKeyForSubject } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import { GRAPH_SHARD_STATE_EMPTY } from "./graph-shard-state";
import type { IDatastoreGrain } from "./i-datastore-grain";
import type { IDatastoreWatcher } from "./i-datastore-watcher";
import type { ISequencerMetrics } from "./i-sequencer-metrics";
import type { LogEvent, LogSegment } from "./log-event";
import { eventFromState } from "./log-event-factory";
import {
  metaFoldApplyEvent,
  metaFoldForwardKeyOf,
  metaFoldReverseKeyOf,
  metaFoldTouchedKeys,
} from "./meta-fold";
import { mustMatchFailedMessage, mustNotMatchFailedMessage } from "./precondition-messages";
import { shardFoldApplyEvent, shardFoldCollectBelow } from "./shard-fold";
import { toCoreFilter, toWriteUpdate } from "./wire-convert";
// The value-codec surrogate that lets `RevisionNotFoundException` cross the grain boundary as its
// own class (`readFrom` / `readSchemaAt` are the two throw sites). Importing for the side effect IS
// the registration; without it a stale Watch cursor arrives at the front door as a plain error.
import "./revision-not-found-surrogate";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/DatastoreGrain.cs`.
 *
 * The cluster-singleton datastore grain (`DATASTORE_GRAIN_KEY` = 0n): the single source of truth
 * for the whole MVCC datastore. It is EVENT-SOURCED - the append-only log of {@link LogEvent}s is
 * the source of truth - and, under the THIN-SEQUENCER layout, it does not materialize the whole
 * fold: the journaled state is only the SMALL state ({@link DatastoreMetaState} - head, schemas,
 * counters, GC floor, key index), relationship rows are persisted per adjacency key as
 * VERSION-QUALIFIED `shard/{rowVersion}/{escapedGraphShardGrainKey}` {@link GraphShardState} rows
 * (write-once per version, reachable only through the meta's key->version index maps; both
 * directions), and the grain holds a DIRTY BUFFER of the keys touched since their rows were last
 * flushed.
 *
 * INTERLEAVING IS THE CENTRAL CONTRACT. It is a single non-reentrant activation; WRITES (`commit`,
 * `runGc` - no interleave option on the interface) never interleave EACH OTHER, so a write's turn
 * runs to completion before the next write's, keeping the head-compare-and-append atomic. The PURE
 * reads (`readState`, `getHead`, `readSchemaAt`, `readShard`, `readFrom`) carry
 * `alwaysInterleave` in `IDatastoreGrain`'s options map (never `readOnly`, which interleaves only
 * when BOTH turns are read-only and so would not get past the non-read-only `commit`) and may run
 * DURING a write's await - never concurrently with it (the scheduler is still single-threaded) and
 * never observing a write's intermediate state; see the publication discipline in
 * {@link DatastoreGrain.applyUpdatesToStorage}.
 *
 * Persistence is OUR responsibility via Thresh's `CustomStorageInterface` over a `GrainStorage`
 * provider (no application SQL): each event is a per-version `log/{version}` entry, a `head`
 * pointer tracks the contiguous log version + the timestamp head revision + the current flush
 * (meta) version, and every {@link FLUSH_INTERVAL} events the dirty buffer is FLUSHED (per-key
 * shard rows written under the new flush version + a `meta/{version}` row) and the log compacted,
 * bounding replay cost. `retrieveConfirmedEvents` is NOT supported under custom storage in EITHER
 * runtime, which is exactly why the grain keeps its own in-memory recent-events window so
 * {@link DatastoreGrain.readFrom} serves the live tail with no storage reads.
 *
 * THE LOAD-BEARING SHARDING FACT (pinned by `shard-fold-lemma-tests.test.ts`): a stored shard row's
 * CONTENT is complete unless an event touched its key - any touching event dirties the key and the
 * next flush rewrites the row - so a clean key's stored row is current except for its
 * `appliedRevision` label, which may safely be relabeled to the current head. Row-level GC is LAZY:
 * a GC event advances the small state's floor immediately, but a clean key's stored row keeps its
 * sub-floor dead rows until it is next dirtied and flushed; sound because reads pinned below the
 * floor are rejected outright and every serve path re-applies the current floor
 * (`shardFoldCollectBelow`) before answering.
 *
 * THE KEY INDEX IS CHUNKED IN STORAGE (durable layout v2): the meta row never serializes the
 * forward/reverse key maps - they are persisted as per-direction BUCKET rows
 * (`indexb/{version}/{dir}/{bucket}`, `bucket = FNV-1a-64(key) % B` with B fixed at store creation)
 * rewritten ONE bucket per direction per flush in round-robin rotation, plus a per-flush DELTA row
 * (`indexd/{version}`) carrying exactly the entries that flush dirtied (removals as explicit
 * tombstones).
 *
 * PORT DECISIONS (recorded here because none of them is mechanical):
 *
 *  1. `[LogConsistencyProvider(ProviderName = "CustomStorage")]` has no counterpart: Thresh's
 *     `bindJournaledGrain` DETECTS a `CustomStorageInterface` host and installs the custom-storage
 *     adaptor instead of the journal substrate. The attribute becomes the class implementing the
 *     interface, nothing else.
 *  2. `JournaledGrain<DatastoreMetaHolder, LogEvent>` becomes
 *     `JournaledGrain<DatastoreMetaState, LogEvent>`. The C# holder exists ONLY because Orleans
 *     mutates its state object in place through `TransitionState(holder, ev)`; Thresh's
 *     `transitionState(state, ev)` RETURNS the next state, so the holder is dead weight. This
 *     settles the open question recorded on `DatastoreMetaHolder`.
 *  3. `RaiseConditionalEvent(ev)` has no Thresh counterpart. `raiseEvent` + `confirmEvents` is the
 *     equivalent pair, and the custom-storage adaptor's own CAS on the contiguous log version plays
 *     the role of Orleans' conditional-append version check - so the boolean the C# branches on
 *     becomes "did `confirmEvents` complete without an `InconsistentStateError`". See
 *     {@link DatastoreGrain.raiseConditionalEvent}.
 *  4. `SemaphoreSlim(1,1)` -> the module-private {@link Mutex}. The port guide points at
 *     `AsyncSerialExecutor`, but that runs a QUEUED CALLBACK to completion and cannot be HELD
 *     across a section (the flush holds `#shardIo` across its whole write-rows/meta/head/clear
 *     block, and readers hold it across one row read), so a promise-chain mutex with an explicit
 *     `try/finally` release is what transliterates.
 *  5. Thresh has no constructor DI, so the C#'s `[FromKeyedServices("datastore")] IGrainStorage`
 *     plus its optional `ILogger`/`IOptions`/`ISequencerMetrics` become one optional options bag
 *     supplied through a `GrainActivator`. The parameter is OPTIONAL so the class still satisfies
 *     Thresh's `new () => Grain` registration shape.
 *  6. Observers ARE available: `ObserverManager` is keyed by the observer reference's
 *     `grainReferenceIdentity(...).grainId` string, because Thresh grain references (unlike
 *     Orleans') have no value equality - the C#'s `Subscribe(watcher, watcher)` would otherwise
 *     accumulate a duplicate registration per heartbeat instead of refreshing one.
 */
@grain()
export class DatastoreGrain
  extends JournaledGrain<DatastoreMetaState, LogEvent>
  implements IDatastoreGrain, CustomStorageInterface<DatastoreMetaState, LogEvent>, Remindable
{
  // --- injected collaborators ---

  readonly #storageProvider: GrainStorage | undefined;
  readonly #logger: Logger;
  readonly #gcOptions: ResolvedDatastoreGcOptions;

  /**
   * The sequencer-side inbound-call counters, or absent on a host that never registered them -
   * every record site is optional-chained, so the grain works unchanged without the seam.
   */
  readonly #metrics: ISequencerMetrics | undefined;

  /**
   * How long old revisions stay served by {@link readFrom} / retained in the in-memory window, and
   * the retention window {@link runGc} collects MVCC history beyond. Older cursors throw
   * `RevisionNotFoundException`.
   */
  readonly #gcWindowNanos: bigint;

  /**
   * The registered head-advance observers (one per silo hub), keyed by the observer reference's
   * grain-id string. Deliberately in-memory only - observer references are not durable, so the set
   * empties on reactivation; the hubs' heartbeat resubscribe (which also returns the head) makes
   * that safe.
   */
  readonly #watchers = new ObserverManager<string, IDatastoreWatcher>(
    WATCHER_EXPIRY,
    systemTimeProvider,
  );

  // --- the publication unit (see `applyUpdatesToStorage`) ---

  /** The contiguous append-only log version (= number of confirmed events) currently in storage. */
  #logVersion = 0;

  /** The log version of the current `meta/{version}` row (log entries at or below it are compacted). */
  #metaVersion = 0;

  /**
   * The small state as currently PERSISTED-or-published (the meta fold of all stored events).
   * Tracked here so the storage methods never touch `JournaledGrain.state` - reading the confirmed
   * view from inside a confirm round-trip would re-enter the log-consistency adaptor - and so every
   * serve path reads head/floor/schemas/counters/index from the SAME publication unit as
   * {@link dirty}/{@link recent}.
   */
  #storedMeta: DatastoreMetaState = datastoreMetaStateEmpty(0n);

  /**
   * The durable key-index layout descriptor (bucket count, per-bucket row versions, rotation
   * cursor, pending delta versions) as of the current meta row. Consumed only by the flush (which
   * rotates it forward) and recovery (which reconstructs the in-memory maps from the rows it
   * describes); serve paths never touch it.
   */
  #indexLayout: KeyIndexLayout = createEmptyKeyIndexLayout(
    datastoreGrainInternals.creationBucketCount,
  );

  /**
   * THE DIRTY BUFFER: the folded CURRENT {@link GraphShardState} of every shard key touched since
   * its storage row was last flushed, keyed by the escaped `GraphShardGrainKey` string. SEEDING
   * RULE: before an event is folded into the buffer, every key it touches must already hold an
   * entry seeded from its storage row (or the empty shard) - seeding happens in ASYNC contexts only
   * ({@link commit} pre-stages the keys it touches; recovery seeds while replaying); the
   * synchronous fold paths only apply `shardFoldApplyEvent` to entries guaranteed present.
   *
   * `Dictionary<string, GraphShardState>(StringComparer.Ordinal)` -> a `Map`, which is ordinal by
   * construction.
   */
  #dirty = new Map<string, GraphShardState>();

  /**
   * Serializes the flush's shard-row rewrites against {@link currentShardState}'s clean-key storage
   * reads. Without it, an interleaved read racing a flush could fetch a key's PRE-flush row
   * (missing the dirty-window events), then observe the buffer already cleared and wrongly relabel
   * that stale content to the new head. Readers hold it only across one row read; the flush holds
   * it across its whole write-rows/meta/head/clear section. NEVER held across
   * {@link raiseConditionalEvent}.
   */
  readonly #shardIo = new Mutex();

  /**
   * The live state holder for the `head` entry - the only singleton entry rewritten in place. Held
   * as a field so its storage etag persists across writes (the providers enforce optimistic
   * concurrency per entry; a fresh etag-less holder would be rejected on the second write).
   */
  readonly #headState: StateHolder<LogHeadEntry> = {
    value: undefined as unknown as LogHeadEntry,
    exists: false,
  };

  /**
   * The in-memory recent-events window (ascending by revision) that {@link readFrom} tails. It
   * retains exactly the events with revision > {@link recentFloorRevision}; it is rebuilt from
   * storage on activation (the post-flush tail) and appended to on each confirmed write.
   */
  #recent: LogEvent[] = [];

  /**
   * The exclusive lower bound of {@link recent}: events at or below this revision have been flushed
   * into per-key shard rows (or aged past the GC window) and are no longer individually retained,
   * so {@link readFrom} cannot serve a cursor older than this and throws.
   */
  #recentFloorRevision = 0n;

  constructor(options: DatastoreGrainOptions = {}) {
    super();
    this.#storageProvider = options.storage;
    this.#logger = options.logger ?? noopLogger;
    this.#metrics = options.metrics;
    // Optional so a host/test that never configures the GC options still activates the grain with
    // sane defaults (24h window, 1h reminder, enabled).
    this.#gcOptions = resolveDatastoreGcOptions(options.gcOptions);
    // `(long)Window.TotalMilliseconds * 1_000_000L`: the TRUNCATION happens before the multiply, so
    // it is `Math.trunc` on the millisecond value, never on the product.
    this.#gcWindowNanos = BigInt(Math.trunc(durationToMs(this.#gcOptions.window))) * 1_000_000n;
  }

  /**
   * `[FromKeyedServices("datastore")] IGrainStorage`. Thresh has no constructor DI, so the provider
   * arrives through the options bag; a grain activated without one cannot do anything at all, and
   * saying so here beats a `TypeError` from deep inside a storage helper.
   */
  get #storage(): GrainStorage {
    if (this.#storageProvider === undefined) {
      throw new Error(
        "DatastoreGrain requires the 'datastore' grain-storage provider; supply it through a GrainActivator",
      );
    }
    return this.#storageProvider;
  }

  // --- JournaledGrain ---

  /** @inheritdoc */
  initialState(): DatastoreMetaState {
    return datastoreMetaStateEmpty(0n);
  }

  /**
   * Folds a confirmed event into the SMALL state only (the adaptor's confirmed view, which
   * {@link commit}/{@link runGc} read at the top of a write turn). The dirty buffer's per-key fold
   * deliberately does NOT happen here: it happens in {@link applyUpdatesToStorage} (into locals,
   * published atomically with {@link storedMeta}), because a flush inside that method must write
   * rows that already include the in-flight batch, and folding the buffer twice would corrupt it
   * while folding it only here would leave the flush's rows missing the batch. Deterministic and
   * synchronous, exactly as the adaptor requires.
   */
  transitionState(state: DatastoreMetaState, ev: LogEvent): DatastoreMetaState {
    return metaFoldApplyEvent(state, ev);
  }

  // --- lifecycle ---

  /** @inheritdoc */
  override async onActivate(): Promise<void> {
    if (!this.#gcOptions.reminderEnabled) return;

    try {
      const period = durationLessThan(this.#gcOptions.reminderPeriod, MINIMUM_REMINDER_PERIOD)
        ? MINIMUM_REMINDER_PERIOD
        : this.#gcOptions.reminderPeriod;
      await this.runtime.registerReminder(GC_REMINDER_NAME, period, period);
    } catch (error) {
      // A host with no reminder service configured (many tests, some dev hosts) must still
      // activate; losing the periodic reminder is safe because the singleton re-registers it on
      // every future activation, and `runGc` remains directly callable regardless.
      this.#logger.warn(
        `datastore grain: failed to register the '${GC_REMINDER_NAME}' reminder; MVCC GC will not run periodically on this activation`,
        { error },
      );
    }
  }

  /** @inheritdoc */
  async receiveReminder(reminderName: string, _status: TickStatus): Promise<void> {
    if (reminderName === GC_REMINDER_NAME) await this.runGc();
  }

  // --- serve-path core ---

  /**
   * current-state(key): the exact per-key fold at the current head, served without any per-key log
   * replay. Resolution order: the dirty buffer entry (folded through every confirmed touching
   * event); otherwise the key's STORAGE row relabeled to head (sound by the sharding fact) - read
   * at the row version the key index maps the key to, so an unindexed key resolves to
   * empty-at-head with no storage read (this also shields leaked or orphaned rows the index never
   * references); otherwise empty-at-head. Every branch re-applies the current GC floor via
   * `shardFoldCollectBelow` (the lazy row-GC contract), which also performs the relabel.
   *
   * Interleave safety: the dirty-hit and unindexed branches are fully synchronous over one
   * publication unit. The storage-read branch awaits under {@link shardIo} so it cannot race a
   * flush's row rewrite, and re-checks the buffer afterwards.
   */
  async #currentShardState(shardKey: string): Promise<GraphShardState> {
    for (;;) {
      const meta = this.#storedMeta;
      const entry = this.#dirty.get(shardKey);
      if (entry !== undefined) {
        return shardFoldCollectBelow(
          entry,
          maxBig(entry.appliedRevision, meta.headRevision),
          meta.gcFloor,
        );
      }

      // Index miss => empty-at-head with no storage read. Rows are reachable ONLY through the index
      // maps (shard rows are version-qualified), so a leaked physical row can never be served. A key
      // indexed at `NO_ROW_VERSION` but NOT dirty is unreachable in practice; treat it like an index
      // miss defensively rather than dereference the sentinel.
      const rowVersion = tryGetRowVersion(meta, shardKey);
      if (rowVersion === undefined || rowVersion < 0)
        return { appliedRevision: meta.headRevision, gcFloor: meta.gcFloor, rows: [] };

      let stored: GraphShardState | undefined;
      await this.#shardIo.wait();
      try {
        stored = await this.#readShardRow(rowVersion, shardKey);
      } finally {
        this.#shardIo.release();
      }

      // SYNCHRONOUS re-validation (no await between here and the return): a commit may have landed
      // during the read. If it touched THIS key the buffer now holds the authority - loop. If a
      // FLUSH landed instead (possible while parked on the semaphore), the key's current row may
      // have moved to a newer version and the row just read may already be post-commit-cleared -
      // loop and resolve through the fresh index.
      if (this.#dirty.has(shardKey)) continue;
      const currentVersion = tryGetRowVersion(this.#storedMeta, shardKey);
      if (currentVersion === undefined || currentVersion !== rowVersion) continue;

      // Serve at the MAX of the small state's floor and the stored row's own stamped floor. They
      // agree on this activation; they can diverge only when a STALE DUPLICATE activation reads a
      // row a newer activation has GC-compacted further - taking the max turns what would be a
      // silently-incomplete answer into the standard below-floor rejection at the consumer.
      const current = this.#storedMeta;
      return shardFoldCollectBelow(
        stored ?? GRAPH_SHARD_STATE_EMPTY,
        current.headRevision,
        maxBig(current.gcFloor, stored?.gcFloor ?? 0n),
      );
    }
  }

  // --- IDatastoreGrain ---

  /**
   * `alwaysInterleave`. ADMIN-PLANE ASSEMBLY: the thin sequencer no longer holds the whole fold, so
   * this rebuilds a {@link DatastoreGrainState} from the small state plus the current state of
   * every indexed FORWARD key (each row belongs to exactly one forward key, so the union is exact
   * and duplicate-free). The cost is O(graph) storage reads + transfer per call, acceptable ONLY
   * for its admin-plane consumers; the per-Check hot path never comes here.
   */
  async readState(): Promise<DatastoreGrainState> {
    this.#metrics?.recordReadState();
    for (;;) {
      const meta = this.#storedMeta;
      const rows: StoredRelationshipWire[] = [];
      let floor = meta.gcFloor;
      for (const shardKey of meta.forwardKeys.keys()) {
        const state = await this.#currentShardState(shardKey);
        // `rows.AddRange(state.Rows)`: a LOOP, not `push(...state.rows)`. Spread passes each row as
        // an argument and is capped by the engine's argument limit, so one wide shard key (a public
        // wildcard, or enough MVCC versions - `rows` carries every stored version, not just the
        // live ones) turns a store the C# serves into a `RangeError` here. `readState` is the write
        // base for every import, snapshot reader and equivalence gate, so that is the admin plane.
        for (const row of state.rows) rows.push(row);
        // Normally equal to the small state's floor; a HIGHER per-key floor can only come from the
        // stale-duplicate divergence documented in `currentShardState` - propagate it so a pin
        // between the floors is rejected (fail loud) instead of served incomplete.
        floor = maxBig(floor, state.gcFloor);
      }

      if (this.#storedMeta.gcFloor !== meta.gcFloor) continue; // GC landed mid-assembly; restart.

      // Order by created revision to approximate the retired fold's append order. `List.Sort` is
      // UNSTABLE in .NET and `Array.prototype.sort` is STABLE, so ties (the rows of one commit)
      // order differently between the two - cosmetic by the C#'s own statement, since every
      // consumer is an MVCC reader and anything order-sensitive imposes its own order downstream.
      rows.sort(compareByCreatedRevision);

      return {
        headRevision: meta.headRevision,
        relationships: rows,
        schemas: meta.schemas,
        counters: meta.counters,
        gcFloor: floor,
      };
    }
  }

  /**
   * `alwaysInterleave`. Reads {@link storedMeta} - the storage-side publication unit - so an
   * interleaved call landing mid-write sees, AT WORST, the previous commit; it can never observe a
   * write's in-flight intermediate state.
   */
  getHead(): Promise<DatastoreHeadWire> {
    this.#metrics?.recordGetHead();
    const s = this.#storedMeta;
    return Promise.resolve({
      head: s.headRevision,
      schemaHash: datastoreMetaStateSchemaHashAt(s, s.headRevision),
      gcFloor: s.gcFloor,
    });
  }

  /** `alwaysInterleave`. Small state only; same publication guarantee as {@link getHead}. */
  readSchemaAt(revision: bigint): Promise<Uint8Array | undefined> {
    this.#metrics?.recordReadSchemaAt();
    const s = this.#storedMeta;
    // Below the GC floor the schema history has been collected, so "no schema at this revision" is
    // indistinguishable from "collected away" - a silent absent here would make callers fall back
    // to the seed schema and evaluate WRONG results under a stale token. Reject loudly instead;
    // `RevisionNotFoundException` round-trips the grain boundary via its surrogate and the front
    // door maps it to InvalidArgument like any other GC'd pinned revision.
    if (revision < s.gcFloor) throw new RevisionNotFoundException(new TimestampRevision(revision));

    return Promise.resolve(datastoreMetaStateSchemaVersionAt(s, revision)?.bytes);
  }

  /**
   * `alwaysInterleave`. One {@link currentShardState} resolution: the dirty entry, or the stored row
   * relabeled to the CURRENT head (the sharding fact), or empty-at-head - with the current GC floor
   * applied in every branch.
   */
  readShard(key: GraphShardKeyWire): Promise<GraphShardState> {
    this.#metrics?.recordReadShard();
    if (key === undefined || key === null) throw new Error("key must not be null");
    return this.#currentShardState(graphShardGrainKeyBuild(key));
  }

  /**
   * The RELOCATION of the client-side write execution into the sequencer: because writes never
   * interleave writes, the head read at the top of this method cannot move before the append at the
   * bottom - the transaction executor IS the serialization point, so a declarative commit (absent
   * `expectedHead`) needs no retry. All rejections return as reply data with NOTHING applied.
   */
  async commit(request: CommitRequest): Promise<CommitReply> {
    if (request === undefined || request === null) throw new Error("request must not be null");

    // Duration measured around the WHOLE serialized write turn and recorded in a `finally` so every
    // inbound call - accepted, rejected, or thrown - counts exactly once. `Stopwatch.GetTimestamp`
    // -> `performance.now()`, whose unit is FRACTIONAL MILLISECONDS, so microseconds is `* 1000`.
    const startTimestamp = performance.now();
    try {
      return await this.#commitCore(request);
    } finally {
      this.#metrics?.recordCommit(Math.trunc((performance.now() - startTimestamp) * 1000));
    }
  }

  /**
   * The whole `commit` body; split out only so the public entry can bracket it with the duration
   * measurement.
   */
  async #commitCore(request: CommitRequest): Promise<CommitReply> {
    // The confirmed small state: in a write turn this equals `#storedMeta` (all prior confirms have
    // fully completed), and it is the view the adaptor's own version check pairs with.
    const meta = this.state;
    const head = meta.headRevision;

    // 1. Compatibility CAS: reject if the head moved - the load-bearing compare, atomic with the
    //    append because writes never interleave writes.
    if (request.expectedHead !== undefined && head !== request.expectedHead)
      return rejected("headMoved", `expected head ${request.expectedHead} but head is ${head}`);

    // 2. Schema-write serializability: the caller validated its schema change against the schema it
    //    saw; reject if another schema landed since. An ABSENT current hash is the pre-first-schema
    //    seed window and matches only an absent/EMPTY-STRING expected hash - that conflation is the
    //    C#'s own deliberate choice and the empty-string sentinel must survive intact.
    if (request.expectedSchemaHash !== undefined) {
      const expectedSchemaHash = request.expectedSchemaHash;
      const currentHash = datastoreMetaStateSchemaHashAt(meta, head);
      const unchanged =
        currentHash === undefined
          ? expectedSchemaHash.length === 0
          : currentHash === expectedSchemaHash;
      if (!unchanged) {
        return rejected(
          "schemaHashMoved",
          `expected schema hash '${expectedSchemaHash}' but schema hash at head is '${currentHash ?? ""}'`,
        );
      }
    }

    // 3. Mint the new revision monotonically over the observed head (mirrors ReferenceDatastore).
    const now = nowNanos();
    const newRevision = now > head ? now : head + 1n;

    // 4. CANDIDATE-KEY RESOLUTION replaces the whole-state base: the forward key of every update's
    //    resource, plus the keys matching each precondition filter and the deleteByFilter. Rows are
    //    deduped by (six-tuple identity, createdRevision) because a row contributed by both its
    //    forward and its reverse key is the identical stored row.
    const candidates = new Set<string>();
    for (const update of request.updates) candidates.add(metaFoldForwardKeyOf(update.relationship));
    for (const precondition of request.preconditions)
      addFilterCandidates(precondition.filter, meta, candidates);
    if (request.deleteByFilter !== undefined)
      addFilterCandidates(request.deleteByFilter.filter, meta, candidates);
    this.#metrics?.recordCommitCandidates(candidates.size);

    const loaded = new Map<string, GraphShardState>();
    const candidateRows: StoredRelationshipWire[] = [];
    // `readonly record struct CandidateRowIdentity` used as a Dictionary KEY: value equality over
    // six strings plus a long. A JS `Map` keys by REFERENCE, so this is a LENGTH-PREFIXED composite
    // string - relationship ids may contain any character, so a delimiter-joined key would not be
    // injective, and a non-injective key silently stops deduping.
    const seen = new Map<string, bigint | undefined>();
    for (const candidate of candidates) {
      const shard = await this.#currentShardState(candidate);
      loaded.set(candidate, shard);
      for (const row of shard.rows) {
        const identity = candidateRowIdentity(row);
        if (seen.has(identity)) {
          // The INTENDED collision: the same stored row contributed by both its forward and its
          // reverse key - identical stamps by the sharding lemma, so dropping the duplicate is
          // exact. If the stamps disagree, that state is impossible by construction: storage
          // corruption or a fold bug. Fail loudly instead of guessing.
          const deletedRevision = seen.get(identity);
          if (deletedRevision !== row.deletedRevision) {
            throw new Error(
              "datastore invariant violation: two reachable shard rows share identity " +
                `${row.relationship.resourceType}:${row.relationship.resourceId}` +
                `#${row.relationship.resourceRelation}` +
                `@${row.relationship.subjectType}:${row.relationship.subjectId}` +
                `#${row.relationship.subjectRelation}` +
                ` and created revision ${row.createdRevision} but differ in deleted revision` +
                ` (${deletedRevision?.toString() ?? "live"} vs ${row.deletedRevision?.toString() ?? "live"});` +
                " forward/reverse contributions of one stored row must be identical",
            );
          }
          continue;
        }

        seen.set(identity, row.deletedRevision);
        candidateRows.push(row);
      }
    }
    candidateRows.sort(compareByCreatedRevision);

    const partial: DatastoreGrainState = {
      headRevision: head,
      relationships: candidateRows,
      schemas: meta.schemas,
      counters: meta.counters,
      gcFloor: meta.gcFloor,
    };

    // 5. Stage the whole request through the SAME in-memory MVCC transaction the client path used,
    //    pinned directly at the authoritative revision.
    const baseState = toMemoryState(partial);
    const tx = new MvccReadWriteTransaction(baseState, newRevision);

    // 6. Preconditions in request order, BEFORE any mutation (existence-only probe per filter), with
    //    the shared message text so the client-side rethrown message is unchanged.
    for (let i = 0; i < request.preconditions.length; i += 1) {
      const precondition = request.preconditions[i]!;
      const filter = toCoreFilter(precondition.filter);

      let matched = false;
      for await (const _ of tx.queryRelationships(filter)) {
        matched = true;
        break; // existence check only; one row is enough.
      }

      if (precondition.mustMatch && !matched)
        return rejected("preconditionFailed", mustMatchFailedMessage(i, filter));
      if (!precondition.mustMatch && matched)
        return rejected("preconditionFailed", mustNotMatchFailedMessage(i, filter));
    }

    // 7. Relationship updates, PRESERVING Create so the create-conflict check fires here.
    if (request.updates.length > 0) {
      const updates = request.updates.map(toWriteUpdate);
      try {
        await tx.writeRelationships(updates);
      } catch (error) {
        if (error instanceof CreateRelationshipExistsException)
          return rejected("createAlreadyExists", error.relationship);
        throw error;
      }
    }

    // 8. Bulk delete-by-filter (after the updates, like the request declares them).
    let deletedCount = 0n;
    let reachedLimit = false;
    if (request.deleteByFilter !== undefined) {
      const result = await tx.deleteRelationships(
        toCoreFilter(request.deleteByFilter.filter),
        request.deleteByFilter.limit,
      );
      deletedCount = result.count;
      reachedLimit = result.reachedLimit;
    }

    // 9. Schema bytes (compile/type/diff validation is the caller's job, guarded here by the
    //    expectedSchemaHash gate above).
    if (request.schemaBytes !== undefined) await tx.writeStoredSchema(request.schemaBytes);

    // 10. Counter deltas, keyed (like the CAS itself) off `expectedHead`:
    //     - Declarative (absent expectedHead): each delta is a guarded INTENT, run through
    //       tx.writeCounter/deleteCounter so the register/unregister preconditions are enforced here
    //       and rejected as typed reply failures.
    //     - Compatibility (present expectedHead): each delta is the already-RESOLVED net counter
    //       version the lambda's own guarded ops produced client-side against this exact base. It
    //       must NOT replay through the guards - a same-commit register+unregister nets to a
    //       tombstone whose guard is false in the base (and the inverse trips AlreadyRegistered) -
    //       so it rides the appended event directly below.
    if (request.expectedHead === undefined) {
      for (const counter of request.counterChanges) {
        try {
          if (counter.filter !== undefined)
            await tx.writeCounter(counter.name, toCoreFilter(counter.filter));
          else await tx.deleteCounter(counter.name);
        } catch (error) {
          if (error instanceof CounterAlreadyRegisteredException)
            return rejected("counterAlreadyRegistered", error.counterName);
          if (error instanceof CounterNotRegisteredException)
            return rejected("counterNotRegistered", error.counterName);
          throw error;
        }
      }
    }

    // 11. Commit the staged transaction and derive the canonical event.
    const committed = tx.commit();
    let ev = eventFromState(committed, newRevision);

    // Compatibility path: the net counter deltas ride the event directly (see step 10) - the fold
    // applies them by direct append, exactly how the retired client-side derivation shipped them.
    if (request.expectedHead !== undefined && request.counterChanges.length > 0)
      ev = { ...ev, counterChanges: request.counterChanges };

    // 12. PRE-SEED the dirty buffer for every key the event touches (the seeding rule). The merge
    //     into the shared buffer is SYNCHRONOUS - no await between the merge and the append - so an
    //     interleaved reader sees either no entry or a complete, content-correct seed.
    const touched = metaFoldTouchedKeys(ev);
    for (const key of touched) {
      if (!loaded.has(key) && !this.#dirty.has(key))
        loaded.set(key, await this.#currentShardState(key));
    }
    for (const key of touched) {
      if (!this.#dirty.has(key)) this.#dirty.set(key, loaded.get(key)!);
    }

    // The adaptor's own version check is a secondary guard behind the CAS above. It cannot lose
    // here - this activation is the only writer and no write interleaves a write - but keep the
    // identical false-branch handling (reported as a moved head) rather than assume.
    const raised = await this.#raiseConditionalEvent(ev);
    if (!raised)
      return rejected("headMoved", "conditional append reported a concurrent head advance");

    // Push the new head to the per-silo watch hubs. Best-effort and isolated: `headAdvanced` is
    // one-way and any failure is swallowed - the commit result must never depend on the notify; a
    // missed push is recovered by the hubs' heartbeat.
    try {
      await this.#watchers.notify((w) => w.headAdvanced(newRevision));
    } catch {
      // Defunct observers are pruned by ObserverManager; nothing else to do.
    }

    // A schema change committed this revision: push the bytes to every silo's watch hub alongside
    // the head advance. Without this, a schema write landing on THIS silo only swaps the schema
    // provider locally - a live divergence, not just a cache-miss latency cost.
    if (ev.schemaChange !== undefined) {
      const schemaChange = ev.schemaChange;
      try {
        await this.#watchers.notify((w) => w.schemaAdvanced(schemaChange.bytes, schemaChange.hash));
      } catch {
        // Defunct observers are pruned by ObserverManager; nothing else to do.
      }
    }

    return { revision: newRevision, failure: undefined, deletedCount, reachedLimit };
  }

  /** @inheritdoc */
  async runGc(): Promise<bigint | undefined> {
    const head = this.state.headRevision;
    const currentFloor = this.state.gcFloor;
    const now = nowNanos();
    // Never above head and never inside the retained window. `head - gcWindowNanos` may go NEGATIVE
    // on a young store; that is fine and intended - the floor simply never advances.
    const floor = minBig(head, now - this.#gcWindowNanos);

    if (floor <= currentFloor) return undefined; // GC only moves forward; nothing new to collect.

    // Mint the new revision exactly like `commit`. A GC event touches no shard keys, so no
    // dirty-buffer seeding is needed: the fold applies it to every entry already present, and clean
    // keys compact lazily.
    const newRevision = now > head ? now : head + 1n;
    const ev: LogEvent = {
      revision: newRevision,
      relationshipChanges: [],
      schemaChange: undefined,
      counterChanges: [],
      gcFloor: floor,
    };

    const raised = await this.#raiseConditionalEvent(ev);
    if (!raised) return undefined; // lost a race with a concurrent turn; the next tick retries.

    // Keep the in-memory log-tail retention in lockstep with the collected state floor.
    this.#recentFloorRevision = maxBig(this.#recentFloorRevision, floor);
    this.#recent = this.#recent.filter((e) => e.revision > this.#recentFloorRevision);

    // Same best-effort notify pattern as `commit`.
    try {
      await this.#watchers.notify((w) => w.headAdvanced(newRevision));
    } catch {
      // Defunct observers are pruned by ObserverManager; nothing else to do.
    }

    return floor;
  }

  /**
   * `RaiseConditionalEvent(ev)` + `ConfirmEvents()` as one step. Orleans' conditional append fails
   * (returns false) when the confirmed version moved under it; Thresh has no conditional raise, and
   * the custom-storage adaptor's CAS on the contiguous log version - which
   * {@link applyUpdatesToStorage}'s own version guard implements - plays the same role, surfacing a
   * lost race as an `InconsistentStateError` out of `confirmEvents`. Any other error is a genuine
   * storage failure and propagates unchanged.
   */
  async #raiseConditionalEvent(ev: LogEvent): Promise<boolean> {
    this.raiseEvent(ev);
    try {
      await this.confirmEvents();
      return true;
    } catch (error) {
      if (error instanceof InconsistentStateError) return false;
      throw error;
    }
  }

  /** @inheritdoc */
  subscribeWatch(watcher: IDatastoreWatcher): Promise<DatastoreHeadWire> {
    if (watcher === undefined || watcher === null) throw new Error("watcher must not be null");
    // `_watchers.Subscribe(watcher, watcher)`: in Orleans the observer reference IS both the
    // subscription key and the target, because references have VALUE equality. Thresh's do not, so
    // the key is the reference's grain-id string - otherwise every heartbeat would accumulate a
    // duplicate registration instead of refreshing one.
    this.#watchers.subscribe(watcherKey(watcher), watcher);
    return this.getHead();
  }

  /** @inheritdoc */
  unsubscribeWatch(watcher: IDatastoreWatcher): Promise<void> {
    if (watcher === undefined || watcher === null) throw new Error("watcher must not be null");
    this.#watchers.unsubscribe(watcherKey(watcher));
    return Promise.resolve();
  }

  // --- IDatastoreLog ---

  /**
   * `alwaysInterleave`, so it can run while a write is parked at an await. It reads the head from
   * `#storedMeta.headRevision` - so the served head and {@link recent}/{@link recentFloorRevision}
   * all come from the SAME publication unit: the returned {@link LogSegment} is internally
   * consistent (its head is >= every event it serves) even if this call lands mid-write.
   */
  readFrom(afterRevision: bigint, maxCount: number): Promise<LogSegment> {
    this.#metrics?.recordReadFrom();
    const head = this.#storedMeta.headRevision;

    // The in-memory window retains only events strictly above the flush/GC floor; an older cursor
    // cannot be served COMPLETELY, so reject rather than silently return a short tail - the
    // consumer re-bootstraps via `readState` / `readShard`.
    if (afterRevision < this.#recentFloorRevision)
      throw new RevisionNotFoundException(new TimestampRevision(afterRevision));

    // `Take(maxCount < 0 ? int.MaxValue : maxCount)`: NEGATIVE is the unbounded sentinel (callers
    // also pass the max integer, which slices identically).
    const limit = maxCount < 0 ? Number.MAX_SAFE_INTEGER : maxCount;
    const events = this.#recent
      .filter((e) => e.revision > afterRevision)
      .sort((a, b) => compareBig(a.revision, b.revision))
      .slice(0, limit);

    return Promise.resolve({ events, headRevision: head });
  }

  // --- CustomStorageInterface (WE own persistence; no application SQL) ---

  /**
   * PUBLICATION DISCIPLINE (this method and {@link applyUpdatesToStorage}): storage reads/writes are
   * awaited into purely LOCAL variables; the shared fields (`#storedMeta`, `#indexLayout`,
   * `#dirty`, `#recent`, `#recentFloorRevision`, `#logVersion`, `#metaVersion`) are only ever
   * assigned in a SINGLE SYNCHRONOUS BLOCK with no `await` in between. Because an interleaving read
   * can only run while THIS call is parked at an await, a read landing mid-method sees either the
   * fields wholly untouched or, once the synchronous tail runs, the fully-updated fields - never a
   * partially-applied batch. Inserting even one `await` into a publish block, or splitting it in
   * two, silently breaks that with no test failing at that line.
   *
   * RECOVERY is O(index reconstruction + tail + touched keys), never O(graph) row content.
   * MIGRATION, one-time, both legacy layouts landing on v2 (see the two migrate helpers).
   */
  async readStateFromStorage(): Promise<{ version: number; state: DatastoreMetaState }> {
    await this.#storage.read(HEAD_STATE_NAME, this.id, this.#headState);

    if (!this.#headState.exists || this.#headState.value === undefined) {
      // No durable head yet: seed an empty state at a monotonic timestamp and PERSIST the seed, so
      // the pre-first-write revision floor is stable across reactivation (a re-seed with a fresh,
      // larger nanos would silently move the head). A fresh store is born on durable layout v2: the
      // bucket count is FIXED here for the store's whole life.
      const seeded = datastoreMetaStateEmpty(nowNanos());
      const seededLayout = createEmptyKeyIndexLayout(datastoreGrainInternals.creationBucketCount);
      await this.#writeMeta(0, {
        meta: seeded,
        flushedThroughLogVersion: 0,
        indexLayout: seededLayout,
      });
      await this.#writeHead({
        logVersion: 0,
        headRevision: seeded.headRevision,
        snapshotVersion: 0,
      });

      // PUBLISH (no await below this point in the branch).
      this.#logVersion = 0;
      this.#metaVersion = 0;
      this.#storedMeta = seeded;
      this.#indexLayout = seededLayout;
      this.#dirty = new Map<string, GraphShardState>();
      this.#recent = [];
      this.#recentFloorRevision = seeded.headRevision;
      return { version: 0, state: seeded };
    }

    const headEntry = this.#headState.value;
    const logVersion = headEntry.logVersion;
    const metaVersion = headEntry.snapshotVersion;

    // Load the small state the head points at - reconstructing the key index from its chunked v2
    // rows - or MIGRATE a store written by either legacy layout in place:
    //   v2 (current): meta row with indexLayout - maps rebuilt from bucket rows + pending deltas.
    //   v1 (retired): meta row with the maps INLINE (absent indexLayout) - chunked once, in place.
    //   v0 (retired): whole-state snapshot row where the meta row is missing - split + chunked
    //                 directly to v2 in one activation.
    const metaEntry = await this.#readMeta(metaVersion);
    let meta: DatastoreMetaState;
    let layout: KeyIndexLayout;
    if (metaEntry === undefined) {
      const legacy = await this.#readLegacySnapshot(metaVersion);
      if (legacy !== undefined) {
        ({ meta, layout } = await this.#migrateLegacySnapshot(metaVersion, legacy));
      } else {
        // Mirrors the retired layout's missing-snapshot tolerance; an in-range missing LOG entry
        // below still fails loudly as corruption.
        meta = datastoreMetaStateEmpty(0n);
        layout = createEmptyKeyIndexLayout(datastoreGrainInternals.creationBucketCount);
      }
    } else if (metaEntry.indexLayout === undefined) {
      ({ meta, layout } = await this.#migrateInlineIndex(metaVersion, metaEntry));
    } else {
      layout = metaEntry.indexLayout;
      const { forward, reverse } = await this.#reconstructIndex(layout);
      meta = { ...metaEntry.meta, forwardKeys: forward, reverseKeys: reverse };
    }

    // Replay the log tail (metaVersion .. logVersion] folding the small state AND the dirty buffer.
    // The range is contiguous BY CONSTRUCTION (head is written last, the commit point), so a missing
    // in-range entry is corruption - fail loudly rather than silently fold a lossy state.
    const dirty = new Map<string, GraphShardState>();
    const recent: LogEvent[] = [];
    let floor = meta.headRevision;
    for (let v = metaVersion + 1; v <= logVersion; v += 1) {
      const ev = await this.#readLogEvent(v);
      if (ev === undefined) {
        throw new Error(
          `datastore log corruption: missing log entry ${v} in [${metaVersion + 1}..${logVersion}]`,
        );
      }

      if (ev.gcFloor === undefined) {
        // SEEDING RULE (recovery form): every key the event touches gets an entry seeded from its
        // storage row as FIRST encountered - resolved through the CURRENT fold point's index map,
        // exactly like the serve path. A key that is unindexed (or indexed at NO_ROW_VERSION) seeds
        // empty even if a physical row exists somewhere.
        //
        // NO DOUBLE-FOLD IS POSSIBLE: the seeds come from rows the OLD meta references, and the
        // index versions used here stay the OLD meta's throughout the replay (`metaFoldApplyEvent`
        // only ADDS keys at NO_ROW_VERSION and never bumps a version - bumps happen only at
        // flushes), so each tail event folds into a base that strictly predates it, exactly once.
        for (const key of metaFoldTouchedKeys(ev)) {
          if (dirty.has(key)) continue;
          const rowVersion = tryGetRowVersion(meta, key);
          const stored =
            rowVersion !== undefined && rowVersion >= 0
              ? await this.#readShardRow(rowVersion, key)
              : undefined;
          dirty.set(key, stored ?? GRAPH_SHARD_STATE_EMPTY);
        }
        for (const key of metaFoldTouchedKeys(ev))
          dirty.set(key, shardFoldApplyEvent(dirty.get(key)!, ev, graphShardGrainKeyParse(key)));
      } else {
        // A GC event touches no keys; it folds into every entry already present (clean keys compact
        // lazily - see the class remarks).
        for (const key of [...dirty.keys()])
          dirty.set(key, shardFoldApplyEvent(dirty.get(key)!, ev, graphShardGrainKeyParse(key)));
      }

      meta = metaFoldApplyEvent(meta, ev);
      floor = this.#addPending(recent, floor, ev, meta.headRevision);
    }

    // PUBLISH (no await below this point in the branch).
    this.#logVersion = logVersion;
    this.#metaVersion = metaVersion;
    this.#storedMeta = meta;
    this.#indexLayout = layout;
    this.#dirty = dirty;
    this.#recent = recent;
    this.#recentFloorRevision = floor;
    return { version: logVersion, state: meta };
  }

  /**
   * One-time in-place migration of a store written by the retired whole-state layout (v0), landing
   * DIRECTLY on durable layout v2: split the legacy snapshot's rows into per-key shard rows (BOTH
   * directions), build the key index, persist ALL its bucket rows at the migration version (empties
   * included, so `deltaFloorVersion` starts at the migration version), persist the SLIM meta row,
   * then clear the legacy snapshot best-effort. One-time O(N) and crash-safe: every versioned row
   * goes read-then-write, the meta row is the commit point, and a crash between meta write and
   * legacy clear leaks one unreferenced row.
   */
  async #migrateLegacySnapshot(
    version: number,
    legacy: DatastoreGrainState,
  ): Promise<{ meta: DatastoreMetaState; layout: KeyIndexLayout }> {
    this.#logger.info(
      `datastore grain: migrating legacy whole-state snapshot v${version} (${legacy.relationships.length} rows) to the per-key shard layout`,
    );

    const byKey = new Map<string, StoredRelationshipWire[]>();
    // The migrated rows are written under the migration's own meta version, and the index maps point
    // every key at it - the same version-qualified discipline as a flush.
    const forward = new Map<string, number>();
    const reverse = new Map<string, number>();
    for (const row of legacy.relationships) {
      const forwardKey = metaFoldForwardKeyOf(row.relationship);
      const reverseKey = metaFoldReverseKeyOf(row.relationship);
      forward.set(forwardKey, version);
      reverse.set(reverseKey, version);
      addRow(byKey, forwardKey, row);
      addRow(byKey, reverseKey, row);
    }

    for (const [key, rows] of byKey) {
      await this.#writeShardRow(version, key, {
        appliedRevision: legacy.headRevision,
        gcFloor: legacy.gcFloor,
        rows,
      });
    }

    const meta: DatastoreMetaState = {
      headRevision: legacy.headRevision,
      schemas: legacy.schemas,
      counters: legacy.counters,
      gcFloor: legacy.gcFloor,
      forwardKeys: forward,
      reverseKeys: reverse,
    };

    // Chunk the freshly built index into v2 bucket rows + the slim meta (all before the meta write,
    // which is the commit point - bucket rows orphaned by a crash are overwritten on re-migration).
    const layout = await this.#writeFullIndexCoverage(version, meta);
    await this.#writeMeta(version, slimMetaEntry(meta, version, layout));

    try {
      await this.#clearLegacySnapshot(version);
    } catch {
      // Best-effort, like compaction: the meta row already supersedes the legacy snapshot, so a
      // failed clear only leaks one unreferenced storage row.
    }

    return { meta, layout };
  }

  /**
   * One-time in-place migration of a v1 meta row (key maps INLINE, absent `indexLayout`) to durable
   * layout v2: write ALL bucket rows at the migration version from the inline maps, then OVERWRITE
   * `meta/{version}` in place with the slim v2 entry - the migration's commit point, and the one
   * deliberate exception to the meta row's write-once rule (etag-correct via the read-then-write in
   * {@link writeMeta}). Shard rows are untouched: only the index's durable representation changes.
   */
  async #migrateInlineIndex(
    version: number,
    v1: DatastoreMetaEntry,
  ): Promise<{ meta: DatastoreMetaState; layout: KeyIndexLayout }> {
    const meta = v1.meta;
    this.#logger.info(
      `datastore grain: migrating v1 inline key-index meta v${version} (${meta.forwardKeys.size} forward / ${meta.reverseKeys.size} reverse keys) to the chunked v2 layout`,
    );

    const layout = await this.#writeFullIndexCoverage(version, meta);
    await this.#writeMeta(version, slimMetaEntry(meta, version, layout));
    return { meta, layout };
  }

  /**
   * Migration helper: writes ALL 2B bucket rows from the meta's in-memory key maps (empty buckets
   * included - full coverage is what lets `deltaFloorVersion` start at the migration version instead
   * of waiting a whole rotation), fanned out in BOUNDED chunks, and returns the layout describing
   * them.
   */
  async #writeFullIndexCoverage(
    version: number,
    meta: DatastoreMetaState,
  ): Promise<KeyIndexLayout> {
    const bucketCount = datastoreGrainInternals.creationBucketCount;
    const forwardBuckets = partitionIntoBuckets(meta.forwardKeys, bucketCount);
    const reverseBuckets = partitionIntoBuckets(meta.reverseKeys, bucketCount);

    // A migration can run at meta version 0 (a legacy store that never crossed a flush boundary).
    // Bucket rows are written - and their versions recorded - at `max(version, 1)` so a recorded
    // bucket version can never equal the never-written NO_BUCKET_ROW (0) sentinel: recording 0 would
    // make the next recovery treat every freshly written bucket row as "never written" and silently
    // reconstruct an EMPTY index. Version 1 cannot collide with any real flush version.
    const bucketVersion = Math.max(version, 1);

    // BOUNDED fan-out: full coverage is 2B rows, and a single 2B-wide `Promise.all` would ask a real
    // provider for that many concurrent commands at migration time - chunk the batch instead.
    let writes: Promise<void>[] = [];
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      writes.push(
        this.#writeIndexBucket(bucketVersion, true, bucket, { entries: forwardBuckets[bucket]! }),
      );
      writes.push(
        this.#writeIndexBucket(bucketVersion, false, bucket, { entries: reverseBuckets[bucket]! }),
      );
      if (writes.length >= MIGRATION_WRITE_CONCURRENCY) {
        await Promise.all(writes);
        writes = [];
      }
    }
    await Promise.all(writes);

    const versions = new Array<number>(bucketCount).fill(bucketVersion);
    return {
      bucketCount,
      forwardBucketVersions: versions,
      // The C# passes ONE `ImmutableArray` twice, which is safe because it is immutable. A shared
      // JS array is not, and the rotation writes one direction at a time.
      reverseBucketVersions: [...versions],
      nextBucket: 0,
      deltaFloorVersion: bucketVersion,
      deltaVersions: [],
    };
  }

  /**
   * Reconstructs the full in-memory key-index maps from the chunked v2 rows: all 2B bucket rows read
   * at their recorded versions (fanned out with `Promise.all`; a bucket at `NO_BUCKET_ROW` has never
   * been written and is empty), then the pending delta rows overlaid in ascending version order -
   * entries applied last-wins, tombstones deleting.
   *
   * NO DOUBLE-APPLY IS POSSIBLE: bucket rows and delta rows both carry ABSOLUTE key->rowVersion
   * entries (never increments), so the overlay is idempotent last-wins.
   */
  async #reconstructIndex(
    layout: KeyIndexLayout,
  ): Promise<{ forward: Map<string, number>; reverse: Map<string, number> }> {
    const forwardReads: Promise<KeyIndexBucketEntry | undefined>[] = [];
    const reverseReads: Promise<KeyIndexBucketEntry | undefined>[] = [];
    for (let bucket = 0; bucket < layout.bucketCount; bucket += 1) {
      const fv = layout.forwardBucketVersions[bucket]!;
      const rv = layout.reverseBucketVersions[bucket]!;
      forwardReads.push(
        fv === NO_BUCKET_ROW ? Promise.resolve(undefined) : this.#readIndexBucket(fv, true, bucket),
      );
      reverseReads.push(
        rv === NO_BUCKET_ROW
          ? Promise.resolve(undefined)
          : this.#readIndexBucket(rv, false, bucket),
      );
    }
    const forwardRows = await Promise.all(forwardReads);
    const reverseRows = await Promise.all(reverseReads);

    const forward = new Map<string, number>();
    const reverse = new Map<string, number>();
    for (let bucket = 0; bucket < layout.bucketCount; bucket += 1) {
      // A recorded version whose row is MISSING is corruption (referenced bucket rows are never
      // cleared - only superseded versions are) - fail loudly like a missing in-range log entry.
      const fv = layout.forwardBucketVersions[bucket]!;
      if (fv !== NO_BUCKET_ROW) {
        const entry = forwardRows[bucket]?.entries;
        if (entry === undefined)
          throw new Error(
            `datastore index corruption: missing bucket row indexb/${fv}/f/${bucket}`,
          );
        for (const [key, rowVersion] of entry) forward.set(key, rowVersion); // buckets are disjoint
      }
      const rv = layout.reverseBucketVersions[bucket]!;
      if (rv !== NO_BUCKET_ROW) {
        const entry = reverseRows[bucket]?.entries;
        if (entry === undefined)
          throw new Error(
            `datastore index corruption: missing bucket row indexb/${rv}/r/${bucket}`,
          );
        for (const [key, rowVersion] of entry) reverse.set(key, rowVersion);
      }
    }

    // Overlay the pending deltas in ascending version order. The order is LOAD-BEARING for
    // tombstone-then-recreate - an earlier delta's tombstone must be applied before a later delta's
    // re-add of the same key - so VERIFY the invariant defensively before replaying: a violated
    // order means a corrupted layout, and replaying it would produce a WRONG index rather than a
    // loud failure.
    for (let i = 1; i < layout.deltaVersions.length; i += 1) {
      if (layout.deltaVersions[i]! <= layout.deltaVersions[i - 1]!) {
        throw new Error(
          "datastore index corruption: pending delta versions are not strictly ascending " +
            `(${layout.deltaVersions[i - 1]} followed by ${layout.deltaVersions[i]}) - ` +
            "replaying them in this order would reconstruct a wrong index",
        );
      }
    }
    for (const deltaVersion of layout.deltaVersions) {
      const delta = await this.#readIndexDelta(deltaVersion);
      if (delta === undefined)
        throw new Error(`datastore index corruption: missing delta row indexd/${deltaVersion}`);
      applyDelta(forward, delta.forwardEntries);
      applyDelta(reverse, delta.reverseEntries);
    }

    return { forward, reverse };
  }

  /** @inheritdoc */
  async applyUpdatesToStorage(
    updates: readonly LogEvent[],
    expectedVersion: number,
  ): Promise<boolean> {
    if (updates === undefined || updates === null) throw new Error("updates must not be null");

    // Optimistic concurrency on the CONTIGUOUS LOG VERSION (distinct from the timestamp head
    // revision): refuse if storage has moved on. This is the log-level guard the adaptor relies on.
    if (this.#logVersion !== expectedVersion) return false;

    // Fold forward into LOCALS only (never touch `JournaledGrain.state` here - that would re-enter
    // the consistency adaptor mid-confirm - and never touch the shared fields yet either; see the
    // publication-discipline remark on `readStateFromStorage`).
    let foldedMeta = this.#storedMeta;
    const foldedDirty =
      updates.length > 0 ? new Map<string, GraphShardState>(this.#dirty) : undefined;
    let version = this.#logVersion;
    const pending: LogEvent[] = [];
    for (const ev of updates) {
      version += 1;
      // Log entries are write-once per COMMITTED version, but a crashed append attempt (row written,
      // head never advanced) leaves an orphan at this exact versioned name that the boundary's retry
      // must overwrite.
      await this.#writeLogEntry(version, ev);

      if (ev.gcFloor === undefined) {
        for (const key of metaFoldTouchedKeys(ev)) {
          let entry = foldedDirty!.get(key);
          if (entry === undefined) {
            // Belt-and-braces: the seeding rule says `commit` pre-seeded every touched key, so this
            // read should never run; if a future caller breaches the contract, seeding here (from
            // the pre-event index, exactly like recovery) is still correct.
            const rowVersion = tryGetRowVersion(foldedMeta, key);
            const stored =
              rowVersion !== undefined && rowVersion >= 0
                ? await this.#readShardRow(rowVersion, key)
                : undefined;
            entry = stored ?? GRAPH_SHARD_STATE_EMPTY;
          }
          foldedDirty!.set(key, shardFoldApplyEvent(entry, ev, graphShardGrainKeyParse(key)));
        }
      } else {
        for (const key of [...foldedDirty!.keys()])
          foldedDirty!.set(
            key,
            shardFoldApplyEvent(foldedDirty!.get(key)!, ev, graphShardGrainKeyParse(key)),
          );
      }

      foldedMeta = metaFoldApplyEvent(foldedMeta, ev);
      pending.push(ev);
    }

    // Periodically FLUSH + compact: bound the replay tail on reactivation and the in-memory window.
    //
    // FLUSH WRITE ORDER AND CRASH WINDOWS (durable layout v2). Shard rows, key-index bucket rows and
    // the per-flush index delta row are all VERSION-QUALIFIED and write-once per version, and a row
    // of ANY of those families is reachable only through the meta row's layout or, transitively,
    // through the index entries those rows reconstruct. The order is:
    //   1. log rows           - already written above, one per event.
    //   2. IN PARALLEL        - all dirty shard rows, the `indexd/{flushVersion}` delta row, and
    //      exactly ONE bucket row per direction in round-robin rotation. Independent write-once
    //      storage keys with NO ordering requirement among them.
    //   3. meta/{flushVersion} - the SLIM v2 meta: head/schemas/counters/floor plus the index
    //      LAYOUT. NO inline key maps, so the row's size is independent of graph cardinality.
    //   4. head               - THE commit point (the only in-place row).
    //   5. post-commit, best-effort clears; then the dirty buffer clears.
    //
    // CRASH BEFORE STEP 4: the durable head still names the OLD meta, whose layout references only
    // OLD-version bucket/delta rows and whose reconstructed index references only OLD-version shard
    // rows - and step 2 never touched any of those. So the in-flight batch's content is UNREACHABLE
    // in ALL THREE row families. CRASH AT/AFTER STEP 4: committed; a crash inside step 5 at worst
    // leaks superseded rows. Physical clears must NEVER run before step 4: clearing a
    // previous-version row first would LOSE data on crash.
    const oldMetaVersion = this.#metaVersion;
    let newMetaVersion = this.#metaVersion;
    let flushBoundaryRevision = -1n;
    let supersededRows: Array<{ key: string; rowVersion: number }> | undefined;
    let deadDeltaVersions: number[] | undefined;
    let rotatedBucket = -1;
    let supersededForwardBucketVersion = NO_BUCKET_ROW;
    let supersededReverseBucketVersion = NO_BUCKET_ROW;
    let newLayout: KeyIndexLayout | undefined;
    // INTEGER division on BOTH sides (`version / FlushInterval > _metaVersion / FlushInterval`), so
    // `Math.floor`, never `/`.
    const flushing =
      updates.length > 0 &&
      Math.floor(version / FLUSH_INTERVAL) > Math.floor(this.#metaVersion / FLUSH_INTERVAL);
    if (flushing) await this.#shardIo.wait();
    try {
      if (flushing) {
        // Lazy GC materializes here: every dirty entry is collected at the CURRENT floor before its
        // row is written, so flushed rows never carry sub-floor dead history.
        const flushVersion = version;
        const layout = this.#indexLayout;
        const forwardIndex = new Map(foldedMeta.forwardKeys);
        const reverseIndex = new Map(foldedMeta.reverseKeys);
        supersededRows = [];
        const deltaForward = new Map<string, number>();
        const deltaReverse = new Map<string, number>();
        // Step 2's parallel batch: every task targets its OWN write-once versioned storage key, so
        // there is no ordering requirement among them and no shared holder/etag - the commit point
        // is still the head row alone.
        const batch: Promise<void>[] = [];
        for (const [key, entry] of foldedDirty!) {
          const collected = shardFoldCollectBelow(
            entry,
            foldedMeta.headRevision,
            foldedMeta.gcFloor,
          );

          // The key's previous durable row (if any) is superseded whether the key is rewritten under
          // the new version or dropped as empty. Its version comes from the PRE-flush index - the
          // only place it survives the bump/removal below - and its physical clear is deferred to
          // step 5 (post-commit).
          const previousVersion = tryGetRowVersion(foldedMeta, key);
          if (previousVersion !== undefined && previousVersion >= 0)
            supersededRows.push({ key, rowVersion: previousVersion });

          const isForward = graphShardGrainKeyParse(key).direction === "forward";
          if (collected.rows.length === 0) {
            // The key's current state is empty: drop it from the index (making any old row
            // unreachable at the commit point), write nothing at the new version, and record an
            // explicit TOMBSTONE in the delta - a recovery whose bucket row for this key predates
            // this flush must delete it on replay, or the dropped key would RESURRECT.
            if (isForward) {
              forwardIndex.delete(key);
              deltaForward.set(key, KEY_INDEX_TOMBSTONE);
            } else {
              reverseIndex.delete(key);
              deltaReverse.set(key, KEY_INDEX_TOMBSTONE);
            }
            continue;
          }

          batch.push(this.#writeShardRow(flushVersion, key, collected));

          // The flush is where index VERSIONS move (the fold only adds keys at NO_ROW_VERSION): bump
          // the written key's entry to the flush version, and mirror the bump into the delta row so
          // recovery sees it even when the key's bucket is not rotated for many more flushes.
          if (isForward) {
            forwardIndex.set(key, flushVersion);
            deltaForward.set(key, flushVersion);
          } else {
            reverseIndex.set(key, flushVersion);
            deltaReverse.set(key, flushVersion);
          }
        }

        foldedMeta = { ...foldedMeta, forwardKeys: forwardIndex, reverseKeys: reverseIndex };

        // Round-robin bucket rotation: one bucket per direction is rewritten with its FULL current
        // entries from the POST-flush in-memory maps. Selecting the bucket's members is an in-memory
        // O(N) scan with a stable hash per key - CPU only, never serialization or IO of the maps.
        rotatedBucket = layout.nextBucket;
        supersededForwardBucketVersion = layout.forwardBucketVersions[rotatedBucket]!;
        supersededReverseBucketVersion = layout.reverseBucketVersions[rotatedBucket]!;
        batch.push(
          this.#writeIndexBucket(
            flushVersion,
            true,
            rotatedBucket,
            bucketEntries(forwardIndex, rotatedBucket, layout.bucketCount),
          ),
        );
        batch.push(
          this.#writeIndexBucket(
            flushVersion,
            false,
            rotatedBucket,
            bucketEntries(reverseIndex, rotatedBucket, layout.bucketCount),
          ),
        );
        batch.push(
          this.#writeIndexDelta(flushVersion, {
            forwardEntries: deltaForward,
            reverseEntries: deltaReverse,
          }),
        );

        await Promise.all(batch);

        // The new layout: bucket versions bumped for the rotated pair; `deltaFloorVersion` is the
        // MIN over BOTH directions' bucket versions (a delta at or below it is covered by every
        // bucket row and is dead); the pending list gains this flush and sheds everything at or
        // below the floor.
        const forwardVersions = [...layout.forwardBucketVersions];
        forwardVersions[rotatedBucket] = flushVersion;
        const reverseVersions = [...layout.reverseBucketVersions];
        reverseVersions[rotatedBucket] = flushVersion;
        const deltaFloor = Math.min(Math.min(...forwardVersions), Math.min(...reverseVersions));
        const allDeltas = [...layout.deltaVersions, flushVersion];
        deadDeltaVersions = allDeltas.filter((v) => v <= deltaFloor);
        const pendingDeltas = allDeltas.filter((v) => v > deltaFloor);
        newLayout = {
          ...layout,
          forwardBucketVersions: forwardVersions,
          reverseBucketVersions: reverseVersions,
          nextBucket: (rotatedBucket + 1) % layout.bucketCount,
          deltaFloorVersion: deltaFloor,
          deltaVersions: pendingDeltas,
        };

        // The SLIM v2 meta row: the key maps are STRIPPED (they live in the bucket/delta rows the
        // layout describes), so this row's size is independent of graph cardinality.
        await this.#writeMeta(flushVersion, {
          meta: {
            ...foldedMeta,
            forwardKeys: new Map<string, number>(),
            reverseKeys: new Map<string, number>(),
          },
          flushedThroughLogVersion: flushVersion,
          indexLayout: newLayout,
        });
        newMetaVersion = flushVersion;
        flushBoundaryRevision = foldedMeta.headRevision;

        this.#metrics?.recordFlush();
      }

      // The head pointer is the commit point: write it AFTER the log entries (+ flushed rows/meta)
      // so a crash mid-write never advertises a version whose log entries are missing or a flush not
      // yet durable.
      await this.#writeHead({
        logVersion: version,
        headRevision: foldedMeta.headRevision,
        snapshotVersion: newMetaVersion,
      });

      // COMMITTED. PUBLISH IN ONE SYNCHRONOUS BLOCK - no await from here to the next statement with
      // an await - so an interleaved read either sees the pre-commit fields (still the PREVIOUS
      // commit) or, once this block runs, the fully-applied new commit: the small state, the dirty
      // buffer and the recent window advance as ONE unit. This IS the atomicity argument for the
      // read side: there is no yield point inside the block for a read to land on.
      this.#logVersion = version;
      this.#storedMeta = foldedMeta;
      if (newLayout !== undefined) this.#indexLayout = newLayout;
      if (foldedDirty !== undefined) this.#dirty = foldedDirty;
      this.#recent = [...this.#recent, ...pending];
      this.#trimRecent(foldedMeta.headRevision);

      // Post-commit compaction. Clearing AFTER the commit point keeps a crash recoverable (the worst
      // case leaks an entry, never loses one).
      if (newMetaVersion > oldMetaVersion) {
        // BEST-EFFORT, and the bare swallow is deliberate: an exception escaping here would make the
        // log-consistency adaptor retry `applyUpdatesToStorage`, hit the version guard, and report a
        // FULLY COMMITTED event as failed - the caller would then re-run its whole transaction
        // against a base that already contains its own write.
        try {
          for (let v = oldMetaVersion + 1; v <= newMetaVersion; v += 1)
            await this.#clearLogEntry(v);
          await this.#clearMeta(oldMetaVersion);
          for (const { key, rowVersion } of supersededRows!)
            await this.#clearShardRow(rowVersion, key);
          // The rotated buckets' previous version rows are superseded by the pair written under the
          // new flush version; deltas at or below the new floor are covered by bucket rows and dead.
          if (supersededForwardBucketVersion !== NO_BUCKET_ROW)
            await this.#clearIndexBucket(supersededForwardBucketVersion, true, rotatedBucket);
          if (supersededReverseBucketVersion !== NO_BUCKET_ROW)
            await this.#clearIndexBucket(supersededReverseBucketVersion, false, rotatedBucket);
          for (const deltaVersion of deadDeltaVersions!) await this.#clearIndexDelta(deltaVersion);
        } catch {
          // A leaked entry/meta/row is unreferenced by the committed head+index and harmless to
          // recovery (unindexed rows are never read).
        }

        // Its own contiguous SYNCHRONOUS field group. Unconditional: the committed head already
        // points at the new meta, so in-memory retention advances whether or not the clears
        // succeeded. The dirty buffer clears because every entry's row (or absence) is now durable
        // and current.
        this.#metaVersion = newMetaVersion;
        this.#recentFloorRevision = maxBig(this.#recentFloorRevision, flushBoundaryRevision);
        this.#recent = this.#recent.filter((e) => e.revision > this.#recentFloorRevision);
        this.#dirty = new Map<string, GraphShardState>();
      }
    } finally {
      if (flushing) this.#shardIo.release();
    }

    return true;
  }

  /** @inheritdoc */
  clearStoredState(): Promise<void> {
    return this.#storage.clear(HEAD_STATE_NAME, this.id, this.#headState);
  }

  // --- storage helpers ---

  async #readLogEvent(version: number): Promise<LogEvent | undefined> {
    return this.#readRow<LogEvent>(`${LOG_STATE_PREFIX}${version}`);
  }

  // The head entry is rewritten in place through the held holder so its etag carries across writes
  // (the commit point). Log entries, meta entries, shard rows and index bucket/delta rows are
  // version-qualified - write-once per COMMITTED version - but a crashed attempt can orphan an entry
  // at a versioned name a retry must write again, so all of them tolerate an existing row with no
  // long-lived holder (a per-row holder cache would grow O(touched keys) memory). Meta, shard and
  // index rows go read-then-write; log entries - the per-commit hot path - attempt the single-RTT
  // fresh write first and pay the read only on the rare orphan collision.

  async #writeLogEntry(version: number, ev: LogEvent): Promise<void> {
    const name = `${LOG_STATE_PREFIX}${version}`;
    // HOT PATH - one storage RTT: in the overwhelmingly common case this versioned name has never
    // been written, so a fresh etag-less holder is a valid insert and the write succeeds first try.
    // Only when a CRASHED prior append attempt orphaned a row at this exact name does the provider
    // reject the absent etag; then, and ONLY then, fall back to the etag-tolerant read-then-write.
    // Catching anything wider than the provider's conflict error would hide real failures.
    const entry: StateHolder<LogEvent> = { value: ev, exists: false };
    try {
      await this.#storage.write(name, this.id, entry);
    } catch (error) {
      if (!(error instanceof InconsistentStateError)) throw error;
      const existing: StateHolder<LogEvent> = {
        value: undefined as unknown as LogEvent,
        exists: false,
      };
      await this.#storage.read(name, this.id, existing);
      existing.value = ev;
      await this.#storage.write(name, this.id, existing);
    }
  }

  #writeHead(entry: LogHeadEntry): Promise<void> {
    this.#headState.value = entry;
    return this.#storage.write(HEAD_STATE_NAME, this.id, this.#headState);
  }

  #writeMeta(version: number, entry: DatastoreMetaEntry): Promise<void> {
    return this.#writeRow(`${META_STATE_PREFIX}${version}`, entry);
  }

  #readMeta(version: number): Promise<DatastoreMetaEntry | undefined> {
    return this.#readRow<DatastoreMetaEntry>(`${META_STATE_PREFIX}${version}`);
  }

  #readShardRow(rowVersion: number, shardKey: string): Promise<GraphShardState | undefined> {
    return this.#readRow<GraphShardState>(shardRowName(rowVersion, shardKey));
  }

  #writeShardRow(rowVersion: number, shardKey: string, state: GraphShardState): Promise<void> {
    return this.#writeRow(shardRowName(rowVersion, shardKey), state);
  }

  #readIndexBucket(
    version: number,
    forward: boolean,
    bucket: number,
  ): Promise<KeyIndexBucketEntry | undefined> {
    return this.#readRow<KeyIndexBucketEntry>(indexBucketRowName(version, forward, bucket));
  }

  #writeIndexBucket(
    version: number,
    forward: boolean,
    bucket: number,
    state: KeyIndexBucketEntry,
  ): Promise<void> {
    return this.#writeRow(indexBucketRowName(version, forward, bucket), state);
  }

  #readIndexDelta(version: number): Promise<KeyIndexDeltaEntry | undefined> {
    return this.#readRow<KeyIndexDeltaEntry>(indexDeltaRowName(version));
  }

  #writeIndexDelta(version: number, state: KeyIndexDeltaEntry): Promise<void> {
    return this.#writeRow(indexDeltaRowName(version), state);
  }

  #clearIndexBucket(version: number, forward: boolean, bucket: number): Promise<void> {
    return this.#clearRow(indexBucketRowName(version, forward, bucket));
  }

  #clearIndexDelta(version: number): Promise<void> {
    return this.#clearRow(indexDeltaRowName(version));
  }

  #readLegacySnapshot(version: number): Promise<DatastoreGrainState | undefined> {
    return this.#readRow<DatastoreGrainState>(`${LEGACY_SNAPSHOT_STATE_PREFIX}${version}`);
  }

  #clearLegacySnapshot(version: number): Promise<void> {
    return this.#clearRow(`${LEGACY_SNAPSHOT_STATE_PREFIX}${version}`);
  }

  #clearMeta(version: number): Promise<void> {
    return this.#clearRow(`${META_STATE_PREFIX}${version}`);
  }

  #clearShardRow(rowVersion: number, shardKey: string): Promise<void> {
    return this.#clearRow(shardRowName(rowVersion, shardKey));
  }

  #clearLogEntry(version: number): Promise<void> {
    return this.#clearRow(`${LOG_STATE_PREFIX}${version}`);
  }

  // The three shapes above collapse to these, because every C# helper differs only in its state
  // name and the type parameter of its `GrainState<T>`.

  async #readRow<T>(name: string): Promise<T | undefined> {
    const entry: StateHolder<T> = { value: undefined as unknown as T, exists: false };
    await this.#storage.read(name, this.id, entry);
    return entry.exists ? entry.value : undefined;
  }

  async #writeRow<T>(name: string, value: T): Promise<void> {
    const entry: StateHolder<T> = { value: undefined as unknown as T, exists: false };
    await this.#storage.read(name, this.id, entry);
    entry.value = value;
    await this.#storage.write(name, this.id, entry);
  }

  // Clears go through a READ-then-clear so the holder carries the CURRENT storage etag: providers
  // enforce the etag on delete too, and these version-qualified entries were written through
  // transient holders whose minted etags were discarded. Reading a missing/already-cleared entry
  // yields an absent etag, which every provider accepts for a no-op clear.
  async #clearRow(name: string): Promise<void> {
    const entry: StateHolder<unknown> = { value: undefined, exists: false };
    await this.#storage.read(name, this.id, entry);
    await this.#storage.clear(name, this.id, entry);
  }

  // --- recent-events window ---

  /**
   * The LOCAL-list counterpart of {@link trimRecent}, used by {@link readStateFromStorage} while it
   * is still folding into locals (before its single publish block) - it NEVER touches the shared
   * `#recent`/`#recentFloorRevision` fields. Deliberately a DUPLICATE of `trimRecent` rather than a
   * shared helper: unifying them would have recovery write through to the published fields.
   *
   * `ref long floor` -> the new floor is RETURNED, and `pending` is mutated in place.
   */
  #addPending(pending: LogEvent[], floor: bigint, ev: LogEvent, head: bigint): bigint {
    pending.push(ev);
    const newFloor = maxBig(floor, head - this.#gcWindowNanos);
    if (newFloor <= floor) return floor;
    // `List.RemoveAll` in place, so the caller's array identity is preserved.
    const kept = pending.filter((e) => e.revision > newFloor);
    pending.length = 0;
    // A loop for the same reason as `readState`: `_recent.AddRange(pending)` has no argument-count
    // bound, and the recent-log buffer holds everything inside the GC window.
    for (const e of kept) pending.push(e);
    return newFloor;
  }

  /**
   * Raises the floor for anything aged past the GC window (never lowers it - compaction may have set
   * it higher), and drops the now-unretained events. `#recent` always holds exactly the events above
   * the floor. Only ever called from within a synchronous publish block (see
   * {@link applyUpdatesToStorage}) or from {@link runGc}'s own append.
   */
  #trimRecent(head: bigint): void {
    const floor = maxBig(this.#recentFloorRevision, head - this.#gcWindowNanos);
    if (floor <= this.#recentFloorRevision) return;
    this.#recentFloorRevision = floor;
    this.#recent = this.#recent.filter((e) => e.revision > this.#recentFloorRevision);
  }
}

/** The options bag standing in for the C# constructor's DI parameters. */
export interface DatastoreGrainOptions {
  /** The `datastore` grain-storage provider (`[FromKeyedServices("datastore")] IGrainStorage`). */
  readonly storage?: GrainStorage | undefined;
  /** `ILogger<DatastoreGrain>`; defaults to Thresh's no-op logger. */
  readonly logger?: Logger | undefined;
  /** `IOptions<DatastoreGcOptions>`; every member defaults. */
  readonly gcOptions?: DatastoreGcOptions | undefined;
  /** The optional sequencer-side inbound-call counters. */
  readonly metrics?: ISequencerMetrics | undefined;
}

/**
 * `internal static int CreationBucketCount` - the bucket count used wherever a key-index LAYOUT IS
 * CREATED (the fresh-store seed, the missing-meta fallback, and the two migrations' full-coverage
 * write). TEST SEAM ONLY: production always leaves it at `DEFAULT_BUCKET_COUNT`; a test may lower it
 * (e.g. to 2) to make a full rotation - and therefore delta pruning - reachable in a handful of
 * flush boundaries. It applies ONLY at layout creation: changing it for an EXISTING store is
 * FORBIDDEN, because `bucket = hash % count` is part of the durable contract and a different count
 * would strand every stored bucket row.
 *
 * A mutable holder object, not a `let` export: an ES module binding cannot be reassigned from
 * outside, so a test seam has to hang off something.
 */
export const datastoreGrainInternals: { creationBucketCount: number } = {
  creationBucketCount: DEFAULT_BUCKET_COUNT,
};

/** The name of the periodic MVCC-GC reminder registered in `onActivate`. */
const GC_REMINDER_NAME = "mvcc-gc";

/** Storage state-name of the durable head pointer (one row, rewritten in place - the commit point). */
const HEAD_STATE_NAME = "head";

/** Per-version small-state entry prefix: `meta/{version}` (write-once, so crash-safe). */
const META_STATE_PREFIX = "meta/";

/**
 * Per-key shard row prefix. Shard rows are VERSION-QUALIFIED and write-once per version:
 * `shard/{rowVersion}/` + the escaped `GraphShardGrainKey` string, where `rowVersion` is the meta
 * (flush) version the row was written under.
 */
const SHARD_STATE_PREFIX = "shard/";

/** Key-index BUCKET row prefix (durable layout v2): `indexb/{version}/{dir}/{bucket}`. */
const INDEX_BUCKET_STATE_PREFIX = "indexb/";

/** Key-index DELTA row prefix (durable layout v2): `indexd/{version}`. */
const INDEX_DELTA_STATE_PREFIX = "indexd/";

/**
 * The RETIRED whole-state snapshot prefix (`snapshot/{version}`). Only read during the one-time
 * activation MIGRATION of a store written by the previous layout, then cleared best-effort.
 */
const LEGACY_SNAPSHOT_STATE_PREFIX = "snapshot/";

/** Per-event log entry state-name prefix: `log/{version}`. */
const LOG_STATE_PREFIX = "log/";

/**
 * Flush the dirty buffer (and compact the log) every N appended events - the same 64-event cadence
 * the retired whole-state snapshots used, so the `readFrom` retention contract (its floor is the
 * flush boundary) is unchanged for shard grains and Watch.
 */
const FLUSH_INTERVAL = 64;

/** The migration's bounded write fan-out (`const int migrationWriteConcurrency = 64`). */
const MIGRATION_WRITE_CONCURRENCY = 64;

/**
 * How long a watcher registration lives without a `subscribeWatch` refresh. 10x the hubs' heartbeat
 * interval, so a silo must miss many heartbeats before its watcher is dropped.
 */
const WATCHER_EXPIRY: Duration = { seconds: 10 };

/** The storage state-name of one version-qualified shard row. */
function shardRowName(rowVersion: number, shardKey: string): string {
  return `${SHARD_STATE_PREFIX}${rowVersion}/${shardKey}`;
}

/** The storage state-name of one version-qualified key-index bucket row. */
function indexBucketRowName(version: number, forward: boolean, bucket: number): string {
  return `${INDEX_BUCKET_STATE_PREFIX}${version}/${forward ? "f" : "r"}/${bucket}`;
}

/** The storage state-name of one per-flush key-index delta row. */
function indexDeltaRowName(version: number): string {
  return `${INDEX_DELTA_STATE_PREFIX}${version}`;
}

/**
 * Resolves a shard key through the meta key index (forward or reverse - a key string is
 * direction-prefixed, so it lives in exactly one map). Returns `undefined` for an unindexed key; a
 * present result may still be `NO_ROW_VERSION` (indexed, but no durable row yet - the dirty buffer
 * covers it).
 *
 * `bool TryX(..., out T)` -> `T | undefined`, per the port guide.
 */
function tryGetRowVersion(meta: DatastoreMetaState, shardKey: string): number | undefined {
  return meta.forwardKeys.get(shardKey) ?? meta.reverseKeys.get(shardKey);
}

/** `static CommitReply Rejected(kind, detail)`. */
function rejected(kind: CommitFailureKind, detail: string | undefined): CommitReply {
  return { revision: undefined, failure: { kind, detail }, deletedCount: 0n, reachedLimit: false };
}

/**
 * `rows.Sort((a, b) => a.CreatedRevision.CompareTo(b.CreatedRevision))`. `Array.prototype.sort`
 * defaults to STRING comparison and rejects the `bigint` a subtraction returns, so the comparator
 * must be explicit and return -1/0/1.
 */
function compareByCreatedRevision(a: StoredRelationshipWire, b: StoredRelationshipWire): number {
  return compareBig(a.createdRevision, b.createdRevision);
}

function compareBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * The whole-millisecond part of the process's clock origin, in nanoseconds. Read ONCE, so the
 * sub-millisecond term below is measured against a fixed anchor - see {@link nowNanos}.
 */
const CLOCK_ORIGIN_NANOS = BigInt(Math.round(performance.timeOrigin)) * 1_000_000n;

/**
 * `(DateTimeOffset.UtcNow - DateTimeOffset.UnixEpoch).Ticks * 100L`.
 *
 * SUB-MILLISECOND ON PURPOSE. .NET ticks are 100ns and `DateTimeOffset.UtcNow` resolves finer than
 * one commit takes, so in Spiceport `now` is essentially always greater than the head and a minted
 * revision IS a timestamp. `Date.now()` resolves only to the millisecond, and at this grain's commit
 * rate that is coarser than the interval between commits: every commit after the first in a given
 * millisecond falls to the `head + 1` branch, so the head climbs ABOVE the clock and a minted
 * revision stops being a timestamp at all.
 *
 * THAT IS NOT COSMETIC, and the claim this comment used to make ("nothing depends on the
 * resolution") is false. {@link runGc} computes its floor as `min(head, now - window)` from the SAME
 * clock, so with a zero window the floor lands at `now` while the revisions just committed sit at
 * `now + k` - and the collection silently skips rows it was asked to collect. `thin-sequencer-tests`
 * catches it directly: a key whose only rows are deleted below a zero-window GC floor must EMPTY at
 * its next flush (dropping it from the key index with a tombstone), and under the millisecond clock
 * it intermittently did not.
 *
 * `performance.timeOrigin + performance.now()` is the same wall clock with sub-microsecond
 * resolution. The two halves are combined in `bigint` AFTER the small one is scaled, never as one
 * float: `(timeOrigin + now()) * 1e6` is ~1.8e18, past float64's integer precision, and would
 * quantise the result back to hundreds of nanoseconds. `performance.now()` is monotonic, so the
 * result is monotonic within the process; it does NOT absorb wall-clock corrections after start,
 * which is the deliberate trade - a clock that steps backwards would be worse here than one that
 * drifts, and every comparison the grain makes (head vs now, GC floor vs revision) reads this same
 * function.
 */
function nowNanos(): bigint {
  return CLOCK_ORIGIN_NANOS + BigInt(Math.round(performance.now() * 1_000_000));
}

/** `TimeSpan <` on two `Duration`s. */
function durationLessThan(a: Duration, b: Duration): boolean {
  return durationToMs(a) < durationToMs(b);
}

/**
 * The dedupe identity for candidate-row assembly: the six-tuple storage identity plus the created
 * revision. LENGTH-PREFIXED because relationship ids may contain any character, so a
 * delimiter-joined key would not be injective - and a non-injective key silently stops deduping the
 * forward/reverse contributions of one stored row.
 */
function candidateRowIdentity(row: StoredRelationshipWire): string {
  const r = row.relationship;
  return (
    [
      r.resourceType,
      r.resourceId,
      r.resourceRelation,
      r.subjectType,
      r.subjectId,
      r.subjectRelation,
    ]
      .map((part) => `${part.length}:${part}`)
      .join("") + `|${row.createdRevision}`
  );
}

/**
 * Resolves a filter to the shard keys able to hold ANY row it matches - deliberately a SUPERSET
 * (over-inclusion only adds rows the filter then ignores; under-inclusion would silently break
 * MustNotMatch/delete completeness). Resource-side constraints resolve against the forward index; a
 * filter constraining ONLY subjects resolves its selectors against the reverse index; a filter
 * constraining neither resolves every forward key, because every row lives in exactly one forward
 * key. Row-level constraints (relation, caveat, expiration, subject-relation) never narrow KEYS.
 *
 * The two index scans iterate a Map, whose order is insertion order rather than the C#'s arbitrary
 * `ImmutableDictionary` order - benign, because the result is a `Set` the caller consumes
 * order-insensitively.
 */
function addFilterCandidates(
  filter: FullRelationshipsFilterWire,
  meta: DatastoreMetaState,
  candidates: Set<string>,
): void {
  const resourceConstrained =
    filter.optionalResourceType !== undefined ||
    (filter.optionalResourceIds !== undefined && filter.optionalResourceIds.length > 0) ||
    filter.optionalResourceIdPrefix !== undefined;

  if (resourceConstrained) {
    // Exact-key fast path: a filter naming an explicit resource type + explicit ids (no prefix)
    // determines its candidate keys by CONSTRUCTION - O(#ids) probes, never a scan. The scan below
    // is O(all keys) with a string parse per key, which makes an exact-key precondition's cost scale
    // linearly with graph cardinality; it remains only for the shapes that cannot name their keys.
    if (
      filter.optionalResourceType !== undefined &&
      filter.optionalResourceIds !== undefined &&
      filter.optionalResourceIds.length > 0 &&
      filter.optionalResourceIdPrefix === undefined
    ) {
      for (const id of filter.optionalResourceIds) {
        const key = graphShardGrainKeyBuild(
          graphShardKeyForResource(filter.optionalResourceType, id),
        );
        if (meta.forwardKeys.has(key)) candidates.add(key);
      }
      return;
    }

    for (const key of meta.forwardKeys.keys()) {
      const parsed = graphShardGrainKeyParse(key);
      if (
        filter.optionalResourceType !== undefined &&
        parsed.objectType !== filter.optionalResourceType
      )
        continue;
      if (
        filter.optionalResourceIds !== undefined &&
        filter.optionalResourceIds.length > 0 &&
        !filter.optionalResourceIds.includes(parsed.objectId)
      )
        continue;
      if (
        filter.optionalResourceIdPrefix !== undefined &&
        !parsed.objectId.startsWith(filter.optionalResourceIdPrefix)
      )
        continue;
      candidates.add(key);
    }
    return;
  }

  const selectors = filter.optionalSubjectsSelectors;
  if (selectors !== undefined && selectors.length > 0) {
    // Same fast path on the reverse side: when EVERY selector names an explicit subject type +
    // explicit ids, the reverse keys are constructible; one broader selector falls the whole filter
    // back to the scan (selectors are OR'd, so a scan-shaped one covers the others too).
    if (
      selectors.every(
        (s) =>
          s.optionalSubjectType !== undefined &&
          s.optionalSubjectIds !== undefined &&
          s.optionalSubjectIds.length > 0,
      )
    ) {
      for (const selector of selectors) {
        for (const id of selector.optionalSubjectIds!) {
          const key = graphShardGrainKeyBuild(
            graphShardKeyForSubject(selector.optionalSubjectType!, id),
          );
          if (meta.reverseKeys.has(key)) candidates.add(key);
        }
      }
      return;
    }

    for (const key of meta.reverseKeys.keys()) {
      const parsed = graphShardGrainKeyParse(key);
      for (const selector of selectors) {
        if (
          selector.optionalSubjectType !== undefined &&
          parsed.objectType !== selector.optionalSubjectType
        )
          continue;
        if (
          selector.optionalSubjectIds !== undefined &&
          selector.optionalSubjectIds.length > 0 &&
          !selector.optionalSubjectIds.includes(parsed.objectId)
        )
          continue;
        candidates.add(key);
        break;
      }
    }
    return;
  }

  for (const key of meta.forwardKeys.keys()) candidates.add(key);
}

/** `MigrateLegacySnapshot`'s local `AddRow`. */
function addRow(
  byKey: Map<string, StoredRelationshipWire[]>,
  key: string,
  row: StoredRelationshipWire,
): void {
  let rows = byKey.get(key);
  if (rows === undefined) {
    rows = [];
    byKey.set(key, rows);
  }
  rows.push(row);
}

/**
 * The slim v2 `meta/{version}` entry: the meta with its key maps STRIPPED (they live in the
 * bucket/delta rows the layout describes), so the row is cardinality-independent.
 */
function slimMetaEntry(
  meta: DatastoreMetaState,
  version: number,
  layout: KeyIndexLayout,
): DatastoreMetaEntry {
  return {
    meta: {
      ...meta,
      forwardKeys: new Map<string, number>(),
      reverseKeys: new Map<string, number>(),
    },
    flushedThroughLogVersion: version,
    indexLayout: layout,
  };
}

/**
 * Partitions one direction's key map into its per-bucket maps (every bucket present, empty ones
 * included).
 */
function partitionIntoBuckets(
  index: ReadonlyMap<string, number>,
  bucketCount: number,
): Map<string, number>[] {
  const buckets: Map<string, number>[] = [];
  for (let b = 0; b < bucketCount; b += 1) buckets.push(new Map<string, number>());
  for (const [key, rowVersion] of index)
    buckets[keyIndexLayoutBucketOf(key, bucketCount)]!.set(key, rowVersion);
  return buckets;
}

/**
 * One bucket's full current entries selected from one direction's in-memory map (the flush-rotation
 * form of {@link partitionIntoBuckets} - an O(N) CPU-only scan).
 */
function bucketEntries(
  index: ReadonlyMap<string, number>,
  bucket: number,
  bucketCount: number,
): KeyIndexBucketEntry {
  const entries = new Map<string, number>();
  for (const [key, rowVersion] of index)
    if (keyIndexLayoutBucketOf(key, bucketCount) === bucket) entries.set(key, rowVersion);
  return { entries };
}

/** `ReconstructIndex`'s local `ApplyDelta`: absolute entries last-wins, tombstones deleting. */
function applyDelta(index: Map<string, number>, entries: ReadonlyMap<string, number>): void {
  for (const [key, rowVersion] of entries) {
    if (rowVersion === KEY_INDEX_TOMBSTONE) index.delete(key);
    else index.set(key, rowVersion);
  }
}

/**
 * The `ObserverManager` key of a watcher reference. Orleans keys the manager BY THE REFERENCE
 * ITSELF (`Subscribe(watcher, watcher)`), which works only because Orleans references have value
 * equality; Thresh's do not, so a re-subscribe from the same hub would add a second entry every
 * heartbeat instead of refreshing one. The reference's grain id is the stable identity.
 */
function watcherKey(watcher: IDatastoreWatcher): string {
  const identity = grainReferenceIdentity(watcher);
  if (identity === undefined)
    throw new Error("subscribeWatch/unsubscribeWatch require a grain-reference observer");
  return identity.grainId.toString();
}

/**
 * `SemaphoreSlim(1, 1)`: a NON-REENTRANT promise-chain mutex with an explicit `release`, so a
 * holder can span an arbitrary section (the flush holds it across its whole
 * write-rows/meta/head/clear block). Thresh's `AsyncSerialExecutor` - the port guide's suggested
 * substitution - cannot express that: it runs a queued callback to completion rather than handing
 * out a permit.
 */
class Mutex {
  #tail: Promise<void> = Promise.resolve();
  #release: (() => void) | undefined;

  async wait(): Promise<void> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.#release = release;
  }

  release(): void {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }
}
