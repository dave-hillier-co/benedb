import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath, sep } from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { ELLIPSIS } from "@benedb/core/core-constants";
import { FormatError } from "@benedb/core/format-error";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { Relationship } from "@benedb/core/relationship";
import { parseObjectAndRelation, parseRelationship } from "@benedb/core/tuple-strings";
import type {
  AssertionExpectation,
  ExpectedSubject,
  ExpectedSubjectTerm,
  ParsedAssertion,
  ValidationEntry,
  ValidationFile,
} from "./validation-model";

/**
 * Loads and parses SpiceDB validation/consistency YAML files into a typed {@link ValidationFile}.
 * Handles the schema block, the newline-separated relationships block, and the
 * assertTrue/assertFalse assertion blocks.
 *
 * Ported from Spiceport `Loading/ValidationFileLoader.cs`. The C# static class becomes module
 * functions; its sibling `ValidationFileLoadException` is exported from here as it is there.
 *
 * YamlDotNet vs the `yaml` package - the substantive part of this port:
 *
 *  - YamlDotNet deserializes into typed properties, so a scalar bound to a `string` is ALWAYS a
 *    string: `relationships: 42` yields "42", and `1.50` yields "1.50", not 1.5. `yaml` resolves
 *    plain scalars against the YAML 1.2 core schema first, so an unquoted relationship line that
 *    looks numeric or boolean would arrive as a `number` or a `boolean` and `String(...)` would
 *    silently reshape it (1.50 -> "1.5", 0x2a -> "42", 007 -> "7"). {@link scalarText} therefore
 *    recovers the ORIGINAL source text for any non-string scalar, which is exactly what
 *    YamlDotNet's string binding produces. Block scalars (the schema field, the relationships
 *    field) already resolve to strings and keep their folded/literal value.
 *  - A YAML null (`null`, `~`, or an empty value) binds to a C# `null` property. Here it maps to
 *    `undefined`, which is why the failsafe schema - where every scalar is a string and `null`
 *    would become the four-character string "null" - is deliberately not used.
 *  - YamlDotNet THROWS when a node's shape does not match the target type (a sequence where a
 *    string is expected, say). `yaml` would hand back whatever it parsed, so every accessor here
 *    throws {@link FormatError} instead of coercing.
 *  - `IgnoreUnmatchedProperties` is reproduced by only ever looking up the known keys.
 *  - `CamelCaseNamingConvention` is reproduced by those keys being the camelCase spellings, and
 *    YamlDotNet matches them case-sensitively, as `===` does.
 */

/**
 * Raised for loader-level (not schema-compile) validation failures: mutually-exclusive
 * schema/schemaFile, a non-local schemaFile, or the legacy `validation_tuples` key.
 */
export class ValidationFileLoadException extends Error {
  constructor(message: string) {
    super(message);
    // Re-pins the prototype so `instanceof` survives downlevelling; C# needs no equivalent.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "ValidationFileLoadException";
  }
}

/** Loads and parses a validation file from disk. The C# `ValidationFileLoader.LoadFromFile`. */
export function loadValidationFile(path: string): ValidationFile {
  const yaml = readAllText(path);
  return parseValidationFile(yaml);
}

/** Parses validation file YAML content. The C# `ValidationFileLoader.Parse`. */
export function parseValidationFile(yaml: string): ValidationFile {
  const raw = deserialize(yaml);
  if (raw === undefined) throw new FormatError("Validation file is empty.");

  const schemaText = (raw.schema ?? "").trimEnd();

  const relationships = parseRelationships(raw.relationships ?? "");
  const assertions = parseAssertions(raw.assertions);
  const validations = parseValidations(raw.validation);

  return { schemaText, relationships, assertions, validations };
}

/**
 * Loads a validation file, resolving a `schemaFile` reference relative to the file's own
 * directory. Mirrors SpiceDB's validationfile loader: schema/schemaFile are mutually exclusive,
 * a schemaFile must be local (no "../" escape), and the legacy `validation_tuples` key is
 * rejected.
 *
 * The C# `ValidationFileLoader.LoadResolved`.
 */
