/**
 * Locates a caveat body's CEL expression as SpiceDB's schema parser does
 * (`pkg/schemadsl/parser/parser.go` `consumeCaveatExpression`): the source from the start of the
 * body's first token to the end of its last token, whitespace and comments being ignored tokens.
 * SpiceDB's lexer (`pkg/schemadsl/lexer/lex_def.go`) turns a newline that follows an identifier,
 * keyword (any alphanumeric run, numbers included), `}`, `)` or `*` into a synthetic semicolon
 * token, so an expression ending such a line keeps that newline.
 *
 * The text found here is what cel-go compiles upstream, so caveat compile errors carry upstream's
 * line, column and source snippet. It is not what the schema stores (`CaveatNode.expression`).
 *
 * Ported from Spiceport `Schema/CaveatExpressionExtent.cs`.
 *
 * Port decisions:
 *   * C# `char.IsLetterOrDigit` becomes the Unicode `\p{L}`/`\p{Nd}` test on a single UTF-16 code
 *     unit, as the C# tests a `char`.
 */
type Kind =
  | "none"
  | "identifier"
  | "rightBrace"
  | "rightParen"
  | "star"
  | "string"
  | "syntheticSemicolon"
  | "newline"
  | "other";

const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;

function isIdentifierChar(c: string): boolean {
  return c === "_" || LETTER_OR_DIGIT.test(c);
}

/**
 * Returns the [start, end) offsets of the expression within `[bodyStart, bodyEnd)`; an empty range
 * at `bodyStart` when the body has no tokens.
 */
export function findCaveatExpressionExtent(
  source: string,
  bodyStart: number,
  bodyEnd: number,
): { readonly start: number; readonly end: number } {
  let start: number | undefined;
  let end = bodyStart;
  let last = "none" as Kind;

  const significant = (tokenStart: number, tokenEnd: number, kind: Kind): void => {
    start ??= tokenStart;
    end = tokenEnd;
    last = kind;
  };

  let i = bodyStart;
  while (i < bodyEnd) {
    const c = source[i] as string;
    if (c === " " || c === "\t") {
      i++;
    } else if (c === "\r" || c === "\n") {
      if (
        last === "identifier" ||
        last === "rightBrace" ||
        last === "rightParen" ||
        last === "star"
      ) {
        significant(i, i + 1, "syntheticSemicolon");
      } else {
        last = "newline";
      }
      i++;
    } else if (c === "/" && i + 1 < bodyEnd && source[i + 1] === "/") {
      while (i < bodyEnd && source[i] !== "\r" && source[i] !== "\n") i++;
    } else if (c === "/" && i + 1 < bodyEnd && source[i + 1] === "*") {
      const close = source.slice(0, bodyEnd).indexOf("*/", i + 2);
      i = close < 0 ? bodyEnd : close + 2;
    } else if (isIdentifierChar(c)) {
      const tokenStart = i;
      while (i < bodyEnd && isIdentifierChar(source[i] as string)) i++;
      significant(tokenStart, i, "identifier");
    } else if (c === '"' || c === "'") {
      const tokenStart = i;
      let terminator = c;
      let allowNewlines = false;
      if (matches(source, i, bodyEnd, '"""') || matches(source, i, bodyEnd, "'''")) {
        // Upstream terminates a ''' string with """, and so does this.
        terminator = '"""';
        allowNewlines = true;
        i += 3;
      } else {
        i++;
      }

      while (i < bodyEnd && !matches(source, i, bodyEnd, terminator)) {
        if (!allowNewlines && (source[i] === "\r" || source[i] === "\n")) break;
        i++;
      }

      if (matches(source, i, bodyEnd, terminator)) i += terminator.length;
      significant(tokenStart, i, "string");
    } else {
      const kind: Kind =
        c === "}" ? "rightBrace" : c === ")" ? "rightParen" : c === "*" ? "star" : "other";
      significant(i, i + 1, kind);
      i++;
    }
  }

  return start === undefined ? { start: bodyStart, end: bodyStart } : { start, end };
}

/** The 0-based line and 0-based column, in code points, of `offset`. */
export function caveatExpressionLineAndColumn(
  source: string,
  offset: number,
): { readonly line: number; readonly column: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      lineStart = i + 1;
    }
  }

  let column = 0;
  for (let i = lineStart; i < offset; i++) {
    const code = source.charCodeAt(i);
    if (code < 0xdc00 || code > 0xdfff) column++;
  }

  return { line, column };
}

function matches(source: string, index: number, end: number, value: string): boolean {
  return index + value.length <= end && source.startsWith(value, index);
}
