import { type CelResult, type CelType, CelMap, NATIVE_ADAPTER } from "@bufbuild/cel";

/**
 * Converts a normalized caveat context value into the representation handed to `CelEnv.set`.
 *
 * PORT-ONLY MODULE - it has no Spiceport counterpart, because the behaviour it restores is
 * behaviour .NET gets for free.
 *
 * SpiceDB context maps reach CEL as maps, and CEL's rule for reading an absent key is that the
 * access yields an ERROR VALUE ("no such key"), which the absorbing `&&` / `||` operators then
 * collapse against a definite operand: cel-go's `false && <error>` is `false`, and Cel.NET agrees.
 * The conformance corpus depends on it - `caveatmap.yaml` asserts that
 * `somemap.foo == 42 && somemap.bar < 56` with `{"foo": 41}` is FALSE, not an error.
 *
 * `@bufbuild/cel` 0.2.0 breaks that for one of its two map carriers. A plain JavaScript object
 * becomes a `CelObject`, whose `accessByName` returns `undefined` on a miss and so becomes
 * `CelErrors.fieldNotFound` in `StringAccess.access` - correct. A JavaScript `Map` becomes a
 * `CelMap`, whose `accessByName` is `adapter.toCel(this.nativeKeyMap.get(name))` with NO
 * undefined guard, so a miss calls `toCel(undefined)`, which THROWS `Unsupported type: undefined`
 * straight out of `env.run`. The error never reaches the operator that would have absorbed it,
 * and a definitely-false caveat surfaces as a crash. (`CelMap.accessByIndex` and
 * `CelObject.accessByName` both have the guard; only this one path lacks it.)
 *
 * The evaluator's own map carrier is `Map`, and must stay `Map`: `convertValue` type-checks
 * `map<...>` parameters with `value instanceof Map`, `isSubtreeOf` reads `CelMap.value`, and the
 * `CelObject` path has its own upstream gap - it reads inherited members, so `m.toString` on a
 * context map returns `Object.prototype.toString` instead of a no-such-key error (the library
 * carries a `TODO(tstamm) fix access to properties from object prototype` at both of those
 * sites). So the fix is applied to the `CelMap` carrier: {@link CelMapWithKeyPresence} restores
 * the missing guard, and every map in the value tree - nested in a map, nested in a list - is
 * rebuilt with it, because the library would otherwise re-wrap the raw inner `Map` with the
 * unguarded class on the way down.
 *
 * This does NOT fix a map LITERAL written inside a caveat expression (`{"a": 1}.b`), which the
 * library plans into an unguarded `CelMap` of its own. No corpus case and no SpiceDB schema shape
 * reaches that; fixing it needs the upstream repair.
 */
export function toCelContextValue(value: unknown): unknown {
  if (value instanceof Map) {
    const entries = new Map<unknown, unknown>();
    for (const [key, item] of value as ReadonlyMap<unknown, unknown>) {
      entries.set(key, toCelContextValue(item));
    }
    return new CelMapWithKeyPresence(entries, NATIVE_ADAPTER, DYN_MAP);
  }

  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map(toCelContextValue);
  }

  // Scalars, `CelUint`, `Uint8Array` and anything already a CEL value pass through untouched.
  return value;
}

/**
 * A `CelMap` whose `accessByName` reports an absent key as absent instead of throwing. The base
 * class adapts the raw `undefined` a missed lookup returns; `CelObject.accessByName` and
 * `CelMap.accessByIndex` both guard that case, and this restores the same guard for the one path
 * that does not.
 */
class CelMapWithKeyPresence extends CelMap<unknown, unknown> {
  override accessByName(id: number, name: unknown): CelResult | undefined {
    // `nativeKeyMap` is the base class's key-normalized view, so presence is asked of exactly the
    // map the base class would have read.
    if (!this.nativeKeyMap.has(name)) return undefined;
    return super.accessByName(id, name);
  }
}

/**
 * The `map(dyn, dyn)` type the native adapter stamps on a `Map`. `@bufbuild/cel` does not export
 * `DYN_MAP` itself, so it is read back off a map the adapter builds - keeping the wrapper's type
 * identical to the one it replaces rather than minting a look-alike.
 */
const DYN_MAP: CelType = (NATIVE_ADAPTER.toCel(new Map([["", ""]])) as CelMap).type_;
