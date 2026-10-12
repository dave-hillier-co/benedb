import { ELLIPSIS } from "@benedb/core/core-constants";
import { describe, expect, it } from "vitest";

import type {
  CounterVersionWire,
  FullRelationshipsFilterWire,
  SchemaVersionWire,
} from "./datastore-dtos";
import { datastoreGrainStateEmpty } from "./datastore-grain-state";
import type { DatastoreMetaState } from "./datastore-meta-state";
import { datastoreMetaStateEmpty } from "./datastore-meta-state";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import {
  graphShardKeyForResource,
  graphShardKeyForSubject,
  graphShardKeyMatches,
} from "./graph-shard-key";
import { GRAPH_SHARD_STATE_EMPTY } from "./graph-shard-state";
import type { CounterDeltaWire, LogEvent } from "./log-event";
import { eventFromProposal, logFoldApplyEvent, type ProposedWrite } from "./log-fold";
import {
  metaFoldApplyEntry,
  metaFoldApplyEvent,
  metaFoldForwardKeyOf,
  metaFoldReverseKeyOf,
  metaFoldTouchedKeys,
} from "./meta-fold";
import type { RelationshipUpdateWire, RelationshipWire } from "./relationships-dtos";
import { shardFoldApplyEvent } from "./shard-fold";
import { computeStoredSchemaHash } from "./stored-schema-hash";

/**
 * NO COVERING C# TEST. `MetaFold` is exercised in Spiceport only by `ThinSequencerTests` and
 * `ThinLayoutDurabilityTests`, both mesh suites belonging to a later slice, and
 * `ShardFoldLemmaTests` does NOT reach it - so the small-state half of the split
 * `MetaFold + ShardFold-per-key == LogFold` was never pinned on its own. This suite is that
 * missing half: the same event sequence is folded through `metaFoldApplyEvent` and through the
 * whole-state `logFoldApplyEvent`, and the head, schema history, counter history and GC floor must
 * agree; `metaFoldTouchedKeys` must name exactly the keys the shard fold sees a match on.
 *
 * The behaviours the C# encodes and this pins:
 *   * GC events compact schemas and counters exactly as `collectBelow` does - the latest version
 *     at-or-below the floor, and for counters PER NAME and only when NOT a tombstone.
 *   * Counter versions are appended DIRECTLY from the event's net deltas, never replayed through
 *     the guarded register/unregister ops, for the same reason `LogFold` does it: a same-commit
 *     register+unregister nets to a delta whose guard is false in the fold base.
 *   * Every committed event joins the PENDING tail, and a projection checkpoint drops exactly the
 *     events at or below it; the types an event names are recorded, add-only and sorted.
 *   * `touchedKeys` returns a `Set`, so its iteration order is insertion order where .NET's
 *     `HashSet` order is unspecified. That is benign here (the result groups a projection's events
 *     by key), and no sort is added to paper over it - the tests compare as sets.
 */
