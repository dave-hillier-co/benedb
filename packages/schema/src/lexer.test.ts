import { describe, expect, it } from "vitest";

import { tokenize, type Token, type TokenType } from "./lexer";
import { SchemaCompileException } from "./schema-compile-exception";

// Ported from `SchemaCompilerTests`, which reaches the lexer only through `SchemaCompiler`, plus
// characterization of the behaviour those cases depend on but never observe directly. The cases
// that target the lexer specifically are `RejectsUnknownUseFlag`, `RejectsUseFlagAfterDefinition`,
// `CompilesSelfOperandUnderUseSelf`, `SelfWithoutFlagIsAnOrdinaryReference`,
// `RejectsWithExpirationWithoutUseFlag` and `CompilesWithExpirationRelation`; the flag tests below
// are those, moved down to the unit that decides them.
//
// Port decisions pinned here:
//
// 1. `char.IsLetter` / `IsLetterOrDigit` / `IsDigit` are UNICODE-aware in .NET. `/[a-zA-Z]/` is
//    not, so the port must use `\p{L}` and `\p{L}|\p{Nd}` with the `u` flag.
// 2. A C# `char` is a UTF-16 CODE UNIT, so a surrogate pair is two chars and NEITHER half is a
//    letter. Every position (`Offset`, `Column`) is code-unit based, which is what lets the parser
//    slice a caveat body out of the original source by offset. Iterating with `for..of` or spread
//    would drift on any astral character.
// 3. `Token` is a `readonly record struct`; `tokens[i] = token with { Type = Keyword }` writes a
//    COPY back into the list. The port must build a new object and assign it back rather than
//    mutate a shared one.
// 4. An unterminated BLOCK COMMENT silently consumes to end of input with no error, while an
//    unterminated STRING throws at the string's own start position. Both are deliberate.
// 5. `Unknown` is a token kind, not an error, so a caveat body may contain arbitrary CEL
//    operators (`!`, `?`, `%`) and still brace-balance.
function tokenAt(tokens: readonly Token[], index: number): Token {
  const token = tokens[index];
  if (token === undefined) {
    throw new Error(`no token at index ${index}`);
  }

  return token;
}

function kinds(tokens: readonly Token[]): readonly TokenType[] {
  return tokens.map((token) => token.type);
}

function texts(tokens: readonly Token[]): readonly string[] {
  return tokens.map((token) => token.text);
}

function compileError(input: string): SchemaCompileException {
  try {
    tokenize(input);
  } catch (error) {
    if (error instanceof SchemaCompileException) {
      return error;
    }

    throw error;
  }

  throw new Error(`expected tokenize(${JSON.stringify(input)}) to throw`);
}

