import { describe, expect, it } from "vitest";

import {
  computedUsersetObjectFromWire,
  computedUsersetObjectToWire,
  computedUsersetOnResource,
  setOperationChildEquals,
  setOperationEquals,
  setOperationExclusion,
  setOperationIntersection,
  setOperationTypeFromWire,
  setOperationTypeToWire,
  setOperationUnion,
  tupleToUsersetFunctionFromWire,
  tupleToUsersetFunctionToWire,
  usersetRewriteEquals,
  type ComputedUserset,
  type ComputedUsersetObject,
  type FunctionedTupleToUserset,
  type SetOperationChild,
  type SetOperationType,
  type TupleToUserset,
  type TupleToUsersetFunction,
  type UsersetRewrite,
} from "./userset-rewrite";

// Characterization of Spiceport `UsersetRewrite.cs` (no covering C# test).
//
// Port decisions pinned here:
//   * The three C# enums have EXPLICIT proto-mirroring values. `SetOperationType` starts at 1 -
//     there is no 0 - and that gap is load-bearing on the wire, so it gets its own case below.
//     It must never be conflated with the DSL-side `SetOp` enum in `Ast.cs`, which starts at 0.
//   * `SetOperationChild` is a sealed hierarchy with a private constructor, so it becomes a
//     discriminated union with a literal `kind`. The ABSTRACT BASE declares `OperationPath`,
//     which means EVERY variant carries it - including `This`, `Nil` and `Self`, which carry no
//     operand at all. `SetOperation` carries its own `OperationPath` separately.
//   * Rewrite trees are compared and cached. C# gives no usable structural equality here
//     (record equality over an `ImmutableList` member is reference equality), so the port
//     supplies explicit deep-equality helpers and these tests are their only gate.
describe("computed userset", () => {
  it("computes on the resource itself by default", () => {
    const cu = computedUsersetOnResource("view");

    expect(cu).toEqual({ object: "tupleObject", relation: "view" });
  });

  it("can be built for the traversed subject", () => {
    const cu: ComputedUserset = { object: "tupleUsersetObject", relation: "view" };

    expect(cu.object).toBe("tupleUsersetObject");
  });

  describe("wire encoding", () => {
    it.each([
      ["tupleObject", 0],
      ["tupleUsersetObject", 1],
    ] as [ComputedUsersetObject, number][])("maps %s to %i", (value, wire) => {
      expect(computedUsersetObjectToWire(value)).toBe(wire);
      expect(computedUsersetObjectFromWire(wire)).toBe(value);
    });

    it("returns undefined for an unknown wire value", () => {
      expect(computedUsersetObjectFromWire(2)).toBeUndefined();
      expect(computedUsersetObjectFromWire(-1)).toBeUndefined();
    });
  });
});

describe("tuple to userset", () => {
  it("pairs a tupleset relation with a computed userset", () => {
    const ttu: TupleToUserset = {
      tuplesetRelation: "parent",
      computedUserset: computedUsersetOnResource("view"),
    };

    expect(ttu.tuplesetRelation).toBe("parent");
    expect(ttu.computedUserset.relation).toBe("view");
  });

  it("carries an explicit aggregation function when functioned", () => {
    const fttu: FunctionedTupleToUserset = {
      function: "all",
      tuplesetRelation: "parent",
      computedUserset: computedUsersetOnResource("view"),
    };

    expect(fttu.function).toBe("all");
  });

  describe("function wire encoding", () => {
    it.each([
      ["unspecified", 0],
      ["any", 1],
      ["all", 2],
    ] as [TupleToUsersetFunction, number][])("maps %s to %i", (value, wire) => {
      expect(tupleToUsersetFunctionToWire(value)).toBe(wire);
      expect(tupleToUsersetFunctionFromWire(wire)).toBe(value);
    });

    it("returns undefined for an unknown wire value", () => {
      expect(tupleToUsersetFunctionFromWire(3)).toBeUndefined();
    });
  });
});

