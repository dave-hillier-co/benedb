import { ELLIPSIS } from "./core-constants";
import { FormatError } from "./format-error";
import type { ContextualizedCaveat } from "./contextualized-caveat";
import type { ObjectAndRelation } from "./object-and-relation";
import type { Relationship } from "./relationship";

/**
 * Parsing and formatting of SpiceDB ONR and relationship (tuple) strings.
 *
 * Grammar (matching the SpiceDB Go reference):
 *
 *     TUPLE      ::= ONR '@' SUBJECT [ CAVEAT ] [ EXPIRATION ]
 *     ONR        ::= NAMESPACE ':' OBJECT_ID '#' RELATION
 *     SUBJECT    ::= NAMESPACE ':' SUBJECT_ID [ '#' (RELATION | '...') ]
 *     CAVEAT     ::= '[' CAVEAT_NAME [ ':' JSON_OBJECT ] ']'
 *     EXPIRATION ::= '[expiration:' RFC3339 ']'
 *
 * Every byte produced here is wire-visible, so the sub-expressions below keep the composed
 * structure of Spiceport's `[GeneratedRegex]` constants rather than being "simplified": the
 * namespace, relation and caveat-name expressions have a minimum length of three characters
 * and a maximum of 64, and collapsing the quantifiers would change what parses.
 *
 * Divergences from Spiceport, all deliberate:
 *
 *  - .NET's non-multiline `$` also matches immediately before a single trailing "\n". JS does
 *    not, so every anchored expression here ends `\n?$` to reproduce it.
 *  - .NET `\d` matches any Unicode Nd; JS `\d` is ASCII-only. The only `\d` is in the
 *    expiration sub-expression, where a non-ASCII digit would fail the subsequent date parse
 *    anyway, so the observable behaviour is unchanged.
 *  - `DateTimeOffset.TryParse` accepts far more than RFC3339. `parseInstant` below is a strict
 *    date/time parser over the character set the expiration expression already admits; the
 *    shapes Spiceport is known to accept (date only, unzoned, "Z"-suffixed, a numeric UTC
 *    offset, 1..n fractional digits rounded to the nearest 100ns tick) are reproduced exactly.
 *    The offset forms matter for wire compatibility: SpiceDB parses expirations with
 *    `time.RFC3339Nano`, whose `Z07:00` layout element accepts `-05:00` as well as `Z`.
 *  - Caveat context values go through `JSON.parse`, which yields plain numbers, so a source
 *    literal such as `1.0` re-emits as `1`. C# deserializes into `JsonElement`, which re-emits
 *    the source literal verbatim. `JSON.parse` also reorders integer-like keys of nested
 *    objects; caveat parameters are CEL identifiers, so this cannot arise in practice.
 */

const NAMESPACE_NAME_EXPR = "([a-z][a-z0-9_]{1,61}[a-z0-9]/)*[a-z][a-z0-9_]{1,62}[a-z0-9]";
const RESOURCE_ID_EXPR = "([a-zA-Z0-9/_|\\-=+]{1,})";
const SUBJECT_ID_EXPR = "([a-zA-Z0-9/_|\\-=+]{1,})|\\*";
const RELATION_EXPR = "[a-z][a-z0-9_]{1,62}[a-z0-9]";
const CAVEAT_NAME_EXPR = "([a-z][a-z0-9_]{1,61}[a-z0-9]/)*[a-z][a-z0-9_]{1,62}[a-z0-9]";

const ONR_EXPR = `(?<resourceType>(${NAMESPACE_NAME_EXPR})):(?<resourceID>${RESOURCE_ID_EXPR})#(?<resourceRel>${RELATION_EXPR})`;

const SUBJECT_EXPR = `(?<subjectType>(${NAMESPACE_NAME_EXPR})):(?<subjectID>${SUBJECT_ID_EXPR})(#(?<subjectRel>${RELATION_EXPR}|\\.\\.\\.))?`;

const CAVEAT_EXPR = `\\[(?<caveatName>(${CAVEAT_NAME_EXPR}))(:(?<caveatContext>(\\{(.+)\\})))?\\]`;

