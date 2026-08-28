import { describe, expect, it } from "vitest";

import type {
  ArrowExpr,
  BinaryExpr,
  CaveatNode,
  DefinitionNode,
  ExprNode,
  ReferenceExpr,
} from "./ast";
import { parse } from "./parser";
import { SchemaCompileException } from "./schema-compile-exception";

// Ported from `SchemaCompilerTests`. The C# cases drive `SchemaCompiler`, which is not in this
// batch; each is re-expressed here against the AST the parser hands the compiler, keeping the case
// and its assertions. The schema text of every ported case is the C# schema verbatim.
//
// Port decisions pinned here:
//
// 1. PRECEDENCE IS NOT SPICEDB'S. The chain is exclusion -> intersection -> union -> primary, so
//    '+' binds TIGHTEST and '-' loosest: `a + b & c - nil` is `((a + b) & c) - nil`.
//    `RespectsPrecedenceUnionAboveIntersectionAboveExclusion` pins it in the C#; it is
//    transliterated, not corrected.
// 2. All three operator loops are LEFT-associative and build nested binary nodes. Flattening
//    `a + b + c` into one n-ary union is the compiler's job (`FlattensAssociativeUnion`), not the
//    parser's, so the parser still yields `((a + b) + c)` here.
// 3. The caveat body is sliced from the ORIGINAL SOURCE between the brace tokens' offsets and then
//    trimmed with .NET `string.Trim()` semantics: U+0085 IS whitespace to .NET (JS `trim` leaves
//    it) and U+FEFF is NOT (JS `trim` strips it). The trimmed text is UTF-8 encoded into
//    `CaveatDefinition.SerializedExpression`, so the difference is wire-visible.
// 4. `TypeRefNode.subrelation` is undefined when absent. Defaulting it to the ellipsis is the
//    compiler's job, not the parser's.
// 5. Two rejections are EMERGENT rather than explicit checks, and the port must preserve the
//    control flow rather than add a guard: repeated `with` falls out of the definition-body loop
//    (`RejectsRepeatedWith`), and `with expiration` without `use expiration` parses `expiration` as
//    an ordinary CAVEAT NAME (`RejectsWithExpirationWithoutUseFlag`).
function single<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected exactly one item");
  }

  return item;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`no item at index ${index}`);
  }

  return item;
}

function definition(source: string, name: string): DefinitionNode {
  return single(parse(source).definitions.filter((d) => d.name === name));
}

function permissionExpr(source: string, definitionName: string, permission: string): ExprNode {
  const owner = definition(source, definitionName);
  return single(owner.permissions.filter((p) => p.name === permission)).expression;
}

function binary(expr: ExprNode): BinaryExpr {
  expect(expr.kind).toBe("binary");
  return expr as BinaryExpr;
}

function reference(expr: ExprNode): ReferenceExpr {
  expect(expr.kind).toBe("reference");
  return expr as ReferenceExpr;
}

function arrow(expr: ExprNode): ArrowExpr {
  expect(expr.kind).toBe("arrow");
  return expr as ArrowExpr;
}

function compileError(source: string): SchemaCompileException {
  try {
    parse(source);
  } catch (error) {
    if (error instanceof SchemaCompileException) {
      return error;
    }

    throw error;
  }

  throw new Error("expected parse to throw a SchemaCompileException");
}

