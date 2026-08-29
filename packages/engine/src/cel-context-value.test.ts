import { CelError, CelMap } from "@bufbuild/cel";
import { describe, expect, it } from "vitest";

import { buildCaveatCelEnvironment } from "./caveat-cel-environment";
import { toCelContextValue } from "./cel-context-value";

/**
 * Regression cover for the CEL missing-key semantics SpaceDB depends on. There is no C# original:
 * Cel.NET and cel-go both yield CEL's "no such key" ERROR value for an absent map key, and the
 * absorbing `&&`/`||` operators then collapse it against a definite operand. `@bufbuild/cel`
 * 0.2.0's `CelMap.accessByName` instead calls `adapter.toCel(undefined)` on a miss, which THROWS
 * `Error: Unsupported type: undefined` out of `env.run` - so the error never reaches the operator
 * that would have absorbed it. {@link toCelContextValue} restores the reference behaviour.
 */

/** Runs `expression` with `m` bound to `value`, as `CaveatEvaluator` binds a context parameter. */
function run(value: unknown, expression: string): unknown {
  const env = buildCaveatCelEnvironment();
  env.set("m", toCelContextValue(value));
  return env.run(expression);
}

const map = (entries: Record<string, unknown>): ReadonlyMap<string, unknown> =>
  new Map(Object.entries(entries));

describe("toCelContextValue", () => {
  it("absorbs a missing key into a definitely-false conjunction", () => {
    // caveatmap.yaml: `somemap.foo == 42 && somemap.bar < 56` with {"foo": 41}.
    expect(run(map({ foo: 41 }), "m.foo == 42 && m.bar < 56")).toBe(false);
  });

  it("absorbs a missing key into a definitely-true disjunction", () => {
    expect(run(map({ foo: 42 }), "m.foo == 42 || m.bar < 56")).toBe(true);
  });

  it("yields a no-such-key error when the missing key determines the result", () => {
    expect(run(map({ foo: 42 }), "m.foo == 42 && m.bar < 56")).toBeInstanceOf(CelError);
  });

  it("absorbs a missing key on an EMPTY map", () => {
    expect(run(map({}), "m.foo == 42 && false")).toBe(false);
  });

  it("absorbs a missing key reached by index syntax", () => {
    expect(run(map({ foo: 41 }), 'm["bar"] < 56 && m["foo"] == 42')).toBe(false);
  });

  it("absorbs a missing key on a NESTED map", () => {
    expect(run(map({ inner: map({ foo: 41 }) }), "m.inner.foo == 42 && m.inner.bar < 56")).toBe(
      false,
    );
  });

  it("absorbs a missing key on a map inside a list", () => {
    expect(run(map({ items: [map({ foo: 41 })] }), "m.items[0].foo == 42 && m.items[0].bar")).toBe(
      false,
    );
  });

  it("still reads present keys, at every depth", () => {
    expect(run(map({ foo: 42 }), "m.foo")).toBe(42);
    expect(run(map({ inner: map({ foo: 42 }) }), "m.inner.foo")).toBe(42);
    expect(run(map({ items: [map({ foo: 42 })] }), "m.items[0].foo")).toBe(42);
  });

  it("still answers has() for present and absent keys", () => {
    expect(run(map({ foo: 42 }), "has(m.foo)")).toBe(true);
    expect(run(map({ foo: 42 }), "has(m.bar)")).toBe(false);
  });

  it("still reaches the isSubtreeOf custom function, at every depth", () => {
    expect(run(map({ a: map({ b: 1 }) }), 'm.isSubtreeOf({"a": {"b": 1}, "c": 2})')).toBe(true);
    expect(run(map({ a: map({ b: 2 }) }), 'm.isSubtreeOf({"a": {"b": 1}, "c": 2})')).toBe(false);
  });

  it("still compares equal to an equivalent map literal", () => {
    expect(run(map({ foo: 42 }), 'm == {"foo": 42}')).toBe(true);
  });

  it("leaves scalars, and the wrapped map's own shape, alone", () => {
    expect(toCelContextValue("text")).toBe("text");
    expect(toCelContextValue(42)).toBe(42);
    expect(toCelContextValue(undefined)).toBe(undefined);

    const wrapped = toCelContextValue(map({ foo: 42 }));
    expect(wrapped).toBeInstanceOf(CelMap);
    expect([...(wrapped as CelMap<unknown, unknown>).value]).toEqual([["foo", 42]]);
  });
});
