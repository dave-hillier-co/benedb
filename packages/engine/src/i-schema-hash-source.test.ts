import { describe, expect, it } from "vitest";

import { createFixedSchemaHashSource, type ISchemaHashSource } from "./i-schema-hash-source";

// Characterization of Spiceport `ISchemaHashSource.cs` (no covering C# test).
//
// Nothing in the S3 engine consumes this yet - the caching dispatcher that does is S4 - so it
// ports as a pure declaration plus the `FixedSchemaHashSource` record.
//
// `CurrentSchemaHash` is a COMPUTED property: the grains-layer implementation recomputes it on
// every read, which is the entire point of the abstraction (a cache key must pick up a schema
// swap). TypeScript cannot require getter-ness on an interface, so it is pinned here: an
// implementation whose backing hash changes must be observed to change through the interface.
describe("schema hash source", () => {
  describe("createFixedSchemaHashSource", () => {
    it("returns the fixed hash", () => {
      const source = createFixedSchemaHashSource("abc123");

      expect(source.currentSchemaHash).toBe("abc123");
    });

    it("returns the same hash on every read", () => {
      const source = createFixedSchemaHashSource("abc123");

      expect(source.currentSchemaHash).toBe("abc123");
      expect(source.currentSchemaHash).toBe("abc123");
    });

    it("does not validate the hash: an empty string is accepted verbatim", () => {
      expect(createFixedSchemaHashSource("").currentSchemaHash).toBe("");
    });

    it("produces a distinct source per call, unlike the singletons in this batch", () => {
      expect(createFixedSchemaHashSource("a")).not.toBe(createFixedSchemaHashSource("a"));
    });
  });

  describe("the interface contract", () => {
    it("permits an implementation that recomputes the hash on every read", () => {
      // The shape the S4 mutable schema provider takes: a live read, not a value frozen at
      // construction time. Declared as a getter, so a field-snapshot port would fail here.
      let live = "hash-1";
      const source: ISchemaHashSource = {
        get currentSchemaHash() {
          return live;
        },
      };

      expect(source.currentSchemaHash).toBe("hash-1");
      live = "hash-2";
      expect(source.currentSchemaHash).toBe("hash-2");
    });

    it("is satisfied by the fixed source", () => {
      const source: ISchemaHashSource = createFixedSchemaHashSource("fixed");

      expect(source.currentSchemaHash).toBe("fixed");
    });
  });
});