describe("parser", () => {
  it("parses a basic document schema", () => {
    const schema = [
      "definition user {}",
      "",
      "definition document {",
      "  relation owner: user",
      "  relation editor: user",
      "  permission read = owner + editor",
      "  permission write = owner",
      "}",
    ].join("\n");

    const file = parse(schema);

    expect(file.definitions).toHaveLength(2);
    expect(file.caveats).toHaveLength(0);

    const user = at(file.definitions, 0);
    expect(user.name).toBe("user");
    expect(user.relations).toHaveLength(0);
    expect(user.permissions).toHaveLength(0);

    const doc = at(file.definitions, 1);
    expect(doc.name).toBe("document");
    expect(doc.relations.map((r) => r.name)).toEqual(["owner", "editor"]);
    expect(doc.permissions.map((p) => p.name)).toEqual(["read", "write"]);

    const owner = single(doc.relations.filter((r) => r.name === "owner"));
    const allowed = single(owner.allowedTypes);
    expect(allowed.typeName).toBe("user");
    expect(allowed.isWildcard).toBe(false);
    // Left undefined by the parser; the compiler is what defaults it to the ellipsis.
    expect(allowed.subrelation).toBeUndefined();
    expect(allowed.caveatName).toBeUndefined();
    expect(allowed.requiresExpiration).toBe(false);

    const read = binary(single(doc.permissions.filter((p) => p.name === "read")).expression);
    expect(read.op).toBe("union");
    expect(reference(read.left).name).toBe("owner");
    expect(reference(read.right).name).toBe("editor");

    const write = single(doc.permissions.filter((p) => p.name === "write")).expression;
    expect(reference(write).name).toBe("owner");
  });

  it("parses wildcard and subrelation type refs", () => {
    const schema = [
      "definition resource {",
      "  relation viewer: user:* | group#member | user",
      "}",
    ].join("\n");

    const viewer = single(single(parse(schema).definitions).relations);
    const types = viewer.allowedTypes;

    expect(types).toHaveLength(3);

    expect(at(types, 0).isWildcard).toBe(true);
    expect(at(types, 0).typeName).toBe("user");
    expect(at(types, 0).subrelation).toBeUndefined();

    expect(at(types, 1).typeName).toBe("group");
    expect(at(types, 1).subrelation).toBe("member");
    expect(at(types, 1).isWildcard).toBe(false);

    expect(at(types, 2).typeName).toBe("user");
    expect(at(types, 2).subrelation).toBeUndefined();
    expect(at(types, 2).isWildcard).toBe(false);
  });

  it("parses an explicit '#...' subrelation as the ellipsis", () => {
    const viewer = single(
      single(parse("definition r { relation v: user#... }").definitions).relations,
    );

    expect(single(viewer.allowedTypes).subrelation).toBe("...");
  });

  it("parses an arrow expression", () => {
    const schema = [
      "definition folder {",
      "  relation parent: folder",
      "  relation viewer: user",
      "  permission view = viewer + parent->view",
      "}",
    ].join("\n");

    const view = binary(permissionExpr(schema, "folder", "view"));

    expect(view.op).toBe("union");
    expect(reference(view.left).name).toBe("viewer");

    const target = arrow(view.right);
    expect(target.tupleset).toBe("parent");
    expect(target.computed).toBe("view");
    expect(target.functionName).toBeUndefined();
  });

  it("parses a functioned arrow", () => {
    const any = arrow(permissionExpr("definition t { permission p = parent.any(view) }", "t", "p"));

    expect(any.tupleset).toBe("parent");
    expect(any.computed).toBe("view");
    expect(any.functionName).toBe("any");
  });

  it("binds '+' tightest and '-' loosest", () => {
    // a + b & c - nil  ==>  (((a + b) & c) - nil)
    const schema = ["definition t {", "  permission p = a + b & c - nil", "}"].join("\n");

    const exclusion = binary(permissionExpr(schema, "t", "p"));
    expect(exclusion.op).toBe("exclusion");
    expect(exclusion.right.kind).toBe("nil");

    const intersection = binary(exclusion.left);
    expect(intersection.op).toBe("intersection");
    expect(reference(intersection.right).name).toBe("c");

    const union = binary(intersection.left);
    expect(union.op).toBe("union");
    expect(reference(union.left).name).toBe("a");
    expect(reference(union.right).name).toBe("b");
  });

  it("builds left-associative chains, leaving flattening to the compiler", () => {
    const schema = ["definition t {", "  permission p = a + b + c", "}"].join("\n");

    const outer = binary(permissionExpr(schema, "t", "p"));
    expect(outer.op).toBe("union");
    expect(reference(outer.right).name).toBe("c");

    const inner = binary(outer.left);
    expect(inner.op).toBe("union");
    expect(reference(inner.left).name).toBe("a");
    expect(reference(inner.right).name).toBe("b");
  });

  it("lets parentheses override the precedence chain", () => {
    const grouped = binary(permissionExpr("definition t { permission p = a & (b - c) }", "t", "p"));

    expect(grouped.op).toBe("intersection");
    expect(binary(grouped.right).op).toBe("exclusion");
  });

  it("parses a caveat block and the relation that references it", () => {
    const schema = [
      "caveat ip_allowlist(user_ip ipaddress, cidr string) {",
      "  user_ip.in_cidr(cidr)",
      "}",
      "",
      "definition resource {",
      "  relation viewer: user with ip_allowlist",
      "}",
    ].join("\n");

    const file = parse(schema);
    const caveat = single(file.caveats);

    expect(caveat.name).toBe("ip_allowlist");
    expect(caveat.expression).toBe("user_ip.in_cidr(cidr)");
    expect(caveat.parameters.map((p) => p.name)).toEqual(["user_ip", "cidr"]);
    expect(at(caveat.parameters, 0).type.name).toBe("ipaddress");
    expect(at(caveat.parameters, 0).type.childTypes).toHaveLength(0);

    const viewer = single(single(file.definitions).relations);
    const allowed = single(viewer.allowedTypes);
    expect(allowed.caveatName).toBe("ip_allowlist");
    expect(allowed.requiresExpiration).toBe(false);
  });

  it("parses generic caveat parameter types", () => {
    const schema = [
      "caveat ip_allowlist(user_ip ipaddress, allowed_ips list<string>) {",
      "  user_ip in allowed_ips",
      "}",
      "",
      "definition resource {",
      "  relation viewer: user with ip_allowlist",
      "}",
    ].join("\n");

    const caveat = single(parse(schema).caveats);

    expect(caveat.expression).toBe("user_ip in allowed_ips");
    expect(caveat.parameters).toHaveLength(2);

    const listType = at(caveat.parameters, 1).type;
    expect(listType.name).toBe("list");
    expect(single(listType.childTypes).name).toBe("string");
  });

  it("parses nested and multi-argument generic caveat parameter types", () => {
    const caveat = single(parse("caveat c(m map<string, list<int>>) { true }").caveats);
    const map = single(caveat.parameters).type;

    expect(map.name).toBe("map");
    expect(map.childTypes.map((c) => c.name)).toEqual(["string", "list"]);
    expect(single(at(map.childTypes, 1).childTypes).name).toBe("int");
  });

  it("parses a caveat with no parameters", () => {
    const caveat = single(parse("caveat c() { true }").caveats);

    expect(caveat.parameters).toHaveLength(0);
    expect(caveat.expression).toBe("true");
  });

  it("parses both definitions and caveats from one file", () => {
    const schema = ["caveat c(x int) { x > 0 }", "definition user {}"].join("\n");
    const file = parse(schema);

    expect(file.definitions.map((d) => d.name)).toEqual(["user"]);
    expect(single(file.caveats).expression).toBe("x > 0");
  });

  describe("caveat body capture", () => {
    function body(source: string): CaveatNode {
      return single(parse(source).caveats);
    }

    it("captures the body verbatim between the braces", () => {
      expect(body("caveat c(x int) {  x > 0 && x < 10  }").expression).toBe("x > 0 && x < 10");
    });

    it("counts brace tokens, so nested braces stay inside the body", () => {
      expect(body("caveat c(x int) { {x: 1}.x > 0 }").expression).toBe("{x: 1}.x > 0");
    });

    it("does not see braces inside a CEL string literal", () => {
      expect(body('caveat c(x string) { x == "}" }').expression).toBe('x == "}"');
    });

    it("does not see braces inside a comment, but keeps the comment text in the body", () => {
      expect(body("caveat c(x int) { x > 0 /* } */ }").expression).toBe("x > 0 /* } */");
    });

    it("keeps arbitrary CEL operators, which lex as unknown tokens", () => {
      expect(body("caveat c(x int) { !(x % 2 == 0) ? true : false }").expression).toBe(
        "!(x % 2 == 0) ? true : false",
      );
    });

    it("trims U+0085, which is whitespace to .NET Trim but not to JS trim", () => {
      // The body slice is trimmed with .NET `string.Trim()` semantics, which treat U+0085 (NEL)
      // as whitespace. JS `String.prototype.trim` does not, so a plain `.trim()` leaves it in
      // and it reaches the wire inside `CaveatDefinition.SerializedExpression`.
      expect(body("caveat c(x int) {\u0085x > 0\u0085}").expression).toBe("x > 0");
    });

    it("keeps U+FEFF, which is whitespace to JS trim but not to .NET Trim", () => {
      // The mirror image: JS `trim` strips U+FEFF and .NET `Trim` does not, so a plain `.trim()`
      // silently deletes a byte the C# would have serialized.
      expect(body("caveat c(x int) {\uFEFF x > 0 }").expression).toBe("\uFEFF x > 0");
    });

    it("rejects an unterminated caveat body", () => {
      expect(() => parse("caveat c(x int) { x > 0")).toThrow(SchemaCompileException);
      expect(() => parse("caveat c(x int) { x > 0")).toThrow("unterminated caveat body");
    });
  });

  describe("traits", () => {
    it("parses `with expiration` and `with <caveat> and expiration` under `use expiration`", () => {
      const schema = [
        "use expiration",
        "",
        "definition document {",
        "  relation viewer: user with expiration",
        "  relation editor: user with some_caveat and expiration",
        "}",
      ].join("\n");

      const file = parse(schema);
      const doc = single(file.definitions);
      expect(file.caveats).toHaveLength(0);

      const viewer = single(
        doc.relations.filter((r) => r.name === "viewer").flatMap((r) => r.allowedTypes),
      );
      expect(viewer.requiresExpiration).toBe(true);
      expect(viewer.caveatName).toBeUndefined();

      const editor = single(
        doc.relations.filter((r) => r.name === "editor").flatMap((r) => r.allowedTypes),
      );
      expect(editor.requiresExpiration).toBe(true);
      expect(editor.caveatName).toBe("some_caveat");
    });

    it("parses `expiration` as an ordinary caveat name without the use flag", () => {
      // Without `use expiration` the identifier is never promoted, so this is a caveat reference
      // that later fails caveat-existence validation rather than silently enabling expiration.
      const schema = [
        "definition user {}",
        "",
        "definition document {",
        "  relation viewer: user with expiration",
        "}",
      ].join("\n");

      const allowed = single(single(definition(schema, "document").relations).allowedTypes);

      expect(allowed.requiresExpiration).toBe(false);
      expect(allowed.caveatName).toBe("expiration");
    });

    it("rejects 'and' that is not followed by 'expiration'", () => {
      const error = compileError(
        "use expiration\ndefinition d { relation r: user with c and other }",
      );

      expect(error.message).toContain("expected 'expiration' after 'and'");
    });

    it("rejects a repeated `with`, via the definition-body loop", () => {
      const schema = [
        "definition document {",
        "  relation viewer: user with cav1 with cav2",
        "}",
      ].join("\n");

      const error = compileError(schema);

      expect(error.message).toContain("expected 'relation' or 'permission'");
      expect(error.line).toBe(2);
    });
  });

  describe("the self operand", () => {
    it("parses `self` as its own operand under `use self`", () => {
      const schema = [
        "use self",
        "",
        "definition user {}",
        "",
        "definition document {",
        "  relation viewer: user",
        "  permission view = self + viewer",
        "}",
      ].join("\n");

      const view = binary(permissionExpr(schema, "document", "view"));

      expect(view.op).toBe("union");
      expect(view.left.kind).toBe("self");
      expect(reference(view.right).name).toBe("viewer");
    });

    it("parses `self` as an ordinary reference without the flag", () => {
      const schema = ["definition document {", "  permission view = self", "}"].join("\n");

      expect(reference(permissionExpr(schema, "document", "view")).name).toBe("self");
    });
  });

  describe("path, annotation and terminator handling", () => {
    it("joins a slash-separated type path", () => {
      const file = parse("definition org/user { relation r: org/dept/group#member }");

      expect(single(file.definitions).name).toBe("org/user");
      expect(single(single(single(file.definitions).relations).allowedTypes).typeName).toBe(
        "org/dept/group",
      );
    });

    it("parses and discards a permission type annotation", () => {
      const schema = "definition t { permission p: user | org/user = a }";
      const permission = single(single(parse(schema).definitions).permissions);

      expect(permission.name).toBe("p");
      expect(reference(permission.expression).name).toBe("a");
    });

    it("treats semicolons as optional everywhere", () => {
      const withSemis = parse("definition t { relation r: user; permission p = r; };");
      const without = parse("definition t { relation r: user permission p = r }");

      expect(withSemis).toEqual(without);
    });
  });

  describe("errors", () => {
    it("throws with a line for a malformed schema", () => {
      const error = compileError("definition document { relation owner }");

      expect(error.line).toBeGreaterThan(0);
      expect(error.message).toContain("expected ':'");
    });

    it("rejects nested arrows with SpiceDB's diagnostic", () => {
      const schema = ["definition document {", "  permission view = a->b->c", "}"].join("\n");

      expect(() => parse(schema)).toThrow(SchemaCompileException);
      expect(() => parse(schema)).toThrow("Nested arrows not yet supported");
    });

    it("rejects an arrow chained through a function call", () => {
      expect(() => parse("definition d { permission p = a->b.any(c) }")).toThrow(
        "Nested arrows not yet supported",
      );
    });

    it("rejects a top-level construct that is neither a definition nor a caveat", () => {
      const error = compileError("relation r: user");

      expect(error.message).toContain("expected 'definition' or 'caveat', found 'relation'");
    });

    it("reports <eof> rather than an empty token text at end of input", () => {
      const error = compileError("definition");

      expect(error.message).toContain("<eof>");
    });

    it("rejects a body member that is neither a relation nor a permission", () => {
      const error = compileError("definition d { caveat c }");

      expect(error.message).toContain("expected 'relation' or 'permission', found 'caveat'");
    });

    it("rejects an expression with no operand", () => {
      const error = compileError("definition d { permission p = + }");

      expect(error.message).toContain("expected an expression operand");
    });

    it("parses an empty file into an empty schema", () => {
      const file = parse("");

      expect(file.definitions).toHaveLength(0);
      expect(file.caveats).toHaveLength(0);
    });
  });
});
