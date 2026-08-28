import { describe, expect, it } from "vitest";

import {
  caveatDefinitionEquals,
  caveatTypeReferenceEquals,
  type CaveatDefinition,
  type CaveatTypeReference,
} from "./caveat-definition";

// Characterization of Spiceport `CaveatDefinition.cs` (no covering C# test). `CaveatTypeReference`
// is declared in the same C# file and stays in the same module: it is a helper shape for the
// definition's parameter map, not a peer entity, so the ledger's single row still holds.
//
// Port decisions pinned here:
//   * `ChildTypes` is NULL for a scalar, not an empty list, and the DSL compiler's test asserts
//     exactly that. `undefined` and `[]` are therefore kept distinct, in the data and in equality.
//   * `byte[] SerializedExpression` becomes `Uint8Array`. As with `RelationshipIntegrity.hash`,
//     C# record equality over `byte[]` is REFERENCE equality; the port compares content, because
//     a compiled expression is a value.
//   * `ParameterTypes` is an `ImmutableDictionary` in C#, whose enumeration order is HASH order,
//     not source order. A `Map` preserves insertion order instead. That divergence is harmless
//     only while nothing serializes or hashes the parameter list in enumeration order - the
//     order case below exists to make the assumption visible if that ever changes.
const scalar = (typeName: string): CaveatTypeReference => ({ typeName });

describe("caveat type reference", () => {
  it("leaves child types undefined for a scalar, not an empty list", () => {
    const int = scalar("int");

    expect(int.typeName).toBe("int");
    expect(int.childTypes).toBeUndefined();
    expect(int.childTypes).not.toEqual([]);
  });

  it("carries one child type for a list", () => {
    const list: CaveatTypeReference = { typeName: "list", childTypes: [scalar("int")] };

    expect(list.childTypes).toEqual([{ typeName: "int" }]);
  });

  it("carries child types in order for a map", () => {
    const map: CaveatTypeReference = {
      typeName: "map",
      childTypes: [scalar("string"), scalar("int")],
    };

    expect(map.childTypes?.map((c) => c.typeName)).toEqual(["string", "int"]);
  });

  it("nests recursively", () => {
    const nested: CaveatTypeReference = {
      typeName: "map",
      childTypes: [scalar("string"), { typeName: "list", childTypes: [scalar("int")] }],
    };

    expect(nested.childTypes?.[1]?.childTypes?.[0]?.typeName).toBe("int");
  });

  describe("equality", () => {
    it("holds for structurally identical but distinct references", () => {
      const build = (): CaveatTypeReference => ({
        typeName: "map",
        childTypes: [scalar("string"), { typeName: "list", childTypes: [scalar("int")] }],
      });

      expect(caveatTypeReferenceEquals(build(), build())).toBe(true);
    });

    it("fails on a differing type name at any depth", () => {
      expect(
        caveatTypeReferenceEquals(
          { typeName: "list", childTypes: [scalar("int")] },
          { typeName: "list", childTypes: [scalar("string")] },
        ),
      ).toBe(false);
    });

    it("is order sensitive over child types", () => {
      expect(
        caveatTypeReferenceEquals(
          { typeName: "map", childTypes: [scalar("string"), scalar("int")] },
          { typeName: "map", childTypes: [scalar("int"), scalar("string")] },
        ),
      ).toBe(false);
    });

    it("does not conflate an absent child list with an empty one", () => {
      expect(caveatTypeReferenceEquals(scalar("int"), { typeName: "int", childTypes: [] })).toBe(
        false,
      );
    });
  });
});

describe("caveat definition", () => {
  const expression = new Uint8Array([1, 2, 3]);
  const definition: CaveatDefinition = {
    name: "only_on_tuesday",
    serializedExpression: expression,
    parameterTypes: new Map([
      ["day_of_week", scalar("string")],
      ["allowed", { typeName: "list", childTypes: [scalar("string")] }],
    ]),
  };

  it("stores the compiled expression as opaque bytes", () => {
    expect(definition.serializedExpression).toBeInstanceOf(Uint8Array);
    expect([...definition.serializedExpression]).toEqual([1, 2, 3]);
  });

  it("accepts an empty expression", () => {
    expect(
      { ...definition, serializedExpression: new Uint8Array() }.serializedExpression,
    ).toHaveLength(0);
  });

  it("keys parameters by name", () => {
    expect(definition.parameterTypes.get("day_of_week")).toEqual({ typeName: "string" });
    expect(definition.parameterTypes.get("missing")).toBeUndefined();
  });

  it("keeps a path-segmented name verbatim", () => {
    expect({ ...definition, name: "org/only_on_tuesday" }.name).toBe("org/only_on_tuesday");
  });

  it("enumerates parameters in insertion order, unlike the C# hash-ordered dictionary", () => {
    expect([...definition.parameterTypes.keys()]).toEqual(["day_of_week", "allowed"]);
  });

  describe("equality", () => {
    it("compares the expression bytes by content, not by reference", () => {
      const other: CaveatDefinition = {
        ...definition,
        serializedExpression: new Uint8Array([1, 2, 3]),
      };

      expect(other.serializedExpression).not.toBe(definition.serializedExpression);
      expect(caveatDefinitionEquals(definition, other)).toBe(true);
    });

    it("fails on differing expression bytes", () => {
      expect(
        caveatDefinitionEquals(definition, {
          ...definition,
          serializedExpression: new Uint8Array([1, 2, 4]),
        }),
      ).toBe(false);
    });

    it("fails on a differing expression length", () => {
      expect(
        caveatDefinitionEquals(definition, {
          ...definition,
          serializedExpression: new Uint8Array([1, 2]),
        }),
      ).toBe(false);
    });

    it("fails on a differing name", () => {
      expect(caveatDefinitionEquals(definition, { ...definition, name: "other" })).toBe(false);
    });

    it("compares the parameter map by content, ignoring insertion order", () => {
      const reordered: CaveatDefinition = {
        ...definition,
        parameterTypes: new Map([
          ["allowed", { typeName: "list", childTypes: [scalar("string")] }],
          ["day_of_week", scalar("string")],
        ]),
      };

      expect(caveatDefinitionEquals(definition, reordered)).toBe(true);
    });

    it("fails on a differing parameter type", () => {
      const changed: CaveatDefinition = {
        ...definition,
        parameterTypes: new Map([
          ["day_of_week", scalar("int")],
          ["allowed", { typeName: "list", childTypes: [scalar("string")] }],
        ]),
      };

      expect(caveatDefinitionEquals(definition, changed)).toBe(false);
    });

    it("fails on a missing or extra parameter", () => {
      const fewer: CaveatDefinition = {
        ...definition,
        parameterTypes: new Map([["day_of_week", scalar("string")]]),
      };

      expect(caveatDefinitionEquals(definition, fewer)).toBe(false);
      expect(caveatDefinitionEquals(fewer, definition)).toBe(false);
    });

    it("accepts a definition with no parameters", () => {
      const none: CaveatDefinition = { ...definition, parameterTypes: new Map() };

      expect(caveatDefinitionEquals(none, { ...none })).toBe(true);
      expect(caveatDefinitionEquals(none, definition)).toBe(false);
    });
  });
});
