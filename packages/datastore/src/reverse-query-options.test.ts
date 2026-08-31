import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipReference } from "@benedb/core/relationship-reference";

import {
  compareReferencesBySubject,
  compareRelationshipsBySubject,
  type ReverseQueryOptions,
} from "./reverse-query-options";

// Port of Spiceport `ReverseQueryOptions.cs`. Covered in Spiceport only by
// ReferenceDatastoreTests.ReverseQuery_BySubject_OrdersAndResumesAfterKeyset, which is carried
// across below at the level this batch can reach: the comparator plus the exclusive-keyset
// guard the reader applies with it.
//
// Port decisions pinned here:
//
// 1. `CompareBySubject` is six `string.CompareOrdinal` calls. JS `<` / `>` on strings IS UTF-16
//    ordinal comparison, so the port is `a < b ? -1 : a > b ? 1 : 0`. `localeCompare` is WRONG
//    and would corrupt every cursor - the cases below pin ordinal ordering explicitly.
//
// 2. `CompareOrdinal` returns a character difference, not -1/0/1, but only its SIGN is ever
//    consumed (`!= 0`, `<= 0`, and as a sort comparator), so narrowing to -1/0/1 is safe. These
//    tests therefore assert the sign, and additionally pin the narrowed magnitude.
//
// 3. The sort key is SUBJECT-first: (subjectType, subjectId, subjectRelation, resourceType,
//    resourceId, resourceRelation). This is a DIFFERENT order from MvccReadWriteTransaction's
//    resource-first delete-limit comparator; the two must not share one function.
//
// 4. The two C# overloads - (Relationship, Relationship) and (RelationshipReference,
//    RelationshipReference) - become two distinctly named free functions.
//
// 5. `.NET List<T>.Sort` is an unstable introsort while `Array.prototype.sort` is stable, but
//    the six-tuple is the relationship's primary key, so the comparator is total and no ties
//    exist. The difference is unobservable.
//
// 6. `ReverseQuerySort` is NOT wire-visible - it never leaves the process - so it is a plain
//    string-literal union with no wire map, despite the explicit 0/1 in the C#.
//
// 7. `After` is an EXCLUSIVE keyset applied AFTER the sort, not folded into it: the reader's
//    guard is `compare(rel.reference, after) <= 0`.
function rel(
  resourceType: string,
  resourceId: string,
  resourceRelation: string,
  subjectType: string,
  subjectId: string,
  subjectRelation: string = ELLIPSIS,
): Relationship {
  return createRelationship(
    { objectType: resourceType, objectId: resourceId, relation: resourceRelation },
    { objectType: subjectType, objectId: subjectId, relation: subjectRelation },
  );
}

function sign(value: number): number {
  return Math.sign(value);
}

describe("compareReferencesBySubject", () => {
  const base = rel("document", "doc1", "viewer", "user", "alice").reference;

  it("returns 0 for value-equal references built independently", () => {
    const same = rel("document", "doc1", "viewer", "user", "alice").reference;

    expect(compareReferencesBySubject(base, same)).toBe(0);
  });

  it("orders by subject type before anything else", () => {
    // Subject type "group" < "user" even though the resource id would order the other way.
    const a = rel("document", "zzz", "viewer", "group", "zzz", "member").reference;
    const b = rel("document", "aaa", "viewer", "user", "aaa").reference;

    expect(sign(compareReferencesBySubject(a, b))).toBe(-1);
    expect(sign(compareReferencesBySubject(b, a))).toBe(1);
  });

  it("orders by subject id when the subject types are equal", () => {
    const a = rel("document", "zzz", "viewer", "user", "alice").reference;
    const b = rel("document", "aaa", "viewer", "user", "bob").reference;

    expect(sign(compareReferencesBySubject(a, b))).toBe(-1);
  });

  it("orders by subject relation when type and id are equal", () => {
    const a = rel("document", "zzz", "viewer", "group", "g", "manager").reference;
    const b = rel("document", "aaa", "viewer", "group", "g", "member").reference;

    expect(sign(compareReferencesBySubject(a, b))).toBe(-1);
  });

  it("falls through to resource type, then resource id, then resource relation", () => {
    const subject = { objectType: "user", objectId: "alice", relation: ELLIPSIS };
    const byType = [
      { resource: { objectType: "document", objectId: "x", relation: "viewer" }, subject },
      { resource: { objectType: "folder", objectId: "a", relation: "aaa" }, subject },
    ] satisfies RelationshipReference[];
    const byId = [
      { resource: { objectType: "document", objectId: "doc1", relation: "zzz" }, subject },
      { resource: { objectType: "document", objectId: "doc2", relation: "aaa" }, subject },
    ] satisfies RelationshipReference[];
    const byRelation = [
      { resource: { objectType: "document", objectId: "doc1", relation: "editor" }, subject },
      { resource: { objectType: "document", objectId: "doc1", relation: "viewer" }, subject },
    ] satisfies RelationshipReference[];

    for (const [a, b] of [byType, byId, byRelation]) {
      expect(sign(compareReferencesBySubject(a!, b!))).toBe(-1);
      expect(sign(compareReferencesBySubject(b!, a!))).toBe(1);
    }
  });

  it("compares ordinally, not by locale", () => {
    const subject = { objectType: "user", objectId: "alice", relation: ELLIPSIS };
    const upper: RelationshipReference = {
      resource: { objectType: "document", objectId: "Z", relation: "viewer" },
      subject,
    };
    const lower: RelationshipReference = {
      resource: { objectType: "document", objectId: "a", relation: "viewer" },
      subject,
    };

    // Ordinal: 'Z' (U+005A) < 'a' (U+0061). A locale comparison would say the opposite.
    expect(sign(compareReferencesBySubject(upper, lower))).toBe(-1);
    expect("Z".localeCompare("a")).toBeGreaterThan(0);
  });

  it("orders an ellipsis subject relation ordinally against concrete relations", () => {
    // "..." (U+002E) sorts before every ASCII letter.
    const ellipsis = rel("document", "d", "viewer", "user", "alice", ELLIPSIS).reference;
    const member = rel("document", "d", "viewer", "user", "alice", "member").reference;

    expect(sign(compareReferencesBySubject(ellipsis, member))).toBe(-1);
  });

  it("treats the empty string as ordering before every non-empty string", () => {
    const empty = rel("document", "d", "viewer", "user", "").reference;
    const nonEmpty = rel("document", "d", "viewer", "user", "a").reference;

    expect(sign(compareReferencesBySubject(empty, nonEmpty))).toBe(-1);
  });

  it("narrows the C# character difference to -1/0/1", () => {
    const a = rel("document", "d", "viewer", "user", "a").reference;
    const b = rel("document", "d", "viewer", "user", "z").reference;

    expect(compareReferencesBySubject(a, b)).toBe(-1);
    expect(compareReferencesBySubject(b, a)).toBe(1);
    expect(compareReferencesBySubject(a, a)).toBe(0);
  });

  it("is antisymmetric and transitive over a mixed set", () => {
    const refs = [
      rel("document", "doc2", "viewer", "user", "alice").reference,
      rel("folder", "f1", "viewer", "group", "g", "member").reference,
      rel("document", "doc1", "editor", "user", "alice").reference,
      rel("document", "doc1", "viewer", "user", "alice").reference,
      rel("document", "doc1", "viewer", "user", "bob").reference,
    ];

    for (const a of refs) {
      for (const b of refs) {
        // `-Math.sign(0)` is -0 and `toBe` is Object.is, so the negated zero is normalized
        // back to +0. The comparator returns a plain 0 for equal references, as CompareOrdinal
        // does; the source is the authority and this was a defect in the assertion.
        expect(sign(compareReferencesBySubject(a, b))).toBe(
          -sign(compareReferencesBySubject(b, a)) || 0,
        );
      }
    }

    const sorted = [...refs].sort(compareReferencesBySubject);
    for (let i = 1; i < sorted.length; i++) {
      expect(compareReferencesBySubject(sorted[i - 1]!, sorted[i]!)).toBeLessThan(0);
    }
  });
});

