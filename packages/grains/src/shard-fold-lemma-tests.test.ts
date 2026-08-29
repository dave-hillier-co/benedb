import type { SeededRandom } from "@spacedb/engine/seeded-random";
import { createSeededRandom } from "@spacedb/engine/seeded-random";
import { describe, expect, it } from "vitest";

import type { StoredRelationshipWire } from "./datastore-dtos";
import type { DatastoreGrainState } from "./datastore-grain-state";
import { datastoreGrainStateEmpty } from "./datastore-grain-state";
import type { GraphShardKeyWire } from "./graph-shard-key";
import {
  graphShardKeyForResource,
  graphShardKeyForSubject,
  graphShardKeyMatches,
  graphShardKeyString,
} from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import { GRAPH_SHARD_STATE_EMPTY } from "./graph-shard-state";
import type { CounterDeltaWire, LogEvent } from "./log-event";
import { logFoldApplyEvent } from "./log-fold";
import type { RelationshipUpdateWire, RelationshipWire } from "./relationships-dtos";
import { shardFoldApplyEvent, shardFoldIsReadableAt, shardFoldVisibleAt } from "./shard-fold";

/**
 * Ported from `tests/Spiceport.Grains.Tests/ShardFoldLemmaTests.cs`.
 *
 * Pins the sharding lemma: `fold(log) == merge over keys of fold(log|key)`. For seeded random event
 * logs (touches, creates, deletes, caveats, expirations and interleaved GC events), the per-key
 * `shardFoldApplyEvent` must reproduce, key by key, exactly the rows the whole-state
 * `logFoldApplyEvent` produces restricted to that key - and the union over all forward (or all
 * reverse) shards must reproduce the whole live set at every readable revision. This is the gate
 * that makes the graph-sharded datastore's shard state a filter of the one fold rather than a
 * divergent re-derivation. Pure fold tests - no cluster.
 *
 * Port decisions:
 *   * `[MemberData]` over 24 seeds becomes `it.for` with the seed in the title.
 *   * `new Random(seed)` becomes the port's own `createSeededRandom`. The SEQUENCE deliberately
 *     differs from .NET's (nothing compares a SpaceDB run against a Spiceport run draw by draw);
 *     what carries across is the property that made the C# gate worth having - the same seed
 *     yields the same log on every run, forever.
 *   * Expirations are `bigint` NANOS, not `DateTimeOffset`. The C#'s `NanosSinceEpoch` helper (and
 *     its tick round trip) collapses to the identity, because the port already stores expiration
 *     as nanos since the Unix epoch. `addTicks` survives only to keep the generated instants
 *     spelled the way the C# spells them.
 */