export function loadResolvedValidationFile(path: string): ValidationFile {
  const yaml = readAllText(path);

  // Legacy key: SpiceDB rejects files declaring relationships via `validation_tuples`.
  if (yaml.includes("validation_tuples")) {
    throw new ValidationFileLoadException("relationships must be specified in `relationships`");
  }

  const raw = deserialize(yaml);
  if (raw === undefined) throw new FormatError("Validation file is empty.");

  const hasSchema = !isNullOrWhiteSpace(raw.schema);
  const hasSchemaFile = !isNullOrWhiteSpace(raw.schemaFile);
  if (hasSchema && hasSchemaFile) {
    throw new ValidationFileLoadException("only one of schema or schemaFile can be specified");
  }

  let schemaText: string;
  if (hasSchemaFile) {
    const baseDir = dirname(resolvePath(path));
    const relative = (raw.schemaFile ?? "").trim();
    const full = resolvePath(baseDir, relative);
    if (!full.startsWith(baseDir + sep)) {
      throw new ValidationFileLoadException(`schema file "${relative}" is not local`);
    }

    // A missing file throws here, as the C# `FileNotFoundException` does: Node reports it as an
    // `Error` carrying `code: "ENOENT"`, so the missing-schemafile case stays a throw.
    schemaText = readAllText(full).trimEnd();
  } else {
    schemaText = (raw.schema ?? "").trimEnd();
  }

  const relationships = parseRelationships(raw.relationships ?? "");
  const assertions = parseAssertions(raw.assertions);
  const validations = parseValidations(raw.validation);
  return { schemaText, relationships, assertions, validations };
}

/** `File.ReadAllText`: UTF-8, with a byte-order mark stripped as .NET's encoding detection does. */
function readAllText(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** `string.IsNullOrWhiteSpace`. */
function isNullOrWhiteSpace(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function parseRelationships(block: string): readonly Relationship[] {
  const builder: Relationship[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("//")) {
      continue;
    }

    builder.push(parseRelationship(line));
  }

  return builder;
}

function parseAssertions(raw: RawAssertions | undefined): readonly ParsedAssertion[] {
  const builder: ParsedAssertion[] = [];
  if (raw === undefined) {
    return builder;
  }

  for (const s of raw.assertTrue ?? []) {
    builder.push(parseAssertion(s, "true"));
  }

  for (const s of raw.assertCaveated ?? []) {
    builder.push(parseAssertion(s, "caveated"));
  }

  for (const s of raw.assertFalse ?? []) {
    builder.push(parseAssertion(s, "false"));
  }

  return builder;
}

function parseAssertion(source: string, expectation: AssertionExpectation): ParsedAssertion {
  const [tupleString, withContext] = splitWithContext(source);

  // An assertion's tuple part is a full relationship string (resource@subject),
  // so reuse the relationship parser: it handles #... ellipsis, wildcards and
  // ellipsis normalisation for the subject relation.
  const relationship = parseRelationship(tupleString);

  // If the assertion did not carry a `with {json}` context, fall back to any
  // caveat context embedded directly in the relationship tuple.
  const context = withContext ?? relationship.optionalCaveat?.context;

  return {
    resource: relationship.reference.resource,
    subject: relationship.reference.subject,
    expectation,
    caveatContext: context,
    sourceText: source,
  };
}

// ---- validation: block (SpiceDB's pkg/validationfile/blocks grammar) ----

// Extracts the bracketed subject term: everything between the first '[' and the LAST
// ']' in the entry (matching SpiceDB's `(.*?)\[(.*)](.*?)` - greedy inside the brackets),
// so a caveat marker `[...]` nested inside the outer brackets doesn't truncate the match.
// The `is <...>` resource-path suffix (if any) trails outside the brackets and is discarded.
// `RegexOptions.Singleline` is the `s` flag; with `.` matching newlines the trailing `.*$`
// already spans them, so no `\n?$` is needed to reproduce .NET's `$`.
const BRACKETED_SUBJECT_REGEX = /^.*?\[(.*)\].*$/s;

// Subject term grammar: `SUBJECT_ONR ['[...]'] [' - {' EXCEPTIONS '}']`, e.g.
// `user:tom`, `user:tom[...]`, `user:*[...] - {user:a, user:b[...]}`.
// The trailing `\n?$` reproduces .NET's non-multiline `$`, which also matches immediately
// before a single trailing newline.
const SUBJECT_WITH_EXCEPTIONS_REGEX =
  /^(?<subject>[^\]\s]+)(?<caveat>\[\.\.\.\])?(\s*-\s*\{(?<exceptions>[^}]*)\})?\n?$/;

const CAVEAT_MARKER = "[...]";

