import { describe, expect, it } from "vitest";

import { fnv1a64 } from "./stable-hash";

/**
 * Ported from `GraphLocalityPlacementTests.Fnv1a64_matches_the_published_test_vectors`. Only that
 * one fact belongs to this slice; the rest of that C# class drives the placement director through
 * a mesh cluster.
 *
 * The hash picks the `indexb/{version}/{dir}/{bucket}` row a key lives in and the silo the
 * locality director picks, so it is DURABLE-LAYOUT-VISIBLE: a merely-different hash relocates
 * data. The C# folds `ulong` under `unchecked`, so the port must mask to 64 bits; it folds
 * `foreach (var ch in value)`, which is UTF-16 CODE UNITS, so an astral character contributes its
 * two surrogate halves and not one 21-bit code point.
 */
describe("fnv1a64", () => {
  it("matches the published FNV-1a 64-bit test vectors", () => {
    expect(fnv1a64("")).toBe(14695981039346656037n);
    expect(fnv1a64("a")).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64("foobar")).toBe(0x85944171f73967e8n);
  });

  it("folds UTF-16 code units, so an astral character contributes both surrogate halves", () => {
    // Verified against the C# helper. Folding U+1F600 as ONE code point instead would give
    // 0xb115bd4c88e32ddf - a different durable bucket for every key containing an emoji.
    expect(fnv1a64("\u{1F600}")).toBe(0xe5e45a0a241b88d8n);
    expect(fnv1a64("\u{1F600}")).not.toBe(0xb115bd4c88e32ddfn);

    // A LONE high surrogate is folded as that one code unit.
    expect(fnv1a64("\uD83D")).toBe(0xb03bb04c8770a9c8n);

    expect(fnv1a64("abc\u{1F600}def")).toBe(0xe70d383c7636664dn);
  });

  it("folds a non-ASCII BMP character as its single code unit, not its UTF-8 bytes", () => {
    // 0x00E9 xored once, NOT the two bytes 0xC3 0xA9.
    expect(fnv1a64("é")).toBe(0xaf64644c8602d3a4n);
  });

  it("stays inside the unsigned 64-bit range for a realistic grain key", () => {
    const hash = fnv1a64("document:readme#view");
    expect(hash).toBe(0x23a6d496e6bcbe5cn);
    expect(hash).toBeGreaterThanOrEqual(0n);
    expect(hash).toBeLessThanOrEqual(0xffffffffffffffffn);
  });

  it("returns a bigint so the caller's unsigned bucket modulo is exact", () => {
    // KeyIndexLayout.BucketOf does `hash % (ulong)bucketCount` and only then narrows to int.
    // Doing the modulo in `number` would first round the hash past 2^53.
    expect(typeof fnv1a64("foobar")).toBe("bigint");
    expect(Number(fnv1a64("foobar") % 16n)).toBe(8);
  });

  it("is a pure function of the string, not of process identity", () => {
    expect(fnv1a64("same")).toBe(fnv1a64("same"));
    expect(fnv1a64("same")).not.toBe(fnv1a64("Same"));
  });
});
