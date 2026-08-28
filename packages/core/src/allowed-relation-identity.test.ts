import { describe, expect, it } from "vitest";

import {
  allowedRelationDirect,
  allowedRelationWildcard,
  type AllowedRelation,
} from "./allowed-relation";
import { allowedRelationSource } from "./allowed-relation-identity";
import { ELLIPSIS } from "./core-constants";

// Characterization of Spiceport `AllowedRelationIdentity` (no covering C# test), which mirrors
// SpiceDB's `schema.SourceForAllowedRelation` in `pkg/schema/definition.go`.
//
// The EXACT SPACING is the identity used for schema diffing and duplicate detection, so every
// literal below is load-bearing: `" with "` has a leading AND a trailing space, the conjunction
// is `" and "`, and the trait word is `"expiration"`. A change of caveat name or of the
// expiration trait is a genuine difference, not a no-op - the traits are never normalised away.
describe("allowed relation identity", () => {
  describe("shape", () => {
    it("renders a direct ellipsis subject as the bare type", () => {
      expect(allowedRelationSource(allowedRelationDirect("user"))).toBe("user");
    });

    it("renders a subrelation subject as type#relation", () => {
      expect(allowedRelationSource(allowedRelationDirect("team", "member"))).toBe("team#member");
    });

    it("renders a public wildcard as type:*", () => {
      expect(allowedRelationSource(allowedRelationWildcard("user"))).toBe("user:*");
    });

    it("checks the wildcard first: a wildcard never renders a subrelation", () => {
      const odd: AllowedRelation = {
        objectType: "user",
        kind: "publicWildcard",
        relationName: "member",
        requiresExpiration: false,
      };

      expect(allowedRelationSource(odd)).toBe("user:*");
    });

    it("treats an absent subrelation as the ellipsis", () => {
      const absent: AllowedRelation = {
        objectType: "user",
        kind: "relation",
        relationName: undefined,
        requiresExpiration: false,
      };

      expect(allowedRelationSource(absent)).toBe("user");
    });

    it("renders an explicit ellipsis identically to an absent one", () => {
      const explicit: AllowedRelation = {
        objectType: "user",
        kind: "relation",
        relationName: ELLIPSIS,
        requiresExpiration: false,
      };

      expect(allowedRelationSource(explicit)).toBe("user");
    });

    it("keeps path segments in the object type verbatim", () => {
      expect(allowedRelationSource(allowedRelationDirect("org/user"))).toBe("org/user");
    });
  });

  describe("traits", () => {
    const caveat = { caveatName: "only_on_tuesday" };

    it("appends a caveat with a leading and trailing space around 'with'", () => {
      expect(allowedRelationSource(allowedRelationDirect("user", ELLIPSIS, caveat))).toBe(
        "user with only_on_tuesday",
      );
    });

    it("appends the expiration trait alone", () => {
      expect(allowedRelationSource(allowedRelationDirect("user", ELLIPSIS, undefined, true))).toBe(
        "user with expiration",
      );
    });

    it("joins a caveat and the expiration trait with ' and ', caveat first", () => {
      expect(allowedRelationSource(allowedRelationDirect("user", ELLIPSIS, caveat, true))).toBe(
        "user with only_on_tuesday and expiration",
      );
    });

    it("appends traits after a subrelation", () => {
      expect(allowedRelationSource(allowedRelationDirect("team", "member", caveat, true))).toBe(
        "team#member with only_on_tuesday and expiration",
      );
    });

    it("appends traits after a wildcard", () => {
      expect(allowedRelationSource(allowedRelationWildcard("user", caveat, true))).toBe(
        "user:* with only_on_tuesday and expiration",
      );
    });

    it("appends nothing when there are no traits", () => {
      expect(allowedRelationSource(allowedRelationDirect("user", ELLIPSIS, undefined, false))).toBe(
        "user",
      );
    });
  });

  describe("as a diff and duplicate-detection key", () => {
    it("distinguishes a change of caveat name", () => {
      expect(
        allowedRelationSource(allowedRelationDirect("user", ELLIPSIS, { caveatName: "a" })),
      ).not.toBe(
        allowedRelationSource(allowedRelationDirect("user", ELLIPSIS, { caveatName: "b" })),
      );
    });

    it("distinguishes gaining the expiration trait", () => {
      expect(allowedRelationSource(allowedRelationDirect("user"))).not.toBe(
        allowedRelationSource(allowedRelationDirect("user", ELLIPSIS, undefined, true)),
      );
    });

    it("distinguishes a wildcard from a direct subject of the same type", () => {
      expect(allowedRelationSource(allowedRelationWildcard("user"))).not.toBe(
        allowedRelationSource(allowedRelationDirect("user")),
      );
    });

    it("collapses structurally identical allowed relations to one key", () => {
      const keys = new Set(
        [
          allowedRelationDirect("user"),
          allowedRelationDirect("user"),
          allowedRelationDirect("team", "member"),
        ].map(allowedRelationSource),
      );

      expect([...keys]).toEqual(["user", "team#member"]);
    });
  });
});
