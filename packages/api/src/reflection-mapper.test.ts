import type { AllowedRelation } from "@spacedb/core/allowed-relation";
import { allowedRelationDirect, allowedRelationWildcard } from "@spacedb/core/allowed-relation";
import type { CaveatDefinition, CaveatTypeReference } from "@spacedb/core/caveat-definition";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import { createNamespaceDefinition } from "@spacedb/core/namespace-definition";
import { baseRelation, permission } from "@spacedb/core/relation";
import { setOperationUnion } from "@spacedb/core/userset-rewrite";
import { describe, expect, it } from "vitest";

import {
  caveatTypeString,
  reflectionCaveat,
  reflectionCaveatParameter,
  reflectionDefinition,
  reflectionPermission,
  reflectionRelation,
  reflectionTypeReference,
} from "./reflection-mapper";

/**
 * Characterization test for `src/Spiceport.Api/ReflectionMapper.cs`.
 *
 * The C# has NO direct suite: it is exercised only through the ReflectSchema/DiffSchema cases in
 * `AuthzedSchemaV1ServiceTests.cs`. Everything this file pins is wire-visible, because the mapper's
 * output IS the response body:
 *
 *   * the three-way `typeref` oneof branch (lines 64-69) is ORDERED and EXCLUSIVE - wildcard wins,
 *     then a non-ellipsis relation name, else terminal - and an ellipsis subrelation is TERMINAL;
 *   * `comment` is always the empty string, never absent, on every message;
 *   * caveat parameters are ordered by an ORDINAL comparison of the parameter name (line 94), which
 *     is not the same order `localeCompare` produces;
 *   * the caveat expression is a UTF-8 decode of the stored bytes (line 91), so non-ASCII CEL string
 *     literals survive;
 *   * `TypeString` joins child types with ", " (comma-space) and treats an absent and an empty child
 *     list identically.
 */

const anyRewrite = { operation: setOperationUnion({ kind: "this" as const }) };

describe("reflectionDefinition", () => {
  it("splits relations and permissions, preserving source order within each list", () => {
    const def = createNamespaceDefinition(
      "document",
      baseRelation("writer", allowedRelationDirect("user")),
      permission("edit", anyRewrite),
      baseRelation("reader", allowedRelationDirect("user")),
      permission("view", anyRewrite),
    );

    const result = reflectionDefinition(def);

    expect(result.name).toBe("document");
    expect(result.relations.map((r) => r.name)).toEqual(["writer", "reader"]);
    expect(result.permissions.map((p) => p.name)).toEqual(["edit", "view"]);
  });

  it("emits an empty comment, not an absent one", () => {
    const result = reflectionDefinition(createNamespaceDefinition("user"));

    expect(result.comment).toBe("");
    expect(result.relations).toEqual([]);
    expect(result.permissions).toEqual([]);
  });

  it("stamps the parent definition name onto every relation and permission", () => {
    const def = createNamespaceDefinition(
      "document",
      baseRelation("viewer", allowedRelationDirect("user")),
      permission("view", anyRewrite),
    );

    const result = reflectionDefinition(def);

    expect(result.relations[0]?.parentDefinitionName).toBe("document");
    expect(result.permissions[0]?.parentDefinitionName).toBe("document");
  });
});

describe("reflectionRelation", () => {
  it("maps every allowed direct relation to a subject type, in order", () => {
    const relation = baseRelation(
      "viewer",
      allowedRelationDirect("user"),
      allowedRelationDirect("group", "member"),
      allowedRelationWildcard("user"),
    );

    const result = reflectionRelation("document", relation);

    expect(result.name).toBe("viewer");
    expect(result.comment).toBe("");
    expect(result.parentDefinitionName).toBe("document");
    expect(result.subjectTypes.map((t) => t.subjectDefinitionName)).toEqual([
      "user",
      "group",
      "user",
    ]);
  });

  it("emits no subject types when the relation carries no type information", () => {
    const result = reflectionRelation("document", { name: "viewer" });

    expect(result.subjectTypes).toEqual([]);
  });
});

