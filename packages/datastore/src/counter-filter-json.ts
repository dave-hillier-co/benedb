import type { RelationshipsFilter, SubjectsSelector } from "./relationships-filter";

/**
 * The flat, JSON-serializable mirror of the proto-shaped subset of `RelationshipsFilter` that a
 * registered counter carries (resource type/id/prefix/relation plus an optional single subject
 * filter). This is exactly the shape SpiceDB persists for a counter (its `core.RelationshipFilter`
 * bytes), so it round-trips the registered filter without depending on the proto package. Residual
 * filters (caveat/expiration/multi-selector) are not part of a registered counter and are
 * intentionally omitted.
 *
 * Module-private: the C# POCO exists only as a serialization shape, and the two free functions are
 * the whole public surface.
 */
interface CounterFilterJson {
  rt?: string | undefined;
  rid?: string | undefined;
  rpfx?: string | undefined;
  rrel?: string | undefined;
  st?: string | undefined;
  sid?: string | undefined;
  srel?: string | undefined;
}

/** The property order System.Text.Json emits, which is C# DECLARATION order. */
const PROPERTY_ORDER = ["rt", "rid", "rpfx", "rrel", "st", "sid", "srel"] as const;

const SHORT_ESCAPES: ReadonlyMap<number, string> = new Map([
  [0x08, "\\b"],
  [0x09, "\\t"],
  [0x0a, "\\n"],
  [0x0c, "\\f"],
  [0x0d, "\\r"],
  [0x5c, "\\\\"],
]);

/**
 * The characters `JavaScriptEncoder.Default` escapes on top of what JSON requires: `"`, `&`, `'`,
 * `+`, `<`, `>` and the backtick. Everything outside printable ASCII - every control character,
 * DEL, and every non-ASCII UTF-16 code unit including each half of a surrogate pair - is escaped
 * too, as `\uXXXX` with UPPERCASE hex.
 */
const EXTRA_ESCAPED = new Set([0x22, 0x26, 0x27, 0x2b, 0x3c, 0x3e, 0x60]);

/**
 * .NET's `JavaScriptEncoder.Default` string escaping. `JSON.stringify` is NOT a substitute: it
 * leaves `&`, `'`, `+`, `<`, `>`, the backtick and all non-ASCII unescaped and writes the quote as
 * `\"`. These bytes are persisted and wire-visible, and a resource-id prefix is arbitrary user
 * input, so the encoder is hand-rolled.
 */
function encodeJsonString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const short = SHORT_ESCAPES.get(code);
    if (short !== undefined) {
      out += short;
    } else if (code >= 0x20 && code <= 0x7e && !EXTRA_ESCAPED.has(code)) {
      out += value[i];
    } else {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return `${out}"`;
}

/**
 * `JsonSerializer.SerializeToUtf8Bytes` with `DefaultIgnoreCondition = WhenWritingNull`: absent
 * members are omitted entirely, present ones are written in declaration order. An empty string is
 * a value, not a null, and is written.
 */
function encodeCounterFilterJson(poco: CounterFilterJson): Uint8Array {
  const parts: string[] = [];
  for (const key of PROPERTY_ORDER) {
    const value = poco[key];
    if (value === undefined) continue;
    parts.push(`"${key}":${encodeJsonString(value)}`);
  }
  return new TextEncoder().encode(`{${parts.join(",")}}`);
}

/**
 * Serializes a `RelationshipsFilter` to its persisted UTF-8 JSON bytes.
 *
 * Deliberately LOSSY: only the first resource id and the first subjects selector survive, and the
 * caveat/expiration residual is dropped - a registered counter has none. Do not "improve" it.
 */
