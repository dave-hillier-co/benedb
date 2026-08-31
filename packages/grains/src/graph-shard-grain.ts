import { ELLIPSIS } from "@benedb/core/core-constants";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { RelationshipsFilter } from "@benedb/datastore/relationships-filter";
import { relationshipsFilterMatches } from "@benedb/datastore/relationships-filter";
import { raceSignal } from "@thresh/core/abort";
import { grain } from "@thresh/core/decorators";
import { Grain } from "@thresh/core/grain";

import type { FullRelationshipsFilterWire, StoredRelationshipWire } from "./datastore-dtos";
import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import { graphShardGrainKeyParse } from "./graph-shard-grain-key";
import type { GraphShardKeyWire } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import { GRAPH_SHARD_STATE_EMPTY } from "./graph-shard-state";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import type { GraphShardRowsReply, IGraphShardGrain } from "./i-graph-shard-grain";
import type { RelationshipWire } from "./relationships-dtos";
import {
  shardFoldApplyEvent,
  shardFoldIsReadableAt,
  shardFoldIsVisibleAt,
  shardFoldVisibleAt,
} from "./shard-fold";
import { toCoreFilter, toRelationship } from "./wire-convert";
// `RevisionNotFoundException` crosses the grain boundary in BOTH directions here - caught out of
// `readFrom` to trigger a re-hydrate, and thrown out of `serve` for a below-floor read - so the
// surrogate registration must be loaded wherever this grain is.
import "./revision-not-found-surrogate";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/GraphShardGrain.cs`.
 *
 * One graph shard as a grain: the activation state IS the shard cache. The state is the per-key
 * restriction of the datastore fold (`shard-fold.ts`) for the `GraphShardKeyWire` named by this
 * grain's string key - hydrated once from `IDatastoreGrain.readShard` and thereafter advanced by
 * tailing the same `LogEvent` feed the sequencer persists. Cold keys never activate; idle
 * collection is the eviction policy - silo memory is O(hot working set), not O(graph)
 * (`docs/graph-sharded-datastore.md` section 2).
 *
 * The incremental bootstrap-then-tail-fold shape: a single-flight gate, a fast path (serve when the
 * watermark already covers the pinned revision), and a catch-up-on-demand pull loop with
 * re-bootstrap on `RevisionNotFoundException` (compaction GC'd past our watermark). The per-shard
 * `GraphShardState.appliedRevision` watermark is the closed-timestamp gate - valid because every
 * shard folds EVERY log event (the watermark advances even when nothing matches the key) - so
 * "watermark >= rev" proves all commits <= rev are present in this slice.
 *
 * A cold shard ALWAYS hydrates via `IDatastoreGrain.readShard` first, never by replaying
 * `readFrom(0n)` - the log's retained tail starts at the compaction floor, so a from-zero replay
 * would silently miss compacted history.
 *
 * GC-floor stance: a shard enforces the floor IT has folded/hydrated - never a per-read probe of
 * the singleton - so at the floor boundary a cold shard (hydrated after a GC run) may reject a
 * pinned revision that a warm shard which has not yet folded the GC event still serves, and vice
 * versa. Data is never wrong on either side; only the stale-token ERROR surfaces earlier or later.
 *
 * Filtered serves (the 3.2 subject-filter pushdown) are answered from a lazily-built subject-keyed
 * index over the served state so a point-membership probe is O(matches), not an O(userset) scan
 * inside this single activation. The index holds REFERENCES to the same `StoredRelationshipWire`
 * rows the state already holds, lives only on hot activations, and is dropped with the activation.
 *
 * PORT NOTES.
 *  - `[GraphLocalityPlacement]` -> `{ placement: "custom", strategy }` plus the silo-side
 *    `addPlacementStrategy(GRAPH_LOCALITY_PLACEMENT_STRATEGY, ...)` registration. Thresh has no
 *    attribute mechanism and no strategy-vs-director split; what survives the pair is the name.
 *  - `SemaphoreSlim(1, 1)` -> the module-private {@link ShardGate}. `AsyncSerialExecutor` cannot
 *    express a permit held across a section the holder does not own as a callback.
 *  - `Task.Delay(10ms, ct)` -> a `setTimeout` promise wrapped in `raceSignal`, timer cleared in a
 *    `finally`. A bare `setTimeout` await would leave one unkillable window per iteration.
 *  - `Dictionary<(string, string), ...>` -> a `Map` over a LENGTH-PREFIXED composite key: a JS
 *    `Map` keys by reference, and relationship ids may contain any character at all.
 *  - `HashSet<StoredRelationshipWire>(ReferenceEqualityComparer.Instance)` -> a plain `Set`, which
 *    is reference-keyed by default. That is deliberate, not incidental: multiple stored VERSIONS of
 *    one identity are distinct instances that must each survive to the visibility check.
 */
@grain({ placement: "custom", strategy: GRAPH_LOCALITY_PLACEMENT_STRATEGY })
export class GraphShardGrain extends Grain implements IGraphShardGrain {
  /** Log-tail page size for catch-up pulls (matches the Watch feed's page size). */
  static readonly #batchSize = 256;

  // Single-flight gate: only one hydration/catch-up runs at a time. `rowsAt` is
  // `alwaysInterleave`, so concurrent readers whose revision the watermark already covers skip the
  // gate entirely (the fast path); the rest queue here and re-check after acquiring.
  readonly #gate = new ShardGate();

  #state: GraphShardState = GRAPH_SHARD_STATE_EMPTY;
  #hydrated = false;

  // --- Subject-keyed index over the served state (scalability-program 3.2, serve-side half) ---
  // Rebuilt lazily at serve time whenever the served `GraphShardState` INSTANCE changes (the state
  // is an immutable record replaced whole, so reference identity is the correct staleness signal).
  // Safe under `alwaysInterleave`: turns are single-threaded and interleave only at awaits; `serve`
  // is fully synchronous, so a rebuild can never be observed half-built. Buckets stay
  // multi-version (ALL stored versions of a subject's rows); visibility filters at serve time.
  #indexedState: GraphShardState | undefined;
  #subjectIndex: Map<string, StoredRelationshipWire[]> | undefined;
  #nonTerminalRows: StoredRelationshipWire[] | undefined;

  /** The shard key parsed once from the grain's string key. */
  #key!: GraphShardKeyWire;

  #datastore!: IDatastoreGrain;

  /** @inheritdoc */
  override onActivate(): Promise<void> {
    this.#key = graphShardGrainKeyParse(this.id.key as string);
    this.#datastore = this.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
    return Promise.resolve();
  }

  /** @inheritdoc */
  async rowsAt(
    revision: bigint,
    filter: FullRelationshipsFilterWire | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<GraphShardRowsReply> {
    // Fast path: hydrated and the watermark already covers the pinned revision. `#state` is an
    // immutable record replaced whole, so serving off it with no gate is safe; the interleaved
    // reader sees either the previous fold or the new one, never a partial.
    if (
      this.#hydrated &&
      this.#state.appliedRevision >= revision &&
      shardFoldIsReadableAt(this.#state, revision)
    ) {
      return this.#serve(revision, filter);
    }

    await this.#gate.wait(signal);
    try {
      if (!this.#hydrated) {
        // ALWAYS hydrate via the per-key snapshot read first - never rely on `readFrom(0n)`
        // semantics for a cold shard (see the class remarks).
        this.#state = await this.#datastore.readShard(this.#key);
        this.#hydrated = true;
      }

      // Watermark as of the last re-hydrate, or absent when no re-hydrate has happened yet in this
      // catch-up. Guards the compaction-window spin: right after the singleton commits, its
      // post-commit compaction can briefly leave the hydrated head below the retained recent-tail
      // floor, so `readFrom` keeps rejecting the freshly re-hydrated watermark.
      let lastRehydrateWatermark: bigint | undefined = undefined;

      while (this.#state.appliedRevision < revision) {
        signal?.throwIfAborted();

        let seg;
        try {
          seg = await this.#datastore.readFrom(
            this.#state.appliedRevision,
            GraphShardGrain.#batchSize,
          );
        } catch (error) {
          if (!(error instanceof RevisionNotFoundException)) throw error;
          // Fell below the grain's retained log window; re-hydrate from a fresh per-key snapshot
          // and continue. If we must re-hydrate AGAIN without the watermark having advanced, we
          // are inside the compaction window described above - back off briefly instead of
          // hot-spinning against the singleton until its compaction settles.
          if (lastRehydrateWatermark === this.#state.appliedRevision) await delay(10, signal);
          this.#state = await this.#datastore.readShard(this.#key);
          lastRehydrateWatermark = this.#state.appliedRevision;
          continue;
        }

        for (const ev of seg.events) this.#state = shardFoldApplyEvent(this.#state, ev, this.#key);

        if (seg.events.length < GraphShardGrain.#batchSize) {
          // A short page proves we drained to the observed head; jump the watermark to it (covers
          // the seed/change-free-head case where head > the last event's revision). The pinned
          // revision is always <= the grain head, so the loop condition now releases us.
          this.#state = {
            ...this.#state,
            appliedRevision:
              this.#state.appliedRevision > seg.headRevision
                ? this.#state.appliedRevision
                : seg.headRevision,
          };
          break;
        }
      }

      return this.#serve(revision, filter);
    } finally {
      this.#gate.release();
    }
  }

  #serve(revision: bigint, filter: FullRelationshipsFilterWire | undefined): GraphShardRowsReply {
    // A revision below the shard's GC floor cannot be read exactly (rows already collected below
    // the floor would be silently missing) - reject, mirroring the `MvccSnapshotReader` constructor
    // guard. `RevisionNotFoundException` round-trips the grain boundary via its surrogate.
    if (!shardFoldIsReadableAt(this.#state, revision)) {
      throw new RevisionNotFoundException(new TimestampRevision(revision));
    }

    // `filter is null` -> the unfiltered branch. The house rule prefers `undefined`, and the
    // interface signature agrees, so this is the same single branch the C# has.
    if (filter === undefined) {
      return { rows: shardFoldVisibleAt(this.#state, revision) };
    }

    // Subject-filter pushdown (scalability-program 3.2): apply the filter server-side so the reply
    // is O(matches), not O(userset). Converted ONCE per call; the row conversion reuses the same
    // `wire-convert` mapping the reader applies client-side, so server-side and client-side
    // `matches` can never disagree on a row. Expiration deliberately stays a caller-side,
    // caller-clock concern (see `IGraphShardGrain.rowsAt`). When every selector is index-servable
    // the candidates come from the subject-keyed index; the FULL pipeline - visibility + convert +
    // `matches` - still runs over the candidates, so an index-served answer is byte-identical to
    // the scan. Any other selector shape falls the whole call back to the scan.
    const coreFilter = toCoreFilter(filter);

    const candidates = this.#tryCollectIndexCandidates(coreFilter);
    if (candidates !== undefined) {
      const served: RelationshipWire[] = [];
      for (const row of candidates) {
        if (
          shardFoldIsVisibleAt(row, revision) &&
          relationshipsFilterMatches(coreFilter, toRelationship(row.relationship))
        ) {
          served.push(row.relationship);
        }
      }
      return { rows: served };
    }

    return {
      rows: shardFoldVisibleAt(this.#state, revision).filter((row) =>
        relationshipsFilterMatches(coreFilter, toRelationship(row)),
      ),
    };
  }

  /**
   * Collects the candidate rows for `filter` from the subject-keyed index, when every selector is
   * index-servable; returns `undefined` (whole call falls back to the full scan) when any selector
   * shape the index cannot serve appears - no selectors at all, a type without ids, ids without a
   * type, or a relation filter other than the exact non-terminal shape.
   *
   * Per-branch superset arguments:
   *  - explicit type + explicit ids: a bucket holds EVERY stored row of that (type, id) subject
   *    regardless of subject relation - a superset of any relation-filtered selector over it, so
   *    the final `matches` narrows and can never miss;
   *  - `onlyNonEllipsisRelations` with no type/ids (and no other relation constraint): the
   *    non-terminals list is EXACTLY that selector's domain.
   *
   * Candidates are deduplicated by REFERENCE: a non-terminal row appears in both its subject's
   * bucket and the non-terminals list, and multiple stored versions of one identity are distinct
   * instances that must each survive to the visibility check.
   *
   * The C#'s `bool TryX(..., out candidates)` becomes a function returning the collection or
   * `undefined`; there is no "false with a defaulted out value" path the caller reads.
   */
  #tryCollectIndexCandidates(
    filter: RelationshipsFilter,
  ): ReadonlySet<StoredRelationshipWire> | undefined {
    const selectors = filter.optionalSubjectsSelectors;
    if (selectors === undefined || selectors.length === 0) return undefined;

    for (const selector of selectors) {
      const servableBucketProbe =
        selector.optionalSubjectType !== undefined &&
        selector.optionalSubjectIds !== undefined &&
        selector.optionalSubjectIds.length > 0;
      const relationFilter = selector.relationFilter;
      const servableNonTerminal =
        selector.optionalSubjectType === undefined &&
        (selector.optionalSubjectIds === undefined || selector.optionalSubjectIds.length === 0) &&
        relationFilter !== undefined &&
        relationFilter.nonEllipsisRelation === undefined &&
        relationFilter.includeEllipsisRelation !== true &&
        relationFilter.onlyNonEllipsisRelations === true;
      if (!servableBucketProbe && !servableNonTerminal) return undefined;
    }

    this.#ensureIndex();

    const collected = new Set<StoredRelationshipWire>();
    for (const selector of selectors) {
      const subjectType = selector.optionalSubjectType;
      if (subjectType !== undefined) {
        for (const id of selector.optionalSubjectIds ?? []) {
          const bucket = this.#subjectIndex?.get(subjectIndexKey(subjectType, id));
          if (bucket !== undefined) for (const row of bucket) collected.add(row);
        }
      } else {
        for (const row of this.#nonTerminalRows ?? []) collected.add(row);
      }
    }

    return collected;
  }

  /** Rebuilds the subject-keyed index iff the served state instance changed (see the field remarks). */
  #ensureIndex(): void {
    if (this.#indexedState === this.#state) return;

    const subjectIndex = new Map<string, StoredRelationshipWire[]>();
    const nonTerminals: StoredRelationshipWire[] = [];
    for (const row of this.#state.rows) {
      const rel = row.relationship;
      const key = subjectIndexKey(rel.subjectType, rel.subjectId);
      let bucket = subjectIndex.get(key);
      if (bucket === undefined) {
        bucket = [];
        subjectIndex.set(key, bucket);
      }
      bucket.push(row);

      // The stored subject relation is normalized on fold (empty => ellipsis; see
      // `shardFoldApplyEvent`), so the ellipsis comparison is exact.
      if (rel.subjectRelation !== ELLIPSIS) nonTerminals.push(row);
    }

    this.#subjectIndex = subjectIndex;
    this.#nonTerminalRows = nonTerminals;
    this.#indexedState = this.#state;
  }
}

/**
 * The C#'s `(string SubjectType, string SubjectId)` value-tuple dictionary key. A JS `Map` keys by
 * reference, so the tuple becomes a canonical string - LENGTH-PREFIXED, because subject ids may
 * contain any character and a delimiter-joined key would not be unconditionally injective.
 */
function subjectIndexKey(subjectType: string, subjectId: string): string {
  return `${subjectType.length}:${subjectType}${subjectId.length}:${subjectId}`;
}

/**
 * `Task.Delay(TimeSpan.FromMilliseconds(ms), cancellationToken)`. The signal race is not optional:
 * `Task.Delay` observes the token and throws, so a bare `setTimeout` await would leave one
 * unkillable window per catch-up iteration.
 */
async function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await raceSignal(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `SemaphoreSlim(1, 1)`: a NON-REENTRANT promise-chain mutex with an explicit `release`, because
 * the C# holds the permit from the top of `RowsAt`'s slow path through to the `finally` - a section
 * `AsyncSerialExecutor` cannot express, since it runs a queued callback to completion rather than
 * handing out a permit. Kept non-reentrant so the source's deadlock properties are unchanged.
 */
class ShardGate {
  #tail: Promise<void> = Promise.resolve();
  #release: (() => void) | undefined;

  async wait(signal?: AbortSignal | undefined): Promise<void> {
    // `WaitAsync(cancellationToken)` observes the token before it queues.
    signal?.throwIfAborted();
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.#release = release;
    // Cancelled while queued: hand the permit straight on rather than stalling the chain.
    if (signal?.aborted === true) {
      this.release();
      signal.throwIfAborted();
    }
  }

  release(): void {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }
}
