import { status } from "@grpc/grpc-js";
import { ReflectionSchemaFilter } from "@spacedb/protos/authzed/api/v1/schema_service";
import { describe, expect, it } from "vitest";

import { RpcError } from "./rpc-error";
import { schemaFiltersFromRequest } from "./schema-filters";

/**
 * Characterization test for `src/Spiceport.Api/SchemaFilters.cs`.
 *
 * The C# has NO direct suite: `AuthzedSchemaV1ServiceTests.cs` drives only two paths through the
 * service (a definition-name filter, and the mutually-exclusive-filter rejection), leaving
 * `MatchesCaveat`, `MatchesRelation`, `MatchesPermission` and the prefix semantics unexercised.
 * What is pinned here is the truth table, one case per predicate per filter shape, because the
 * predicates decide what a ReflectSchema response CONTAINS:
 *
 *   * every match is a PREFIX match, ordinal - never equality, never case-insensitive;
 *   * an empty filter list admits everything, in all four predicates;
 *   * with a non-empty list the filters are OR'd, and each predicate SKIPS filters of the wrong
 *     scope - the four skip conditions differ, and that asymmetry is the whole file;
 *   * `fromRequest` is the only constructor and validates every filter, with verbatim messages
 *     under InvalidArgument.
 */

function filter(partial: Partial<ReflectionSchemaFilter>): ReflectionSchemaFilter {
  return ReflectionSchemaFilter.fromPartial(partial);
}

const unscoped = filter({});
const definitionOnly = filter({ optionalDefinitionNameFilter: "doc" });
const caveatOnly = filter({ optionalCaveatNameFilter: "only" });
const definitionAndRelation = filter({
  optionalDefinitionNameFilter: "doc",
  optionalRelationNameFilter: "view",
});
const definitionAndPermission = filter({
  optionalDefinitionNameFilter: "doc",
  optionalPermissionNameFilter: "view",
});

function expectRpcError(act: () => unknown): RpcError {
  try {
    act();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(RpcError);
    return thrown as RpcError;
  }
  throw new Error("expected an RpcError to be thrown, but nothing was thrown");
}

