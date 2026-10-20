/**
 * `string.Trim()` with .NET's whitespace set rather than JavaScript's.
 *
 * Shared by the parser (the caveat body) and the schema compiler (doc-comment lines), both of
 * which call `Trim()` in Spiceport. Not a C# file of its own: lifted out of `parser.ts` once a
 * second caller needed it.
 */

/**
 * The code units .NET's `char.IsWhiteSpace` reports, which is what `string.Trim()` strips: the
 * Unicode space separators plus the five C0 controls and NEL. The set includes U+0085 (NEL),
 * which JS `String.prototype.trim` does not strip, and excludes U+FEFF, which JS `trim` does
 * strip. The parser trims the caveat body and the compiler trims doc-comment lines with this
 * set, so the wire text matches the C#.
 */
const DOT_NET_WHITESPACE: ReadonlySet<string> = new Set(
  [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
    0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ].map((code) => String.fromCharCode(code)),
);

/** `string.Trim()` with .NET's whitespace set rather than JavaScript's. */
export function dotNetTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && DOT_NET_WHITESPACE.has(value[start] as string)) {
    start++;
  }

  while (end > start && DOT_NET_WHITESPACE.has(value[end - 1] as string)) {
    end--;
  }

  return value.slice(start, end);
}