describe("compareRelationshipsBySubject", () => {
  it("delegates to the reference comparison, ignoring caveat and expiration payload", () => {
    const plain = rel("document", "doc1", "viewer", "user", "alice");
    const decorated: Relationship = {
      ...rel("document", "doc1", "viewer", "user", "alice"),
      optionalCaveat: { caveatName: "biz_hours" },
      optionalExpiration: 1_700_000_000_000_000_000n,
    };

    expect(compareRelationshipsBySubject(plain, decorated)).toBe(0);
  });

  it("agrees with compareReferencesBySubject", () => {
    const a = rel("document", "doc2", "viewer", "user", "alice");
    const b = rel("document", "doc1", "viewer", "user", "bob");

    expect(compareRelationshipsBySubject(a, b)).toBe(
      compareReferencesBySubject(a.reference, b.reference),
    );
  });

  it("sorts out-of-order rows into subject-first order (ReferenceDatastoreTests.ReverseQuery_BySubject_OrdersAndResumesAfterKeyset)", () => {
    const rows = [
      rel("document", "doc3", "viewer", "user", "alice"),
      rel("document", "doc1", "viewer", "user", "alice"),
      rel("document", "doc2", "viewer", "user", "alice"),
    ];

    const ordered = [...rows].sort(compareRelationshipsBySubject);

    expect(ordered.map((r) => r.reference.resource.objectId)).toEqual(["doc1", "doc2", "doc3"]);
  });

  it("resumes exclusively after a keyset position, applied AFTER the sort", () => {
    const rows = [
      rel("document", "doc3", "viewer", "user", "alice"),
      rel("document", "doc1", "viewer", "user", "alice"),
      rel("document", "doc2", "viewer", "user", "alice"),
    ];
    const ordered = [...rows].sort(compareRelationshipsBySubject);
    const after = ordered[0]!.reference;

    const resumed = ordered.filter((r) => compareReferencesBySubject(r.reference, after) > 0);

    expect(resumed.map((r) => r.reference.resource.objectId)).toEqual(["doc2", "doc3"]);
  });

  it("groups by subject before resource, so subject ordering dominates the page order", () => {
    const rows = [
      rel("document", "doc1", "viewer", "user", "bob"),
      rel("document", "doc2", "viewer", "user", "alice"),
      rel("document", "doc1", "viewer", "user", "alice"),
    ];

    const ordered = [...rows].sort(compareRelationshipsBySubject);

    expect(
      ordered.map((r) => `${r.reference.subject.objectId}/${r.reference.resource.objectId}`),
    ).toEqual(["alice/doc1", "alice/doc2", "bob/doc1"]);
  });
});

describe("ReverseQueryOptions", () => {
  it("defaults to unsorted with no keyset, matching the C# default constructor arguments", () => {
    const options: ReverseQueryOptions = {};

    expect(options.sort ?? "unsorted").toBe("unsorted");
    expect(options.after).toBeUndefined();
  });

  it("carries a sort and an exclusive keyset position", () => {
    const after = rel("document", "doc1", "viewer", "user", "alice").reference;
    const options: ReverseQueryOptions = { sort: "bySubject", after };

    expect(options.sort).toBe("bySubject");
    expect(options.after).toBe(after);
  });
});
