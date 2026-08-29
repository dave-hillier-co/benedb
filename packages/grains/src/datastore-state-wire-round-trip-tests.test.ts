import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import type {
  CaveatNameFilterWire,
  FullRelationshipsFilterWire,
  SchemaVersionWire,
} from "./datastore-dtos";
import { datastoreGrainStateEmpty } from "./datastore-grain-state";
import type { DatastoreGrainState } from "./datastore-grain-state";
import type { RelationshipWire } from "./relationships-dtos";

// Port of `tests/Spiceport.Grains.Tests/DatastoreStateWireRoundTripTests.cs`.
//
// The C# proves the grain's persisted state survives a serializer round trip losslessly:
// revisions, created/deleted MVCC stamps, multiple schema versions, a fully featured counter
// filter, and boxed caveat-context values. It is a pure serializer test - it builds a minimal
// ServiceCollection, NOT a TestCluster - so the port is likewise a codec test that activates no
// grain.
//
// Three deliberate differences from the C#, each forced by a port decision made at the value type:
//
//  - `serializer.SerializeToArray` / `Deserialize` become Thresh's `serializeValue` /
//    `deserializeValue`. This is the DURABLE path (`redis-grain-storage` and `postgres-grain-storage`
//    both persist grain state through exactly these two functions), which is what the C# test's
//    subject - the grain's persisted state - actually travels over.
//  - The caveat context is a `ReadonlyMap<string, unknown>` of plain JSON values, not a
//    `Dictionary<string, object?>` of boxed `JsonElement`s. Thresh's codec encodes `Map` natively,
//    so the C#'s `JsonElementSurrogate` registration has no counterpart (see
//    `json-element-surrogate.ts`); the assertions on raw JSON text become assertions on the map's
//    values and their types.
//  - Every C# `long` revision is a `bigint`, per `packages/datastore/src/datastore-state.ts`.
//
// What does NOT change is the C#'s workaround for its own broken record equality: `byte[]` and the
// embedded collections compare by REFERENCE in C#, so the test compares them element-wise with
// `SequenceEqual`. `Uint8Array` has the same problem, so the element-wise comparison is kept
// rather than collapsed into one `toEqual` - and `expectBytesEqual` below states why at the site.
describe("the datastore grain state on the wire", () => {
  const rev1 = 1000n;
  const rev2 = 2000n;

  function caveatContext(): ReadonlyMap<string, unknown> {
    // `{ "level": 7, "name": "alice", "active": true }`, exactly as caveat context is parsed in
    // production - a Map, so key ORDER survives (a plain object reorders integer-like keys).
    return new Map<string, unknown>([
      ["level", 7],
      ["name", "alice"],
      ["active", true],
    ]);
  }

  function committedState(): DatastoreGrainState {
    const relA: RelationshipWire = {
      resourceType: "doc",
      resourceId: "a",
      resourceRelation: "viewer",
      subjectType: "user",
      subjectId: "alice",
      subjectRelation: "...",
    };
    const relB: RelationshipWire = {
      resourceType: "doc",
      resourceId: "b",
      resourceRelation: "viewer",
      subjectType: "user",
      subjectId: "bob",
      subjectRelation: "...",
      caveatName: "is_active",
      caveatContext: caveatContext(),
      // `new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero)` as NANOS since the epoch, the
      // representation S1 settled on for `Relationship.optionalExpiration`. Not a `Date`: the
      // tuple-string format emits 100ns ticks, which a millisecond `Date` cannot round-trip.
      expiration: 1893456000000000000n,
    };

    const counterFilter: FullRelationshipsFilterWire = {
      optionalResourceType: "doc",
      optionalResourceIds: ["a", "b"],
      optionalResourceRelation: "viewer",
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: "user",
          optionalSubjectIds: ["alice"],
          relationFilter: {
            includeEllipsisRelation: true,
            onlyNonEllipsisRelations: false,
          },
        },
        {
          optionalSubjectType: "group",
          relationFilter: {
            nonEllipsisRelation: "member",
            includeEllipsisRelation: false,
            onlyNonEllipsisRelations: false,
          },
        },
      ],
      optionalCaveatNameFilter: { option: 1, caveatName: "is_active" },
      // An `int` mirror of the core enum, kept as a NUMBER here - `WireConvert` owns the mapping,
      // and turning it into a union at this layer would strand that mapping's tolerant defaults.
      optionalExpirationOption: 1,
    };

    const encoder = new TextEncoder();

    return {
      ...datastoreGrainStateEmpty(rev2),
      relationships: [
        // A: created at rev1, deleted at rev2.
        { relationship: relA, createdRevision: rev1, deletedRevision: rev2 },
        // B original: created at rev1, closed by the touch at rev2.
        { relationship: relB, createdRevision: rev1, deletedRevision: rev2 },
        // B re-created by the touch at rev2, still live.
        { relationship: relB, createdRevision: rev2 },
      ],
      schemas: [
        { revision: rev1, bytes: encoder.encode("definition doc {}"), hash: "hash1" },
        {
          revision: rev2,
          bytes: encoder.encode("definition doc { relation viewer: user }"),
          hash: "hash2",
        },
      ],
      counters: [{ revision: rev1, name: "c1", filter: counterFilter }],
    };
  }

  it("round trips the committed state at the live-set level", () => {
    const state = committedState();

    const restored = deserializeValue<DatastoreGrainState>(serializeValue(state));

    expect(restored.headRevision).toBe(state.headRevision);

    // Relationships: element-wise, because the caveat-context map and the payload identity are
    // compared separately below (the C# does the same, for the same reason: its record equality
    // compares the context dictionary by reference).
    expect(restored.relationships).toHaveLength(state.relationships.length);
    state.relationships.forEach((expected, index) => {
      const actual = restored.relationships[index];
      expect(actual).toBeDefined();
      expect(actual?.createdRevision).toBe(expected.createdRevision);
      expect(actual?.deletedRevision).toBe(expected.deletedRevision);
      expectRelEqual(expected.relationship, actual?.relationship);
    });

    // Schemas: `Uint8Array` compares by reference, so compare the bytes content-wise.
    expect(restored.schemas).toHaveLength(state.schemas.length);
    state.schemas.forEach((expected, index) => {
      const actual = restored.schemas[index];
      expect(actual?.revision).toBe(expected.revision);
      expect(actual?.hash).toBe(expected.hash);
      expectBytesEqual(expected, actual);
    });

    // Counters: the embedded lists are fresh instances after a round trip, so compare structurally.
    expect(restored.counters).toHaveLength(state.counters.length);
    state.counters.forEach((expected, index) => {
      const actual = restored.counters[index];
      expect(actual?.revision).toBe(expected.revision);
      expect(actual?.name).toBe(expected.name);
      expectFilterEqual(expected.filter, actual?.filter);
    });
  });

  it("re-serializes to the same bytes: the encoding is stable", () => {
    const state = committedState();
    const encoded = serializeValue(state);

    const restored = deserializeValue<DatastoreGrainState>(encoded);

    expect(serializeValue(restored)).toBe(encoded);
  });

  it("carries the caveat context across with its values and types intact", () => {
    const state = committedState();

    const restored = deserializeValue<DatastoreGrainState>(serializeValue(state));

    const liveB = restored.relationships.find(
      (row) => row.relationship.resourceId === "b" && row.deletedRevision === undefined,
    );
    expect(liveB).toBeDefined();
    expect(liveB?.relationship.caveatName).toBe("is_active");

    const context = liveB?.relationship.caveatContext;
    expect(context).toBeInstanceOf(Map);
    expect(context?.get("name")).toBe("alice");
    expect(context?.get("level")).toBe(7);
    expect(context?.get("active")).toBe(true);
    // Key order is observable in tuple-string formatting, so it is asserted, not assumed.
    expect([...(context?.keys() ?? [])]).toEqual(["level", "name", "active"]);
  });

  it("keeps the MVCC expiration as nanosecond bigints, not seconds or millis", () => {
    const state = committedState();

    const restored = deserializeValue<DatastoreGrainState>(serializeValue(state));

    const rowB = restored.relationships.find((row) => row.relationship.resourceId === "b");
    expect(rowB?.relationship.expiration).toBe(1893456000000000000n);
    expect(typeof rowB?.relationship.expiration).toBe("bigint");
  });

  it("keeps an absent caveat and an absent expiration absent, never defaulted", () => {
    const state = committedState();

    const restored = deserializeValue<DatastoreGrainState>(serializeValue(state));

    const rowA = restored.relationships.find((row) => row.relationship.resourceId === "a");
    expect(rowA?.relationship.caveatName).toBeUndefined();
    expect(rowA?.relationship.caveatContext).toBeUndefined();
    expect(rowA?.relationship.expiration).toBeUndefined();
    // The live B row has no `deletedRevision`; absent must not become 0n, which is a legal
    // revision and would make the row invisible at every read.
    const liveB = restored.relationships[2];
    expect(liveB?.deletedRevision).toBeUndefined();
  });
});

