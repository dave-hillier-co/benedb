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
import { grainReferenceIdentity } from "@thresh/core/grain-reference";
import { JournaledGrain } from "@thresh/core/journaled-grain";
import type { Logger } from "@thresh/core/logger";
import { noopLogger } from "@thresh/core/logger";
import { ObserverManager } from "@thresh/core/observer-manager";
import type { Remindable, TickStatus } from "@thresh/core/reminder";
import { systemTimeProvider } from "@thresh/core/time-provider";

import type { CommitFailureKind, CommitReply, CommitRequest } from "./commit-contract";
import type {
  DatastoreHeadWire,
  FullRelationshipsFilterWire,
  StoredRelationshipWire,
} from "./datastore-dtos";
import type { DatastoreGcOptions, ResolvedDatastoreGcOptions } from "./datastore-gc-options";
import { MINIMUM_REMINDER_PERIOD, resolveDatastoreGcOptions } from "./datastore-gc-options";
import type { DatastoreGrainState } from "./datastore-grain-state";
import type {
  DatastoreJournalEntry,
  DatastoreMetaState,
  ShardTailWire,
} from "./datastore-meta-state";
import {
  datastoreMetaStateEmpty,
  datastoreMetaStateSchemaHashAt,
  datastoreMetaStateSchemaVersionAt,
} from "./datastore-meta-state";
import { toMemoryState } from "./datastore-state-converters";
import { graphShardGrainKeyBuild, graphShardGrainKeyParse } from "./graph-shard-grain-key";
import type { GraphShardDirection, GraphShardKeyWire } from "./graph-shard-key";
import { graphShardKeyForResource, graphShardKeyForSubject } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import type { IDatastoreGrain } from "./i-datastore-grain";
import type { IDatastoreWatcher } from "./i-datastore-watcher";
import { IGraphShardGrain, IShardIndexGrain } from "./i-graph-shard-grain";
import type { ISequencerMetrics } from "./i-sequencer-metrics";
import type { LogEvent, LogSegment } from "./log-event";
import { eventFromState } from "./log-event-factory";
import { metaFoldApplyEntry, metaFoldForwardKeyOf, metaFoldTouchedKeys } from "./meta-fold";
import { mustMatchFailedMessage, mustNotMatchFailedMessage } from "./precondition-messages";
import { shardFoldOverlay, shardFoldTouches } from "./shard-fold";
import { shardIndexKeyFor, shardIndexList } from "./shard-index-grain";
import { toCoreFilter, toWriteUpdate } from "./wire-convert";
// The value-codec surrogate that lets `RevisionNotFoundException` cross the grain boundary as its
// own class (`readFrom` / `readSchemaAt` are the two throw sites). Importing for the side effect IS
// the registration; without it a stale Watch cursor arrives at the front door as a plain error.
import "./revision-not-found-surrogate";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/DatastoreGrain.cs`.
 *
 * The cluster-singleton datastore grain (`DATASTORE_GRAIN_KEY` = 0n): the sequencer whose journal
 * is the source of truth for the whole MVCC datastore. It is an ordinary JOURNALED grain over the
 * silo's journal provider: each commit journals a canonical {@link LogEvent}, and the journaled
 * state is only the SMALL state ({@link DatastoreMetaState} - head, schemas, counters, GC floor, the
 * types seen, and the pending tail of events not yet projected). Relationship rows are owned by the
 * per-key `GraphShardGrain` projections, which persist their own state, and listed by the
 * `ShardIndexGrain` buckets.
 *
 * INTERLEAVING IS THE CENTRAL CONTRACT. It is a single non-reentrant activation; WRITES (`commit`,
 * `runGc`, `flushProjection` - no interleave option on the interface) never interleave EACH OTHER,
 * so a write's turn runs to completion before the next write's, keeping the
 * head-compare-and-append atomic. The PURE reads (`readState`, `getHead`, `readSchemaAt`,
 * `readShard`, `readShardTail`, `readFrom`) carry `alwaysInterleave` in `IDatastoreGrain`'s options
 * map and may run DURING a write's await - never concurrently with it, and never observing a
 * write's intermediate state, because they read the confirmed view.
 *
 * THE PROJECTION. Every {@link FLUSH_INTERVAL} pending events, the sequencer projects them: each
 * shard grain an event touches folds its events over its persisted state and persists the result
 * (`IGraphShardGrain.project`), the touched keys are added to the shard index, and only then is a
 * `projected` entry journaled, which drops those events from the pending tail. A crash anywhere
 * before that entry leaves the events pending, and the next flush replays them; shard projection is
 * idempotent by its label. So every committed event is, at every instant, either projected into
 * each shard it touches or pending in the journaled state - which is what makes a key's current
 * state exactly its projected state with its pending events folded over (`shardFoldOverlay`),
 * relabeled to the head.
 *
 * THE ORDER RULE for reading a key's current state while a flush may interleave: take the pending
 * tail FIRST, read the projected state SECOND. A projection that lands in between is then already
 * in the projected state and its events skipped by the label; one that has not landed is still in
 * the captured tail.
 *
 * Row-level GC is LAZY: a GC event advances the small state's floor immediately, but a projected
 * row keeps its sub-floor dead rows until its key is next projected. Sound because reads pinned
 * below the floor are rejected outright and every serve path re-applies the current floor.
 *
 * PORT DECISIONS (recorded here because none of them is mechanical):
 *
 *  1. `[LogConsistencyProvider(ProviderName = "StateStorage")]` and
 *     `[StorageProvider(ProviderName = "datastore")]` have no counterpart: a Thresh `JournaledGrain`
 *     always persists through the silo's journal provider (events appended, snapshots on a
 *     threshold), which the host's storage backend supplies. The observable contract - confirmed
 *     state, version, conditional append - is the same.
 *  2. `JournaledGrain<DatastoreMetaHolder, DatastoreJournalEntry>` becomes
 *     `JournaledGrain<DatastoreMetaState, DatastoreJournalEntry>`. The C# holder exists ONLY because
 *     Orleans mutates its state object in place through `TransitionState(holder, ev)`; Thresh's
 *     `transitionState(state, ev)` RETURNS the next state, so the holder is dead weight.
 *  3. `RaiseConditionalEvent(entry)` maps to Thresh's `raiseConditionalEvent(entry)` - the same
 *     conditional append (adaptor `tryAppend`, mirroring Orleans' first-conflict-drop
 *     `TryAppend`), so the boolean the C# branches on crosses unchanged. See
 *     {@link DatastoreGrain.#raiseConditionalEvent} and the regression gate in
 *     `datastore-conditional-append-tests.test.ts`.
 *  4. Thresh has no constructor DI, so the C#'s optional `ILogger`/`IOptions`/`ISequencerMetrics`
 *     become one optional options bag supplied through a `GrainActivator`. The parameter is
 *     OPTIONAL so the class still satisfies Thresh's `new () => Grain` registration shape.
 *  5. Observers ARE available: `ObserverManager` is keyed by the observer reference's
 *     `grainReferenceIdentity(...).grainId` string, because Thresh grain references (unlike
 *     Orleans') have no value equality - the C#'s `Subscribe(watcher, watcher)` would otherwise
 *     accumulate a duplicate registration per heartbeat instead of refreshing one.
 *  6. `Task.WhenAll` over shard and index calls becomes `Promise.all`, in batches of
 *     {@link MAX_CONCURRENT_SHARD_CALLS} through {@link inBatches}, as the C#'s `InBatches`.
 */
@grain()
export class DatastoreGrain
  extends JournaledGrain<DatastoreMetaState, DatastoreJournalEntry>
  implements IDatastoreGrain, Remindable
{
  // --- injected collaborators ---

  readonly #logger: Logger;
  readonly #gcOptions: ResolvedDatastoreGcOptions;

  /**
   * The sequencer-side inbound-call counters, or absent on a host that never registered them -
   * every record site is optional-chained, so the grain works unchanged without the seam.
   */
  readonly #metrics: ISequencerMetrics | undefined;

  /** The retention window {@link runGc} collects MVCC history beyond. */
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

  constructor(options: DatastoreGrainOptions = {}) {
    super();
    this.#logger = options.logger ?? noopLogger;
    this.#metrics = options.metrics;
    // Optional so a host/test that never configures the GC options still activates the grain with
    // sane defaults (24h window, 1h reminder, enabled).
    this.#gcOptions = resolveDatastoreGcOptions(options.gcOptions);
    // `(long)Window.TotalMilliseconds * 1_000_000L`: the TRUNCATION happens before the multiply, so
    // it is `Math.trunc` on the millisecond value, never on the product.
    this.#gcWindowNanos = BigInt(Math.trunc(durationToMs(this.#gcOptions.window))) * 1_000_000n;
  }

  // --- JournaledGrain ---

  /** @inheritdoc */
  initialState(): DatastoreMetaState {
    return datastoreMetaStateEmpty(0n);
  }

  /** Folds a journal entry into the small state. Deterministic and synchronous. */
  transitionState(state: DatastoreMetaState, entry: DatastoreJournalEntry): DatastoreMetaState {
    return metaFoldApplyEntry(state, entry);
  }

  // --- lifecycle ---

  /** @inheritdoc */
  override async onActivate(): Promise<void> {
    if (this.version === 0) {
      // A fresh store: seed the head at a monotonic timestamp (mirrors ReferenceDatastore's
      // initial Empty(NowNanos)) and JOURNAL the seed, so the pre-first-write head is stable across
      // reactivation (a re-seed with a fresh, larger timestamp would silently move the head).
      this.raiseEvent({ kind: "seeded", revision: nowNanos() });
      await this.confirmEvents();
    }

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
   * current-state(key) against the captured state `meta`: the key's shard grain's projected state
   * with `meta`'s pending events for the key folded over, relabeled to its head with its floor
   * applied. `meta` must be captured BEFORE this call reads the projected state (the order rule in
   * the class remarks).
   */
  async #currentShardState(meta: DatastoreMetaState, shardKey: string): Promise<GraphShardState> {
    const key = graphShardGrainKeyParse(shardKey);
    const projected = await this.getGrain(IGraphShardGrain, shardKey).readProjected();
    return shardFoldOverlay(projected, meta.pending, key, meta.headRevision, meta.gcFloor);
  }

  /**
   * Every key of `direction` and `objectType` that may hold rows: the shard index's listing plus the
   * keys the pending tail touches (not yet indexed).
   */
  async #keysOf(
    meta: DatastoreMetaState,
    direction: GraphShardDirection,
    objectType: string,
  ): Promise<GraphShardKeyWire[]> {
    const listed = await shardIndexList(
      (key) => this.getGrain(IShardIndexGrain, key),
      direction,
      objectType,
    );
    return [
      ...listed,
      ...pendingKeys(meta, direction).filter((key) => key.objectType === objectType),
    ];
  }

  // --- IDatastoreGrain ---

  /**
   * `alwaysInterleave`. ADMIN-PLANE ASSEMBLY: rebuilds a {@link DatastoreGrainState} from the
   * captured small state plus the current state of every FORWARD key the shard index or the pending
   * tail names (each row belongs to exactly one forward key, so the union is exact and
   * duplicate-free). The cost is O(graph) grain calls + transfer per call, acceptable ONLY for its
   * admin-plane consumers. Every key is read against the one captured state (the order rule), so a
   * projection landing mid-assembly is never double-applied or lost; a key whose projection already
   * includes events above the captured head contributes rows stamped above it, which MVCC
   * visibility filters for every pin at or below it.
   */
  async readState(): Promise<DatastoreGrainState> {
    this.#metrics?.recordReadState();
    const meta = this.state;

    const keys = new Set<string>();
    for (const type of meta.forwardTypes) {
      for (const key of await this.#keysOf(meta, "forward", type))
        keys.add(graphShardGrainKeyBuild(key));
    }

    const states = await inBatches([...keys], (key) => this.#currentShardState(meta, key));

    const rows: StoredRelationshipWire[] = [];
    let floor = meta.gcFloor;
    for (const state of states) {
      rows.push(...state.rows);
      // Normally equal to the small state's floor; a HIGHER projected floor (a GC and a projection
      // landed mid-assembly) is propagated so a pin between the floors is rejected (fail loud)
      // instead of served incomplete.
      floor = maxBig(floor, state.gcFloor);
    }

    // Order by created revision to approximate the whole fold's append order. Order is cosmetic:
    // every consumer is an MVCC reader, and anything order-sensitive imposes its own order.
    rows.sort(compareByCreatedRevision);

    return {
      headRevision: meta.headRevision,
      relationships: rows,
      schemas: meta.schemas,
      counters: meta.counters,
      gcFloor: floor,
    };
  }

  /**
   * `alwaysInterleave`. Reads the confirmed state, so an interleaved call landing mid-write sees, AT
   * WORST, the previous commit; it can never observe a write's in-flight intermediate state.
   */
  getHead(): Promise<DatastoreHeadWire> {
    this.#metrics?.recordGetHead();
    const s = this.state;
    return Promise.resolve({
      head: s.headRevision,
      schemaHash: datastoreMetaStateSchemaHashAt(s, s.headRevision),
      gcFloor: s.gcFloor,
    });
  }

  /** `alwaysInterleave`. Small state only; same publication guarantee as {@link getHead}. */
  readSchemaAt(revision: bigint): Promise<Uint8Array | undefined> {
    this.#metrics?.recordReadSchemaAt();
    const s = this.state;
    // Below the GC floor the schema history has been collected, so "no schema at this revision" is
    // indistinguishable from "collected away" - a silent absent here would make callers fall back
    // to the seed schema and evaluate WRONG results under a stale token. Reject loudly instead;
    // `RevisionNotFoundException` round-trips the grain boundary via its surrogate and the front
    // door maps it to InvalidArgument like any other GC'd pinned revision.
    if (revision < s.gcFloor) throw new RevisionNotFoundException(new TimestampRevision(revision));

    return Promise.resolve(datastoreMetaStateSchemaVersionAt(s, revision)?.bytes);
  }

  /** `alwaysInterleave`. One {@link currentShardState} resolution at the current head. */
  readShard(key: GraphShardKeyWire): Promise<GraphShardState> {
    if (key === undefined || key === null) throw new Error("key must not be null");
    return this.#currentShardState(this.state, graphShardGrainKeyBuild(key));
  }

  /** `alwaysInterleave`. Synchronous over the confirmed state. */
  readShardTail(key: GraphShardKeyWire): Promise<ShardTailWire> {
    this.#metrics?.recordReadShard();
    if (key === undefined || key === null) throw new Error("key must not be null");
    const meta = this.state;
    return Promise.resolve({
      events: meta.pending.filter((ev) => shardFoldTouches(ev, key)),
      headRevision: meta.headRevision,
      gcFloor: meta.gcFloor,
    });
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
    // The confirmed small state: in a write turn all prior confirms have fully completed, and it is
    // the view the adaptor's own version check pairs with.
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
      await this.#addFilterCandidates(precondition.filter, meta, candidates);
    if (request.deleteByFilter !== undefined)
      await this.#addFilterCandidates(request.deleteByFilter.filter, meta, candidates);
    this.#metrics?.recordCommitCandidates(candidates.size);

    const shards = await inBatches([...candidates], (candidate) =>
      this.#currentShardState(meta, candidate),
    );
    const candidateRows: StoredRelationshipWire[] = [];
    // `readonly record struct CandidateRowIdentity` used as a Dictionary KEY: value equality over
    // six strings plus a long. A JS `Map` keys by REFERENCE, so this is a LENGTH-PREFIXED composite
    // string - relationship ids may contain any character, so a delimiter-joined key would not be
    // injective, and a non-injective key silently stops deduping.
    const seen = new Map<string, bigint | undefined>();
    for (const shard of shards) {
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
      const deleteFilter = toCoreFilter(request.deleteByFilter.filter);

      // Transactional-delete guard (upstream SpiceDB relationships.go DeleteRelationships): with a
      // limit and partial deletions disallowed, probe for limit+1 matches FIRST and reject the whole
      // commit when strictly MORE rows match than the limit - the staged transaction is abandoned
      // before commit, so nothing is applied. Exactly limit matches passes the probe and deletes
      // everything, but the delete below still reports reachedLimit (upstream datastores flag the
      // limit as reached when deleted == limit), which the v1 API surfaces as PARTIAL progress.
      // `allowPartial` absent means true (the C#'s constructor default).
      const deleteLimit = request.deleteByFilter.limit;
      if (request.deleteByFilter.allowPartial === false && deleteLimit !== undefined) {
        let probed = 0n;
        for await (const _ of tx.queryRelationships(deleteFilter)) {
          if (++probed > deleteLimit) {
            return rejected("deleteLimitExceeded", deleteLimit.toString());
          }
        }
      }

      const result = await tx.deleteRelationships(deleteFilter, request.deleteByFilter.limit);
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

    // The caller's optional transaction metadata is not part of the datastore state - `eventFromState`
    // derives only the state diff - so it rides the event directly, exactly like the compatibility
    // path's counter deltas above.
    if (request.transactionMetadata !== undefined)
      ev = { ...ev, transactionMetadata: request.transactionMetadata };

    // 12. Append: the event joins the pending tail, from which the shard grains and Watch read it
    //     until a projection flush persists it into the shard grains it touches.
    // The adaptor's own version check is a secondary guard behind the CAS above. It cannot lose
    // here - this activation is the only writer and no write interleaves a write - but keep the
    // identical false-branch handling (reported as a moved head) rather than assume.
    const raised = await this.#raiseConditionalEvent({ kind: "committed", event: ev });
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

    if (this.state.pending.length >= FLUSH_INTERVAL) await this.#tryFlushProjection();

    return { revision: newRevision, failure: undefined, deletedCount, reachedLimit };
  }

  /**
   * Resolves a filter to the shard keys able to hold ANY row it matches - deliberately a SUPERSET
   * (over-inclusion only adds rows the filter then ignores; under-inclusion would silently break
   * MustNotMatch/delete completeness). A filter naming an explicit resource type and ids determines
   * its keys by construction; other resource-side constraints (type/ids/prefix) enumerate the
   * forward keys of the constrained type (every type when none is named); a filter constraining ONLY
   * subjects resolves its selectors the same way on the reverse side; a filter constraining neither
   * (relation-only or empty) resolves every forward key, because every row lives in exactly one
   * forward key. Enumeration reads the shard index plus the pending tail's keys. Row-level
   * constraints (relation, caveat, expiration, subject-relation) never narrow KEYS.
   */
  async #addFilterCandidates(
    filter: FullRelationshipsFilterWire,
    meta: DatastoreMetaState,
    candidates: Set<string>,
  ): Promise<void> {
    const resourceConstrained =
      filter.optionalResourceType !== undefined ||
      (filter.optionalResourceIds !== undefined && filter.optionalResourceIds.length > 0) ||
      filter.optionalResourceIdPrefix !== undefined;

    if (resourceConstrained) {
      // Exact-key fast path: a filter naming an explicit resource type + explicit ids (no prefix)
      // determines its candidate keys by CONSTRUCTION - O(#ids), never an enumeration. A key with no
      // rows resolves to an empty shard, which evaluates preconditions identically.
      if (
        filter.optionalResourceType !== undefined &&
        filter.optionalResourceIds !== undefined &&
        filter.optionalResourceIds.length > 0 &&
        filter.optionalResourceIdPrefix === undefined
      ) {
        for (const id of filter.optionalResourceIds) {
          candidates.add(
            graphShardGrainKeyBuild(graphShardKeyForResource(filter.optionalResourceType, id)),
          );
        }
        return;
      }

      const types =
        filter.optionalResourceType !== undefined
          ? [filter.optionalResourceType]
          : meta.forwardTypes;
      for (const type of types) {
        for (const key of await this.#keysOf(meta, "forward", type)) {
          if (
            filter.optionalResourceIds !== undefined &&
            filter.optionalResourceIds.length > 0 &&
            !filter.optionalResourceIds.includes(key.objectId)
          )
            continue;
          if (
            filter.optionalResourceIdPrefix !== undefined &&
            !key.objectId.startsWith(filter.optionalResourceIdPrefix)
          )
            continue;
          candidates.add(graphShardGrainKeyBuild(key));
        }
      }
      return;
    }

    const selectors = filter.optionalSubjectsSelectors;
    if (selectors !== undefined && selectors.length > 0) {
      // Same fast path on the reverse side: when EVERY selector names an explicit subject type +
      // explicit ids, the reverse keys are constructible; one broader selector falls the whole
      // filter back to enumeration (selectors are OR'd, so an enumerated one covers the others).
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
            candidates.add(
              graphShardGrainKeyBuild(graphShardKeyForSubject(selector.optionalSubjectType!, id)),
            );
          }
        }
        return;
      }

      const subjectTypes = selectors.some((s) => s.optionalSubjectType === undefined)
        ? meta.reverseTypes
        : [...new Set(selectors.map((s) => s.optionalSubjectType!))];
      for (const type of subjectTypes) {
        for (const key of await this.#keysOf(meta, "reverse", type)) {
          for (const selector of selectors) {
            if (
              selector.optionalSubjectType !== undefined &&
              key.objectType !== selector.optionalSubjectType
            )
              continue;
            if (
              selector.optionalSubjectIds !== undefined &&
              selector.optionalSubjectIds.length > 0 &&
              !selector.optionalSubjectIds.includes(key.objectId)
            )
              continue;
            candidates.add(graphShardGrainKeyBuild(key));
            break;
          }
        }
      }
      return;
    }

    for (const type of meta.forwardTypes) {
      for (const key of await this.#keysOf(meta, "forward", type))
        candidates.add(graphShardGrainKeyBuild(key));
    }
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

    // Mint the new revision exactly like `commit`. A GC event touches no shard keys: projected rows
    // compact lazily (at their key's next projection), and every serve path re-applies the floor.
    const newRevision = now > head ? now : head + 1n;
    const ev: LogEvent = {
      revision: newRevision,
      relationshipChanges: [],
      schemaChange: undefined,
      counterChanges: [],
      gcFloor: floor,
    };

    const raised = await this.#raiseConditionalEvent({ kind: "committed", event: ev });
    if (!raised) return undefined; // lost a race with a concurrent turn; the next tick retries.

    // Same best-effort notify pattern as `commit`.
    try {
      await this.#watchers.notify((w) => w.headAdvanced(newRevision));
    } catch {
      // Defunct observers are pruned by ObserverManager; nothing else to do.
    }

    if (this.state.pending.length >= FLUSH_INTERVAL) await this.#tryFlushProjection();

    return floor;
  }

  /**
   * `RaiseConditionalEvent(ev)`: Thresh's `raiseConditionalEvent` carries Orleans' conditional
   * append whole - the entry is conditional on the version it was raised at, and a lost race (or
   * an exhausted CAS budget, the adaptor's bounded deviation) DROPS the event and reports `false`,
   * never leaving it pending. The retired `raiseEvent` + `confirmEvents` + `catch` translation was
   * unsound: the adaptor retried the same event against a re-read base, and after the budget the
   * event stayed pending, so the NEXT commit's confirm appended an event whose caller had already
   * been told it failed. Any error other than the reported `false` is a genuine storage failure
   * and propagates unchanged.
   */
  async #raiseConditionalEvent(entry: DatastoreJournalEntry): Promise<boolean> {
    return this.raiseConditionalEvent(entry);
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
   * `alwaysInterleave`. The tail it serves is the pending tail of the confirmed state, so the served
   * head and events come from one immutable state and the returned {@link LogSegment} is internally
   * consistent (its head is >= every event it serves) even if this call lands mid-write. Retention
   * starts at the projection boundary (and the GC floor): an older cursor cannot be served
   * COMPLETELY, so it is rejected rather than silently answered with a short tail - a shard
   * re-bootstraps from its projection, a Watch consumer from a fresh snapshot.
   */
  readFrom(afterRevision: bigint, maxCount: number): Promise<LogSegment> {
    this.#metrics?.recordReadFrom();
    const meta = this.state;

    if (afterRevision < maxBig(meta.projectedThrough, meta.gcFloor))
      throw new RevisionNotFoundException(new TimestampRevision(afterRevision));

    // `Take(maxCount < 0 ? int.MaxValue : maxCount)`: NEGATIVE is the unbounded sentinel.
    const limit = maxCount < 0 ? Number.MAX_SAFE_INTEGER : maxCount;
    const events = meta.pending.filter((e) => e.revision > afterRevision).slice(0, limit);

    return Promise.resolve({ events, headRevision: meta.headRevision });
  }

  // --- projection ---

  /** @inheritdoc */
  flushProjection(): Promise<void> {
    return this.#flushProjectionCore();
  }

  /**
   * The flush a write turn runs when the pending tail reaches {@link FLUSH_INTERVAL}. A failure is
   * logged and left for the next flush to retry - the events stay pending, which is always correct
   * - because the write that triggered it has already committed and must not be reported as failed.
   */
  async #tryFlushProjection(): Promise<void> {
    try {
      await this.#flushProjectionCore();
    } catch (error) {
      this.#logger.warn(
        `datastore grain: projecting ${this.state.pending.length} pending events failed; they stay pending and the next flush retries`,
        { error },
      );
    }
  }

  /**
   * Projects the whole pending tail (see the class remarks): every touched shard grain persists its
   * events, the populated keys are added to the shard index, and only then is the projection
   * journaled. Runs in a write turn, so no commit interleaves it.
   */
  async #flushProjectionCore(): Promise<void> {
    const meta = this.state;
    const last = meta.pending.at(-1);
    if (last === undefined) return;
    const through = last.revision;

    const eventsByKey = new Map<string, LogEvent[]>();
    for (const ev of meta.pending) {
      for (const key of metaFoldTouchedKeys(ev)) {
        let events = eventsByKey.get(key);
        if (events === undefined) {
          events = [];
          eventsByKey.set(key, events);
        }
        events.push(ev);
      }
    }

    const projected = await inBatches([...eventsByKey], async ([shardKey, events]) => ({
      key: graphShardGrainKeyParse(shardKey),
      populated: await this.getGrain(IGraphShardGrain, shardKey).project(
        events,
        through,
        meta.gcFloor,
      ),
    }));

    const buckets = new Map<string, string[]>();
    for (const { key, populated } of projected) {
      if (!populated) continue;
      const bucket = shardIndexKeyFor(key);
      let ids = buckets.get(bucket);
      if (ids === undefined) {
        ids = [];
        buckets.set(bucket, ids);
      }
      ids.push(key.objectId);
    }
    await inBatches([...buckets], ([bucket, ids]) =>
      this.getGrain(IShardIndexGrain, bucket).add(ids),
    );

    this.raiseEvent({ kind: "projected", through });
    await this.confirmEvents();
  }
}

/** The options bag standing in for the C# constructor's DI parameters. */
export interface DatastoreGrainOptions {
  /** `ILogger<DatastoreGrain>`; defaults to Thresh's no-op logger. */
  readonly logger?: Logger | undefined;
  /** `IOptions<DatastoreGcOptions>`; every member defaults. */
  readonly gcOptions?: DatastoreGcOptions | undefined;
  /** The optional sequencer-side inbound-call counters. */
  readonly metrics?: ISequencerMetrics | undefined;
}

/** The name of the periodic MVCC-GC reminder registered in `onActivate`. */
const GC_REMINDER_NAME = "mvcc-gc";

/**
 * Project the pending tail once it holds this many events. It bounds the journaled state and is
 * the retention of `readFrom`, whose floor is the projection boundary.
 */
const FLUSH_INTERVAL = 64;

/**
 * The most shard or index grain calls the sequencer has in flight at once. A flush touches up to
 * two keys per event, and every one of those grains persists through the storage provider:
 * unbounded, a flush opens as many storage connections as it touches keys and exhausts the
 * database's connection limit, failing the projection.
 */
const MAX_CONCURRENT_SHARD_CALLS = 16;

/** Runs `call` over `items` with at most {@link MAX_CONCURRENT_SHARD_CALLS} in flight. */
async function inBatches<T, TResult>(
  items: readonly T[],
  call: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = [];
  for (let i = 0; i < items.length; i += MAX_CONCURRENT_SHARD_CALLS)
    results.push(...(await Promise.all(items.slice(i, i + MAX_CONCURRENT_SHARD_CALLS).map(call))));
  return results;
}

/**
 * How long a watcher registration lives without a `subscribeWatch` refresh. 10x the hubs'
 * heartbeat interval, so a silo must miss many heartbeats before its watcher is dropped.
 */
const WATCHER_EXPIRY: Duration = { seconds: 10 };

/** The keys of `direction` the pending tail touches. */
function pendingKeys(
  meta: DatastoreMetaState,
  direction: GraphShardDirection,
): GraphShardKeyWire[] {
  const keys: GraphShardKeyWire[] = [];
  for (const ev of meta.pending) {
    if (ev.gcFloor !== undefined) continue;
    for (const change of ev.relationshipChanges) {
      const rel = change.relationship;
      keys.push(
        direction === "forward"
          ? graphShardKeyForResource(rel.resourceType, rel.resourceId)
          : graphShardKeyForSubject(rel.subjectType, rel.subjectId),
      );
    }
  }
  return keys;
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
 * `now + k` - and the collection silently skips rows it was asked to collect. The GC
 * suites catch it directly: rows deleted below a zero-window GC floor must be collected, and under
 * the millisecond clock they intermittently were not.
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
