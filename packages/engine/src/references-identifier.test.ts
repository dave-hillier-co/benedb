import { describe, expect, it } from "vitest";

import { referencesIdentifier } from "./references-identifier";

// No C# test covers this: it is the private `ReferencesIdentifier` of Spiceport
// `Engine/CaveatEvaluator.cs`, duplicated verbatim in `Engine/SchemaTypeValidator.cs` and
// extracted here so the two share one definition. The cases pin the two halves of the C# regex
// `(?<![\w.])<escaped>\b` and the Unicode substitution the port had to make for them.
describe("referencesIdentifier", () => {
  it("finds a whole-word reference", () => {
    expect(referencesIdentifier("tier > 5", "tier")).toBe(true);
    expect(referencesIdentifier("allowed || tier > 5", "tier")).toBe(true);
    expect(referencesIdentifier("!denied", "denied")).toBe(true);
    expect(referencesIdentifier("f(x, tier)", "tier")).toBe(true);
  });

  it("does not match a longer identifier that merely contains it", () => {
    expect(referencesIdentifier("tiered > 5", "tier")).toBe(false);
    expect(referencesIdentifier("my_tier > 5", "tier")).toBe(false);
  });

  it("does not match a field selection", () => {
    // The `.` in the lookbehind: `obj.tier` references `obj`, not a parameter named `tier`.
    expect(referencesIdentifier("obj.tier > 5", "tier")).toBe(false);
    expect(referencesIdentifier("obj.tier > 5", "obj")).toBe(true);
  });

  it("matches a non-ASCII parameter name as a whole word", () => {
    // .NET's `\w`/`\b` are Unicode-aware and JavaScript's are ASCII-only, so the port spells the
    // word class out. Without that, `naïve` would match inside `naïveté`.
    expect(referencesIdentifier("naïve > 5", "naïve")).toBe(true);
    expect(referencesIdentifier("naïveté > 5", "naïve")).toBe(false);
    expect(referencesIdentifier("obj.naïve > 5", "naïve")).toBe(false);
  });

  it("treats regex metacharacters in the identifier literally", () => {
    // `Regex.Escape` is hand-rolled; without it a `.` in a name would match any character.
    expect(referencesIdentifier("a+b", "a.b")).toBe(false);
    expect(referencesIdentifier("a.b", "a.b")).toBe(true);
  });
});
