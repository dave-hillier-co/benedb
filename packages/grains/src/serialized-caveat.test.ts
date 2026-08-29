import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import type { SerializedCaveat, SerializedCaveatLeaf } from "./serialized-caveat";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/SerializedCaveat.cs`, which
// has NO covering C# test of its own: Spiceport exercises it only through `CaveatWire` and
// `FrontierWire` (both later slices). This is therefore the only gate the shape will have for a
// while, so it pins the properties the rest of the port relies on rather than an implementation
// detail.
//
// The C# is an abstract record with four nested sealed records whose nested types re-declare
// nothing of the base (the base is empty). Per the port guide that becomes ONE discriminated union
// with a literal `kind` data field - never a base object with a nested one - and `kind` must be a
// plain own enumerable property, because `CaveatWire` and the frontier reply SPREAD these nodes and
// a spread copies neither getters nor prototype members.
describe("the SerializedCaveat union", () => {
  const leaf: SerializedCaveatLeaf = {
    kind: "leaf",
    caveatName: "over_age",
    context: new Map<string, unknown>([["min_age", 18]]),
  };

  const tree: SerializedCaveat = {
    kind: "or",
    children: [
      {
        kind: "and",
        children: [leaf, { kind: "not", child: { kind: "leaf", caveatName: "banned" } }],
      },
      { kind: "leaf", caveatName: "is_admin", context: new Map<string, unknown>([["level", 3]]) },
    ],
  };

  it("carries `kind` as an own enumerable data property on every node", () => {
    // The trap the guide names: a `kind` living on a getter or a prototype is silently dropped by
    // `{ ...node }`, the clone stops matching any arm of the switch it was cloned to feed, and the
    // declared type still says it is a union so nothing warns.
    const nodes: readonly SerializedCaveat[] = [
      leaf,
      { kind: "or", children: [] },
      { kind: "and", children: [] },
      { kind: "not", child: leaf },
    ];

    for (const node of nodes) {
      expect(Object.keys(node)).toContain("kind");
      expect(Object.getOwnPropertyDescriptor(node, "kind")?.get).toBeUndefined();
    }
  });

  it("survives a spread, so an abstract-typed `node with { ... }` ports as `{ ...node }`", () => {
    const renamed: SerializedCaveat = { ...leaf, caveatName: "under_age" };

    expect(renamed.kind).toBe("leaf");
    expect(renamed).toEqual({ ...leaf, caveatName: "under_age" });
  });

  it("round trips a nested Or/And/Not tree through the value codec unchanged", () => {
    const back = deserializeValue<SerializedCaveat>(serializeValue(tree));

    expect(back).toEqual(tree);
  });

  it("keeps leaf context as a Map, preserving key order", () => {
    // Matching `ContextualizedCaveat.context` exactly: a Map, not a plain object, so JSON key
    // order survives - a plain object reorders integer-like keys numerically. Thresh's codec
    // encodes Map natively, so no surrogate is registered for this type.
    const ordered: SerializedCaveatLeaf = {
      kind: "leaf",
      caveatName: "ordered",
      context: new Map<string, unknown>([
        ["2", "two"],
        ["1", "one"],
        ["zebra", "z"],
      ]),
    };

    const back = deserializeValue<SerializedCaveatLeaf>(serializeValue(ordered));

    expect(back.context).toBeInstanceOf(Map);
    expect([...(back.context?.keys() ?? [])]).toEqual(["2", "1", "zebra"]);
  });

  it("keeps an absent leaf context distinct from an empty one", () => {
    // `ContextualizedCaveat` treats undefined and an empty map as the same thing for FORMATTING,
    // but does not merge them at the value level, and neither does the C# here: `Context` is
    // nullable and an empty dictionary is a different object. Both states must survive the wire.
    const absent = deserializeValue<SerializedCaveatLeaf>(
      serializeValue({ kind: "leaf", caveatName: "c" } satisfies SerializedCaveatLeaf),
    );
    const empty = deserializeValue<SerializedCaveatLeaf>(
      serializeValue({
        kind: "leaf",
        caveatName: "c",
        context: new Map<string, unknown>(),
      } satisfies SerializedCaveatLeaf),
    );

    expect(absent.context).toBeUndefined();
    expect(empty.context).toBeInstanceOf(Map);
    expect(empty.context?.size).toBe(0);
  });

  it("keeps Or/And children as lists, so an empty composite stays an empty composite", () => {
    const back = deserializeValue<SerializedCaveat>(serializeValue({ kind: "and", children: [] }));

    expect(back).toEqual({ kind: "and", children: [] });
  });

  it("narrows exhaustively on `kind`", () => {
    // A compile-time property expressed as a runtime one: every arm is reachable and the union has
    // exactly these four members, which is what lets every consumer's `assertNever` default arm be
    // unreachable.
    const describeNode = (node: SerializedCaveat): string => {
      switch (node.kind) {
        case "leaf":
          return `leaf:${node.caveatName}`;
        case "or":
          return `or:${node.children.length}`;
        case "and":
          return `and:${node.children.length}`;
        case "not":
          return `not:${describeNode(node.child)}`;
        default:
          return assertNeverKind(node);
      }
    };

    expect(describeNode(tree)).toBe("or:2");
    expect(describeNode({ kind: "not", child: leaf })).toBe("not:leaf:over_age");
  });
});

function assertNeverKind(node: never): never {
  throw new Error(`unhandled SerializedCaveat: ${JSON.stringify(node)}`);
}
