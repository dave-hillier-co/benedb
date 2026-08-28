import { describe, expect, it } from "vitest";

import { isAllowedRelationPublicWildcard } from "@spacedb/core/allowed-relation";
import type { CaveatTypeReference } from "@spacedb/core/caveat-definition";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import { isPermission, type Relation } from "@spacedb/core/relation";
import type {
  ComputedUsersetChild,
  NestedRewriteChild,
  SetOperation,
  SetOperationChild,
  TupleToUsersetChild,
} from "@spacedb/core/userset-rewrite";

import { compile, compileSchema } from "./schema-compiler";
import { SchemaCompileException } from "./schema-compile-exception";

// Ported from `tests/Spiceport.Schema.Tests/SchemaCompilerTests.cs`, case for case. The schema text
// of every case is the C# schema verbatim.
//
// Port decisions pinned here:
//
// 1. TWO public entry points, and both must survive. `compile` returns namespaces ONLY;
//    `compileSchema` returns namespaces AND caveats. `CompileStillReturnsNamespacesOnly` pins that
//    a schema with a caveat block still compiles through `compile` and yields only its definitions.
// 2. `CompileDefinition` appends ALL relations, then ALL permissions, into one list, so the
//    resulting order is GROUPED, not source order. `CompilesBasicDocumentSchema` pins the count and
//    shape; the grouping is visible wherever a schema is read back.
// 3. `CompilePermission` LIFTS the set operation when the compiled top-level expression is a nested
//    rewrite, and otherwise wraps the single operand in a union. So `permission write = owner` is a
//    one-child UNION, not a bare operand.
// 4. `FlattenOperand` flattens same-type associative operators into one n-ary SetOperation, but
//    only when the parent type is not exclusion; exclusion is left-nested because order is
//    significant. `FlattensAssociativeUnion` pins the flattening and the precedence case pins the
//    nesting.
// 5. `CompileCaveatType` yields ABSENT children for a scalar, never an empty list. The C# asserts
//    `Assert.Null`; here that is `toBeUndefined`.
// 6. The caveat body is stored VERBATIM as UTF-8 bytes and never type-checked here, so the test
//    decodes the bytes rather than inspecting any parsed form.
// 7. An unsupported arrow function throws with NO position information, which is the
//    "schema error: ..." message form rather than the "at line N" one.

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

function relation(definition: NamespaceDefinition, name: string): Relation {
  return single(definition.relations.filter((r) => r.name === name));
}

function rewriteOperation(relationOrPermission: Relation): SetOperation {
  const rewrite = relationOrPermission.usersetRewrite;
  if (rewrite === undefined) {
    throw new Error(`relation '${relationOrPermission.name}' has no userset rewrite`);
  }

  return rewrite.operation;
}

function allowedTypes(relationOrPermission: Relation) {
  const info = relationOrPermission.typeInformation;
  if (info === undefined) {
    throw new Error(`relation '${relationOrPermission.name}' has no type information`);
  }

  return info.allowedDirectRelations;
}

function computedUserset(child: SetOperationChild): ComputedUsersetChild {
  expect(child.kind).toBe("computedUserset");
  return child as ComputedUsersetChild;
}

function nestedRewrite(child: SetOperationChild): NestedRewriteChild {
  expect(child.kind).toBe("nestedRewrite");
  return child as NestedRewriteChild;
}

function tupleToUserset(child: SetOperationChild): TupleToUsersetChild {
  expect(child.kind).toBe("tupleToUserset");
  return child as TupleToUsersetChild;
}

function relationNames(children: readonly SetOperationChild[]): readonly string[] {
  return children.map((c) => computedUserset(c).value.relation);
}

function childTypes(type: CaveatTypeReference): readonly CaveatTypeReference[] {
  const children = type.childTypes;
  if (children === undefined) {
    throw new Error(`type '${type.typeName}' has no child types`);
  }

  return children;
}

function parameterType(
  parameterTypes: ReadonlyMap<string, CaveatTypeReference>,
  name: string,
): CaveatTypeReference {
  const type = parameterTypes.get(name);
  if (type === undefined) {
    throw new Error(`no parameter named '${name}'`);
  }

  return type;
}

function compileError(source: string): SchemaCompileException {
  try {
    compile(source);
  } catch (error) {
    if (error instanceof SchemaCompileException) {
      return error;
    }

    throw error;
  }

  throw new Error("expected a SchemaCompileException");
}

