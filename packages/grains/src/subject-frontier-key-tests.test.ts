import { ELLIPSIS } from "@spacedb/core/core-constants";
import { FormatError } from "@spacedb/core/format-error";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { describe, expect, it } from "vitest";

import { subjectFrontierKeyBuild, subjectFrontierKeyParse } from "./subject-frontier-key";

// Ported from `tests/Spiceport.Grains.Tests/SubjectFrontierKeyTests.cs`.
//
// `SubjectFrontierKey` build/parse round-trip: escaping of separator/reserved characters and a
// strict segment-count parse. `FormatException` -> `FormatError`; `Assert.Equal` over the
// `ObjectAndRelation` record is structural, so it becomes `toEqual`, never `toBe`.

function resource(type: string, id: string, relation: string): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

describe("SubjectFrontierKey", () => {
  it("Build then Parse round trips every component", () => {
    const res = resource("document", "readme", "view");
    const key = subjectFrontierKeyBuild(res, "user", ELLIPSIS, "12345", "hash-abc");

    const parts = subjectFrontierKeyParse(key);

    expect(parts.resource).toEqual(res);
    expect(parts.subjectType).toBe("user");
    expect(parts.subjectRelation).toBe(ELLIPSIS);
    expect(parts.revision).toBe("12345");
    expect(parts.schemaHash).toBe("hash-abc");
  });

  it("ids containing separator, hash and percent round trip unmangled", () => {
    const res = resource("doc/ument", "id#with/slash%percent", "vi/ew");
    const key = subjectFrontierKeyBuild(
      res,
      "us/er#type",
      "rel%ation",
      "rev/ision#1",
      "hash%with/slash",
    );

    const parts = subjectFrontierKeyParse(key);

    expect(parts.resource).toEqual(res);
    expect(parts.subjectType).toBe("us/er#type");
    expect(parts.subjectRelation).toBe("rel%ation");
    expect(parts.revision).toBe("rev/ision#1");
    expect(parts.schemaHash).toBe("hash%with/slash");
  });

  it.each(["too/few/segments", "way/too/many/segments/than/the/seven/expected/here"])(
    "wrong segment count throws: %s",
    (malformed) => {
      expect(() => subjectFrontierKeyParse(malformed)).toThrow(FormatError);
    },
  );
});
