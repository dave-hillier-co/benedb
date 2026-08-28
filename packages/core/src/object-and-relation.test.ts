import { describe, expect, it } from "vitest";

import { ELLIPSIS, PUBLIC_WILDCARD } from "./core-constants";
import { formatRelationReference } from "./relation-reference";
import {
  asRelationReference,
  isPublicWildcard,
  objectAndRelationEquals,
  objectAndRelationKey,
  withRelation,
  type ObjectAndRelation,
} from "./object-and-relation";

// Characterization of Spiceport `ObjectAndRelation` (no covering C# test).
//
// Port decisions pinned here:
//   * The C# `record` becomes a readonly interface with camelCase members; its instance methods
//     become free functions in this module. Formatting lives in tuple-strings.ts (which owns the
//     mutually recursive ONR/relationship string graph), so `ToString()` is covered by
//     tuple-strings.test.ts, not here.
//   * This is the most common dictionary/HashSet key in the codebase. `objectAndRelationKey` is
//     the canonical key and ALWAYS includes the relation, including an ellipsis - unlike the
//     formatted ONR string, which elides it. Keying on the formatted string instead would make
//     the key ambiguous the moment a relation is empty.
const doc: ObjectAndRelation = { objectType: "document", objectId: "doc", relation: "viewer" };
const alice: ObjectAndRelation = { objectType: "user", objectId: "alice", relation: ELLIPSIS };

describe("object and relation", () => {
  describe("withRelation", () => {
    it("returns a fresh value and never mutates the original", () => {
      const editor = withRelation(doc, "editor");

      expect(editor).toEqual({ objectType: "document", objectId: "doc", relation: "editor" });
      expect(doc.relation).toBe("viewer");
      expect(editor).not.toBe(doc);
    });
  });

  describe("asRelationReference", () => {
    it("drops the object id", () => {
      expect(asRelationReference(doc)).toEqual({ objectType: "document", relation: "viewer" });
      expect(formatRelationReference(asRelationReference(doc))).toBe("document#viewer");
    });
  });

  describe("isPublicWildcard", () => {
    it("is true only for the exact wildcard object id", () => {
      expect(isPublicWildcard({ ...alice, objectId: PUBLIC_WILDCARD })).toBe(true);
      expect(isPublicWildcard(alice)).toBe(false);
      // C# `==` on string is ordinal; `===` matches. Nothing near-miss counts.
      expect(isPublicWildcard({ ...alice, objectId: "**" })).toBe(false);
      expect(isPublicWildcard({ ...alice, objectId: " *" })).toBe(false);
      expect(isPublicWildcard({ ...alice, objectId: "" })).toBe(false);
    });

    it("does not care which field holds the wildcard", () => {
      expect(isPublicWildcard({ objectType: "*", objectId: "alice", relation: "*" })).toBe(false);
    });
  });

  describe("objectAndRelationKey", () => {
    it("keeps the relation even when it is an ellipsis", () => {
      expect(objectAndRelationKey(doc)).toBe("document:doc#viewer");
      expect(objectAndRelationKey(alice)).toBe("user:alice#...");
    });

    it("distinguishes ONRs that share a formatted prefix", () => {
      const a = objectAndRelationKey({ objectType: "user", objectId: "alice", relation: ELLIPSIS });
      const b = objectAndRelationKey({ objectType: "user", objectId: "alice", relation: "member" });

      expect(a).not.toBe(b);
    });

    it("collapses structurally equal ONRs to one Map entry", () => {
      const keys = new Set([objectAndRelationKey(doc), objectAndRelationKey({ ...doc })]);

      expect(keys.size).toBe(1);
    });
  });

  describe("objectAndRelationEquals", () => {
    it("is structural, matching C# record equality", () => {
      expect(objectAndRelationEquals(doc, { ...doc })).toBe(true);
      expect(objectAndRelationEquals(doc, withRelation(doc, "editor"))).toBe(false);
      expect(objectAndRelationEquals(doc, { ...doc, objectId: "other" })).toBe(false);
      expect(objectAndRelationEquals(doc, { ...doc, objectType: "folder" })).toBe(false);
    });
  });
});
