import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { describe, expect, it } from "vitest";

import { parseCaveatExpression } from "./caveat-compiler";

// Characterization of Spiceport `Engine/CaveatCompiler.cs`. No direct C# test exists;
// `SchemaTypeValidatorTests` is the only thing that exercises it, and only through one case
// (`caveat c(x int) { x > > 0 }`). Thirty lines of C#, but a behavioural fork.
//
// The write-time gate. `SchemaTypeValidator.ValidateCaveat` calls this first and wraps whatever
// it throws as `SchemaTypeException("could not compile caveat `<name>`: <message>")`, mirroring
// SpiceDB's `caveats.DeserializeCaveatWithTypeSet`: an expression that cannot compile is
// rejected when the schema is written, not deferred to a Check that will then deny at runtime.
//
// Port decisions pinned here:
//
//   * PARSE MUST STILL RESOLVE FUNCTIONS. The .NET `Cel` package's `Environment.Parse` resolves
//     the registered custom functions during the parse, so a caveat naming a function that does
//     not exist fails at schema-write time. `@bufbuild/cel`'s `env.parse(text)` is SYNTAX ONLY -
//     function resolution happens when the parsed expression is planned, and even then an
//     unresolved call is left as a node that only errors at eval. Left alone, a caveat calling a
//     bogus function would be accepted at write time and deny at check time instead, which is a
//     real divergence in the error path SchemaTypeValidator depends on. So the port does the
//     resolution step itself rather than narrowing the gate, and the unknown-function cases
//     below are what hold it to that.
//
//   * The standard library must survive that check. An over-narrow allowlist of known function
//     names would reject perfectly good caveats at schema-write time - a far worse failure than
//     the narrowing it was meant to fix - so the accepted set below is deliberately broad.
//
//   * `private static readonly CelEnvironment Environment` is a module-level constant, built
//     once. Unlike `CaveatEvaluator`, sharing it is safe here: parsing binds no variables.
//
//   * .NET `Parse` throws; `@bufbuild/cel`'s parse may throw OR return a parse carrying errors,
//     so the port checks and normalises. The thrown TYPE is deliberately not pinned: the
//     validator catches broadly (`CelException or InvalidOperationException or
//     ArgumentException`) and only re-reads `ex.Message`.
//
//   * `ArgumentNullException.ThrowIfNull` becomes an `InvalidArgumentError` guard, kept even
//     though the TypeScript parameter is non-optional - the caller may be untyped.

describe("caveat compiler", () => {
  describe("accepts", () => {
    it("a plain boolean expression over undeclared identifiers", () => {
      // Parsing does not bind variables: the caveat's parameters are validated separately, by
      // SchemaTypeValidator, and are never supplied here.
      expect(() => parseCaveatExpression("tier > 5")).not.toThrow();
      expect(() => parseCaveatExpression("allowed || tier > 5")).not.toThrow();
      expect(() => parseCaveatExpression("!denied && age >= 18")).not.toThrow();
      expect(() => parseCaveatExpression("true")).not.toThrow();
    });

    it("the SpiceDB custom functions", () => {
      expect(() => parseCaveatExpression("user_ip.in_cidr(cidr)")).not.toThrow();
      expect(() => parseCaveatExpression("ipaddress(user_ip).in_cidr(cidr)")).not.toThrow();
      expect(() => parseCaveatExpression("someMap.isSubtreeOf(anotherMap)")).not.toThrow();
    });

    it("the CEL standard library and macros", () => {
      expect(() => parseCaveatExpression("size(items) == 3")).not.toThrow();
      expect(() => parseCaveatExpression('name.startsWith("a")')).not.toThrow();
      expect(() => parseCaveatExpression('name.matches("^a")')).not.toThrow();
      expect(() => parseCaveatExpression("items.all(x, x > 0)")).not.toThrow();
      expect(() => parseCaveatExpression("items.exists(x, x > 0)")).not.toThrow();
      expect(() => parseCaveatExpression("x in items")).not.toThrow();
      expect(() => parseCaveatExpression("has(obj.field)")).not.toThrow();
      expect(() => parseCaveatExpression("int(x) == 1")).not.toThrow();
      expect(() => parseCaveatExpression('string(x) == "a"')).not.toThrow();
      expect(() => parseCaveatExpression("timestamp(t) > timestamp(u)")).not.toThrow();
      expect(() => parseCaveatExpression('duration(d) < duration("1h")')).not.toThrow();
      expect(() => parseCaveatExpression("cond ? a : b")).not.toThrow();
      expect(() => parseCaveatExpression('m["key"] == 1')).not.toThrow();
      expect(() => parseCaveatExpression('{"a": 1}.isSubtreeOf(m)')).not.toThrow();
    });

    it("a non-boolean expression", () => {
      // The compiler is a parse gate, not a type checker: SpiceDB rejects a non-boolean caveat
      // during its own type-check step, which Spiceport does not port. Pinned so that adding
      // one later is a deliberate change rather than an accident.
      expect(() => parseCaveatExpression("1 + 1")).not.toThrow();
    });

    it("the same expression repeatedly, against the shared environment", () => {
      for (let i = 0; i < 3; i++) {
        expect(() => parseCaveatExpression("user_ip.in_cidr(cidr)")).not.toThrow();
      }
    });
  });

  describe("rejects", () => {
    it("a syntactically invalid expression", () => {
      // The one case SchemaTypeValidatorTests covers, plus its neighbours.
      expect(() => parseCaveatExpression("x > > 0")).toThrow();
      expect(() => parseCaveatExpression("1 +")).toThrow();
      expect(() => parseCaveatExpression("(1")).toThrow();
      expect(() => parseCaveatExpression('"unterminated')).toThrow();
    });

    it("an empty or whitespace-only expression", () => {
      expect(() => parseCaveatExpression("")).toThrow();
      expect(() => parseCaveatExpression("   ")).toThrow();
    });

    it("a call to a function that does not exist", () => {
      // The behavioural fork described at the top of this file. If these pass, a caveat naming
      // a bogus function is accepted at schema write and only denies at check time.
      expect(() => parseCaveatExpression("bogus_function(1)")).toThrow();
      expect(() => parseCaveatExpression("user_ip.bogus_method(cidr)")).toThrow();
      expect(() => parseCaveatExpression("items.all(x, x.bogus_method())")).toThrow();
    });

    it("a near-miss on a custom function name", () => {
      // `in_cidr` and `isSubtreeOf` are the exact registered names; a typo must not slip
      // through to runtime.
      expect(() => parseCaveatExpression("user_ip.inCidr(cidr)")).toThrow();
      expect(() => parseCaveatExpression("user_ip.in_cidr6(cidr)")).toThrow();
      expect(() => parseCaveatExpression("someMap.is_subtree_of(anotherMap)")).toThrow();
    });
  });

  describe("guards", () => {
    it("rejects an absent expression with InvalidArgumentError", () => {
      expect(() => parseCaveatExpression(undefined as unknown as string)).toThrow(
        InvalidArgumentError,
      );
      expect(() => parseCaveatExpression(null as unknown as string)).toThrow(InvalidArgumentError);
    });
  });
});
