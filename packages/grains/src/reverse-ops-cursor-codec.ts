import { createHash } from "node:crypto";

import { FormatError } from "@benedb/core/format-error";
import type { RelationshipReference } from "@benedb/core/relationship-reference";
import type {
  LookupResourcesCursor,
  LookupResourcesCursorSection,
} from "@benedb/engine/lookup-resources-cursor";

import { fromBase64String, toBase64String } from "./convert-base64";
import { escapeDataString, unescapeDataString } from "./grain-key-codec";
import { InvalidCursorException } from "./invalid-cursor-exception";
import type { LookupResourcesArgs, LookupSubjectsArgs } from "./reverse-ops-dtos";

/**
 * Encodes and decodes the opaque continuation cursors carried on the reverse-op grain replies and
 * the gRPC responses, so callers treat them as a black-box token.
 *
 * LookupResources resumes from the engine's `LookupResourcesCursor` (one ordered section per
 * nesting level). LookupSubjects has no engine cursor - its results are deterministically ordered
 * by subject id, so a cursor is simply the last id already returned and resumption skips ids at or
 * before it. An empty/whitespace token means "from the start".
 *
 * Every token is bound to a hash of the originating request's shape (op kind, resource/permission,
 * subject, caveat context) plus the hash of the schema in effect at the pinned revision - mirroring
 * SpiceDB's cursor request-hash check and its schema-hash-carrying cursors - so resuming with a
 * cursor minted for a different request, or across a schema change, fails with
 * {@link InvalidCursorException} rather than silently skipping or duplicating results.
 *
 * CONTRADICTION RESOLVED IN FAVOUR OF THE CODE. The C# doc comment says the tokens are "URL-safe
 * base64"; `ToToken` calls `Convert.ToBase64String`, which is STANDARD base64 with `+`, `/` and
 * `=`. A client hands the token back verbatim, so the CODE is the contract and the comment is the
 * bug - it is not carried across.
 *
 * WIRE-VISIBLE, so every mechanical detail below is load-bearing: the `Uri.EscapeDataString`
 * segment escape (shared with the grain-key codec, NOT `encodeURIComponent`), the
 * `RemoveEmptyEntries` section split, the EXACT per-tag field counts, .NET's whitespace set, and
 * the asymmetric keyset field order.
 */

const SECTION_SEPARATOR = ";";
const FIELD_SEPARATOR = ":";

// Separates the request-shape hash prefix from the cursor payload inside the token. '\n' never
// occurs in the hex hash and never survives the payload's Uri escaping.
const HASH_SEPARATOR = "\n";

// Per-section kind tags. Exactly one resume mechanism applies per section.
const TAG_LEAF = "L"; // Portion-1 self-match: LastResourceId follows.
const TAG_QUERY = "Q"; // Query entrypoint: a six-field keyset follows.
const TAG_STRUCTURAL = "S"; // Structural rewrite / query first-chunk: no payload.

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * `char.IsWhiteSpace`'s character class, which is NOT JavaScript's: .NET includes U+0085 (NEL) and
 * EXCLUDES U+FEFF, while JavaScript's `trim` does the opposite on both. Which set applies decides
 * "start from the beginning" versus "attempt a decode", so it is hand-rolled here rather than
 * delegated to `trim`.
 */
const WHITESPACE_CLASS =
  "[\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

const WHITESPACE_ONLY = new RegExp(`^${WHITESPACE_CLASS}*$`);

/**
 * The whitespace `int.TryParse` itself strips, which is NARROWER than {@link WHITESPACE_CLASS}:
 * .NET's number parser allows only U+0020 and U+0009-U+000D, never the Unicode spaces that
 * `char.IsWhiteSpace` reports true for. Verified on dotnet 10.0.102: a leading U+00A0, U+0085,
 * U+1680, U+2000, U+202F or U+3000 all make `int.TryParse` return false while
 * `char.IsWhiteSpace` returns true for each.
 *
 * The two sets must stay separate. Sharing the wider one here accepts a cursor .NET rejects, and
 * the token is client-supplied: a tampered section would silently resume LookupResources at a
 * fabricated entrypoint index instead of being refused as malformed.
 */
const NUMBER_WHITESPACE_CLASS = "[\\t-\\r ]";

/**
 * `int.TryParse(s, out var idx)` with the DEFAULT `NumberStyles.Integer`: a leading sign and
 * surrounding whitespace are allowed, everything else (hex, exponents, decimal points, group
 * separators) rejected. Deliberately NOT unified with `preconditionMessages`' parse, which passes
 * `NumberStyles.None` and so allows none of that.
 */
const INT32_SHAPE = new RegExp(
  `^${NUMBER_WHITESPACE_CLASS}*([+-]?[0-9]+)${NUMBER_WHITESPACE_CLASS}*$`,
);

/** `string.IsNullOrWhiteSpace`. */
function isNullOrWhiteSpace(value: string | undefined): boolean {
  return value === undefined || WHITESPACE_ONLY.test(value);
}

