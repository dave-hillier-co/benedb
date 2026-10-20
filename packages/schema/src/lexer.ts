import { SchemaCompileException } from "./schema-compile-exception";

/**
 * Hand-written character-by-character lexer for the SpiceDB schema DSL.
 * Whitespace and comments are skipped; newlines do not produce tokens (the
 * parser is whitespace/terminator insensitive for the supported subset).
 *
 * Ported from Spiceport `Lexer.cs`. The C# class exposes only `Tokenize()`, so the port is a
 * closure over the input with `tokenize` as its single entry point.
 *
 * Port decisions:
 *   * `char.IsLetter`/`IsLetterOrDigit`/`IsDigit` are Unicode-aware in .NET, so the character
 *     classes use `\p{L}` and `\p{Nd}` with the `u` flag rather than ASCII ranges.
 *   * A C# `char` is a UTF-16 CODE UNIT. Every position (`offset`, `column`) is code-unit based,
 *     which is what lets the parser slice a caveat body out of the original source by offset, so
 *     the scan indexes with `input[pos]` and never iterates by code point.
 *   * `Token` is a `readonly record struct`, so `tokens[i] = token with { ... }` writes a copy
 *     back into the list. `applyFlags` builds a new object and assigns it back.
 *   * `Advance()` indexes `_input[_pos]` unguarded and throws in C# at end of input; JS would
 *     silently yield `undefined`, so the port keeps the same AtEnd invariant and reads a
 *     defaulted character.
 *
 * Comments are skipped as trivia but kept, verbatim with their markers, on the next token
 * (`Token.comments`) - SpiceDB's parser does the same in `consumeToken`
 * (pkg/schemadsl/parser/parser_impl.go). SpiceDB's lexer turns a newline that follows an
 * identifier, keyword, `}`, `)` or `*` into a synthetic semicolon token
 * (pkg/schemadsl/lexer/lex_def.go `syntheticPredecessors`), and the comments before it attach to
 * that semicolon rather than to the next statement; this lexer emits no semicolon there, so it
 * drops the pending comments instead, with the same result: a trailing comment on a statement
 * line is nobody's doc comment.
 */

/** The kinds of tokens produced by the schema DSL lexer. */
export type TokenType =
  | "eof"
  | "keyword"
  | "identifier"
  | "number"
  | "string"
  | "leftBrace"
  | "rightBrace"
  | "leftParen"
  | "rightParen"
  | "pipe"
  | "plus"
  | "minus"
  | "and"
  | "slash"
  | "equals"
  | "colon"
  | "semicolon"
  | "rightArrow"
  | "hash"
  | "ellipsis"
  | "star"
  | "period"
  | "comma"
  | "lessThan"
  | "greaterThan"
  /**
   * Any character not otherwise recognized. Emitted rather than thrown so that caveat
   * bodies (captured verbatim) may contain arbitrary CEL operators such as `!`, `?`
   * or `%`; outside a caveat body the parser rejects it as a syntax error.
   */
  | "unknown";

/**
 * A single lexeme: its kind, text, 1-based source position, absolute character offset, and the
 * comments lexed since the previous token that SpiceDB's parser would attach to it (absent when
 * there are none, the C#'s null).
 */
export interface Token {
  readonly type: TokenType;
  readonly text: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly comments?: readonly string[] | undefined;
}

const KEYWORDS: ReadonlySet<string> = new Set([
  "definition",
  "relation",
  "permission",
  "caveat",
  "nil",
  "use",
  "with",
]);

/**
 * Identifiers that are only promoted to keywords when the matching `use <flag>` declaration is
 * present. Mirrors SpiceDB's flaggable lexer (pkg/schemadsl/lexer/flags.go): `use expiration`
 * promotes `expiration` and `and`; `use self` promotes `self`. The flag must be declared before
 * any definition or caveat.
 */
const FLAG_PROMOTED_KEYWORDS: ReadonlyMap<string, readonly string[]> = new Map([
  ["expiration", ["expiration", "and"]],
  ["self", ["self"]],
]);

