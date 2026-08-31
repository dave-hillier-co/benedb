import type { RelationshipReference } from "@benedb/core/relationship-reference";
import { describe, expect, it } from "vitest";

import {
  createLookupResourcesCursor,
  createLookupResourcesCursorSection,
  LOOKUP_RESOURCES_CURSOR_EMPTY,
  type LookupResourcesCursor,
  type LookupResourcesCursorSection,
} from "./lookup-resources-cursor";

// CHARACTERIZATION test for `src/Spiceport.Server/Engine/Lookup/LookupResourcesCursor.cs`, which
// has no covering C# test of its own - it is exercised only through LookupResourcesEngine's paging
// cases. These assertions pin the shape and the value semantics the engine relies on, not the
// engine's use of them.
//
// Port decisions this file fixes:
//   * `ImmutableList<LookupResourcesCursorSection>` -> `readonly LookupResourcesCursorSection[]`,
//     COPIED ON WRITE. The engine only ever does `RemoveAt(0)` (-> `sections.slice(1)`) and
//     `Insert(0, section)` (-> `[section, ...inner]`), both non-mutating; `shift`/`unshift` would
//     corrupt a cursor another result still holds, so neither ever appears.
//   * `LookupResourcesCursor.Empty` is a `static` property with an initialised backing field, so
//     it is a FROZEN MODULE CONSTANT, never a factory. Call sites compare and reuse it, and a
//     factory would silently break every such match (the guide's static-singleton row).
//   * `EntrypointIndex` of -1 is a SENTINEL meaning "the Portion-1 self-match leaf". The engine
//     branches on `EntrypointIndex: >= 0` in three places, so it stays a plain `number` - modelling
//     it as a union would make every one of those comparisons a type error for no gain.
//   * `LastResourceId` and `AfterKeyset` are each meaningful for exactly ONE section kind and BOTH
//     are absent for a structural rewrite section. All three fields are kept and `undefined` stays
//     distinct from a value: an absent `AfterKeyset` means "the first chunk", which is not the same
//     as any keyset value.
//   * `AfterKeyset` is a core `RelationshipReference` (the exclusive datastore keyset). If a cursor
//     is ever base64'd for the wire, that encoding is decided at the API layer (S5), not here.

function keyset(resourceId: string, subjectId: string): RelationshipReference {
  return {
    resource: { objectType: "document", objectId: resourceId, relation: "viewer" },
    subject: { objectType: "user", objectId: subjectId, relation: "..." },
  };
}

describe("LOOKUP_RESOURCES_CURSOR_EMPTY", () => {
  it("is one shared frozen instance, not a fresh value per read", () => {
    // The C# `Empty` is a static property over an initialised backing field: every read is the
    // same object. Call sites reuse it, so a factory here would be a behaviour change.
    expect(LOOKUP_RESOURCES_CURSOR_EMPTY).toBe(LOOKUP_RESOURCES_CURSOR_EMPTY);
    expect(Object.isFrozen(LOOKUP_RESOURCES_CURSOR_EMPTY)).toBe(true);
  });

  it("carries a frozen, empty sections list", () => {
    expect(LOOKUP_RESOURCES_CURSOR_EMPTY.sections).toEqual([]);
    expect(Object.isFrozen(LOOKUP_RESOURCES_CURSOR_EMPTY.sections)).toBe(true);
  });
});