function tryParseInt32(value: string): number | undefined {
  const match = INT32_SHAPE.exec(value);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  if (parsed < INT32_MIN || parsed > INT32_MAX) return undefined;
  return parsed;
}

/**
 * The request-shape hash a LookupResources cursor is bound to: op kind, resource type, permission,
 * subject, caveat context, and the hash of the schema resolved at the pinned revision. The schema
 * hash is included because `LookupResourcesCursorSection.entrypointIndex` is positional in the
 * schema's entrypoint ordering - resuming under a changed schema would silently walk the wrong
 * entrypoint (mirrors upstream, whose cursors carry the schema hash; cf. the CLAUDE.md "schema
 * change yields a fresh keyspace" invariant on dispatch grain keys). Limit and consistency are
 * deliberately excluded - a client may legitimately change the page size or re-pin between pages,
 * and a benign re-pin under an unchanged schema resolves the same schema hash.
 *
 * The C# `RequestShapeHash` overload pair becomes two distinctly named functions, per the guide's
 * overload-set row.
 */
export function requestShapeHashLookupResources(
  args: LookupResourcesArgs,
  schemaHash: string,
): string {
  return hashShape(
    "LR",
    schemaHash,
    args.resourceType,
    args.permission,
    args.subjectType,
    args.subjectId,
    args.subjectRelation,
    args.context,
  );
}

/**
 * The request-shape hash a LookupSubjects cursor is bound to: op kind, resource, permission,
 * subject type/relation, caveat context, and the hash of the schema resolved at the pinned
 * revision (see {@link requestShapeHashLookupResources} for why the schema hash is bound).
 */
export function requestShapeHashLookupSubjects(
  args: LookupSubjectsArgs,
  schemaHash: string,
): string {
  return hashShape(
    "LS",
    schemaHash,
    args.resourceType,
    args.resourceId,
    args.permission,
    args.subjectType,
    args.subjectRelation,
    args.context,
  );
}

function hashShape(
  kind: string,
  schemaHash: string,
  a: string,
  b: string,
  c: string,
  d: string,
  e: string,
  context: ReadonlyMap<string, unknown> | undefined,
): string {
  let sb = "";
  for (const part of [kind, schemaHash, a, b, c, d, e]) {
    sb += escapeDataString(part) + FIELD_SEPARATOR;
  }
  sb += appendCanonical(context);
  // `Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(...)).AsSpan(0, 12))`.
  const digest = createHash("sha256").update(sb, "utf8").digest();
  return digest.subarray(0, 12).toString("hex");
}

/**
 * A deterministic rendering of the caveat context: keys sorted ordinally, values recursed, every
 * atom escaped so structure characters cannot be forged by content. Same input dictionary =>
 * same string, so equal request shapes always hash equal.
 *
 * The C# appends into a shared `StringBuilder`; the port returns the rendered text and the caller
 * concatenates - the same bytes, as with `encodeSection`. The branch ORDER is the C#'s: null,
 * string, bool, dictionary, enumerable, then the numeric (`IFormattable`) arm. The bare `sort()`
 * is `StringComparer.Ordinal` (UTF-16 code units), never `localeCompare`. The `n` arm renders via
 * `String(value)` where the C# uses the invariant culture - only same-runtime determinism is
 * load-bearing (tokens never cross implementations), so the two renderings need not agree
 * byte-for-byte across languages.
 */
function appendCanonical(value: unknown): string {
  if (value === null || value === undefined) return "~";
  if (typeof value === "string") return "s" + escapeDataString(value);
  if (typeof value === "boolean") return "b" + (value ? "1" : "0");
  if (value instanceof Map) {
    let sb = "{";
    const map = value as ReadonlyMap<string, unknown>;
    for (const key of [...map.keys()].sort()) {
      sb += escapeDataString(key) + "=" + appendCanonical(map.get(key)) + ",";
    }
    return sb + "}";
  }
  if (typeof value === "object" && Symbol.iterator in value) {
    let sb = "[";
    for (const item of value as Iterable<unknown>) {
      sb += appendCanonical(item) + ",";
    }
    return sb + "]";
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return "n" + escapeDataString(String(value));
  }
  return "o" + escapeDataString(String(value));
}

/**
 * Encodes a LookupResources engine cursor to an opaque token bound to the request-shape hash, or
 * absent when there is none.
 */
export function encodeLookupResourcesCursor(
  cursor: LookupResourcesCursor | undefined,
  requestHash: string,
): string | undefined {
  if (cursor === undefined || cursor.sections.length === 0) return undefined;

  let raw = "";
  for (let i = 0; i < cursor.sections.length; i++) {
    if (i > 0) raw += SECTION_SEPARATOR;
    raw += encodeSection(cursor.sections[i] as LookupResourcesCursorSection);
  }
  return toToken(raw, requestHash);
}

