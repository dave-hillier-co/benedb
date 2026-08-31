import { ELLIPSIS } from "@benedb/core/core-constants";

import type {
  CaveatNode,
  CaveatParameterNode,
  CaveatTypeRefNode,
  DefinitionNode,
  ExprNode,
  PermissionNode,
  RelationNode,
  SchemaFileNode,
  SetOp,
  TypeRefNode,
} from "./ast";
import { tokenize, type Token, type TokenType } from "./lexer";
import { SchemaCompileException } from "./schema-compile-exception";

/**
 * Recursive-descent parser turning a token stream into a `SchemaFileNode` AST.
 * Supports definitions, relations (with type refs incl. `#subrelation` and `:*`),
 * and permissions with `+ & -` and `->` arrow operators plus `nil`.
 * Caveat blocks are consumed but not deeply modelled.
 *
 * Ported from Spiceport `Parser.cs`. The C# class has a private constructor and a single static
 * `Parse`, so the port exposes `parse` and keeps the state in a class used only from it.
 *
 * Port decisions:
 *   * The precedence chain is transliterated, NOT corrected: exclusion -> intersection -> union
 *     -> primary, so `+` binds tightest and `-` loosest. All three loops are left-associative.
 *   * The caveat body is sliced from the ORIGINAL SOURCE by token offsets and then trimmed with
 *     .NET `string.Trim()` semantics (`dotNetTrim`), because JS `trim` and .NET `Trim` disagree
 *     on U+0085 and U+FEFF and the trimmed text is wire-visible in
 *     `CaveatDefinition.SerializedExpression`.
 *   * `Current => _tokens[_pos]` relies on the trailing `eof` token; under
 *     `noUncheckedIndexedAccess` each access is guarded, and running off the end raises the same
 *     kind of failure the C# indexer would.
 */
export function parse(input: string): SchemaFileNode {
  const tokens = tokenize(input);
  return new Parser(tokens, input).parseFile();
}

class Parser {
  private readonly tokens: readonly Token[];
  private readonly source: string;
  private pos = 0;

  constructor(tokens: readonly Token[], source: string) {
    this.tokens = tokens;
    this.source = source;
  }

  private get current(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) {
      throw new SchemaCompileException("unexpected end of token stream");
    }

