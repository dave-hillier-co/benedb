const GENERIC = "unable to unescape string";
const OCTAL = "unable to unescape octal sequence in string";

/**
 * The validation half of cel-go's `parser/unescape.go`: decides whether a quoted string or bytes
 * literal unescapes, and with which message it fails. The decoded value is never needed by the
 * checker. Returns cel-go's error message for an invalid literal, or `undefined` when it unescapes.
 *
 * Ported from Spiceport `Engine/CelCheck/CelUnescape.cs`.
 */
export function celUnescapeError(input: string, isBytes: boolean): string | undefined {
  // All strings normalize newlines to the \n representation.
  let value = input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let n = value.length;
  if (n < 2) return GENERIC;

  let isRawLiteral = false;
  if (value[0] === "r" || value[0] === "R") {
    value = value.slice(1);
    n = value.length;
    isRawLiteral = true;
  }

  if (n === 0 || value[0] !== value[n - 1] || (value[0] !== '"' && value[0] !== "'")) {
    return GENERIC;
  }

  if (n >= 6) {
    if (value.startsWith("'''")) {
      if (!value.endsWith("'''")) return GENERIC;
      value = `"${value.slice(3, n - 3)}"`;
    } else if (value.startsWith('"""')) {
      if (!value.endsWith('"""')) return GENERIC;
      value = `"${value.slice(3, n - 3)}"`;
    }

    n = value.length;
  }

  value = value.slice(1, n - 1);
  if (isRawLiteral || !value.includes("\\")) return undefined;

  let s = value;
  while (s.length > 0) {
    const [error, rest] = unescapeChar(s, isBytes);
    if (error !== undefined) return error;
    s = rest;
  }

  return undefined;
}

function unescapeChar(s: string, isBytes: boolean): [error: string | undefined, rest: string] {
  if (s[0] !== "\\") return [undefined, s.slice(1)];

  if (s.length <= 1) return ["unable to unescape string, found '\\' as last character", ""];

  const c = s[1] as string;
  let rest = s.slice(2);
  switch (c) {
    case "a":
    case "b":
    case "f":
    case "n":
    case "r":
    case "t":
    case "v":
    case "\\":
    case "'":
    case '"':
    case "`":
    case "?":
      return [undefined, rest];

    case "x":
    case "X":
    case "u":
    case "U": {
      const count = c === "x" || c === "X" ? 2 : c === "u" ? 4 : 8;
      if (isBytes && (c === "u" || c === "U")) return [GENERIC, rest];
      if (rest.length < count) return [GENERIC, rest];
      let v = 0;
      for (let j = 0; j < count; j++) {
        const x = hexValue(rest[j] as string);
        if (x < 0) return [GENERIC, rest];
        v = v * 16 + x;
      }

      rest = rest.slice(count);
      if (!isBytes && v > 0x10ffff) return [GENERIC, rest];
      return [undefined, rest];
    }

    case "0":
    case "1":
    case "2":
    case "3": {
      if (rest.length < 2) return [OCTAL, rest];
      for (let j = 0; j < 2; j++) {
        const d = rest[j] as string;
        if (d < "0" || d > "7") return [OCTAL, rest];
      }

      return [undefined, rest.slice(2)];
    }

    default:
      return [GENERIC, rest];
  }
}

function hexValue(c: string): number {
  if (c >= "0" && c <= "9") return c.charCodeAt(0) - 48;
  if (c >= "a" && c <= "f") return c.charCodeAt(0) - 87;
  if (c >= "A" && c <= "F") return c.charCodeAt(0) - 55;
  return -1;
}
