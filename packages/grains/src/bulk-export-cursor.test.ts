import { FormatError } from "@spacedb/core/format-error";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { describe, expect, it } from "vitest";

import { encodeBulkExportCursor, tryDecodeBulkExportCursor } from "./bulk-export-cursor";

/**
 * NO COVERING C# TEST. This is a WIRE-VISIBLE TOKEN - `zed` round-trips it across requests - so the
 * gate has to pin the exact encoded BYTES, not merely that this implementation can read back what
 * it wrote. Characterized from `src/Spiceport.Server/Grains/BulkExportCursor.cs`.
 *
 * The contract, verbatim from the C#:
 *   * The payload is `v1\n{revisionString}\n{afterTuple}`, base64'd with `Convert.ToBase64String` -
 *     STANDARD base64, with `+`, `/` and `=` padding. NOT URL-safe.
 *   * The revision string is `IRevision.ToString()` (the nanos decimal string) and is re-parsed by
 *     `RevisionCodec`, so it is a bigint end to end and never a `number`.
 *   * `Convert.FromBase64String` THROWS on malformed input, while `Buffer.from(s, "base64")` never
 *     does - it skips invalid characters and truncates. The port must therefore validate the
 *     alphabet, the length and the padding itself; .NET's decoder tolerates exactly space, tab, CR
 *     and LF as embedded whitespace, which is pinned below.
 *   * The payload splits on `\n` into EXACTLY three parts with `parts[0] === "v1"`. A tuple that
 *     itself contains a newline yields more parts and is REJECTED, as it is in C#.
 *   * Every failure path throws with the literal message `invalid bulk export cursor`.
 *   * The try-decode returns "absent" for a null/empty cursor (a first page) but THROWS for a
 *     malformed non-empty one. The two must not be merged.
 */
describe("bulk export cursor", () => {
  const revision = new TimestampRevision(1_234_567_890_123_456_789n);

  it("encodes the exact bytes of the v1 record", () => {
    expect(encodeBulkExportCursor(revision, "document:1#viewer@user:alice")).toBe(
      "djEKMTIzNDU2Nzg5MDEyMzQ1Njc4OQpkb2N1bWVudDoxI3ZpZXdlckB1c2VyOmFsaWNl",
    );
  });

  it("encodes an empty after-tuple as a trailing empty third field", () => {
    expect(encodeBulkExportCursor(new TimestampRevision(5n), "")).toBe("djEKNQo=");
  });

  it("decodes the pinned token back to its revision and tuple", () => {
    const decoded = tryDecodeBulkExportCursor(
      "djEKMTIzNDU2Nzg5MDEyMzQ1Njc4OQpkb2N1bWVudDoxI3ZpZXdlckB1c2VyOmFsaWNl",
    );

    expect(decoded?.revision.toString()).toBe("1234567890123456789");
    expect(decoded?.afterTuple).toBe("document:1#viewer@user:alice");
  });

  it("keeps a full-precision nanos revision exact through the round trip", () => {
    // 1234567890123456789 is not representable as a `number`; a port that parses through one
    // would come back as ...4608 and silently resume the export at a different snapshot.
    const decoded = tryDecodeBulkExportCursor(encodeBulkExportCursor(revision, "t"));

    expect(decoded?.revision.toString()).toBe("1234567890123456789");
  });

  it("round-trips a tuple containing the base64-significant characters", () => {
    const tuple = "document:a+b/c=#viewer@user:alice";

    const decoded = tryDecodeBulkExportCursor(encodeBulkExportCursor(revision, tuple));

    expect(decoded?.afterTuple).toBe(tuple);
  });

  it.each([[undefined], [""]])("returns absent for the first page (%s)", (cursor) => {
    expect(tryDecodeBulkExportCursor(cursor)).toBeUndefined();
  });

  it("tolerates the whitespace .NET's base64 decoder ignores", () => {
    const token = "djEKNQo=";

    for (const whitespace of [" ", "\t", "\r", "\n"]) {
      const spaced = `${token.slice(0, 4)}${whitespace}${token.slice(4)}`;
      expect(tryDecodeBulkExportCursor(spaced)?.afterTuple).toBe("");
    }
  });

  it.each([
    ["not base64 at all", "!!!not-base64!!!"],
    ["a token whose length is not a multiple of four", "djEKNQo"],
    ["a token with misplaced padding", "dj=KNQo="],
    ["a wrong version tag", "djIKNQp4"],
    ["only two parts", "djEKNQ=="],
    ["four parts (a tuple containing a newline)", "djEKNQphCmI="],
    ["an unparseable revision", "djEKbm90YW51bWJlcgp4"],
  ])("throws the literal format message for %s", (_case, cursor) => {
    expect(() => tryDecodeBulkExportCursor(cursor)).toThrow(FormatError);
    expect(() => tryDecodeBulkExportCursor(cursor)).toThrow("invalid bulk export cursor");
  });

  it("does not silently truncate a token with an invalid character, as Buffer.from would", () => {
    // `Buffer.from("djEKN$Qo=", "base64")` drops the `$` and decodes something; .NET throws, and
    // so must this codec, or a corrupted cursor resumes an export at a fabricated position.
    expect(() => tryDecodeBulkExportCursor("djEKN$Qo=")).toThrow(FormatError);
  });
});
