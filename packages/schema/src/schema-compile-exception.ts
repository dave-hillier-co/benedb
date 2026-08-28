/**
 * Thrown when the schema DSL cannot be lexed, parsed, or compiled.
 *
 * Ported from Spiceport `SchemaCompileException.cs`.
 *
 * Port decisions:
 *   * The message is FORMATTED IN THE CONSTRUCTOR, exactly as the C# does by passing
 *     `Format(...)` to `base(...)`. Call sites pass the bare reason.
 *   * `Object.setPrototypeOf` re-pins the prototype so `instanceof` survives downlevelling,
 *     which C# needs no equivalent of.
 */
export class SchemaCompileException extends Error {
  /** The 1-based line where the error occurred (0 if unknown). */
  readonly line: number;

  /** The 1-based column where the error occurred (0 if unknown). */
  readonly column: number;

  constructor(message: string, line = 0, column = 0) {
    super(format(message, line, column));
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "SchemaCompileException";
    this.line = line;
    this.column = column;
  }
}

function format(message: string, line: number, column: number): string {
  return line > 0
    ? `schema error at line ${line}, column ${column}: ${message}`
    : `schema error: ${message}`;
}
