import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "./core-constants";
import { formatRelationReference, type RelationReference } from "./relation-reference";

// Characterization of Spiceport `RelationReference` (no covering C# test).
//
// Port decisions pinned here:
//   * The C# `record`'s value equality has no TypeScript equivalent, and this type is used as a
//     dictionary/HashSet key in Spiceport. `formatRelationReference` is therefore the canonical
//     key: `type#relation`, exactly the C# `ToString()`.
//   * `ToString()` does NOT elide an ellipsis relation, unlike `ObjectAndRelation.ToString()`.
//     The two formats deliberately differ; see the ellipsis case below.
describe("relation reference", () => {
  it("formats as namespace#relation", () => {
    const rr: RelationReference = { objectType: "org", relation: "admin" };

    expect(formatRelationReference(rr)).toBe("org#admin");
  });

  it("does not elide an ellipsis relation, unlike an ONR", () => {
    const rr: RelationReference = { objectType: "org", relation: ELLIPSIS };

    expect(formatRelationReference(rr)).toBe("org#...");
  });

  it("does not validate: it formats whatever it is given", () => {
    const rr: RelationReference = { objectType: "Org/Team", relation: "" };

    expect(formatRelationReference(rr)).toBe("Org/Team#");
  });

  it("is a stable canonical key for Map/Set use", () => {
    const a: RelationReference = { objectType: "org", relation: "admin" };
    const b: RelationReference = { objectType: "org", relation: "admin" };

    // Two structurally identical objects are distinct Map keys; the string key is not.
    const byObject = new Map<RelationReference, number>([
      [a, 1],
      [b, 2],
    ]);
    const byKey = new Map<string, number>([
      [formatRelationReference(a), 1],
      [formatRelationReference(b), 2],
    ]);

    expect(byObject.size).toBe(2);
    expect(byKey.size).toBe(1);
  });
});
