import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FormatError } from "@spacedb/core/format-error";
import type { IRevision } from "@spacedb/core/i-revision";
import type { Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { formatRelationship } from "@spacedb/core/tuple-strings";
import { CreateRelationshipExistsException } from "@spacedb/datastore/datastore-exceptions";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import { SchemaTypeException } from "@spacedb/engine/schema-type-exception";
import { validateSchemaTypes } from "@spacedb/engine/schema-type-validator";
import { SchemaCompileException } from "@spacedb/schema/schema-compile-exception";
import { compileSchema } from "@spacedb/schema/schema-compiler";

import {
  RelationshipTypeException,
  validateAllRelationships,
} from "./relationship-schema-validator";
import { loadResolvedValidationFile, ValidationFileLoadException } from "./validation-file-loader";

/**
 * SpiceDB validationfile loader/server-validation robustness suite, ported from
 * pkg/validationfile/{loader_test.go,fileformat_test.go} via Spiceport
 * `tests/Spiceport.Conformance.Tests/Loading/ValidationLoaderSuiteTests.cs`. These files carry
 * null validation blocks and empty assertions - they exercise the LOADER and write-time SCHEMA
 * VALIDATION, not Check semantics. Each positive case asserts the loaded, sorted relationship
 * strings; each negative case asserts that load/compile/validate/write fails in the expected
 * category.
 *
 * Port notes:
 *   * The C# reads `TestData/LoaderSuite`; here the same tree is vendored at
 *     `corpus/LoaderSuite`.
 *   * `StringComparer.Ordinal` ordering is JavaScript's default `Array.prototype.sort`, which
 *     compares UTF-16 code units - the same order for this ASCII corpus.
 *   * `Assert.Throws<FileNotFoundException>` becomes an assertion on Node's `ENOENT` error code:
 *     `readFileSync` has no distinct not-found exception type to catch.
 *   * `Assert.Throws<FormatException>` becomes `FormatError`, the port's rename of it.
 */

const dir = fileURLToPath(new URL("../corpus/LoaderSuite", import.meta.url));

const path_ = (name: string): string => join(dir, name);

describe("ValidationLoaderSuite", () => {
  // ---------- POSITIVE ----------

  const positiveSingleFile: readonly (readonly [string, readonly string[]])[] = [
    [
      "loader_no_comment.yaml",
      [
        "example/project:pied_piper#owner@example/user:milburga",
        "example/project:pied_piper#reader@example/user:tarben",
        "example/project:pied_piper#writer@example/user:freyja",
      ],
    ],
    [
      "loader_with_comment.yaml",
      [
        "example/project:pied_piper#owner@example/user:milburga",
        "example/project:pied_piper#reader@example/user:tarben",
        "example/project:pied_piper#writer@example/user:freyja",
      ],
    ],
    [
      "loader_using_schemafile.yaml",
      [
        "example/project:pied_piper#owner@example/user:milburga",
        "example/project:pied_piper#reader@example/user:tarben",
        "example/project:pied_piper#writer@example/user:freyja",
      ],
    ],
    [
      "basic_caveats.yaml",
      [
        'resource:first#reader@user:sarah[some_caveat:{"somecondition":42}]',
        "resource:first#reader@user:tom[some_caveat]",
      ],
    ],
    [
      "caveat_order.yaml",
      [
        'resource:first#reader@user:sarah[some_caveat:{"somecondition":42}]',
        "resource:first#reader@user:tom[some_caveat]",
      ],
    ],
  ];

  it.each(positiveSingleFile)(
    "loads %s with the expected relationships",
    async (fileName, expected) => {
      const file = loadResolvedValidationFile(path_(fileName));
      const compiled = compileSchema(file.schemaText);
      validateSchemaTypes(compiled);
      validateAllRelationships(compiled, file.relationships);

      await writeAll(file.relationships);

      const got = file.relationships.map(formatRelationship).sort();
      expect(got).toEqual([...expected].sort());
    },
  );

  it("loads multiple files, merging relationships", async () => {
    const schemaFile = loadResolvedValidationFile(path_("initial_schema_and_rels.yaml"));
    const relsOnly = loadResolvedValidationFile(path_("just_rels.yaml"));

    const merged = [...schemaFile.relationships, ...relsOnly.relationships];
    const compiled = compileSchema(schemaFile.schemaText);
    validateSchemaTypes(compiled);
    validateAllRelationships(compiled, merged);
    await writeAll(merged);

    const expected = [
      "example/project:pied_piper#owner@example/user:milburga",
      "example/project:pied_piper#reader@example/user:tarben",
      "example/project:pied_piper#writer@example/user:freyja",
      "example/project:pied_piper#owner@example/user:fred",
      "example/project:pied_piper#reader@example/user:tom",
      "example/project:pied_piper#writer@example/user:sarah",
    ];
    const got = merged.map(formatRelationship).sort();
    expect(got).toEqual([...expected].sort());
  });

  it("loads every relationship of a file that requires chunking", async () => {
    const file = loadResolvedValidationFile(path_("requires_chunking.yaml"));
    expect(file.relationships.length).toBe(501); // user:0 .. user:500 inclusive
    const compiled = compileSchema(file.schemaText);
    validateSchemaTypes(compiled);
    validateAllRelationships(compiled, file.relationships);
    const rev = await writeAll(file.relationships);
    expect(rev).toBeDefined();
  });

  // ---------- NEGATIVE ----------

  it("rejects just_rels alone with a missing definition", () => {
    const file = loadResolvedValidationFile(path_("just_rels.yaml"));
    const compiled = compileSchema(file.schemaText); // empty schema compiles
    let caught: unknown;
    try {
      validateAllRelationships(compiled, file.relationships);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RelationshipTypeException);
    expect((caught as Error).message).toContain("object definition `example/project` not found");
  });

  it("rejects schema and schemaFile as mutually exclusive", () => {
    let caught: unknown;
    try {
      loadResolvedValidationFile(path_("schema_and_schemafile.yaml"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationFileLoadException);
    expect((caught as Error).message).toContain(
      "only one of schema or schemaFile can be specified",
    );
  });

  it("rejects an invalid schemaFile with a schema parse error", () => {
    const file = loadResolvedValidationFile(path_("loader_using_invalid_schemafile.yaml"));
    expect(() => compileSchema(file.schemaText)).toThrow(SchemaCompileException);
  });

  it("rejects a non-local schemaFile", () => {
    let caught: unknown;
    try {
      loadResolvedValidationFile(path_("loader_using_non-local_schemafile.yaml"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationFileLoadException);
    expect((caught as Error).message).toContain("is not local");
  });

  it("rejects a missing schemaFile as file not found", () => {
    let caught: unknown;
    try {
      loadResolvedValidationFile(path_("loader_using_missing_schemafile.yaml"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("ENOENT");
  });

  it("rejects the legacy validation_tuples key", () => {
    let caught: unknown;
    try {
      loadResolvedValidationFile(path_("legacy.yaml"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationFileLoadException);
    expect((caught as Error).message).toContain(
      "relationships must be specified in `relationships`",
    );
  });

  it("rejects an invalid caveat as caveat not found", () => {
    const file = loadResolvedValidationFile(path_("invalid_caveat.yaml"));
    const compiled = compileSchema(file.schemaText);
    let caught: unknown;
    try {
      validateSchemaTypes(compiled);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SchemaTypeException);
    expect((caught as Error).message).toContain("caveat with name `some_caveat` not found");
  });

  it("rejects an invalid caveated relationship as a subject type not allowed", () => {
    const file = loadResolvedValidationFile(path_("invalid_caveated_rel.yaml"));
    const compiled = compileSchema(file.schemaText);
    validateSchemaTypes(compiled);
    let caught: unknown;
    try {
      validateAllRelationships(compiled, file.relationships);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RelationshipTypeException);
    expect((caught as Error).message).toContain("are not allowed on relation `resource#reader`");
  });

  it("rejects invalid caveated relationship syntax as a parse error", () => {
    expect(() => loadResolvedValidationFile(path_("invalid_caveated_rel_syntax.yaml"))).toThrow(
      FormatError,
    );
  });

  it("rejects a repeated relationship on create", async () => {
    const file = loadResolvedValidationFile(path_("repeated_relationship.yaml"));
    const compiled = compileSchema(file.schemaText);
    validateSchemaTypes(compiled);
    await expect(writeAll(file.relationships)).rejects.toBeInstanceOf(
      CreateRelationshipExistsException,
    );
  });
});

// ---------- shared write helper ----------

async function writeAll(relationships: readonly Relationship[]): Promise<IRevision> {
  const datastore = new ReferenceDatastore();
  if (relationships.length === 0) {
    return (await datastore.headRevision()).revision;
  }

  const updates: readonly RelationshipUpdate[] = relationships.map((r) => ({
    relationship: r,
    operation: "create",
  }));
  return await datastore.readWriteTx(async (tx) => {
    await tx.writeRelationships(updates);
  });
}