describe("set operation type", () => {
  // The proto numbering starts at 1. Renumbering this map, or adding a 0, is a wire break.
  it.each([
    ["union", 1],
    ["intersection", 2],
    ["exclusion", 3],
  ] as [SetOperationType, number][])("maps %s to %i", (value, wire) => {
    expect(setOperationTypeToWire(value)).toBe(wire);
    expect(setOperationTypeFromWire(wire)).toBe(value);
  });

  it("has no zero value: 0 is not a set operation type", () => {
    expect(setOperationTypeFromWire(0)).toBeUndefined();
    expect(setOperationTypeFromWire(4)).toBeUndefined();
  });
});

describe("set operation children", () => {
  const allSevenVariants: SetOperationChild[] = [
    { kind: "this" },
    { kind: "nil" },
    { kind: "self" },
    { kind: "computedUserset", value: computedUsersetOnResource("view") },
    {
      kind: "tupleToUserset",
      value: { tuplesetRelation: "parent", computedUserset: computedUsersetOnResource("view") },
    },
    {
      kind: "functionedTupleToUserset",
      value: {
        function: "any",
        tuplesetRelation: "parent",
        computedUserset: computedUsersetOnResource("view"),
      },
    },
    { kind: "nestedRewrite", value: { operation: setOperationUnion({ kind: "this" }) } },
  ];

  it("has exactly seven variants", () => {
    expect(allSevenVariants.map((child) => child.kind)).toEqual([
      "this",
      "nil",
      "self",
      "computedUserset",
      "tupleToUserset",
      "functionedTupleToUserset",
      "nestedRewrite",
    ]);
  });

  // The operation path is declared on the ABSTRACT BASE in the C#, so it is not a property of
  // the operand-bearing variants only. Every one of the seven can carry it.
  it.each(allSevenVariants.map((child) => [child.kind, child] as const))(
    "lets the %s variant carry an operation path",
    (_kind, child) => {
      const withPath: SetOperationChild = { ...child, operationPath: [0, 1, 2] };

      expect(withPath.operationPath).toEqual([0, 1, 2]);
    },
  );

  it("leaves the operation path undefined when not supplied", () => {
    for (const child of allSevenVariants) {
      expect(child.operationPath).toBeUndefined();
    }
  });
});

describe("set operation factories", () => {
  it("builds a union", () => {
    expect(setOperationUnion({ kind: "this" }).type).toBe("union");
  });

  it("builds an intersection", () => {
    expect(setOperationIntersection({ kind: "this" }).type).toBe("intersection");
  });

  it("builds an exclusion", () => {
    expect(setOperationExclusion({ kind: "this" }).type).toBe("exclusion");
  });

  it("collects rest parameters into the children list, in order", () => {
    const a: SetOperationChild = { kind: "computedUserset", value: computedUsersetOnResource("a") };
    const b: SetOperationChild = { kind: "computedUserset", value: computedUsersetOnResource("b") };

    expect(setOperationUnion(a, b).children).toEqual([a, b]);
  });

  it("does not validate arity: an empty children list is accepted", () => {
    // The C# `params` factories perform no arity check, despite the "at least one" doc comment.
    expect(setOperationIntersection().children).toEqual([]);
  });

  it("leaves the operation's own path undefined", () => {
    expect(setOperationUnion({ kind: "nil" }).operationPath).toBeUndefined();
  });

  it("carries an operation path of its own, separate from its children's", () => {
    const operation = {
      ...setOperationUnion({ kind: "this", operationPath: [1] }),
      operationPath: [0],
    };

    expect(operation.operationPath).toEqual([0]);
    expect(operation.children[0]?.operationPath).toEqual([1]);
  });
});