const EXPIRATION_EXPR = "\\[expiration:(?<expirationDateTime>([\\d\\-\\.:TZ]+))\\]";

const TUPLE_EXPR = `^${ONR_EXPR}@${SUBJECT_EXPR}(${CAVEAT_EXPR})?(${EXPIRATION_EXPR})?\n?$`;

const ONR_REGEX = new RegExp(`^${ONR_EXPR}\n?$`);
const TUPLE_REGEX = new RegExp(TUPLE_EXPR);
const RESOURCE_ID_REGEX = new RegExp(`^${RESOURCE_ID_EXPR}\n?$`);
const SUBJECT_ID_REGEX = new RegExp(`^(${SUBJECT_ID_EXPR})\n?$`);

/** Longest object id accepted, in UTF-16 code units (C# counts `char`s, so `.length` matches). */
const MAX_OBJECT_ID_LENGTH = 1024;

// ---- Formatting ----

/**
 * Formats an ONR. An ellipsis relation is omitted (`namespace:object_id`); otherwise
 * `namespace:object_id#relation`. Formatting does not validate.
 */
export function formatObjectAndRelation(onr: ObjectAndRelation): string {
  return onr.relation === ELLIPSIS
    ? `${onr.objectType}:${onr.objectId}`
    : `${onr.objectType}:${onr.objectId}#${onr.relation}`;
}

/** Formats a complete relationship as a canonical tuple string. Integrity is never emitted. */
export function formatRelationship(relationship: Relationship): string {
  return (
    formatObjectAndRelation(relationship.reference.resource) +
    "@" +
    formatObjectAndRelation(relationship.reference.subject) +
    formatCaveat(relationship.optionalCaveat) +
    formatExpiration(relationship.optionalExpiration)
  );
}

function formatCaveat(caveat: ContextualizedCaveat | undefined): string {
  if (caveat === undefined || caveat.caveatName === "") return "";

  // `Context is { Count: > 0 }`: an absent context and an empty one are the same thing.
  const context = caveat.context;
  const contextString =
    context !== undefined && context.size > 0 ? ":" + serializeJson(context) : "";

  return `[${caveat.caveatName}${contextString}]`;
}

// ---- Expirations ----

const NS_PER_SECOND = 1_000_000_000n;
const NS_PER_TICK = 100n;
const TICKS_PER_SECOND = 10_000_000n;

/**
 * `yyyy-MM-ddTHH:mm:ss.fffffff'Z'` after conversion to UTC: ALWAYS seven fractional digits and
 * always a "Z" suffix, which is why `Date.prototype.toISOString` (three digits) is not used.
 */
function formatExpiration(expiration: bigint | undefined): string {
  if (expiration === undefined) return "";

  let seconds = expiration / NS_PER_SECOND;
  let remainder = expiration % NS_PER_SECOND;
  if (remainder < 0n) {
    remainder += NS_PER_SECOND;
    seconds -= 1n;
  }

  const date = new Date(Number(seconds) * 1000);
  const ticks = remainder / NS_PER_TICK;

  const yyyy = pad(date.getUTCFullYear(), 4);
  const mm = pad(date.getUTCMonth() + 1, 2);
  const dd = pad(date.getUTCDate(), 2);
  const hh = pad(date.getUTCHours(), 2);
  const mi = pad(date.getUTCMinutes(), 2);
  const ss = pad(date.getUTCSeconds(), 2);
  const fff = ticks.toString().padStart(7, "0");

  return `[expiration:${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.${fff}Z]`;
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}

// ---- JSON serialization ----
//
// System.Text.Json with its default `JavaScriptEncoder`, reproduced by hand because
// `JSON.stringify` emits HTML-sensitive and non-ASCII characters raw. The forbidden BasicLatin
// characters are the HTML-sensitive set plus the grave accent; everything outside printable
// ASCII becomes `\uXXXX` with UPPERCASE hex, per UTF-16 code unit (so a non-BMP character
// becomes a surrogate pair of escapes, exactly as .NET writes it).

const FORBIDDEN_ASCII = new Set(['"', "&", "'", "+", "<", ">", "`", "\\"]);

