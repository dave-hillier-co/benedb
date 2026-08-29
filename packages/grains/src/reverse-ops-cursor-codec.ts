import { FormatError } from "@spacedb/core/format-error";
import type { RelationshipReference } from "@spacedb/core/relationship-reference";
import type {
  LookupResourcesCursor,
  LookupResourcesCursorSection,
} from "@spacedb/engine/lookup-resources-cursor";

import { fromBase64String, toBase64String } from "./convert-base64";
import { escapeDataString, unescapeDataString } from "./grain-key-codec";

/**
 * Encodes and decodes the opaque continuation cursors carried on the reverse-op grain replies and
 * the gRPC responses, so callers treat them as a black-box token.
 *
 * LookupResources resumes from the engine's `LookupResourcesCursor` (one ordered section per
 * nesting level). LookupSubjects has no engine cursor - its results are deterministically ordered
 * by subject id, so a cursor is simply the last id already returned and resumption skips ids at or
 * before it. An empty/whitespace token means "from the start".
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

/** Encodes a LookupResources engine cursor to an opaque token, or absent when there is none. */
export function encodeLookupResourcesCursor(
  cursor: LookupResourcesCursor | undefined,
): string | undefined {
  if (cursor === undefined || cursor.sections.length === 0) return undefined;

  let raw = "";
  for (let i = 0; i < cursor.sections.length; i++) {
    if (i > 0) raw += SECTION_SEPARATOR;
    raw += encodeSection(cursor.sections[i] as LookupResourcesCursorSection);
  }
  return toBase64String(raw);
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

/** Decodes an opaque token back to a LookupResources engine cursor, or absent when empty. */
export function decodeLookupResourcesCursor(
  token: string | undefined,
): LookupResourcesCursor | undefined {
  const raw = fromToken(token);
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

function malformedSection(part: string): FormatError {
  return new FormatError(`Malformed lookup-resources cursor section: '${part}'.`);
}

/** Encodes the last subject id returned as a LookupSubjects continuation token. */
export function encodeSubjectId(lastSubjectId: string): string {
  return toBase64String(lastSubjectId);
}

/** Decodes a LookupSubjects token back to the last subject id, or absent when empty. */
export function decodeSubjectId(token: string | undefined): string | undefined {
  return fromToken(token);
}

// A bare base64 of the payload with NO version tag, in both directions - kept as it is, because the
// token is already in clients' hands.
function fromToken(token: string | undefined): string | undefined {
  if (isNullOrWhiteSpace(token)) return undefined;
  return fromBase64String(token as string);
}
