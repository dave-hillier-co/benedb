import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "./core-constants";
import type { ObjectAndRelation } from "./object-and-relation";
import { createRelationship } from "./relationship";
import {
  updateOperationFromWire,
  updateOperationToWire,
  type RelationshipUpdate,
  type UpdateOperation,
} from "./relationship-update";

// Characterization of Spiceport `RelationshipUpdate` and `UpdateOperation` (no covering C# test).
//
// Port decision: the C# enum has EXPLICIT values - Touch = 0, Create = 1, Delete = 2 - and those
// numbers are what cross the wire. The port uses a string-literal union (house style) plus an
// explicit bidirectional map, so nothing depends on declaration order. Renumbering the map is a
// wire break; that is what these tests exist to catch.
const doc: ObjectAndRelation = { objectType: "document", objectId: "doc", relation: "viewer" };
const alice: ObjectAndRelation = { objectType: "user", objectId: "alice", relation: ELLIPSIS };

describe("relationship update", () => {
  it("pairs a relationship with an operation", () => {
    const update: RelationshipUpdate = {
      relationship: createRelationship(doc, alice),
      operation: "touch",
    };

    expect(update.operation).toBe("touch");
    expect(update.relationship.reference.resource).toEqual(doc);
  });

  describe("wire encoding", () => {
    it.each([
      ["touch", 0],
      ["create", 1],
      ["delete", 2],
    ] as [UpdateOperation, number][])("maps %s to %i", (operation, wire) => {
      expect(updateOperationToWire(operation)).toBe(wire);
    });

    it.each([
      [0, "touch"],
      [1, "create"],
      [2, "delete"],
    ] as [number, UpdateOperation][])("maps %i back to %s", (wire, operation) => {
      expect(updateOperationFromWire(wire)).toBe(operation);
    });

    it("round-trips every operation", () => {
      const operations: UpdateOperation[] = ["touch", "create", "delete"];

      for (const operation of operations) {
        expect(updateOperationFromWire(updateOperationToWire(operation))).toBe(operation);
      }
    });

    it("yields undefined for an unknown wire value rather than guessing", () => {
      expect(updateOperationFromWire(3)).toBeUndefined();
      expect(updateOperationFromWire(-1)).toBeUndefined();
    });
  });
});