const SHORT_ESCAPES = new Map<string, string>([
  ["\b", "\\b"],
  ["\t", "\\t"],
  ["\n", "\\n"],
  ["\f", "\\f"],
  ["\r", "\\r"],
  ["\\", "\\\\"],
]);

function serializeJson(value: unknown): string {
  if (value === null || value === undefined) return "null";

  switch (typeof value) {
    case "string":
      return serializeString(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "bigint":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    default:
      break;
  }

  if (Array.isArray(value)) return `[${value.map(serializeJson).join(",")}]`;
  if (value instanceof Map) return serializeEntries(value.entries());
  return serializeEntries(Object.entries(value as object)[Symbol.iterator]());
}

function serializeEntries(entries: IterableIterator<[unknown, unknown]>): string {
  const parts: string[] = [];
  for (const [key, entryValue] of entries) {
    parts.push(`${serializeString(String(key))}:${serializeJson(entryValue)}`);
  }
  return `{${parts.join(",")}}`;
}

function serializeString(value: string): string {
  let result = '"';
  for (const character of splitCodeUnits(value)) {
    const shortEscape = SHORT_ESCAPES.get(character);
    if (shortEscape !== undefined) {
      result += shortEscape;
      continue;
    }

    const code = character.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e && !FORBIDDEN_ASCII.has(character)) {
      result += character;
      continue;
    }

    result += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return result + '"';
}

/** Iterates UTF-16 code units, not code points: .NET escapes surrogates individually. */
function* splitCodeUnits(value: string): Generator<string> {
  for (let index = 0; index < value.length; index++) {
    yield value.charAt(index);
  }
}

// ---- Parsing ----

/**
 * Parses an ONR string (`namespace:object_id#relation`).
 *
 * @throws {FormatError} if the string is not a valid ONR.
 */
export function parseObjectAndRelation(value: string): ObjectAndRelation {
  const onr = tryParseObjectAndRelation(value);
  if (onr === undefined) throw new FormatError(`invalid object and relation string: '${value}'`);
  return onr;
}

/**
 * Attempts to parse an ONR string. Spiceport's `out` parameter becomes a
 * `ObjectAndRelation | undefined` return; there is no `null!` sentinel in the port.
 */
export function tryParseObjectAndRelation(value: string): ObjectAndRelation | undefined {
  const match = ONR_REGEX.exec(value);
  if (match === null) return undefined;

  const groups = match.groups as Record<string, string | undefined>;
  return {
    objectType: groups.resourceType ?? "",
    objectId: groups.resourceID ?? "",
    relation: groups.resourceRel ?? "",
  };
}

/**
 * Parses a relationship (tuple) string.
 *
 * @throws {FormatError} if the string is not a valid relationship.
 */
export function parseRelationship(value: string): Relationship {
  const relationship = tryParseRelationship(value);
  if (relationship === undefined) throw new FormatError(`invalid relationship string: '${value}'`);
  return relationship;
}

/** Attempts to parse a relationship (tuple) string. Integrity metadata is never populated. */
export function tryParseRelationship(value: string): Relationship | undefined {
  const match = TUPLE_REGEX.exec(value);
  if (match === null) return undefined;

  const groups = match.groups as Record<string, string | undefined>;

  const resource: ObjectAndRelation = {
    objectType: groups.resourceType ?? "",
    objectId: groups.resourceID ?? "",
    relation: groups.resourceRel ?? "",
  };

  const subjectRelation = groups.subjectRel;
  const subject: ObjectAndRelation = {
    objectType: groups.subjectType ?? "",
    objectId: groups.subjectID ?? "",
    relation:
      subjectRelation !== undefined && subjectRelation.length > 0 ? subjectRelation : ELLIPSIS,
  };

  let caveat: ContextualizedCaveat | undefined;
  const caveatName = groups.caveatName;
  if (caveatName !== undefined && caveatName.length > 0) {
    let context: ReadonlyMap<string, unknown> | undefined;
    const contextText = groups.caveatContext;
    if (contextText !== undefined && contextText.length > 0) {
      context = tryParseContext(contextText);
      if (context === undefined) return undefined;
    }
    caveat = { caveatName, context };
  }

  let expiration: bigint | undefined;
  const expirationText = groups.expirationDateTime;
  if (expirationText !== undefined && expirationText.length > 0) {
    expiration = parseInstant(expirationText);
    if (expiration === undefined) return undefined;
  }

  return {
    reference: { resource, subject },
    optionalCaveat: caveat,
    optionalExpiration: expiration,
    optionalIntegrity: undefined,
  };
}

/** `JsonSerializer.Deserialize<Dictionary<string, object?>>`; a `JsonException` becomes `undefined`. */
function tryParseContext(text: string): ReadonlyMap<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return toContextMap(parsed as Record<string, unknown>);
}

