import { describe, expect, it } from "vitest";

import { createRelationship } from "@benedb/core/relationship";

import { relationshipsFilterMatches, type RelationshipsFilter } from "./relationships-filter";
import type { RegisteredCounter } from "./counters";

// Port of Spiceport `Counters.cs`:
//
//     public sealed record RegisteredCounter(string Name, RelationshipsFilter Filter);
//
// Spiceport asserts it only sociably, through
// ReferenceDatastoreCounterTests.LookupCounters_ReturnsLiveCounters, which registers counters
// "a" and "b", deletes "a", and asserts the snapshot at that revision yields exactly ["b"] by
// `Name`. That test belongs to the MVCC layer this port has not reached; what it needs FROM
// this file is carried across below as a direct unit test.
//
// Port decisions pinned here:
//
// 1. A plain readonly `interface`, not a class: nothing keys or hashes a RegisteredCounter, so
//    it needs no canonical-key or equality helper (unlike RelationshipReference).
//
// 2. BOTH members are required and non-optional. The MVCC counter version carries a NULLABLE
//    filter (null is the tombstone that unregisters the counter); RegisteredCounter is what a
//    LIVE counter looks like, so the tombstone case must not be representable here.
describe("registered counter", () => {
  const docViewerFilter: RelationshipsFilter = {
    optionalResourceType: "document",
    optionalResourceRelation: "viewer",
  };

  it("binds a name to the filter whose matches it counts", () => {
    const counter: RegisteredCounter = { name: "viewers", filter: docViewerFilter };

    expect(counter.name).toBe("viewers");
    expect(counter.filter).toBe(docViewerFilter);
  });

  it("carries a filter that is the batch-1 RelationshipsFilter, usable as one", () => {
    const counter: RegisteredCounter = { name: "viewers", filter: docViewerFilter };

    const viewer = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: "..." },
    );
    const editor = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "editor" },
      { objectType: "user", objectId: "alice", relation: "..." },
    );

    expect(relationshipsFilterMatches(counter.filter, viewer)).toBe(true);
    expect(relationshipsFilterMatches(counter.filter, editor)).toBe(false);
  });

  it("is distinguished by name, which is what LookupCounters projects", () => {
    // The shape LookupCounters_ReturnsLiveCounters consumes: a stream of counters, mapped to
    // their names. Registering "a" and "b" then unregistering "a" leaves ["b"] live.
    const live: readonly RegisteredCounter[] = [{ name: "b", filter: docViewerFilter }];

    expect(live.map((c) => c.name)).toEqual(["b"]);
  });

  it("requires both members", () => {
    // @ts-expect-error - Filter is non-optional: a tombstoned (filter-less) counter version is
    // not a RegisteredCounter.
    const missingFilter: RegisteredCounter = { name: "a" };
    // @ts-expect-error - Name is non-optional.
    const missingName: RegisteredCounter = { filter: docViewerFilter };

    expect(missingFilter.name).toBe("a");
    expect(missingName.filter).toBe(docViewerFilter);
  });
});
