import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { describe, expect, it } from "vitest";

import { grainKeyBuild } from "./grain-key";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { localityKey } from "./graph-locality-placement-director";
import { membershipWalkKeyBuild } from "./membership-walk-key";
import { subjectFrontierKeyBuild } from "./subject-frontier-key";

/**
 * Ported from `tests/Spiceport.Grains.Tests/GraphLocalityPlacementTests.cs`, the fact
 * `Locality_key_names_the_same_object_from_every_key_shape_that_reads_its_shard` (lines 22-66) -
 * a plain `[Fact] public void` that needs no cluster despite the class-level `[Collection]`.
 *
 * The class's other facts are deferred: `Fnv1a64_matches_the_published_test_vectors` belongs to
 * `StableHash` and is already ported in `stable-hash.test.ts`, and the remaining ones drive a
 * multi-silo `MeshTestCluster`, which needs grain implementations this slice does not have.
 *
 * The agreement asserted here IS the co-location property: the locality-key rule must name the
 * same object from every grain-key shape that reads that object's shard.
 */
function objectAndRelation(type: string, id: string, relation: string): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

describe("GraphLocalityPlacementTests", () => {
  it("Locality_key_names_the_same_object_from_every_key_shape_that_reads_its_shard", () => {
    const resource = objectAndRelation("document", "readme", "view");
    const subject = objectAndRelation("group", "eng", "member");

    // CheckGrain (8 segments) and the forward shard of its resource (3 segments) must agree: the
    // check's first data read is that shard.
    const checkKey = grainKeyBuild(resource, subject, "42", "hash");
    const forwardShardKey = graphShardGrainKeyBuild({
      direction: "forward",
      objectType: "document",
      objectId: "readme",
    });
    expect(localityKey(forwardShardKey)).toEqual(localityKey(checkKey));
    // Pinned rather than left to a vacuous undefined-equals-undefined: the 3-segment arm is
    // `parts[1]/parts[2]`, the (type, id) after the direction segment.
    expect(localityKey(forwardShardKey)).toBe("document/readme");

    // MembershipWalkGrain (5 segments) and the REVERSE shard of its subject (3 segments) must
    // agree: the walk's one data read is that shard. Direction is ignored by design, so the
    // reverse shard also agrees with the forward shard of the same object.
    const walkKey = membershipWalkKeyBuild("group", "eng", "member", "42", "hash");
    const reverseShardKey = graphShardGrainKeyBuild({
      direction: "reverse",
      objectType: "group",
      objectId: "eng",
    });
    expect(localityKey(reverseShardKey)).toEqual(localityKey(walkKey));
    expect(localityKey(walkKey)).toBe("group/eng");

    // SubjectFrontierGrain (7 segments) co-locates by its RESOURCE (its key names no subject id;
    // its whole walk starts from the resource root's forward shard).
    const frontierKey = subjectFrontierKeyBuild(resource, "user", ELLIPSIS, "42", "hash");
    expect(localityKey(checkKey)).toEqual(localityKey(frontierKey));

    // Escaping keeps the segment-count dispatch honest: a literal '/' in an id must not change the
    // recognized shape, and the escaped locality key must still agree across key shapes.
    const trickyShardKey = graphShardGrainKeyBuild({
      direction: "forward",
      objectType: "doc",
      objectId: "a/b",
    });
    const trickyCheckKey = grainKeyBuild(
      objectAndRelation("doc", "a/b", "view"),
      subject,
      "42",
      "hash",
    );
    expect(localityKey(trickyShardKey)).toEqual(localityKey(trickyCheckKey));
    // Segments are compared in their ESCAPED form - never unescaped - so the literal '/' stays
    // encoded and cannot fake an extra segment.
    expect(localityKey(trickyShardKey)).toBe("doc/a%2Fb");

    // An unrecognized shape yields null (the director then falls back to a random pick). `null` in
    // the C#; `undefined` here, per the repo's `undefined`-not-`null` convention.
    expect(localityKey("just/two")).toBeUndefined();
  });
});
