import { describe, expect, it } from "vitest";

import { allowedRelationDirect } from "./allowed-relation";
import { createNamespaceDefinition, type NamespaceDefinition } from "./namespace-definition";
import { baseRelation, isPermission, permission } from "./relation";
import { computedUsersetOnResource, setOperationUnion } from "./userset-rewrite";

// Characterization of Spiceport `NamespaceDefinition`, declared alongside `Relation` in
// `Relation.cs`. The port gives it its own module under the no-barrels, one-primary-export rule;
// the ledger row for `Relation.cs` therefore fans out to two target files.
describe("namespace definition", () => {
  const relations = [
    baseRelation("viewer", allowedRelationDirect("user")),
    permission("view", {
      operation: setOperationUnion({
        kind: "computedUserset",
        value: computedUsersetOnResource("viewer"),
      }),
    }),
  ];

  it("collects rest-parameter relations in declaration order", () => {
    const definition = createNamespaceDefinition("document", ...relations);

    expect(definition.name).toBe("document");
    expect(definition.relations.map((r) => r.name)).toEqual(["viewer", "view"]);
  });

  it("holds both relations and permissions in one list", () => {
    const definition = createNamespaceDefinition("document", ...relations);

    expect(definition.relations.map(isPermission)).toEqual([false, true]);
  });

  it("accepts a definition with no relations", () => {
    expect(createNamespaceDefinition("empty").relations).toEqual([]);
  });

  it("keeps a path-segmented name verbatim", () => {
    // The documented pattern allows "/" segments; the type performs no validation of its own.
    expect(createNamespaceDefinition("org/document").name).toBe("org/document");
  });

  it("performs no uniqueness check of its own: names are the compiler's responsibility", () => {
    const duplicate: NamespaceDefinition = createNamespaceDefinition(
      "document",
      baseRelation("viewer", allowedRelationDirect("user")),
      baseRelation("viewer", allowedRelationDirect("team", "member")),
    );

    expect(duplicate.relations).toHaveLength(2);
  });
});