describe("meta fold", () => {
  const noCounterChanges: readonly CounterDeltaWire[] = [];

  const rel = (resourceId: string, subjectId: string, relation = "viewer"): RelationshipWire => ({
    resourceType: "doc",
    resourceId,
    resourceRelation: relation,
    subjectType: "user",
    subjectId,
    subjectRelation: ELLIPSIS,
  });

  const touch = (r: RelationshipWire): RelationshipUpdateWire => ({
    operation: "touch",
    relationship: r,
  });
  const remove = (r: RelationshipWire): RelationshipUpdateWire => ({
    operation: "delete",
    relationship: r,
  });

  const filterC1: FullRelationshipsFilterWire = {
    optionalResourceType: "doc",
    optionalResourceRelation: "viewer",
    optionalExpirationOption: 0,
  };
  const filterC2: FullRelationshipsFilterWire = {
    optionalResourceType: "doc",
    optionalResourceIds: ["a", "b"],
    optionalExpirationOption: 0,
  };

  const schemaOne = new TextEncoder().encode("definition doc {}");
  const schemaTwo = new TextEncoder().encode("definition doc { relation viewer: user }");

  const proposal = (
    relationshipChanges: readonly RelationshipUpdateWire[],
    schemaBytes?: Uint8Array | undefined,
    counterChanges: readonly CounterDeltaWire[] = noCounterChanges,
  ): ProposedWrite => ({ relationshipChanges, schemaBytes, counterChanges });

  const gc = (revision: bigint, floor: bigint): LogEvent => ({
    revision,
    relationshipChanges: [],
    schemaChange: undefined,
    counterChanges: noCounterChanges,
    gcFloor: floor,
  });

  const relA = rel("a", "alice");
  const relB = rel("b", "bob");

  // A sequence that exercises every branch: schema writes on both sides of a floor, a counter
  // registered then tombstoned then a second one registered, relationship churn, and two GC events
  // with strictly increasing floors.
  const log: readonly LogEvent[] = [
    eventFromProposal(proposal([touch(relA)], schemaOne), 10n),
    eventFromProposal(proposal([], undefined, [{ name: "c1", filter: filterC1 }]), 20n),
    eventFromProposal(proposal([touch(relB), remove(relA)]), 30n),
    eventFromProposal(proposal([], schemaTwo), 40n),
    eventFromProposal(proposal([], undefined, [{ name: "c1", filter: undefined }]), 50n),
    gc(60n, 35n),
    eventFromProposal(proposal([], undefined, [{ name: "c2", filter: filterC2 }]), 70n),
    gc(80n, 65n),
  ];

  const canonSchema = (s: SchemaVersionWire): string =>
    `${s.revision}|${s.hash}|${new TextDecoder().decode(s.bytes)}`;

  const canonFilter = (f: FullRelationshipsFilterWire | undefined): string =>
    f === undefined
      ? "tombstone"
      : [
          f.optionalResourceType ?? "",
          (f.optionalResourceIds ?? []).join("+"),
          f.optionalResourceIdPrefix ?? "",
          f.optionalResourceRelation ?? "",
          String(f.optionalSubjectsSelectors?.length ?? -1),
          f.optionalCaveatNameFilter?.caveatName ?? "",
          String(f.optionalExpirationOption),
        ].join("|");

  const canonCounter = (c: CounterVersionWire): string =>
    `${c.revision}|${c.name}|${canonFilter(c.filter)}`;

  const foldSmall = (events: readonly LogEvent[]): DatastoreMetaState => {
    let state = datastoreMetaStateEmpty(0n);
    for (const event of events) state = metaFoldApplyEvent(state, event);
    return state;
  };

  const foldWhole = (events: readonly LogEvent[]) => {
    let state = datastoreGrainStateEmpty(0n);
    for (const event of events) state = logFoldApplyEvent(state, event);
    return state;
  };

  describe("agreement with the whole fold", () => {
    it("agrees on the head, the gc floor, and the schema and counter histories", () => {
      const small = foldSmall(log);
      const whole = foldWhole(log);

      expect(small.headRevision).toBe(whole.headRevision);
      expect(small.gcFloor).toBe(whole.gcFloor);
      expect(small.schemas.map(canonSchema)).toEqual(whole.schemas.map(canonSchema));
      expect(small.counters.map(canonCounter)).toEqual(whole.counters.map(canonCounter));
    });

    it("agrees at every prefix of the log, not only at the end", () => {
      for (let take = 1; take <= log.length; take++) {
        const events = log.slice(0, take);
        const small = foldSmall(events);
        const whole = foldWhole(events);

        expect(small.headRevision).toBe(whole.headRevision);
        expect(small.gcFloor).toBe(whole.gcFloor);
        expect(small.schemas.map(canonSchema)).toEqual(whole.schemas.map(canonSchema));
        expect(small.counters.map(canonCounter)).toEqual(whole.counters.map(canonCounter));
      }
    });

    it("compacts the schema history at the floor exactly as the whole fold does", () => {
      // Floor 65 keeps only the version effective at the floor (the one written at 40).
      const small = foldSmall(log);

      expect(small.schemas.map((s) => s.revision)).toEqual([40n]);
      expect(small.schemas[0]?.hash).toBe(computeStoredSchemaHash(schemaTwo));
    });

    it("drops a tombstoned counter below the floor but keeps a live one above it", () => {
      const small = foldSmall(log);

      // c1 registered at 20 and tombstoned at 50, both at/below the floor of 65: the latest
      // at-or-below is the tombstone, so BOTH versions go. c2 is above the floor and survives.
      expect(small.counters.map((c) => `${c.name}@${c.revision}`)).toEqual(["c2@70"]);
    });

    it("keeps a counter register+unregister in the SAME event, appending the deltas directly", () => {
      // Replaying these through the guarded write/delete ops would throw in the fold base, which
      // is why both folds append the net deltas straight onto the history.
      const sameCommit = eventFromProposal(
        proposal([], undefined, [
          { name: "c3", filter: filterC1 },
          { name: "c3", filter: undefined },
        ]),
        90n,
      );

      const small = metaFoldApplyEvent(datastoreMetaStateEmpty(0n), sameCommit);
      const whole = logFoldApplyEvent(datastoreGrainStateEmpty(0n), sameCommit);

      expect(small.counters.map(canonCounter)).toEqual(whole.counters.map(canonCounter));
      expect(small.counters).toHaveLength(2);
    });
  });

  describe("touched keys", () => {
    const allKeys = () => {
      const keys = new Map<string, ReturnType<typeof graphShardKeyForResource>>();
      for (const event of log)
        for (const change of event.relationshipChanges) {
          const forward = graphShardKeyForResource(
            change.relationship.resourceType,
            change.relationship.resourceId,
          );
          const reverse = graphShardKeyForSubject(
            change.relationship.subjectType,
            change.relationship.subjectId,
          );
          keys.set(graphShardGrainKeyBuild(forward), forward);
          keys.set(graphShardGrainKeyBuild(reverse), reverse);
        }
      return keys;
    };

    it("names exactly the keys the shard fold sees a match on", () => {
      const keys = allKeys();

      for (const event of log) {
        const expected = new Set<string>();
        for (const [keyString, key] of keys) {
          if (event.relationshipChanges.some((c) => graphShardKeyMatches(key, c.relationship)))
            expected.add(keyString);
        }

        expect(new Set(metaFoldTouchedKeys(event))).toEqual(expected);
      }
    });

    it("leaves an untouched key's rows alone (only its watermark moves)", () => {
      const event = log[2] as LogEvent; // touch b / delete a
      const untouched = graphShardKeyForResource("doc", "never-referenced");

      expect([...metaFoldTouchedKeys(event)]).not.toContain(graphShardGrainKeyBuild(untouched));

      const folded = shardFoldApplyEvent(GRAPH_SHARD_STATE_EMPTY, event, untouched);
      expect(folded.rows).toEqual([]);
      expect(folded.appliedRevision).toBe(event.revision);
    });

    it("touches no keys for a gc event", () => {
      expect([...metaFoldTouchedKeys(gc(100n, 90n))]).toEqual([]);
    });

    it("touches no keys for an event with no relationship changes", () => {
      expect([...metaFoldTouchedKeys(eventFromProposal(proposal([], schemaOne), 110n))]).toEqual(
        [],
      );
    });

    it("derives the forward and reverse key strings through the grain-key form", () => {
      expect(metaFoldForwardKeyOf(relA)).toBe(
        graphShardGrainKeyBuild(graphShardKeyForResource("doc", "a")),
      );
      expect(metaFoldReverseKeyOf(relA)).toBe(
        graphShardGrainKeyBuild(graphShardKeyForSubject("user", "alice")),
      );
    });
  });

  describe("the types seen and the pending tail", () => {
    it("records every type an event names, per direction, sorted and add-only", () => {
      const small = foldSmall(log);

      expect(small.forwardTypes).toEqual(["doc"]);
      expect(small.reverseTypes).toEqual(["user"]);

      const group: RelationshipWire = {
        ...rel("a", "eng"),
        resourceType: "acl",
        subjectType: "group",
      };
      const more = metaFoldApplyEvent(small, eventFromProposal(proposal([touch(group)]), 200n));
      expect(more.forwardTypes).toEqual(["acl", "doc"]);
      expect(more.reverseTypes).toEqual(["group", "user"]);
    });

    it("keeps a type after its rows are deleted", () => {
      const small = foldSmall(log.slice(0, 3)); // touch a, ..., delete a

      expect(small.forwardTypes).toEqual(["doc"]);
    });

    it("puts every committed event, gc events included, on the pending tail in order", () => {
      const small = foldSmall(log);

      expect(small.pending.map((e) => e.revision)).toEqual(log.map((e) => e.revision));
    });

    it("drops exactly the pending events a projection checkpoint covers", () => {
      const small = foldSmall(log);
      const through = (log[2] as LogEvent).revision;

      const projected = metaFoldApplyEntry(small, { kind: "projected", through });

      expect(projected.projectedThrough).toBe(through);
      expect(projected.pending.map((e) => e.revision)).toEqual(log.slice(3).map((e) => e.revision));
      // Everything else is untouched.
      expect(projected.headRevision).toBe(small.headRevision);
      expect(projected.schemas).toBe(small.schemas);
    });

    it("ignores a projection checkpoint at or below the one already recorded", () => {
      const small = metaFoldApplyEntry(foldSmall(log), {
        kind: "projected",
        through: (log[2] as LogEvent).revision,
      });

      expect(metaFoldApplyEntry(small, { kind: "projected", through: 1n })).toBe(small);
    });

    it("starts an empty store at the seeded revision", () => {
      const seeded = metaFoldApplyEntry(datastoreMetaStateEmpty(0n), {
        kind: "seeded",
        revision: 42n,
      });

      expect(seeded).toEqual(datastoreMetaStateEmpty(42n));
      expect(seeded.projectedThrough).toBe(42n);
    });

    it("folds a committed entry exactly as the event", () => {
      const ev = log[0] as LogEvent;

      expect(
        metaFoldApplyEntry(datastoreMetaStateEmpty(0n), { kind: "committed", event: ev }),
      ).toEqual(metaFoldApplyEvent(datastoreMetaStateEmpty(0n), ev));
    });

    it("does not mutate the state it folded from", () => {
      const before = datastoreMetaStateEmpty(0n);

      metaFoldApplyEvent(before, log[0] as LogEvent);

      expect(before.pending).toEqual([]);
      expect(before.forwardTypes).toEqual([]);
      expect(before.headRevision).toBe(0n);
    });
  });

  describe("stale gc floors", () => {
    it("advances the head but leaves the floor and histories untouched", () => {
      const folded = foldSmall(log);

      const stale = metaFoldApplyEvent(folded, gc(90n, 65n)); // equal to the current floor

      expect(stale.headRevision).toBe(90n);
      expect(stale.gcFloor).toBe(65n);
      expect(stale.schemas).toEqual(folded.schemas);
      expect(stale.counters).toEqual(folded.counters);
    });
  });
});
