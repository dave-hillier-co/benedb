import { describe, expect, it } from "vitest";

import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship } from "@benedb/core/relationship";

import { relationshipKeyOf, relationshipKeyString, type RelationshipKey } from "./relationship-key";

// Characterization of Spiceport `RelationshipKey` (no covering C# test - it is asserted only
// indirectly, through ReferenceDatastoreTests and the MVCC transaction).
//
// Port decisions pinned here:
//
// 1. The C# type is an `internal readonly record struct`. `internal` has no TypeScript
//    equivalent, so the port exports it normally; nothing outside this package should import it.
//
// 2. The C# uses it as a `Dictionary` key (`MvccReadWriteTransaction._live`), as `HashSet`
//    members (`_deleted`, `_created`, `DatastoreState.ChangesAt`'s touched keys) and compares it
//    with `==`. A TypeScript `Map`/`Set` keys by REFERENCE, so all of those lookups silently
//    miss unless the port keys by an injective canonical string. Hence the split: the record
//    shape (`RelationshipKey`, which `MvccReadWriteTransaction` still sorts by field) plus
//    `relationshipKeyString` for use as the actual `Map`/`Set` key.
//
// 3. The canonical string LENGTH-PREFIXES each field rather than joining on a separator. A
//    separator only yields an injective key if it cannot occur in a field, and no layer on this
//    path enforces the SpiceDB grammar - `validateRelationship` checks emptiness and the
//    resource wildcard rule and nothing else - so any separator, however unusual, admits a
//    collision between two distinct relationships. Length-prefixing restores the C# record
//    struct's unconditional guarantee. Injectivity is what the tests assert; the exact encoding
//    is checked too, because stored keys would otherwise change meaning across a port revision.
//
// 4. Caveat, expiration and integrity are payload, not identity: two relationships that differ
//    only in those produce the same key.
const alice: ObjectAndRelation = { objectType: "user", objectId: "alice", relation: ELLIPSIS };

function key(
  resourceType: string,
  resourceId: string,
  resourceRelation: string,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
): RelationshipKey {
  return {
    resourceType,
    resourceId,
    resourceRelation,
    subjectType,
    subjectId,
    subjectRelation,
  };
}

describe("relationshipKeyOf", () => {
  it("projects the six identity parts of a relationship in resource-then-subject order", () => {
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      alice,
    );

    expect(relationshipKeyOf(rel)).toEqual(
      key("document", "doc1", "viewer", "user", "alice", ELLIPSIS),
    );
  });

  it("keeps an ellipsis subject relation rather than eliding it", () => {
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      alice,
    );

    expect(relationshipKeyOf(rel).subjectRelation).toBe(ELLIPSIS);
  });

  it("keeps a wildcard subject id verbatim", () => {
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: PUBLIC_WILDCARD, relation: ELLIPSIS },
    );

    expect(relationshipKeyOf(rel).subjectId).toBe(PUBLIC_WILDCARD);
  });

  it("ignores caveat, expiration and integrity - they are payload, not identity", () => {
    const resource: ObjectAndRelation = {
      objectType: "document",
      objectId: "doc1",
      relation: "viewer",
    };
    const plain = createRelationship(resource, alice);
    const decorated = createRelationship(
      resource,
      alice,
      { caveatName: "biz_hours", context: new Map([["a", 1]]) },
      1_700_000_000_000_000_000n,
      { keyId: "k", hash: new Uint8Array([1, 2, 3]), hashedAt: 0n },
    );

    expect(relationshipKeyOf(decorated)).toEqual(relationshipKeyOf(plain));
    expect(relationshipKeyString(relationshipKeyOf(decorated))).toBe(
      relationshipKeyString(relationshipKeyOf(plain)),
    );
  });
});

