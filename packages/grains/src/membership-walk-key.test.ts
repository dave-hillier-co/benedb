import { ELLIPSIS } from "@benedb/core/core-constants";
import { FormatError } from "@benedb/core/format-error";
import { describe, expect, it } from "vitest";

import { membershipWalkKeyBuild, membershipWalkKeyParse } from "./membership-walk-key";

// Characterization test for `src/Spiceport.Server/Grains/MembershipWalkKey.cs`, which has no
// covering C# test of its own (`MembershipWalkGrainTests` and `Stage4LeopardMeshTests` are mesh
// suites over the implementation; `GrainKeyCodecTests` only mentions this key in a comment). It
// mirrors `SubjectFrontierKeyTests`, which is the C# file this codec was written to mirror.

describe("membershipWalkKeyBuild / membershipWalkKeyParse", () => {
  it("builds FIVE segments in order: subjType/subjId/subjRelation/revision/schemaHash", () => {
    const key = membershipWalkKeyBuild("user", "alice", ELLIPSIS, "12345", "hash-abc");

    expect(key).toBe("user/alice/.../12345/hash-abc");
    expect(key.split("/")).toHaveLength(5);
  });

  it("round-trips every component", () => {
    const parts = membershipWalkKeyParse(
      membershipWalkKeyBuild("user", "alice", ELLIPSIS, "12345", "hash-abc"),
    );

    expect(parts.subjectType).toBe("user");
    expect(parts.subjectId).toBe("alice");
    expect(parts.subjectRelation).toBe(ELLIPSIS);
    expect(parts.revision).toBe("12345");
    expect(parts.schemaHash).toBe("hash-abc");
  });

  it("round-trips ids containing the separator, '#' and '%' unmangled", () => {
    const parts = membershipWalkKeyParse(
      membershipWalkKeyBuild(
        "us/er#type",
        "id#with/slash%percent",
        "rel%ation",
        "rev/ision#1",
        "hash%with/slash",
      ),
    );

    expect(parts.subjectType).toBe("us/er#type");
    expect(parts.subjectId).toBe("id#with/slash%percent");
    expect(parts.subjectRelation).toBe("rel%ation");
    expect(parts.revision).toBe("rev/ision#1");
    expect(parts.schemaHash).toBe("hash%with/slash");
  });

  it("carries the EXACT pinned revision verbatim, never a quantized or re-formatted one", () => {
    // Unlike GrainKey's quantized window, a walk runs over a reader pinned to this key's exact
    // revision - which is why this grain family has no fold/catch-up machinery at all. Parsing and
    // re-rendering the string would normalise a leading zero or lose precision beyond 2^53, and
    // either would break that exactness.
    const padded = "0000012345";
    const huge = "1234567890123456789012345";

    expect(
      membershipWalkKeyParse(membershipWalkKeyBuild("u", "a", ELLIPSIS, padded, "h")).revision,
    ).toBe(padded);
    expect(
      membershipWalkKeyParse(membershipWalkKeyBuild("u", "a", ELLIPSIS, huge, "h")).revision,
    ).toBe(huge);
  });

  it.each(["too/few", "way/too/many/segments/than/the/five/expected", ""])(
    "throws FormatError on the wrong segment count: %s",
    (malformed) => {
      expect(() => membershipWalkKeyParse(malformed)).toThrow(FormatError);
      expect(() => membershipWalkKeyParse(malformed)).toThrow("5");
    },
  );
});