// The C# appends into a shared `StringBuilder`; the port returns each section's text and the caller
// joins. The same bytes, with no shared mutable buffer threaded through.
function encodeSection(s: LookupResourcesCursorSection): string {
  let section = `${s.entrypointIndex}${FIELD_SEPARATOR}`;
  if (s.lastResourceId !== undefined) {
    section += `${TAG_LEAF}${FIELD_SEPARATOR}${escapeDataString(s.lastResourceId)}`;
  } else if (s.afterKeyset !== undefined) {
    section += TAG_QUERY;
    for (const part of keysetParts(s.afterKeyset))
      section += `${FIELD_SEPARATOR}${escapeDataString(part)}`;
  } else {
    section += TAG_STRUCTURAL;
  }
  return section;
}

/**
 * SUBJECT first, RESOURCE second. The decode reads them back the other way round (resource from
 * `p[3..5]`, subject from `p[0..2]`); the asymmetry is deliberate, and a "tidying" swap here would
 * silently resume a lookup at the wrong place.
 */
function keysetParts(k: RelationshipReference): readonly string[] {
  return [
    k.subject.objectType,
    k.subject.objectId,
    k.subject.relation,
    k.resource.objectType,
    k.resource.objectId,
    k.resource.relation,
  ];
}

/**
 * Decodes an opaque token back to a LookupResources engine cursor, or absent when empty. Throws
 * {@link InvalidCursorException} when the token is malformed or was minted for a request with a
 * different shape.
 */
export function decodeLookupResourcesCursor(
  token: string | undefined,
  requestHash: string,
): LookupResourcesCursor | undefined {
  const raw = fromToken(token, requestHash);
  if (raw === undefined) return undefined;

  const sections: LookupResourcesCursorSection[] = [];
  // `Split(SectionSeparator, StringSplitOptions.RemoveEmptyEntries)` tolerates a doubled or
  // trailing separator; JavaScript's `split` keeps the empties, so they are filtered explicitly.
  for (const part of raw.split(SECTION_SEPARATOR).filter((p) => p.length > 0))
    sections.push(decodeSection(part));
  return sections.length === 0 ? undefined : { sections };
}

function decodeSection(part: string): LookupResourcesCursorSection {
  const fields = part.split(FIELD_SEPARATOR);
  const idx = tryParseInt32(fields[0] as string);
  if (fields.length < 2 || idx === undefined) throw malformedSection(part);

  // The field counts are EXACT per tag - 3 for a leaf, 2 for a structural section, 8 for a query -
  // and anything else falls through to the same `FormatException` naming the offending section.
  switch (fields[1]) {
    case TAG_LEAF:
      if (fields.length !== 3) throw malformedSection(part);
      return { entrypointIndex: idx, lastResourceId: unescapeDataString(fields[2] as string) };
    case TAG_STRUCTURAL:
      if (fields.length !== 2) throw malformedSection(part);
      return { entrypointIndex: idx };
    case TAG_QUERY: {
      if (fields.length !== 8) throw malformedSection(part);
      const p: string[] = [];
      for (let i = 0; i < 6; i++) p.push(unescapeDataString(fields[i + 2] as string));
      const keyset: RelationshipReference = {
        resource: {
          objectType: p[3] as string,
          objectId: p[4] as string,
          relation: p[5] as string,
        },
        subject: {
          objectType: p[0] as string,
          objectId: p[1] as string,
          relation: p[2] as string,
        },
      };
      return { entrypointIndex: idx, afterKeyset: keyset };
    }
    default:
      throw malformedSection(part);
  }
}

function malformedSection(part: string): InvalidCursorException {
  return new InvalidCursorException(`Malformed lookup-resources cursor section: '${part}'.`);
}

/**
 * Encodes the last subject id returned as a LookupSubjects continuation token bound to the
 * request-shape hash.
 */
export function encodeSubjectId(lastSubjectId: string, requestHash: string): string {
  return toToken(lastSubjectId, requestHash);
}

/**
 * Decodes a LookupSubjects token back to the last subject id, or absent when empty. Throws
 * {@link InvalidCursorException} when the token is malformed or was minted for a request with a
 * different shape.
 */
export function decodeSubjectId(
  token: string | undefined,
  requestHash: string,
): string | undefined {
  return fromToken(token, requestHash);
}

function toToken(raw: string, requestHash: string): string {
  return toBase64String(requestHash + HASH_SEPARATOR + raw);
}

function fromToken(token: string | undefined, requestHash: string): string | undefined {
  if (isNullOrWhiteSpace(token)) return undefined;

  let decoded: string;
  try {
    decoded = fromBase64String(token as string);
  } catch (error) {
    // `catch (FormatException)` - the base64 helper's FormatError; anything else is a bug.
    if (!(error instanceof FormatError)) throw error;
    throw new InvalidCursorException("invalid cursor: token is malformed");
  }

  const separator = decoded.indexOf(HASH_SEPARATOR);
  if (separator < 0) throw new InvalidCursorException("invalid cursor: token is malformed");
  if (decoded.slice(0, separator) !== requestHash) {
    throw new InvalidCursorException(
      "cursor does not apply to this request: it was created for a different set of arguments",
    );
  }
  return decoded.slice(separator + 1);
}
