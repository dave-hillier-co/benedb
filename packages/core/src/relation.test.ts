import { describe, expect, it } from "vitest";

import { allowedRelationDirect, allowedRelationWildcard } from "./allowed-relation";
import { baseRelation, isPermission, permission, type Relation } from "./relation";
import {
  computedUsersetOnResource,
  setOperationUnion,
  type UsersetRewrite,
} from "./userset-rewrite";

// Characterization of Spiceport `Relation` (no covering C# test). `NamespaceDefinition`, declared
// in the same C# file, gets its own module under the no-barrels rule; see
// `namespace-definition.test.ts`.
//
// The load-bearing definition here is `IsPermission => UsersetRewrite is not null`: a permission
// is EXACTLY a relation that has a rewrite. The DSL compiler relies on that equivalence, so these
// cases pin it in both directions rather than testing a separate flag.
const viewRewrite: UsersetRewrite = {
  operation: setOperationUnion({
    kind: "computedUserset",
    value: computedUsersetOnResource("editor"),
  }),
};

describe("relation", () => {
  describe("base relation", () => {
    it("collects allowed subject types into type information, in order", () => {
      const relation = baseRelation(
        "viewer",
        allowedRelationDirect("user"),
        allowedRelationWildcard("user"),
      );

      expect(relation.name).toBe("viewer");
      expect(relation.typeInformation?.allowedDirectRelations).toEqual([
        allowedRelationDirect("user"),
        allowedRelationWildcard("user"),
      ]);
    });

    it("has no userset rewrite, so it is not a permission", () => {
      const relation = baseRelation("viewer", allowedRelationDirect("user"));

      expect(relation.usersetRewrite).toBeUndefined();
      expect(isPermission(relation)).toBe(false);
    });

    it("still builds type information when given no allowed types", () => {
      // The C# `params` array is empty, not absent: `TypeInformation` is always constructed.
      const relation = baseRelation("viewer");

      expect(relation.typeInformation).toEqual({ allowedDirectRelations: [] });
    });
  });

  describe("permission", () => {
    it("carries the rewrite and reports itself as a permission", () => {
      const relation = permission("view", viewRewrite);

      expect(relation.name).toBe("view");
      expect(relation.usersetRewrite).toBe(viewRewrite);
      expect(isPermission(relation)).toBe(true);
    });

    it("carries no type information", () => {
      expect(permission("view", viewRewrite).typeInformation).toBeUndefined();
    });
  });

  describe("is permission", () => {
    it("is decided solely by the presence of a rewrite", () => {
      const withBoth: Relation = {
        name: "odd",
        usersetRewrite: viewRewrite,
        typeInformation: { allowedDirectRelations: [allowedRelationDirect("user")] },
      };

      expect(isPermission(withBoth)).toBe(true);
    });

    it("is false for a relation with neither a rewrite nor type information", () => {
      expect(isPermission({ name: "bare" })).toBe(false);
    });
  });

  describe("carried-forward fields", () => {
    // Unused by the S1 compiler, but they must exist so later stages can populate them.
    it("leaves the aliasing relation and canonical cache key unset by default", () => {
      const relation = baseRelation("viewer", allowedRelationDirect("user"));

      expect(relation.aliasingRelation).toBeUndefined();
      expect(relation.canonicalCacheKey).toBeUndefined();
    });

    it("accepts an aliasing relation and a canonical cache key", () => {
      const relation: Relation = {
        name: "view",
        usersetRewrite: viewRewrite,
        aliasingRelation: "editor",
        canonicalCacheKey: "cache-key",
      };

      expect(relation.aliasingRelation).toBe("editor");
      expect(relation.canonicalCacheKey).toBe("cache-key");
    });
  });
});