function parseValidations(
  raw: ReadonlyMap<string, readonly string[] | undefined> | undefined,
): readonly ValidationEntry[] {
  const builder: ValidationEntry[] = [];
  if (raw === undefined) {
    return builder;
  }

  for (const [key, values] of raw) {
    const onr = parseObjectAndRelation(key.trim());
    const subjects = (values ?? []).map(parseExpectedSubject);
    builder.push({ objectAndRelation: onr, expectedSubjects: subjects });
  }

  return builder;
}

function parseExpectedSubject(source: string): ExpectedSubject {
  const bracketMatch = BRACKETED_SUBJECT_REGEX.exec(source.trim());
  if (bracketMatch === null) {
    throw new FormatError(`invalid validation subject entry: '${source}'`);
  }

  const userStr = (bracketMatch[1] ?? "").trim();
  const subjectMatch = SUBJECT_WITH_EXCEPTIONS_REGEX.exec(userStr);
  if (subjectMatch === null) {
    throw new FormatError(`invalid validation subject: '${userStr}'`);
  }

  const groups = subjectMatch.groups as Record<string, string | undefined>;

  const term: ExpectedSubjectTerm = {
    subject: parseSubjectOnr(groups.subject ?? ""),
    isCaveated: groups.caveat !== undefined,
  };

  const exceptions: ExpectedSubjectTerm[] = [];
  const exceptionsGroup = groups.exceptions;
  if (exceptionsGroup !== undefined && exceptionsGroup.trim().length > 0) {
    for (const rawException of exceptionsGroup.split(",")) {
      let trimmed = rawException.trim();
      const isCaveated = trimmed.endsWith(CAVEAT_MARKER);
      if (isCaveated) {
        trimmed = trimmed.slice(0, trimmed.length - CAVEAT_MARKER.length);
      }

      exceptions.push({ subject: parseSubjectOnr(trimmed), isCaveated });
    }
  }

  return { term, exceptions };
}

/**
 * Parses a bare subject ONR (no resource part): `type:id`, `type:id#relation` or the wildcard
 * `type:*`. Absent relation normalises to the ellipsis, matching `tuple-strings`' convention for
 * a subject with no explicit sub-relation.
 */
function parseSubjectOnr(value: string): ObjectAndRelation {
  const hashIndex = value.indexOf("#");
  const typeAndId = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const relation = hashIndex >= 0 ? value.slice(hashIndex + 1) : ELLIPSIS;

  const colonIndex = typeAndId.indexOf(":");
  if (colonIndex < 0) {
    throw new FormatError(`invalid subject ONR: '${value}'`);
  }

  const type = typeAndId.slice(0, colonIndex);
  const id = typeAndId.slice(colonIndex + 1);
  return { objectType: type, objectId: id, relation };
}

function splitWithContext(source: string): [string, ReadonlyMap<string, unknown> | undefined] {
  const trimmed = source.trim();
  const withIndex = trimmed.indexOf(" with ");
  if (withIndex < 0) {
    return [trimmed, undefined];
  }

  const tuplePart = trimmed.slice(0, withIndex).trim();
  const jsonPart = trimmed.slice(withIndex + " with ".length).trim();
  const context = parseJsonContext(jsonPart);
  return [tuplePart, context];
}

function parseJsonContext(json: string): ReadonlyMap<string, unknown> {
  // `JsonDocument.Parse` and `JSON.parse` agree on the strict JSON grammar; both throw on
  // malformed input, and that throw propagates exactly as the C#'s `JsonException` does.
  const doc: unknown = JSON.parse(json);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new FormatError(`Assertion caveat context must be a JSON object, got: ${json}`);
  }

  const result = new Map<string, unknown>();
  for (const [name, value] of Object.entries(doc)) {
    result.set(name, convertJson(value));
  }

  return result;
}

/**
 * The C# `ConvertJson`, over `JSON.parse`'s output rather than a `JsonElement` tree.
 *
 * Nested objects become `Map`s, not plain objects, so that an assertion context is the same
 * shape as the context `tuple-strings` produces for a caveat embedded in a relationship - the
 * two are assigned to the SAME field, and the caveat evaluator walks both.
 */
function convertJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(convertJson);
  return new Map(Object.entries(value).map(([name, member]) => [name, convertJson(member)]));
}

// ---- YamlDotNet's typed deserialization, reproduced over the `yaml` document tree ----

interface RawValidationFile {
  readonly schema: string | undefined;
  readonly schemaFile: string | undefined;
  readonly relationships: string | undefined;
  readonly assertions: RawAssertions | undefined;
  readonly validation: ReadonlyMap<string, readonly string[] | undefined> | undefined;
}

