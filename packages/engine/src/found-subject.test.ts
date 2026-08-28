import { PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import { describe, expect, it } from "vitest";

import { caveatExpressionFromCaveat } from "./caveat-expression";
import { createFoundSubject, type FoundSubject } from "./found-subject";

// Characterization test for Spiceport `src/Spiceport.Server/Engine/Lookup/FoundSubject.cs`, which
// has no covering C# test of its own: it is exercised only through `LookupSubjectsEngineTests` and
// (later) the cross-API agreement tests. This file is the only direct gate on the value type.
//
// Port decisions pinned here:
//   * The record is `(SubjectId, Caveat = null, IsWildcard = false, ExcludedSubjects = null)`.
//     `isWildcard` is a REQUIRED member with a factory default of `false`, matching the C# where
//     the property always has a value; `caveat` and `excludedSubjects` stay genuinely absent.
//   * UNLIKE `CheckResult.missingExprFields` (which normalises null to empty), `ExcludedSubjects`
//     is NOT normalised: `SubjectSet.ToFoundSubjects` emits `null` - never `[]` - when a wildcard
//     has no exclusions. `undefined` and `[]` therefore stay DISTINCT here. They coincide in the
//     C# only because it never constructs the empty-list case.
//   * `IsWildcard` is a SEPARATE boolean from `SubjectId == "*"`. Both are set together by the
//     engine, but consumers read the flag, so the flag is not derived from the id - pinned below.
//   * The type is RECURSIVE: each excluded entry is itself a `FoundSubject` with its own caveat.
//   * A non-null `caveat` is the "Caveated marker", carried verbatim for the caller to
//     Collapse-evaluate; nothing here evaluates it.

const CAVEAT = caveatExpressionFromCaveat({ caveatName: "over_age" });
const EXCLUSION_CAVEAT = caveatExpressionFromCaveat({ caveatName: "in_hours" });

describe("createFoundSubject", () => {
  it("defaults every optional member the way the C# record does", () => {
    const found = createFoundSubject("alice");

    expect(found.subjectId).toBe("alice");
    expect(found.caveat).toBeUndefined();
    expect(found.isWildcard).toBe(false);
    expect(found.excludedSubjects).toBeUndefined();
  });

  it("carries the caveat verbatim as the Caveated marker", () => {
    const found = createFoundSubject("alice", CAVEAT);

    expect(found.caveat).toBe(CAVEAT);
    expect(found.isWildcard).toBe(false);
  });

  it("does NOT derive isWildcard from the subject id", () => {
    // A `FoundSubject("*")` in the C# has IsWildcard = false: the flag is independent state.
    const found = createFoundSubject(PUBLIC_WILDCARD);

    expect(found.subjectId).toBe(PUBLIC_WILDCARD);
    expect(found.isWildcard).toBe(false);
  });

  it("sets both the wildcard id and the flag for a real wildcard match", () => {
    const found = createFoundSubject(PUBLIC_WILDCARD, undefined, true);

    expect(found.subjectId).toBe(PUBLIC_WILDCARD);
    expect(found.isWildcard).toBe(true);
  });
});

describe("excludedSubjects", () => {
  it("keeps absent and empty distinct", () => {
    const absent = createFoundSubject(PUBLIC_WILDCARD, undefined, true);
    const empty = createFoundSubject(PUBLIC_WILDCARD, undefined, true, []);

    expect(absent.excludedSubjects).toBeUndefined();
    expect(empty.excludedSubjects).toEqual([]);
    expect(empty.excludedSubjects).not.toBeUndefined();
  });

  it("carries exclusions in order, each a FoundSubject in its own right", () => {
    const found = createFoundSubject(PUBLIC_WILDCARD, undefined, true, [
      createFoundSubject("bob"),
      createFoundSubject("carol", EXCLUSION_CAVEAT),
    ]);

    expect(found.excludedSubjects?.map((e) => e.subjectId)).toEqual(["bob", "carol"]);
    expect(found.excludedSubjects?.[0]?.caveat).toBeUndefined();
    expect(found.excludedSubjects?.[1]?.caveat).toBe(EXCLUSION_CAVEAT);
  });

  it("marks a conditionally-excluded subject as concrete, not wildcard", () => {
    const found = createFoundSubject(PUBLIC_WILDCARD, CAVEAT, true, [
      createFoundSubject("bob", EXCLUSION_CAVEAT),
    ]);

    expect(found.isWildcard).toBe(true);
    expect(found.caveat).toBe(CAVEAT);
    expect(found.excludedSubjects?.[0]?.isWildcard).toBe(false);
  });

  it("nests recursively", () => {
    const inner = createFoundSubject(PUBLIC_WILDCARD, undefined, true, [createFoundSubject("bob")]);
    const outer: FoundSubject = createFoundSubject(PUBLIC_WILDCARD, undefined, true, [inner]);

    expect(outer.excludedSubjects?.[0]?.excludedSubjects?.[0]?.subjectId).toBe("bob");
  });
});