const IDENT_START = /[\p{L}]/u;
const IDENT_PART = /[\p{L}\p{Nd}]/u;
const DIGIT = /\p{Nd}/u;

/** Tokenizes the entire input, ending with an `eof` token. */
export function tokenize(input: string): Token[] {
  const lexer = new Lexer(input);
  return lexer.tokenize();
}

class Lexer {
  private readonly input: string;
  private pos = 0;
  private line = 1;
  private column = 1;

  /**
   * True while the last token lexed is one after which SpiceDB emits a synthetic semicolon at the
   * next newline. Cleared by that newline (a second newline is an ordinary one).
   */
  private newlineEndsStatement = false;

  constructor(input: string) {
    this.input = input;
  }

  private current(): string {
    return this.pos < this.input.length ? (this.input[this.pos] as string) : "\0";
  }

  private peek(ahead = 1): string {
    return this.pos + ahead < this.input.length ? (this.input[this.pos + ahead] as string) : "\0";
  }

  private atEnd(): boolean {
    return this.pos >= this.input.length;
  }

  private advance(): void {
    if (this.current() === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }

    this.pos++;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];
    for (;;) {
      const token = this.next();
      tokens.push(token);
      if (token.type === "eof") {
        break;
      }
    }

    return applyFlags(tokens);
  }

  private next(): Token {
    const comments = this.skipTrivia();
    const token = this.lexToken();
    this.newlineEndsStatement =
      token.type === "identifier" ||
      token.type === "keyword" ||
      token.type === "rightBrace" ||
      token.type === "rightParen" ||
      token.type === "star";
    return comments === undefined ? token : { ...token, comments };
  }

  private lexToken(): Token {
    if (this.atEnd()) {
      return { type: "eof", text: "", line: this.line, column: this.column, offset: this.pos };
    }

    const line = this.line;
    const col = this.column;
    const off = this.pos;
    const c = this.current();

    const single = (type: TokenType): Token => {
      this.advance();
      return { type, text: c, line, column: col, offset: off };
    };

    switch (c) {
      case "{":
        return single("leftBrace");
      case "}":
        return single("rightBrace");
      case "(":
        return single("leftParen");
      case ")":
        return single("rightParen");
      case "|":
        return single("pipe");
      case "+":
        return single("plus");
      case "&":
        return single("and");
      case "/":
        return single("slash");
      case "=":
        return single("equals");
      case ":":
        return single("colon");
      case ";":
        return single("semicolon");
      case "#":
        return single("hash");
      case "*":
        return single("star");
      case ",":
        return single("comma");
      case "<":
        return single("lessThan");
      case ">":
        return single("greaterThan");
      case "-":
        if (this.peek() === ">") {
          this.advance();
          this.advance();
          return { type: "rightArrow", text: "->", line, column: col, offset: off };
        }

        this.advance();
        return { type: "minus", text: "-", line, column: col, offset: off };
      case ".":
        if (this.peek() === "." && this.peek(2) === ".") {
          this.advance();
          this.advance();
          this.advance();
          return { type: "ellipsis", text: "...", line, column: col, offset: off };
        }

        this.advance();
        return { type: "period", text: ".", line, column: col, offset: off };
      case '"':
      case "'":
        return this.lexString(line, col, off);
      default:
        break;
    }

    if (isIdentStart(c)) {
      return this.lexIdentifierOrKeyword(line, col, off);
    }

    if (isDigit(c)) {
      return this.lexNumber(line, col, off);
    }

    // Unrecognized character: emit an Unknown token rather than throwing, so verbatim
    // caveat-body capture can balance braces over arbitrary CEL operators.
    this.advance();
    return { type: "unknown", text: c, line, column: col, offset: off };
  }

  /**
   * Skips whitespace and comments, returning the comments (verbatim, markers included) that are
   * still pending for the next token, or undefined when there are none.
   */
  private skipTrivia(): string[] | undefined {
    let comments: string[] | undefined;
    while (!this.atEnd()) {
      const c = this.current();
      if (c === " " || c === "\t") {
        this.advance();
        continue;
      }

      if (c === "\r" || c === "\n") {
        if (this.newlineEndsStatement) {
          // SpiceDB lexes this newline as a synthetic semicolon, which takes the comments.
          comments?.splice(0);
          this.newlineEndsStatement = false;
        }

        this.advance();
        continue;
      }

      const start = this.pos;
      if (c === "/" && this.peek() === "/") {
        while (!this.atEnd() && this.current() !== "\n" && this.current() !== "\r") {
          this.advance();
        }

        (comments ??= []).push(this.input.slice(start, this.pos));
        continue;
      }

      if (c === "/" && this.peek() === "*") {
        this.advance();
        this.advance();
        while (!this.atEnd() && !(this.current() === "*" && this.peek() === "/")) {
          this.advance();
        }

        if (!this.atEnd()) {
          this.advance();
          this.advance();
        }

        (comments ??= []).push(this.input.slice(start, this.pos));
        continue;
      }

      break;
    }

    return comments !== undefined && comments.length > 0 ? comments : undefined;
  }

  private lexIdentifierOrKeyword(line: number, col: number, off: number): Token {
    const start = this.pos;
    while (!this.atEnd() && isIdentPart(this.current())) {
      this.advance();
    }

    const text = this.input.slice(start, this.pos);
    const type: TokenType = KEYWORDS.has(text) ? "keyword" : "identifier";
    return { type, text, line, column: col, offset: off };
  }

  private lexNumber(line: number, col: number, off: number): Token {
    const start = this.pos;
    while (!this.atEnd() && isDigit(this.current())) {
      this.advance();
    }

    return {
      type: "number",
      text: this.input.slice(start, this.pos),
      line,
      column: col,
      offset: off,
    };
  }

  private lexString(line: number, col: number, off: number): Token {
    const quote = this.current();
    this.advance();
    const start = this.pos;
    while (!this.atEnd() && this.current() !== quote) {
      if (this.current() === "\\") {
        this.advance();
      }

      this.advance();
    }

    if (this.atEnd()) {
      throw new SchemaCompileException("unterminated string literal", line, col);
    }

    const text = this.input.slice(start, this.pos);
    this.advance();
    return { type: "string", text, line, column: col, offset: off };
  }
}

