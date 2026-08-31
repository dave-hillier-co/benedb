import { ELLIPSIS } from "@benedb/core/core-constants";
import { createRelationship } from "@benedb/core/relationship";
import type { RelationshipsFilter } from "@benedb/datastore/relationships-filter";
import { describe, expect, it } from "vitest";

import type { FullRelationshipsFilterWire } from "./datastore-dtos";
import type { RelationshipUpdateWire, RelationshipWire } from "./relationships-dtos";
import {
  toCoreFilter,
  toFullFilter,
  toRelationship,
  toUpdate,
  toWire,
  toWriteUpdate,
} from "./wire-convert";

/**
 * NO COVERING C# TEST. `WireConvert` is exercised in Spiceport only through the fold suites, which
 * use it to BUILD their fixtures - that is not coverage. These are characterization tests written
 * from `src/Spiceport.Server/Grains/WireConvert.cs`, and they are the only gate on the shared
 * payload conversion that all three folds normalise through.
 *
 * What is load-bearing here:
 *   * `toRelationship` NORMALISES an empty subject relation to the ellipsis and an empty caveat
 *     name to "no caveat". `ShardFold` deliberately round-trips every payload through
 *     `toWire(toRelationship(x))` so its restricted rows compare equal to the whole fold's; that
 *     double conversion is only sound if the normalisation is IDEMPOTENT, which is pinned below.
 *   * `toUpdate` and `toWriteUpdate` are DELIBERATELY DIFFERENT: the log/Watch form collapses
 *     Create to Touch (a committed event only ever carries the resolved Touch/Delete), while the
 *     write-request form preserves Create so the create-conflict check can fire. Two distinctly
 *     named functions, never one with a flag - so both are pinned separately.
 *   * `toWire` DROPS `optionalIntegrity` on purpose: the wire type carries no integrity field.
 *   * The C# option converters switch on an `int` with a TOLERANT default (`None`), so an unknown
 *     wire number must map to "none" rather than throwing.
 *   * Expiration is a `bigint` nanos-since-epoch value on BOTH sides, so that conversion is now the
 *     identity - the C#'s `DateTimeOffset` <-> nanos step (and `ShardFold`'s `NanosSinceEpoch`
 *     helper with it) has vanished from the port.
 */
