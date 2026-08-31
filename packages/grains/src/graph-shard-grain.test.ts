import { ELLIPSIS } from "@benedb/core/core-constants";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { RelationshipsFilter } from "@benedb/datastore/relationships-filter";
import { relationshipsFilterMatches } from "@benedb/datastore/relationships-filter";
import { grain } from "@thresh/core/decorators";
import { Grain } from "@thresh/core/grain";
import type { GrainType } from "@thresh/core/grain-type";
import type { SiloAddress } from "@thresh/core/silo-address";
import type {
  PlacementContext,
  PlacementStrategy,
} from "@thresh/runtime/placement/placement-strategy";
import { TestCluster } from "@thresh/testing/test-cluster";
import { afterEach, describe, expect, it } from "vitest";

import type { FullRelationshipsFilterWire, StoredRelationshipWire } from "./datastore-dtos";
import { GraphLocalityPlacementDirector } from "./graph-locality-placement-director";
import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import { GraphShardGrain } from "./graph-shard-grain";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import type { GraphShardKeyWire } from "./graph-shard-key";
import { graphShardKeyForResource, graphShardKeyString } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import { GRAPH_SHARD_STATE_EMPTY } from "./graph-shard-state";
import { IDatastoreGrain } from "./i-datastore-grain";
import { IGraphShardGrain } from "./i-graph-shard-grain";
import type { LogEvent, LogSegment } from "./log-event";
import type { RelationshipWire } from "./relationships-dtos";
import { shardFoldApplyEvent, shardFoldVisibleAt } from "./shard-fold";
import { toFullFilter, toRelationship } from "./wire-convert";
// The surrogate is what lets `RevisionNotFoundException` cross the grain boundary as its own
// class. `GraphShardGrain.rowsAt` both CATCHES one (from `readFrom`, to re-hydrate) and THROWS
// one (a below-floor `Serve`), so both directions are exercised below and both need this import.
import "./revision-not-found-surrogate";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/GraphShardGrain.cs`.
 *
 * NO COVERING C# TEST: every Spiceport gate on this grain (`ShardedReaderCorpusMeshTests`,
 * `ColdStartTests`) reaches it through a `MeshTestCluster`, which is a later batch. This is
 * therefore a CHARACTERIZATION of the file, pinning the behaviour the mesh suites will later
 * depend on but never name directly.
 *
 * It drives the REAL grain through a Thresh {@link TestCluster} against a SCRIPTED
 * `IDatastoreGrain` registered under the singleton key, because the interesting behaviour of this
 * file is not what the sequencer stores - that is `DatastoreGrain`'s own gate - but exactly which
 * sequencer calls the shard makes, in which order, and how it reacts when `readFrom` rejects a
 * cursor. A real `DatastoreGrain` cannot be made to reject one on demand.
 *
 * The seven things this file exists to pin, and why each is easy to lose:
 *
 *  1. A COLD SHARD ALWAYS HYDRATES VIA `readShard`, never by replaying `readFrom(0n)`. The log's
 *     retained tail starts at the compaction floor, so a from-zero replay silently misses
 *     compacted history and produces a shard that is WRONG, not merely stale. This is the single
 *     most tempting shortcut in the file.
 *  2. THE UNGATED FAST PATH. `hydrated && appliedRevision >= revision && isReadableAt` serves with
 *     no single-flight gate at all. That is safe ONLY because the state is an immutable record
 *     REPLACED WHOLE: an interleaved reader sees either the previous fold or the new one, never a
 *     partial. A `ShardFold` that mutated state in place would make this unsafe silently, so the
 *     no-further-calls assertion below is a proxy for the ungated serve actually existing.
 *  3. THE CATCH-UP LOOP: pages of exactly 256 (the Watch feed's page size); a SHORT page proves we
 *     drained to the observed head and jumps the watermark to `max(applied, headRevision)` before
 *     breaking - which is what covers the change-free-head case where head exceeds the last
 *     event's revision.
 *  4. `RevisionNotFoundException` FROM `readFrom` re-hydrates from a fresh per-key snapshot and
 *     continues; a re-hydrate that does NOT advance the watermark sleeps 10ms FIRST, the
 *     compaction-window guard against hot-spinning the singleton right after a commit.
 *  5. `Serve` REJECTS A BELOW-FLOOR REVISION BEFORE ANY FILTERING, mirroring the
 *     `MvccSnapshotReader` constructor guard. The GC-floor stance is deliberate: a shard enforces
 *     the floor IT has folded, never a per-read probe of the singleton.
 *  6. THE SUBJECT-KEYED INDEX narrows the candidate set and NOTHING ELSE: the full pipeline
 *     (visibility + convert + `matches`) still runs over the candidates, so an index-served answer
 *     is byte-identical to the scan. Every index case below asserts against the scan's own answer
 *     rather than a hand-written expectation, so the two can never drift apart in the test.
 *  7. EXPIRATION IS NOT FILTERED SHARD-SIDE. It is a caller-side, caller-clock concern, so the
 *     same shard reply serves callers with different clocks.
 */

// --- the scripted sequencer -------------------------------------------------------------------

/** One recorded call the shard made to the singleton. */
type SequencerCall =
  | { readonly kind: "readShard"; readonly key: string; readonly at: number }
  | { readonly kind: "readFrom"; readonly afterRevision: bigint; readonly maxCount: number };

interface Script {
  /** What `readShard` answers, per canonical shard-key string. Consumed in order when several. */
  readonly shards: Map<string, GraphShardState[]>;
  /** What `readFrom` answers (or throws), consumed in order; the last entry repeats. */
  readonly pages: Array<LogSegment | RevisionNotFoundException>;
  readonly calls: SequencerCall[];
}

let script: Script = { shards: new Map(), pages: [], calls: [] };

function resetScript(): void {
  script = { shards: new Map(), pages: [], calls: [] };
}

/** Queues the answer(s) `readShard` gives for `key`, in order; the last queued answer repeats. */
function stubShard(key: GraphShardKeyWire, ...states: GraphShardState[]): void {
  script.shards.set(graphShardKeyString(key), [...states]);
}

function readShardCalls(): readonly SequencerCall[] {
  return script.calls.filter((c) => c.kind === "readShard");
}

function readFromCalls(): ReadonlyArray<Extract<SequencerCall, { kind: "readFrom" }>> {
  return script.calls.filter(
    (c): c is Extract<SequencerCall, { kind: "readFrom" }> => c.kind === "readFrom",
  );
}

/**
 * The scripted stand-in for the cluster-singleton sequencer. Only the two members
 * `GraphShardGrain` reaches - `readShard` and `readFrom` - are implemented; every other
 * `IDatastoreGrain` member is deliberately absent, so a port that reaches for one (a per-read
 * `getHead` floor probe, say - the exact "fix" the GC-floor stance forbids) fails loudly here
 * rather than passing with the wrong design.
 */
@grain()
class ScriptedDatastoreGrain extends Grain {
  async readShard(key: GraphShardKeyWire): Promise<GraphShardState> {
    script.calls.push({ kind: "readShard", key: graphShardKeyString(key), at: Date.now() });
    const queued = script.shards.get(graphShardKeyString(key));
    if (queued === undefined || queued.length === 0) return GRAPH_SHARD_STATE_EMPTY;
    return queued.length === 1 ? queued[0]! : queued.shift()!;
  }

  async readFrom(afterRevision: bigint, maxCount: number): Promise<LogSegment> {
    script.calls.push({ kind: "readFrom", afterRevision, maxCount });
    const next = script.pages.length > 1 ? script.pages.shift()! : script.pages[0];
    if (next === undefined) return { events: [], headRevision: afterRevision };
    if (next instanceof RevisionNotFoundException) throw next;
    return next;
  }
}

// --- fixtures ---------------------------------------------------------------------------------

/** Records what the placement director was asked, so the grain-key-reaches-placement fix is pinned. */
class RecordingPlacementDirector implements PlacementStrategy {
  readonly seen: Array<string | undefined> = [];
  readonly #inner = new GraphLocalityPlacementDirector();

  choose(
    grainType: GrainType,
    candidates: readonly SiloAddress[],
    context: PlacementContext,
  ): SiloAddress {
    const key = context.grainId?.key;
    this.seen.push(typeof key === "string" ? key : undefined);
    return this.#inner.choose(grainType, candidates, context);
  }
}

interface Fixture {
  readonly cluster: TestCluster;
  readonly placement: RecordingPlacementDirector;
}

let fixture: Fixture | undefined;

async function start(): Promise<Fixture> {
  resetScript();
  const placement = new RecordingPlacementDirector();
  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: [
      { ctor: GraphShardGrain, interfaces: [IGraphShardGrain] },
      {
        ctor: ScriptedDatastoreGrain as unknown as typeof GraphShardGrain,
        interfaces: [IDatastoreGrain as unknown as typeof IGraphShardGrain],
      },
    ],
    configureSilo: (builder) => {
      builder.addPlacementStrategy(GRAPH_LOCALITY_PLACEMENT_STRATEGY, placement);
    },
  });
  fixture = { cluster, placement };
  return fixture;
}

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  if (current !== undefined) await current.cluster.dispose();
});

function shardGrain(cluster: TestCluster, key: GraphShardKeyWire): IGraphShardGrain {
  return cluster.primary.host.getGrain(IGraphShardGrain, graphShardGrainKeyBuild(key));
}

// --- data helpers -----------------------------------------------------------------------------

const DOC = graphShardKeyForResource("document", "doc1");

function wire(
  subjectType: string,
  subjectId: string,
  subjectRelation: string = ELLIPSIS,
  extra: Partial<RelationshipWire> = {},
): RelationshipWire {
  return {
    resourceType: "document",
    resourceId: "doc1",
    resourceRelation: "viewer",
    subjectType,
    subjectId,
    subjectRelation,
    ...extra,
  };
}

function row(
  relationship: RelationshipWire,
  createdRevision: bigint,
  deletedRevision?: bigint,
): StoredRelationshipWire {
  return { relationship, createdRevision, deletedRevision };
}

function state(
  appliedRevision: bigint,
  rows: readonly StoredRelationshipWire[],
  gcFloor = 0n,
): GraphShardState {
  return { appliedRevision, gcFloor, rows };
}

function touchEvent(revision: bigint, ...relationships: RelationshipWire[]): LogEvent {
  return {
    revision,
    relationshipChanges: relationships.map((relationship) => ({
      operation: "touch" as const,
      relationship,
    })),
    counterChanges: [],
  };
}

/** The canonical `resourceType:resourceId#relation@subjectType:subjectId#subjectRelation` form. */
function tuple(rel: RelationshipWire): string {
  return `${rel.resourceType}:${rel.resourceId}#${rel.resourceRelation}@${rel.subjectType}:${rel.subjectId}#${rel.subjectRelation}`;
}

