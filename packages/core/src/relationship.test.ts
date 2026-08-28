import { describe, expect, it } from "vitest";

import { ELLIPSIS, PUBLIC_WILDCARD } from "./core-constants";
import { InvalidArgumentError } from "./invalid-argument-error";
import type { ObjectAndRelation } from "./object-and-relation";
import {
  createRelationship,
  relationshipEquals,
  validateRelationship,
  withCaveat,
  withoutIntegrity,
  type Relationship,
} from "./relationship";
import type { RelationshipIntegrity } from "./relationship-integrity";

// Characterization of Spiceport `Relationship` (no covering C# test).
//
// Port decisions pinned here:
//
// 1. `DateTimeOffset? OptionalExpiration` becomes NANOSECONDS SINCE THE UNIX EPOCH as a
//    `bigint`, decided once at this value type and reused for `RelationshipIntegrity.hashedAt`.
//    Rationale: the tuple-string format emits 7 fractional digits (100ns ticks), so a
//    millisecond `number` (or a `Date`) cannot round-trip what Spiceport writes; nanosecond
//    values exceed 2^53; and `TimestampRevision` already carries `long TimestampNanosSinceEpoch`,
//    so nanoseconds are already this port's time currency.
//
// 2. `Validate()` throws `ArgumentException`. The port throws `InvalidArgumentError` - one class,
//    reused wherever Spiceport throws `ArgumentException`, mapped to gRPC InvalidArgument at the
//    API layer. The check ORDER and the exact messages are wire-visible and are pinned below.
//
// 3. `string.IsNullOrEmpty` is `=== undefined || === ""`. Whitespace is NOT empty.
//
// 4. `with` expressions return fresh values; `withCaveat`/`withoutIntegrity` never mutate.
const doc: ObjectAndRelation = { objectType: "document", objectId: "doc", relation: "viewer" };
const alice: ObjectAndRelation = { objectType: "user", objectId: "alice", relation: ELLIPSIS };
const integrity: RelationshipIntegrity = {
  keyId: "k",
  hash: new Uint8Array([1, 2, 3]),
  hashedAt: 0n,
};

