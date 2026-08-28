import { describe, expect, it } from "vitest";

import { relationReferenceKey, type RelationReference } from "./relation-reference";

// Characterization of Spiceport `Engine/Reachability/RelationReference.cs` (no covering C# test).
//
// NAME COLLISION, deliberately preserved: `@spacedb/core/relation-reference` also exports a
// `RelationReference`, but its members are `{ objectType, relation }` while this engine record's
// are `{ namespace, relation }` (matching the C# `RelationReference(string Namespace, string
// Relation)`). The two types are therefore structurally INCOMPATIBLE, which is what we want -
// TypeScript will catch a cross-wiring that C# would too. Where both appear in one file (e.g.
// lookup-resources-engine, which uses core's `ObjectAndRelation` alongside this type), import
// core's under an alias.
//
// CRITICAL, and binding on every later batch: this record is used as a `Dictionary` KEY and a
// `HashSet` ELEMENT in reachability-graph.ts and schema-introspection.ts, where C# record
// equality is free and a JS `Map`/`Set` would compare by reference. `relationReferenceKey` is
// THE canonical key for this type. Later batches must import it rather than inventing a second
// one.
//
// The key LENGTH-PREFIXES each part rather than joining on a bare "#": SpiceDB object-type and
// relation names are validated elsewhere and that validator does not run inside the engine, so a
// bare separator would make injectivity depend on a check that may never have happened.
describe("engine relation reference", () => {
  it("length-prefixes each part", () => {
    const reference: RelationReference = { namespace: "document", relation: "viewer" };

    expect(relationReferenceKey(reference)).toBe("8:document#6:viewer");
  });

  it("is stable across structurally identical objects", () => {
    const a: RelationReference = { namespace: "document", relation: "viewer" };
    const b: RelationReference = { namespace: "document", relation: "viewer" };

    expect(relationReferenceKey(a)).toBe(relationReferenceKey(b));
    // ...whereas the objects themselves are distinct Map keys.
    expect(a).not.toBe(b);
  });

  it("distinguishes the namespace from the relation", () => {
    expect(relationReferenceKey({ namespace: "a", relation: "b" })).not.toBe(
      relationReferenceKey({ namespace: "b", relation: "a" }),
    );
  });

  it("is injective even when a part contains the separator characters", () => {
    // A bare `${ns}#${rel}` join collides on these two; the length prefix does not.
    const first = relationReferenceKey({ namespace: "a#b", relation: "c" });
    const second = relationReferenceKey({ namespace: "a", relation: "b#c" });

    expect(first).not.toBe(second);
  });

  it("is injective when a part contains a colon", () => {
    expect(relationReferenceKey({ namespace: "1:x", relation: "y" })).not.toBe(
      relationReferenceKey({ namespace: "1", relation: "x#1:y" }),
    );
  });

  it("handles empty parts", () => {
    expect(relationReferenceKey({ namespace: "", relation: "" })).toBe("0:#0:");
    expect(relationReferenceKey({ namespace: "", relation: "a" })).not.toBe(
      relationReferenceKey({ namespace: "a", relation: "" }),
    );
  });

  it("counts UTF-16 code units, matching JavaScript string length", () => {
    // Not a validity claim about SpiceDB names - just that the prefix and the part agree, which
    // is all injectivity needs.
    const key = relationReferenceKey({ namespace: "é", relation: "\u{1f600}" });

    expect(key).toBe("1:é#2:\u{1f600}");
  });

  it("works as a Map key where the object itself would not", () => {
    const byKey = new Map<string, number>();
    byKey.set(relationReferenceKey({ namespace: "document", relation: "viewer" }), 1);

    expect(byKey.get(relationReferenceKey({ namespace: "document", relation: "viewer" }))).toBe(1);
    expect(byKey.size).toBe(1);
  });

  it("works as a Set element where the object itself would not", () => {
    const seen = new Set<string>();
    seen.add(relationReferenceKey({ namespace: "document", relation: "viewer" }));
    seen.add(relationReferenceKey({ namespace: "document", relation: "viewer" }));

    expect(seen.size).toBe(1);
  });
});
