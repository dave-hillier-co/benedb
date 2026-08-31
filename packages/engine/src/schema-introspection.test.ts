import { ELLIPSIS } from "@benedb/core/core-constants";
import { allowedRelationDirect } from "@benedb/core/allowed-relation";
import { createNamespaceDefinition } from "@benedb/core/namespace-definition";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { baseRelation, permission } from "@benedb/core/relation";
import { setOperationUnion } from "@benedb/core/userset-rewrite";
import { compileSchema } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { buildReachabilityGraph } from "./reachability-graph";
import { computablePermissions, dependentRelations } from "./schema-introspection";
import { SchemaIntrospectionException } from "./schema-introspection-exception";
import type { RelationReference } from "./relation-reference";

// Characterization of Spiceport `Engine/Reachability/SchemaIntrospection.cs`. NO C# test covers it
// at this layer: the only coverage is `tests/Spiceport.Grains.Tests/AuthzedSchemaV1ServiceTests.cs`,
// three stages up, so these tests drive the two walks directly.
//
// LEDGER NOTE: the one C# file also declares `SchemaIntrospectionErrorKind` and
// `SchemaIntrospectionException`. Under the no-barrels / one-primary-export rule they get their
// own module (`schema-introspection-exception.ts`) and a second `docs/port-ledger.md` row against
// the same source, the way `Relation.cs` already maps to two targets.
//
// Behaviour pinned here:
//
//   * The exception's KIND must survive as data, not just as message text: at S5 it picks the gRPC
//     status (DefinitionNotFound / RelationNotFound -> NotFound, NotAPermission ->
//     InvalidArgument). Every error case below asserts the kind as well as the message.
//
//   * `HashSet<RelationReference>` for results / seen / visited becomes a Set over the canonical
//     key from `relation-reference.ts`; a Set of objects would compare by reference and dedupe
//     nothing.
//
//   * `results.Remove(input)` runs AFTER the closure, so the input can be re-added transitively
//     and is then removed again. The recursive-arrow case below is exactly that shape.
//
//   * `Project` filters with an ORDINAL `StartsWith` and sorts by namespace then relation
//     ORDINALLY (`a < b`, never `localeCompare`). The uppercase/underscore cases below pin the
//     ordinal ordering, which differs from a locale-aware sort.
//
//   * An empty `relationName` defaults to the ellipsis and SKIPS the relation-exists check.
//
//   * `DependentRelations` rejects a base relation with NotAPermission, and `WalkArrow` mirrors
//     `ReachabilityGraph.AddTtu`'s rule (skip wildcards, walk each allowed type's computed
//     relation). The two are kept in sync deliberately.

function namespacesOf(schemaText: string): ReadonlyMap<string, NamespaceDefinition> {
  const compiled = compileSchema(schemaText);
  return new Map(compiled.namespaces.map((ns) => [ns.name, ns]));
}

function labels(references: readonly RelationReference[]): readonly string[] {
  return references.map((r) => `${r.namespace}#${r.relation}`);
}

function introspectionThrows(run: () => unknown): SchemaIntrospectionException {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaIntrospectionException);
    return error as SchemaIntrospectionException;
  }
  throw new Error("expected a SchemaIntrospectionException, but the call succeeded");
}

const SCHEMA = `
  definition user {}
  definition group {
      relation member: user
  }
  definition document {
      relation viewer: user | group#member
      permission view = viewer
  }
`;