    return token;
  }

  private advance(): Token {
    const token = this.current;
    this.pos++;
    return token;
  }

  private is(type: TokenType): boolean {
    return this.current.type === type;
  }

  private isKeyword(keyword: string): boolean {
    return this.current.type === "keyword" && this.current.text === keyword;
  }

  private expect(type: TokenType, what: string): Token {
    if (!this.is(type)) {
      throw this.error(`expected ${what}, found '${this.tokenText()}'`);
    }

    return this.advance();
  }

  private tokenText(): string {
    return this.current.type === "eof" ? "<eof>" : this.current.text;
  }

  private error(message: string): SchemaCompileException {
    return new SchemaCompileException(message, this.current.line, this.current.column);
  }

  parseFile(): SchemaFileNode {
    const definitions: DefinitionNode[] = [];
    const caveats: CaveatNode[] = [];

    while (!this.is("eof")) {
      if (this.is("semicolon")) {
        this.advance();
        continue;
      }

      if (this.isKeyword("use")) {
        // Feature-flag import, e.g. `use expiration`. The flaggable lexer (see applyFlags) has
        // already validated the flag and promoted the gated keywords; here we just consume the
        // `use <feature>` pair.
        this.advance();
        this.advance(); // the feature name (identifier or now-promoted keyword)
      } else if (this.isKeyword("definition")) {
        definitions.push(this.parseDefinition());
      } else if (this.isKeyword("caveat")) {
        caveats.push(this.parseCaveat());
      } else {
        throw this.error(`expected 'definition' or 'caveat', found '${this.tokenText()}'`);
      }
    }

    return { definitions, caveats };
  }

  private parseDefinition(): DefinitionNode {
    this.advance(); // 'definition'
    const name = this.parseTypePath();
    this.expect("leftBrace", "'{'");

    const relations: RelationNode[] = [];
    const permissions: PermissionNode[] = [];

    while (!this.is("rightBrace") && !this.is("eof")) {
      if (this.is("semicolon")) {
        this.advance();
        continue;
      }

      if (this.isKeyword("relation")) {
        relations.push(this.parseRelation());
      } else if (this.isKeyword("permission")) {
        permissions.push(this.parsePermission());
      } else {
        throw this.error(`expected 'relation' or 'permission', found '${this.tokenText()}'`);
      }
    }

    this.expect("rightBrace", "'}'");
    return { name, relations, permissions };
  }

  private parseRelation(): RelationNode {
    this.advance(); // 'relation'
    const name = this.expect("identifier", "relation name").text;
    this.expect("colon", "':'");

    const types: TypeRefNode[] = [];
    types.push(this.parseTypeRef());
    while (this.is("pipe")) {
      this.advance();
      types.push(this.parseTypeRef());
    }

    this.consumeOptionalTerminator();
    return { name, allowedTypes: types };
  }

  private parseTypeRef(): TypeRefNode {
    const typeName = this.parseTypePath();
    let isWildcard = false;
    let subrelation: string | undefined;

    if (this.is("colon")) {
      this.advance();
      this.expect("star", "'*'");
      isWildcard = true;
    } else if (this.is("hash")) {
      this.advance();
      if (this.is("ellipsis")) {
        this.advance();
        subrelation = ELLIPSIS;
      } else {
        subrelation = this.expect("identifier", "subrelation name").text;
      }
    }

    let caveatName: string | undefined;
    let requiresExpiration = false;

    // Trait grammar (mirrors SpiceDB consumeSpecificTypeWithCaveat):
    //   with <caveat> [and expiration]   |   with expiration
    // 'with' is a reserved keyword; 'expiration'/'and' are keywords only under
    // `use expiration` (otherwise they remain identifiers, so `with expiration`
    // without the flag is rejected as a missing caveat name).
    if (this.isKeyword("with")) {
      this.advance(); // 'with'

      if (!this.isKeyword("expiration")) {
        caveatName = this.parseTypePath();

        if (this.isKeyword("and")) {
          this.advance(); // 'and'
          if (!this.isKeyword("expiration")) {
            throw this.error(`expected 'expiration' after 'and', found '${this.tokenText()}'`);
          }

          this.advance(); // 'expiration'
          requiresExpiration = true;
        }
      } else {
        this.advance(); // 'expiration'
        requiresExpiration = true;
      }
    }

    return { typeName, isWildcard, subrelation, caveatName, requiresExpiration };
  }

  private parsePermission(): PermissionNode {
    this.advance(); // 'permission'
    const name = this.expect("identifier", "permission name").text;

    // Optional type annotation: permission p: user | org = ...  (parsed and ignored).
    if (this.is("colon")) {
      this.advance();
      this.parseTypePath();
      while (this.is("pipe")) {
        this.advance();
        this.parseTypePath();
      }
    }

    this.expect("equals", "'='");
    const expression = this.parseExpression();
    this.consumeOptionalTerminator();
    return { name, expression };
  }

  // Expression precedence (lowest binds last): exclusion '-' < intersection '&' < union '+'.
  private parseExpression(): ExprNode {
    return this.parseExclusion();
  }

  private parseExclusion(): ExprNode {
    let left = this.parseIntersection();
    while (this.is("minus")) {
      this.advance();
      const right = this.parseIntersection();
      left = binaryExpr("exclusion", left, right);
    }

    return left;
  }

  private parseIntersection(): ExprNode {
    let left = this.parseUnion();
    while (this.is("and")) {
      this.advance();
      const right = this.parseUnion();
      left = binaryExpr("intersection", left, right);
    }

    return left;
  }

  private parseUnion(): ExprNode {
    let left = this.parsePrimary();
    while (this.is("plus")) {
      this.advance();
      const right = this.parsePrimary();
      left = binaryExpr("union", left, right);
    }

    return left;
  }

  private parsePrimary(): ExprNode {
    if (this.is("leftParen")) {
      this.advance();
      const inner = this.parseExpression();
      this.expect("rightParen", "')'");
      return inner;
    }

    if (this.isKeyword("nil")) {
      this.advance();
      return { kind: "nil" };
    }

    if (this.isKeyword("self")) {
      // The resource itself treated as its own subject. Only a keyword under
      // `use self`; otherwise `self` is an ordinary computed-userset reference.
      this.advance();
      return { kind: "self" };
    }

    if (this.is("identifier")) {
      const name = this.advance().text;

      if (this.is("rightArrow")) {
        this.advance();
        const computed = this.expect("identifier", "arrow target relation").text;
        this.rejectNestedArrow();
        return { kind: "arrow", tupleset: name, computed, functionName: undefined };
      }

      if (this.is("period")) {
        // tupleset.any(target) / tupleset.all(target)
        this.advance();
        const fn = this.expect("identifier", "arrow function name").text;
        this.expect("leftParen", "'('");
        const computed = this.expect("identifier", "arrow target relation").text;
        this.expect("rightParen", "')'");
        this.rejectNestedArrow();
        return { kind: "arrow", tupleset: name, computed, functionName: fn };
      }

      return { kind: "reference", name };
    }

    throw this.error(`expected an expression operand, found '${this.tokenText()}'`);
  }

  /**
   * Rejects chained/nested arrows (`a->b->c`) with the SpiceDB compiler diagnostic. SpiceDB
   * parses left-recursive arrows then errors in the translator; the port detects the trailing
   * arrow operator here and emits the same message.
   */
  private rejectNestedArrow(): void {
    if (this.is("rightArrow") || this.is("period")) {
      throw this.error("Nested arrows not yet supported");
    }
  }

  private parseCaveat(): CaveatNode {
    this.advance(); // 'caveat'
    const name = this.parseTypePath();

    // Parameter list: ( name type, name type, ... )
    this.expect("leftParen", "'('");
    const parameters: CaveatParameterNode[] = [];
    if (!this.is("rightParen")) {
      parameters.push(this.parseCaveatParameter());
      while (this.is("comma")) {
        this.advance();
        parameters.push(this.parseCaveatParameter());
      }
    }

    this.expect("rightParen", "')'");

    // Body: { CEL ... } - captured verbatim from source, not parsed here.
    const open = this.expect("leftBrace", "'{'");
    const close = this.skipBalancedBraces();

    // Slice raw CEL text between the braces, trimming surrounding whitespace.
    const bodyStart = open.offset + 1;
    const bodyEnd = close.offset;
    const expression = dotNetTrim(this.source.slice(bodyStart, bodyEnd));

    return { name, parameters, expression };
  }

  private parseCaveatParameter(): CaveatParameterNode {
    const paramName = this.expect("identifier", "caveat parameter name").text;
    const type = this.parseCaveatTypeRef();
    return { name: paramName, type };
  }

  private parseCaveatTypeRef(): CaveatTypeRefNode {
    const typeName = this.expect("identifier", "caveat parameter type").text;
    const children: CaveatTypeRefNode[] = [];

    if (this.is("lessThan")) {
      this.advance();
      children.push(this.parseCaveatTypeRef());
      while (this.is("comma")) {
        this.advance();
        children.push(this.parseCaveatTypeRef());
      }

      this.expect("greaterThan", "'>'");
    }

    return { name: typeName, childTypes: children };
  }

  private skipBalancedBraces(): Token {
    let depth = 1;
    while (depth > 0 && !this.is("eof")) {
      if (this.is("leftBrace")) {
        depth++;
      } else if (this.is("rightBrace")) {
        depth--;
        if (depth === 0) {
          return this.advance();
        }
      }

      this.advance();
    }

    throw this.error("unterminated caveat body");
  }

  /** Parses a slash-separated namespace path such as `org/user`. */
  private parseTypePath(): string {
    const segments: string[] = [this.expect("identifier", "type name").text];
    while (this.is("slash")) {
      this.advance();
      segments.push(this.expect("identifier", "type path segment").text);
    }

    return segments.join("/");
  }

  private consumeOptionalTerminator(): void {
    if (this.is("semicolon")) {
      this.advance();
    }
  }
}

function binaryExpr(op: SetOp, left: ExprNode, right: ExprNode): ExprNode {
  return { kind: "binary", op, left, right };
}

/**
 * The code units .NET's `char.IsWhiteSpace` reports, which is what `string.Trim()` strips: the
 * Unicode space separators plus the five C0 controls and NEL. The set includes U+0085 (NEL),
 * which JS `String.prototype.trim` does not strip, and excludes U+FEFF, which JS `trim` does
 * strip; the caveat body is trimmed with this set so the wire text matches the C#.
 */
const DOT_NET_WHITESPACE: ReadonlySet<string> = new Set(
  [
    0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
    0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ].map((code) => String.fromCharCode(code)),
);

/** `string.Trim()` with .NET's whitespace set rather than JavaScript's. */
function dotNetTrim(value: string): string {
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
