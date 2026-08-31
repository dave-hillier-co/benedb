import { FormatError } from "@benedb/core/format-error";

/**
 * Shared mechanics for the grain-key codecs (`GrainKey`, `SubjectFrontierKey`,
 * `MembershipWalkKey`): URL-style per-segment escaping joined on `/`, and a strict segment-count
 * parse. Each grain-key type keeps its own build/parse signature and its own parts record - this
 * only factors out the identical escape/join/split/unescape mechanics they all hand-rolled the
 * same way.
 *
 * These strings ARE grain keys - activation identity, placement input, and the input to
 * `fnv1a64` for the durable key-index bucket - so the encoding must be byte-identical to .NET's
 * `Uri.EscapeDataString`, not merely round-trip-correct within this implementation.
 * `encodeURIComponent` is NOT that function: it additionally leaves `!'()*` unescaped, so the
 * escape is hand-rolled here over the RFC 3986 unreserved set.
 */

const SEPARATOR = "/";
const HEX = "0123456789ABCDEF";

const encoder = new TextEncoder();

/** `A-Za-z0-9-._~`, the RFC 3986 unreserved set - exactly what .NET leaves alone. */
function isUnreservedByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39) ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x5f ||
    byte === 0x7e
  );
}

/**
 * `Uri.EscapeDataString`: percent-encode the UTF-8 bytes outside the unreserved set, uppercase hex.
 *
 * Exported because `ReverseOpsCursorCodec` escapes its cursor SEGMENTS with the same function
 * while joining them on `;`/`:` rather than `/`, so it cannot go through `joinGrainKey`. Its token
 * is wire-visible, so it must be this escape and not `encodeURIComponent`.
 */
export function escapeDataString(value: string): string {
  const bytes = encoder.encode(value);
  let escaped = "";
  for (const byte of bytes) {
    if (isUnreservedByte(byte)) {
      escaped += String.fromCharCode(byte);
    } else {
      escaped += `%${HEX[byte >> 4]}${HEX[byte & 0x0f]}`;
    }
  }

  return escaped;
}

function hexValue(ch: string | undefined): number {
  if (ch === undefined) return -1;
  const code = ch.charCodeAt(0);
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

/**
 * Decodes one UTF-8 sequence starting at `at`, returning the character and how many bytes it
 * consumed, or `undefined` when the sequence is not well-formed. Overlong forms, surrogate
 * encodings and out-of-range lead bytes are all rejected.
 */
function decodeUtf8Sequence(
  bytes: readonly number[],
  at: number,
): { readonly text: string; readonly length: number } | undefined {
  const lead = bytes[at];
  if (lead === undefined) return undefined;
  if (lead < 0x80) return { text: String.fromCharCode(lead), length: 1 };

  let length: number;
  let lowerSecond = 0x80;
  let upperSecond = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) {
    length = 2;
  } else if (lead >= 0xe0 && lead <= 0xef) {
    length = 3;
    if (lead === 0xe0) lowerSecond = 0xa0;
    if (lead === 0xed) upperSecond = 0x9f;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    length = 4;
    if (lead === 0xf0) lowerSecond = 0x90;
    if (lead === 0xf4) upperSecond = 0x8f;
  } else {
    return undefined;
  }

  const sequence: number[] = [lead];
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i];
    if (byte === undefined) return undefined;
    const lower = i === 1 ? lowerSecond : 0x80;
    const upper = i === 1 ? upperSecond : 0xbf;
    if (byte < lower || byte > upper) return undefined;
    sequence.push(byte);
  }

  return { text: new TextDecoder().decode(new Uint8Array(sequence)), length };
}

/**
 * `Uri.UnescapeDataString`. Unlike `decodeURIComponent` it NEVER throws: a malformed `%`
 * sequence, and a percent-escaped byte run that is not valid UTF-8, are both left as the literal
 * source text with its original case. That tolerance is load-bearing - the C# `Split` only ever
 * throws on segment COUNT, and every caller catches only `FormatException`, so a `URIError` here
 * would escape as an unmapped 500. Exported alongside `escapeDataString`, for the same reason.
 */
export function unescapeDataString(value: string): string {
  let unescaped = "";
  let i = 0;
  while (i < value.length) {
    if (value[i] !== "%") {
      unescaped += value[i];
      i += 1;
      continue;
    }

    // Gather the maximal run of well-formed `%XX` escapes starting here, keeping the source
    // text of each so an undecodable byte can be emitted verbatim.
    const bytes: number[] = [];
    const sources: string[] = [];
    let scan = i;
    for (;;) {
      if (value[scan] !== "%") break;
      const high = hexValue(value[scan + 1]);
      const low = hexValue(value[scan + 2]);
      if (high < 0 || low < 0) break;
      bytes.push((high << 4) | low);
      sources.push(value.slice(scan, scan + 3));
      scan += 3;
    }

    if (bytes.length === 0) {
      unescaped += value[i];
      i += 1;
      continue;
    }

    let at = 0;
    while (at < bytes.length) {
      const decoded = decodeUtf8Sequence(bytes, at);
      if (decoded === undefined) {
        unescaped += sources[at];
        at += 1;
      } else {
        unescaped += decoded.text;
        at += decoded.length;
      }
    }

    i = scan;
  }

  return unescaped;
}

/** Escapes each segment and joins them on an unescaped `/`. */
export function joinGrainKey(...segments: string[]): string {
  return segments.map(escapeDataString).join(SEPARATOR);
}

/**
 * Splits on the unescaped `/`, requiring exactly `expectedCount` segments, then unescapes each.
 * The count is checked BEFORE unescaping, so an escaped separator inside a segment is not a
 * segment boundary.
 */
export function splitGrainKey(key: string, expectedCount: number): string[] {
  const parts = key.split(SEPARATOR);
  if (parts.length !== expectedCount) {
    throw new FormatError(`Malformed grain key (expected ${expectedCount} segments): '${key}'.`);
  }

  return parts.map(unescapeDataString);
}
