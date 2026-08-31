import { FormatError } from "@benedb/core/format-error";
import { describe, expect, it } from "vitest";

import { joinGrainKey, splitGrainKey } from "./grain-key-codec";

/**
 * Ported from `GrainKeyCodecTests`, plus a characterization of the escape itself.
 *
 * These strings ARE grain keys: they are the activation identity, the placement input, and the
 * input to `fnv1a64` for the durable key-index bucket. So the encoding must be byte-identical
 * to `Uri.EscapeDataString`, not merely round-trip-correct within this implementation.
 * `encodeURIComponent` is NOT that function - it leaves `!'()*` unescaped - so the exact-output
 * cases below are the gate, not the round-trip.
 *
 * Expected outputs were taken from .NET 10 `Uri.EscapeDataString` / `Uri.UnescapeDataString`.
 */
describe("grain key codec", () => {
  it("round-trips segments containing separators and percent signs", () => {
    const segments = [
      "doc/ument",
      "id#with/slash%percent",
      "rel%ation",
      "rev/ision#1",
      "hash%with/slash",
    ];

    const key = joinGrainKey(...segments);
    const parsed = splitGrainKey(key, segments.length);

    expect(parsed).toEqual(segments);
  });

  it.each([["too/few"], ["way/too/many/segments/than/expected"]])(
    "throws naming the expected count and the key for %s",
    (malformed) => {
      let thrown: unknown;
      try {
        splitGrainKey(malformed, 3);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(FormatError);
      expect((thrown as FormatError).message).toContain("3");
      expect((thrown as FormatError).message).toContain(malformed);
    },
  );

  describe("join", () => {
    it("escapes everything outside the RFC 3986 unreserved set, in uppercase hex", () => {
      expect(joinGrainKey("doc/ument")).toBe("doc%2Fument");
      expect(joinGrainKey("id#with/slash%percent")).toBe("id%23with%2Fslash%25percent");
      expect(joinGrainKey("a b")).toBe("a%20b");
      expect(joinGrainKey("+&=?:@$,;[]")).toBe("%2B%26%3D%3F%3A%40%24%2C%3B%5B%5D");
    });

    it("leaves the unreserved set alone", () => {
      expect(joinGrainKey("AZaz09-._~")).toBe("AZaz09-._~");
    });

    it("escapes the sub-delims encodeURIComponent leaves alone", () => {
      // The single most likely port bug: reaching for the built-in. .NET escapes these five.
      expect(joinGrainKey("!'()*")).toBe("%21%27%28%29%2A");
      expect(joinGrainKey("!'()*")).not.toBe(encodeURIComponent("!'()*"));
    });

    it("percent-encodes the UTF-8 bytes of non-ASCII text", () => {
      expect(joinGrainKey("é")).toBe("%C3%A9");
      expect(joinGrainKey("\u{1F600}")).toBe("%F0%9F%98%80");
    });

    it("joins escaped segments on an unescaped separator", () => {
      expect(joinGrainKey("a", "b", "c")).toBe("a/b/c");
      expect(joinGrainKey("", "")).toBe("/");
      expect(joinGrainKey("only")).toBe("only");
      expect(joinGrainKey()).toBe("");
    });
  });

  describe("split", () => {
    it("unescapes each segment", () => {
      expect(splitGrainKey("doc%2Fument/%C3%A9", 2)).toEqual(["doc/ument", "é"]);
      expect(splitGrainKey("%21%27%28%29%2A", 1)).toEqual(["!'()*"]);
    });

    it("accepts an empty key as one empty segment", () => {
      expect(splitGrainKey("", 1)).toEqual([""]);
      expect(splitGrainKey("/", 2)).toEqual(["", ""]);
    });

    it("leaves a malformed percent sequence as literal text rather than throwing", () => {
      // `Uri.UnescapeDataString` never throws on a bad escape; `decodeURIComponent` throws
      // URIError. The C# Split only ever throws on segment COUNT, and every caller catches only
      // FormatException - a URIError here would escape as an unmapped 500.
      expect(splitGrainKey("a%zz", 1)).toEqual(["a%zz"]);
      expect(splitGrainKey("a%", 1)).toEqual(["a%"]);
      expect(splitGrainKey("%4", 1)).toEqual(["%4"]);
      expect(splitGrainKey("a%zzb%41", 1)).toEqual(["a%zzbA"]);
    });

    it("leaves a percent sequence that is not valid UTF-8 literal, preserving its case", () => {
      expect(splitGrainKey("%FF", 1)).toEqual(["%FF"]);
      expect(splitGrainKey("%ff", 1)).toEqual(["%ff"]);
      expect(splitGrainKey("%C3", 1)).toEqual(["%C3"]);
    });

    it("counts segments before unescaping, so an escaped separator is not a segment", () => {
      expect(splitGrainKey("a%2Fb", 1)).toEqual(["a/b"]);
      expect(() => splitGrainKey("a%2Fb", 2)).toThrow(FormatError);
    });
  });

  it("round-trips every escape-sensitive shape through join and split", () => {
    const segments = ["!'()*", "é", "\u{1F600}", "a b", "AZaz09-._~", "", "%", "%41"];

    expect(splitGrainKey(joinGrainKey(...segments), segments.length)).toEqual(segments);
  });
});
