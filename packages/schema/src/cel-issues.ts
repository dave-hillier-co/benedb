import type { CelLocation } from "./cel-expr";

/** One parse or type-check error at a source location. */
export interface CelIssue {
  readonly location: CelLocation;
  readonly message: string;
}

const MAX_ERRORS_TO_REPORT = 100;
const MAX_SNIPPET_LENGTH = 16384;

/**
 * The errors collected while parsing and checking a CEL expression, rendered as cel-go renders an
 * `*cel.Issues` (`common.Errors.ToDisplayString`): sorted by location, one
 * `ERROR: <source>:<line>:<column>: <message>` per error, each followed by the offending source
 * line and a caret under the column.
 *
 * Ported from Spiceport `Engine/CelCheck/CelIssues.cs`.
 *
 * Port decisions:
 *   * Columns and snippets count code points (`Array.from` over the string), as the C# counts
 *     `Rune`s and cel-go counts runes; a wide (non-ASCII) character is marked with the full-width
 *     dot and caret, by UTF-8 length as cel-go decides it.
 */
export class CelIssues {
  readonly #errors: CelIssue[] = [];
  #count = 0;

  /** True when at least one error was reported. */
  get hasErrors(): boolean {
    return this.#count > 0;
  }

  /** The reported errors, in report order. */
  get errors(): readonly CelIssue[] {
    return this.#errors;
  }

  /** The total number of errors reported, including any beyond the hundred kept. */
  get count(): number {
    return this.#count;
  }

  /** Records an error (cel-go keeps the first hundred and counts the rest). */
  report(location: CelLocation, message: string): void {
    this.#count++;
    if (this.#count > MAX_ERRORS_TO_REPORT) return;
    this.#errors.push({ location, message });
  }

  /** Renders these issues against the given source. */
  toDisplayString(sourceText: string, description: string): string {
    return CelIssues.toDisplayString(this.#errors, this.#count, sourceText, description);
  }

  /**
   * Renders the errors against `sourceText`, the expression text cel-go compiled, described by
   * `description` (the caveat name). Locations are taken as given; a caller that relocated them
   * into an enclosing document keeps the snippet of the expression itself, exactly as SpiceDB does.
   */
  static toDisplayString(
    errors: readonly CelIssue[],
    totalCount: number,
    sourceText: string,
    description: string,
  ): string {
    const sorted = errors
      .map((e, i) => ({ e, i }))
      .sort(
        (a, b) =>
          a.e.location.line - b.e.location.line ||
          a.e.location.column - b.e.location.column ||
          a.i - b.i,
      )
      .map((p) => p.e);

    const source = new Source(sourceText);
    const lines = sorted.map((e) => display(e, source, description));
    if (totalCount > MAX_ERRORS_TO_REPORT) {
      lines.push(`${totalCount - MAX_ERRORS_TO_REPORT} more errors were truncated`);
    }
    return lines.join("\n");
  }
}

function display(error: CelIssue, source: Source, description: string): string {
  let result = `ERROR: ${description}:${error.location.line}:${error.location.column + 1}: ${error.message}`;
  const found = source.snippet(error.location.line);
  if (found !== undefined && utf8Length(found) <= MAX_SNIPPET_LENGTH) {
    const snippet = found.replaceAll("\t", " ");
    result += `\n | ${snippet}\n | `;
    const runes = Array.from(snippet);
    let index = 0;
    for (let i = 0; i < error.location.column && index < runes.length; i++, index++) {
      result += utf8Length(runes[index] as string) > 1 ? "．" : ".";
    }
    result += index < runes.length && utf8Length(runes[index] as string) > 1 ? "＾" : "^";
  }

  return result;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** cel-go's `common.Source` line bookkeeping, over code points. */
class Source {
  readonly #runes: readonly string[];
  readonly #lineOffsets: number[] = [];

  constructor(text: string) {
    this.#runes = Array.from(text);
    if (this.#runes.length === 0) {
      this.#lineOffsets.push(0);
      return;
    }

    this.#runes.forEach((rune, offset) => {
      if (rune === "\n") this.#lineOffsets.push(offset + 1);
    });
    this.#lineOffsets.push(this.#runes.length + 1);
  }

  snippet(line: number): string | undefined {
    const start = this.#findLineOffset(line);
    if (start === undefined || this.#runes.length === 0) return undefined;
    const next = this.#findLineOffset(line + 1);
    const end = next !== undefined ? next - 1 : this.#runes.length;
    return this.#runes.slice(start, end).join("");
  }

  #findLineOffset(line: number): number | undefined {
    if (line === 1) return 0;
    if (line > 1 && line <= this.#lineOffsets.length) return this.#lineOffsets[line - 2];
    return undefined;
  }
}