describe("createLookupResourcesCursorSection", () => {
  it("leaves both resume positions absent when only an entrypoint index is given", () => {
    // The C# record defaults both to null. Absent is NOT the empty string and NOT a keyset:
    // an absent `afterKeyset` means "resume from the start of this entrypoint".
    const section = createLookupResourcesCursorSection(3);

    expect(section.entrypointIndex).toBe(3);
    expect(section.lastResourceId).toBeUndefined();
    expect(section.afterKeyset).toBeUndefined();
  });

  it("carries a Portion-1 leaf as the -1 sentinel plus the last yielded resource id", () => {
    const section = createLookupResourcesCursorSection(-1, "doc2");

    expect(section.entrypointIndex).toBe(-1);
    expect(section.lastResourceId).toBe("doc2");
    expect(section.afterKeyset).toBeUndefined();
  });

  it("carries a query entrypoint as a non-negative index plus the exclusive keyset", () => {
    const after = keyset("doc9", "alice");
    const section = createLookupResourcesCursorSection(0, undefined, after);

    expect(section.entrypointIndex).toBe(0);
    expect(section.lastResourceId).toBeUndefined();
    expect(section.afterKeyset).toBe(after);
  });

  it("keeps an empty-string last resource id distinct from an absent one", () => {
    // `LastResourceId = ""` is a value, not an absence; the engine's `id <= skip1` ordinal
    // comparison would behave differently if the port collapsed the two.
    const section = createLookupResourcesCursorSection(-1, "");

    expect(section.lastResourceId).toBe("");
    expect(section.lastResourceId).not.toBeUndefined();
  });

  it("distinguishes the -1 sentinel from entrypoint index 0", () => {
    // The engine's three `EntrypointIndex: >= 0` guards turn on exactly this.
    expect(createLookupResourcesCursorSection(-1).entrypointIndex).toBeLessThan(0);
    expect(createLookupResourcesCursorSection(0).entrypointIndex).toBeGreaterThanOrEqual(0);
  });
});

describe("createLookupResourcesCursor", () => {
  it("keeps the sections in the given order, outermost first", () => {
    const outer = createLookupResourcesCursorSection(0, undefined, keyset("doc1", "alice"));
    const inner = createLookupResourcesCursorSection(-1, "doc3");

    const cursor = createLookupResourcesCursor([outer, inner]);

    expect(cursor.sections).toHaveLength(2);
    expect(cursor.sections[0]).toBe(outer);
    expect(cursor.sections[1]).toBe(inner);
  });

  it("snapshots its input, so a later mutation of the caller's array cannot reach it", () => {
    // `ImmutableList<T>` is genuinely immutable in the C#; a bare `readonly T[]` alias would only
    // be immutable by convention. A cursor is handed out on a `FoundResource` and held across
    // pages, so the snapshot is load-bearing rather than defensive style.
    const sections: LookupResourcesCursorSection[] = [createLookupResourcesCursorSection(0)];
    const cursor = createLookupResourcesCursor(sections);

    sections.push(createLookupResourcesCursorSection(1));

    expect(cursor.sections).toHaveLength(1);
  });

  it("builds an empty cursor that is equal to - but not identical with - the shared empty one", () => {
    const built: LookupResourcesCursor = createLookupResourcesCursor([]);

    expect(built.sections).toEqual([]);
    expect(built).not.toBe(LOOKUP_RESOURCES_CURSOR_EMPTY);
  });
});

describe("cursor section stacks are built by copy, never in place", () => {
  it("drops the outermost section without disturbing the original stack", () => {
    // The engine's `cursorSections.RemoveAt(0)`. `shift` would mutate a cursor the caller of a
    // deeper recursion level still holds.
    const stack = createLookupResourcesCursor([
      createLookupResourcesCursorSection(0),
      createLookupResourcesCursorSection(1),
      createLookupResourcesCursorSection(-1, "doc1"),
    ]);

    const deeper = stack.sections.slice(1);

    expect(deeper).toHaveLength(2);
    expect(stack.sections).toHaveLength(3);
    expect(deeper[0]).toBe(stack.sections[1]);
  });

  it("prepends this level's section onto a bubbled-up stack without disturbing it", () => {
    // The engine's `Prepend`: `inner.Insert(0, section)`. The ORIGINAL result's cursor must be
    // unchanged, because the same `FoundResource` bubbles up through several nesting levels.
    const inner = createLookupResourcesCursor([createLookupResourcesCursorSection(-1, "doc1")]);
    const section = createLookupResourcesCursorSection(2, undefined, keyset("doc4", "alice"));

    const outer = createLookupResourcesCursor([section, ...inner.sections]);

    expect(outer.sections.map((s) => s.entrypointIndex)).toEqual([2, -1]);
    expect(inner.sections.map((s) => s.entrypointIndex)).toEqual([-1]);
  });
});
