/**
 * A reference to a caveat together with the runtime context values supplied on a relationship.
 *
 * `context` is a `Map`, not a plain object: a plain JS object reorders integer-like keys
 * numerically, which would change `JSON` key order and therefore the formatted tuple string.
 * `undefined` and an empty map mean the same thing (`TupleStrings.FormatCaveat` treats both as
 * "no context"), and `contextualizedCaveatEquals` honours that.
 */
export interface ContextualizedCaveat {
  /** The name of the caveat definition. */
  readonly caveatName: string;
  /**
   * Optional JSON-serializable context map. Values are scalars (string, number, boolean, null),
   * arrays, or nested maps. Undefined or empty means no context.
   */
  readonly context?: ReadonlyMap<string, unknown> | undefined;
}

/**
 * Structural equality over the caveat name and context.
 *
 * DIVERGES FROM C#: C# record equality on an `IReadOnlyDictionary` member is REFERENCE
 * equality, so two Spiceport caveats with equal-content but distinct dictionaries are unequal.
 * TypeScript gives no record equality at all, so a comparison has to be written either way;
 * this port compares context by content, because "same name, same values" is what callers
 * mean and reference identity is an artifact of C# codegen. Key order is ignored (a JSON
 * object is an unordered map); order matters only for byte-exact tuple-string formatting.
 */
export function contextualizedCaveatEquals(
  a: ContextualizedCaveat | undefined,
  b: ContextualizedCaveat | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.caveatName !== b.caveatName) return false;
  return contextEquals(a.context, b.context);
}

function contextEquals(
  a: ReadonlyMap<string, unknown> | undefined,
  b: ReadonlyMap<string, unknown> | undefined,
): boolean {
  const left = a ?? EMPTY_CONTEXT;
  const right = b ?? EMPTY_CONTEXT;
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key)) return false;
    if (!deepEquals(value, right.get(key))) return false;
  }
  return true;
}

const EMPTY_CONTEXT: ReadonlyMap<string, unknown> = new Map<string, unknown>();

/** Content equality over JSON-shaped values: scalars, arrays, plain objects and `Map`s. */
function deepEquals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => deepEquals(value, b[index]));
  }

  const left = toEntryMap(a);
  const right = toEntryMap(b);
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key)) return false;
    if (!deepEquals(value, right.get(key))) return false;
  }
  return true;
}

function toEntryMap(value: object): ReadonlyMap<unknown, unknown> {
  return value instanceof Map ? value : new Map<unknown, unknown>(Object.entries(value));
}