/**
 * `Uint8Array` compares by REFERENCE, exactly as C# `byte[]` does under record equality, so the
 * comparison is spelled out. The C# works around its own broken equality with `SequenceEqual`;
 * this is the same workaround, for the same reason.
 */
function expectBytesEqual(
  expected: SchemaVersionWire,
  actual: SchemaVersionWire | undefined,
): void {
  expect(actual?.bytes).toBeInstanceOf(Uint8Array);
  expect([...(actual?.bytes ?? [])]).toEqual([...expected.bytes]);
}

function expectRelEqual(expected: RelationshipWire, actual: RelationshipWire | undefined): void {
  expect(actual).toBeDefined();
  expect(actual?.resourceType).toBe(expected.resourceType);
  expect(actual?.resourceId).toBe(expected.resourceId);
  expect(actual?.resourceRelation).toBe(expected.resourceRelation);
  expect(actual?.subjectType).toBe(expected.subjectType);
  expect(actual?.subjectId).toBe(expected.subjectId);
  expect(actual?.subjectRelation).toBe(expected.subjectRelation);
  expect(actual?.caveatName).toBe(expected.caveatName);
  expect(actual?.expiration).toBe(expected.expiration);

  if (expected.caveatContext === undefined) {
    expect(actual?.caveatContext).toBeUndefined();
    return;
  }
  expect(actual?.caveatContext).toBeInstanceOf(Map);
  expect([...(actual?.caveatContext?.keys() ?? [])].sort()).toEqual(
    [...expected.caveatContext.keys()].sort(),
  );
  for (const key of expected.caveatContext.keys()) {
    expect(actual?.caveatContext?.get(key)).toEqual(expected.caveatContext.get(key));
  }
}

