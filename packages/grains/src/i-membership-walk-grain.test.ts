import type { GrainKeyFor } from "@thresh/core/key-kinds";
import { describe, expect, it } from "vitest";

import {
  IMembershipWalkGrain,
  resourceNodeKey,
  type MembershipClosureReply,
  type MembershipWalkArgs,
  type ResourceNodeWire,
} from "./i-membership-walk-grain";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/IMembershipWalkGrain.cs`,
// which has no covering C# test of its own (`MembershipWalkGrainTests` is a mesh suite driving the
// IMPLEMENTATION, a later slice). NOTHING HERE ACTIVATES A GRAIN.

describe("ResourceNodeWire", () => {
  it("has a canonical, unconditionally injective key so it can live in a Set", () => {
    // The C# record gets structural equality free, which is what puts these nodes in a HashSet and
    // dedupes the union of a walk's children. A JS `Set` keys by REFERENCE, so the port needs a
    // canonical key - and it must be injective UNCONDITIONALLY, because the equality it replaces
    // is. Length-prefixed, not joined on a separator "ids cannot contain": ids demonstrably can.
    const node: ResourceNodeWire = { type: "document", id: "readme", relation: "view" };

    expect(resourceNodeKey(node)).toBe(
      resourceNodeKey({ type: "document", id: "readme", relation: "view" }),
    );
    expect(resourceNodeKey(node)).not.toBe(resourceNodeKey({ ...node, id: "other" }));
    expect(resourceNodeKey(node)).not.toBe(resourceNodeKey({ ...node, relation: "edit" }));
    expect(resourceNodeKey(node)).not.toBe(resourceNodeKey({ ...node, type: "folder" }));
  });

  it("does not collide across field boundaries for ids containing the field separator", () => {
    const a = resourceNodeKey({ type: "a", id: "b:c", relation: "d" });
    const b = resourceNodeKey({ type: "a", id: "b", relation: "c:d" });
    const c = resourceNodeKey({ type: "a:b", id: "c", relation: "d" });

    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("dedupes structurally equal nodes when used as a Map key", () => {
    const nodes: readonly ResourceNodeWire[] = [
      { type: "document", id: "readme", relation: "view" },
      { type: "document", id: "readme", relation: "view" },
      { type: "document", id: "other", relation: "view" },
    ];

    const deduped = new Map(nodes.map((node) => [resourceNodeKey(node), node]));

    expect(deduped.size).toBe(2);
  });
});

describe("MembershipWalkArgs", () => {
  it("carries an EXACT ancestor path of canonical subject keys, root first, plus a depth budget", () => {
    // Deliberately NOT a bloom: unlike Check's probabilistic traversal filter, a false-positive
    // skip here would silently drop a whole subtree of candidates, which a completeness-critical
    // candidate walk cannot risk. `int DepthRemaining` -> number.
    const args: MembershipWalkArgs = {
      path: ["user:alice#...", "group:eng#member"],
      depthRemaining: 48,
    };

    expect(args.path).toEqual(["user:alice#...", "group:eng#member"]);
    expect(args.depthRemaining).toBe(48);
  });

  it("is threaded through recursion by COPYING at the call, never by pushing onto a shared array", () => {
    // The C# passes an immutable list, so each sibling branch sees only its own ancestors. The
    // port guide's immutable-set-in-recursion rule applies verbatim at the call sites: a shared
    // mutable array compiles, passes every single-path test, then prunes a live sibling branch.
    const parent: MembershipWalkArgs = { path: ["user:alice#..."], depthRemaining: 2 };
    const childA: MembershipWalkArgs = {
      path: [...parent.path, "group:eng#member"],
      depthRemaining: parent.depthRemaining - 1,
    };
    const childB: MembershipWalkArgs = {
      path: [...parent.path, "group:ops#member"],
      depthRemaining: parent.depthRemaining - 1,
    };

    expect(parent.path).toEqual(["user:alice#..."]);
    expect(childA.path).toEqual(["user:alice#...", "group:eng#member"]);
    expect(childB.path).toEqual(["user:alice#...", "group:ops#member"]);
  });
});

describe("MembershipClosureReply", () => {
  it("keeps CycleCut and Incomplete as DISTINCT flags with different meanings", () => {
    // A path-hit cut is still COMPLETE for reachability - the ancestor is already accounted for by
    // the path that reached it first - so, unlike Check's cycle cut, it does NOT force Incomplete.
    // Only Incomplete (depth exhausted) forces the caller back to the live traversal. Merging the
    // two would either discard sound results or trust partial ones.
    const cutButComplete: MembershipClosureReply = { nodes: [], cycleCut: true, incomplete: false };
    const depthExhausted: MembershipClosureReply = { nodes: [], cycleCut: false, incomplete: true };

    expect(cutButComplete.cycleCut).toBe(true);
    expect(cutButComplete.incomplete).toBe(false);
    expect(depthExhausted.cycleCut).toBe(false);
    expect(depthExhausted.incomplete).toBe(true);
  });
});

describe("IMembershipWalkGrain", () => {
  it("is both a type and a registered GrainInterface VALUE named for the C# interface", () => {
    expect(IMembershipWalkGrain.name).toBe("IMembershipWalkGrain");
  });

  it("carries NO per-method invocation options: GetContainingSet has no interleave attribute", () => {
    expect(IMembershipWalkGrain.options).toEqual({});
  });

  it("is string-keyed by subjType/subjId/subjRelation/revision/schemaHash", () => {
    const key: GrainKeyFor<IMembershipWalkGrain> = "user/alice/.../12345/hash-abc";

    expect(typeof key).toBe("string");
  });

  it("declares getContainingSet(args, signal?) => Promise<MembershipClosureReply>", () => {
    const reply: MembershipClosureReply = { nodes: [], cycleCut: false, incomplete: false };
    const fake: IMembershipWalkGrain = {
      getContainingSet: (_args: MembershipWalkArgs, _signal?: AbortSignal) =>
        Promise.resolve(reply),
    };

    expect(Object.keys(fake)).toEqual(["getContainingSet"]);
    return expect(fake.getContainingSet({ path: [], depthRemaining: 1 })).resolves.toEqual(reply);
  });
});
