import { FormatError } from "@benedb/core/format-error";
import { describe, expect, it } from "vitest";

import {
  visitKeyFromCanonicalString,
  visitKeyOf,
  visitKeyToCanonicalString,
  type VisitKey,
} from "./i-dispatcher";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/VisitKeyTests.cs`, case for case, plus one
// BeneDB-only round-trip table (marked below).
//
// The C# `VisitKey` is a `readonly record struct` used as the element type of
// `ImmutableHashSet<VisitKey>`. TypeScript has no value equality, so the visited set becomes a
// `ReadonlySet<string>` keyed by this ALREADY-EXISTING canonical string - there is no second key.
// That makes these cases load-bearing rather than incidental: the canonical string is now the
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
  it("round-trips through toCanonicalString then fromCanonicalString", () => {
    const original = key("document", "doc1", "view", "user", "alice", "member");

    const canonical = visitKeyToCanonicalString(original);
    const parsed = visitKeyFromCanonicalString(canonical);

    expect(parsed).toEqual(original);
  });

  it("is injective across adjacent field boundaries", () => {
    // ("a", "bc", ...) and ("ab", "c", ...) must not collide on the rendered string: each part is
    // length-prefixed, so no concatenation ambiguity survives.
    const first = key("a", "bc", "rel", "user", "u", "...");
    const second = key("ab", "c", "rel", "user", "u", "...");

    expect(visitKeyToCanonicalString(first)).not.toBe(visitKeyToCanonicalString(second));
  });

  it("round-trips ids containing the unit separator", () => {
    // Nothing on the request path enforces the SpiceDB object-id grammar, so an id carrying the
    // separator character reaches the dispatcher and must survive the wire rendering intact.
    const original = key("document", `a${SEPARATOR}b`, "view", "user", "alice", "...");

    const parsed = visitKeyFromCanonicalString(visitKeyToCanonicalString(original));

    expect(parsed).toEqual(original);
  });

  it("renders keys differing only in separator placement distinctly", () => {
    const first = key("document", `a${SEPARATOR}b`, "c", "user", "alice", "...");
    const second = key("document", "a", `b${SEPARATOR}c`, "user", "alice", "...");

    expect(visitKeyToCanonicalString(first)).not.toBe(visitKeyToCanonicalString(second));
  });

  it.each([
    "",
    "x",
    `8${SEPARATOR}document`,
    `-1${SEPARATOR}`,
    `08${SEPARATOR}document4${SEPARATOR}doc14${SEPARATOR}view4${SEPARATOR}user5${SEPARATOR}alice3${SEPARATOR}...`,
    `8${SEPARATOR}document4${SEPARATOR}doc14${SEPARATOR}view4${SEPARATOR}user5${SEPARATOR}alice03${SEPARATOR}...`,
    `+8${SEPARATOR}document4${SEPARATOR}doc14${SEPARATOR}view4${SEPARATOR}user5${SEPARATOR}alice3${SEPARATOR}...`,
    `99${SEPARATOR}document4${SEPARATOR}doc14${SEPARATOR}view4${SEPARATOR}user5${SEPARATOR}alice3${SEPARATOR}...`,
    `8${SEPARATOR}document4${SEPARATOR}doc14${SEPARATOR}view4${SEPARATOR}user5${SEPARATOR}alice`,
    `8${SEPARATOR}document4${SEPARATOR}doc14${SEPARATOR}view4${SEPARATOR}user5${SEPARATOR}alice9${SEPARATOR}...`,
  ])("throws FormatError on a malformed length prefix: %j", (malformed) => {
    expect(() => visitKeyFromCanonicalString(malformed)).toThrow(FormatError);
  });

  it("throws FormatError on trailing data", () => {
    const canonical = visitKeyToCanonicalString(
      key("document", "doc1", "view", "user", "alice", "member"),
    );

    expect(() => visitKeyFromCanonicalString(canonical + "x")).toThrow(FormatError);
    expect(() => visitKeyFromCanonicalString(`${canonical}0${SEPARATOR}`)).toThrow(FormatError);
  });

  // BeneDB-only: the string is the visited-set identity here (see above), so a wider table of
  // field characters is pinned to round-trip.
  it.each([SEPARATOR, " ", ":", "#", ""])("round-trips a field containing %j", (char) => {
    const original = visitKeyOf(
      { objectType: "doc", objectId: `a${char}b`, relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: "..." },
    );

    expect(visitKeyFromCanonicalString(visitKeyToCanonicalString(original))).toEqual(original);
  });
});