describe("lexer", () => {
  it("tokenizes a definition, ending with an eof token", () => {
    const tokens = tokenize("definition user {}");

    expect(kinds(tokens)).toEqual(["keyword", "identifier", "leftBrace", "rightBrace", "eof"]);
    expect(texts(tokens)).toEqual(["definition", "user", "{", "}", ""]);
    expect(tokens.map((token) => token.offset)).toEqual([0, 11, 16, 17, 18]);
    expect(tokens.map((token) => token.column)).toEqual([1, 12, 17, 18, 19]);
    expect(tokens.every((token) => token.line === 1)).toBe(true);
  });

  it("recognizes exactly the unconditional keywords", () => {
    // `use` is the seventh unconditional keyword, but it cannot appear in this list: `applyFlags`
    // runs over the whole token stream and rejects a `use` that follows a `definition` or
    // `caveat`, so the `use flags` cases below are what pin it as a keyword.
    const tokens = tokenize("definition relation permission caveat nil with other");

    expect(kinds(tokens)).toEqual([
      "keyword",
      "keyword",
      "keyword",
      "keyword",
      "keyword",
      "keyword",
      "identifier",
      "eof",
    ]);
  });

  it("emits a token per punctuation form", () => {
    const tokens = tokenize("{}()|+&/=:;#*,<>");

    expect(kinds(tokens)).toEqual([
      "leftBrace",
      "rightBrace",
      "leftParen",
      "rightParen",
      "pipe",
      "plus",
      "and",
      "slash",
      "equals",
      "colon",
      "semicolon",
      "hash",
      "star",
      "comma",
      "lessThan",
      "greaterThan",
      "eof",
    ]);
  });

  it("prefers the two-character arrow over a bare minus", () => {
    expect(kinds(tokenize("a->b"))).toEqual(["identifier", "rightArrow", "identifier", "eof"]);
    expect(texts(tokenize("a->b"))).toEqual(["a", "->", "b", ""]);
    expect(kinds(tokenize("a - b"))).toEqual(["identifier", "minus", "identifier", "eof"]);
  });

  it("prefers the three-character ellipsis over a bare period", () => {
    expect(kinds(tokenize("#..."))).toEqual(["hash", "ellipsis", "eof"]);
    expect(texts(tokenize("#..."))).toEqual(["#", "...", ""]);
    expect(kinds(tokenize("a.any"))).toEqual(["identifier", "period", "identifier", "eof"]);
    expect(kinds(tokenize(".."))).toEqual(["period", "period", "eof"]);
  });

  it("distinguishes the '&' operator from the flag-gated 'and' keyword", () => {
    const ampersand = tokenAt(tokenize("a & b"), 1);

    expect(ampersand.type).toBe("and");
    expect(ampersand.text).toBe("&");
  });

  it("lexes runs of digits as a number", () => {
    const tokens = tokenize("123 4");

    expect(kinds(tokens)).toEqual(["number", "number", "eof"]);
    expect(texts(tokens)).toEqual(["123", "4", ""]);
  });

  it("allows underscores to start and continue an identifier", () => {
    const tokens = tokenize("_a1 a_1");

    expect(kinds(tokens)).toEqual(["identifier", "identifier", "eof"]);
    expect(texts(tokens)).toEqual(["_a1", "a_1", ""]);
  });

  it("accepts any Unicode letter in an identifier, as char.IsLetter does", () => {
    const tokens = tokenize("café Ünter δοκιμή");

    expect(kinds(tokens)).toEqual(["identifier", "identifier", "identifier", "eof"]);
    expect(texts(tokens)).toEqual(["café", "Ünter", "δοκιμή", ""]);
    expect(tokenAt(tokens, 3).offset).toBe("café Ünter δοκιμή".length);
  });

  it("accepts any Unicode decimal digit, as char.IsDigit does", () => {
    expect(kinds(tokenize("٣"))).toEqual(["number", "eof"]);
    expect(texts(tokenize("a٣"))).toEqual(["a٣", ""]);
  });

  it("treats each half of a surrogate pair as its own unknown token", () => {
    // U+1F600 is two UTF-16 code units and neither is a letter, so char-by-char lexing yields
    // two Unknown tokens at consecutive offsets. Code-point iteration would yield one.
    const tokens = tokenize("\u{1F600}");

    expect(kinds(tokens)).toEqual(["unknown", "unknown", "eof"]);
    expect(tokens.map((token) => token.offset)).toEqual([0, 1, 2]);
    expect(tokens.map((token) => token.column)).toEqual([1, 2, 3]);
    expect(tokenAt(tokens, 0).text + tokenAt(tokens, 1).text).toBe("\u{1F600}");
  });

  it("emits unrecognized characters as unknown tokens rather than throwing", () => {
    const tokens = tokenize("!?%");

    expect(kinds(tokens)).toEqual(["unknown", "unknown", "unknown", "eof"]);
    expect(texts(tokens)).toEqual(["!", "?", "%", ""]);
  });

  it("counts lines on newline and treats carriage return as an ordinary column", () => {
    const tokens = tokenize("a\r\nb");
    const b = tokenAt(tokens, 1);

    expect(b.line).toBe(2);
    expect(b.column).toBe(1);
    expect(b.offset).toBe(3);
  });

  it("skips line comments to the end of the line", () => {
    const tokens = tokenize("// note\ndefinition");
    const definition = tokenAt(tokens, 0);

    expect(kinds(tokens)).toEqual(["keyword", "eof"]);
    expect(definition.line).toBe(2);
    expect(definition.column).toBe(1);
    expect(definition.offset).toBe(8);
  });

  it("skips block comments, including across lines", () => {
    const tokens = tokenize("a /* one\ntwo */ b");
    const b = tokenAt(tokens, 1);

    expect(kinds(tokens)).toEqual(["identifier", "identifier", "eof"]);
    expect(b.line).toBe(2);
    expect(b.text).toBe("b");
  });

  it("consumes an unterminated block comment to end of input without an error", () => {
    const tokens = tokenize("definition /* user {}");

    expect(kinds(tokens)).toEqual(["keyword", "eof"]);
    expect(tokenAt(tokens, 1).offset).toBe("definition /* user {}".length);
  });

  it("keeps string bodies raw, with escapes unprocessed", () => {
    const tokens = tokenize('"a\\"b"');
    const literal = tokenAt(tokens, 0);

    expect(literal.type).toBe("string");
    expect(literal.text).toBe('a\\"b');
    expect(literal.offset).toBe(0);
    expect(kinds(tokens)).toEqual(["string", "eof"]);
  });

  it("accepts single-quoted strings", () => {
    const tokens = tokenize("'it \"is\" fine'");

    expect(kinds(tokens)).toEqual(["string", "eof"]);
    expect(tokenAt(tokens, 0).text).toBe('it "is" fine');
  });

  it("throws for an unterminated string, at the string's own start position", () => {
    const error = compileError('definition\n  "abc');

    expect(error.message).toContain("unterminated string literal");
    expect(error.line).toBe(2);
    expect(error.column).toBe(3);
  });

  describe("use flags", () => {
    it("leaves the gated identifiers alone when no flag is declared", () => {
      const tokens = tokenize("self and expiration");

      expect(kinds(tokens)).toEqual(["identifier", "identifier", "identifier", "eof"]);
    });

    it("promotes 'expiration' and 'and' under `use expiration`", () => {
      const tokens = tokenize("use expiration\nfoo and expiration self");

      expect(kinds(tokens)).toEqual([
        "keyword",
        "keyword",
        "identifier",
        "keyword",
        "keyword",
        "identifier",
        "eof",
      ]);
      expect(texts(tokens)).toEqual(["use", "expiration", "foo", "and", "expiration", "self", ""]);
    });

    it("promotes 'self' under `use self`, and nothing else", () => {
      const tokens = tokenize("use self\nself and expiration");

      expect(kinds(tokens)).toEqual([
        "keyword",
        "keyword",
        "keyword",
        "identifier",
        "identifier",
        "eof",
      ]);
    });

    it("accumulates the promotions of several flags", () => {
      const tokens = tokenize("use expiration\nuse self\nself and expiration");

      expect(kinds(tokens).slice(4)).toEqual(["keyword", "keyword", "keyword", "eof"]);
    });

    it("rejects a use flag that follows a definition", () => {
      const error = compileError("definition user {}\nuse expiration");

      expect(error.message).toContain("use flags must appear before any definition or caveat");
      expect(error.line).toBe(2);
      expect(error.column).toBe(1);
    });

    it("rejects a use flag that follows a caveat", () => {
      const error = compileError("caveat c(x int) { x > 0 }\nuse expiration");

      expect(error.message).toContain("use flags must appear before any definition or caveat");
    });

    it("rejects an unknown use flag, naming it", () => {
      const error = compileError("use bogus\ndefinition user {}");

      expect(error.message).toContain("unknown use flag 'bogus'");
      expect(error.line).toBe(1);
      expect(error.column).toBe(5);
    });

    it("rejects `use` with no feature name", () => {
      const error = compileError("use");

      expect(error.message).toContain("expected a feature name after 'use'");
      expect(error.line).toBe(1);
      expect(error.column).toBe(1);
    });

    it("rejects `use` followed by something that is not a name", () => {
      expect(() => tokenize("use {")).toThrow("expected a feature name after 'use'");
    });
  });
});
