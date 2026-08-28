import { FormatError } from "@spacedb/core/format-error";
import { describe, expect, it } from "vitest";

import {
  visitKeyFromCanonicalString,
  visitKeyOf,
  visitKeyToCanonicalString,
  type VisitKey,
} from "./i-dispatcher";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/VisitKeyTests.cs`, case for case.
//
// The C# `VisitKey` is a `readonly record struct` used as the element type of
// `ImmutableHashSet<VisitKey>`. TypeScript has no value equality, so the visited set becomes a
// `ReadonlySet<string>` keyed by this ALREADY-EXISTING canonical string - there is no second key.
// That makes these four cases load-bearing rather than incidental: the canonical string is now the
// identity, not merely a wire rendering of it.
//
// `Assert.Equal(key, parsed)` is C# record equality; `toEqual` is its structural counterpart.
// `Assert.Throws<FormatException>` becomes the project `FormatError` (per the port guide's
// exception table).

/** The C# `private const char Separator = (char)0x1F`, restated so the test is independent. */
const SEPARATOR = String.fromCharCode(0x1f);

function key(
  resourceType: string,
  resourceId: string,
  resourceRelation: string,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
): VisitKey {
  return { resourceType, resourceId, resourceRelation, subjectType, subjectId, subjectRelation };
}

describe("VisitKey canonical string", () => {
  // In Spiceport the visited set is `ImmutableHashSet<VisitKey>` over a `readonly record struct`,
  // so its identity is field-wise value equality and `ToCanonicalString` is only a wire
  // rendering. Here the string IS the identity, so it must be injective for ANY six strings --
  // nothing on this path enforces the SpiceDB object-id grammar, so the separator's absence is
  // not a property to rely on. A collision would silently merge two distinct sub-problems in the
  // cycle guard.
  it("distinguishes keys whose fields differ only by where a boundary falls", () => {
    const sep = String.fromCharCode(0x1f);
    const left = visitKeyOf(
      { objectType: "d", objectId: "x", relation: "r" },
      { objectType: "u", objectId: "a", relation: `b${sep}c` },
    );
    const right = visitKeyOf(
      { objectType: "d", objectId: "x", relation: "r" },
      { objectType: "u", objectId: `a${sep}b`, relation: "c" },
    );

    expect(visitKeyToCanonicalString(left)).not.toBe(visitKeyToCanonicalString(right));
  });

  it.each([String.fromCharCode(0x1f), " ", ":", "#", ""])(
    "round-trips a field containing %j",
    (char) => {
      const key = visitKeyOf(
        { objectType: "doc", objectId: `a${char}b`, relation: "viewer" },
        { objectType: "user", objectId: "alice", relation: "..." },
      );

      expect(visitKeyFromCanonicalString(visitKeyToCanonicalString(key))).toEqual(key);
    },
  );

  it("round-trips through toCanonicalString then fromCanonicalString", () => {
    const original = key("document", "doc1", "view", "user", "alice", "member");

    const canonical = visitKeyToCanonicalString(original);
    const parsed = visitKeyFromCanonicalString(canonical);

    expect(parsed).toEqual(original);
  });

  it("is injective across adjacent field boundaries", () => {
    // ("a", "bc", ...) and ("ab", "c", ...) must not collide on the joined string: the separator
    // (U+001F) cannot appear in an ONR field, so no naive concatenation ambiguity survives.
    const first = key("a", "bc", "rel", "user", "u", "...");
    const second = key("ab", "c", "rel", "user", "u", "...");

    expect(visitKeyToCanonicalString(first)).not.toBe(visitKeyToCanonicalString(second));
  });

  it("throws FormatError on too few parts", () => {
    const tooFew = ["document", "doc1", "view", "user", "alice"].join(SEPARATOR);

    expect(() => visitKeyFromCanonicalString(tooFew)).toThrow(FormatError);
  });

  it("throws FormatError on too many parts", () => {
    const tooMany = ["document", "doc1", "view", "user", "alice", "member", "extra"].join(
      SEPARATOR,
    );

    expect(() => visitKeyFromCanonicalString(tooMany)).toThrow(FormatError);
  });
});