function tuples(rows: readonly RelationshipWire[]): string[] {
  return rows.map(tuple).sort();
}

/**
 * The answer a pure SCAN would give for `filter` over `state` at `revision` - visibility, then
 * convert, then `matches`, exactly the unindexed branch of `Serve`. Every index case asserts the
 * grain's reply equals THIS, never a hand-written list, so the index can only ever be judged
 * against the scan it must be byte-identical to.
 */
function scanAnswer(
  shard: GraphShardState,
  revision: bigint,
  filter: RelationshipsFilter,
): string[] {
  return tuples(
    shardFoldVisibleAt(shard, revision).filter((rel) =>
      relationshipsFilterMatches(filter, toRelationship(rel)),
    ),
  );
}

function full(filter: RelationshipsFilter): FullRelationshipsFilterWire {
  return toFullFilter(filter);
}

describe("GraphShardGrain", () => {
  describe("hydration", () => {
    /**
     * THE most important assertion in the file. A cold shard hydrates from the per-key snapshot
     * and NOTHING else: no `readFrom(0n, ...)` replay, because the log's retained tail starts at
     * the compaction floor and a from-zero replay would silently miss compacted history. A port
     * that "simplifies" hydration into a log replay passes almost every other case here.
     */
    it("hydrates a cold shard via readShard, never by replaying readFrom from zero", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(100n, [row(wire("user", "alice"), 50n)]));

      const reply = await shardGrain(cluster, DOC).rowsAt(100n, undefined);

      expect(tuples(reply.rows)).toEqual(["document:doc1#viewer@user:alice#..."]);
      expect(readShardCalls()).toHaveLength(1);
      expect(readFromCalls()).toHaveLength(0);
    });

    /** The hydration read is for the key parsed out of THIS grain's own string key. */
    it("hydrates the shard key its own grain key names", async () => {
      const { cluster } = await start();
      const other = graphShardKeyForResource("document", "doc2");
      stubShard(DOC, state(10n, [row(wire("user", "alice"), 5n)]));
      stubShard(other, state(10n, [row(wire("user", "bob"), 5n)]));

      await shardGrain(cluster, other).rowsAt(10n, undefined);

      expect(readShardCalls().map((c) => (c as { key: string }).key)).toEqual([
        graphShardKeyString(other),
      ]);
    });

    /**
     * The ungated fast path: once hydrated and the watermark covers the revision, a serve makes NO
     * sequencer call at all - not even the single-flight gate is taken. Observable only as the
     * absence of calls, which is exactly why it is asserted here: this is what makes a hot shard
     * O(1) rather than a queue behind an in-flight fold.
     */
    it("serves a covered revision from the activation with no further sequencer calls", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(100n, [row(wire("user", "alice"), 50n)]));
      const target = shardGrain(cluster, DOC);

      await target.rowsAt(100n, undefined);
      const after = script.calls.length;
      await target.rowsAt(60n, undefined);
      await target.rowsAt(100n, undefined);

      expect(script.calls.length).toBe(after);
    });
  });

  describe("catch-up", () => {
    /**
     * The pull loop's page size is 256 - the Watch feed's own page size. It is not a tuning knob
     * with a free choice: a shard and the Watch feed paging differently is the kind of divergence
     * that only shows up as a throughput cliff under load.
     */
    it("pulls the log tail in pages of 256 and folds every event", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(0n, []));
      const firstPage = Array.from({ length: 256 }, (_unused, i) =>
        touchEvent(BigInt(i + 1), wire("user", `u${i}`)),
      );
      script.pages.push(
        { events: firstPage, headRevision: 300n },
        { events: [touchEvent(257n, wire("user", "last"))], headRevision: 300n },
      );

      const reply = await shardGrain(cluster, DOC).rowsAt(257n, undefined);

      expect(readFromCalls().map((c) => c.maxCount)).toEqual([256, 256]);
      expect(readFromCalls().map((c) => c.afterRevision)).toEqual([0n, 256n]);
      expect(reply.rows).toHaveLength(257);
      expect(tuples(reply.rows)).toContain("document:doc1#viewer@user:last#...");
    });

    /**
     * A SHORT page proves the shard drained to the head the sequencer observed, so the watermark
     * jumps to `max(applied, headRevision)` - covering the change-free-head case, where the head
     * has advanced past the last event that touched THIS key. Without the jump the shard re-pulls
     * the tail on every single read of a revision above its last matching event: correct, but a
     * per-read round trip to the singleton for every hot shard in the cluster.
     */
    it("jumps the watermark to the observed head on a short page", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(0n, []));
      script.pages.push({ events: [touchEvent(5n, wire("user", "alice"))], headRevision: 900n });
      const target = shardGrain(cluster, DOC);

      await target.rowsAt(5n, undefined);
      const afterFirst = readFromCalls().length;
      // 900 was never the revision of an event this shard folded; only the head jump covers it.
      const reply = await target.rowsAt(900n, undefined);

      expect(readFromCalls().length).toBe(afterFirst);
      expect(tuples(reply.rows)).toEqual(["document:doc1#viewer@user:alice#..."]);
    });

    /**
     * The watermark advances on EVERY folded event, matching or not - that is what makes
     * "watermark >= revision" a closed-timestamp gate rather than a per-key one. Here the only
     * event in the page belongs to a DIFFERENT shard key, and the read at its revision must still
     * be served (empty) rather than looping forever waiting for a matching event.
     */
    it("advances the watermark through events that do not match its key", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(0n, []));
      script.pages.push({
        events: [
          {
            revision: 7n,
            relationshipChanges: [
              {
                operation: "touch",
                relationship: { ...wire("user", "alice"), resourceId: "somewhere-else" },
              },
            ],
            counterChanges: [],
          },
        ],
        headRevision: 7n,
      });

      const reply = await shardGrain(cluster, DOC).rowsAt(7n, undefined);

      expect(reply.rows).toEqual([]);
      expect(readFromCalls()).toHaveLength(1);
    });

    /**
     * A cursor that fell below the sequencer's retained window re-hydrates from a FRESH per-key
     * snapshot and continues the loop - it does not fail the read, and it does not fall back to a
     * from-zero replay.
     */
    it("re-hydrates from a fresh snapshot when readFrom rejects the cursor", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(10n, []), state(80n, [row(wire("user", "alice"), 70n)]));
      script.pages.push(new RevisionNotFoundException(new TimestampRevision(10n)), {
        events: [touchEvent(90n, wire("user", "bob"))],
        headRevision: 90n,
      });

      const reply = await shardGrain(cluster, DOC).rowsAt(90n, undefined);

      expect(readShardCalls()).toHaveLength(2);
      expect(tuples(reply.rows)).toEqual([
        "document:doc1#viewer@user:alice#...",
        "document:doc1#viewer@user:bob#...",
      ]);
      // The re-hydrate resumes from the FRESH watermark, never from zero.
      expect(readFromCalls().map((c) => c.afterRevision)).toEqual([10n, 80n]);
    });

    /**
     * The compaction-window guard. Right after a commit the singleton's own post-commit compaction
     * can briefly leave the freshly hydrated head below the retained tail's floor, so `readFrom`
     * keeps rejecting the cursor the re-hydrate just produced. Re-hydrating AGAIN with no watermark
     * advance therefore sleeps 10ms FIRST rather than hot-spinning the cluster singleton.
     *
     * Pinned as elapsed time between the non-advancing re-hydrates, not as a call count: the count
     * alone cannot distinguish a back-off from a spin. The bound is deliberately loose (>= 5ms for
     * a 10ms sleep) because timer granularity is not what is under test - the ABSENCE of a sleep
     * is, and that shows up as a sub-millisecond gap.
     */
    it("backs off before re-hydrating again when the watermark did not advance", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(10n, []), state(10n, []), state(95n, []));
      script.pages.push(
        new RevisionNotFoundException(new TimestampRevision(10n)),
        new RevisionNotFoundException(new TimestampRevision(10n)),
        { events: [], headRevision: 95n },
      );

      await shardGrain(cluster, DOC).rowsAt(95n, undefined);

      const hydrations = readShardCalls() as ReadonlyArray<{ at: number }>;
      expect(hydrations).toHaveLength(3);
      // The FIRST re-hydrate (calls[1]) advanced nothing, so the SECOND (calls[2]) is the one that
      // must have slept first.
      expect(hydrations[2]!.at - hydrations[1]!.at).toBeGreaterThanOrEqual(5);
    });
  });

  describe("the GC floor", () => {
    /**
     * A revision below the shard's own folded floor cannot be read exactly - rows already
     * collected below it would be silently missing - so `Serve` rejects BEFORE any filtering,
     * mirroring the `MvccSnapshotReader` constructor guard. The filter here would match nothing at
     * all, so an implementation that filtered first would return an empty reply instead of
     * throwing, and every stale-token caller would silently get a wrong (empty) answer.
     */
    it("rejects a below-floor revision before applying the filter", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(500n, [row(wire("user", "alice"), 400n)], 300n));
      const matchesNothing = full({ optionalResourceType: "no-such-type" });

      await expect(shardGrain(cluster, DOC).rowsAt(299n, matchesNothing)).rejects.toBeInstanceOf(
        RevisionNotFoundException,
      );
    });

    /** The floor is INCLUSIVE-readable: a read exactly AT the floor is still exact. */
    it("serves a read exactly at the floor", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(500n, [row(wire("user", "alice"), 400n)], 300n));

      const reply = await shardGrain(cluster, DOC).rowsAt(400n, undefined);

      expect(tuples(reply.rows)).toEqual(["document:doc1#viewer@user:alice#..."]);
    });

    /**
     * The GC-floor stance is deliberately SHARD-LOCAL: the shard enforces the floor IT has folded
     * and never probes the singleton per read. Pinned as the absence of any extra sequencer call
     * on the rejecting path - a port that "fixed" this into a per-read floor probe would make one.
     */
    it("enforces its own folded floor without probing the singleton", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(500n, [row(wire("user", "alice"), 400n)], 300n));
      const target = shardGrain(cluster, DOC);

      await target.rowsAt(500n, undefined);
      const after = script.calls.length;
      await expect(target.rowsAt(299n, undefined)).rejects.toBeInstanceOf(
        RevisionNotFoundException,
      );

      expect(script.calls.length).toBe(after);
    });
  });

  describe("serving", () => {
    /** The half-open MVCC window `[created, deleted)`, filtered shard-side. */
    it("returns exactly the rows visible at the pinned revision", async () => {
      const { cluster } = await start();
      stubShard(
        DOC,
        state(100n, [
          row(wire("user", "alice"), 10n, 50n),
          row(wire("user", "bob"), 50n),
          row(wire("user", "carol"), 90n),
        ]),
      );
      const target = shardGrain(cluster, DOC);

      expect(tuples((await target.rowsAt(10n, undefined)).rows)).toEqual([
        "document:doc1#viewer@user:alice#...",
      ]);
      // 50 is alice's deleted revision (exclusive) and bob's created revision (inclusive).
      expect(tuples((await target.rowsAt(50n, undefined)).rows)).toEqual([
        "document:doc1#viewer@user:bob#...",
      ]);
      expect(tuples((await target.rowsAt(90n, undefined)).rows)).toEqual([
        "document:doc1#viewer@user:bob#...",
        "document:doc1#viewer@user:carol#...",
      ]);
    });

    /**
     * EXPIRATION IS NOT A SHARD CONCERN. It depends on the evaluation "now", a caller-clock
     * concern, so the same shard reply must serve callers with different clocks; the caller-side
     * readers filter it. A shard that sheared expired rows would make `relexpiration.yaml`'s
     * caller-pinned "now" unobservable.
     */
    it("does not filter expired rows", async () => {
      const { cluster } = await start();
      const expired = wire("user", "alice", ELLIPSIS, { expiration: 1n });
      stubShard(DOC, state(100n, [row(expired, 10n)]));

      const reply = await shardGrain(cluster, DOC).rowsAt(100n, undefined);

      expect(tuples(reply.rows)).toEqual(["document:doc1#viewer@user:alice#..."]);
    });

    /** An absent filter is the unfiltered branch - distinct from a filter that matches everything. */
    it("returns every visible row for an absent filter", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(100n, [row(wire("user", "alice"), 10n), row(wire("user", "bob"), 10n)]));

      const reply = await shardGrain(cluster, DOC).rowsAt(100n, undefined);

      expect(reply.rows).toHaveLength(2);
    });
  });

  describe("the subject-keyed index", () => {
    // Six rows spanning every shape the servability test discriminates: terminal subjects, a
    // non-terminal subject, a wildcard, and two stored VERSIONS of one identity.
    const ROWS: readonly StoredRelationshipWire[] = [
      row(wire("user", "alice"), 10n),
      row(wire("user", "bob"), 10n),
      row(wire("user", "*"), 10n),
      row(wire("group", "g1", "member"), 10n),
      row(wire("group", "g2", "member"), 10n),
      // Two versions of ONE identity: the first is superseded at 60, the second live from 60.
      row(wire("user", "dave", ELLIPSIS, { caveatName: "old" }), 10n, 60n),
      row(wire("user", "dave", ELLIPSIS, { caveatName: "new" }), 60n),
    ];
    const SHARD = state(100n, ROWS);

    async function served(
      filter: RelationshipsFilter,
      revision = 100n,
    ): Promise<{ readonly grain: string[]; readonly scan: string[] }> {
      const { cluster } = await start();
      stubShard(DOC, SHARD);
      const reply = await shardGrain(cluster, DOC).rowsAt(revision, full(filter));
      return { grain: tuples(reply.rows), scan: scanAnswer(SHARD, revision, filter) };
    }

    /** Index-servable shape 1: an explicit subject type with explicit ids. */
    it("serves an explicit type-and-ids selector identically to the scan", async () => {
      const { grain: answer, scan } = await served({
        optionalSubjectsSelectors: [
          { optionalSubjectType: "user", optionalSubjectIds: ["alice", "bob"] },
        ],
      });

      expect(answer).toEqual(scan);
      expect(answer).toEqual([
        "document:doc1#viewer@user:alice#...",
        "document:doc1#viewer@user:bob#...",
      ]);
    });

    /**
     * Index-servable shape 2, and the ONLY relation-filtered shape the index serves: no type, no
     * ids, and exactly `{ nonEllipsisRelation: absent, includeEllipsisRelation: false,
     * onlyNonEllipsisRelations: true }`. The stored subject relation is NORMALIZED on fold (empty
     * becomes the ellipsis), which is what makes the ellipsis comparison an exact one.
     */
    it("serves the bare non-terminal selector identically to the scan", async () => {
      const { grain: answer, scan } = await served({
        optionalSubjectsSelectors: [{ relationFilter: { onlyNonEllipsisRelations: true } }],
      });

      expect(answer).toEqual(scan);
      expect(answer).toEqual([
        "document:doc1#viewer@group:g1#member",
        "document:doc1#viewer@group:g2#member",
      ]);
    });

    /**
     * The exact selector union `LocalDispatcher.checkDirect` pushes down: an exact-subject
     * selector, a wildcard selector, and the bare non-terminal selector. All three are servable,
     * so this is the shape the hot check path actually takes through the index - and it must equal
     * the scan row for row, wildcard included.
     */
    it("serves the check path's three-selector pushdown identically to the scan", async () => {
      const { grain: answer, scan } = await served({
        optionalResourceType: "document",
        optionalResourceIds: ["doc1"],
        optionalResourceRelation: "viewer",
        optionalSubjectsSelectors: [
          {
            optionalSubjectType: "user",
            optionalSubjectIds: ["alice"],
            relationFilter: { includeEllipsisRelation: true },
          },
          {
            optionalSubjectType: "user",
            optionalSubjectIds: ["*"],
            relationFilter: { includeEllipsisRelation: true },
          },
          { relationFilter: { onlyNonEllipsisRelations: true } },
        ],
      });

      expect(answer).toEqual(scan);
      expect(answer).toEqual([
        "document:doc1#viewer@group:g1#member",
        "document:doc1#viewer@group:g2#member",
        "document:doc1#viewer@user:*#...",
        "document:doc1#viewer@user:alice#...",
      ]);
    });

    /**
     * A row reachable through BOTH an id bucket and the non-terminals list appears exactly ONCE:
     * the candidate collection dedups. It dedups BY REFERENCE, which is why the next case matters.
     */
    it("returns a row reachable through two selectors exactly once", async () => {
      const { grain: answer, scan } = await served({
        optionalSubjectsSelectors: [
          { optionalSubjectType: "group", optionalSubjectIds: ["g1"] },
          { relationFilter: { onlyNonEllipsisRelations: true } },
        ],
      });

      expect(answer).toEqual(scan);
      expect(answer).toEqual([
        "document:doc1#viewer@group:g1#member",
        "document:doc1#viewer@group:g2#member",
      ]);
    });

    /**
     * The candidate dedup is by REFERENCE, deliberately: multiple stored VERSIONS of one identity
     * are distinct row instances that must EACH survive to the visibility check, because which one
     * is visible depends on the pinned revision. A value-keyed dedup would collapse them and the
     * older revision would be served the newer payload (or nothing at all).
     */
    it("keeps every stored version of one identity as its own candidate", async () => {
      const daveOnly: RelationshipsFilter = {
        optionalSubjectsSelectors: [{ optionalSubjectType: "user", optionalSubjectIds: ["dave"] }],
      };
      const { cluster } = await start();
      stubShard(DOC, SHARD);
      const target = shardGrain(cluster, DOC);

      const before = await target.rowsAt(50n, full(daveOnly));
      const after = await target.rowsAt(70n, full(daveOnly));

      expect(before.rows.map((r) => r.caveatName)).toEqual(["old"]);
      expect(after.rows.map((r) => r.caveatName)).toEqual(["new"]);
      expect(tuples(before.rows)).toEqual(scanAnswer(SHARD, 50n, daveOnly));
      expect(tuples(after.rows)).toEqual(scanAnswer(SHARD, 70n, daveOnly));
    });

    // --- fall-back shapes: the whole call reverts to the scan, and the answer is unchanged ------

    it("falls back to the scan for a type with no ids", async () => {
      const { grain: answer, scan } = await served({
        optionalSubjectsSelectors: [{ optionalSubjectType: "user" }],
      });

      expect(answer).toEqual(scan);
      expect(answer).toEqual([
        "document:doc1#viewer@user:*#...",
        "document:doc1#viewer@user:alice#...",
        "document:doc1#viewer@user:bob#...",
        "document:doc1#viewer@user:dave#...",
      ]);
    });

    it("falls back to the scan for ids with no type", async () => {
      const { grain: answer, scan } = await served({
        optionalSubjectsSelectors: [{ optionalSubjectIds: ["alice"] }],
      });

      expect(answer).toEqual(scan);
    });

    /**
     * The non-terminal branch is servable ONLY in its exact shape. `includeEllipsisRelation: true`
     * alongside `onlyNonEllipsisRelations` is a different domain than the non-terminals list, so
     * the whole call falls back.
     */
    it("falls back to the scan when the non-terminal selector carries any other relation constraint", async () => {
      const { grain: answer, scan } = await served({
        optionalSubjectsSelectors: [
          {
            relationFilter: { onlyNonEllipsisRelations: true, includeEllipsisRelation: true },
          },
        ],
      });

      expect(answer).toEqual(scan);
    });

    it("falls back to the scan for a bare non-ellipsis relation selector", async () => {
      const { grain: answer, scan } = await served({
        optionalSubjectsSelectors: [{ relationFilter: { nonEllipsisRelation: "member" } }],
      });

      expect(answer).toEqual(scan);
      expect(answer).toEqual([
        "document:doc1#viewer@group:g1#member",
        "document:doc1#viewer@group:g2#member",
      ]);
    });

    /** ONE unservable selector falls the WHOLE call back, not just that selector. */
    it("falls back to the scan when any one selector of several is unservable", async () => {
      const { grain: answer, scan } = await served({
        optionalSubjectsSelectors: [
          { optionalSubjectType: "user", optionalSubjectIds: ["alice"] },
          { optionalSubjectType: "group" },
        ],
      });

      expect(answer).toEqual(scan);
      expect(answer).toEqual([
        "document:doc1#viewer@group:g1#member",
        "document:doc1#viewer@group:g2#member",
        "document:doc1#viewer@user:alice#...",
      ]);
    });

    it("falls back to the scan for a filter with no subject selectors at all", async () => {
      const { grain: answer, scan } = await served({ optionalResourceRelation: "viewer" });

      expect(answer).toEqual(scan);
      expect(answer).toHaveLength(6);
    });

    it("falls back to the scan for an empty subject-selector list", async () => {
      const { grain: answer, scan } = await served({ optionalSubjectsSelectors: [] });

      expect(answer).toEqual(scan);
    });

    /**
     * The index narrows CANDIDATES only: the full pipeline still runs over them, so a resource-side
     * constraint that excludes an index-selected row must still exclude it from the reply.
     */
    it("still applies the non-subject parts of the filter to index-served candidates", async () => {
      const { grain: answer, scan } = await served({
        optionalResourceRelation: "editor",
        optionalSubjectsSelectors: [{ optionalSubjectType: "user", optionalSubjectIds: ["alice"] }],
      });

      expect(answer).toEqual(scan);
      expect(answer).toEqual([]);
    });

    /**
     * The index is rebuilt when the SERVED STATE INSTANCE changes, which is the correct staleness
     * signal only because the state is an immutable record replaced whole. Pinned from the outside
     * the only way it can be: an index-served read taken AFTER a catch-up must see the newly folded
     * rows. A stale index would keep serving the pre-catch-up candidate set.
     */
    it("reflects newly folded rows in an index-served read after a catch-up", async () => {
      const { cluster } = await start();
      stubShard(DOC, state(10n, [row(wire("user", "alice"), 5n)]));
      script.pages.push({
        events: [touchEvent(20n, wire("user", "bob"))],
        headRevision: 20n,
      });
      const filter: RelationshipsFilter = {
        optionalSubjectsSelectors: [
          { optionalSubjectType: "user", optionalSubjectIds: ["alice", "bob"] },
        ],
      };
      const target = shardGrain(cluster, DOC);

      const before = await target.rowsAt(10n, full(filter));
      const after = await target.rowsAt(20n, full(filter));

      expect(tuples(before.rows)).toEqual(["document:doc1#viewer@user:alice#..."]);
      expect(tuples(after.rows)).toEqual([
        "document:doc1#viewer@user:alice#...",
        "document:doc1#viewer@user:bob#...",
      ]);
    });
  });

  describe("placement", () => {
    /**
     * `[GraphLocalityPlacement]` becomes Thresh's `{ placement: "custom", strategy }` metadata plus
     * the silo-side registration. A Thresh bug where the placement director never received the
     * grain key was found and fixed from this layer; this pins that the fix still holds for THIS
     * grain, whose whole locality argument is a function of its key.
     */
    it("hands the shard's grain key to the placement director", async () => {
      const { cluster, placement } = await start();
      stubShard(DOC, state(10n, []));

      await shardGrain(cluster, DOC).rowsAt(10n, undefined);

      expect(placement.seen).toContain(graphShardGrainKeyBuild(DOC));
    });
  });

  describe("the fold's immutability", () => {
    /**
     * Not a grain assertion but the PREMISE of the ungated fast path, asserted here because this
     * is where losing it would be silent: `shardFoldApplyEvent` must return a FRESH state and
     * leave the old one untouched. If the port ever mutated in place, the fast path's "a reader
     * sees either the previous fold or the new one, never a partial" evaporates with nothing else
     * in this file failing.
     */
    it("replaces the state whole rather than mutating it in place", () => {
      const before = state(10n, [row(wire("user", "alice"), 5n)]);
      const after = shardFoldApplyEvent(before, touchEvent(20n, wire("user", "bob")), DOC);

      expect(after).not.toBe(before);
      expect(before.rows).toHaveLength(1);
      expect(before.appliedRevision).toBe(10n);
      expect(after.rows).toHaveLength(2);
    });
  });
});
