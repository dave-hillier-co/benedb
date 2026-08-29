import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import {
  datastoreHeadWireGcFloor,
  type DatastoreHeadWire,
  type FullRelationshipsFilterWire,
  type LogHeadEntry,
  type ProposedWrite,
  type SchemaVersionWire,
  type StoredRelationshipWire,
} from "./datastore-dtos";
import type { RelationshipWire } from "./relationships-dtos";

// `src/Spiceport.Server/Grains.Abstractions/DatastoreDtos.cs` is covered by
// `DatastoreStateWireRoundTripTests` for the stored rows, schema versions and counter filters.
// This file pins what that test does not reach: the two DIFFERENT integer widths in the same file,
// the `GcFloor = 0` default parameter, and the byte-array reference-equality trap.
describe("revisions versus storage versions", () => {
  it("keeps every revision a bigint and every storage version a number", () => {
    // The easiest silent bug in this file. `LogHeadEntry.LogVersion` and `SnapshotVersion` are
    // `int` STORAGE versions (the CustomStorage optimistic-concurrency counter and the current
    // meta-row version); `HeadRevision` is the `long` MVCC revision. They live side by side in one
    // record and mean entirely different things.
    const head: LogHeadEntry = {
      logVersion: 12,
      headRevision: 1730000000000000000n,
      snapshotVersion: 3,
    };

    const back = deserializeValue<LogHeadEntry>(serializeValue(head));

    expect(typeof back.logVersion).toBe("number");
    expect(typeof back.snapshotVersion).toBe("number");
    expect(typeof back.headRevision).toBe("bigint");
    expect(back.headRevision).toBe(1730000000000000000n);
  });

  it("carries a nanosecond revision past 2^53 without rounding", () => {
    // The whole reason revisions are bigints: 1.73e18 is a real timestamp revision, and `number`
    // would round it to a different value, so two distinct revisions would compare equal.
    const row: StoredRelationshipWire = {
      relationship: aRelationship(),
      createdRevision: 1730000000000000001n,
      deletedRevision: 1730000000000000002n,
    };

    const back = deserializeValue<StoredRelationshipWire>(serializeValue(row));

    expect(back.createdRevision).toBe(1730000000000000001n);
    expect(back.deletedRevision).toBe(1730000000000000002n);
    expect(back.createdRevision).not.toBe(back.deletedRevision);
  });

  it("keeps a live row's deleted revision ABSENT, never zero", () => {
    // 0 is a legal revision, and a row deleted at 0 would be invisible at every read.
    const live: StoredRelationshipWire = { relationship: aRelationship(), createdRevision: 1n };

    expect(
      deserializeValue<StoredRelationshipWire>(serializeValue(live)).deletedRevision,
    ).toBeUndefined();
  });
});

describe("DatastoreHeadWire", () => {
  it("resolves an absent GC floor to zero at the resolver, not in the type", () => {
    // `DatastoreHeadWire(..., long GcFloor = 0)` is a DEFAULT PARAMETER, so the member is optional
    // and a named resolver applies `?? 0n`. Baking 0n into the type would make an explicit 0n
    // indistinguishable from an unstated one at construction, which is exactly the distinction the
    // guide keeps.
    const noFloor: DatastoreHeadWire = { head: 100n };
    const explicitZero: DatastoreHeadWire = { head: 100n, gcFloor: 0n };
    const collected: DatastoreHeadWire = { head: 100n, gcFloor: 50n };

    expect(datastoreHeadWireGcFloor(noFloor)).toBe(0n);
    expect(datastoreHeadWireGcFloor(explicitZero)).toBe(0n);
    expect(datastoreHeadWireGcFloor(collected)).toBe(50n);
    expect(noFloor.gcFloor).toBeUndefined();
  });

  it("keeps an absent schema hash absent: the pre-first-schema seed window", () => {
    const seeded: DatastoreHeadWire = { head: 0n };

    const back = deserializeValue<DatastoreHeadWire>(serializeValue(seeded));

    expect(back.schemaHash).toBeUndefined();
    expect(datastoreHeadWireGcFloor(back)).toBe(0n);
  });
});

