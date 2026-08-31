import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { FormatError } from "@benedb/core/format-error";
import { describe, expect, it } from "vitest";

import { grainKeyBuild, grainKeyParse } from "./grain-key";

// Characterization test for `src/Spiceport.Server/Grains/GrainKey.cs`.
//
// NO COVERING C# TEST EXISTS: `SubjectFrontierKeyTests`' XML comment claims to mirror a
// `GrainKeyTests`, but no such file is in the Spiceport test project - GrainKey is otherwise
// exercised only through mesh suites. This file is therefore the analogue of
// `SubjectFrontierKeyTests` (round-trip, separator/#/% escaping, wrong segment count), and it is
// the only gate this codec has until the mesh suites land.

function resource(type: string, id: string, relation: string): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

describe("grainKeyBuild / grainKeyParse", () => {
  it("builds EIGHT segments in the exact order that IS the sub-problem identity", () => {
    // resType/resId/relation/subjType/subjId/subjRelation/revision/schemaHash. The ORDER is the
    // identity: reordering silently repartitions the check cache without any test noticing, so the
    // exact string is pinned rather than only its round-trip.
    const key = grainKeyBuild(
      resource("document", "readme", "view"),
      resource("user", "alice", ELLIPSIS),
      "12345",
      "hash-abc",
    );

    expect(key).toBe("document/readme/view/user/alice/.../12345/hash-abc");
    expect(key.split("/")).toHaveLength(8);
  });

  it("round-trips every component", () => {
    const res = resource("document", "readme", "view");
    const subject = resource("user", "alice", ELLIPSIS);

    const parts = grainKeyParse(grainKeyBuild(res, subject, "12345", "hash-abc"));

    expect(parts.resource).toEqual(res);
    expect(parts.subject).toEqual(subject);
    expect(parts.revision).toBe("12345");
    expect(parts.schemaHash).toBe("hash-abc");
  });

  it("round-trips ids containing the separator, '#' and '%' unmangled", () => {
    // The escaping contract of GrainKeyCodec: a literal separator in any field cannot corrupt the
    // key. This is the assertion that fails loudly if the escape ever becomes encodeURIComponent.
    const res = resource("doc/ument", "id#with/slash%percent", "vi/ew");
    const subject = resource("us/er#type", "al/ice", "rel%ation");

    const parts = grainKeyParse(grainKeyBuild(res, subject, "rev/ision#1", "hash%with/slash"));

    expect(parts.resource).toEqual(res);
    expect(parts.subject).toEqual(subject);
    expect(parts.revision).toBe("rev/ision#1");
    expect(parts.schemaHash).toBe("hash%with/slash");
  });

  it("escapes to .NET's Uri.EscapeDataString form, uppercase hex over the unreserved set", () => {
    const key = grainKeyBuild(
      resource("a/b", "c#d", "e%f"),
      resource("g", "h", ELLIPSIS),
      "1",
      "x",
    );

    expect(key).toBe("a%2Fb/c%23d/e%25f/g/h/.../1/x");
  });

  it("reproduces the revision string VERBATIM: it is never parsed and re-formatted", () => {
    // The revision component is whatever revision string the resolver pinned. Parsing it into a
    // bigint and re-rendering it would normalise a leading zero, or lose precision beyond 2^53,
    // and either would split one sub-problem across two cache entries.
    const padded = "0000012345";
    const huge = "1234567890123456789012345";

    expect(
      grainKeyParse(
        grainKeyBuild(resource("d", "r", "v"), resource("u", "a", ELLIPSIS), padded, "h"),
      ).revision,
    ).toBe(padded);
    expect(
      grainKeyParse(grainKeyBuild(resource("d", "r", "v"), resource("u", "a", ELLIPSIS), huge, "h"))
        .revision,
    ).toBe(huge);
  });

  it.each(["too/few/segments", "way/too/many/segments/than/the/eight/expected/right/here", ""])(
    "throws FormatError on the wrong segment count: %s",
    (malformed) => {
      expect(() => grainKeyParse(malformed)).toThrow(FormatError);
      expect(() => grainKeyParse(malformed)).toThrow("8");
    },
  );
});