describe("schemaFiltersFromRequest validation", () => {
  it("accepts an empty filter list", () => {
    expect(() => schemaFiltersFromRequest([])).not.toThrow();
  });

  it("rejects a definition and caveat filter together", () => {
    const error = expectRpcError(() =>
      schemaFiltersFromRequest([
        filter({ optionalDefinitionNameFilter: "doc", optionalCaveatNameFilter: "only" }),
      ]),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("cannot filter by both definition and caveat name");
  });

  it("rejects a relation and permission filter together", () => {
    const error = expectRpcError(() =>
      schemaFiltersFromRequest([
        filter({
          optionalDefinitionNameFilter: "doc",
          optionalRelationNameFilter: "view",
          optionalPermissionNameFilter: "view",
        }),
      ]),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("cannot filter by both relation and permission name");
  });

  it("rejects a relation filter with no definition filter", () => {
    const error = expectRpcError(() =>
      schemaFiltersFromRequest([filter({ optionalRelationNameFilter: "view" })]),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("relation/permission filter requires a definition filter");
  });

  it("rejects a permission filter with no definition filter", () => {
    const error = expectRpcError(() =>
      schemaFiltersFromRequest([filter({ optionalPermissionNameFilter: "view" })]),
    );

    expect(error.details).toBe("relation/permission filter requires a definition filter");
  });

  it("reports the missing-definition rule before the caveat/relation rule", () => {
    // Both `hasRelation && !hasDef` and `hasCaveat && hasRelation` hold here; the C# checks them
    // in that order, so the missing-definition message is the one the client sees. (The fourth
    // rule is unreachable as a consequence - see sourceConcerns.)
    const error = expectRpcError(() =>
      schemaFiltersFromRequest([
        filter({ optionalCaveatNameFilter: "only", optionalRelationNameFilter: "view" }),
      ]),
    );

    expect(error.details).toBe("relation/permission filter requires a definition filter");
  });

  it("validates every filter, not just the first", () => {
    const error = expectRpcError(() =>
      schemaFiltersFromRequest([
        definitionOnly,
        filter({ optionalDefinitionNameFilter: "doc", optionalCaveatNameFilter: "only" }),
      ]),
    );

    expect(error.details).toBe("cannot filter by both definition and caveat name");
  });
});

describe("matchesDefinition", () => {
  it("admits everything when there are no filters", () => {
    expect(schemaFiltersFromRequest([]).matchesDefinition("anything")).toBe(true);
  });

  it("matches by prefix, not equality", () => {
    const filters = schemaFiltersFromRequest([definitionOnly]);

    expect(filters.matchesDefinition("doc")).toBe(true);
    expect(filters.matchesDefinition("document")).toBe(true);
    expect(filters.matchesDefinition("do")).toBe(false);
    expect(filters.matchesDefinition("user")).toBe(false);
  });

  it("matches case-sensitively", () => {
    const filters = schemaFiltersFromRequest([definitionOnly]);

    expect(filters.matchesDefinition("Document")).toBe(false);
  });

  it("skips a caveat-only filter, so a caveat-only list admits no definition", () => {
    expect(schemaFiltersFromRequest([caveatOnly]).matchesDefinition("document")).toBe(false);
  });

  it("admits every definition through an unscoped filter", () => {
    expect(schemaFiltersFromRequest([unscoped]).matchesDefinition("anything")).toBe(true);
  });

  it("ORs across filters", () => {
    const filters = schemaFiltersFromRequest([
      caveatOnly,
      filter({ optionalDefinitionNameFilter: "user" }),
    ]);

    expect(filters.matchesDefinition("user")).toBe(true);
    expect(filters.matchesDefinition("document")).toBe(false);
  });

  it("uses only the definition half of a definition+relation filter", () => {
    const filters = schemaFiltersFromRequest([definitionAndRelation]);

    expect(filters.matchesDefinition("document")).toBe(true);
    expect(filters.matchesDefinition("user")).toBe(false);
  });
});

describe("matchesCaveat", () => {
  it("admits everything when there are no filters", () => {
    expect(schemaFiltersFromRequest([]).matchesCaveat("anything")).toBe(true);
  });

  it("matches a caveat-scoped filter by prefix", () => {
    const filters = schemaFiltersFromRequest([caveatOnly]);

    expect(filters.matchesCaveat("only_on_tuesday")).toBe(true);
    expect(filters.matchesCaveat("onl")).toBe(false);
    expect(filters.matchesCaveat("other")).toBe(false);
  });

  it("admits every caveat through an unscoped filter", () => {
    expect(schemaFiltersFromRequest([unscoped]).matchesCaveat("anything")).toBe(true);
  });

  it("skips a definition-scoped filter, so a definition-only list admits no caveat", () => {
    expect(schemaFiltersFromRequest([definitionOnly]).matchesCaveat("only_on_tuesday")).toBe(false);
  });

  it("skips relation- and permission-scoped filters", () => {
    expect(schemaFiltersFromRequest([definitionAndRelation]).matchesCaveat("only_on_tuesday")).toBe(
      false,
    );
    expect(
      schemaFiltersFromRequest([definitionAndPermission]).matchesCaveat("only_on_tuesday"),
    ).toBe(false);
  });

  it("ORs across filters", () => {
    const filters = schemaFiltersFromRequest([definitionOnly, caveatOnly]);

    expect(filters.matchesCaveat("only_on_tuesday")).toBe(true);
    expect(filters.matchesCaveat("other")).toBe(false);
  });
});

describe("matchesRelation", () => {
  it("admits everything when there are no filters", () => {
    expect(schemaFiltersFromRequest([]).matchesRelation("document", "viewer")).toBe(true);
  });

  it("admits every relation of a matching definition when no relation filter is set", () => {
    const filters = schemaFiltersFromRequest([definitionOnly]);

    expect(filters.matchesRelation("document", "viewer")).toBe(true);
    expect(filters.matchesRelation("user", "viewer")).toBe(false);
  });

  it("matches the relation name by prefix once the definition matches", () => {
    const filters = schemaFiltersFromRequest([definitionAndRelation]);

    expect(filters.matchesRelation("document", "viewer")).toBe(true);
    expect(filters.matchesRelation("document", "view")).toBe(true);
    expect(filters.matchesRelation("document", "vie")).toBe(false);
    expect(filters.matchesRelation("document", "editor")).toBe(false);
    expect(filters.matchesRelation("user", "viewer")).toBe(false);
  });

  it("skips a caveat-only filter", () => {
    expect(schemaFiltersFromRequest([caveatOnly]).matchesRelation("document", "viewer")).toBe(
      false,
    );
  });

  it("skips a filter that names a permission", () => {
    expect(
      schemaFiltersFromRequest([definitionAndPermission]).matchesRelation("document", "viewer"),
    ).toBe(false);
  });

  it("admits every relation through an unscoped filter", () => {
    expect(schemaFiltersFromRequest([unscoped]).matchesRelation("anything", "anything")).toBe(true);
  });

  it("ORs across filters", () => {
    const filters = schemaFiltersFromRequest([definitionAndPermission, definitionAndRelation]);

    expect(filters.matchesRelation("document", "viewer")).toBe(true);
    expect(filters.matchesRelation("document", "editor")).toBe(false);
  });
});

describe("matchesPermission", () => {
  it("admits everything when there are no filters", () => {
    expect(schemaFiltersFromRequest([]).matchesPermission("document", "view")).toBe(true);
  });

  it("admits every permission of a matching definition when no permission filter is set", () => {
    const filters = schemaFiltersFromRequest([definitionOnly]);

    expect(filters.matchesPermission("document", "view")).toBe(true);
    expect(filters.matchesPermission("user", "view")).toBe(false);
  });

  it("matches the permission name by prefix once the definition matches", () => {
    const filters = schemaFiltersFromRequest([definitionAndPermission]);

    expect(filters.matchesPermission("document", "view")).toBe(true);
    expect(filters.matchesPermission("document", "view_all")).toBe(true);
    expect(filters.matchesPermission("document", "vie")).toBe(false);
    expect(filters.matchesPermission("document", "edit")).toBe(false);
    expect(filters.matchesPermission("user", "view")).toBe(false);
  });

  it("skips a caveat-only filter", () => {
    expect(schemaFiltersFromRequest([caveatOnly]).matchesPermission("document", "view")).toBe(
      false,
    );
  });

  it("skips a filter that names a relation", () => {
    expect(
      schemaFiltersFromRequest([definitionAndRelation]).matchesPermission("document", "view"),
    ).toBe(false);
  });

  it("admits every permission through an unscoped filter", () => {
    expect(schemaFiltersFromRequest([unscoped]).matchesPermission("anything", "anything")).toBe(
      true,
    );
  });

  it("ORs across filters", () => {
    const filters = schemaFiltersFromRequest([definitionAndRelation, definitionAndPermission]);

    expect(filters.matchesPermission("document", "view")).toBe(true);
    expect(filters.matchesPermission("document", "edit")).toBe(false);
  });
});