/**
 * Applies `use <flag>` declarations, promoting flag-gated identifiers (`expiration`, `and`,
 * `self`) to keywords. Mirrors SpiceDB's flaggable lexer: a `use` flag must appear before any
 * `definition` or `caveat` (otherwise it is rejected), and only the declared flags take effect.
 */
function applyFlags(tokens: Token[]): Token[] {
  const promoted = new Set<string>();
  let seenDefinition = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;

    if (token.type === "keyword" && token.text === "use") {
      if (seenDefinition) {
        throw new SchemaCompileException(
          "use flags must appear before any definition or caveat",
          token.line,
          token.column,
        );
      }

      const following = tokens[i + 1];
      if (
        following === undefined ||
        !(following.type === "identifier" || following.type === "keyword")
      ) {
        throw new SchemaCompileException(
          "expected a feature name after 'use'",
          token.line,
          token.column,
        );
      }

      const flag = following.text;
      const promotions = FLAG_PROMOTED_KEYWORDS.get(flag);
      if (promotions === undefined) {
        throw new SchemaCompileException(
          `unknown use flag '${flag}'`,
          following.line,
          following.column,
        );
      }

      for (const promotion of promotions) {
        promoted.add(promotion);
      }

      continue;
    }

    if (token.type === "keyword" && (token.text === "definition" || token.text === "caveat")) {
      seenDefinition = true;
    }
  }

  if (promoted.size === 0) {
    return tokens;
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as Token;
    if (token.type === "identifier" && promoted.has(token.text)) {
      tokens[i] = { ...token, type: "keyword" };
    }
  }

  return tokens;
}

function isIdentStart(c: string): boolean {
  return IDENT_START.test(c) || c === "_";
}

function isIdentPart(c: string): boolean {
  return IDENT_PART.test(c) || c === "_";
}

function isDigit(c: string): boolean {
  return DIGIT.test(c);
}