describe("wire convert", () => {
  const wire: RelationshipWire = {
    resourceType: "document",
    resourceId: "d1",
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: ELLIPSIS,
  };

  describe("toRelationship", () => {
    it("normalises an empty subject relation to the ellipsis", () => {
      const rel = toRelationship({ ...wire, subjectRelation: "" });

      expect(rel.reference.subject.relation).toBe(ELLIPSIS);
    });

    it("keeps a non-empty subject relation verbatim", () => {
      const rel = toRelationship({ ...wire, subjectRelation: "member" });

      expect(rel.reference.subject.relation).toBe("member");
    });

    it("carries the resource and subject fields across unchanged", () => {
      const rel = toRelationship(wire);

      expect(rel.reference.resource).toEqual({
        objectType: "document",
        objectId: "d1",
        relation: "viewer",
      });
      expect(rel.reference.subject).toEqual({
        objectType: "user",
        objectId: "alice",
        relation: ELLIPSIS,
      });
    });

    it.each([[undefined], [""]])("maps a caveat name of %s to no caveat", (caveatName) => {
      const rel = toRelationship({
        ...wire,
        caveatName,
        caveatContext: new Map<string, unknown>([["level", 3]]),
      });

      expect(rel.optionalCaveat).toBeUndefined();
    });

    it("carries a named caveat with its context", () => {
      const context = new Map<string, unknown>([["level", 3]]);

      const rel = toRelationship({ ...wire, caveatName: "is_active", caveatContext: context });

      expect(rel.optionalCaveat?.caveatName).toBe("is_active");
      expect(rel.optionalCaveat?.context).toBe(context);
    });

    it("carries the expiration nanos unchanged (the conversion is now the identity)", () => {
      const rel = toRelationship({ ...wire, expiration: 1_893_456_000_123_456_789n });

      expect(rel.optionalExpiration).toBe(1_893_456_000_123_456_789n);
    });
  });

  describe("toWire", () => {
    it("drops the integrity metadata on purpose", () => {
      const rel = createRelationship(
        { objectType: "document", objectId: "d1", relation: "viewer" },
        { objectType: "user", objectId: "alice", relation: ELLIPSIS },
        undefined,
        undefined,
        { keyId: "k1", hash: new Uint8Array([1, 2, 3]), hashedAt: 5n },
      );

      const back = toWire(rel);

      expect(back).toEqual(wire);
      expect(Object.values(back)).not.toContain(rel.optionalIntegrity);
    });

    it("emits an absent caveat name and context for an uncaveated relationship", () => {
      const back = toWire(toRelationship(wire));

      expect(back.caveatName).toBeUndefined();
      expect(back.caveatContext).toBeUndefined();
    });
  });

  describe("the normalising round trip ShardFold relies on", () => {
    it("normalises an empty subject relation and an empty caveat name", () => {
      const back = toWire(toRelationship({ ...wire, subjectRelation: "", caveatName: "" }));

      expect(back.subjectRelation).toBe(ELLIPSIS);
      expect(back.caveatName).toBeUndefined();
    });

    it("is IDEMPOTENT: a second round trip changes nothing", () => {
      const once = toWire(toRelationship({ ...wire, subjectRelation: "", caveatName: "" }));
      const twice = toWire(toRelationship(once));

      expect(twice).toEqual(once);
    });

    it("collapses the wire and normalised spellings of the ellipsis to one payload", () => {
      const asEmpty = toWire(toRelationship({ ...wire, subjectRelation: "" }));
      const asEllipsis = toWire(toRelationship({ ...wire, subjectRelation: ELLIPSIS }));

      expect(asEmpty).toEqual(asEllipsis);
    });

    it("preserves the caveat, its context and the expiration through the round trip", () => {
      const context = new Map<string, unknown>([["level", 3]]);
      const source: RelationshipWire = {
        ...wire,
        caveatName: "is_active",
        caveatContext: context,
        expiration: 1_893_456_000_123_456_789n,
      };

      const back = toWire(toRelationship(source));

      expect(back).toEqual(source);
    });
  });

  describe("toUpdate (the log / Watch form)", () => {
    const relationship = wire;

    it.each([
      ["touch", "touch"],
      ["create", "touch"],
      ["delete", "delete"],
    ] as const)("maps a %s to %s", (operation, expected) => {
      const update: RelationshipUpdateWire = { operation, relationship };

      expect(toUpdate(update).operation).toBe(expected);
    });

    it("normalises the payload exactly as toRelationship does", () => {
      const update: RelationshipUpdateWire = {
        operation: "touch",
        relationship: { ...wire, subjectRelation: "" },
      };

      expect(toUpdate(update).relationship.reference.subject.relation).toBe(ELLIPSIS);
    });
  });

  describe("toWriteUpdate (the write-request form)", () => {
    const relationship = wire;

    it.each([
      ["touch", "touch"],
      ["create", "create"],
      ["delete", "delete"],
    ] as const)("PRESERVES a %s as %s", (operation, expected) => {
      const update: RelationshipUpdateWire = { operation, relationship };

      expect(toWriteUpdate(update).operation).toBe(expected);
    });

    it("differs from toUpdate on exactly the Create case", () => {
      const update: RelationshipUpdateWire = { operation: "create", relationship };

      expect(toUpdate(update).operation).toBe("touch");
      expect(toWriteUpdate(update).operation).toBe("create");
    });
  });

  describe("full filter conversion", () => {
    const full: FullRelationshipsFilterWire = {
      optionalResourceType: "document",
      optionalResourceIds: ["d1", "d2"],
      optionalResourceIdPrefix: "d",
      optionalResourceRelation: "viewer",
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: "user",
          optionalSubjectIds: ["alice", "bob"],
          relationFilter: {
            nonEllipsisRelation: "member",
            includeEllipsisRelation: true,
            onlyNonEllipsisRelations: false,
          },
        },
      ],
      optionalCaveatNameFilter: { option: 1, caveatName: "is_active" },
      optionalExpirationOption: 2,
    };

    it("round-trips a fully populated filter", () => {
      expect(toFullFilter(toCoreFilter(full))).toEqual(full);
    });

    it("maps the caveat and expiration options through their names", () => {
      const core = toCoreFilter(full);

      expect(core.optionalCaveatNameFilter?.option).toBe("hasMatchingCaveat");
      expect(core.optionalExpirationOption).toBe("noExpiration");
    });

    it("propagates an absent selector list and caveat filter as absent, never as empty", () => {
      const sparse: FullRelationshipsFilterWire = { optionalExpirationOption: 0 };

      const core = toCoreFilter(sparse);

      expect(core.optionalSubjectsSelectors).toBeUndefined();
      expect(core.optionalCaveatNameFilter).toBeUndefined();
      expect(core.optionalExpirationOption).toBe("none");
      expect(toFullFilter(core)).toEqual(sparse);
    });

    it("keeps an EMPTY selector list distinct from an absent one", () => {
      const empty: FullRelationshipsFilterWire = {
        optionalSubjectsSelectors: [],
        optionalExpirationOption: 0,
      };

      expect(toCoreFilter(empty).optionalSubjectsSelectors).toEqual([]);
    });

    it("propagates an absent subject id list and relation filter within a selector", () => {
      const core = toCoreFilter({
        optionalSubjectsSelectors: [{ optionalSubjectType: "user" }],
        optionalExpirationOption: 0,
      });

      expect(core.optionalSubjectsSelectors?.[0]?.optionalSubjectIds).toBeUndefined();
      expect(core.optionalSubjectsSelectors?.[0]?.relationFilter).toBeUndefined();
    });

    // The C# switches on an int with a TOLERANT default arm, so an unrecognised wire number is
    // "no constraint" rather than a throw: a newer client's enum value must never fail a fold.
    it.each([[-1], [3], [99]])("maps the unknown caveat option %i to none", (option) => {
      const core = toCoreFilter({
        optionalCaveatNameFilter: { option },
        optionalExpirationOption: 0,
      });

      expect(core.optionalCaveatNameFilter?.option).toBe("none");
    });

    it.each([[-1], [3], [99]])("maps the unknown expiration option %i to none", (option) => {
      expect(toCoreFilter({ optionalExpirationOption: option }).optionalExpirationOption).toBe(
        "none",
      );
    });

    it("defaults an absent core expiration option to the wire's none (0)", () => {
      const core: RelationshipsFilter = { optionalResourceType: "document" };

      expect(toFullFilter(core).optionalExpirationOption).toBe(0);
    });
  });
});
