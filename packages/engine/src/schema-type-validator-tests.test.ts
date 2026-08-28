import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { baseRelation } from "@spacedb/core/relation";
import { allowedRelationDirect } from "@spacedb/core/allowed-relation";
import { createNamespaceDefinition } from "@spacedb/core/namespace-definition";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { SchemaTypeException } from "./schema-type-exception";
import { validateSchemaTypes } from "./schema-type-validator";

// Port of `tests/Spiceport.Engine.Tests/SchemaTypeValidatorTests.cs`, case for case.
//
// The C# mirrors SpiceDB's `TypeSystem.Validate` (`pkg/schema/typesystem_validation.go`) and
// `ValidateCaveatDefinition` (`internal/namespace/caveats.go`): undefined references,
// permission-on-left-of-arrow, wildcard in arrow, missing allowed types, undefined caveat,
// duplicate/reused names, and the caveat-definition rules (>= 1 parameter, parseable CEL, every
// declared parameter referenced).
//
// The C# asserts with `Assert.Contains(fragment, ex.Message)`; those assertions are carried over
// unchanged rather than tightened to whole-message equality, so this file stays a faithful port
// of the suite it replaces.
//
// ONE case below has no C# counterpart - `DuplicateRelationName_...`. It is not new coverage of a
// new rule: it pins the behaviour the C# already has by accident. `ValidateDefinition` builds
// `def.Relations.ToDictionary(r => r.Name)`, and `ToDictionary` THROWS on a duplicate key, while
// the natural TypeScript `new Map(...)` silently keeps the last entry. Nothing upstream rejects a
// duplicate relation name (the compiler does not, and `ValidateUniqueNames` only covers
// definition and caveat names), so without the pin a schema the C# rejected would quietly pass
// here. The thrown shape mirrors `SchemaCompiler`'s existing port of the same .NET behaviour:
// `InvalidArgumentError`, NOT `SchemaTypeException`, because in the C# the throw comes from
// `ToDictionary` outside any `catch`.

function validate(schemaText: string): void {
  validateSchemaTypes(compileSchema(schemaText));
}

function validateThrows(schemaText: string): SchemaTypeException {
  try {
    validate(schemaText);
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaTypeException);
    return error as SchemaTypeException;
  }
  throw new Error("expected a SchemaTypeException, but validation succeeded");
}

