import { describe, expect, it } from "vitest";

import {
  allowedRelationDirect,
  allowedRelationKindFromWire,
  allowedRelationKindToWire,
  allowedRelationWildcard,
  isAllowedRelationPublicWildcard,
  EXPIRATION_TRAIT,
  type AllowedCaveat,
  type AllowedRelation,
  type AllowedRelationKind,
  type TypeInformation,
} from "./allowed-relation";
import { ELLIPSIS } from "./core-constants";

// Characterization of Spiceport `AllowedRelation.cs` (no covering C# test).
//
// Port decisions pinned here:
//   * `AllowedRelationKind` mirrors the proto enum (Relation = 0, PublicWildcard = 1); the
//     string-literal union plus an explicit wire map keeps the numbers off declaration order.
//   * The two factories differ ASYMMETRICALLY and `allowed-relation-identity` depends on it:
//     `Direct` defaults the subrelation to the ellipsis, `Wildcard` leaves it ABSENT. That
//     asymmetry is the point of the first two cases below.
//   * `ExpirationTrait` is an empty C# record mirroring SpiceDB's empty proto message. An empty
//     TypeScript interface is structurally `any`, so the port brands it and exposes a single
//     frozen instance rather than letting every object satisfy the type.
const caveat: AllowedCaveat = { caveatName: "only_on_tuesday" };

describe("allowed relation", () => {
  describe("direct", () => {
    it("defaults the subrelation to the ellipsis", () => {
      const allowed = allowedRelationDirect("user");

      expect(allowed.relationName).toBe(ELLIPSIS);
      expect(allowed.objectType).toBe("user");
      expect(allowed.kind).toBe("relation");
      expect(allowed.requiredCaveat).toBeUndefined();
      expect(allowed.requiresExpiration).toBe(false);
    });

    it("keeps an explicit subrelation", () => {
      expect(allowedRelationDirect("team", "member").relationName).toBe("member");
    });

    it("carries a required caveat and the expiration flag", () => {
      const allowed = allowedRelationDirect("user", ELLIPSIS, caveat, true);

      expect(allowed.requiredCaveat).toEqual(caveat);
      expect(allowed.requiresExpiration).toBe(true);
    });

    it("is not a public wildcard", () => {
      expect(isAllowedRelationPublicWildcard(allowedRelationDirect("user"))).toBe(false);
    });
  });

  describe("wildcard", () => {
    // NOT the ellipsis: `Wildcard` passes null for the relation name, and the identity function
    // relies on that to pick the `type:*` shape.
    it("leaves the subrelation absent rather than defaulting it to the ellipsis", () => {
      const allowed = allowedRelationWildcard("user");

      expect(allowed.relationName).toBeUndefined();
      expect(allowed.relationName).not.toBe(ELLIPSIS);
      expect(allowed.objectType).toBe("user");
      expect(allowed.kind).toBe("publicWildcard");
      expect(allowed.requiredCaveat).toBeUndefined();
      expect(allowed.requiresExpiration).toBe(false);
    });

    it("carries a required caveat and the expiration flag", () => {
      const allowed = allowedRelationWildcard("user", caveat, true);

      expect(allowed.requiredCaveat).toEqual(caveat);
      expect(allowed.requiresExpiration).toBe(true);
    });

    it("is a public wildcard", () => {
      expect(isAllowedRelationPublicWildcard(allowedRelationWildcard("user"))).toBe(true);
    });
  });

  it("decides the wildcard flag from the kind alone, not from the relation name", () => {
    const odd: AllowedRelation = {
      objectType: "user",
      kind: "publicWildcard",
      relationName: "member",
      requiresExpiration: false,
    };

    expect(isAllowedRelationPublicWildcard(odd)).toBe(true);
  });

  describe("kind wire encoding", () => {
    it.each([
      ["relation", 0],
      ["publicWildcard", 1],
    ] as [AllowedRelationKind, number][])("maps %s to %i", (kind, wire) => {
      expect(allowedRelationKindToWire(kind)).toBe(wire);
      expect(allowedRelationKindFromWire(wire)).toBe(kind);
    });

    it("returns undefined for an unknown wire value", () => {
      expect(allowedRelationKindFromWire(2)).toBeUndefined();
    });
  });
});

describe("expiration trait", () => {
  it("is a single frozen instance, not an anonymous empty object", () => {
    expect(Object.isFrozen(EXPIRATION_TRAIT)).toBe(true);
    expect(EXPIRATION_TRAIT).toBe(EXPIRATION_TRAIT);
  });
});

describe("type information", () => {
  it("holds the allowed subject types in order", () => {
    const info: TypeInformation = {
      allowedDirectRelations: [
        allowedRelationDirect("user"),
        allowedRelationDirect("team", "member"),
        allowedRelationWildcard("user"),
      ],
    };

    expect(info.allowedDirectRelations.map((a) => a.objectType)).toEqual(["user", "team", "user"]);
  });

  it("accepts an empty list", () => {
    const info: TypeInformation = { allowedDirectRelations: [] };

    expect(info.allowedDirectRelations).toEqual([]);
  });
});