describe("shard fold lemma", () => {
  // All expirations are generated relative to this fixed instant (never "now"), so the generated
  // logs and their GC outcomes are identical on every run. Revisions are nanos-since-epoch of the
  // same instant plus small deltas, so "inside the revision range" expirations are expressible.
  const FIXED_BASE = BigInt(Date.UTC(2030, 0, 1)) * 1_000_000n;
  const ELLIPSIS = "...";

  const addTicks = (nanos: bigint, ticks: number | bigint): bigint => nanos + BigInt(ticks) * 100n;
  const addHours = (nanos: bigint, hours: number): bigint =>
    nanos + BigInt(hours) * 3_600_000_000_000n;

  const noCounterChanges: readonly CounterDeltaWire[] = [];

  const rel = (
    resourceType: string,
    resourceId: string,
    relation: string,
    subjectType: string,
    subjectId: string,
    subjectRelation: string = ELLIPSIS,
    expiration?: bigint | undefined,
  ): RelationshipWire => ({
    resourceType,
    resourceId,
    resourceRelation: relation,
    subjectType,
    subjectId,
    subjectRelation,
    caveatName: undefined,
    caveatContext: undefined,
    expiration,
  });

  const touchOf = (r: RelationshipWire): RelationshipUpdateWire => ({
    operation: "touch",
    relationship: r,
  });
  const deleteOf = (r: RelationshipWire): RelationshipUpdateWire => ({
    operation: "delete",
    relationship: r,
  });

  const ev = (revision: bigint, ...updates: RelationshipUpdateWire[]): LogEvent => ({
    revision,
    relationshipChanges: updates,
    schemaChange: undefined,
    counterChanges: noCounterChanges,
    gcFloor: undefined,
  });

  const gc = (revision: bigint, floor: bigint): LogEvent => ({
    revision,
    relationshipChanges: [],
    schemaChange: undefined,
    counterChanges: noCounterChanges,
    gcFloor: floor,
  });

  const context = (level: number): ReadonlyMap<string, unknown> =>
    new Map<string, unknown>([["level", level]]);

  // --- Canonical forms (caveat context compared by its serialized values, since maps compare by
  // reference) ---

  const contextString = (ctx: ReadonlyMap<string, unknown> | undefined): string =>
    ctx === undefined || ctx.size === 0
      ? ""
      : [...ctx.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(",");

  const canonRel = (r: RelationshipWire): string => {
    const caveat =
      r.caveatName !== undefined && r.caveatName.length > 0
        ? `[${r.caveatName}:${contextString(r.caveatContext)}]`
        : "";
    const exp = r.expiration !== undefined ? `@exp=${r.expiration}` : "";
    return (
      `${r.resourceType}:${r.resourceId}#${r.resourceRelation}` +
      `@${r.subjectType}:${r.subjectId}#${r.subjectRelation}${caveat}${exp}`
    );
  };

  const canonRow = (row: StoredRelationshipWire): string =>
    `${canonRel(row.relationship)}|c=${row.createdRevision}|d=${
      row.deletedRevision !== undefined ? row.deletedRevision : "live"
    }`;

  const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = (values: readonly string[]): readonly string[] => [...values].sort(ordinal);

  const identityOf = (r: RelationshipWire): string =>
    `${r.resourceType}:${r.resourceId}#${r.resourceRelation}@${r.subjectType}:${r.subjectId}#${r.subjectRelation}`;

  // --- Log generator ---

  const pick = (rng: SeededRandom, items: readonly string[]): string => {
    const chosen = items[rng.next(items.length)];
    if (chosen === undefined) throw new Error("empty alphabet");
    return chosen;
  };

  /** Adds a caveat (~10%) and/or an expiration (~10%) - past, mid-log, or far-future. */
  const decorate = (rng: SeededRandom, source: RelationshipWire): RelationshipWire => {
    let r = source;
    if (rng.nextDouble() < 0.1)
      r = { ...r, caveatName: "is_active", caveatContext: context(rng.next(10)) };
    if (rng.nextDouble() < 0.1) {
      const which = rng.next(3);
      const expiration =
        which === 0
          ? addTicks(FIXED_BASE, -(1 + rng.next(1000))) // below every revision: dies at the first GC
          : which === 1
            ? addTicks(FIXED_BASE, rng.next(700)) // inside the revision range: dies at some GC
            : addHours(FIXED_BASE, 1 + rng.next(24)); // far above the head: survives every GC
      r = { ...r, expiration };
    }
    return r;
  };

  const buildLog = (seed: number): { events: readonly LogEvent[]; baseRevision: bigint } => {
    const rng = createSeededRandom(seed);
    const resourceTypes = ["document", "folder", "group"];
    const resourceIds = ["d0", "d1", "d2", "d3", "d4", "d5"];
    const relations = ["viewer", "editor", "parent", "member"];
    const subjectTypes = ["user", "group"];
    const subjectIds = ["u0", "u1", "u2", "u3", "u4", "u5"];

    const baseRevision = FIXED_BASE;
    let revision = baseRevision;
    const eventCount = 60 + rng.next(61);
    const events: LogEvent[] = [];

    // Sequential liveness tracking mirroring the transaction the whole fold replays through, so a
    // generated create is never replayed over a live identity.
    const liveByIdentity = new Map<string, RelationshipWire>();
    const liveOrder: string[] = [];

    for (let i = 0; i < eventCount; i++) {
      revision += BigInt(1 + rng.next(1000));

      if (i > 0 && i % 25 === 0) {
        // Floors are event revisions ~15 events back, so some rows die below the floor and some
        // survive; the cadence (every 25) keeps successive floors strictly increasing.
        const floorEvent = events[events.length - 15];
        if (floorEvent === undefined) throw new Error("not enough events to derive a gc floor");
        events.push(gc(revision, floorEvent.revision));
        continue;
      }

      const updateCount = 1 + rng.next(5);
      const updates: RelationshipUpdateWire[] = [];
      for (let u = 0; u < updateCount; u++) {
        // Bias toward re-targeting a live identity so touches replace and deletes actually close.
        let relationship: RelationshipWire;
        if (liveOrder.length > 0 && rng.nextDouble() < 0.4) {
          const key = liveOrder[rng.next(liveOrder.length)];
          const basis = key === undefined ? undefined : liveByIdentity.get(key);
          if (basis === undefined) throw new Error("live index out of sync");
          relationship = decorate(rng, {
            ...basis,
            caveatName: undefined,
            caveatContext: undefined,
            expiration: undefined,
          });
        } else {
          const subjectId = rng.nextDouble() < 0.1 ? "*" : pick(rng, subjectIds);
          const subjectRelation = subjectId !== "*" && rng.nextDouble() < 0.2 ? "member" : ELLIPSIS;
          relationship = decorate(
            rng,
            rel(
              pick(rng, resourceTypes),
              pick(rng, resourceIds),
              pick(rng, relations),
              pick(rng, subjectTypes),
              subjectId,
              subjectRelation,
            ),
          );
        }

        const identity = identityOf(relationship);
        const roll = rng.nextDouble();
        let operation: RelationshipUpdateWire["operation"] =
          roll < 0.6 ? "touch" : roll < 0.9 ? "delete" : "create";
        if (operation === "create" && liveByIdentity.has(identity)) operation = "touch";

        if (operation === "delete") {
          if (liveByIdentity.delete(identity)) {
            const at = liveOrder.indexOf(identity);
            if (at >= 0) liveOrder.splice(at, 1);
          }
        } else if (!liveByIdentity.has(identity)) {
          liveByIdentity.set(identity, relationship);
          liveOrder.push(identity);
        } else {
          liveByIdentity.set(identity, relationship);
        }

        updates.push({ operation, relationship });
      }

      events.push(ev(revision, ...updates));
    }

    return { events, baseRevision };
  };

  const seeds = Array.from({ length: 24 }, (_, i) => i);

  it.for(seeds)("the shard fold satisfies the sharding lemma for seed %s", (seed) => {
    const { events, baseRevision } = buildLog(seed);

    let whole = datastoreGrainStateEmpty(baseRevision);
    for (const event of events) whole = logFoldApplyEvent(whole, event);

    expect(whole.relationships.length).toBeGreaterThan(0); // the lemma must never hold vacuously

    // Every key the log references, plus one forward and one reverse key it never does.
    const forwardKeys = new Map<string, GraphShardKeyWire>();
    const reverseKeys = new Map<string, GraphShardKeyWire>();
    const remember = (into: Map<string, GraphShardKeyWire>, key: GraphShardKeyWire): void => {
      into.set(graphShardKeyString(key), key);
    };
    for (const event of events) {
      for (const update of event.relationshipChanges) {
        remember(
          forwardKeys,
          graphShardKeyForResource(
            update.relationship.resourceType,
            update.relationship.resourceId,
          ),
        );
        remember(
          reverseKeys,
          graphShardKeyForSubject(update.relationship.subjectType, update.relationship.subjectId),
        );
      }
    }
    const neverForward = graphShardKeyForResource("document", "never-referenced");
    const neverReverse = graphShardKeyForSubject("user", "never-referenced");
    remember(forwardKeys, neverForward);
    remember(reverseKeys, neverReverse);

    const shards = new Map<string, { key: GraphShardKeyWire; state: GraphShardState }>();
    for (const key of [...forwardKeys.values(), ...reverseKeys.values()]) {
      let shard = GRAPH_SHARD_STATE_EMPTY;
      for (const event of events) shard = shardFoldApplyEvent(shard, event, key);
      shards.set(graphShardKeyString(key), { key, state: shard });
    }

    const shardFor = (key: GraphShardKeyWire): GraphShardState => {
      const found = shards.get(graphShardKeyString(key));
      if (found === undefined) throw new Error("missing shard");
      return found.state;
    };

    // 1 + 3: per key, the shard's rows are exactly the whole state's rows restricted to that key
    // (full payload + visibility window, order-insensitive), and every shard's watermark and GC
    // floor - matched or not by any event - equal the whole state's.
    for (const { key, state } of shards.values()) {
      expect(state.appliedRevision).toBe(whole.headRevision);
      expect(state.gcFloor).toBe(whole.gcFloor);

      const expected = sorted(
        whole.relationships
          .filter((row) => graphShardKeyMatches(key, row.relationship))
          .map(canonRow),
      );
      expect(sorted(state.rows.map(canonRow))).toEqual(expected);
    }

    // 4: never-referenced keys hold no rows but still advanced (checked above for all shards).
    expect(shardFor(neverForward).rows).toEqual([]);
    expect(shardFor(neverReverse).rows).toEqual([]);

    // 2: at sampled readable revisions (the GC floor itself, the first event at/above it, two
    // mid-log points, and the head), the multiset union of the visible rows over all forward
    // shards - and independently over all reverse shards - equals the whole state's live set.
    expect(whole.gcFloor).toBeGreaterThan(0n); // the generated log always contains GC events
    const readable = events.map((e) => e.revision).filter((r) => r >= whole.gcFloor);
    const at = (index: number): bigint => {
      const revision = readable[index];
      if (revision === undefined) throw new Error("no readable revisions");
      return revision;
    };
    const samples = new Set<bigint>([
      whole.gcFloor,
      at(0),
      at(Math.floor(readable.length / 3)),
      at(Math.floor((2 * readable.length) / 3)),
      whole.headRevision,
    ]);

    for (const revision of samples) {
      for (const { state } of shards.values())
        expect(shardFoldIsReadableAt(state, revision)).toBe(true);

      const wholeLive = sorted(
        whole.relationships
          .filter(
            (row) =>
              row.createdRevision <= revision &&
              (row.deletedRevision === undefined || row.deletedRevision > revision),
          )
          .map((row) => canonRel(row.relationship)),
      );

      const unionOf = (keys: Iterable<GraphShardKeyWire>): readonly string[] =>
        sorted([...keys].flatMap((k) => shardFoldVisibleAt(shardFor(k), revision).map(canonRel)));

      expect(unionOf(forwardKeys.values())).toEqual(wholeLive);
      expect(unionOf(reverseKeys.values())).toEqual(wholeLive);
    }
  });

  it("a touch over the same identity closes the old row and appends a new one", () => {
    const key = graphShardKeyForResource("document", "a");
    const first = rel("document", "a", "viewer", "user", "alice");
    const second = { ...first, caveatName: "is_active", caveatContext: context(7) };

    let shard = GRAPH_SHARD_STATE_EMPTY;
    shard = shardFoldApplyEvent(shard, ev(10n, touchOf(first)), key);
    shard = shardFoldApplyEvent(shard, ev(20n, touchOf(second)), key);

    expect(shard.rows).toHaveLength(2);
    expect(shard.rows.some((r) => r.createdRevision === 10n && r.deletedRevision === 20n)).toBe(
      true,
    );
    expect(
      shard.rows.some((r) => r.createdRevision === 20n && r.deletedRevision === undefined),
    ).toBe(true);

    const at15 = shardFoldVisibleAt(shard, 15n);
    expect(at15).toHaveLength(1);
    expect(canonRel(at15[0] as RelationshipWire)).toBe(canonRel(first));

    const at20 = shardFoldVisibleAt(shard, 20n);
    expect(at20).toHaveLength(1);
    expect(canonRel(at20[0] as RelationshipWire)).toBe(canonRel(second));
  });

  it("a delete of a never-created identity is a no-op but advances the watermark", () => {
    const key = graphShardKeyForResource("document", "a");

    const shard = shardFoldApplyEvent(
      GRAPH_SHARD_STATE_EMPTY,
      ev(10n, deleteOf(rel("document", "a", "viewer", "user", "ghost"))),
      key,
    );

    expect(shard.rows).toEqual([]);
    expect(shard.appliedRevision).toBe(10n);
    expect(shard.gcFloor).toBe(0n);
  });

  it("gc at exactly the deleted revision drops the row", () => {
    const key = graphShardKeyForResource("document", "a");
    const dead = rel("document", "a", "viewer", "user", "alice");
    const survivor = rel("document", "a", "viewer", "user", "bob");

    let shard = GRAPH_SHARD_STATE_EMPTY;
    shard = shardFoldApplyEvent(shard, ev(10n, touchOf(dead), touchOf(survivor)), key);
    shard = shardFoldApplyEvent(shard, ev(20n, deleteOf(dead)), key);
    shard = shardFoldApplyEvent(shard, ev(25n, deleteOf(survivor)), key);
    shard = shardFoldApplyEvent(shard, gc(30n, 20n), key);

    // deletedRevision <= floor is the drop rule (the boundary is inclusive): the row deleted AT
    // the floor is gone, the row deleted just above it survives with its window intact.
    expect(shard.rows).toHaveLength(1);
    const kept = shard.rows[0] as StoredRelationshipWire;
    expect(canonRel(kept.relationship)).toBe(canonRel(survivor));
    expect(kept.deletedRevision).toBe(25n);
    expect(shard.gcFloor).toBe(20n);
    expect(shard.appliedRevision).toBe(30n);
  });

  it("normalises the wire ellipsis the same way the whole fold does, so the row closes in both", () => {
    const key = graphShardKeyForResource("document", "a");
    // Wire form of the ellipsis ("") on the touch, normalised form ("...") on the later delete of
    // the same identity: both sides must resolve to the same row identity, or the shard would keep
    // a phantom live row that the whole fold correctly closes.
    const touched = rel("document", "a", "viewer", "user", "alice", "");
    const deleted = rel("document", "a", "viewer", "user", "alice", ELLIPSIS);

    const events = [ev(10n, touchOf(touched)), ev(20n, deleteOf(deleted))];

    let whole: DatastoreGrainState = datastoreGrainStateEmpty(10n);
    for (const event of events) whole = logFoldApplyEvent(whole, event);

    let shard = GRAPH_SHARD_STATE_EMPTY;
    for (const event of events) shard = shardFoldApplyEvent(shard, event, key);

    expect(sorted(shard.rows.map(canonRow))).toEqual(sorted(whole.relationships.map(canonRow)));

    // No phantom live row in either fold: the sole row is closed at revision 20.
    expect(whole.relationships).toHaveLength(1);
    expect((whole.relationships[0] as StoredRelationshipWire).deletedRevision).toBe(20n);
    expect(shard.rows).toHaveLength(1);
    expect((shard.rows[0] as StoredRelationshipWire).deletedRevision).toBe(20n);
  });

  it("is readable exactly at or above the gc floor", () => {
    const key = graphShardKeyForResource("document", "a");
    const relationship = rel("document", "a", "viewer", "user", "alice");

    let shard = GRAPH_SHARD_STATE_EMPTY;
    shard = shardFoldApplyEvent(shard, ev(10n, touchOf(relationship)), key);
    shard = shardFoldApplyEvent(shard, gc(20n, 15n), key);

    expect(shardFoldIsReadableAt(shard, 15n)).toBe(true);
    expect(shardFoldIsReadableAt(shard, 14n)).toBe(false);
  });

  it("a stale or equal gc floor still advances the watermark but leaves rows and floor alone", () => {
    const key = graphShardKeyForResource("document", "a");
    const relationship = rel("document", "a", "viewer", "user", "alice");

    const events = [
      ev(10n, touchOf(relationship)),
      gc(20n, 50n),
      gc(30n, 50n), // equal to the current floor: stale, but the watermark must still move.
    ];

    let whole: DatastoreGrainState = datastoreGrainStateEmpty(10n);
    for (const event of events) whole = logFoldApplyEvent(whole, event);

    let shard = GRAPH_SHARD_STATE_EMPTY;
    let beforeStale = GRAPH_SHARD_STATE_EMPTY;
    for (const event of events) {
      if (event.revision === 30n) beforeStale = shard;
      shard = shardFoldApplyEvent(shard, event, key);
    }

    expect(shard.appliedRevision).toBe(30n);
    expect(shard.gcFloor).toBe(50n);
    expect(whole.headRevision).toBe(30n);
    expect(whole.gcFloor).toBe(50n);

    expect(sorted(shard.rows.map(canonRow))).toEqual(sorted(beforeStale.rows.map(canonRow)));
  });

  it("drops a row whose expiration is exactly equal to the floor, in both folds", () => {
    // The C# picks tick-aligned nanos so the DateTimeOffset round trip through NanosSinceEpoch is
    // exact, and asserts that round trip. The port stores expiration as nanos already, so that
    // conversion - and its sanity assertion - is the identity; what survives, and is what the case
    // was really for, is the INCLUSIVE `<=` boundary: a row expiring EXACTLY on the floor is
    // dropped, not merely one strictly below it.
    const baseRevision = FIXED_BASE;
    const floor = addTicks(baseRevision, 500);
    const expiring = rel("document", "a", "viewer", "user", "alice", ELLIPSIS, floor);
    const survivor = rel(
      "document",
      "a",
      "viewer",
      "user",
      "bob",
      ELLIPSIS,
      addHours(FIXED_BASE, 1),
    );

    const key = graphShardKeyForResource("document", "a");
    const events = [
      ev(baseRevision + 10n, touchOf(expiring), touchOf(survivor)),
      gc(baseRevision + 1000n, floor),
    ];

    let whole: DatastoreGrainState = datastoreGrainStateEmpty(baseRevision);
    for (const event of events) whole = logFoldApplyEvent(whole, event);

    let shard = GRAPH_SHARD_STATE_EMPTY;
    for (const event of events) shard = shardFoldApplyEvent(shard, event, key);

    expect(sorted(shard.rows.map(canonRow))).toEqual(sorted(whole.relationships.map(canonRow)));

    expect(shard.rows).toHaveLength(1);
    expect(canonRel((shard.rows[0] as StoredRelationshipWire).relationship)).toBe(
      canonRel(survivor),
    );
  });

  it("sweeps a live row expired at or before the floor", () => {
    const baseRevision = FIXED_BASE;
    const key = graphShardKeyForResource("document", "a");
    const expired = rel(
      "document",
      "a",
      "viewer",
      "user",
      "alice",
      ELLIPSIS,
      addTicks(FIXED_BASE, -1),
    );
    const future = rel("document", "a", "viewer", "user", "bob", ELLIPSIS, addHours(FIXED_BASE, 1));

    let shard = GRAPH_SHARD_STATE_EMPTY;
    shard = shardFoldApplyEvent(
      shard,
      ev(baseRevision + 10n, touchOf(expired), touchOf(future)),
      key,
    );
    shard = shardFoldApplyEvent(shard, gc(baseRevision + 30n, baseRevision + 20n), key);

    // Both rows are still live (no deleted revision), but the one whose expiration falls at/before
    // the floor is swept; the future-dated one is kept.
    expect(shard.rows).toHaveLength(1);
    const kept = shard.rows[0] as StoredRelationshipWire;
    expect(canonRel(kept.relationship)).toBe(canonRel(future));
    expect(kept.deletedRevision).toBeUndefined();
  });
});
