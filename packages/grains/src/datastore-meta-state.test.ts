import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import type { SchemaVersionWire } from "./datastore-dtos";
import {
  datastoreMetaStateEmpty,
  datastoreMetaStateSchemaHashAt,
  datastoreMetaStateSchemaVersionAt,
  type DatastoreJournalEntry,
  type DatastoreMetaState,
} from "./datastore-meta-state";
import type { LogEvent } from "./log-event";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/DatastoreMetaState.cs`,
// which has no covering C# test of its own: Spiceport reaches these types through the sequencer
// mesh suites. It pins the journaled state's shape and that it survives the journal's value codec,
// since the state is what a snapshot frame carries.
describe("datastoreMetaStateEmpty", () => {
  it("seeds an empty state at the given initial revision, projected through it", () => {
    const state = datastoreMetaStateEmpty(1234n);

    expect(state.headRevision).toBe(1234n);
    expect(state.schemas).toEqual([]);
    expect(state.counters).toEqual([]);
    expect(state.gcFloor).toBe(0n);
    expect(state.pending).toEqual([]);
    expect(state.projectedThrough).toBe(1234n);
    expect(state.forwardTypes).toEqual([]);
    expect(state.reverseTypes).toEqual([]);
  });
});

describe("datastoreMetaStateSchemaVersionAt", () => {
  const schema = (revision: bigint, hash: string): SchemaVersionWire => ({
    revision,
    bytes: new TextEncoder().encode(hash),
    hash,
  });

  const stateWith = (schemas: readonly SchemaVersionWire[]): DatastoreMetaState => ({
    ...datastoreMetaStateEmpty(100n),
    schemas,
  });

  it("returns nothing when no schema was persisted at or before the revision", () => {
    expect(datastoreMetaStateSchemaVersionAt(stateWith([]), 50n)).toBeUndefined();
    expect(datastoreMetaStateSchemaHashAt(stateWith([schema(10n, "h1")]), 9n)).toBeUndefined();
  });

  it("returns the last version written at or before the revision, inclusive", () => {
    const state = stateWith([schema(10n, "h1"), schema(20n, "h2"), schema(30n, "h3")]);

    expect(datastoreMetaStateSchemaVersionAt(state, 19n)?.hash).toBe("h1");
    expect(datastoreMetaStateSchemaVersionAt(state, 20n)?.hash).toBe("h2");
    expect(datastoreMetaStateSchemaHashAt(state, 999n)).toBe("h3");
  });

  it("BREAKS at the first schema above the revision, exactly as the grain-state scan does", () => {
    // The identical loop to `DatastoreGrainState.SchemaVersionAt`. The break relies on ascending
    // write order, which MetaFold's compaction preserves; keeping it means an out-of-order list
    // fails loudly rather than silently disagreeing with the whole-state fold.
    const outOfOrder = stateWith([schema(10n, "h1"), schema(50n, "h5"), schema(20n, "h2")]);

    expect(datastoreMetaStateSchemaVersionAt(outOfOrder, 30n)?.hash).toBe("h1");
  });
});

describe("the journal's value codec", () => {
  const event: LogEvent = {
    revision: 20n,
    relationshipChanges: [
      {
        operation: "touch",
        relationship: {
          resourceType: "doc",
          resourceId: "a",
          resourceRelation: "viewer",
          subjectType: "user",
          subjectId: "alice",
          subjectRelation: "...",
          caveatName: "is_active",
          caveatContext: new Map<string, unknown>([["level", 7]]),
          expiration: 99n,
        },
      },
    ],
    schemaChange: {
      revision: 20n,
      bytes: new TextEncoder().encode("definition doc {}"),
      hash: "h",
    },
    counterChanges: [],
    gcFloor: undefined,
  };

  it("round trips the journaled state, pending tail and all", () => {
    const state: DatastoreMetaState = {
      ...datastoreMetaStateEmpty(10n),
      headRevision: 20n,
      pending: [event],
      forwardTypes: ["doc"],
      reverseTypes: ["user"],
    };

    expect(deserializeValue<DatastoreMetaState>(serializeValue(state))).toEqual(state);
  });

  it("round trips every journal entry kind", () => {
    const entries: DatastoreJournalEntry[] = [
      { kind: "seeded", revision: 1n },
      { kind: "committed", event },
      { kind: "projected", through: 20n },
    ];

    for (const entry of entries)
      expect(deserializeValue<DatastoreJournalEntry>(serializeValue(entry))).toEqual(entry);
  });
});
