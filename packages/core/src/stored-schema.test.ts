import { describe, expect, it } from "vitest";

import { allowedRelationDirect } from "./allowed-relation";
import type { CaveatDefinition } from "./caveat-definition";
import { InvalidArgumentError } from "./invalid-argument-error";
import { createNamespaceDefinition, type NamespaceDefinition } from "./namespace-definition";
import { baseRelation, permission } from "./relation";
import { createStoredSchema, type StoredSchema } from "./stored-schema";
import { computedUsersetOnResource, setOperationUnion } from "./userset-rewrite";

// Characterization of Spiceport `StoredSchema` (no covering C# test).
//
// Port decisions pinned here:
//   * `uint Version` becomes `number`. The C# type system makes a negative version
//     unrepresentable; TypeScript does not, so the factory guards the uint32 range instead.
//     Nothing downstream may ever see a negative or fractional version.
//   * The two `ImmutableDictionary` members become `ReadonlyMap` keyed by name. Lookup is by
//     name, so a definition whose key disagrees with its own `name` is a caller bug the type
//     cannot catch - the case below records that this file does not check it.
//   * `SchemaHash` is compared against the hash carried in a `ZedToken`, so whatever computes it
//     must be byte-stable. THIS FILE ONLY STORES IT: it neither computes nor validates it.
const document: NamespaceDefinition = createNamespaceDefinition(
  "document",
  baseRelation("viewer", allowedRelationDirect("user")),
  permission("view", {
    operation: setOperationUnion({
      kind: "computedUserset",
      value: computedUsersetOnResource("viewer"),
    }),
  }),
);

const onlyOnTuesday: CaveatDefinition = {
  name: "only_on_tuesday",
  serializedExpression: new Uint8Array([1, 2, 3]),
  parameterTypes: new Map([["day_of_week", { typeName: "string" }]]),
};

const namespaces = new Map([["document", document]]);
const caveats = new Map([["only_on_tuesday", onlyOnTuesday]]);

describe("stored schema", () => {
  it("holds a version, the original DSL text, a hash, namespaces and caveats", () => {
    const schema = createStoredSchema(3, "definition document {}", "abc123", namespaces, caveats);

    expect(schema.version).toBe(3);
    expect(schema.schemaText).toBe("definition document {}");
    expect(schema.schemaHash).toBe("abc123");
    expect(schema.namespaces.get("document")).toBe(document);
    expect(schema.caveats.get("only_on_tuesday")).toBe(onlyOnTuesday);
  });

  it("returns undefined for an unknown namespace or caveat", () => {
    const schema = createStoredSchema(1, "", "", namespaces, caveats);

    expect(schema.namespaces.get("missing")).toBeUndefined();
    expect(schema.caveats.get("missing")).toBeUndefined();
  });

  it("accepts an empty schema", () => {
    const schema = createStoredSchema(0, "", "", new Map(), new Map());

    expect(schema.version).toBe(0);
    expect(schema.namespaces.size).toBe(0);
    expect(schema.caveats.size).toBe(0);
  });

  it("stores the schema hash opaquely, without computing or validating it", () => {
    const schema = createStoredSchema(
      1,
      "definition document {}",
      "not-a-real-hash",
      new Map(),
      new Map(),
    );

    expect(schema.schemaHash).toBe("not-a-real-hash");
  });

  it("does not check that a map key matches the definition's own name", () => {
    const mismatched = new Map([["wrong-key", document]]);
    const schema = createStoredSchema(1, "", "", mismatched, new Map());

    expect(schema.namespaces.get("wrong-key")?.name).toBe("document");
    expect(schema.namespaces.get("document")).toBeUndefined();
  });

  describe("version range", () => {
    it.each([0, 1, 4294967295])("accepts %i", (version) => {
      expect(createStoredSchema(version, "", "", new Map(), new Map()).version).toBe(version);
    });

    it.each([-1, -0.5, 1.5, 4294967296, Number.NaN, Number.POSITIVE_INFINITY])(
      "rejects %s, because the C# version is a uint",
      (version) => {
        expect(() => createStoredSchema(version, "", "", new Map(), new Map())).toThrow(
          InvalidArgumentError,
        );
      },
    );
  });

  it("is a plain readonly snapshot: copies share their maps", () => {
    const schema = createStoredSchema(1, "", "", namespaces, caveats);
    const bumped: StoredSchema = { ...schema, version: 2 };

    expect(bumped.version).toBe(2);
    expect(bumped.namespaces).toBe(schema.namespaces);
  });
});
