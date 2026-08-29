import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import {
  caveatedPermissionship,
  expandTreeReplyExpandedAtToken,
  foundResourceWireLookedUpAtToken,
  foundSubjectStreamItemLookedUpAtToken,
  PERMISSIONSHIP_MEMBER,
  type ExpandModeWire,
  type ExpandTreeNodeWire,
  type ExpandTreeReply,
  type FoundResourceWire,
  type FoundSubjectStreamItem,
  type LookupResourcesArgs,
  type LookupSubjectsArgs,
  type SetOpWire,
} from "./reverse-ops-dtos";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/ReverseOpsDtos.cs`, which has
// NO covering C# test: Spiceport exercises these shapes only through `ReverseOps` and the gRPC
// front doors, both later slices. This is therefore the only gate they have for now.
//
// NONE of these types is `[GenerateSerializer]`: they run IN-PROCESS between `ReverseOps` and the
// gRPC front doors and cross no grain boundary. That distinction is preserved in the ported doc
// comments so a later slice does not accidentally send one. They stay DATA - a page is a page, not
// a generator - because being data is what lets the engine stream without an `IAsyncEnumerable`
// crossing a grain boundary.
describe("Permissionship", () => {
  it("exposes the unconditional member as a frozen singleton, not a factory", () => {
    // `public static Permissionship Member { get; }` - a static singleton property, so a frozen
    // module constant. A factory would hand out fresh objects and break any reference match.
    expect(PERMISSIONSHIP_MEMBER).toEqual({ isCaveated: false, missingContextParams: [] });
    expect(Object.isFrozen(PERMISSIONSHIP_MEMBER)).toBe(true);
    expect(Object.isFrozen(PERMISSIONSHIP_MEMBER.missingContextParams)).toBe(true);
  });

  it("builds a caveated member from the unresolved parameter names", () => {
    // `Caveated(missing)` IS a factory in the C#, and stays one here - the asymmetry with `Member`
    // is transliterated rather than smoothed over.
    const caveated = caveatedPermissionship(["min_age", "region"]);

    expect(caveated.isCaveated).toBe(true);
    expect(caveated.missingContextParams).toEqual(["min_age", "region"]);
    expect(caveatedPermissionship([])).not.toBe(PERMISSIONSHIP_MEMBER);
  });

  it("never represents a non-member: those are simply not yielded", () => {
    // Recorded because the absence is load-bearing: there is no third state, and a consumer that
    // invents one would start emitting rows the engine deliberately dropped.
    expect(PERMISSIONSHIP_MEMBER.isCaveated).toBe(false);
    expect(caveatedPermissionship(["x"]).isCaveated).toBe(true);
  });
});

describe("the reverse-ops enums", () => {
  it("has exactly the two expand modes", () => {
    const modes: readonly ExpandModeWire[] = ["shallow", "recursive"];

    expect(new Set(modes).size).toBe(2);
  });

  it("has exactly the three set operations", () => {
    const ops: readonly SetOpWire[] = ["union", "intersection", "exclusion"];

    expect(new Set(ops).size).toBe(3);
  });
});

describe("the default parameter values", () => {
  it("resolves an absent expandedAtToken to the empty string", () => {
    const reply: ExpandTreeReply = { root: leafNode() };

    expect(expandTreeReplyExpandedAtToken(reply)).toBe("");
    expect(expandTreeReplyExpandedAtToken({ root: leafNode(), expandedAtToken: "tok" })).toBe(
      "tok",
    );
    expect(reply.expandedAtToken).toBeUndefined();
  });

  it("resolves an absent lookedUpAtToken to the empty string on both stream items", () => {
    const subjectItem: FoundSubjectStreamItem = {
      subject: { subjectId: "alice", isWildcard: false, permissionship: PERMISSIONSHIP_MEMBER },
      resumeCursor: "c",
    };
    const resource: FoundResourceWire = {
      resourceId: "doc1",
      permissionship: PERMISSIONSHIP_MEMBER,
    };

    expect(foundSubjectStreamItemLookedUpAtToken(subjectItem)).toBe("");
    expect(foundResourceWireLookedUpAtToken(resource)).toBe("");
    expect(foundResourceWireLookedUpAtToken({ ...resource, lookedUpAtToken: "tok" })).toBe("tok");
  });

  it("keeps an absent afterResultCursor DISTINCT from an empty one", () => {
    // `string? AfterResultCursor = null` - and null means "no cursor available", which is not the
    // same as an empty cursor. Resolving this one to "" like the tokens above would tell a client
    // it may resume from the start of the stream.
    const noCursor: FoundResourceWire = {
      resourceId: "doc1",
      permissionship: PERMISSIONSHIP_MEMBER,
    };
    const emptyCursor: FoundResourceWire = { ...noCursor, afterResultCursor: "" };

    expect(noCursor.afterResultCursor).toBeUndefined();
    expect(emptyCursor.afterResultCursor).toBe("");
  });

  it("leaves an absent consistency absent, meaning minimize-latency at the resolver", () => {
    const subjects: LookupSubjectsArgs = {
      resourceType: "doc",
      resourceId: "1",
      permission: "view",
      subjectType: "user",
      subjectRelation: "...",
    };
    const resources: LookupResourcesArgs = {
      resourceType: "doc",
      permission: "view",
      subjectType: "user",
      subjectId: "alice",
      subjectRelation: "...",
    };

    expect(subjects.consistency).toBeUndefined();
    expect(resources.consistency).toBeUndefined();
    // `int? Limit` and `string? Cursor` are likewise absent by default: null or 0 means "the
    // engine default / unbounded in this slice", and null cursor means "start".
    expect(subjects.limit).toBeUndefined();
    expect(subjects.cursor).toBeUndefined();
    expect(subjects.context).toBeUndefined();
  });

  it("carries the request-time caveat context as a Map, matching the core context shape", () => {
    const args: LookupSubjectsArgs = {
      resourceType: "doc",
      resourceId: "1",
      permission: "view",
      subjectType: "user",
      subjectRelation: "...",
      context: new Map<string, unknown>([
        ["2", "two"],
        ["1", "one"],
      ]),
    };

    const back = deserializeValue<LookupSubjectsArgs>(serializeValue(args));

    expect(back.context).toBeInstanceOf(Map);
    expect([...(back.context?.keys() ?? [])]).toEqual(["2", "1"]);
  });
});

describe("ExpandTreeNodeWire", () => {
  it("is recursive, and its 'exactly one of subjects or children' invariant is DOCUMENTED, not typed", () => {
    // Deliberately not redesigned into a discriminated union: the C# is the authority on this
    // shape and `isLeaf` plus two always-present lists is what it says. A union here would be a
    // redesign, and the gRPC front door mirrors the C# field-for-field.
    const tree: ExpandTreeNodeWire = {
      expandedType: "doc",
      expandedId: "1",
      expandedRelation: "view",
      caveatMissingFields: [],
      isLeaf: false,
      operation: "exclusion",
      subjects: [],
      children: [leafNode()],
    };

    const back = deserializeValue<ExpandTreeNodeWire>(serializeValue(tree));

    expect(back.isLeaf).toBe(false);
    expect(back.subjects).toEqual([]);
    expect(back.children).toHaveLength(1);
    expect(back.children[0]?.isLeaf).toBe(true);
    expect(back.children[0]?.subjects[0]?.subjectId).toBe("alice");
  });

  it("marks a node caveated by a NON-EMPTY missing-fields list, and a leaf's subject likewise", () => {
    const node = leafNode();

    expect(node.caveatMissingFields).toEqual([]);
    expect(node.subjects[0]?.caveatMissingFields).toEqual([]);
    expect({ ...node, caveatMissingFields: ["min_age"] }.caveatMissingFields).toHaveLength(1);
  });
});

describe("FoundResourceWire", () => {
  it("doubles as its own stream item: it already carries the per-item resume cursor", () => {
    // No wrapper, unlike `FoundSubjectStreamItem`. That asymmetry is the C#'s and is kept.
    const found: FoundResourceWire = {
      resourceId: "doc1",
      permissionship: caveatedPermissionship(["min_age"]),
      afterResultCursor: "cursor-1",
      lookedUpAtToken: "tok",
    };

    const back = deserializeValue<FoundResourceWire>(serializeValue(found));

    expect(back).toEqual(found);
    expect(back.afterResultCursor).toBe("cursor-1");
  });
});

function leafNode(): ExpandTreeNodeWire {
  return {
    expandedType: "doc",
    expandedId: "1",
    expandedRelation: "viewer",
    caveatMissingFields: [],
    isLeaf: true,
    operation: "union",
    subjects: [
      {
        subjectType: "user",
        subjectId: "alice",
        subjectRelation: "...",
        isWildcard: false,
        caveatMissingFields: [],
      },
    ],
    children: [],
  };
}
