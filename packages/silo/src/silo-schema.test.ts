import { compileSchema } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { SILO_SCHEMA_TEXT } from "./silo-schema";

/**
 * Characterization test for `src/Spiceport.Silo/SiloSchema.cs`.
 *
 * The C# has NO covering suite: it is an 18-line static class holding one `const string`, compiled
 * by the silo host at startup. What makes it worth pinning at all is that the constant is not just
 * a fixture - `AddSpiceportGrainServices(SiloSchema.SchemaText)` compiles it into the live
 * `MutableSchemaProvider`, whose `SchemaHash` is folded into every ZedToken the host mints. A byte
 * that differs from Spiceport's is a token that differs from Spiceport's.
 *
 * THE TRAP THIS TEST EXISTS FOR. The C# literal is a raw string literal (`"""..."""`), which
 * (a) STRIPS the indentation common to the closing delimiter's line and (b) emits NO trailing
 * newline. A TypeScript template literal does NEITHER: written naively, the ported constant would
 * carry a leading newline, eight leading spaces on every line, and a trailing newline - three
 * differences in the hashed input. So the assertions below are deliberately about WHITESPACE and
 * exact bytes, not about "does it parse".
 *
 * `SeedData.SchemaText` (`packages/api/src/seed-data.ts`) is byte-identical to this constant, but
 * the two are SEPARATE constants in separate C# files and drift independently by design; neither
 * may be expressed in terms of the other, and this test does not reference the API one.
 */
describe("SILO_SCHEMA_TEXT", () => {
  it("is the raw-string-literal expansion, byte for byte", () => {
    expect(SILO_SCHEMA_TEXT).toBe(
      [
        "definition user {}",
        "",
        "definition document {",
        "    relation viewer: user",
        "    relation editor: user",
        "    permission view = viewer + editor",
        "}",
      ].join("\n"),
    );
  });

  it("carries no leading newline and no leading indentation (the raw literal dedents)", () => {
    expect(SILO_SCHEMA_TEXT.startsWith("definition user {}")).toBe(true);
    expect(SILO_SCHEMA_TEXT).not.toMatch(/^\s/);
  });

  it("carries no trailing newline (the raw literal does not emit one)", () => {
    expect(SILO_SCHEMA_TEXT.endsWith("}")).toBe(true);
    expect(SILO_SCHEMA_TEXT).not.toMatch(/\s$/);
  });

  it("uses LF line endings only, and indents the body with exactly four spaces", () => {
    expect(SILO_SCHEMA_TEXT).not.toContain("\r");
    expect(SILO_SCHEMA_TEXT).not.toContain("\t");
    const bodyLines = SILO_SCHEMA_TEXT.split("\n").filter((line) => line.startsWith(" "));
    expect(bodyLines).toHaveLength(3);
    for (const line of bodyLines) expect(line).toMatch(/^ {4}\S/);
  });

  it("compiles to the two-definition fixture the silo host serves", () => {
    const compiled = compileSchema(SILO_SCHEMA_TEXT);

    expect(compiled.namespaces.map((ns) => ns.name)).toEqual(["user", "document"]);
    expect(compiled.caveats).toHaveLength(0);

    const document = compiled.namespaces[1];
    expect(document?.relations.map((r) => r.name)).toEqual(["viewer", "editor", "view"]);
  });
});