export function serializeCounterFilter(filter: RelationshipsFilter): Uint8Array {
  const poco: CounterFilterJson = {
    rt: filter.optionalResourceType,
    rpfx: filter.optionalResourceIdPrefix,
    rrel: filter.optionalResourceRelation,
  };

  // `is { Count: > 0 }`: an empty list is no id at all, not an empty id.
  const ids = filter.optionalResourceIds;
  if (ids !== undefined && ids.length > 0) poco.rid = ids[0];

  const selectors = filter.optionalSubjectsSelectors;
  if (selectors !== undefined && selectors.length > 0) {
    const s = selectors[0] as SubjectsSelector;
    poco.st = s.optionalSubjectType;
    const sids = s.optionalSubjectIds;
    if (sids !== undefined && sids.length > 0) poco.sid = sids[0];
    poco.srel = s.relationFilter?.nonEllipsisRelation;
  }

  return encodeCounterFilterJson(poco);
}

/**
 * A known member of the persisted object, or `undefined` when absent or an explicit JSON null.
 * `JsonSerializer` matches property names case-sensitively and skips unmatched members, so
 * neither is looked for here.
 *
 * A present member of the wrong JSON type THROWS, because `JsonSerializer.Deserialize` throws
 * `JsonException` on it (verified against System.Text.Json 10: `{"rt":5}` for a `string?` member
 * throws). Coercing it to `undefined` instead would be the exact trap the port guide names - an
 * error path that exists only because .NET throws going unreachable in JS - and here it is not
 * cosmetic: an all-absent `RelationshipsFilter` matches EVERY relationship, so a corrupt
 * persisted counter filter would silently count the whole store rather than fail.
 */
function readMember(parsed: Record<string, unknown>, key: string): string | undefined {
  const value = parsed[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new SyntaxError(
      `counter filter member "${key}" is ${typeof value}, expected a JSON string or null`,
    );
  }
  return value;
}

/**
 * Deserializes persisted UTF-8 JSON bytes back into a `RelationshipsFilter`.
 *
 * The inverse of `serializeCounterFilter` only up to its lossiness: single-element lists are
 * rebuilt for the id and the selector. A selector is built when ANY of st/sid/srel is present, and
 * a relation filter only when srel is present; absent and empty stay distinct.
 */
export function deserializeCounterFilter(bytes: Uint8Array): RelationshipsFilter {
  // `JsonSerializer.Deserialize` throws on malformed input, as `JSON.parse` does, and returns null
  // for the `null` literal, where the C# falls back to a fresh empty POCO.
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));

  // The `null` literal is the ONLY non-object root the C# tolerates: `Deserialize` returns null
  // for it and the caller falls back to `new CounterFilterJson()`. Every other scalar or array
  // root throws `JsonException` (verified: `5` and `[]` both throw), so it must throw here too.
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new SyntaxError(
      `counter filter JSON root is ${Array.isArray(parsed) ? "an array" : typeof parsed}, expected an object`,
    );
  }

  const poco: CounterFilterJson =
    parsed !== null
      ? {
          rt: readMember(parsed as Record<string, unknown>, "rt"),
          rid: readMember(parsed as Record<string, unknown>, "rid"),
          rpfx: readMember(parsed as Record<string, unknown>, "rpfx"),
          rrel: readMember(parsed as Record<string, unknown>, "rrel"),
          st: readMember(parsed as Record<string, unknown>, "st"),
          sid: readMember(parsed as Record<string, unknown>, "sid"),
          srel: readMember(parsed as Record<string, unknown>, "srel"),
        }
      : {};

  let selectors: readonly SubjectsSelector[] | undefined = undefined;
  if (poco.st !== undefined || poco.sid !== undefined || poco.srel !== undefined) {
    selectors = [
      {
        optionalSubjectType: poco.st,
        optionalSubjectIds: poco.sid !== undefined ? [poco.sid] : undefined,
        relationFilter: poco.srel !== undefined ? { nonEllipsisRelation: poco.srel } : undefined,
      },
    ];
  }

  return {
    optionalResourceType: poco.rt,
    optionalResourceIds: poco.rid !== undefined ? [poco.rid] : undefined,
    optionalResourceIdPrefix: poco.rpfx,
    optionalResourceRelation: poco.rrel,
    optionalSubjectsSelectors: selectors,
  };
}
