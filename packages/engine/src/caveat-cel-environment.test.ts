import { CelError } from "@bufbuild/cel";
import { describe, expect, it } from "vitest";

import { buildCaveatCelEnvironment } from "./caveat-cel-environment";

// Characterization of Spiceport `Engine/CaveatCelEnvironment.cs`. There is NO direct C# test:
// `CaveatEvaluatorTests` pins only the unbound-receiver path and `CaveatCheckTests` pins
// `in_cidr` end-to-end through a check, while `isSubtreeOf` is untested in Spiceport entirely.
// Its intended semantics therefore come from SpiceDB's cel-go registrations
// (`pkg/caveats/types/basic.go`, `map.go`, `ipaddress.go`), and this suite is the only gate on
// the file until the caveat conformance corpus lands.
//
// Port decisions pinned here:
//
//   * `new CelEnvironment(null, null)` + `env.RegisterFunction(name, types, lambda)` has no
//     counterpart. The port builds `createEnv("", createRegistry())` and installs the three
//     SpiceDB customs through a `FuncRegistry` of `Func.newStrict(...)`. `createEnv`, never
//     `new CelEnv()`, whose parser is left unset and throws "parser not set" on first use.
//
//   * EXCEPTIONS BECOME VALUES. The C# `RequireBound` throws `CelUndeclaredReferenceException`
//     when a custom-function argument is null, which is how an absent caveat parameter is
//     signalled. `@bufbuild/cel` has no such channel: an unbound identifier evaluates to a
//     `CelError` value, and `Func.newStrict` already propagates a `CelError`/`CelUnknown`
//     argument without ever entering the op. So the port's custom functions never see an
//     unbound argument, and `RequireBound` disappears - but the OBSERVABLE behaviour it
//     existed to produce (an unbound operand is an error, never a plain `false`) must survive,
//     which is what the "unbound" cases below pin. `CaveatEvaluator` turns that error value
//     into `caveated`; collapsing it to `false` here would silently deny access.
//
//   * `IPAddress.TryParse` has no JS equivalent, so the port hand-rolls the parse. It is
//     STRICT - dotted-quad IPv4 with no leading zeros, or IPv6 - which is what SpiceDB's
//     `netip.ParseAddr` does and what the conformance corpus will assert. This is a
//     DELIBERATE, DOCUMENTED DIVERGENCE from Spiceport: .NET 10's `IPAddress.TryParse` is
//     lenient in ways nobody wants in an authorization decision, and it was verified against
//     .NET 10 for this port that it accepts `010.0.0.1` as OCTAL (8.0.0.1), `1.2.3` as
//     1.2.0.3, `16777217` as 1.0.0.1 and `0x0a.0.0.1` as 10.0.0.1. Those forms are rejected
//     here.
//
//   * `isSubtreeOf` requires BOTH sides to be string-keyed maps (anything else is false),
//     recurses only when both values are maps, and compares numerics by converting BOTH to
//     double, so C# `1L` equals `1.0`. In CEL-JS an int is a `bigint`, a double is a `number`
//     and a uint is a `CelUint`, and `1n !== 1`, so that cross-width equality has to be
//     re-implemented explicitly or every mixed-width subtree check regresses to false.
//
//   * A map arrives in TWO shapes and both must work. A CEL map LITERAL plans to a `CelMap`
//     whose values are themselves adapted (`CelMap`, `CelList`, `bigint`, ...), while
//     `env.set(name, new Map(...))` produces a `CelMap` whose values are still the RAW native
//     objects handed in (a plain `Map`, a plain array). The variable form is the one the
//     evaluator actually uses, so it is pinned alongside the literal form.

/** Evaluates `expression` in a freshly built caveat environment with `vars` bound. */
function run(expression: string, vars: ReadonlyMap<string, unknown> = new Map()): unknown {
  const env = buildCaveatCelEnvironment();
  for (const [name, value] of vars) {
    env.set(name, value);
  }
  return env.run(expression);
}