function expectFilterEqual(
  expected: FullRelationshipsFilterWire | undefined,
  actual: FullRelationshipsFilterWire | undefined,
): void {
  if (expected === undefined) {
    expect(actual).toBeUndefined();
    return;
  }
  expect(actual).toBeDefined();
  expect(actual?.optionalResourceType).toBe(expected.optionalResourceType);
  expect(actual?.optionalResourceIds).toEqual(expected.optionalResourceIds);
  expect(actual?.optionalResourceIdPrefix).toBe(expected.optionalResourceIdPrefix);
  expect(actual?.optionalResourceRelation).toBe(expected.optionalResourceRelation);
  expectCaveatNameFilterEqual(expected.optionalCaveatNameFilter, actual?.optionalCaveatNameFilter);
  expect(actual?.optionalExpirationOption).toBe(expected.optionalExpirationOption);

  if (expected.optionalSubjectsSelectors === undefined) {
    expect(actual?.optionalSubjectsSelectors).toBeUndefined();
    return;
  }
  expect(actual?.optionalSubjectsSelectors).toHaveLength(expected.optionalSubjectsSelectors.length);
  expected.optionalSubjectsSelectors.forEach((selector, index) => {
    const restored = actual?.optionalSubjectsSelectors?.[index];
    expect(restored?.optionalSubjectType).toBe(selector.optionalSubjectType);
    expect(restored?.optionalSubjectIds).toEqual(selector.optionalSubjectIds);
    expect(restored?.relationFilter).toEqual(selector.relationFilter);
  });
}

function expectCaveatNameFilterEqual(
  expected: CaveatNameFilterWire | undefined,
  actual: CaveatNameFilterWire | undefined,
): void {
  if (expected === undefined) {
    expect(actual).toBeUndefined();
    return;
  }
  expect(actual?.option).toBe(expected.option);
  expect(actual?.caveatName).toBe(expected.caveatName);
}
