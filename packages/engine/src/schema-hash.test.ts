import {
  allowedRelationDirect,
  allowedRelationWildcard,
  type AllowedRelation,
} from "@benedb/core/allowed-relation";
import type { CaveatDefinition } from "@benedb/core/caveat-definition";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import {
  createNamespaceDefinition,
  type NamespaceDefinition,
} from "@benedb/core/namespace-definition";
import { baseRelation, permission, type Relation } from "@benedb/core/relation";
import {
  computedUsersetOnResource,
  setOperationExclusion,
  setOperationIntersection,
  setOperationUnion,
  type SetOperationChild,
} from "@benedb/core/userset-rewrite";
import { describe, expect, it } from "vitest";

import { computeSchemaHash, computeSchemaHashFromNamespaceMap } from "./schema-hash";

// Characterization of Spiceport `SchemaHash.cs` (no covering C# test).
//
// THE MOST BYTE-SENSITIVE FILE IN THE BATCH. The function builds a string and SHA-256s it, so
// every character of the rendering is load-bearing for hash stability across the cluster. The
// exact rendering the port commits to is:
//
//   "namespaces:\n"
//   for each namespace, ordered ORDINAL by name:
//     "def <name>\n"
//     for each relation, ordered ORDINAL by name:
//       "  rel <name>" + (aliasingRelation ? " alias=<alias>" : "") + "\n"
//       for each allowed direct relation, IN DECLARATION ORDER:
//         "    allow <objectType>#<wildcard ? "*" : relationName ?? ELLIPSIS>"
//           + (requiredCaveat ? " with <caveatName>" : "")
//           + (requiresExpiration ? " +expiration" : "") + "\n"
//       if usersetRewrite: "    rewrite:" + <set operation> + "\n"
//   "caveats:\n"
//   for each caveat, ordered ORDINAL by name:
//     "caveat <name>\n"
//     for each parameter, ordered ORDINAL by parameter name:
//       "  param <name> <type>\n"          where <type> is "t" or "t<a,b>" (absent child list
//                                          renders bare; an EMPTY child list renders "t<>")
//     "  expr <lowercase hex of serializedExpression>\n"
//
//   <set operation> = "(" + type + (" " + <child>)* + ")"
//   <child>         = "this" | "nil" | "self"
//                   | "cu[" + object + ":" + relation + "]"
//                   | "ttu[" + tuplesetRelation + "->" + object + ":" + relation + "]"
//                   | "fttu[" + function + " " + tuplesetRelation + "->" + object + ":"
//                     + relation + "]"
//                   | <set operation>          (a nested rewrite)
//
// Two DELIBERATE, DOCUMENTED DIVERGENCES from the C#, both safe because this hash is internal to
// the cluster and never appears on the wire:
//
//  1. CAVEATS ARE RENDERED FAITHFULLY. The C# does `sb.Append(c)` on a `CaveatDefinition`, which
//     invokes the RECORD DEFAULT `ToString()`. That renders `SerializedExpression` as the literal
//     text "System.Byte[]" and `ParameterTypes` as
//     "System.Collections.Immutable.ImmutableDictionary`2[...]", so the C# caveat section hashes
//     essentially only the NAME and two caveats differing only in their expression hash
//     IDENTICALLY. That is a latent cache-correctness bug, not a contract; reproducing it
//     verbatim in TypeScript is impossible and pointless, so the port renders the parameters and
//     the expression bytes. `caveats differing only in the expression hash differently` below
//     pins the divergence.
//  2. ENUM CASING follows the BeneDB string unions, not the .NET enum names: "union" not
//     "Union", "tupleObject" not "TupleObject", "any" not "Any". No mapping layer is introduced
//     just to restore PascalCase.
//
// Everything else is transliterated: the ORDINAL sort on both namespace and caveat names (which
// is what makes the hash independent of enumeration order - never "simplify it away"), the
// per-relation ordinal sort, the declaration-order allowed list, and
// `Convert.ToHexStringLower(SHA256.HashData(UTF8(s)))`.

const documentRelations: readonly Relation[] = [
  // Given deliberately UNSORTED, so the ordinal sort by relation name is exercised.
  baseRelation(
    "viewer",
    allowedRelationDirect("user"),
    allowedRelationWildcard("user", { caveatName: "only_on_tuesday" }, true),
  ),
  permission("view", {
    operation: setOperationUnion(
      { kind: "computedUserset", value: computedUsersetOnResource("viewer") },
      {
        kind: "tupleToUserset",
        value: {
          tuplesetRelation: "parent",
          computedUserset: { object: "tupleObject", relation: "view" },
        },
      },
    ),
  }),
  {
    name: "editor",
    aliasingRelation: "owner",
    typeInformation: { allowedDirectRelations: [allowedRelationDirect("user")] },
  },
];

