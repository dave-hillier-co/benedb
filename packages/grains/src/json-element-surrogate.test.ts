import type { ContextualizedCaveat } from "@benedb/core/contextualized-caveat";
import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import { CAVEAT_CONTEXT_SURROGATE_NOT_REQUIRED } from "./json-element-surrogate";

// The C# `JsonElementSurrogate.cs` (covered indirectly by
// `tests/Spiceport.Grains.Tests/DatastoreStateWireRoundTripTests.cs`) exists because .NET's caveat
// context is a `Dictionary<string, object?>` of BOXED `JsonElement`s, a type Orleans can neither
// copy nor code. It captures each element's raw JSON text on the wire and re-parses it on the way
// back.
//
// THAT PROBLEM DOES NOT EXIST HERE. The ported `ContextualizedCaveat.context` is a
// `ReadonlyMap<string, unknown>` of PLAIN JSON values, and Thresh's value codec already encodes and
// decodes `Map` natively (as an entries array). Registering a surrogate would double-encode. So the
// ported module registers nothing, and this test carries the C# test's INTENT across instead:
// caveat context must survive the grain boundary with its values, its types and its KEY ORDER
// intact. Key order is observable - the S1 port pinned it in tuple-string formatting - so a codec
// that lost it would be a Thresh bug to fix in Thresh, not something to paper over here.
describe("caveat context on the wire", () => {
  it("records that no JsonElement surrogate is needed in the port", () => {
    expect(CAVEAT_CONTEXT_SURROGATE_NOT_REQUIRED).toBe(true);
  });

  it("round-trips a caveat context map with every JSON value shape intact", () => {
    const caveat: ContextualizedCaveat = {
      caveatName: "only_on_tuesday",
      context: new Map<string, unknown>([
        ["str", "hello"],
        ["num", 42],
        ["float", 1.5],
        ["bool", true],
        ["nul", null],
        ["arr", [1, "two", false]],
        ["nested", new Map<string, unknown>([["inner", "value"]])],
      ]),
    };

    const revived = deserializeValue<ContextualizedCaveat>(serializeValue(caveat));

    expect(revived.caveatName).toBe("only_on_tuesday");
    expect(revived.context).toBeInstanceOf(Map);
    expect(revived.context?.get("str")).toBe("hello");
    expect(revived.context?.get("num")).toBe(42);
    expect(revived.context?.get("float")).toBe(1.5);
    expect(revived.context?.get("bool")).toBe(true);
    expect(revived.context?.get("nul")).toBeNull();
    expect(revived.context?.get("arr")).toEqual([1, "two", false]);
    expect(revived.context?.get("nested")).toBeInstanceOf(Map);
    expect((revived.context?.get("nested") as Map<string, unknown>).get("inner")).toBe("value");
  });

  it("preserves key ORDER, including integer-like keys a plain object would reorder", () => {
    // The reason `context` is a Map at all: `{ "2": ..., "1": ... }` silently reorders in a plain
    // JS object, and key order is observable in the formatting the S1 port pinned.
    const context = new Map<string, unknown>([
      ["2", "two"],
      ["1", "one"],
      ["zebra", "z"],
      ["apple", "a"],
    ]);

    const revived = deserializeValue<Map<string, unknown>>(serializeValue(context));

    expect([...revived.keys()]).toEqual(["2", "1", "zebra", "apple"]);
  });

  it("round-trips an empty context map as an empty map, not as absent", () => {
    const revived = deserializeValue<Map<string, unknown>>(
      serializeValue(new Map<string, unknown>()),
    );

    expect(revived).toBeInstanceOf(Map);
    expect(revived.size).toBe(0);
  });
});