describe("SchemaVersionWire bytes", () => {
  it("compares by REFERENCE, so any equality helper must compare content explicitly", () => {
    // `byte[]` becomes `Uint8Array`, which has the same broken equality the C# record has - the
    // round-trip test works around it with `SequenceEqual`, and so must anything here. Stated as a
    // test so a later fold cannot quietly assume `a.bytes === b.bytes` means "same schema".
    const bytes = new TextEncoder().encode("definition doc {}");
    const a: SchemaVersionWire = { revision: 1n, bytes, hash: "h" };
    const b: SchemaVersionWire = {
      revision: 1n,
      bytes: new TextEncoder().encode("definition doc {}"),
      hash: "h",
    };

    expect(a.bytes).not.toBe(b.bytes);
    expect([...a.bytes]).toEqual([...b.bytes]);
    // The `hash` member is what the port compares when it wants "same schema" - which is why the
    // C# carries a hash alongside the bytes at all.
    expect(a.hash).toBe(b.hash);
  });
});

describe("the full relationships filter on the wire", () => {
  it("keeps the enum MIRRORS as plain numbers", () => {
    // `OptionalExpirationOption` and `CaveatNameFilterWire.Option` are `int` mirrors of core
    // enums. They stay NUMBERS here: `WireConvert` owns the mapping, and its tolerant default arms
    // (which is how an unknown value from a newer peer degrades rather than throwing) stop being
    // reachable if this layer narrows them into a union first.
    const filter: FullRelationshipsFilterWire = {
      optionalExpirationOption: 2,
      optionalCaveatNameFilter: { option: 1, caveatName: "is_active" },
    };

    const back = deserializeValue<FullRelationshipsFilterWire>(serializeValue(filter));

    expect(typeof back.optionalExpirationOption).toBe("number");
    expect(typeof back.optionalCaveatNameFilter?.option).toBe("number");
    // An out-of-range value must survive the wire, so WireConvert can apply its default arm.
    expect(
      deserializeValue<FullRelationshipsFilterWire>(
        serializeValue({ optionalExpirationOption: 99 } satisfies FullRelationshipsFilterWire),
      ).optionalExpirationOption,
    ).toBe(99);
  });

  it("round trips losslessly, which is what makes it usable for counter registration", () => {
    // "The counter's registered filter must round-trip exactly through the grain."
    const filter: FullRelationshipsFilterWire = {
      optionalResourceType: "doc",
      optionalResourceIds: ["a", "b"],
      optionalResourceIdPrefix: "pre",
      optionalResourceRelation: "viewer",
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: "user",
          optionalSubjectIds: ["alice"],
          relationFilter: {
            nonEllipsisRelation: "member",
            includeEllipsisRelation: true,
            onlyNonEllipsisRelations: false,
          },
        },
      ],
      optionalCaveatNameFilter: { option: 1, caveatName: "is_active" },
      optionalExpirationOption: 1,
    };

    expect(deserializeValue<FullRelationshipsFilterWire>(serializeValue(filter))).toEqual(filter);
  });

  it("keeps an absent selector list absent, distinct from an empty one", () => {
    // Absent places no subject constraint at all; an empty list is a constraint no subject
    // satisfies. Collapsing them turns a match-everything filter into a match-nothing one.
    const unconstrained: FullRelationshipsFilterWire = { optionalExpirationOption: 0 };
    const empty: FullRelationshipsFilterWire = {
      optionalExpirationOption: 0,
      optionalSubjectsSelectors: [],
    };

    expect(
      deserializeValue<FullRelationshipsFilterWire>(serializeValue(unconstrained))
        .optionalSubjectsSelectors,
    ).toBeUndefined();
    expect(
      deserializeValue<FullRelationshipsFilterWire>(serializeValue(empty))
        .optionalSubjectsSelectors,
    ).toEqual([]);
  });
});

describe("ProposedWrite", () => {
  it("is a revision-less net diff: changes, optional schema bytes, counter deltas", () => {
    // Once the wire shape of the retired two-step write path; it survives as the INPUT of
    // `LogFold.EventFromProposal`, which stamps a minted revision onto it. It therefore carries no
    // revision of its own, and that absence is the point.
    const proposal: ProposedWrite = {
      relationshipChanges: [{ operation: "touch", relationship: aRelationship() }],
      counterChanges: [{ name: "c1" }],
    };

    const back = deserializeValue<ProposedWrite>(serializeValue(proposal));

    expect(back.schemaBytes).toBeUndefined();
    expect(back.relationshipChanges).toHaveLength(1);
    // A null filter on a counter delta is a TOMBSTONE, not a missing value.
    expect(back.counterChanges[0]?.filter).toBeUndefined();
    expect("revision" in back).toBe(false);
  });
});

function aRelationship(): RelationshipWire {
  return {
    resourceType: "doc",
    resourceId: "1",
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: "...",
  };
}