const document: NamespaceDefinition = { name: "document", relations: documentRelations };
const user: NamespaceDefinition = createNamespaceDefinition("user");

// The digests below were computed from the rendering documented above with
// `createHash("sha256").update(new TextEncoder().encode(s)).digest("hex")`. If one of them
// fails, the RENDERING changed - not the assertion. Fix the renderer, not the constant.
const EMPTY_DIGEST = "82744a2b5c6679b2d049bb40d86034535a304e192b68569f92e471a4970ddb59";
const NAMESPACES_DIGEST = "676ad4bacf25a3d390fa5bf4574456b42e7f521854562f751c6839a11aae3f7f";
const WITH_CAVEAT_DIGEST = "636511887ecf8f9b26c4b4f859d3b15ba3d7522f329ed646fffdb9d2254b17fd";
const WITH_OTHER_EXPRESSION_DIGEST =
  "3ccdb34ac3771c816c4fd559c73ed171059edc5dc1f5afa54331aa990e341015";
const ORDINAL_NAMESPACES_DIGEST =
  "effb4fcb227998b0bfe495c534781ab4e5797535d151831a27296430e571666e";
const ORDINAL_CAVEATS_DIGEST = "fcf25fbfad752da6cb659e5732cd705c6884114ce6b25ec26d4b13e4ca428af8";
const ALL_CHILD_KINDS_DIGEST = "48e79336c8da2cc20968b52ea80624eebf8b919bf9de5229d03e94c4155e51cd";

function onlyOnTuesday(expression: Uint8Array): CaveatDefinition {
  return {
    name: "only_on_tuesday",
    serializedExpression: expression,
    parameterTypes: new Map([
      // Given deliberately unsorted; the rendering sorts parameter names ordinally.
      ["day", { typeName: "string" }],
      ["allowed", { typeName: "list", childTypes: [{ typeName: "string" }] }],
    ]),
  };
}

