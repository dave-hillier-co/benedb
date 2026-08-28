import { describe, expect, it } from "vitest";

import { SchemaCompileException } from "./schema-compile-exception";

// Ported from the assertions that `SchemaCompilerTests` makes about the exception itself
// (`ThrowsOnMalformedSchema` asserts `ex.Line > 0`; `RejectsNestedArrows` asserts a substring of
// `ex.Message`), plus characterization of the format the C# constructor pins.
//
// Port decisions pinned here:
//
// 1. The message is FORMATTED IN THE CONSTRUCTOR, not by the thrower. Every call site passes the
//    bare reason and gets `schema error at line {line}, column {column}: {reason}` back. Throwers
//    that pre-format would double the prefix.
// 2. `Line`/`Column` are 1-based, with 0 meaning "unknown"; only `line > 0` selects the located
//    form, so a located error with column 0 still renders `column 0`.
// 3. In TypeScript the prototype has to be re-pinned (`Object.setPrototypeOf(this, ...)`) or
//    `instanceof` fails once the class is downlevelled; the `instanceof` assertions below are
//    that requirement's gate.
describe("schema compile exception", () => {
  it("formats a located error with line and column in the constructor", () => {
    const error = new SchemaCompileException("expected ':', found '}'", 3, 12);

    expect(error.message).toBe("schema error at line 3, column 12: expected ':', found '}'");
    expect(error.line).toBe(3);
    expect(error.column).toBe(12);
  });

  it("formats an unlocated error without a position when line is unknown", () => {
    const error = new SchemaCompileException("unterminated caveat body");

    expect(error.message).toBe("schema error: unterminated caveat body");
    expect(error.line).toBe(0);
    expect(error.column).toBe(0);
  });

  it("treats line 0 as unknown even when a column is supplied", () => {
    const error = new SchemaCompileException("boom", 0, 7);

    expect(error.message).toBe("schema error: boom");
    expect(error.line).toBe(0);
    expect(error.column).toBe(7);
  });

  it("keeps the located form when the column is unknown but the line is not", () => {
    const error = new SchemaCompileException("boom", 4);

    expect(error.message).toBe("schema error at line 4, column 0: boom");
  });

  it("is an Error and an instance of its own class", () => {
    const error = new SchemaCompileException("boom", 1, 1);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SchemaCompileException);
    expect(error.name).toBe("SchemaCompileException");
  });

  it("is catchable by class from a throw site", () => {
    const throwing = (): never => {
      throw new SchemaCompileException("Nested arrows not yet supported", 2, 21);
    };

    expect(throwing).toThrow(SchemaCompileException);
    expect(throwing).toThrow("Nested arrows not yet supported");
  });
});
