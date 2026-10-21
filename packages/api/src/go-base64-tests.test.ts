import { describe, expect, it } from "vitest";

import { corruptInputOffset } from "./go-base64";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/GoBase64Tests.cs`: Go's
 * `base64.StdEncoding.DecodeString` failure offsets (`CorruptInputError`), each observed from Go's own
 * decoder, which SpiceDB quotes when a ZedToken is not base64.
 */
describe("GoBase64Tests", () => {
  it.each([
    ["garbage", 4],
    ["Zm9v YmFy", 4],
    ["Z===", 1],
    ["Zm=x", 2],
    ["Zm=", 3],
    ["Zm9v====", 4],
    ["Zm9vYg", 4],
    ["é", 0],
    ["Zm9vYg=", 7],
    ["Zm9vYg==x", 8],
    ["Zm9vYmFyZm9vYmFy!", 16],
  ] as const)("Reports_the_offset_Go_reports (%j)", (input, offset) => {
    expect(corruptInputOffset(input)).toBe(offset);
  });

  it.each(["", "Zm9vYmFy", "Zm9v\nYmFy", "Zm9vYg==", "Zm9vYmE=\n", "Zm9\r\nv", "Zm9vYm\n=\n="])(
    "Accepts_what_Go_accepts (%j)",
    (input) => {
      expect(corruptInputOffset(input)).toBeUndefined();
    },
  );
});
