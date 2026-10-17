import { describe, expect, it } from "vitest";

import { caveatDefinitionEquals, type CaveatDefinition } from "@benedb/core/caveat-definition";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import type { Relation } from "@benedb/core/relation";

import type { CompiledSchema } from "./compiled-schema";
import { compileSchema } from "./schema-compiler";

// Ported from `tests/Spiceport.Schema.Tests/SchemaCompilerDocCommentTests.cs`, case for case. The
// schema text of every case is the C# schema verbatim.
//
// Doc comments: SpiceDB's parser attaches every comment lexed since the previous significant token
// to the next token (pkg/schemadsl/parser/parser_impl.go consumeToken), and the translator turns
// the ones on a definition, relation, permission or caveat node into DocComment metadata, each
// comment verbatim with its markers and every line whitespace-trimmed
// (pkg/schemadsl/compiler/translator.go addComments / normalizeComment). A newline after an
// identifier, keyword, `}`, `)` or `*` lexes as a synthetic semicolon, which takes any comments
// before it with it, so a trailing comment on a statement line never reaches the next statement.
//
// Port decisions pinned here:
//
// 1. The C# `Comments` is an `ImmutableList<string>` defaulting to empty; here it is an optional
//    `readonly string[]` whose absence means none. The compiler always sets it, so a compiled
//    declaration without comments carries `[]`, which `toEqual([])` pins.
// 2. `Assert.Equal(plain, commented)` on two `CaveatDefinition` records is the record's custom
//    equality, which is core's `caveatDefinitionEquals` here. It ignores comments.

function def(compiled: CompiledSchema, name: string): NamespaceDefinition {
  const found = compiled.namespaces.filter((n) => n.name === name);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function rel(definition: NamespaceDefinition, name: string): Relation {
  const found = definition.relations.filter((r) => r.name === name);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function onlyCaveat(compiled: CompiledSchema): CaveatDefinition {
  expect(compiled.caveats).toHaveLength(1);
  return compiled.caveats[0]!;
}

describe("SchemaCompilerDocCommentTests", () => {
  it("Leading_line_comments_attach_to_the_definition_in_order_across_blank_lines", () => {
    const compiled = compileSchema("// def doc\n\n// second\ndefinition user {}\n");

    expect(def(compiled, "user").comments).toEqual(["// def doc", "// second"]);
  });

  it("A_block_comment_keeps_its_markers_and_has_every_line_trimmed", () => {
    const compiled = compileSchema(
      "/**\n   * Line one\n   *   indented\n   */\ndefinition user {}\n",
    );

    expect(def(compiled, "user").comments).toEqual(["/**\n* Line one\n*   indented\n*/"]);
  });

  it("Line_comment_padding_is_trimmed_and_blank_block_lines_survive", () => {
    const compiled = compileSchema("\t//   padded   \n\t/*  a  \n\n   b */\ndefinition user {}\n");

    expect(def(compiled, "user").comments).toEqual(["//   padded", "/*  a\n\nb */"]);
  });

  it("Relation_and_permission_comments_attach_to_their_own_declarations", () => {
    const compiled = compileSchema(`/* d */ definition user {}
definition document { // after brace
  // viewer doc
  relation viewer: user // trailing
  relation editor: user; // after semi
  relation owner: user
  /* perm */
  permission view = viewer + /* inner */ editor
  // dangling
}
// after def
definition other {} // trailing brace
definition third {}`);

    expect(def(compiled, "user").comments).toEqual(["/* d */"]);

    const document = def(compiled, "document");
    expect(document.comments).toEqual([]);
    expect(rel(document, "viewer").comments).toEqual(["// after brace", "// viewer doc"]);
    expect(rel(document, "editor").comments).toEqual([]);
    expect(rel(document, "owner").comments).toEqual(["// after semi"]);
    expect(rel(document, "view").comments).toEqual(["/* perm */"]);

    expect(def(compiled, "other").comments).toEqual(["// after def"]);
    expect(def(compiled, "third").comments).toEqual([]);
  });

  it("A_trailing_comment_after_a_wildcard_or_paren_is_dropped", () => {
    const compiled = compileSchema(`definition user {}
definition document {
  relation viewer: user:* // star trailing
  relation editor: user
  permission view = (viewer) // paren trailing
  permission edit = editor
}`);

    const document = def(compiled, "document");
    expect(rel(document, "editor").comments).toEqual([]);
    expect(rel(document, "edit").comments).toEqual([]);
  });

  it("Caveat_comments_attach_to_the_caveat_and_body_comments_do_not_leak", () => {
    const compiled = compileSchema(
      "// cav doc\ncaveat c(x int) {\n  x > 1 // in body\n}\ndefinition user {}\n",
    );

    expect(onlyCaveat(compiled).comments).toEqual(["// cav doc"]);
    expect(def(compiled, "user").comments).toEqual([]);
  });

  it("A_line_comment_stops_before_a_carriage_return", () => {
    const compiled = compileSchema("// crlf doc  \r\ndefinition user {}\r\n");

    expect(def(compiled, "user").comments).toEqual(["// crlf doc"]);
  });

  it("A_schema_without_comments_compiles_to_empty_comment_lists", () => {
    const compiled = compileSchema(
      "caveat c(x int) { x > 1 }\ndefinition user { relation self_rel: user }\n",
    );

    expect(def(compiled, "user").comments).toEqual([]);
    expect(rel(def(compiled, "user"), "self_rel").comments).toEqual([]);
    expect(onlyCaveat(compiled).comments).toEqual([]);
  });

  it("Comments_take_no_part_in_caveat_equality", () => {
    const plain = onlyCaveat(compileSchema("caveat c(x int) { x > 1 }"));
    const commented = onlyCaveat(compileSchema("// doc\ncaveat c(x int) { x > 1 }"));

    expect(caveatDefinitionEquals(plain, commented)).toBe(true);
  });
});