/**
 * Objects become `Map`s at every depth, so that re-serialization walks insertion order rather
 * than JavaScript's integer-key-first property order.
 */
function toContextMap(value: Record<string, unknown>): ReadonlyMap<string, unknown> {
  return new Map(Object.entries(value).map(([key, entry]) => [key, toContextValue(entry)]));
}

function toContextValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(toContextValue);
  return toContextMap(value as Record<string, unknown>);
}

const INSTANT_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:Z|([+-])(\d{2}):?(\d{2}))?$/;

/**
 * The port's stand-in for `DateTimeOffset.TryParse` with
 * `AssumeUniversal | AdjustToUniversal`: an unzoned value is UTC (not machine-local), a bare
 * date is midnight UTC, and the fraction is rounded to the nearest 100ns tick, which is
 * `DateTimeOffset`'s resolution. Returns nanoseconds since the Unix epoch.
 */
function parseInstant(value: string): bigint | undefined {
  const match = INSTANT_REGEX.exec(value);
  if (match === null) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = match[4] === undefined ? 0 : Number(match[4]);
  const minutes = match[5] === undefined ? 0 : Number(match[5]);
  const seconds = match[6] === undefined ? 0 : Number(match[6]);

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (hours > 23 || minutes > 59 || seconds > 59) return undefined;

  // A numeric UTC offset, as `AdjustToUniversal` handles it: the instant is normalized to UTC
  // by subtracting the offset. `Z` and an absent zone both leave the value untouched, which is
  // what `AssumeUniversal` does for the unzoned case.
  const offsetHours = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinutes = match[10] === undefined ? 0 : Number(match[10]);
  if (offsetHours > 23 || offsetMinutes > 59) return undefined;
  const offsetMillis =
    (match[8] === "-" ? -1 : 1) * (offsetHours * 3_600_000 + offsetMinutes * 60_000);

  // `Date.UTC` maps years 0..99 into the 1900s, so build the date explicitly and then confirm
  // no field rolled over (which is how an impossible day such as 2023-02-30 is rejected).
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hours, minutes, seconds, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  let ticks = parseTicks(match[7]);
  let epochMillis = date.getTime() - offsetMillis;
  if (ticks === TICKS_PER_SECOND) {
    ticks = 0n;
    epochMillis += 1000;
  }

  return BigInt(epochMillis) * 1_000_000n + ticks * NS_PER_TICK;
}

/** Fractional seconds to 100ns ticks, rounding half away from zero beyond seven digits. */
function parseTicks(fraction: string | undefined): bigint {
  if (fraction === undefined || fraction.length === 0) return 0n;

  const padded = fraction.padEnd(8, "0");
  const ticks = BigInt(padded.slice(0, 7));
  const next = padded.charCodeAt(7) - 48;
  return next >= 5 ? ticks + 1n : ticks;
}

// ---- Validation ----

/** Validates a resource object id: 1..1024 UTF-16 code units, allowed character set, no wildcard. */
export function isValidResourceId(objectId: string): boolean {
  return (
    objectId.length > 0 &&
    objectId.length <= MAX_OBJECT_ID_LENGTH &&
    RESOURCE_ID_REGEX.test(objectId)
  );
}

/** Validates a subject object id: as above, but the wildcard `*` is also accepted. */
export function isValidSubjectId(subjectId: string): boolean {
  return (
    subjectId.length > 0 &&
    subjectId.length <= MAX_OBJECT_ID_LENGTH &&
    SUBJECT_ID_REGEX.test(subjectId)
  );
}
