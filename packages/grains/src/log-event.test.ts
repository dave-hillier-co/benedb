import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import type { FullRelationshipsFilterWire } from "./datastore-dtos";
import type { CounterDeltaWire, IDatastoreLog, LogEvent, LogSegment } from "./log-event";
import type { RelationshipUpdateWire, RelationshipWire } from "./relationships-dtos";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/LogEvent.cs`.
//
// The C#'s covering test is `DatastoreGcFoldTests`, which drives the GC fold - a LATER batch of this
// stage; it is ported alongside `LogFold` and nothing here pre-empts it. What this file pins is the
// event's own contract, and above all the GC DISCRIMINANT: `long? GcFloor` non-null marks a GC
// event for all three folds, so `undefined` (never `0n`, never `null`) has to mean "not a GC
// event". 0 is a LEGAL floor - it is the floor of a store that has collected nothing - so a port
// that defaults the absent case to 0n turns every ordinary commit into a GC event that replays no
// changes at all.
describe("the GC discriminant on a LogEvent", () => {
  const rel: RelationshipWire = {
    resourceType: "doc",
    resourceId: "1",
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: "...",
  };
  const touch: RelationshipUpdateWire = { operation: "touch", relationship: rel };

  const changeEvent: LogEvent = {
    revision: 100n,
    relationshipChanges: [touch],
    counterChanges: [],
  };

  it("leaves gcFloor ABSENT on an ordinary change-bearing event", () => {
    const back = deserializeValue<LogEvent>(serializeValue(changeEvent));

    expect(back.gcFloor).toBeUndefined();
    expect(back.revision).toBe(100n);
    expect(back.relationshipChanges).toHaveLength(1);
    expect(back.schemaChange).toBeUndefined();
  });

  it("keeps a zero floor as a PRESENT floor, distinct from an absent one", () => {
    // The whole hazard in one assertion: a GC event minted at floor 0 and an ordinary commit must
    // not read the same after a round trip.
    const gcAtZero: LogEvent = {
      revision: 101n,
      relationshipChanges: [],
      counterChanges: [],
      gcFloor: 0n,
    };

    const back = deserializeValue<LogEvent>(serializeValue(gcAtZero));

    expect(back.gcFloor).toBe(0n);
    expect(back.gcFloor).not.toBeUndefined();
    expect(deserializeValue<LogEvent>(serializeValue(changeEvent)).gcFloor).toBeUndefined();
  });

  it("carries a non-zero floor as a bigint", () => {
    const back = deserializeValue<LogEvent>(
      serializeValue({
        revision: 200n,
        relationshipChanges: [],
        counterChanges: [],
        gcFloor: 150n,
      } satisfies LogEvent),
    );

    expect(back.gcFloor).toBe(150n);
    expect(typeof back.gcFloor).toBe("bigint");
  });

  it("carries empty change lists on a GC event, never a schema change", () => {
    // The XML remark: relationship/schema/counter changes are always empty or absent on a GC
    // event, because folding one applies `collectBelow(gcFloor)` INSTEAD of replaying them.
    const gcEvent: LogEvent = {
      revision: 300n,
      relationshipChanges: [],
      counterChanges: [],
      gcFloor: 250n,
    };

    expect(gcEvent.relationshipChanges).toEqual([]);
    expect(gcEvent.counterChanges).toEqual([]);
    expect(gcEvent.schemaChange).toBeUndefined();
  });
});

describe("a self-contained, foldable LogEvent", () => {
  it("carries every payload needed to reproduce the committed state inline", () => {
    // The remark's claim, pinned: a consumer can fold the ordered event sequence from empty with
    // no side state, which is only true while the schema bytes and the counter filters travel
    // inside the event rather than being looked up.
    const filter: FullRelationshipsFilterWire = {
      optionalResourceType: "doc",
      optionalExpirationOption: 0,
    };
    const event: LogEvent = {
      revision: 400n,
      relationshipChanges: [],
      schemaChange: {
        revision: 400n,
        bytes: new TextEncoder().encode("definition doc {}"),
        hash: "hash1",
      },
      counterChanges: [
        { name: "c1", filter },
        // A null filter is a TOMBSTONE: the counter was unregistered at this revision. It must
        // stay distinguishable from "a counter with no constraints".
        { name: "c2" },
      ],
      gcFloor: undefined,
    };

    const back = deserializeValue<LogEvent>(serializeValue(event));

    expect(back.schemaChange?.revision).toBe(400n);
    expect(back.schemaChange?.hash).toBe("hash1");
    expect(back.counterChanges[0]?.filter?.optionalResourceType).toBe("doc");
    expect(back.counterChanges[1]?.filter).toBeUndefined();
  });

  it("distinguishes a counter tombstone from a filterless registration", () => {
    const tombstone: CounterDeltaWire = { name: "c" };
    const registration: CounterDeltaWire = {
      name: "c",
      filter: { optionalExpirationOption: 0 },
    };

    expect(deserializeValue<CounterDeltaWire>(serializeValue(tombstone)).filter).toBeUndefined();
    expect(
      deserializeValue<CounterDeltaWire>(serializeValue(registration)).filter,
    ).not.toBeUndefined();
  });
});

describe("LogSegment", () => {
  it("carries a bounded page of events plus the head revision observed at read time", () => {
    const segment: LogSegment = {
      events: [{ revision: 1n, relationshipChanges: [], counterChanges: [] }],
      headRevision: 42n,
    };

    const back = deserializeValue<LogSegment>(serializeValue(segment));

    expect(back.headRevision).toBe(42n);
    expect(typeof back.headRevision).toBe("bigint");
    expect(back.events[0]?.revision).toBe(1n);
  });

  it("can be empty while the head has moved: caught up, nothing new above the cursor", () => {
    const segment: LogSegment = { events: [], headRevision: 42n };

    expect(deserializeValue<LogSegment>(serializeValue(segment)).events).toEqual([]);
  });
});

// `IDatastoreLog` is a grain-interface FRAGMENT that `IDatastoreGrain` inherits. Its `ReadFrom`
// carries `[AlwaysInterleave]`, and because Thresh's per-method options live on the CONCRETE
// `GrainInterface` value and are NOT inherited, that flag has to be repeated in `IDatastoreGrain`'s
// own options map (a later batch). A dropped `alwaysInterleave` deadlocks Watch behind a commit,
// and no unit test would show it - which is why the requirement is written down at both ends.
//
// The C#'s remark that `[ReadOnly]` is the WRONG attribute here is verified Orleans research and
// carries across unchanged: Thresh's `InvokeMethodOptions` has both `readOnly` and
// `alwaysInterleave`, and `readOnly` interleaves only when BOTH the blocking and incoming requests
// are read-only, which `Commit` is not.
describe("the IDatastoreLog fragment", () => {
  it("declares ReadFrom as an ascending, bounded, head-reporting read", () => {
    // A structural stand-in: any object satisfying the interface must accept `(afterRevision,
    // maxCount)` with a bigint cursor and a number count, and answer with a `LogSegment`.
    const log: IDatastoreLog = {
      readFrom: async (afterRevision: bigint, maxCount: number): Promise<LogSegment> => ({
        events: [
          { revision: afterRevision + 1n, relationshipChanges: [], counterChanges: [] },
        ].slice(0, maxCount),
        headRevision: afterRevision + 1n,
      }),
    };

    return expect(log.readFrom(7n, 10)).resolves.toEqual({
      events: [{ revision: 8n, relationshipChanges: [], counterChanges: [] }],
      headRevision: 8n,
    });
  });
});