describe("computablePermissions", () => {
  it("returns the forward closure from a subject, ordinally sorted", () => {
    const namespaces = namespacesOf(SCHEMA);
    const graph = buildReachabilityGraph(namespaces);

    const results = computablePermissions(namespaces, graph, "user", "");

    expect(labels(results)).toEqual(["document#view", "document#viewer", "group#member"]);
  });

  it("treats an empty relation name as the ellipsis subject", () => {
    const namespaces = namespacesOf(SCHEMA);
    const graph = buildReachabilityGraph(namespaces);

    expect(computablePermissions(namespaces, graph, "user", "")).toEqual(
      computablePermissions(namespaces, graph, "user", ELLIPSIS),
    );
  });

  it("continues the closure outward from each newly reached target", () => {
    // group#member is reached from user#..., and document#viewer/document#view are reached from
    // group#member in turn, so all three appear even though only the first is a direct hit.
    const namespaces = namespacesOf(SCHEMA);
    const graph = buildReachabilityGraph(namespaces);

    expect(labels(computablePermissions(namespaces, graph, "group", "member"))).toEqual([
      "document#view",
      "document#viewer",
    ]);
  });

  it("excludes the input itself", () => {
    // group#member allows group#member, so the closure reaches the input; it is removed at the end.
    const namespaces = namespacesOf(`
      definition user {}
      definition group {
          relation member: user | group#member
      }
    `);
    const graph = buildReachabilityGraph(namespaces);

    expect(labels(computablePermissions(namespaces, graph, "group", "member"))).toEqual([]);
  });

  it("filters result definitions by an ordinal name prefix", () => {
    const namespaces = namespacesOf(SCHEMA);
    const graph = buildReachabilityGraph(namespaces);

    expect(labels(computablePermissions(namespaces, graph, "user", "", "doc"))).toEqual([
      "document#view",
      "document#viewer",
    ]);
    expect(labels(computablePermissions(namespaces, graph, "user", "", "document"))).toEqual([
      "document#view",
      "document#viewer",
    ]);
    expect(labels(computablePermissions(namespaces, graph, "user", "", "gr"))).toEqual([
      "group#member",
    ]);
  });

  it("treats an empty filter as no filter", () => {
    const namespaces = namespacesOf(SCHEMA);
    const graph = buildReachabilityGraph(namespaces);

    expect(labels(computablePermissions(namespaces, graph, "user", "", ""))).toEqual([
      "document#view",
      "document#viewer",
      "group#member",
    ]);
  });

  it("matches the prefix filter case-sensitively", () => {
    const namespaces = namespacesOf(SCHEMA);
    const graph = buildReachabilityGraph(namespaces);

    expect(computablePermissions(namespaces, graph, "user", "", "Doc")).toEqual([]);
  });

  it("returns nothing for a subject nothing points at", () => {
    const namespaces = namespacesOf(SCHEMA);
    const graph = buildReachabilityGraph(namespaces);

    expect(computablePermissions(namespaces, graph, "document", "view")).toEqual([]);
  });

  it("rejects an unknown definition", () => {
    const namespaces = namespacesOf(SCHEMA);
    const graph = buildReachabilityGraph(namespaces);

    const ex = introspectionThrows(() =>
      computablePermissions(namespaces, graph, "nope", "member"),
    );

    expect(ex.kind).toBe("definitionNotFound");
    expect(ex.message).toBe("object definition `nope` not found");
    expect(ex.name).toBe("SchemaIntrospectionException");
  });

  it("rejects an unknown relation", () => {
    const namespaces = namespacesOf(SCHEMA);
    const graph = buildReachabilityGraph(namespaces);

    const ex = introspectionThrows(() =>
      computablePermissions(namespaces, graph, "group", "nosuchrel"),
    );

    expect(ex.kind).toBe("relationNotFound");
    expect(ex.message).toBe("relation/permission `nosuchrel` not found under definition `group`");
  });

  it("accepts an empty relation on a definition that has none", () => {
    const namespaces = namespacesOf(SCHEMA);
    const graph = buildReachabilityGraph(namespaces);

    // `user` declares no relations at all; the ellipsis default skips the existence check.
    expect(() => computablePermissions(namespaces, graph, "user", "")).not.toThrow();
  });

  it("sorts ordinally, not by locale", () => {
    // Ordinal ordering puts every uppercase letter and the underscore where their code points
    // say, which a locale-aware comparison would not.
    const namespaces = namespacesOf(`
      definition user {}
      definition a_bc {
          relation viewer: user
      }
      definition abc {
          relation viewer: user
      }
    `);
    const graph = buildReachabilityGraph(namespaces);

    // "_" (U+005F) sorts before "b" (U+0062), so `a_bc` precedes `abc`.
    expect(labels(computablePermissions(namespaces, graph, "user", ""))).toEqual([
      "a_bc#viewer",
      "abc#viewer",
    ]);
  });
});