describe("relationship", () => {
  describe("createRelationship", () => {
    it("wraps the resource and subject in a reference and defaults the rest", () => {
      const rel = createRelationship(doc, alice);

      expect(rel.reference).toEqual({ resource: doc, subject: alice });
      expect(rel.optionalCaveat).toBeUndefined();
      expect(rel.optionalExpiration).toBeUndefined();
      expect(rel.optionalIntegrity).toBeUndefined();
    });

    it("carries the optional caveat, expiration and integrity through", () => {
      const expiration = BigInt(Date.UTC(2023, 11, 1)) * 1_000_000n;
      const rel = createRelationship(doc, alice, { caveatName: "cav" }, expiration, integrity);

      expect(rel.optionalCaveat).toEqual({ caveatName: "cav" });
      expect(rel.optionalExpiration).toBe(expiration);
      expect(rel.optionalIntegrity).toBe(integrity);
    });
  });

  describe("withoutIntegrity", () => {
    it("returns a copy with the integrity dropped and leaves the original alone", () => {
      const rel = createRelationship(doc, alice, undefined, undefined, integrity);
      const stripped = withoutIntegrity(rel);

      expect(stripped.optionalIntegrity).toBeUndefined();
      expect(stripped.reference).toEqual(rel.reference);
      expect(rel.optionalIntegrity).toBe(integrity);
      expect(stripped).not.toBe(rel);
    });
  });

  describe("withCaveat", () => {
    it("replaces the caveat without touching the original", () => {
      const rel = createRelationship(doc, alice, { caveatName: "first" });
      const replaced = withCaveat(rel, { caveatName: "second" });

      expect(replaced.optionalCaveat).toEqual({ caveatName: "second" });
      expect(rel.optionalCaveat).toEqual({ caveatName: "first" });
    });

    it("removes the caveat when given undefined", () => {
      const rel = createRelationship(doc, alice, { caveatName: "first" });

      expect(withCaveat(rel, undefined).optionalCaveat).toBeUndefined();
    });

    it("preserves expiration and integrity", () => {
      const expiration = 1n;
      const rel = createRelationship(doc, alice, undefined, expiration, integrity);
      const withOne = withCaveat(rel, { caveatName: "cav" });

      expect(withOne.optionalExpiration).toBe(expiration);
      expect(withOne.optionalIntegrity).toBe(integrity);
    });
  });

  describe("validateRelationship", () => {
    it("accepts a fully specified relationship", () => {
      expect(() => validateRelationship(createRelationship(doc, alice))).not.toThrow();
    });

    it("accepts a wildcard subject", () => {
      const wildcard = { ...alice, objectId: PUBLIC_WILDCARD };

      expect(() => validateRelationship(createRelationship(doc, wildcard))).not.toThrow();
    });

    it.each([
      ["resource type", { ...doc, objectType: "" }],
      ["resource id", { ...doc, objectId: "" }],
      ["resource relation", { ...doc, relation: "" }],
    ])("rejects an empty %s", (_name, resource) => {
      expect(() => validateRelationship(createRelationship(resource, alice))).toThrow(
        new InvalidArgumentError("relationship resource must be fully specified"),
      );
    });

    it.each([
      ["subject type", { ...alice, objectType: "" }],
      ["subject id", { ...alice, objectId: "" }],
      ["subject relation", { ...alice, relation: "" }],
    ])("rejects an empty %s", (_name, subject) => {
      expect(() => validateRelationship(createRelationship(doc, subject))).toThrow(
        new InvalidArgumentError("relationship subject must be fully specified"),
      );
    });

    it("rejects a wildcard resource object id", () => {
      const wildcardResource = { ...doc, objectId: PUBLIC_WILDCARD };

      expect(() => validateRelationship(createRelationship(wildcardResource, alice))).toThrow(
        new InvalidArgumentError("relationship resource object id may not be a wildcard '*'"),
      );
    });

    it("checks the resource before the subject", () => {
      // Both halves are broken; the resource message is the one that surfaces.
      const rel = createRelationship({ ...doc, objectType: "" }, { ...alice, objectType: "" });

      expect(() => validateRelationship(rel)).toThrow(
        "relationship resource must be fully specified",
      );
    });

    it("checks subject emptiness before the resource wildcard", () => {
      // The C# order is resource-specified, subject-specified, resource-not-wildcard.
      const rel = createRelationship(
        { ...doc, objectId: PUBLIC_WILDCARD },
        { ...alice, objectId: "" },
      );

      expect(() => validateRelationship(rel)).toThrow(
        "relationship subject must be fully specified",
      );
    });

    it("treats whitespace as specified: IsNullOrEmpty is not IsNullOrWhiteSpace", () => {
      const rel = createRelationship({ ...doc, objectId: " " }, alice);

      expect(() => validateRelationship(rel)).not.toThrow();
    });

    it("throws InvalidArgumentError, the port's stand-in for ArgumentException", () => {
      expect(() =>
        validateRelationship(createRelationship({ ...doc, objectType: "" }, alice)),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe("relationshipEquals", () => {
    it("is structural over the reference, caveat, expiration and integrity", () => {
      const a = createRelationship(doc, alice, { caveatName: "cav" }, 5n, integrity);
      const b = createRelationship({ ...doc }, { ...alice }, { caveatName: "cav" }, 5n, {
        keyId: "k",
        hash: new Uint8Array([1, 2, 3]),
        hashedAt: 0n,
      });

      expect(relationshipEquals(a, b)).toBe(true);
    });

    it("distinguishes each component", () => {
      const base: Relationship = createRelationship(doc, alice, { caveatName: "cav" }, 5n);

      expect(relationshipEquals(base, createRelationship(doc, alice, { caveatName: "cav" }))).toBe(
        false,
      );
      expect(relationshipEquals(base, createRelationship(doc, alice, undefined, 5n))).toBe(false);
      expect(
        relationshipEquals(
          base,
          createRelationship({ ...doc, objectId: "other" }, alice, { caveatName: "cav" }, 5n),
        ),
      ).toBe(false);
      expect(
        relationshipEquals(base, createRelationship(doc, alice, { caveatName: "cav" }, 6n)),
      ).toBe(false);
    });
  });
});
