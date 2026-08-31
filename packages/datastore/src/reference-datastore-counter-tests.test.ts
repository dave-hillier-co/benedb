import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";

import {
  CounterAlreadyRegisteredException,
  CounterNotRegisteredException,
} from "./datastore-exceptions";
import { ReferenceDatastore } from "./reference-datastore";
import type { RelationshipsFilter } from "./relationships-filter";

// Port of Spiceport `tests/Spiceport.Datastore.Tests/ReferenceDatastoreCounterTests.cs`.
//
// Datastore-level conformance for the relationship-counter primitive on the reference datastore:
// register / read-filter / count / overwrite-conflict / delete, MVCC snapshot isolation, and that
// the count tracks live matches across writes and deletes.
//
// This is the more targeted gate on `MvccReadWriteTransaction`'s STAGED-COUNTER paths - the two
// cases the datastore-level tests cannot reach any other way:
//
// - "throws when a counter is written twice within one transaction" pins that `writeCounter`
//   resolves visibility through the staged map FIRST (`_pendingCounterWrites`), then the staged
//   tombstone set, and only then the committed base state. A port that consulted the base state
//   alone would let the second write silently overwrite the first.
// - "re-registers a deleted counter" pins the other half: `writeCounter` must REMOVE the name
//   from the tombstone set before staging, and `deleteCounter` must remove it from the staged
//   writes before tombstoning, so the two staging structures can never both claim a name.
//
// `LookupCounters` iterates a `HashSet<string>` in unspecified .NET order while a JS `Set` is
// insertion-ordered. That divergence is benign, but no case here may assert an order that only
// one of the two guarantees - the single lookup case below has exactly one surviving counter.

function rel(
  resType: string,
  resId: string,
  relation: string,
  subType: string,
  subId: string,
  subRel: string = ELLIPSIS,
): Relationship {
  return createRelationship(
    { objectType: resType, objectId: resId, relation },
    { objectType: subType, objectId: subId, relation: subRel },
  );
}

function create(relationship: Relationship): RelationshipUpdate {
  return { relationship, operation: "create" };
}

function remove(relationship: Relationship): RelationshipUpdate {
  return { relationship, operation: "delete" };
}

function docViewerFilter(): RelationshipsFilter {
  return { optionalResourceType: "document", optionalResourceRelation: "viewer" };
}

/**
 * Runs `action`, expecting it to reject, and returns the rejection. The C# `Assert.ThrowsAsync<T>`
 * returns the exception so a case can go on to assert its data; vitest's `rejects` matchers do
 * not, so cases that check both the type and `counterName` capture the error once here rather
 * than running the transaction twice.
 */
async function rejection(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to reject");
}

