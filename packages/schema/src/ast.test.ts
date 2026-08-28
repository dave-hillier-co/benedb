import type { SetOperationType } from "@spacedb/core/userset-rewrite";
import { describe, expect, it } from "vitest";

import type {
  ArrowExpr,
  BinaryExpr,
  CaveatNode,
  DefinitionNode,
  ExprNode,
  NilExpr,
  PermissionNode,
  RelationNode,
  SchemaFileNode,
  SelfExpr,
  SetOp,
  TypeRefNode,
} from "./ast";

// Characterization of Spiceport `Ast.cs`. There is no covering C# test: the records are pure data
// with no behaviour, and `SchemaCompilerTests` never observes an AST node directly. This file
// exists to pin the shape the parser produces and the compiler consumes, since nothing else will
// for some time.
//
// Port decisions pinned here:
//
// 1. Every AST type is `internal` in C#. TypeScript has no `internal`, and there are no barrels
//    here, so the containment is simply that nothing outside this package imports them.
// 2. `ExprNode` is a sealed record hierarchy, so it becomes a discriminated union with a literal
//    `kind` plus a local `assertNever`. The `describeExpr` walk below is the exhaustiveness gate:
//    adding a variant without handling it must fail to compile.
// 3. AST `SetOp` and core `SetOperationType` are DELIBERATELY DISTINCT TYPES. In the C# they even
//    number differently (`SetOp` is 0/1/2, `SetOperationType` is 1/2/3) and `SchemaCompiler`
//    translates between them; keeping two types here preserves that boundary, so a future change
//    to either side cannot silently cross it.
// 4. `TypeRefNode.subrelation` is undefined when the `#relation` suffix is absent. The parser does
//    NOT default it to the ellipsis - the compiler does.
function assertNever(value: never): never {
  throw new Error(`unexpected expression node: ${JSON.stringify(value)}`);
}

function describeExpr(expr: ExprNode): string {
  switch (expr.kind) {
    case "reference":
      return expr.name;
    case "nil":
      return "nil";
    case "self":
      return "self";
    case "arrow":
      return expr.functionName === undefined
        ? `${expr.tupleset}->${expr.computed}`
        : `${expr.tupleset}.${expr.functionName}(${expr.computed})`;
    case "binary":
      return `(${describeExpr(expr.left)} ${expr.op} ${describeExpr(expr.right)})`;
    default:
      return assertNever(expr);
  }
}

// What `SchemaCompiler.CompileBinary` has to do: translate the parser's operator into the core
// model's. Two distinct types, one explicit table.
const SET_OP_TO_CORE: Readonly<Record<SetOp, SetOperationType>> = {
  union: "union",
  intersection: "intersection",
  exclusion: "exclusion",
};

describe("schema ast", () => {
  it("walks every expression variant through a kind switch", () => {
    const nil: NilExpr = { kind: "nil" };
    const self: SelfExpr = { kind: "self" };
    const arrow: ArrowExpr = {
      kind: "arrow",
      tupleset: "parent",
      computed: "view",
      functionName: undefined,
    };
    const functioned: ArrowExpr = {
      kind: "arrow",
      tupleset: "parent",
      computed: "view",
      functionName: "any",
    };
    const binary: BinaryExpr = {
      kind: "binary",
      op: "exclusion",
      left: { kind: "reference", name: "a" },
      right: nil,
    };

    expect(describeExpr(nil)).toBe("nil");
    expect(describeExpr(self)).toBe("self");
    expect(describeExpr(arrow)).toBe("parent->view");
    expect(describeExpr(functioned)).toBe("parent.any(view)");
    expect(describeExpr(binary)).toBe("(a exclusion nil)");
  });

  it("nests binary expressions, which is how the parser encodes associativity", () => {
    const chained: BinaryExpr = {
      kind: "binary",
      op: "union",
      left: {
        kind: "binary",
        op: "union",
        left: { kind: "reference", name: "a" },
        right: { kind: "reference", name: "b" },
      },
      right: { kind: "reference", name: "c" },
    };

    expect(describeExpr(chained)).toBe("((a union b) union c)");
  });

  it("keeps the AST operator distinct from the core set-operation type", () => {
    const ops: readonly SetOp[] = ["union", "intersection", "exclusion"];

    expect(ops.map((op) => SET_OP_TO_CORE[op])).toEqual(["union", "intersection", "exclusion"]);
  });

  it("leaves an absent subrelation, caveat and expiration trait unset on a type ref", () => {
    const bare: TypeRefNode = {
      typeName: "user",
      isWildcard: false,
      subrelation: undefined,
      caveatName: undefined,
      requiresExpiration: false,
    };

    expect(bare.subrelation).toBeUndefined();
    expect(bare.caveatName).toBeUndefined();
    expect(bare.requiresExpiration).toBe(false);
  });

  it("carries a wildcard, a subrelation and both traits when present", () => {
    const wildcard: TypeRefNode = {
      typeName: "user",
      isWildcard: true,
      subrelation: undefined,
      caveatName: undefined,
      requiresExpiration: false,
    };
    const traited: TypeRefNode = {
      typeName: "group",
      isWildcard: false,
      subrelation: "member",
      caveatName: "some_caveat",
      requiresExpiration: true,
    };

    expect(wildcard.isWildcard).toBe(true);
    expect(traited.subrelation).toBe("member");
    expect(traited.caveatName).toBe("some_caveat");
    expect(traited.requiresExpiration).toBe(true);
  });

  it("separates relations from permissions inside a definition", () => {
    const owner: RelationNode = {
      name: "owner",
      allowedTypes: [
        {
          typeName: "user",
          isWildcard: false,
          subrelation: undefined,
          caveatName: undefined,
          requiresExpiration: false,
        },
      ],
    };
    const read: PermissionNode = {
      name: "read",
      expression: { kind: "reference", name: "owner" },
    };
    const document: DefinitionNode = {
      name: "document",
      relations: [owner],
      permissions: [read],
    };

    expect(document.relations.map((r) => r.name)).toEqual(["owner"]);
    expect(document.permissions.map((p) => p.name)).toEqual(["read"]);
  });

  it("keeps caveat parameters in source order and nests their generic child types", () => {
    const caveat: CaveatNode = {
      name: "ip_allowlist",
      parameters: [
        { name: "user_ip", type: { name: "ipaddress", childTypes: [] } },
        {
          name: "allowed_ips",
          type: { name: "list", childTypes: [{ name: "string", childTypes: [] }] },
        },
      ],
      expression: "user_ip in allowed_ips",
    };

    expect(caveat.parameters.map((p) => p.name)).toEqual(["user_ip", "allowed_ips"]);
    expect(caveat.parameters.map((p) => p.type.name)).toEqual(["ipaddress", "list"]);
    expect(caveat.expression).toBe("user_ip in allowed_ips");
  });

  it("holds definitions and caveats as two separate lists at the file root", () => {
    const file: SchemaFileNode = { definitions: [], caveats: [] };

    expect(file.definitions).toEqual([]);
    expect(file.caveats).toEqual([]);
  });
});