describe("relationshipKeyString", () => {
  it("length-prefixes the six parts, resource first", () => {
    expect(
      relationshipKeyString(key("document", "doc1", "viewer", "user", "alice", ELLIPSIS)),
    ).toBe("8:document4:doc16:viewer4:user5:alice3:...");
  });

  // The C# key is a record struct, so its equality is injective for ANY six strings. A joined
  // string only inherits that if the separator cannot occur in a field -- and nothing on this
  // path enforces the SpiceDB grammar: `validateRelationship` checks emptiness and the resource
  // wildcard rule and nothing else. Two relationships whose fields differ only by where a
  // boundary falls therefore reach the key builder and must stay distinct.
  it("distinguishes keys whose fields differ only by where a boundary falls", () => {
    const straddling = key("document", "a b", "viewer", "user", "alice", ELLIPSIS);
    const shifted = key("document", "a", "b viewer", "user", "alice", ELLIPSIS);

    expect(relationshipKeyString(straddling)).not.toBe(relationshipKeyString(shifted));
  });

  // Includes the two characters a naive fix would reach for as a "cannot occur" separator: a
  // length-prefixed key does not care, because it never relies on exclusion.
  it.each([" ", ":", "#", "|", "/", "\u0000", "\u001f"])(
    "stays injective when a field contains %j",
    (char) => {
      const left = key("document", `a${char}b`, "viewer", "user", "alice", ELLIPSIS);
      const right = key("document", "a", `b${char}viewer`, "user", "alice", ELLIPSIS);

      expect(relationshipKeyString(left)).not.toBe(relationshipKeyString(right));
    },
  );

  it("is stable: equal-valued keys built independently produce the same string", () => {
    const a = key("document", "doc1", "viewer", "user", "alice", ELLIPSIS);
    const b = key("document", "doc1", "viewer", "user", "alice", ELLIPSIS);

    expect(relationshipKeyString(b)).toBe(relationshipKeyString(a));
  });

  it("distinguishes keys that differ in any single part", () => {
    const base = key("document", "doc1", "viewer", "user", "alice", ELLIPSIS);
    const variants = [
      key("folder", "doc1", "viewer", "user", "alice", ELLIPSIS),
      key("document", "doc2", "viewer", "user", "alice", ELLIPSIS),
      key("document", "doc1", "editor", "user", "alice", ELLIPSIS),
      key("document", "doc1", "viewer", "group", "alice", ELLIPSIS),
      key("document", "doc1", "viewer", "user", "bob", ELLIPSIS),
      key("document", "doc1", "viewer", "user", "alice", "member"),
    ];

    const strings = new Set(variants.map(relationshipKeyString));
    expect(strings.size).toBe(variants.length);
    expect(strings.has(relationshipKeyString(base))).toBe(false);
  });

  it("is injective across the separator-collision shapes that legal SpiceDB names allow", () => {
    // Every one of these characters is legal inside an object type, object id or relation, so
    // none of them may be the separator. Field boundaries must survive them.
    const collisions = [
      key("document", "a/b", "viewer", "user", "alice", ELLIPSIS),
      key("document", "a", "b/viewer", "user", "alice", ELLIPSIS),
      key("document", "a|b", "viewer", "user", "alice", ELLIPSIS),
      key("document", "a", "b|viewer", "user", "alice", ELLIPSIS),
      key("document", "a-b", "viewer", "user", "alice", ELLIPSIS),
      key("document", "a", "b-viewer", "user", "alice", ELLIPSIS),
      key("document", "a_b", "viewer", "user", "alice", ELLIPSIS),
      key("document", "a", "b_viewer", "user", "alice", ELLIPSIS),
      key("document", "a.b", "viewer", "user", "alice", ELLIPSIS),
      key("document", "a", "b.viewer", "user", "alice", ELLIPSIS),
      key("document", "a:b", "viewer", "user", "alice", ELLIPSIS),
      key("document", "a", "b:viewer", "user", "alice", ELLIPSIS),
      key("document", "a#b", "viewer", "user", "alice", ELLIPSIS),
      key("document", "a", "b#viewer", "user", "alice", ELLIPSIS),
      key("doc/ument", "a", "viewer", "user", "alice", ELLIPSIS),
      key("doc", "ument/a", "viewer", "user", "alice", ELLIPSIS),
    ];

    expect(new Set(collisions.map(relationshipKeyString)).size).toBe(collisions.length);
  });

  it("distinguishes an empty part from an absent boundary", () => {
    const emptyId = key("document", "", "viewer", "user", "alice", ELLIPSIS);
    const emptyRelation = key("document", "doc1", "", "user", "alice", ELLIPSIS);

    expect(relationshipKeyString(emptyId)).not.toBe(relationshipKeyString(emptyRelation));
    expect(relationshipKeyString(emptyId)).not.toBe(
      relationshipKeyString(key("document", "viewer", "", "user", "alice", ELLIPSIS)),
    );
  });

  it("works as a Map key, where the record object itself would not", () => {
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      alice,
    );
    const same = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
    );

    const live = new Map<string, number>();
    live.set(relationshipKeyString(relationshipKeyOf(rel)), 1);

    expect(live.get(relationshipKeyString(relationshipKeyOf(same)))).toBe(1);
    // The pitfall this exists to avoid: distinct record objects are distinct Map keys.
    expect(new Map([[relationshipKeyOf(rel), 1]]).get(relationshipKeyOf(same))).toBeUndefined();
  });

  it("works as a Set member, deduplicating equal-valued keys", () => {
    const deleted = new Set<string>();
    deleted.add(
      relationshipKeyString(key("document", "doc1", "viewer", "user", "alice", ELLIPSIS)),
    );
    deleted.add(
      relationshipKeyString(key("document", "doc1", "viewer", "user", "alice", ELLIPSIS)),
    );

    expect(deleted.size).toBe(1);
    expect(
      deleted.has(
        relationshipKeyString(key("document", "doc1", "viewer", "user", "alice", ELLIPSIS)),
      ),
    ).toBe(true);
  });
});
