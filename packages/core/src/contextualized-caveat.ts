import { contextEqual } from "./structural-equality";

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
 * Value equality, comparing `context` by content (values deeply; undefined and empty alike mean no
 * context) rather than by map reference.
 *
 * Ported from the C# record's `Equals` override. Key order is ignored (a JSON object is an
 * unordered map); order matters only for byte-exact tuple-string formatting.
 */
export function contextualizedCaveatEquals(
  a: ContextualizedCaveat | undefined,
  b: ContextualizedCaveat | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.caveatName === b.caveatName && contextEqual(a.context, b.context);
}
