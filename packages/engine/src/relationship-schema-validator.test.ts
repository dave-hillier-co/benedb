import { ELLIPSIS } from "@benedb/core/core-constants";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { UpdateOperation } from "@benedb/core/relationship-update";
import { compileSchema } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import {
  RelationshipTypeException,
  validateAllRelationships,
  validateRelationshipUpdates,
  type RelationshipTypeReason,
} from "./relationship-schema-validator";

/**
 * Pins the write-time relationship validation against SpiceDB's
 * `internal/relationships/validation.go` `ValidateOneRelationship`: its check ORDER (resource
 * definition, resource relation, subject definition, subject relation, permission, allowed type),
 * its messages, the reason each failure carries (which the gRPC front door maps to a status code),
 * and the relaxed DELETE rule that lets an uncaveated delete ignore caveats and expiration.
 */

const SCHEMA = compileSchema(`use expiration

definition user {}

definition group {
    relation member: user
}

caveat only_on_tuesday(day string) {
    day == "tuesday"
}

definition document {
    relation viewer: user | group#member
    relation caveated_viewer: user with only_on_tuesday
    relation expiring_viewer: user with expiration
    relation public_viewer: user:*
    permission view = viewer + caveated_viewer
}`);

function rel(
  resource: string,
  subject: string,
  options: { caveat?: string; expiration?: bigint } = {},
): Relationship {
  const [resType, resRest] = resource.split(":") as [string, string];
  const [resId, resRel] = resRest.split("#") as [string, string];
  const [subType, subRest] = subject.split(":") as [string, string];
  const [subId, subRel] = subRest.split("#") as [string, string | undefined];
  return createRelationship(
    { objectType: resType, objectId: resId, relation: resRel },
    { objectType: subType, objectId: subId, relation: subRel ?? ELLIPSIS },
    options.caveat !== undefined ? { caveatName: options.caveat } : undefined,
    options.expiration,
  );
}

function failure(run: () => void): { reason: RelationshipTypeReason; message: string } {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RelationshipTypeException);
    const typed = error as RelationshipTypeException;
    return { reason: typed.reason, message: typed.message };
  }
  throw new Error("expected a RelationshipTypeException");
}

function write(relationship: Relationship, operation: UpdateOperation = "touch"): () => void {
  return () => validateRelationshipUpdates(SCHEMA, [{ relationship, operation }]);
}