describe("reflectionTypeReference", () => {
  it("takes the terminal branch for an ellipsis subrelation", () => {
    const result = reflectionTypeReference(allowedRelationDirect("user", ELLIPSIS));

    expect(result.subjectDefinitionName).toBe("user");
    expect(result.isTerminalSubject).toBe(true);
    expect(result.optionalRelationName).toBeUndefined();
    expect(result.isPublicWildcard).toBeUndefined();
  });

  it("takes the terminal branch when the subrelation is absent", () => {
    const allowed: AllowedRelation = {
      objectType: "user",
      kind: "relation",
      relationName: undefined,
      requiresExpiration: false,
    };

    const result = reflectionTypeReference(allowed);

    expect(result.isTerminalSubject).toBe(true);
    expect(result.optionalRelationName).toBeUndefined();
  });

  it("sets the relation name for a non-ellipsis subrelation", () => {
    const result = reflectionTypeReference(allowedRelationDirect("group", "member"));

    expect(result.subjectDefinitionName).toBe("group");
    expect(result.optionalRelationName).toBe("member");
    expect(result.isTerminalSubject).toBeUndefined();
    expect(result.isPublicWildcard).toBeUndefined();
  });

  it("treats an EMPTY subrelation as relation-scoped, not terminal", () => {
    // The C# test is `allowed.RelationName is { } rel` - a null test, not a truthiness test. An
    // empty string is not null, so it sets `optional_relation_name` to "" and the oneof case is
    // optional_relation_name, NOT is_terminal_subject.
    const allowed: AllowedRelation = {
      objectType: "user",
      kind: "relation",
      relationName: "",
      requiresExpiration: false,
    };

    const result = reflectionTypeReference(allowed);

    expect(result.optionalRelationName).toBe("");
    expect(result.isTerminalSubject).toBeUndefined();
  });

  it("lets the wildcard branch win over a subrelation", () => {
    // Wildcard is tested FIRST, so a wildcard carrying a relation name never reaches the
    // relation-name branch.
    const allowed: AllowedRelation = {
      objectType: "user",
      kind: "publicWildcard",
      relationName: "member",
      requiresExpiration: false,
    };

    const result = reflectionTypeReference(allowed);

    expect(result.isPublicWildcard).toBe(true);
    expect(result.optionalRelationName).toBeUndefined();
    expect(result.isTerminalSubject).toBeUndefined();
  });

  it("maps a wildcard with no subrelation to the wildcard branch", () => {
    const result = reflectionTypeReference(allowedRelationWildcard("user"));

    expect(result.subjectDefinitionName).toBe("user");
    expect(result.isPublicWildcard).toBe(true);
    expect(result.isTerminalSubject).toBeUndefined();
  });

  it("leaves the caveat name empty when no caveat is required", () => {
    const result = reflectionTypeReference(allowedRelationDirect("user"));

    expect(result.optionalCaveatName).toBe("");
  });

  it("carries the required caveat name alongside any branch", () => {
    const withRelation = reflectionTypeReference(
      allowedRelationDirect("group", "member", { caveatName: "only_on_tuesday" }),
    );
    const withWildcard = reflectionTypeReference(
      allowedRelationWildcard("user", { caveatName: "only_on_tuesday" }),
    );

    expect(withRelation.optionalCaveatName).toBe("only_on_tuesday");
    expect(withRelation.optionalRelationName).toBe("member");
    expect(withWildcard.optionalCaveatName).toBe("only_on_tuesday");
    expect(withWildcard.isPublicWildcard).toBe(true);
  });
});

describe("reflectionPermission", () => {
  it("maps name, parent and the always-empty comment", () => {
    const result = reflectionPermission("document", permission("view", anyRewrite));

    expect(result).toEqual({ name: "view", comment: "", parentDefinitionName: "document" });
  });
});

