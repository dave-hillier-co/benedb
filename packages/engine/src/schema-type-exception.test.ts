import { describe, expect, it } from "vitest";

import { SchemaTypeException } from "./schema-type-exception";

// Characterization of Spiceport `SchemaTypeException.cs` (no covering C# test of its own;
// SchemaTypeValidatorTests exercises it only as an `Assert.Throws` target).
//
// A one-member exception carrying only a message. The port guide's blanket rule applies:
// `Object.setPrototypeOf(this, new.target.prototype)` plus an explicit `this.name`, or
// `instanceof` fails after downlevelling and the validator suite cannot assert the type.
//
// Its messages are FailedPrecondition-mapped and are asserted VERBATIM by the ported
// SchemaTypeValidatorTests, so the message must be carried through byte-identically.
describe("schema type exception", () => {
  it("carries its message unchanged", () => {
    const error = new SchemaTypeException(
      "relation `viewer` not found under definition `document`",
    );

    expect(error.message).toBe("relation `viewer` not found under definition `document`");
  });

  it("does not rewrite, trim or decorate the message", () => {
    const error = new SchemaTypeException("  spaces and `backticks` kept  ");

    expect(error.message).toBe("  spaces and `backticks` kept  ");
  });

  it("accepts an empty message", () => {
    expect(new SchemaTypeException("").message).toBe("");
  });

  it("is an Error", () => {
    expect(new SchemaTypeException("x")).toBeInstanceOf(Error);
  });

  it("survives instanceof after downlevelling (setPrototypeOf in the constructor)", () => {
    const error = new SchemaTypeException("x");

    expect(error).toBeInstanceOf(SchemaTypeException);
    expect(Object.getPrototypeOf(error)).toBe(SchemaTypeException.prototype);
  });

  it("has an explicit name", () => {
    expect(new SchemaTypeException("x").name).toBe("SchemaTypeException");
  });

  it("is catchable and type-discriminable", () => {
    let caught: unknown;
    try {
      throw new SchemaTypeException("boom");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SchemaTypeException);
    expect((caught as SchemaTypeException).message).toBe("boom");
  });

  it("works as an expect(...).toThrow matcher target", () => {
    expect(() => {
      throw new SchemaTypeException("boom");
    }).toThrow(SchemaTypeException);
  });

  it("includes the name in its string form, as Error does", () => {
    expect(String(new SchemaTypeException("boom"))).toBe("SchemaTypeException: boom");
  });
});