describe("validateRelationshipUpdates", () => {
  it("accepts a relationship the schema allows", () => {
    expect(write(rel("document:readme#viewer", "user:alice"))).not.toThrow();
    expect(write(rel("document:readme#viewer", "group:eng#member"))).not.toThrow();
    expect(write(rel("document:readme#public_viewer", "user:*"))).not.toThrow();
    expect(
      write(rel("document:readme#caveated_viewer", "user:alice", { caveat: "only_on_tuesday" })),
    ).not.toThrow();
    expect(
      write(rel("document:readme#expiring_viewer", "user:alice", { expiration: 1n })),
    ).not.toThrow();
  });

  it("rejects an unknown resource definition as an unknown definition", () => {
    expect(failure(write(rel("folder:root#viewer", "user:alice")))).toEqual({
      reason: "unknownDefinition",
      message: "object definition `folder` not found",
    });
  });

  it("rejects an unknown resource relation as an unknown relation", () => {
    expect(failure(write(rel("document:readme#editor", "user:alice")))).toEqual({
      reason: "unknownRelation",
      message: "relation/permission `editor` not found under definition `document`",
    });
  });

  it("rejects an unknown subject definition as an unknown definition", () => {
    expect(failure(write(rel("document:readme#viewer", "team:eng")))).toEqual({
      reason: "unknownDefinition",
      message: "object definition `team` not found",
    });
  });

  it("rejects an unknown subject relation as an unknown relation", () => {
    expect(failure(write(rel("document:readme#viewer", "group:eng#admin")))).toEqual({
      reason: "unknownRelation",
      message: "relation/permission `admin` not found under definition `group`",
    });
  });

  it("rejects a write to a permission with SpiceDB's permission message", () => {
    expect(failure(write(rel("document:readme#view", "user:alice")))).toEqual({
      reason: "cannotWriteToPermission",
      message: "cannot write a relationship to permission `view` under definition `document`",
    });
  });

  it("rejects a disallowed subject type, describing the subject's subrelation", () => {
    expect(failure(write(rel("document:readme#public_viewer", "group:eng#member")))).toEqual({
      reason: "invalidSubjectType",
      message:
        "subjects of type `group#member` are not allowed on relation `document#public_viewer`",
    });
  });

  it("names the required caveats when only a caveated form is allowed", () => {
    expect(failure(write(rel("document:readme#caveated_viewer", "user:alice")))).toEqual({
      reason: "invalidSubjectType",
      message:
        "subjects of type `user` are not allowed on relation `document#caveated_viewer` " +
        "without one of the following caveats: only_on_tuesday",
    });
  });

  it("rejects a caveat the relation does not allow", () => {
    expect(
      failure(write(rel("document:readme#viewer", "user:alice", { caveat: "only_on_tuesday" }))),
    ).toEqual({
      reason: "invalidSubjectType",
      message:
        "subjects of type `user with only_on_tuesday` are not allowed on relation `document#viewer`",
    });
  });

  it("rejects an expiration on a relation without the expiration trait", () => {
    expect(failure(write(rel("document:readme#viewer", "user:alice", { expiration: 1n })))).toEqual(
      {
        reason: "invalidSubjectType",
        message:
          "subjects of type `user with expiration` are not allowed on relation `document#viewer`",
      },
    );
  });

  it("suggests the closest allowed type when the written one is a fuzzy match", () => {
    expect(failure(write(rel("document:readme#expiring_viewer", "user:alice")))).toEqual({
      reason: "invalidSubjectType",
      message:
        "subjects of type `user` are not allowed on relation `document#expiring_viewer`; " +
        "did you mean `user with expiration`?",
    });
  });

  it("rejects a wildcard subject on a relation that does not allow one", () => {
    expect(failure(write(rel("document:readme#viewer", "user:*")))).toEqual({
      reason: "invalidSubjectType",
      message: "subjects of type `user:*` are not allowed on relation `document#viewer`",
    });
  });

  it("validates every update, reporting the first failure", () => {
    const run = (): void =>
      validateRelationshipUpdates(SCHEMA, [
        { relationship: rel("document:readme#viewer", "user:alice"), operation: "create" },
        { relationship: rel("folder:root#viewer", "user:alice"), operation: "create" },
      ]);

    expect(failure(run).message).toBe("object definition `folder` not found");
  });

  describe("deletes", () => {
    it("let an uncaveated delete ignore a required caveat", () => {
      expect(write(rel("document:readme#caveated_viewer", "user:alice"), "delete")).not.toThrow();
    });

    it("let an uncaveated delete ignore the expiration trait", () => {
      expect(write(rel("document:readme#expiring_viewer", "user:alice"), "delete")).not.toThrow();
    });

    it("still reject a subject type the relation never allows", () => {
      expect(
        failure(write(rel("document:readme#public_viewer", "group:eng#member"), "delete")),
      ).toEqual({
        reason: "invalidSubjectType",
        message:
          "subjects of type `group#member` are not allowed on relation `document#public_viewer`",
      });
    });

    it("still reject a wildcard on a relation that allows no wildcard", () => {
      expect(failure(write(rel("document:readme#viewer", "user:*"), "delete")).reason).toBe(
        "invalidSubjectType",
      );
    });

    it("hold a caveated delete to the exact allowed type", () => {
      expect(
        failure(
          write(
            rel("document:readme#viewer", "user:alice", { caveat: "only_on_tuesday" }),
            "delete",
          ),
        ).reason,
      ).toBe("invalidSubjectType");
    });

    it("still reject an unknown definition or a permission", () => {
      expect(failure(write(rel("folder:root#viewer", "user:alice"), "delete")).reason).toBe(
        "unknownDefinition",
      );
      expect(failure(write(rel("document:readme#view", "user:alice"), "delete")).reason).toBe(
        "cannotWriteToPermission",
      );
    });
  });
});

describe("validateAllRelationships", () => {
  it("applies the create-or-touch rule to every relationship", () => {
    expect(
      failure(() =>
        validateAllRelationships(SCHEMA, [rel("document:readme#caveated_viewer", "user:alice")]),
      ).reason,
    ).toBe("invalidSubjectType");
  });
});