interface RawAssertions {
  readonly assertTrue: readonly string[] | undefined;
  readonly assertFalse: readonly string[] | undefined;
  readonly assertCaveated: readonly string[] | undefined;
}

/** `Deserializer.Deserialize<RawValidationFile>`; an empty document yields `undefined`. */
function deserialize(yaml: string): RawValidationFile | undefined {
  const doc = parseDocument(yaml);
  const error = doc.errors[0];
  if (error !== undefined) {
    throw new FormatError(`invalid validation file YAML: ${error.message}`);
  }

  const contents: unknown = doc.contents;
  if (contents === null || contents === undefined) return undefined;
  if (isScalar(contents) && contents.value === null) return undefined;
  if (!isMap(contents)) {
    throw new FormatError("Validation file must be a YAML mapping.");
  }

  const assertionsNode = memberNode(contents, "assertions");
  const validationNode = memberNode(contents, "validation");

  return {
    schema: stringMember(contents, "schema"),
    schemaFile: stringMember(contents, "schemaFile"),
    relationships: stringMember(contents, "relationships"),
    assertions: assertionsNode === undefined ? undefined : rawAssertions(assertionsNode),
    validation: validationNode === undefined ? undefined : stringListMap(validationNode),
  };
}

function rawAssertions(node: unknown): RawAssertions | undefined {
  if (isNullScalar(node)) return undefined;
  if (!isMap(node)) throw new FormatError("`assertions` must be a YAML mapping.");

  return {
    assertTrue: stringListMember(node, "assertTrue"),
    assertFalse: stringListMember(node, "assertFalse"),
    assertCaveated: stringListMember(node, "assertCaveated"),
  };
}

/** The node bound to `key`, or `undefined` when the key is absent. Keys match ordinally. */
function memberNode(map: unknown, key: string): unknown {
  if (!isMap(map)) return undefined;
  for (const item of map.items) {
    const itemKey: unknown = item.key;
    if (isScalar(itemKey) && itemKey.value === key) return item.value;
  }
  return undefined;
}

function stringMember(map: unknown, key: string): string | undefined {
  const node = memberNode(map, key);
  return node === undefined ? undefined : scalarText(node, key);
}

function stringListMember(map: unknown, key: string): readonly string[] | undefined {
  const node = memberNode(map, key);
  return node === undefined ? undefined : stringList(node, key);
}

function stringList(node: unknown, key: string): readonly string[] | undefined {
  if (isNullScalar(node)) return undefined;
  if (!isSeq(node)) throw new FormatError(`\`${key}\` must be a YAML sequence.`);
  return node.items.map((item) => requiredScalarText(item, key));
}

function stringListMap(
  node: unknown,
): ReadonlyMap<string, readonly string[] | undefined> | undefined {
  if (isNullScalar(node)) return undefined;
  if (!isMap(node)) throw new FormatError("`validation` must be a YAML mapping.");

  const result = new Map<string, readonly string[] | undefined>();
  for (const item of node.items) {
    const key = requiredScalarText(item.key, "validation");
    if (result.has(key)) {
      throw new FormatError(`duplicate validation key: '${key}'`);
    }
    result.set(key, stringList(item.value, key));
  }
  return result;
}

function isNullScalar(node: unknown): boolean {
  return node === null || node === undefined || (isScalar(node) && node.value === null);
}

/**
 * A scalar bound to a `string`, as YamlDotNet binds one.
 *
 * A YAML null yields `undefined`. A string value (a quoted scalar, a block scalar, or a plain
 * scalar the core schema left as a string) is used as-is. ANY OTHER resolved value - a number, a
 * boolean - is replaced by the scalar's ORIGINAL SOURCE TEXT, because that is the text
 * YamlDotNet would have handed to the `string` property, and `String(value)` would not be: it
 * turns `1.50` into "1.5", `0x2a` into "42" and `007` into "7". A relationship line silently
 * reshaped that way is corpus corruption, not a crash.
 */
function scalarText(node: unknown, key: string): string | undefined {
  if (isNullScalar(node)) return undefined;
  if (!isScalar(node)) throw new FormatError(`\`${key}\` must be a YAML scalar.`);

  const value: unknown = node.value;
  if (typeof value === "string") return value;

  const source = node.source;
  if (source !== undefined) return source;
  return String(value);
}

function requiredScalarText(node: unknown, key: string): string {
  const text = scalarText(node, key);
  if (text === undefined) throw new FormatError(`\`${key}\` must not contain a null entry.`);
  return text;
}
