import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { describe, expect, it } from "vitest";

import { createFoundResource, type FoundResource } from "./found-resource";
import {
  createLookupResourcesCursor,
  createLookupResourcesCursorSection,
} from "./lookup-resources-cursor";

// CHARACTERIZATION test for `src/Spiceport.Server/Engine/Lookup/FoundResource.cs`, which has no
// covering C# test of its own - it is only ever asserted through LookupResourcesEngine's cases.
//
// Port decisions this file fixes:
//   * The C# has the same absent-vs-empty CONFLATION as `CheckResult`: the primary constructor
//     takes `IReadOnlyList<string>? MissingContextParams = null` and an `init` property
//     immediately re-declares it as `?? []`. So `missingContextParams` is NON-OPTIONAL on the
//     interface and {@link createFoundResource} applies the `?? []`; the field is never undefined.
//     This is the one place the "keep undefined and [] distinct" rule does not apply, because the
//     C# itself does not.
//   * `Membership` is both a member NAME on the record and the name of its type. In TypeScript
//     that is simply a property called `membership`; no disambiguation is needed.
//   * The record is DOCUMENTED as never carrying `notMember` - non-members are not yielded at all -
//     so the factory asserts it. In C# the invariant lives only in the doc comment.
//   * `AfterCursor` is set through `found with { AfterCursor = ... }` in two places in the engine
//     (`Prepend` and the Portion-1 yield). That is an object spread producing a FRESH object: the
//     engine relies on the original being unchanged as a result bubbles up through nested
//     recursion levels, so the spread must never be replaced by an in-place assignment.

describe("createFoundResource", () => {
  it("normalises an absent missing-params list to empty", () => {
    const found = createFoundResource("doc1", ["alice"], "member");

    expect(found.resourceId).toBe("doc1");
    expect(found.forSubjectIds).toEqual(["alice"]);
    expect(found.membership).toBe("member");
    expect(found.missingContextParams).toEqual([]);
    expect(found.afterCursor).toBeUndefined();
  });

  it("keeps an explicitly supplied missing-params list", () => {
    const found = createFoundResource("doc1", ["alice"], "caveated", ["age"]);

    expect(found.membership).toBe("caveated");
    expect(found.missingContextParams).toEqual(["age"]);
  });

  it("keeps an explicitly supplied EMPTY missing-params list as empty", () => {
    // `?? []` is not `|| []`: an explicit empty list survives as itself rather than being
    // re-created, matching the C# init-property expression.
    const supplied: readonly string[] = [];
    const found = createFoundResource("doc1", ["alice"], "caveated", supplied);

    expect(found.missingContextParams).toEqual([]);
  });

  it("keeps the for-subject ids exactly as given, in order", () => {
    // The engine sorts ordinally BEFORE constructing; the record itself never re-orders.
    const found = createFoundResource("doc1", ["carol", "alice", "bob"], "member");

    expect(found.forSubjectIds).toEqual(["carol", "alice", "bob"]);
  });

  it("carries an after-cursor when one is supplied", () => {
    const cursor = createLookupResourcesCursor([createLookupResourcesCursorSection(-1, "doc1")]);

    const found = createFoundResource("doc1", ["alice"], "member", undefined, cursor);

    expect(found.afterCursor).toBe(cursor);
  });

  it("rejects a notMember verdict, which the record documents as impossible", () => {
    // Non-members are simply not yielded, so a `notMember` FoundResource is a construction bug in
    // the engine, not a representable result.
    expect(() => createFoundResource("doc1", ["alice"], "notMember")).toThrow(InvalidArgumentError);
  });
});

describe("re-cursoring a found resource", () => {
  it("produces a fresh value and leaves the original untouched", () => {
    // The engine's `found with { AfterCursor = ... }`. The SAME `FoundResource` instance is
    // re-cursored once per nesting level as it bubbles up, so each level must see the value it
    // was handed, not one a deeper level rewrote.
    const original: FoundResource = createFoundResource("doc1", ["alice"], "member");
    const cursor = createLookupResourcesCursor([createLookupResourcesCursorSection(0)]);

    const decorated: FoundResource = { ...original, afterCursor: cursor };

    expect(decorated).not.toBe(original);
    expect(decorated.afterCursor).toBe(cursor);
    expect(original.afterCursor).toBeUndefined();
    expect(decorated.resourceId).toBe(original.resourceId);
    expect(decorated.forSubjectIds).toBe(original.forSubjectIds);
    expect(decorated.missingContextParams).toBe(original.missingContextParams);
  });
});
