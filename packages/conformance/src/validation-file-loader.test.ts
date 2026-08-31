import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import { isPublicWildcard } from "@benedb/core/object-and-relation";

import { loadValidationFile, parseValidationFile } from "./validation-file-loader";
import {
  assertionExpectedMembership,
  expectedSubjectSubject,
  isAssertionExpected,
  isExpectedSubjectCaveated,
  type ValidationFile,
} from "./validation-model";

// Port of Spiceport `tests/Spiceport.Conformance.Tests/Loading/ValidationFileLoaderTests.cs`,
// the covering gate for `validation-file-loader.ts` and `validation-model.ts`.
//
// The C# reads its samples from `TestData/`, a build-time copy of the conformance corpus; here
// they are read from `corpus/` directly, which is the same three files byte-for-byte.
//
// Mechanical substitutions, applied uniformly:
//   * `[Theory]` + `[InlineData]` becomes `it.each`.
//   * `Assert.Single(xs)` becomes an explicit length assertion followed by the element, because
//     an out-of-range index in TypeScript yields `undefined` rather than throwing, so the count
//     has to be asserted separately for the failure to name the right thing.
//   * The C# computed properties `Expected`, `ExpectedMembership`, `Subject` and `IsCaveated`
//     are free functions in the port, so every read of them goes through those.
//   * `DateTimeOffset.Year` becomes a UTC year read off the `bigint` epoch-nanosecond
//     expiration this port stores instead.

const dataPath = (fileName: string): string =>
  fileURLToPath(new URL(`../corpus/${fileName}`, import.meta.url));

