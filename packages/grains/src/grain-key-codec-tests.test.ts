import { describe, expect, it } from "vitest";

import { FormatError } from "@benedb/core/format-error";

import { joinGrainKey, splitGrainKey } from "./grain-key-codec";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/GrainKeyCodecTests.cs`.
 *
 * `GrainKeyCodec` is the shared mechanics behind `GrainKey`, `SubjectFrontierKey` and
 * `MembershipWalkKey`: escape-join on `Join`, strict segment-count unescape-split on `Split`.
 *
 * A PURE UNIT: no cluster, no silo, nothing async.
 *
 * PORT NOTES.
 *  - This is a SEPARATE ledger row from `grain-key-codec.test.ts` (the characterization suite the
 *    codec itself landed with), so it lands as its own file at the ledger's path rather than
 *    being folded into that one. The two overlap by design - this is the C# author's own gate.
 *  - `GrainKeyCodec.Join(string[])` -> the variadic `joinGrainKey(...segments)`;
 *    `GrainKeyCodec.Split(key, count)` -> `splitGrainKey(key, count)`.
 *  - `FormatException` has no JS analogue; the port raises `@benedb/core`'s `FormatError`, which
 *    is what this asserts on. NOT a bare `toThrow()`: both message assertions - the expected
 *    segment count and the malformed key verbatim - are kept, because a message that names
 *    neither is useless at the call site where a malformed grain key actually surfaces.
 *  - `[Theory]`/`[InlineData]` -> `it.each` with a `%s` placeholder in the title, so a failing row
 *    names itself.
 */
describe("GrainKeyCodecTests", () => {
  it("Join_then_Split_round_trips_segments_containing_separators_and_percent_signs", () => {
    // The round trip is entirely about ESCAPING: every segment carries a separator, a `#`, or a
    // literal `%`. `%` must be escaped BEFORE the separator or the round trip is lossy, and the
    // escape-join must be injective or two different segment lists collide on one grain key.
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
    "Split_with_wrong_segment_count_throws_naming_expected_count_and_key (%s)",
    (malformed: string) => {
      let thrown: unknown;
      try {
        splitGrainKey(malformed, 3);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(FormatError);
      const message = (thrown as FormatError).message;
      expect(message).toContain("3");
      expect(message).toContain(malformed);
    },
  );
});
