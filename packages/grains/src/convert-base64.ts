import { FormatError } from "@spacedb/core/format-error";

/**
 * `System.Convert`'s base64 pair, hand-rolled because the JavaScript equivalents differ in the one
 * way that matters for a WIRE-VISIBLE TOKEN.
 *
 * This module has NO C# source file: in Spiceport `BulkExportCursor` and `ReverseOpsCursorCodec`
 * both call `Convert.FromBase64String`/`ToBase64String` directly. `Buffer.from(s, "base64")` is not
 * that function - it NEVER throws, silently skipping invalid characters and truncating - so a
 * corrupted cursor would decode to a fabricated position instead of being rejected. Rather than
 * hand-rolling the same validation in two codecs, it lives here once.
 *
 * The encoding is STANDARD base64: the `+` and `/` alphabet with `=` padding, NOT the URL-safe
 * variant. (`ReverseOpsCursorCodec`'s doc comment claims URL-safe; its code calls
 * `Convert.ToBase64String`, and the code is the contract - see the note there.)
 */

// .NET's decoder ignores exactly these four characters as embedded whitespace - not `\v`, not `\f`.
const IGNORED_WHITESPACE = /[ \t\r\n]/g;

// A base64 body over the standard alphabet, with at most two trailing pad characters. Padding
// anywhere but at the very end fails here, exactly as it does in .NET.
const BASE64_SHAPE = /^[A-Za-z0-9+/]*={0,2}$/;

/** `Convert.ToBase64String(Encoding.UTF8.GetBytes(value))`. */
export function toBase64String(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * `Encoding.UTF8.GetString(Convert.FromBase64String(value))`, THROWING `FormatError` on malformed
 * input as `Convert.FromBase64String` throws `FormatException`. The message is .NET's own, because
 * in `ReverseOpsCursorCodec` this exception propagates to the caller unwrapped.
 */
export function fromBase64String(value: string): string {
  const cleaned = value.replace(IGNORED_WHITESPACE, "");
  if (cleaned.length % 4 !== 0 || !BASE64_SHAPE.test(cleaned)) {
    throw new FormatError(
      "The input is not a valid Base-64 string as it contains a non-base 64 character, more than two padding characters, or an illegal character among the padding characters.",
    );
  }

  // Validated above, so `Buffer.from`'s tolerance can no longer hide anything.
  return Buffer.from(cleaned, "base64").toString("utf8");
}