describe("deep equality", () => {
  const tree = (relation: string): UsersetRewrite => ({
    operation: setOperationExclusion(
      { kind: "computedUserset", value: computedUsersetOnResource(relation) },
      {
        kind: "nestedRewrite",
        value: {
          operation: setOperationUnion(
            {
              kind: "tupleToUserset",
              value: {
                tuplesetRelation: "parent",
                computedUserset: { object: "tupleUsersetObject", relation: "view" },
              },
            },
            { kind: "nil" },
          ),
        },
      },
    ),
  });

  it("holds for structurally identical but distinct trees", () => {
    expect(usersetRewriteEquals(tree("view"), tree("view"))).toBe(true);
  });

  it("fails on a difference buried in a nested rewrite", () => {
    const other = tree("view");
    const nested = other.operation.children[1];
    if (nested?.kind !== "nestedRewrite") throw new Error("unexpected shape");
    const changed: UsersetRewrite = {
      operation: {
        ...other.operation,
        children: [
          other.operation.children[0] as SetOperationChild,
          {
            kind: "nestedRewrite",
            value: { operation: setOperationUnion({ kind: "nil" }) },
          },
        ],
      },
    };

    expect(usersetRewriteEquals(other, changed)).toBe(false);
  });

  it("fails when only the computed relation differs", () => {
    expect(usersetRewriteEquals(tree("view"), tree("edit"))).toBe(false);
  });

  it("is order sensitive over children", () => {
    const a: SetOperationChild = { kind: "computedUserset", value: computedUsersetOnResource("a") };
    const b: SetOperationChild = { kind: "computedUserset", value: computedUsersetOnResource("b") };

    expect(setOperationEquals(setOperationUnion(a, b), setOperationUnion(b, a))).toBe(false);
  });

  it("distinguishes the set operation type", () => {
    expect(
      setOperationEquals(
        setOperationUnion({ kind: "this" }),
        setOperationIntersection({ kind: "this" }),
      ),
    ).toBe(false);
  });

  it("distinguishes children of different kinds", () => {
    expect(setOperationChildEquals({ kind: "this" }, { kind: "nil" })).toBe(false);
    expect(setOperationChildEquals({ kind: "this" }, { kind: "this" })).toBe(true);
  });

  it("compares the operation path by content", () => {
    expect(
      setOperationChildEquals(
        { kind: "self", operationPath: [0, 1] },
        { kind: "self", operationPath: [0, 1] },
      ),
    ).toBe(true);
    expect(
      setOperationChildEquals(
        { kind: "self", operationPath: [0, 1] },
        { kind: "self", operationPath: [0, 2] },
      ),
    ).toBe(false);
    expect(
      setOperationChildEquals(
        { kind: "self", operationPath: [0] },
        { kind: "self", operationPath: [] },
      ),
    ).toBe(false);
  });

  // C# `null` and an empty `ImmutableList<uint>` are different values, and the port keeps them
  // different: an absent path is not the root path.
  it("does not conflate an absent operation path with an empty one", () => {
    expect(setOperationChildEquals({ kind: "self" }, { kind: "self", operationPath: [] })).toBe(
      false,
    );
  });

  it("compares the operation's own path, not only its children's", () => {
    const withPath = { ...setOperationUnion({ kind: "nil" }), operationPath: [3] };

    expect(setOperationEquals(withPath, setOperationUnion({ kind: "nil" }))).toBe(false);
    expect(
      setOperationEquals(withPath, { ...setOperationUnion({ kind: "nil" }), operationPath: [3] }),
    ).toBe(true);
  });

  it("compares functioned traversals by function as well as relations", () => {
    const child = (fn: TupleToUsersetFunction): SetOperationChild => ({
      kind: "functionedTupleToUserset",
      value: {
        function: fn,
        tuplesetRelation: "parent",
        computedUserset: computedUsersetOnResource("view"),
      },
    });

    expect(setOperationChildEquals(child("any"), child("any"))).toBe(true);
    expect(setOperationChildEquals(child("any"), child("all"))).toBe(false);
  });

  it("compares computed usersets by object as well as relation", () => {
    const on = (object: ComputedUsersetObject): SetOperationChild => ({
      kind: "computedUserset",
      value: { object, relation: "view" },
    });

    expect(setOperationChildEquals(on("tupleObject"), on("tupleUsersetObject"))).toBe(false);
  });

  it("fails when the children lists have different lengths", () => {
    expect(
      setOperationEquals(
        setOperationUnion({ kind: "this" }),
        setOperationUnion({ kind: "this" }, { kind: "nil" }),
      ),
    ).toBe(false);
  });
});
