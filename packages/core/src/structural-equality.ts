/**
 * Content comparison for the record members whose own equality would otherwise be by reference
 * (byte arrays, maps, lists), so the records holding them keep the value equality a record
 * advertises.
 *
 * Ported from Spiceport `Common/StructuralEquality.cs`. Port decisions:
 *   * The C#'s `BytesHash` and `ContextHash` are not ported: a TypeScript interface has no
 *     `GetHashCode`, and nothing in the port hashes these records.
 *   * The C#'s `JsonElement` arm has no counterpart: a context value here is already a plain
 *     JavaScript value, never a parsed-JSON handle.
 *   * A context map is a `Map`, and a nested map may also arrive as a plain object (the shape
 *     `JSON.parse` yields). Both are maps to {@link valueEqual}; an array never is, which keeps the
 *     C#'s "a map is never equal to a list" rule.
 *   * The C#'s default arm, a boxed `a.Equals(b)`, is SameValueZero for numbers (`NaN` equals
 *     `NaN`, `0` equals `-0`), so it is spelled that way rather than as `===` or `Object.is`.
 */

/** Whether two byte arrays hold the same bytes. */
export function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Whether two caveat context maps hold the same entries, comparing values deeply. An absent map and
 * an empty map both mean "no context" and compare equal.
 */
export function contextEqual(
  a: ReadonlyMap<string, unknown> | undefined,
  b: ReadonlyMap<string, unknown> | undefined,
): boolean {
  if (a === b) return true;
  if ((a?.size ?? 0) !== (b?.size ?? 0)) return false;
  if (a === undefined || b === undefined) return true; // both empty
  for (const [key, value] of a) {
    if (!b.has(key) || !valueEqual(value, b.get(key))) return false;
  }
  return true;
}

/** Whether two context values are equal by content: maps by entry, sequences by element. */
export function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;

  const aIsMap = isMap(a);
  const bIsMap = isMap(b);
  if (aIsMap && bIsMap) return contextEqual(toMap(a), toMap(b));
  // A map is never equal to a list (a protobuf Struct and ListValue differ even when both are
  // empty), so a map only reaches the sequence comparison below when both sides are maps.
  if (aIsMap || bIsMap) return false;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valueEqual(a[i], b[i])) return false;
    }
    return true;
  }
  // SameValueZero, the C#'s boxed `Equals`: only NaN differs from `===` here.
  return a !== a && b !== b;
}

function isMap(value: unknown): value is ReadonlyMap<string, unknown> | Record<string, unknown> {
  if (value instanceof Map) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toMap(
  value: ReadonlyMap<string, unknown> | Record<string, unknown>,
): ReadonlyMap<string, unknown> {
  return value instanceof Map
    ? (value as ReadonlyMap<string, unknown>)
    : new Map(Object.entries(value));
}