describe("caveat cel environment", () => {
  describe("ipaddress", () => {
    it("is the identity over its string argument", () => {
      // The C# registers `ipaddress(string) -> args[0]`: this engine represents an IP address
      // as the string itself rather than as a distinct opaque type.
      expect(run(`ipaddress("10.0.0.1")`)).toBe("10.0.0.1");
    });

    it("composes with in_cidr as the receiver", () => {
      expect(run(`ipaddress("10.0.0.5").in_cidr("10.0.0.0/8")`)).toBe(true);
    });
  });

  describe("in_cidr", () => {
    it("returns true for an address inside the network", () => {
      expect(run(`"10.0.0.5".in_cidr("10.0.0.0/8")`)).toBe(true);
    });

    it("returns false for an address outside the network", () => {
      expect(run(`"11.0.0.5".in_cidr("10.0.0.0/8")`)).toBe(false);
    });

    it("treats a zero-length prefix as matching every address of the family", () => {
      expect(run(`"10.0.0.5".in_cidr("0.0.0.0/0")`)).toBe(true);
      expect(run(`"255.255.255.255".in_cidr("0.0.0.0/0")`)).toBe(true);
      expect(run(`"2001:db8::1".in_cidr("::/0")`)).toBe(true);
    });

    it("treats a full-length prefix as an exact match", () => {
      expect(run(`"10.0.0.5".in_cidr("10.0.0.5/32")`)).toBe(true);
      expect(run(`"10.0.0.6".in_cidr("10.0.0.5/32")`)).toBe(false);
    });

    it("masks per bit, not per byte, on a prefix that is not byte-aligned", () => {
      // /29 keeps the top five bits of the last octet: 10.0.0.0-10.0.0.7 match, 10.0.0.9 does
      // not. A byte-granular mask would wrongly accept the whole final octet.
      expect(run(`"10.0.0.5".in_cidr("10.0.0.0/29")`)).toBe(true);
      expect(run(`"10.0.0.7".in_cidr("10.0.0.0/29")`)).toBe(true);
      expect(run(`"10.0.0.9".in_cidr("10.0.0.0/29")`)).toBe(false);
    });

    it("matches IPv6 networks", () => {
      expect(run(`"2001:db8::1".in_cidr("2001:db8::/32")`)).toBe(true);
      expect(run(`"2001:db9::1".in_cidr("2001:db8::/32")`)).toBe(false);
    });

    it("returns false, not an error, when the address families differ", () => {
      // The C# compares `AddressFamily` and returns FALSE. A mismatch is a definite non-match,
      // not an undetermined caveat, so it must not surface as a CelError.
      expect(run(`"10.0.0.1".in_cidr("2001:db8::/32")`)).toBe(false);
      expect(run(`"::1".in_cidr("10.0.0.0/8")`)).toBe(false);
    });

    it("compares a CIDR with no slash as a single address", () => {
      // `cidr.IndexOf('/') < 0` falls back to address equality. SpiceDB's `netip.ParsePrefix`
      // rejects a bare address instead; Spiceport is the source and it is pinned here.
      expect(run(`"10.0.0.1".in_cidr("10.0.0.1")`)).toBe(true);
      expect(run(`"10.0.0.1".in_cidr("10.0.0.2")`)).toBe(false);
      expect(run(`"2001:db8::1".in_cidr("2001:db8::1")`)).toBe(true);
    });

    it("returns false for a prefix length outside the address width", () => {
      expect(run(`"10.0.0.1".in_cidr("10.0.0.0/33")`)).toBe(false);
      expect(run(`"2001:db8::1".in_cidr("2001:db8::/129")`)).toBe(false);
      expect(run(`"10.0.0.1".in_cidr("10.0.0.0/-1")`)).toBe(false);
    });

    it("returns false for a malformed prefix length", () => {
      expect(run(`"10.0.0.1".in_cidr("10.0.0.0/")`)).toBe(false);
      expect(run(`"10.0.0.1".in_cidr("10.0.0.0/abc")`)).toBe(false);
    });

    it("returns false for a malformed address or network", () => {
      expect(run(`"not-an-ip".in_cidr("10.0.0.0/8")`)).toBe(false);
      expect(run(`"".in_cidr("10.0.0.0/8")`)).toBe(false);
      expect(run(`"10.0.0.1".in_cidr("garbage/8")`)).toBe(false);
      expect(run(`"10.0.0.1".in_cidr("")`)).toBe(false);
      expect(run(`"10.0.0.256".in_cidr("10.0.0.0/8")`)).toBe(false);
      expect(run(`"1.2.3.4.5".in_cidr("1.0.0.0/8")`)).toBe(false);
    });

    it("parses strictly: no octal, no shorthand, no hex, no surrounding space", () => {
      // See the divergence note at the top of this file. .NET 10 accepts every one of these
      // and reads the leading-zero forms as OCTAL; SpiceDB's netip rejects them, and an
      // authorization decision must not turn on which reading a runtime happens to pick.
      expect(run(`"010.0.0.1".in_cidr("8.0.0.0/8")`)).toBe(false);
      expect(run(`"010.0.0.1".in_cidr("10.0.0.0/8")`)).toBe(false);
      expect(run(`"1.2.3".in_cidr("1.2.0.0/16")`)).toBe(false);
      expect(run(`"16777217".in_cidr("1.0.0.0/8")`)).toBe(false);
      expect(run(`"0x0a.0.0.1".in_cidr("10.0.0.0/8")`)).toBe(false);
      expect(run(`" 10.0.0.1".in_cidr("10.0.0.0/8")`)).toBe(false);
      expect(run(`"10.0.0.1 ".in_cidr("10.0.0.0/8")`)).toBe(false);
    });

    it("yields an error, not false, when the receiver is unbound", () => {
      // The whole point of the C#'s `RequireBound`: an absent parameter must stay undetermined
      // so that CaveatEvaluator reports `caveated`. Returning `false` here would deny.
      const result = run(`user_ip.in_cidr("10.0.0.0/8")`);

      expect(result).toBeInstanceOf(CelError);
    });

    it("yields an error, not false, when the cidr argument is unbound", () => {
      const result = run(`"10.0.0.1".in_cidr(cidr)`);

      expect(result).toBeInstanceOf(CelError);
    });
  });

  describe("isSubtreeOf", () => {
    it("is true when every key of the left map is present on the right with an equal value", () => {
      expect(run(`{"a": 1, "b": "x"}.isSubtreeOf({"a": 1, "b": "x", "c": true})`)).toBe(true);
    });

    it("is false when a key of the left map is absent from the right", () => {
      expect(run(`{"a": 1, "z": 2}.isSubtreeOf({"a": 1})`)).toBe(false);
    });

    it("is false when a shared key holds a different value", () => {
      expect(run(`{"a": 1}.isSubtreeOf({"a": 2})`)).toBe(false);
      expect(run(`{"a": "x"}.isSubtreeOf({"a": "y"})`)).toBe(false);
      expect(run(`{"a": true}.isSubtreeOf({"a": false})`)).toBe(false);
    });

    it("is vacuously true for an empty left map", () => {
      expect(run(`{}.isSubtreeOf({"a": 1})`)).toBe(true);
      expect(run(`{}.isSubtreeOf({})`)).toBe(true);
    });

    it("recurses into nested maps", () => {
      expect(run(`{"a": {"b": 1}}.isSubtreeOf({"a": {"b": 1, "c": 2}})`)).toBe(true);
      expect(run(`{"a": {"b": 1}}.isSubtreeOf({"a": {"b": 2}})`)).toBe(false);
      expect(run(`{"a": {"b": 1}}.isSubtreeOf({"a": {}})`)).toBe(false);
    });

    it("is false when a nested left map faces a non-map on the right", () => {
      expect(run(`{"a": {"b": 1}}.isSubtreeOf({"a": 1})`)).toBe(false);
      expect(run(`{"a": 1}.isSubtreeOf({"a": {"b": 1}})`)).toBe(false);
    });

    it("compares numerics across widths by converting both to double", () => {
      // The C# `ValuesEqual` routes two numerics through `Convert.ToDouble`, so `1L == 1.0`.
      // In CEL-JS the same pair is `1n` and `1`, and `1n !== 1`: without an explicit
      // cross-width comparison every mixed-width subtree check silently regresses to false.
      expect(run(`{"a": 1}.isSubtreeOf({"a": 1.0})`)).toBe(true);
      expect(run(`{"a": 1.0}.isSubtreeOf({"a": 1})`)).toBe(true);
      expect(run(`{"a": 1u}.isSubtreeOf({"a": 1})`)).toBe(true);
      expect(run(`{"a": 1}.isSubtreeOf({"a": 1u})`)).toBe(true);
      expect(run(`{"a": 1u}.isSubtreeOf({"a": 1.0})`)).toBe(true);
      expect(run(`{"a": 1}.isSubtreeOf({"a": 2.0})`)).toBe(false);
      expect(run(`{"a": 1.5}.isSubtreeOf({"a": 1})`)).toBe(false);
    });

    it("does not treat a number as equal to its string form", () => {
      expect(run(`{"a": 1}.isSubtreeOf({"a": "1"})`)).toBe(false);
      expect(run(`{"a": "1"}.isSubtreeOf({"a": 1})`)).toBe(false);
    });

    it("is false when either side is not a map", () => {
      // The C# `left is not IDictionary<string, object> || right is not ...` guard: anything
      // that is not a string-keyed map is not a subtree of anything, including of itself.
      expect(run(`"x".isSubtreeOf("x")`)).toBe(false);
      expect(run(`[1].isSubtreeOf([1])`)).toBe(false);
      expect(run(`{"a": 1}.isSubtreeOf("x")`)).toBe(false);
      expect(run(`"x".isSubtreeOf({"a": 1})`)).toBe(false);
    });

    it("works over map variables, whose entries arrive as raw native values", () => {
      // `env.set(name, new Map(...))` wraps the map but leaves its VALUES as the native
      // objects handed in - a nested `Map` stays a `Map`, it does not become a `CelMap` the
      // way a map literal's entries do. This is the shape CaveatEvaluator actually supplies,
      // so a `CelMap`-only implementation would pass every literal case above and still fail
      // every real caveat.
      const left = new Map<string, unknown>([["a", 1n]]);
      const right = new Map<string, unknown>([
        ["a", 1n],
        ["b", 2n],
      ]);

      const vars = new Map<string, unknown>([
        ["left", left],
        ["right", right],
      ]);

      expect(run(`left.isSubtreeOf(right)`, vars)).toBe(true);
      expect(run(`right.isSubtreeOf(left)`, vars)).toBe(false);
    });

    it("recurses into nested map variables", () => {
      const left = new Map<string, unknown>([["a", new Map<string, unknown>([["b", 1n]])]]);
      const right = new Map<string, unknown>([
        [
          "a",
          new Map<string, unknown>([
            ["b", 1n],
            ["c", 2n],
          ]),
        ],
      ]);

      const vars = new Map<string, unknown>([
        ["left", left],
        ["right", right],
      ]);

      expect(run(`left.isSubtreeOf(right)`, vars)).toBe(true);
      expect(run(`right.isSubtreeOf(left)`, vars)).toBe(false);
    });

    it("compares a map variable against a map literal", () => {
      const left = new Map<string, unknown>([["a", 1n]]);

      expect(run(`left.isSubtreeOf({"a": 1, "b": 2})`, new Map([["left", left]]))).toBe(true);
      expect(run(`left.isSubtreeOf({"a": 2})`, new Map([["left", left]]))).toBe(false);
    });

    it("yields an error, not false, when either side is unbound", () => {
      expect(run(`absent.isSubtreeOf({"a": 1})`)).toBeInstanceOf(CelError);
      expect(run(`{"a": 1}.isSubtreeOf(absent)`)).toBeInstanceOf(CelError);
    });
  });

  describe("the environment at large", () => {
    it("still provides the CEL standard library", () => {
      // The customs are ADDED to the standard dispatcher, not substituted for it: caveats lean
      // on size/startsWith/timestamp/duration and on the `.all` macro.
      expect(run(`size("abc") == 3`)).toBe(true);
      expect(run(`"abc".startsWith("a")`)).toBe(true);
      expect(run(`[1, 2].all(x, x > 0)`)).toBe(true);
      expect(run(`1 in [1, 2]`)).toBe(true);
      expect(run(`timestamp("2020-01-01T00:00:00Z") > timestamp("2019-01-01T00:00:00Z")`)).toBe(
        true,
      );
      expect(run(`duration("1h") > duration("30m")`)).toBe(true);
    });

    it("hands out a fresh environment on every build", () => {
      // The C# `Build()` returns a new CelEnvironment each call, and CaveatEvaluator depends on
      // it: a `CelEnv` holds its variables in mutable `data`, so a shared instance would leak
      // one evaluation's context into the next and turn a `caveated` into a definite verdict.
      const first = buildCaveatCelEnvironment();
      const second = buildCaveatCelEnvironment();

      expect(second).not.toBe(first);

      first.set("leaked", true);
      expect(second.run("leaked")).toBeInstanceOf(CelError);
    });
  });
});
