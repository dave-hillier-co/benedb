import { ELLIPSIS } from "@benedb/core/core-constants";
import { describe, expect, it } from "vitest";

// Characterization additions to the ported `SubjectFrontierKeyTests` (see
// `subject-frontier-key-tests.test.ts`, which carries that C# file's cases verbatim). Only the two
// facts that file does not assert live here: the segment ORDER, pinned as an exact string, and the
// SEVEN-segment count that distinguishes this key from `GrainKey`'s eight.
import { subjectFrontierKeyBuild } from "./subject-frontier-key";

describe("subjectFrontierKeyBuild", () => {
  it("builds SEVEN segments in order, with NO subjectId", () => {
    // resType/resId/relation/subjType/subjRelation/revision/schemaHash. The missing eighth
    // segment - the subject id - is the point: this grain answers the whole frontier for a subject
    // TYPE and relation, and there is no dispatcher seam splitting it per subject the way
    // ICheckGrain's key does.
    const key = subjectFrontierKeyBuild(
      { objectType: "document", objectId: "readme", relation: "view" },
      "user",
      ELLIPSIS,
      "12345",
      "hash-abc",
    );

    expect(key).toBe("document/readme/view/user/.../12345/hash-abc");
    expect(key.split("/")).toHaveLength(7);
  });
});