describe("ReferenceDatastore counters", () => {
  it("round-trips a written counter filter", async () => {
    const ds = new ReferenceDatastore();
    const filter: RelationshipsFilter = {
      optionalResourceType: "document",
      optionalResourceIds: ["doc1"],
      optionalResourceRelation: "viewer",
      optionalSubjectsSelectors: [{ optionalSubjectType: "user" }],
    };

    const rev = await ds.readWriteTx((tx) => tx.writeCounter("c", filter));

    const read = await ds.snapshotReader(rev).readCounterFilter("c");
    expect(read).toBeDefined();
    expect(read!.optionalResourceType).toBe("document");
    expect(read!.optionalResourceIds).toEqual(["doc1"]);
    expect(read!.optionalResourceRelation).toBe("viewer");
    expect(read!.optionalSubjectsSelectors).toHaveLength(1);
    expect(read!.optionalSubjectsSelectors![0]!.optionalSubjectType).toBe("user");
  });

  it("returns undefined for an unknown counter filter", async () => {
    // `Assert.Null` becomes `toBeUndefined`: the port uses `undefined`, never `null`.
    const ds = new ReferenceDatastore();
    const head = await ds.headRevision();
    expect(await ds.snapshotReader(head.revision).readCounterFilter("nope")).toBeUndefined();
  });

  it("counts the relationships matching the counter's filter", async () => {
    const ds = new ReferenceDatastore();
    await ds.readWriteTx((tx) =>
      tx.writeRelationships([
        create(rel("document", "doc1", "viewer", "user", "alice")),
        create(rel("document", "doc2", "viewer", "user", "bob")),
        create(rel("document", "doc3", "editor", "user", "carol")),
      ]),
    );
    const rev = await ds.readWriteTx((tx) => tx.writeCounter("viewers", docViewerFilter()));

    expect(await ds.snapshotReader(rev).countRelationships("viewers")).toBe(2n);
  });

  it("throws when counting an unknown counter", async () => {
    const ds = new ReferenceDatastore();
    const head = await ds.headRevision();
    await expect(ds.snapshotReader(head.revision).countRelationships("nope")).rejects.toThrow(
      CounterNotRegisteredException,
    );
  });

  it("throws when a counter name is registered twice", async () => {
    const ds = new ReferenceDatastore();
    await ds.readWriteTx((tx) => tx.writeCounter("c", docViewerFilter()));

    const error = await rejection(() =>
      ds.readWriteTx((tx) => tx.writeCounter("c", docViewerFilter())),
    );

    expect(error).toBeInstanceOf(CounterAlreadyRegisteredException);
    expect((error as CounterAlreadyRegisteredException).counterName).toBe("c");
  });

  it("throws when a counter is written twice within one transaction", async () => {
    const ds = new ReferenceDatastore();
    await expect(
      ds.readWriteTx(async (tx) => {
        await tx.writeCounter("c", docViewerFilter());
        await tx.writeCounter("c", docViewerFilter());
      }),
    ).rejects.toThrow(CounterAlreadyRegisteredException);
  });

  it("throws when counting a deleted counter", async () => {
    const ds = new ReferenceDatastore();
    await ds.readWriteTx((tx) => tx.writeCounter("c", docViewerFilter()));
    const rev = await ds.readWriteTx((tx) => tx.deleteCounter("c"));

    await expect(ds.snapshotReader(rev).countRelationships("c")).rejects.toThrow(
      CounterNotRegisteredException,
    );
    expect(await ds.snapshotReader(rev).readCounterFilter("c")).toBeUndefined();
  });

  it("throws when deleting an unknown counter", async () => {
    const ds = new ReferenceDatastore();
    const error = await rejection(() => ds.readWriteTx((tx) => tx.deleteCounter("nope")));

    expect(error).toBeInstanceOf(CounterNotRegisteredException);
    expect((error as CounterNotRegisteredException).counterName).toBe("nope");
  });

  it("re-registers a deleted counter", async () => {
    const ds = new ReferenceDatastore();
    await ds.readWriteTx((tx) => tx.writeCounter("c", docViewerFilter()));
    await ds.readWriteTx((tx) => tx.deleteCounter("c"));
    const rev = await ds.readWriteTx((tx) => tx.writeCounter("c", docViewerFilter()));

    expect(await ds.snapshotReader(rev).readCounterFilter("c")).toBeDefined();
  });

  it("keeps counts snapshot-isolated across writes and deletes", async () => {
    const ds = new ReferenceDatastore();

    await ds.readWriteTx((tx) =>
      tx.writeRelationships([create(rel("document", "doc1", "viewer", "user", "alice"))]),
    );
    const revRegistered = await ds.readWriteTx((tx) =>
      tx.writeCounter("viewers", docViewerFilter()),
    );

    // A matching write increases the count at the newer snapshot only.
    const revAfterMatch = await ds.readWriteTx((tx) =>
      tx.writeRelationships([create(rel("document", "doc2", "viewer", "user", "bob"))]),
    );

    // A non-matching write does not change the count.
    const revAfterNonMatch = await ds.readWriteTx((tx) =>
      tx.writeRelationships([create(rel("document", "doc3", "editor", "user", "carol"))]),
    );

    // A matching delete decreases the count at the newest snapshot.
    const revAfterDelete = await ds.readWriteTx((tx) =>
      tx.writeRelationships([remove(rel("document", "doc1", "viewer", "user", "alice"))]),
    );

    expect(await ds.snapshotReader(revRegistered).countRelationships("viewers")).toBe(1n);
    expect(await ds.snapshotReader(revAfterMatch).countRelationships("viewers")).toBe(2n);
    expect(await ds.snapshotReader(revAfterNonMatch).countRelationships("viewers")).toBe(2n);
    expect(await ds.snapshotReader(revAfterDelete).countRelationships("viewers")).toBe(1n);

    // The original snapshot is unchanged by all later writes.
    expect(await ds.snapshotReader(revRegistered).countRelationships("viewers")).toBe(1n);
  });

  it("makes a counter visible per snapshot and tombstoned after unregister", async () => {
    const ds = new ReferenceDatastore();
    const revBefore = (await ds.headRevision()).revision;
    const revRegistered = await ds.readWriteTx((tx) => tx.writeCounter("c", docViewerFilter()));
    const revUnregistered = await ds.readWriteTx((tx) => tx.deleteCounter("c"));

    // Not visible before registration.
    expect(await ds.snapshotReader(revBefore).readCounterFilter("c")).toBeUndefined();
    // Visible at and after registration, before unregister.
    expect(await ds.snapshotReader(revRegistered).readCounterFilter("c")).toBeDefined();
    // Tombstoned after unregister.
    expect(await ds.snapshotReader(revUnregistered).readCounterFilter("c")).toBeUndefined();
  });

  it("looks up only the live counters", async () => {
    const ds = new ReferenceDatastore();
    await ds.readWriteTx(async (tx) => {
      await tx.writeCounter("a", docViewerFilter());
      await tx.writeCounter("b", docViewerFilter());
    });
    const rev = await ds.readWriteTx((tx) => tx.deleteCounter("a"));

    const names: string[] = [];
    for await (const counter of ds.snapshotReader(rev).lookupCounters()) names.push(counter.name);

    expect(names).toEqual(["b"]);
  });
});
