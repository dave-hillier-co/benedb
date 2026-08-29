import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import {
  graphShardKeyForResource,
  graphShardKeyForSubject,
  graphShardKeyMatches,
  graphShardKeyString,
  type GraphShardKeyWire,
} from "./graph-shard-key";
import type { RelationshipWire } from "./relationships-dtos";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/GraphShardKey.cs`.
//
// The C#'s covering test is `ShardFoldLemmaTests`, which drives `ShardFold` - a LATER batch of this
// stage. That test is the gate that proves the per-key restriction of the log fold partitions the
// whole state, and it is ported alongside the fold; nothing here weakens or pre-empts it. What this
// file pins is the value type itself, and specifically the one thing `ShardFoldLemmaTests` gets for
// free in C# and cannot get here: `GraphShardKeyWire` is used as a `Dictionary`/`HashSet` KEY
// (`forwardKeys.Concat(reverseKeys).ToDictionary(key => key, ...)`), which C# record equality
// answers structurally while a JS `Map`/`Set` keys by REFERENCE. The port therefore needs a
// canonical key string, and the lemma test will key its maps by that string.
describe("GraphShardKeyWire canonical keying", () => {
  it("gives equal-valued keys the same string and unequal keys different strings", () => {
    expect(graphShardKeyString(graphShardKeyForResource("doc", "1"))).toBe(
      graphShardKeyString({ direction: "forward", objectType: "doc", objectId: "1" }),
    );
    expect(graphShardKeyString(graphShardKeyForResource("doc", "1"))).not.toBe(
      graphShardKeyString(graphShardKeyForSubject("doc", "1")),
    );
    expect(graphShardKeyString(graphShardKeyForResource("doc", "1"))).not.toBe(
      graphShardKeyString(graphShardKeyForResource("doc", "2")),
    );
    expect(graphShardKeyString(graphShardKeyForResource("doc", "1"))).not.toBe(
      graphShardKeyString(graphShardKeyForResource("folder", "1")),
    );
  });

  it("is injective across field boundaries, even for ids containing the separator", () => {
    // The port guide requires the canonical key to be UNCONDITIONALLY injective, because the C#
    // record equality it replaces is. Joining on a character "the grammar excludes" is not enough:
    // object ids can and do contain slashes (which is exactly why `GrainKeyCodec` escapes them),
    // and a validator that would rule them out lives in a different layer and often does not run.
    const collisionCandidates: readonly GraphShardKeyWire[] = [
      { direction: "forward", objectType: "a/b", objectId: "c" },
      { direction: "forward", objectType: "a", objectId: "b/c" },
      { direction: "forward", objectType: "a", objectId: "" },
      { direction: "forward", objectType: "", objectId: "a" },
      { direction: "forward", objectType: "ab", objectId: "" },
      { direction: "forward", objectType: "", objectId: "ab" },
      { direction: "forward", objectType: "a:b", objectId: "c" },
      { direction: "forward", objectType: "a", objectId: ":b:c" },
    ];

    const strings = collisionCandidates.map(graphShardKeyString);

    expect(new Set(strings).size).toBe(collisionCandidates.length);
  });

  it("keys a Map by value once the canonical string is used", () => {
    const byKey = new Map<string, number>();
    byKey.set(graphShardKeyString(graphShardKeyForResource("doc", "1")), 1);
    byKey.set(graphShardKeyString(graphShardKeyForResource("doc", "1")), 2);

    expect(byKey.size).toBe(1);
    expect(
      byKey.get(graphShardKeyString({ direction: "forward", objectType: "doc", objectId: "1" })),
    ).toBe(2);
  });
});

describe("the two static shard-key factories", () => {
  it("ForResource names the forward slice and ForSubject the reverse one", () => {
    expect(graphShardKeyForResource("doc", "1")).toEqual({
      direction: "forward",
      objectType: "doc",
      objectId: "1",
    });
    expect(graphShardKeyForSubject("user", "alice")).toEqual({
      direction: "reverse",
      objectType: "user",
      objectId: "alice",
    });
  });

  it("round trips through the value codec", () => {
    const key = graphShardKeyForSubject("user", "alice");

    expect(deserializeValue<GraphShardKeyWire>(serializeValue(key))).toEqual(key);
  });
});

describe("graphShardKeyMatches", () => {
  const rel: RelationshipWire = {
    resourceType: "doc",
    resourceId: "1",
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: "...",
  };

  it("matches the forward slice on the RESOURCE type and id only", () => {
    expect(graphShardKeyMatches(graphShardKeyForResource("doc", "1"), rel)).toBe(true);
    expect(graphShardKeyMatches(graphShardKeyForResource("doc", "2"), rel)).toBe(false);
    expect(graphShardKeyMatches(graphShardKeyForResource("folder", "1"), rel)).toBe(false);
    // The relation is NOT part of the slice: every row with this resource belongs to it.
    expect(
      graphShardKeyMatches(graphShardKeyForResource("doc", "1"), {
        ...rel,
        resourceRelation: "editor",
      }),
    ).toBe(true);
  });

  it("matches the reverse slice on the SUBJECT type and id only", () => {
    expect(graphShardKeyMatches(graphShardKeyForSubject("user", "alice"), rel)).toBe(true);
    expect(graphShardKeyMatches(graphShardKeyForSubject("user", "bob"), rel)).toBe(false);
    expect(graphShardKeyMatches(graphShardKeyForSubject("group", "alice"), rel)).toBe(false);
    expect(
      graphShardKeyMatches(graphShardKeyForSubject("user", "alice"), {
        ...rel,
        subjectRelation: "member",
      }),
    ).toBe(true);
  });

  it("never confuses the resource side with the subject side", () => {
    // The forward key on ("user","alice") must NOT match a row whose SUBJECT is user:alice.
    expect(graphShardKeyMatches(graphShardKeyForResource("user", "alice"), rel)).toBe(false);
    expect(graphShardKeyMatches(graphShardKeyForSubject("doc", "1"), rel)).toBe(false);
  });

  it("compares ordinally, so case and Unicode normalization differences do not match", () => {
    // `StringComparison.Ordinal` in the C#; plain `===` in TypeScript already is ordinal.
    expect(graphShardKeyMatches(graphShardKeyForResource("Doc", "1"), rel)).toBe(false);
    expect(
      graphShardKeyMatches(graphShardKeyForResource("doc", "1"), { ...rel, resourceId: "1 " }),
    ).toBe(false);
    // U+00E9 versus "e" + U+0301 - the same text, differently normalized. Ordinal comparison
    // keeps them distinct, which is what makes the shard assignment byte-stable.
    expect(
      graphShardKeyMatches(graphShardKeyForSubject("user", "caf\u00e9"), {
        ...rel,
        subjectId: "cafe\u0301",
      }),
    ).toBe(false);
  });

  it("puts every relationship in exactly one forward and one reverse slice", () => {
    // The sharding lemma's premise, stated at the value type: the two derived keys always match,
    // and they are the only ones that do.
    expect(
      graphShardKeyMatches(graphShardKeyForResource(rel.resourceType, rel.resourceId), rel),
    ).toBe(true);
    expect(graphShardKeyMatches(graphShardKeyForSubject(rel.subjectType, rel.subjectId), rel)).toBe(
      true,
    );
  });
});
