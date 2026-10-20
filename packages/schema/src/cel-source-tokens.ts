import type { CelLocation } from "./cel-expr";

/** The lexical classes the parsed-expression conversion distinguishes. */
export type CelTokenKind = "identifier" | "number" | "string" | "punctuation";

/** One token of a CEL expression, placed as cel-go's lexer places it. */
export interface CelToken {
  readonly kind: CelTokenKind;
  readonly text: string;
  /** The 1-based line and 0-based code-point column of the token's first character. */
  readonly location: CelLocation;
  /** The code-point offset of the token's first character. */
  readonly offset: number;
  /** For an opening `(`, `[` or `{`, the index of its matching closer; otherwise -1. */
  readonly match: number;
}

const TWO_CHARACTER_OPERATORS: ReadonlySet<string> = new Set(["==", "!=", "<=", ">=", "&&", "||"]);
const STRING_PREFIXES: ReadonlySet<string> = new Set(["r", "R", "b", "B"]);

/**
 * Splits a CEL expression into the tokens of cel-go's `CEL.g4` lexer, with cel-go's source
 * positions: a 1-based line counted by `\n`, and a 0-based column counted in code points (cel-go
 * counts runes). Whitespace and `//` comments are skipped.
 *
 * This is not a parser and decides no structure: `@bufbuild/cel` has already parsed the expression
 * (the tokenizer only ever runs over text it accepted), and its tree carries no source positions
 * through its public API. `cel-parsed-expr` walks that tree over these tokens to recover the
 * position cel-go would give each node, which is what places a type error's line, column and caret.
 *
 * BeneDB-only: Spiceport's ANTLR parser supplies token positions itself.
 */
export function tokenizeCelSource(text: string): readonly CelToken[] {
  const chars = Array.from(text);
  const tokens: { -readonly [K in keyof CelToken]: CelToken[K] }[] = [];
  let line = 1;
  let lineStart = 0;
  let i = 0;

  const at = (index: number): string => chars[index] ?? "";

  while (i < chars.length) {
    const c = at(i);
    if (c === "\n") {
      line++;
      i++;
      lineStart = i;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    if (c === "/" && at(i + 1) === "/") {
      while (i < chars.length && at(i) !== "\n") i++;
      continue;
    }

    const start = i;
    const location: CelLocation = { line, column: start - lineStart };
    let kind: CelTokenKind;

    if (isIdentifierStart(c)) {
      while (isIdentifierPart(at(i))) i++;
      const word = chars.slice(start, i).join("");
      if (isStringPrefix(word) && (at(i) === '"' || at(i) === "'")) {
        i = endOfString(chars, i, word.includes("r") || word.includes("R"));
        kind = "string";
      } else {
        kind = "identifier";
      }
    } else if (isDigit(c) || (c === "." && isDigit(at(i + 1)))) {
      i = endOfNumber(chars, i);
      kind = "number";
    } else if (c === '"' || c === "'") {
      i = endOfString(chars, i, false);
      kind = "string";
    } else {
      i += TWO_CHARACTER_OPERATORS.has(c + at(i + 1)) ? 2 : 1;
      kind = "punctuation";
    }

    // A string literal may span lines (a triple-quoted one); keep the line count right after it.
    for (let j = start; j < i; j++) {
      if (at(j) === "\n") {
        line++;
        lineStart = j + 1;
      }
    }

    tokens.push({ kind, text: chars.slice(start, i).join(""), location, offset: start, match: -1 });
  }

  const open: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "punctuation") return;
    if (token.text === "(" || token.text === "[" || token.text === "{") {
      open.push(index);
    } else if (token.text === ")" || token.text === "]" || token.text === "}") {
      const opener = open.pop();
      if (opener !== undefined) (tokens[opener] as (typeof tokens)[number]).match = index;
    }
  });

  return tokens;
}

function isIdentifierStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentifierPart(c: string): boolean {
  return isIdentifierStart(c) || isDigit(c);
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isHexDigit(c: string): boolean {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

function isStringPrefix(word: string): boolean {
  if (word.length === 1) return STRING_PREFIXES.has(word);
  if (word.length !== 2) return false;
  const lower = word.toLowerCase();
  return lower === "rb" || lower === "br";
}

/** The end of a numeric literal starting at `i`, by maximal munch as cel-go's lexer. */
function endOfNumber(chars: readonly string[], i: number): number {
  const at = (index: number): string => chars[index] ?? "";
  if (at(i) === "0" && (at(i + 1) === "x" || at(i + 1) === "X") && isHexDigit(at(i + 2))) {
    i += 2;
    while (isHexDigit(at(i))) i++;
  } else {
    while (isDigit(at(i))) i++;
    if (at(i) === "." && isDigit(at(i + 1))) {
      i++;
      while (isDigit(at(i))) i++;
    }
    const exponentDigit = at(i + 1) === "+" || at(i + 1) === "-" ? i + 2 : i + 1;
    if ((at(i) === "e" || at(i) === "E") && isDigit(at(exponentDigit))) {
      i = exponentDigit;
      while (isDigit(at(i))) i++;
    }
  }
  if (at(i) === "u" || at(i) === "U") i++;
  return i;
}

/** The end of a quoted literal whose opening quote is at `i`. */
function endOfString(chars: readonly string[], i: number, raw: boolean): number {
  const quote = chars[i] as string;
  const triple = chars[i + 1] === quote && chars[i + 2] === quote;
  i += triple ? 3 : 1;
  while (i < chars.length) {
    const c = chars[i] as string;
    if (c === "\\" && !raw) {
      i += 2;
      continue;
    }
    if (c === quote && (!triple || (chars[i + 1] === quote && chars[i + 2] === quote))) {
      return i + (triple ? 3 : 1);
    }
    i++;
  }
  return i;
}