describe("schema hash", () => {
  describe("computeSchemaHash", () => {
    it("returns a lowercase hex SHA-256 (64 chars)", () => {
      const hash = computeSchemaHash([document, user]);

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('hashes the empty schema to the digest of "namespaces:\\ncaveats:\\n"', () => {
      expect(computeSchemaHash([])).toBe(EMPTY_DIGEST);
    });

    it("treats an absent caveat list and an empty one identically", () => {
      expect(computeSchemaHash([], undefined)).toBe(EMPTY_DIGEST);
      expect(computeSchemaHash([], [])).toBe(EMPTY_DIGEST);
    });

    it("renders relations, allowed types, caveat requirements, expiration and rewrites", () => {
      expect(computeSchemaHash([document, user])).toBe(NAMESPACES_DIGEST);
    });

    it("is independent of namespace enumeration order", () => {
      expect(computeSchemaHash([user, document])).toBe(NAMESPACES_DIGEST);
    });

    it("is independent of relation enumeration order within a namespace", () => {
      const reordered: NamespaceDefinition = {
        name: "document",
        relations: [...documentRelations].reverse(),
      };

      expect(computeSchemaHash([reordered, user])).toBe(NAMESPACES_DIGEST);
    });

    it("sorts namespace names ORDINALLY, not by locale", () => {
      // Ordinal puts "Zed" (U+005A) before "apple" (U+0061); a locale collation would not.
      const zed = createNamespaceDefinition("Zed");
      const apple = createNamespaceDefinition("apple");

      expect(computeSchemaHash([apple, zed])).toBe(ORDINAL_NAMESPACES_DIGEST);
      expect(computeSchemaHash([zed, apple])).toBe(ORDINAL_NAMESPACES_DIGEST);
    });

    it("sorts caveat names ORDINALLY, not by locale", () => {
      const empty = new Uint8Array(0);
      const zed: CaveatDefinition = {
        name: "Zed",
        serializedExpression: empty,
        parameterTypes: new Map(),
      };
      const apple: CaveatDefinition = {
        name: "apple",
        serializedExpression: empty,
        parameterTypes: new Map(),
      };

      expect(computeSchemaHash([], [apple, zed])).toBe(ORDINAL_CAVEATS_DIGEST);
      expect(computeSchemaHash([], [zed, apple])).toBe(ORDINAL_CAVEATS_DIGEST);
    });

    it("renders every set-operation child kind, including a nested rewrite", () => {
      const children: readonly SetOperationChild[] = [
        { kind: "this" },
        { kind: "nil" },
        { kind: "self" },
        {
          kind: "functionedTupleToUserset",
          value: {
            function: "any",
            tuplesetRelation: "parent",
            computedUserset: { object: "tupleUsersetObject", relation: "view" },
          },
        },
        {
          kind: "nestedRewrite",
          value: {
            operation: setOperationIntersection({
              kind: "computedUserset",
              value: computedUsersetOnResource("a"),
            }),
          },
        },
      ];
      const ns: NamespaceDefinition = {
        name: "x",
        relations: [permission("p", { operation: setOperationExclusion(...children) })],
      };

      expect(computeSchemaHash([ns])).toBe(ALL_CHILD_KINDS_DIGEST);
    });

    it("accepts any Iterable, not just an array", () => {
      function* namespaces(): Generator<NamespaceDefinition> {
        yield document;
        yield user;
      }

      expect(computeSchemaHash(namespaces())).toBe(NAMESPACES_DIGEST);
    });

    describe("sensitivity", () => {
      it("changes when a namespace name changes", () => {
        const renamed: NamespaceDefinition = { ...document, name: "documents" };

        expect(computeSchemaHash([renamed, user])).not.toBe(NAMESPACES_DIGEST);
      });

      it("changes when a relation is added", () => {
        const extended: NamespaceDefinition = {
          name: "document",
          relations: [...documentRelations, baseRelation("owner", allowedRelationDirect("user"))],
        };

        expect(computeSchemaHash([extended, user])).not.toBe(NAMESPACES_DIGEST);
      });

      it("changes when a rewrite changes", () => {
        const changed: NamespaceDefinition = {
          name: "document",
          relations: documentRelations.map((relation) =>
            relation.name === "view"
              ? permission("view", {
                  operation: setOperationIntersection({
                    kind: "computedUserset",
                    value: computedUsersetOnResource("viewer"),
                  }),
                })
              : relation,
          ),
        };

        expect(computeSchemaHash([changed, user])).not.toBe(NAMESPACES_DIGEST);
      });

      it("changes when an allowed type gains a required caveat", () => {
        const withCaveat: AllowedRelation = allowedRelationDirect("user", "...", {
          caveatName: "some_caveat",
        });
        const changed: NamespaceDefinition = {
          name: "document",
          relations: [baseRelation("viewer", withCaveat)],
        };
        const without: NamespaceDefinition = {
          name: "document",
          relations: [baseRelation("viewer", allowedRelationDirect("user"))],
        };

        expect(computeSchemaHash([changed])).not.toBe(computeSchemaHash([without]));
      });

      it("changes when an allowed type gains an expiration requirement", () => {
        const a: NamespaceDefinition = {
          name: "d",
          relations: [
            baseRelation("viewer", allowedRelationDirect("user", "...", undefined, true)),
          ],
        };
        const b: NamespaceDefinition = {
          name: "d",
          relations: [
            baseRelation("viewer", allowedRelationDirect("user", "...", undefined, false)),
          ],
        };

        expect(computeSchemaHash([a])).not.toBe(computeSchemaHash([b]));
      });

      it("distinguishes a wildcard subject from an ellipsis subject", () => {
        const wildcard: NamespaceDefinition = {
          name: "d",
          relations: [baseRelation("viewer", allowedRelationWildcard("user"))],
        };
        const direct: NamespaceDefinition = {
          name: "d",
          relations: [baseRelation("viewer", allowedRelationDirect("user"))],
        };

        expect(computeSchemaHash([wildcard])).not.toBe(computeSchemaHash([direct]));
      });

      it("changes when a relation gains an aliasing relation", () => {
        const aliased: NamespaceDefinition = {
          name: "d",
          relations: [{ name: "viewer", aliasingRelation: "owner" }],
        };
        const plain: NamespaceDefinition = { name: "d", relations: [{ name: "viewer" }] };

        expect(computeSchemaHash([aliased])).not.toBe(computeSchemaHash([plain]));
      });

      it("distinguishes namespaces that share names but differ in relations", () => {
        const a: NamespaceDefinition = { name: "d", relations: [{ name: "viewer" }] };
        const b: NamespaceDefinition = { name: "d", relations: [{ name: "editor" }] };

        expect(computeSchemaHash([a])).not.toBe(computeSchemaHash([b]));
      });
    });

    describe("caveats", () => {
      it("renders the name, ordinal-sorted parameters and the expression bytes", () => {
        expect(
          computeSchemaHash([document, user], [onlyOnTuesday(new Uint8Array([1, 2, 255]))]),
        ).toBe(WITH_CAVEAT_DIGEST);
      });

      it("hashes caveats differing only in the expression DIFFERENTLY (divergence 1)", () => {
        // The C# would produce the SAME hash here, because its record ToString() renders the
        // byte array as the literal "System.Byte[]". The port fixes that deliberately.
        const withOther = computeSchemaHash(
          [document, user],
          [onlyOnTuesday(new Uint8Array([1, 2, 254]))],
        );

        expect(withOther).toBe(WITH_OTHER_EXPRESSION_DIGEST);
        expect(withOther).not.toBe(WITH_CAVEAT_DIGEST);
      });

      it("hashes caveats differing only in parameter types DIFFERENTLY (divergence 1)", () => {
        const bytes = new Uint8Array([1]);
        const a: CaveatDefinition = {
          name: "c",
          serializedExpression: bytes,
          parameterTypes: new Map([["x", { typeName: "int" }]]),
        };
        const b: CaveatDefinition = {
          name: "c",
          serializedExpression: bytes,
          parameterTypes: new Map([["x", { typeName: "string" }]]),
        };

        expect(computeSchemaHash([], [a])).not.toBe(computeSchemaHash([], [b]));
      });

      it("distinguishes an absent child-type list from an empty one", () => {
        const bytes = new Uint8Array(0);
        const scalar: CaveatDefinition = {
          name: "c",
          serializedExpression: bytes,
          parameterTypes: new Map([["x", { typeName: "list" }]]),
        };
        const emptyGeneric: CaveatDefinition = {
          name: "c",
          serializedExpression: bytes,
          parameterTypes: new Map([["x", { typeName: "list", childTypes: [] }]]),
        };

        expect(computeSchemaHash([], [scalar])).not.toBe(computeSchemaHash([], [emptyGeneric]));
      });

      it("is independent of caveat enumeration order", () => {
        const bytes = new Uint8Array(0);
        const a: CaveatDefinition = {
          name: "a",
          serializedExpression: bytes,
          parameterTypes: new Map(),
        };
        const b: CaveatDefinition = {
          name: "b",
          serializedExpression: bytes,
          parameterTypes: new Map(),
        };

        expect(computeSchemaHash([], [a, b])).toBe(computeSchemaHash([], [b, a]));
      });

      it("is independent of parameter insertion order", () => {
        const bytes = new Uint8Array(0);
        const forward: CaveatDefinition = {
          name: "c",
          serializedExpression: bytes,
          parameterTypes: new Map([
            ["a", { typeName: "int" }],
            ["b", { typeName: "string" }],
          ]),
        };
        const backward: CaveatDefinition = {
          name: "c",
          serializedExpression: bytes,
          parameterTypes: new Map([
            ["b", { typeName: "string" }],
            ["a", { typeName: "int" }],
          ]),
        };

        expect(computeSchemaHash([], [forward])).toBe(computeSchemaHash([], [backward]));
      });
    });

    it("rejects a missing namespace collection, as ArgumentNullException.ThrowIfNull does", () => {
      // The guard survives the port even though the TypeScript parameter is non-optional: the
      // caller may be untyped.
      expect(() =>
        computeSchemaHash(undefined as unknown as Iterable<NamespaceDefinition>),
      ).toThrow(InvalidArgumentError);
    });
  });

  describe("computeSchemaHashFromNamespaceMap", () => {
    // The C# `Compute` OVERLOAD SET (IEnumerable vs ImmutableDictionary) becomes two distinctly
    // named functions; the map form just forwards `namespaces.values()`.
    it("agrees with the iterable form over the same namespaces", () => {
      const map = new Map([
        ["document", document],
        ["user", user],
      ]);

      expect(computeSchemaHashFromNamespaceMap(map)).toBe(NAMESPACES_DIGEST);
    });

    it("ignores the map keys, hashing only the values", () => {
      const map = new Map([
        ["ignored-key-1", document],
        ["ignored-key-2", user],
      ]);

      expect(computeSchemaHashFromNamespaceMap(map)).toBe(NAMESPACES_DIGEST);
    });

    it("is independent of map insertion order, because the values are sorted by name", () => {
      const forward = new Map([
        ["document", document],
        ["user", user],
      ]);
      const backward = new Map([
        ["user", user],
        ["document", document],
      ]);

      expect(computeSchemaHashFromNamespaceMap(forward)).toBe(
        computeSchemaHashFromNamespaceMap(backward),
      );
    });

    it("forwards the caveats", () => {
      const map = new Map([
        ["document", document],
        ["user", user],
      ]);

      expect(
        computeSchemaHashFromNamespaceMap(map, [onlyOnTuesday(new Uint8Array([1, 2, 255]))]),
      ).toBe(WITH_CAVEAT_DIGEST);
    });

    it("hashes an empty map to the empty-schema digest", () => {
      expect(computeSchemaHashFromNamespaceMap(new Map())).toBe(EMPTY_DIGEST);
    });
  });
});