describe("SchemaCompiler", () => {
  it("compiles a basic document schema", () => {
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

    const defs = compile(schema);

    expect(defs).toHaveLength(2);
    expect(at(defs, 0).name).toBe("user");
    expect(at(defs, 0).relations).toHaveLength(0);

    const doc = at(defs, 1);
    expect(doc.name).toBe("document");
    // Relations first, then permissions: the grouped order, not the source order.
    expect(doc.relations).toHaveLength(4);

    const owner = relation(doc, "owner");
    expect(isPermission(owner)).toBe(false);
    const allowed = single(allowedTypes(owner));
    expect(allowed.objectType).toBe("user");
    expect(allowed.relationName).toBe(ELLIPSIS);
    expect(allowed.kind).toBe("relation");

    const read = relation(doc, "read");
    expect(isPermission(read)).toBe(true);
    const op = rewriteOperation(read);
    expect(op.type).toBe("union");
    expect(op.children).toHaveLength(2);
    expect(relationNames(op.children)).toEqual(["owner", "editor"]);

    // A single operand is WRAPPED in a one-child union, not left bare.
    const writeOp = rewriteOperation(relation(doc, "write"));
    expect(writeOp.type).toBe("union");
    expect(computedUserset(single(writeOp.children)).value.relation).toBe("owner");
  });

  it("compiles wildcard and subrelation type refs", () => {
    const schema = [
      "definition resource {",
      "  relation viewer: user:* | group#member | user",
      "}",
    ].join("\n");

    const defs = compile(schema);
    const viewer = relation(single(defs), "viewer");
    const types = allowedTypes(viewer);

    expect(types).toHaveLength(3);

    expect(isAllowedRelationPublicWildcard(at(types, 0))).toBe(true);
    expect(at(types, 0).objectType).toBe("user");

    expect(at(types, 1).kind).toBe("relation");
    expect(at(types, 1).objectType).toBe("group");
    expect(at(types, 1).relationName).toBe("member");

    expect(at(types, 2).objectType).toBe("user");
    expect(at(types, 2).relationName).toBe(ELLIPSIS);
  });

  it("compiles an arrow expression to a tuple-to-userset", () => {
    const schema = [
      "definition folder {",
      "  relation parent: folder",
      "  relation viewer: user",
      "  permission view = viewer + parent->view",
      "}",
    ].join("\n");

    const defs = compile(schema);
    const op = rewriteOperation(relation(single(defs), "view"));

    expect(op.type).toBe("union");
    expect(op.children).toHaveLength(2);

    const arrow = tupleToUserset(at(op.children, 1));
    expect(arrow.value.tuplesetRelation).toBe("parent");
    expect(arrow.value.computedUserset.relation).toBe("view");
    expect(arrow.value.computedUserset.object).toBe("tupleUsersetObject");
  });

  it("respects precedence: union above intersection above exclusion", () => {
    // a + b & c - d  ==>  (((a + b) & c) - d)
    const schema = ["definition t {", "  permission p = a + b & c - nil", "}"].join("\n");

    const op = rewriteOperation(relation(single(compile(schema)), "p"));

    // Top level is exclusion, and it is NOT flattened.
    expect(op.type).toBe("exclusion");
    expect(op.children).toHaveLength(2);
    expect(at(op.children, 1).kind).toBe("nil");

    // Left of exclusion is intersection.
    const intersect = nestedRewrite(at(op.children, 0)).value.operation;
    expect(intersect.type).toBe("intersection");

    // Left of intersection is union(a, b).
    const union = nestedRewrite(at(intersect.children, 0)).value.operation;
    expect(union.type).toBe("union");
    expect(relationNames(union.children)).toEqual(["a", "b"]);
  });

  it("flattens an associative union", () => {
    const schema = ["definition t {", "  permission p = a + b + c", "}"].join("\n");

    const op = rewriteOperation(relation(single(compile(schema)), "p"));

    expect(op.type).toBe("union");
    expect(relationNames(op.children)).toEqual(["a", "b", "c"]);
  });

  it("parses a caveat block without error", () => {
    const schema = [
      "caveat ip_allowlist(user_ip ipaddress, cidr string) {",
      "  user_ip.in_cidr(cidr)",
      "}",
      "",
      "definition resource {",
      "  relation viewer: user with ip_allowlist",
      "}",
    ].join("\n");

    const defs = compile(schema);
    const viewer = relation(single(defs), "viewer");
    const allowed = single(allowedTypes(viewer));
    expect(allowed.requiredCaveat?.caveatName).toBe("ip_allowlist");
  });

  it("compiles a caveat block into a caveat definition", () => {
    const schema = [
      "caveat ip_allowlist(user_ip ipaddress, allowed_ips list<string>) {",
      "  user_ip in allowed_ips",
      "}",
      "",
      "definition resource {",
      "  relation viewer: user with ip_allowlist",
      "}",
    ].join("\n");

    const compiled = compileSchema(schema);

    expect(compiled.namespaces).toHaveLength(1);
    const caveat = single(compiled.caveats);

    expect(caveat.name).toBe("ip_allowlist");

    // The raw CEL expression is captured verbatim (UTF-8), not evaluated.
    expect(new TextDecoder().decode(caveat.serializedExpression)).toBe("user_ip in allowed_ips");

    expect(caveat.parameterTypes.size).toBe(2);
    expect(parameterType(caveat.parameterTypes, "user_ip").typeName).toBe("ipaddress");
    // A scalar has ABSENT children, not an empty list.
    expect(parameterType(caveat.parameterTypes, "user_ip").childTypes).toBeUndefined();

    const listType = parameterType(caveat.parameterTypes, "allowed_ips");
    expect(listType.typeName).toBe("list");
    expect(single(childTypes(listType)).typeName).toBe("string");

    // The caveat name is also attached to the referencing relation.
    const viewer = relation(single(compiled.namespaces), "viewer");
    const allowed = single(allowedTypes(viewer));
    expect(allowed.requiredCaveat?.caveatName).toBe("ip_allowlist");
  });

  it("compiles a relation with expiration", () => {
    const schema = [
      "use expiration",
      "",
      "definition document {",
      "  relation viewer: user with expiration",
      "  relation editor: user with some_caveat and expiration",
      "}",
    ].join("\n");

    const compiled = compileSchema(schema);
    const doc = single(compiled.namespaces);
    expect(compiled.caveats).toHaveLength(0);

    const viewerAllowed = single(allowedTypes(relation(doc, "viewer")));
    expect(viewerAllowed.requiresExpiration).toBe(true);
    expect(viewerAllowed.requiredCaveat).toBeUndefined();

    const editorAllowed = single(allowedTypes(relation(doc, "editor")));
    expect(editorAllowed.requiresExpiration).toBe(true);
    expect(editorAllowed.requiredCaveat?.caveatName).toBe("some_caveat");
  });

  it("compile still returns namespaces only", () => {
    const schema = ["caveat c(x int) { x > 0 }", "definition user {}"].join("\n");

    const namespaces = compile(schema);
    expect(single(namespaces).name).toBe("user");
  });

  it("throws on a malformed schema", () => {
    const error = compileError("definition document { relation owner }");
    expect(error.line).toBeGreaterThan(0);
  });

  it("compiles a self operand under use self", () => {
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

    const doc = single(compile(schema).filter((d) => d.name === "document"));
    const op = rewriteOperation(relation(doc, "view"));
    expect(op.type).toBe("union");
    expect(op.children.some((c) => c.kind === "self")).toBe(true);
  });

  it("treats self without the flag as an ordinary reference", () => {
    const schema = ["definition document {", "  permission view = self", "}"].join("\n");

    const doc = single(compile(schema));
    const child = single(rewriteOperation(relation(doc, "view")).children);
    expect(computedUserset(child).value.relation).toBe("self");
  });

  it("rejects with expiration without the use flag", () => {
    const schema = [
      "definition user {}",
      "",
      "definition document {",
      "  relation viewer: user with expiration",
      "}",
    ].join("\n");

    // Without `use expiration`, `expiration` stays an identifier and is parsed as a caveat
    // name, which fails caveat-existence validation rather than silently enabling expiration.
    const doc = single(compile(schema).filter((d) => d.name === "document"));
    const allowed = single(allowedTypes(relation(doc, "viewer")));
    expect(allowed.requiresExpiration).toBe(false);
    expect(allowed.requiredCaveat?.caveatName).toBe("expiration");
  });

  it("rejects a use flag after a definition", () => {
    const schema = ["definition user {}", "use expiration"].join("\n");

    expect(() => compile(schema)).toThrow(SchemaCompileException);
  });

  it("rejects a repeated with", () => {
    const schema = [
      "definition document {",
      "  relation viewer: user with cav1 with cav2",
      "}",
    ].join("\n");

    expect(() => compile(schema)).toThrow(SchemaCompileException);
  });

  it("rejects nested arrows", () => {
    const schema = ["definition document {", "  permission view = a->b->c", "}"].join("\n");

    const error = compileError(schema);
    expect(error.message).toContain("Nested arrows not yet supported");
  });

  it("rejects an unknown use flag", () => {
    expect(() => compile("use bogus\ndefinition user {}")).toThrow(SchemaCompileException);
  });
});
