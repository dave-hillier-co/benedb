import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "./core-constants";
import type { ObjectAndRelation } from "./object-and-relation";
import {
  relationshipReferenceEquals,
  relationshipReferenceKey,
  type RelationshipReference,
} from "./relationship-reference";

// Characterization of Spiceport `RelationshipReference` (no covering C# test): a plain pair of
// ONRs with structural record equality, used as the dedup key for relationships.
//
// Port decision: `relationshipReferenceKey` is the canonical string key, since a TS object in a
// Map compares by reference. It composes the two ONR keys around '@' - and, like the ONR key, it
// keeps an ellipsis relation rather than eliding it as the tuple string does.
const doc: ObjectAndRelation = { objectType: "document", objectId: "doc", relation: "viewer" };
const alice: ObjectAndRelation = { objectType: "user", objectId: "alice", relation: ELLIPSIS };

describe("relationship reference", () => {
  it("pairs a resource and a subject", () => {
    const ref: RelationshipReference = { resource: doc, subject: alice };

    expect(ref.resource).toEqual(doc);
    expect(ref.subject).toEqual(alice);
  });

  describe("relationshipReferenceKey", () => {
    it("composes the two ONR keys, keeping the ellipsis", () => {
      expect(relationshipReferenceKey({ resource: doc, subject: alice })).toBe(
        "document:doc#viewer@user:alice#...",
      );
    });

    it("distinguishes a subject relation from an ellipsis subject", () => {
      const withSubrelation = relationshipReferenceKey({
        resource: doc,
        subject: { objectType: "group", objectId: "g", relation: "member" },
      });

      expect(withSubrelation).toBe("document:doc#viewer@group:g#member");
      expect(withSubrelation).not.toBe(relationshipReferenceKey({ resource: doc, subject: alice }));
    });

    it("collapses structurally equal references to one Set entry", () => {
      const keys = new Set([
        relationshipReferenceKey({ resource: doc, subject: alice }),
        relationshipReferenceKey({ resource: { ...doc }, subject: { ...alice } }),
      ]);

      expect(keys.size).toBe(1);
    });

    it("does not confuse a resource and a subject that swap", () => {
      const forward = relationshipReferenceKey({ resource: doc, subject: alice });
      const reverse = relationshipReferenceKey({ resource: alice, subject: doc });

      expect(forward).not.toBe(reverse);
    });
  });

  describe("relationshipReferenceEquals", () => {
    it("is structural, matching C# record equality", () => {
      const a: RelationshipReference = { resource: doc, subject: alice };
      const b: RelationshipReference = { resource: { ...doc }, subject: { ...alice } };

      expect(relationshipReferenceEquals(a, b)).toBe(true);
      expect(relationshipReferenceEquals(a, { resource: doc, subject: doc })).toBe(false);
    });
  });
});
