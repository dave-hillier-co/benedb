import { FormatError } from "@spacedb/core/format-error";
import { describe, expect, it } from "vitest";

import { graphShardGrainKeyBuild, graphShardGrainKeyParse } from "./graph-shard-grain-key";
import type { GraphShardKeyWire } from "./graph-shard-key";

// Characterization test for `src/Spiceport.Server/Grains/GraphShardGrainKey.cs`, which has no
// covering C# test of its own (only mesh suites reference it).
//
// This string is WIRE- AND DURABLE-VISIBLE: it is the grain key, it is what
// `DatastoreMetaState.ForwardKeys`/`ReverseKeys` store, and it is the input to
// `KeyIndexLayout.BucketOf`. Its bytes are part of the durable layout, so the exact form is pinned,
// not merely its round-trip.

describe("graphShardGrainKeyBuild", () => {
  it("encodes the direction as the literal 'f' / 'r' segments", () => {
    // The GraphShardDirection union member names ("forward" / "reverse") must NEVER leak into the
    // key: the C# writes 'f' and 'r', and every durable row already written says so.
    expect(
      graphShardGrainKeyBuild({ direction: "forward", objectType: "document", objectId: "readme" }),
    ).toBe("f/document/readme");
    expect(
      graphShardGrainKeyBuild({ direction: "reverse", objectType: "document", objectId: "readme" }),
    ).toBe("r/document/readme");
  });

  it("builds THREE segments - deliberately no revision and no schema hash", () => {
    // One activation per SLICE, not per (slice, revision): the shard holds the key's whole MVCC
    // history within the GC window and serves any covered revision, so the revision is a call
    // argument on RowsAt rather than part of the identity.
    const key = graphShardGrainKeyBuild({
      direction: "forward",
      objectType: "document",
      objectId: "readme",
    });

    expect(key.split("/")).toHaveLength(3);
  });
});

describe("graphShardGrainKeyParse", () => {
  it.each([
    { direction: "forward", objectType: "document", objectId: "readme" },
    { direction: "reverse", objectType: "user", objectId: "alice" },
  ] as const)("round-trips %o", (key: GraphShardKeyWire) => {
    expect(graphShardGrainKeyParse(graphShardGrainKeyBuild(key))).toEqual(key);
  });

  it("round-trips object types and ids containing the separator, '#' and '%'", () => {
    const key: GraphShardKeyWire = {
      direction: "reverse",
      objectType: "doc/ument#x",
      objectId: "id%with/slash",
    };

    expect(graphShardGrainKeyParse(graphShardGrainKeyBuild(key))).toEqual(key);
  });

  it("throws FormatError naming the unknown direction and the key", () => {
    expect(() => graphShardGrainKeyParse("x/document/readme")).toThrow(FormatError);
    expect(() => graphShardGrainKeyParse("x/document/readme")).toThrow(
      "Malformed graph-shard key (unknown direction 'x'): 'x/document/readme'.",
    );
  });

  it("rejects the union member names as direction segments", () => {
    // The mirror of the build assertion: were the segment ever spelled from the union, this parse
    // would start accepting keys the C# rejects.
    expect(() => graphShardGrainKeyParse("forward/document/readme")).toThrow(FormatError);
  });

  it.each(["f/document", "f/document/readme/extra", ""])(
    "throws FormatError on the wrong segment count: %s",
    (malformed) => {
      // Thrown by the shared codec, BEFORE the direction is examined, and its message names the
      // expected count and the key.
      expect(() => graphShardGrainKeyParse(malformed)).toThrow(FormatError);
      expect(() => graphShardGrainKeyParse(malformed)).toThrow("3");
    },
  );
});