function caveat(
  name: string,
  expression: string,
  parameterTypes: ReadonlyMap<string, CaveatTypeReference> = new Map(),
): CaveatDefinition {
  return {
    name,
    serializedExpression: new TextEncoder().encode(expression),
    parameterTypes,
  };
}

describe("reflectionCaveat", () => {
  it("decodes the serialized expression as UTF-8", () => {
    // A latin1/`String.fromCharCode` decode mangles this; the decoded text goes straight onto the
    // wire as ReflectionCaveat.expression.
    const expression = 'request.name == "café ☕" && request.count > 1';

    const result = reflectionCaveat(caveat("greeting", expression));

    expect(result.name).toBe("greeting");
    expect(result.comment).toBe("");
    expect(result.expression).toBe(expression);
  });

  it("decodes empty expression bytes to the empty string", () => {
    const result = reflectionCaveat({
      name: "empty",
      serializedExpression: new Uint8Array(),
      parameterTypes: new Map(),
    });

    expect(result.expression).toBe("");
    expect(result.parameters).toEqual([]);
  });

  it("orders parameters by an ORDINAL comparison of the name, not a locale-aware one", () => {
    // Ordinal (UTF-16 code unit) order is B(0x42) < Z(0x5A) < _(0x5F) < a(0x61) < á(0xE1).
    // `localeCompare` would produce a, á, B, Z, _ and silently change the emitted proto.
    const parameters = new Map<string, CaveatTypeReference>([
      ["a", { typeName: "int" }],
      ["á", { typeName: "int" }],
      ["Z", { typeName: "int" }],
      ["_x", { typeName: "int" }],
      ["B", { typeName: "int" }],
    ]);

    const result = reflectionCaveat(caveat("c", "true", parameters));

    expect(result.parameters.map((p) => p.name)).toEqual(["B", "Z", "_x", "a", "á"]);
  });

  it("renders each parameter's type and parent caveat name", () => {
    const parameters = new Map<string, CaveatTypeReference>([
      ["count", { typeName: "int" }],
      ["names", { typeName: "list", childTypes: [{ typeName: "string" }] }],
    ]);

    const result = reflectionCaveat(caveat("only_on_tuesday", "true", parameters));

    expect(result.parameters).toEqual([
      { name: "count", type: "int", parentCaveatName: "only_on_tuesday" },
      { name: "names", type: "list<string>", parentCaveatName: "only_on_tuesday" },
    ]);
  });
});

describe("reflectionCaveatParameter", () => {
  it("renders the type through caveatTypeString", () => {
    const result = reflectionCaveatParameter("c", "m", {
      typeName: "map",
      childTypes: [{ typeName: "string" }, { typeName: "int" }],
    });

    expect(result).toEqual({ name: "m", type: "map<string, int>", parentCaveatName: "c" });
  });
});

describe("caveatTypeString", () => {
  it("returns the bare type name for a scalar", () => {
    expect(caveatTypeString({ typeName: "int" })).toBe("int");
  });

  it("returns the bare type name for an EMPTY child list, as for an absent one", () => {
    expect(caveatTypeString({ typeName: "list", childTypes: [] })).toBe("list");
    expect(caveatTypeString({ typeName: "list", childTypes: undefined })).toBe("list");
  });

  it("joins child types with a comma AND a space", () => {
    expect(
      caveatTypeString({
        typeName: "map",
        childTypes: [{ typeName: "string" }, { typeName: "int" }],
      }),
    ).toBe("map<string, int>");
  });

  it("recurses through nested generic types", () => {
    expect(
      caveatTypeString({
        typeName: "map",
        childTypes: [
          { typeName: "string" },
          { typeName: "list", childTypes: [{ typeName: "ipaddress" }] },
        ],
      }),
    ).toBe("map<string, list<ipaddress>>");
  });
});