describe("ValidationFileLoader", () => {
  it.each(["basicrbac.yaml", "indirectgroups.yaml", "simplewildcard.yaml"])(
    "parses sample file %s without error",
    (fileName) => {
      const file = loadValidationFile(dataPath(fileName));

      expect(file.schemaText.length).toBeGreaterThan(0);
      expect(file.relationships.length).toBeGreaterThan(0);
      expect(file.assertions.length).toBeGreaterThan(0);
    },
  );

  it("parses basicrbac relationships and assertions", () => {
    const file = loadValidationFile(dataPath("basicrbac.yaml"));

    expect(file.schemaText).toContain("definition example/document");
    expect(file.relationships.length).toBe(3);

    const rel = file.relationships[0];
    expect(rel).toBeDefined();
    expect(rel?.reference.resource.objectType).toBe("example/document");
    expect(rel?.reference.resource.objectId).toBe("firstdoc");
    expect(rel?.reference.resource.relation).toBe("writer");
    expect(rel?.reference.subject.objectType).toBe("example/user");
    expect(rel?.reference.subject.objectId).toBe("tom");

    expect(file.assertions.length).toBe(6);
    expect(file.assertions.filter((a) => isAssertionExpected(a)).length).toBe(4);
    expect(file.assertions.filter((a) => !isAssertionExpected(a)).length).toBe(2);
  });

  it("parses typed assertion resource, relation and subject", () => {
    const file = loadValidationFile(dataPath("basicrbac.yaml"));

    const trueAssertion = file.assertions.find((a) => isAssertionExpected(a));
    expect(trueAssertion).toBeDefined();
    expect(trueAssertion?.resource.objectType).toBe("example/document");
    expect(trueAssertion?.resource.relation).toBe("write");
    expect(trueAssertion?.subject.objectType).toBe("example/user");
    expect(trueAssertion?.subject.objectId).toBe("tom");
    expect(trueAssertion?.expectation).toBe("true");
  });

  it("normalises an ellipsis subject relation", () => {
    const file = loadValidationFile(dataPath("indirectgroups.yaml"));

    const assertion = file.assertions[0];
    expect(assertion).toBeDefined();
    expect(assertion?.subject.relation).toBe(ELLIPSIS);
  });

  it("parses a wildcard subject", () => {
    const file = loadValidationFile(dataPath("simplewildcard.yaml"));

    const wildcard = file.relationships.find((r) => isPublicWildcard(r.reference.subject));
    expect(wildcard).toBeDefined();
    expect(wildcard?.reference.subject.objectId).toBe(PUBLIC_WILDCARD);
    expect(wildcard?.reference.subject.objectType).toBe("test/user");
  });

  it("parses an assertion with caveat context", () => {
    const yaml = [
      "schema: |",
      "  definition user {}",
      "relationships: |",
      "  doc:d#viewer@user:tom",
      "assertions:",
      "  assertTrue:",
      `    - 'doc:d#view@user:tom with {"now": "2023-01-01T00:00:00Z", "count": 42}'`,
    ].join("\n");

    const file = parseValidationFile(yaml);

    expect(file.assertions.length).toBe(1);
    const assertion = file.assertions[0];
    expect(assertion).toBeDefined();
    expect(assertion?.caveatContext).toBeDefined();
    expect(assertion?.caveatContext?.get("now")).toBe("2023-01-01T00:00:00Z");
    expect(assertion?.caveatContext?.get("count")).toBe(42);
    expect(assertion?.resource.objectType).toBe("doc");
    expect(assertion?.resource.relation).toBe("view");
  });

  it("parses a caveated relationship and a caveated assertion", () => {
    const yaml = [
      "schema: |+",
      "  use expiration",
      "  caveat somecaveat(somecondition int) {",
      "    somecondition == 42",
      "  }",
      "  definition user {}",
      "  definition document {",
      "    relation viewer: user with somecaveat and expiration",
      "    permission view = viewer",
      "  }",
      "relationships: |",
      `  document:firstdoc#viewer@user:sarah[somecaveat:{"somecondition":42}][expiration:2300-12-01T00:00:00Z]`,
      "  document:firstdoc#viewer@user:fred[somecaveat][expiration:2300-12-01T00:00:00Z]",
      "assertions:",
      "  assertTrue:",
      `    - 'document:firstdoc#view@user:fred with {"somecondition": 42}'`,
      "  assertCaveated:",
      `    - "document:firstdoc#view@user:fred"`,
      "  assertFalse:",
      `    - "document:firstdoc#view@user:tom"`,
    ].join("\n");

    const file = parseValidationFile(yaml);

    // Relationship: caveat name + JSON context + expiration all populated.
    const sarah = file.relationships.find((r) => r.reference.subject.objectId === "sarah");
    expect(sarah).toBeDefined();
    expect(sarah?.optionalCaveat).toBeDefined();
    expect(sarah?.optionalCaveat?.caveatName).toBe("somecaveat");
    expect(sarah?.optionalCaveat?.context).toBeDefined();
    // Relationship caveat context is deserialised lazily as JsonElement by the core parser;
    // the port hands back the parsed JSON value, so the C#'s `.ToString()` becomes `String(...)`.
    expect(String(sarah?.optionalCaveat?.context?.get("somecondition"))).toBe("42");
    expect(sarah?.optionalExpiration).toBeDefined();
    expect(expirationYear(sarah?.optionalExpiration)).toBe(2300);

    // Relationship: caveat name, no context (context provided at check time).
    const fred = file.relationships.find((r) => r.reference.subject.objectId === "fred");
    expect(fred).toBeDefined();
    expect(fred?.optionalCaveat).toBeDefined();
    expect(fred?.optionalCaveat?.caveatName).toBe("somecaveat");
    expect(fred?.optionalCaveat?.context).toBeUndefined();

    // assertTrue with " with {json}" context.
    const trueAssertion = file.assertions.find((a) => a.expectation === "true");
    expect(trueAssertion).toBeDefined();
    expect(trueAssertion?.caveatContext).toBeDefined();
    expect(trueAssertion?.caveatContext?.get("somecondition")).toBe(42);

    // assertCaveated maps to the caveated outcome / Membership "caveated".
    const caveated = file.assertions.find((a) => a.expectation === "caveated");
    expect(caveated).toBeDefined();
    expect(caveated !== undefined && assertionExpectedMembership(caveated)).toBe("caveated");
    expect(caveated?.subject.objectId).toBe("fred");

    // assertFalse maps to notMember.
    const falseAssertion = file.assertions.find((a) => a.expectation === "false");
    expect(falseAssertion).toBeDefined();
    expect(falseAssertion !== undefined && assertionExpectedMembership(falseAssertion)).toBe(
      "notMember",
    );
  });

  // ---- validation: block parsing (mirrors SpiceDB's pkg/validationfile/blocks grammar) ----

  it("yields no entries when the validation block is absent", () => {
    const file = parseValidationFile(
      ["schema: |", "  definition user {}", 'relationships: ""'].join("\n"),
    );

    expect(file.validations.length).toBe(0);
  });

  it("parses a validation entry key as object and relation", () => {
    const file = parseWithValidation([
      "  document:firstdoc#view:",
      '  - "[user:tom] is <document:firstdoc#viewer>"',
    ]);

    expect(file.validations.length).toBe(1);
    const entry = file.validations[0];
    expect(entry?.objectAndRelation.objectType).toBe("document");
    expect(entry?.objectAndRelation.objectId).toBe("firstdoc");
    expect(entry?.objectAndRelation.relation).toBe("view");
  });

  it("normalises a terminal subject without ellipsis to the ellipsis", () => {
    const file = parseWithValidation([
      "  document:firstdoc#view:",
      '  - "[user:tom] is <document:firstdoc#viewer>"',
    ]);

    const subject = singleExpectedSubject(file);
    expect(expectedSubjectSubject(subject).objectType).toBe("user");
    expect(expectedSubjectSubject(subject).objectId).toBe("tom");
    expect(expectedSubjectSubject(subject).relation).toBe(ELLIPSIS);
    expect(isExpectedSubjectCaveated(subject)).toBe(false);
    expect(subject.exceptions.length).toBe(0);
  });

  it("parses a subject with an explicit ellipsis the same as a bare id", () => {
    const file = parseWithValidation([
      "  document:firstdoc#view:",
      '  - "[user:tom#...] is <document:firstdoc#viewer>"',
    ]);

    const subject = singleExpectedSubject(file);
    expect(expectedSubjectSubject(subject).objectId).toBe("tom");
    expect(expectedSubjectSubject(subject).relation).toBe(ELLIPSIS);
  });

  it("parses a subject with a relation as a subject relation, not the ellipsis", () => {
    const file = parseWithValidation([
      "  document:firstdoc#view:",
      '  - "[group:eng#member] is <document:firstdoc#viewer>"',
    ]);

    const subject = singleExpectedSubject(file);
    expect(expectedSubjectSubject(subject).objectType).toBe("group");
    expect(expectedSubjectSubject(subject).objectId).toBe("eng");
    expect(expectedSubjectSubject(subject).relation).toBe("member");
  });

  it("parses a wildcard subject with the public wildcard id", () => {
    const file = parseWithValidation([
      "  document:firstdoc#view:",
      '  - "[user:*] is <document:firstdoc#viewer>"',
    ]);

    const subject = singleExpectedSubject(file);
    expect(isPublicWildcard(expectedSubjectSubject(subject))).toBe(true);
    expect(isExpectedSubjectCaveated(subject)).toBe(false);
  });

  it("marks a caveated subject via the bracket-ellipsis suffix", () => {
    const file = parseWithValidation([
      "  document:firstdoc#view:",
      '  - "[user:tom[...]] is <document:firstdoc#viewer>"',
    ]);

    const subject = singleExpectedSubject(file);
    expect(expectedSubjectSubject(subject).objectId).toBe("tom");
    expect(isExpectedSubjectCaveated(subject)).toBe(true);
  });

  it("parses wildcard exceptions as excluded subjects with their own caveat flags", () => {
    const file = parseWithValidation([
      "  document:firstdoc#view:",
      '  - "[user:*[...] - {user:a, user:b[...]}] is <document:firstdoc#viewer>"',
    ]);

    const subject = singleExpectedSubject(file);
    expect(isPublicWildcard(expectedSubjectSubject(subject))).toBe(true);
    expect(isExpectedSubjectCaveated(subject)).toBe(true);
    expect(subject.exceptions.length).toBe(2);

    const a = subject.exceptions.filter((e) => e.subject.objectId === "a");
    expect(a.length).toBe(1);
    expect(a[0]?.isCaveated).toBe(false);
    const b = subject.exceptions.filter((e) => e.subject.objectId === "b");
    expect(b.length).toBe(1);
    expect(b[0]?.isCaveated).toBe(true);
  });

  it("ignores a multiple-resource path suffix and asserts only the subject", () => {
    const file = parseWithValidation([
      "  document:firstdoc#view:",
      '  - "[user:tom] is <document:firstdoc#viewer>/<document:firstdoc#builder>"',
    ]);

    const subject = singleExpectedSubject(file);
    expect(expectedSubjectSubject(subject).objectId).toBe("tom");
  });

  it("parses every expected subject for the same entry", () => {
    const file = parseWithValidation([
      "  document:firstdoc#view:",
      '  - "[user:tom] is <document:firstdoc#viewer>"',
      '  - "[user:fred] is <document:firstdoc#viewer>"',
    ]);

    expect(file.validations.length).toBe(1);
    const entry = file.validations[0];
    expect(entry?.expectedSubjects.length).toBe(2);
    const ids = (entry?.expectedSubjects ?? []).map((s) => expectedSubjectSubject(s).objectId);
    expect(ids).toContain("tom");
    expect(ids).toContain("fred");
  });
});

/** The C# `ParseWithValidation` helper: one fixed schema and relationship, a varying block. */
function parseWithValidation(validationYaml: readonly string[]): ValidationFile {
  const yaml = [
    "schema: |",
    "  definition user {}",
    "  definition document {",
    "    relation viewer: user",
    "    permission view = viewer",
    "  }",
    "relationships: |",
    "  document:firstdoc#viewer@user:tom",
    "validation:",
    ...validationYaml,
  ].join("\n");
  return parseValidationFile(yaml);
}

/** The C# `Assert.Single(Assert.Single(file.Validations).ExpectedSubjects)`. */
function singleExpectedSubject(file: ValidationFile) {
  expect(file.validations.length).toBe(1);
  const entry = file.validations[0];
  expect(entry).toBeDefined();
  expect(entry?.expectedSubjects.length).toBe(1);
  const subject = entry?.expectedSubjects[0];
  if (subject === undefined) throw new Error("expected a single expected subject");
  return subject;
}

/** The C# `DateTimeOffset.Year`, over this port's epoch-nanosecond expiration. */
function expirationYear(nanos: bigint | undefined): number | undefined {
  if (nanos === undefined) return undefined;
  return new Date(Number(nanos / 1_000_000n)).getUTCFullYear();
}
