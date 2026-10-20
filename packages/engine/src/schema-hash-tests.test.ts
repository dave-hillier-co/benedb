import type { CaveatDefinition, CaveatTypeReference } from "@benedb/core/caveat-definition";
import { compileSchema } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { computeSchemaHash } from "./schema-hash";

/**
 * Ported from Spiceport `tests/Spiceport.Engine.Tests/SchemaHashTests.cs`.
 *
 * Port notes:
 *  - `SchemaHash.Compute(compiled.Namespaces, compiled.Caveats)` -> `computeSchemaHash`.
 *  - `Array.Empty<NamespaceDefinition>()` -> `[]`; `Encoding.UTF8.GetBytes` -> `TextEncoder`, and
 *    `(byte[])body.Clone()` -> `body.slice()`, so the second definition holds its own copy.
 *  - The C# `Dictionary` parameter maps become `Map`s, given in opposite insertion orders.
 */
function schemaWithCaveat(parameters: string, body: string): string {
  return `caveat c(${parameters}) {
  ${body}
}

definition user {}

definition document {
  relation viewer: user with c
  permission view = viewer
}`;
}

function hashOf(schemaText: string): string {
  const compiled = compileSchema(schemaText);
  return computeSchemaHash(compiled.namespaces, compiled.caveats);
}

describe("SchemaHashTests", () => {
  it("Caveat_body_edit_changes_hash", () => {
    const before = hashOf(schemaWithCaveat("x int", "x > 1"));
    const after = hashOf(schemaWithCaveat("x int", "x > 100"));

    expect(after).not.toBe(before);
  });

  it("Caveat_parameter_type_edit_changes_hash", () => {
    const before = hashOf(schemaWithCaveat("x int", "x > 1"));
    const after = hashOf(schemaWithCaveat("x uint", "x > 1"));

    expect(after).not.toBe(before);
  });

  it("Caveat_generic_parameter_type_edit_changes_hash", () => {
    const before = hashOf(schemaWithCaveat("x list<int>", "1 in x"));
    const after = hashOf(schemaWithCaveat("x list<uint>", "1 in x"));

    expect(after).not.toBe(before);
  });

  it("Identical_schema_hashes_identically", () => {
    const text = schemaWithCaveat("x int, y map<string>", "x > 1");

    expect(hashOf(text)).toBe(hashOf(text));
  });

  it("Caveat_parameter_order_does_not_change_hash", () => {
    const body = new TextEncoder().encode("x > y");
    const forward = new Map<string, CaveatTypeReference>([
      ["x", { typeName: "int" }],
      ["y", { typeName: "list", childTypes: [{ typeName: "int" }] }],
    ]);
    const reversed = new Map<string, CaveatTypeReference>([
      ["y", { typeName: "list", childTypes: [{ typeName: "int" }] }],
      ["x", { typeName: "int" }],
    ]);

    const first: CaveatDefinition = {
      name: "c",
      serializedExpression: body,
      parameterTypes: forward,
    };
    const second: CaveatDefinition = {
      name: "c",
      serializedExpression: body.slice(),
      parameterTypes: reversed,
    };
    const a = computeSchemaHash([], [first]);
    const b = computeSchemaHash([], [second]);

    expect(a).toBe(b);
  });

  it("Doc_comment_edit_does_not_change_hash", () => {
    // Comments are metadata, not semantics: a comment-only edit must not rotate the dispatch keyspace.
    const plain = hashOf(schemaWithCaveat("x int", "x > 1"));
    const commentedText =
      "// caveat doc\n" +
      schemaWithCaveat("x int", "x > 1")
        .replace("definition document {", "// document doc\ndefinition document {\n  // viewer doc")
        .replace("permission view", "/* view doc */ permission view");
    const compiled = compileSchema(commentedText);
    expect(compiled.namespaces.filter((n) => n.name === "document")[0]?.comments).toEqual([
      "// document doc",
    ]);

    expect(hashOf(commentedText)).toBe(plain);
  });
});