describe("dependentRelations", () => {
  const DEPENDENCY_SCHEMA = `
    definition user {}
    definition folder {
        relation viewer: user
        permission view = viewer
    }
    definition document {
        relation parent: folder
        relation viewer: user
        permission edit = viewer
        permission view = edit + parent->view
    }
  `;

  it("returns the transitive dependencies of a permission, ordinally sorted", () => {
    const namespaces = namespacesOf(DEPENDENCY_SCHEMA);

    expect(labels(dependentRelations(namespaces, "document", "view"))).toEqual([
      "document#edit",
      "document#parent",
      "document#viewer",
      "folder#view",
      "folder#viewer",
    ]);
  });

  it("walks an arrow's tupleset relation and each allowed type's computed relation", () => {
    const namespaces = namespacesOf(DEPENDENCY_SCHEMA);
    const results = labels(dependentRelations(namespaces, "document", "view"));

    expect(results).toContain("document#parent");
    expect(results).toContain("folder#view");
  });

  it("ignores an allowed type that lacks the computed relation", () => {
    const namespaces = namespacesOf(`
      definition user {}
      definition folder {
          relation viewer: user
          permission view = viewer
      }
      definition document {
          relation parent: folder | user
          permission view = parent->view
      }
    `);

    expect(labels(dependentRelations(namespaces, "document", "view"))).toEqual([
      "document#parent",
      "folder#view",
      "folder#viewer",
    ]);
  });

  it("skips a wildcard allowed type on the tupleset relation", () => {
    // Mirrors `ReachabilityGraph.AddTtu`, deliberately: an arrow over a wildcard link contributes
    // nothing, so only the tupleset relation itself remains a dependency.
    const namespaces = namespacesOf(`
      definition user {}
      definition folder {
          relation viewer: user
          permission view = viewer
      }
      definition document {
          relation parent: folder:*
          permission view = parent->view
      }
    `);

    expect(labels(dependentRelations(namespaces, "document", "view"))).toEqual(["document#parent"]);
  });

  it("removes the input after the walk, even when reached transitively", () => {
    // The recursive arrow re-adds document#view through the tupleset's own allowed type; the
    // final `results.Remove(input)` takes it back out.
    const namespaces = namespacesOf(`
      definition document {
          relation parent: document
          permission view = parent->view
      }
    `);

    expect(labels(dependentRelations(namespaces, "document", "view"))).toEqual(["document#parent"]);
  });

  it("terminates on mutually recursive permissions", () => {
    const namespaces = namespacesOf(`
      definition user {}
      definition document {
          relation viewer: user
          permission a = viewer + b
          permission b = a
      }
    `);

    expect(labels(dependentRelations(namespaces, "document", "a"))).toEqual([
      "document#b",
      "document#viewer",
    ]);
  });

  it("ignores a reference to a relation that does not exist", () => {
    // `Reference` bails on an unresolvable name rather than throwing: an unvalidated schema is
    // walked as far as it goes.
    const namespaces = namespacesOf(`
      definition user {}
      definition document {
          relation viewer: user
          permission view = viewer + nosuchrel
      }
    `);

    expect(labels(dependentRelations(namespaces, "document", "view"))).toEqual(["document#viewer"]);
  });

  it("records the ellipsis subject for a self operand", () => {
    const namespaces: ReadonlyMap<string, NamespaceDefinition> = new Map([
      [
        "document",
        createNamespaceDefinition(
          "document",
          baseRelation("viewer", allowedRelationDirect("user")),
          permission("view", {
            operation: setOperationUnion(
              { kind: "self" },
              { kind: "computedUserset", value: { object: "tupleObject", relation: "viewer" } },
            ),
          }),
        ),
      ],
    ]);

    expect(labels(dependentRelations(namespaces, "document", "view"))).toEqual([
      `document#${ELLIPSIS}`,
      "document#viewer",
    ]);
  });

  it("returns nothing for a permission with no dependencies", () => {
    const namespaces: ReadonlyMap<string, NamespaceDefinition> = new Map([
      [
        "document",
        createNamespaceDefinition(
          "document",
          permission("nothing", { operation: setOperationUnion({ kind: "nil" }) }),
        ),
      ],
    ]);

    expect(dependentRelations(namespaces, "document", "nothing")).toEqual([]);
  });

  it("rejects an unknown definition", () => {
    const namespaces = namespacesOf(DEPENDENCY_SCHEMA);

    const ex = introspectionThrows(() => dependentRelations(namespaces, "nope", "view"));

    expect(ex.kind).toBe("definitionNotFound");
    expect(ex.message).toBe("object definition `nope` not found");
  });

  it("rejects an unknown permission", () => {
    const namespaces = namespacesOf(DEPENDENCY_SCHEMA);

    const ex = introspectionThrows(() => dependentRelations(namespaces, "document", "nope"));

    expect(ex.kind).toBe("relationNotFound");
    expect(ex.message).toBe("permission `nope` not found under definition `document`");
  });

  it("rejects a base relation as not a permission", () => {
    const namespaces = namespacesOf(DEPENDENCY_SCHEMA);

    const ex = introspectionThrows(() => dependentRelations(namespaces, "document", "viewer"));

    expect(ex.kind).toBe("notAPermission");
    expect(ex.message).toBe(
      "`viewer` is a relation, not a permission, under definition `document`",
    );
  });

  it("is an Error with a working instanceof after downlevelling", () => {
    const namespaces = namespacesOf(DEPENDENCY_SCHEMA);

    const ex = introspectionThrows(() => dependentRelations(namespaces, "nope", "view"));

    expect(ex).toBeInstanceOf(Error);
    expect(ex).toBeInstanceOf(SchemaIntrospectionException);
    expect(ex.name).toBe("SchemaIntrospectionException");
  });
});
