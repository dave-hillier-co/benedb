import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { describe, expect, it } from "vitest";

import { parseRevision } from "./revision-codec";

/**
 * No covering C# test - a characterization of `RevisionCodec.Parse`, the single dispatch point
 * from the revision string carried in a grain key back to an `IRevision`.
 *
 * The rejections matter more than the successes: `BulkExportCursor` decodes a client-supplied
 * cursor by handing its revision segment here and catching the throw. If a malformed string
 * parsed, a corrupt cursor would silently resume from the WRONG revision instead of failing.
 */
describe("parseRevision", () => {
  it("parses the integer nanosecond form into a timestamp revision", () => {
    const revision = parseRevision("1700000000000000000");

    expect(revision).toBeInstanceOf(TimestampRevision);
    expect((revision as TimestampRevision).timestampNanosSinceEpoch).toBe(1700000000000000000n);
    expect(revision.toString()).toBe("1700000000000000000");
  });

  it("keeps full int64 precision, well past 2^53", () => {
    const revision = parseRevision("9223372036854775807");

    expect((revision as TimestampRevision).timestampNanosSinceEpoch).toBe(9223372036854775807n);
  });

  it("round-trips whatever a revision rendered into a grain key", () => {
    const original = new TimestampRevision(42n);

    expect(parseRevision(original.toString()).equals(original)).toBe(true);
  });

  it.each([[""], ["   "], ["abc"], ["0x1f"], ["1e3"], ["1.5"], ["1 2"], ["+"], ["١٢٣"]])(
    "rejects the malformed form %j",
    (malformed) => {
      expect(() => parseRevision(malformed)).toThrow(SyntaxError);
    },
  );

  it("rejects a value outside the int64 range rather than truncating it", () => {
    expect(() => parseRevision("9223372036854775808")).toThrow(RangeError);
    expect(() => parseRevision("-9223372036854775809")).toThrow(RangeError);
  });

  it("rejects an absent revision even though the parameter is typed non-optional", () => {
    // `ArgumentNullException.ThrowIfNull`. Callers reach this from wire data, where the type is
    // a promise rather than a guarantee, and the cursor decoder relies on a throw.
    expect(() => parseRevision(undefined as unknown as string)).toThrow(InvalidArgumentError);
    expect(() => parseRevision(null as unknown as string)).toThrow(InvalidArgumentError);
  });
});