describe("validateSchemaTypes", () => {
  it("accepts a valid schema", () => {
    validate(`
      definition user {}
      definition group {
          relation member: user
      }
      definition document {
          relation viewer: user | group#member
          relation parent: document
          permission view = viewer + parent->view
      }
    `);
  });

  it("rejects a permission referencing an undefined relation", () => {
    const ex = validateThrows(`
      definition user {}
      definition document {
          permission view = nonexistent
      }
    `);
    expect(ex.message).toContain("nonexistent");
  });

  it("rejects a permission on the left of an arrow", () => {
    const ex = validateThrows(`
      definition user {}
      definition document {
          relation viewer: user
          permission edit = viewer
          permission view = edit->something
      }
    `);
    expect(ex.message).toContain("left hand side of an arrow");
  });

  it("rejects a wildcard on the left of an arrow", () => {
    const ex = validateThrows(`
      definition user {}
      definition document {
          relation parent: user:*
          permission view = parent->view
      }
    `);
    expect(ex.message).toContain("wildcard");
  });

  // --- Wildcard reachable through a userset reference ("wildcard relations cannot be
  // transitively included") -- issue #33. Real SpiceDB v1.49.2 rejects every shape below at
  // WriteSchema with FailedPrecondition; verified empirically against the container (see
  // tests/Spiceport.Differential.Tests/WriteSchemaWildcardTransitivityTests.cs). A relation is
  // validated wherever it is DEFINED, so a chain of cross-definition userset references is still
  // caught: the link that directly names a wildcard-bearing relation/subrelation fails on its
  // own, regardless of how deeply it is nested under the schema's other definitions.

  it("rejects a wildcard reachable one level through a userset", () => {
    const ex = validateThrows(`
      definition user {}
      definition group {
          relation member: user:*
      }
      definition document {
          relation viewer: group#member
      }
    `);
    expect(ex.message).toContain("wildcard");
    expect(ex.message).toContain("group#member");
  });

  it("rejects a wildcard reachable two levels through a userset", () => {
    // document.viewer -> team#groupmember -> group#member (user:*). The offending link is
    // team.groupmember itself (validated independently of who references `team#groupmember`), so
    // the rejection fires regardless of chain depth.
    const ex = validateThrows(`
      definition user {}
      definition group {
          relation member: user:*
      }
      definition team {
          relation groupmember: group#member
      }
      definition document {
          relation viewer: team#groupmember
      }
    `);
    expect(ex.message).toContain("wildcard");
  });

  it("rejects a wildcard reachable through a userset via a union member", () => {
    // The wildcard-bearing relation is one union arm of an otherwise-fine relation; still
    // rejected, because `team.groupmember` itself directly names the wildcard-bearing
    // `group#member`.
    const ex = validateThrows(`
      definition user {}
      definition group {
          relation member: user:*
      }
      definition team {
          relation directmember: user
          relation groupmember: group#member
          permission member = directmember + groupmember
      }
      definition document {
          relation viewer: team#member
      }
    `);
    expect(ex.message).toContain("wildcard");
  });

  it("accepts a direct wildcard on a base relation", () => {
    // A wildcard on the relation where it is DEFINED is legal SpiceDB -- only a userset reference
    // TO a wildcard-bearing relation from elsewhere is rejected.
    validate(`
      definition user {}
      definition document {
          relation viewer: user:*
      }
    `);
  });

  it("accepts a wildcard reachable only through a permission", () => {
    // Real SpiceDB does NOT walk into a permission's rewrite tree for the transitive-wildcard
    // check -- only base-relation userset references are checked. A permission computed via an
    // arrow over a wildcard-bearing relation is a legal userset type.
    validate(`
      definition user {}
      definition group {
          relation member: user:*
      }
      definition team {
          relation groupmember: group
          permission allmembers = groupmember->member
      }
      definition document {
          relation viewer: team#allmembers
      }
    `);
  });

  it("accepts a wildcard reachable through the same definition's other relation", () => {
    // Real SpiceDB only rejects a CROSS-definition userset reference to a wildcard-bearing
    // relation; referencing a wildcard-bearing relation of the SAME definition is accepted
    // (mirrors the recursive-group self-reference exception below).
    validate(`
      definition user {}
      definition group {
          relation adminwildcard: user:*
          relation member: group#adminwildcard
      }
    `);
  });

  it("accepts a relation allowing itself", () => {
    // Canonical recursive-group SpiceDB shape (the conformance corpus' directgroups.yaml);
    // real SpiceDB's WriteSchema accepts it, so ours must too.
    validate(`
      definition user {}
      definition group {
          relation member: user | group#member
      }
    `);
  });

  it("rejects an allowed subject type with an undefined namespace", () => {
    const ex = validateThrows(`
      definition document {
          relation viewer: missingtype
      }
    `);
    expect(ex.message).toContain("missingtype");
  });

  it("rejects an undefined allowed subject subrelation", () => {
    const ex = validateThrows(`
      definition user {}
      definition group {
          relation member: user
      }
      definition document {
          relation viewer: group#nosuchrel
      }
    `);
    expect(ex.message).toContain("nosuchrel");
  });

  it("rejects an undefined caveat", () => {
    const ex = validateThrows(`
      definition user {}
      definition document {
          relation viewer: user with nosuchcaveat
      }
    `);
    expect(ex.message).toContain("nosuchcaveat");
  });

  it("rejects a duplicate allowed type", () => {
    const ex = validateThrows(`
      definition user {}
      definition document {
          relation viewer: user | user
      }
    `);
    expect(ex.message).toContain("duplicate");
  });

  it("rejects a duplicate definition name", () => {
    const ex = validateThrows(`
      definition user {}
      definition user {}
    `);
    expect(ex.message).toContain("reused");
  });

  it("rejects a name reused between a definition and a caveat", () => {
    const ex = validateThrows(`
      definition thing {}
      caveat thing(x int) { x > 0 }
    `);
    expect(ex.message).toContain("reused");
  });

  it("rejects a caveat with no parameters", () => {
    const ex = validateThrows(`
      definition user {}
      caveat always() { true }
    `);
    expect(ex.message).toContain("at least one parameter");
  });

  it("rejects a caveat with an unused parameter", () => {
    const ex = validateThrows(`
      definition user {}
      caveat c(used int, unused string) { used > 0 }
    `);
    expect(ex.message).toContain("unused");
  });

  it("rejects a caveat with unparseable CEL", () => {
    const ex = validateThrows(`
      definition user {}
      caveat c(x int) { x > > 0 }
    `);
    expect(ex.message).toContain("c");
  });

  it("accepts a caveat whose parameters are all referenced", () => {
    validate(`
      definition user {}
      definition document {
          relation viewer: user with ip_match
      }
      caveat ip_match(allowed string, user_ip string) { user_ip == allowed }
    `);
  });

  // Not a C# test case; a pin on the C#'s incidental `ToDictionary` throw. See the file header.
  it("rejects a definition with two relations of the same name", () => {
    const schema = {
      namespaces: [
        createNamespaceDefinition("user"),
        createNamespaceDefinition(
          "document",
          baseRelation("viewer", allowedRelationDirect("user")),
          baseRelation("viewer", allowedRelationDirect("user")),
        ),
      ],
      caveats: [],
    };

    expect(() => validateSchemaTypes(schema)).toThrow(InvalidArgumentError);
    expect(() => validateSchemaTypes(schema)).toThrow(
      "An item with the same key has already been added. Key: viewer",
    );
  });

  it("rejects a null schema", () => {
    // `ArgumentNullException.ThrowIfNull(schema)`. The guard survives the port even though the
    // parameter's TypeScript type is non-optional: callers across the grain boundary are untyped.
    expect(() => validateSchemaTypes(undefined as never)).toThrow(InvalidArgumentError);
  });
});
