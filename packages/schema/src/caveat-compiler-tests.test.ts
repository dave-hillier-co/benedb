import type { CaveatTypeReference } from "@benedb/core/caveat-definition";
import { describe, expect, it } from "vitest";

import { CaveatCompileException } from "./caveat-compile-exception";
import { compileCaveat } from "./caveat-compiler";
import { validateCaveatParameterType } from "./caveat-parameter-types";
import { compileStoredSchema } from "./schema-compiler";

// Ported from `tests/Spiceport.Engine.Tests/CaveatCompilerTests.cs`, case for case: the static CEL
// check SpiceDB applies to a caveat body at schema-write time (`pkg/caveats/compile.go`
// `CompileCaveatWithSource` over cel-go's parser and checker). Every expected message is the one
// SpiceDB v1.49.2 produces for the same parameters and body through `caveats.CompileCaveatWithName`.

/** Parameter types as the schema compiler models them, e.g. `"x int, l list<int>"`. */
function parameterTypes(parameters: string): ReadonlyMap<string, CaveatTypeReference> {
  const caveat = compileStoredSchema(`caveat c(${parameters}) { true }`).caveats[0];
  if (caveat === undefined) throw new Error("expected a caveat");
  return caveat.parameterTypes;
}

/** Compiles `expression` as caveat `c` with the given parameter list. */
function compile(parameters: string, expression: string): void {
  compileCaveat("c", expression, parameterTypes(parameters));
}

function rejection(parameters: string, expression: string): string {
  try {
    compile(parameters, expression);
  } catch (error) {
    if (error instanceof CaveatCompileException) return error.message;
    throw error;
  }
  throw new Error("expected a CaveatCompileException");
}

describe("CaveatCompilerTests", () => {
  // ---- accepted ----

  it.each([
    ["x int", "x == 1"],
    ["b bool", "!!b"],
    ["i int", "--i == 1"],
    ["s string", "s.startsWith('a') || s.endsWith('b') && s.contains('c')"],
    ["s string", "s.matches('^a') && matches(s, 'a') && size(s) > s.size()"],
    ["u uint", "u == 1 && u > 1"],
    ["i int, u uint", "i == u"],
    ["d double", "d > 1.0"],
    ["by bytes", "by == b'abc' && size(by) == 3"],
    ["du duration, ts timestamp", "ts - ts > du && ts + du > ts && du > duration('1h')"],
    ["ts timestamp", "ts.getHours() == 1 && ts.getHours('UTC') == 1 && ts.getFullYear() > 2000"],
    ["l list<int>", "1 in l && l[0] == 1 && [1] + [2] == l"],
    ["m map<int>", "'a' in m && m['a'] == 1 && m.a == 1 && has(m.a)"],
    ["a any", "a == 1 && a.b == 1 && a[0] == 1 && a.size() > 0"],
    ["a any, b bool", "a && b"],
    ["ip ipaddress, cidr string", "ip.in_cidr(cidr) && ip.in_cidr('10.0.0.0/8') && ip == ip"],
    ["x map<any>", "x.isSubtreeOf(x) && {'a': 1}.isSubtreeOf(x)"],
    ["x map<map<string>>, y map<any>", "x.isSubtreeOf(y)"],
    ["l list<int>", "l.all(e, e > 0) && l.exists(e, e > 0) && l.exists_one(e, e > 0)"],
    ["l list<int>", "l.map(e, e * 2) == [2] && l.map(e, e > 0, e * 2)[0] == 2"],
    ["l list<int>", "l.filter(e, e > 0).size() == 1"],
    ["m map<int>", "m.all(k, k == 'a')"],
    ["a any", "a.all(e, e)"],
    ["ll list<list<int>>", "ll.all(x, x.all(y, y > 0))"],
    ["b bool", "(b ? 1 : 2) == 1"],
    ["l list<int>", "[1, 'a'][0] == 1 && [] == l && {'a': 1, 'b': 'c'}.a == 1"],
    ["i int", "type(i) == int && dyn(i) == 1 && int('1') == i && string(i) == '1'"],
    ["a any, ts timestamp, ip ipaddress", "null == a && ts == null && ip == null"],
    ["m map<int>", "optional.of(m['a']).hasValue() && optional.of(1).value() == 1"],
    ["i int", "optional.of(i).optMap(x, x + 1).value() == 2"],
    ["i int", "google.protobuf.Int64Value{value: 1} == i"],
    ["b bool", "b // a comment\n && true"],
  ])("accepts well typed boolean expressions: (%s) %s", (parameters, expression) => {
    compile(parameters, expression);
  });

  // The conformance corpus's caveats, each compiled against its declared parameters.
  it.each([
    ["somemap map<any>", "somemap.foo == 42 && somemap.bar < 56"],
    ["somelist list<int>", "somelist.all(i, i >= 42)"],
    ["user_ip ipaddress, cidr string", "user_ip.in_cidr(cidr)"],
    ["user_ip ipaddress, cidr string", "!user_ip.in_cidr(cidr)"],
    ["current_time timestamp, expiration timestamp", "current_time < expiration"],
    ["limit uint, count uint", "count < limit"],
    ["admin_teams list<string>, self string", "self in admin_teams"],
    ["actual string, required string", "actual == required"],
    ["day_of_week string", "day_of_week == 'tuesday'"],
    ["somesecret int, somecondition int", "somecondition == somesecret"],
    ["memberparam int", "memberparam >= 42"],
    ["thirdcondition bool", "thirdcondition"],
  ])("accepts the conformance corpus caveats: (%s) %s", (parameters, expression) => {
    compile(parameters, expression);
  });

  it("compares mixed numeric types once a comprehension has been checked", () => {
    // cel-go disables the int/double ordering overloads, but its comprehension scopes are built
    // without that filter, and the environment restored afterwards is too: so the mixed comparison
    // type-checks after a macro, and only after one.
    compile("i int, l list<int>", "l.all(e, true) && i < 1.0");

    expect(rejection("i int, l list<int>", "i < 1.0 && l.all(e, true)")).toBe(
      "ERROR: c:1:3: found no matching overload for '_<_' applied to '(int, double)'\n" +
        " | i < 1.0 && l.all(e, true)\n | ..^",
    );
  });

  // ---- rejected: type errors ----

  it("rejects a non-boolean operand of a logical operator", () => {
    // The issue's example: accepted before because the boolean-output check was dynamic.
    expect(rejection("x int, y int", "x == 1 || y")).toBe(
      "ERROR: c:1:11: expected type 'bool' but found 'int'\n | x == 1 || y\n | ..........^",
    );
  });

  it("reports every operand type error in source order", () => {
    expect(rejection("b bool, i int, s string, d double", "b || i || s || d")).toBe(
      "ERROR: c:1:6: expected type 'bool' but found 'int'\n | b || i || s || d\n | .....^\n" +
        "ERROR: c:1:11: expected type 'bool' but found 'string'\n | b || i || s || d\n | ..........^\n" +
        "ERROR: c:1:16: expected type 'bool' but found 'double'\n | b || i || s || d\n | ...............^",
    );
  });

  it.each([
    [
      "x int",
      'x == "a"',
      "ERROR: c:1:3: found no matching overload for '_==_' applied to '(int, string)'\n | x == \"a\"\n | ..^",
    ],
    [
      "i int, d double",
      "i < d",
      "ERROR: c:1:3: found no matching overload for '_<_' applied to '(int, double)'\n | i < d\n | ..^",
    ],
    [
      "x uint",
      "x == 1u",
      "ERROR: c:1:3: found no matching overload for '_==_' applied to '(int, uint)'\n | x == 1u\n | ..^",
    ],
    [
      "m map<int>",
      "1 in m",
      "ERROR: c:1:3: found no matching overload for '@in' applied to '(int, map(string, int))'\n | 1 in m\n | ..^",
    ],
    [
      "user_ip ipaddress, allowed_ips list<string>",
      "user_ip in allowed_ips",
      "ERROR: c:1:9: found no matching overload for '@in' applied to '(IPAddress, list(string))'\n | user_ip in allowed_ips\n | ........^",
    ],
    [
      "ip ipaddress",
      "ip.in_cidr(1)",
      "ERROR: c:1:11: found no matching overload for 'in_cidr' applied to 'IPAddress.(int)'\n | ip.in_cidr(1)\n | ..........^",
    ],
    [
      "l list<int>",
      "l.filter(e, e)",
      "ERROR: c:1:9: found no matching overload for '_?_:_' applied to '(int, list(int), list(int))'\n | l.filter(e, e)\n | ........^",
    ],
  ])("rejects mismatched operand types: (%s) %s", (parameters, expression, expected) => {
    expect(rejection(parameters, expression)).toBe(expected);
  });

  it.each([
    [
      "x int",
      "x == 1 && y",
      "ERROR: c:1:11: undeclared reference to 'y' (in container '')\n | x == 1 && y\n | ..........^",
    ],
    [
      "x int",
      "x.foo()",
      "ERROR: c:1:6: undeclared reference to 'foo' (in container '')\n | x.foo()\n | .....^",
    ],
    [
      "ip ipaddress",
      'ipaddress("1.2.3.4") == ip',
      "ERROR: c:1:10: undeclared reference to 'ipaddress' (in container '')\n | ipaddress(\"1.2.3.4\") == ip\n | .........^",
    ],
  ])(
    "rejects undeclared identifiers and functions: (%s) %s",
    (parameters, expression, expected) => {
      expect(rejection(parameters, expression)).toBe(expected);
    },
  );

  it.each([
    [
      "i int",
      "has(i.a)",
      "ERROR: c:1:4: type 'int' does not support field selection\n | has(i.a)\n | ...^",
    ],
    [
      "ip ipaddress",
      "ip.foo == 1",
      "ERROR: c:1:3: unexpected failed resolution of 'IPAddress'\n | ip.foo == 1\n | ..^",
    ],
    [
      "l list<int>",
      "l.all(e, e)",
      "ERROR: c:1:10: expected type 'bool' but found 'int'\n | l.all(e, e)\n | .........^",
    ],
  ])(
    "rejects ill typed selections and macro bodies: (%s) %s",
    (parameters, expression, expected) => {
      expect(rejection(parameters, expression)).toBe(expected);
    },
  );

  // ---- rejected: non-boolean output ----

  it.each([
    ["x int", "x", "int"],
    ["x uint", "x", "int"],
    ["x string", "x", "string"],
    ["x double", "x", "double"],
    ["x bytes", "x", "bytes"],
    ["x duration", "x", "google.protobuf.Duration"],
    ["x timestamp", "x", "google.protobuf.Timestamp"],
    ["x list<int>", "x", "list(int)"],
    ["x map<int>", "x", "map(string, int)"],
    ["x ipaddress", "x", "IPAddress"],
    ["x int", "type(x)", "type(int)"],
    ["x int", "optional.of(x)", "optional_type(int)"],
    ["x int", 'x == 1 ? "a" : "b"', "string"],
    ["l list<int>", "l.map(e, e * 2)", "list(int)"],
  ])("rejects a non-boolean result: (%s) %s", (parameters, expression, found) => {
    expect(rejection(parameters, expression)).toBe(
      `caveat expression must result in a boolean value: found \`${found}\``,
    );
  });

  // SpiceDB requires the output type to be exactly bool: dyn is rejected, even where the value may
  // turn out to be a boolean at evaluation time.
  it.each([
    ["x any", "x"],
    ["x map<any>", "x.foo"],
    ["x int", "dyn(x)"],
    ["b bool, a any", "b ? a : true"],
  ])("rejects a dynamic result: (%s) %s", (parameters, expression) => {
    expect(rejection(parameters, expression)).toBe(
      "caveat expression must result in a boolean value: found `dyn`",
    );
  });

  // ---- rejected: parse errors ----

  it.each([
    ["b bool", "b && while", "ERROR: c:1:6: reserved identifier: while\n | b && while\n | .....^"],
    ["s string", "has(s)", "ERROR: c:1:5: invalid argument to has() macro\n | has(s)\n | ....^"],
  ])("rejects what cel-go does not parse: (%s) %s", (parameters, expression, expected) => {
    expect(rejection(parameters, expression)).toBe(expected);
  });

  // ---- documented divergences: the parse is @bufbuild/cel's, not cel-go's ----

  it("reports a syntax error with @bufbuild/cel's wording and position", () => {
    // SpiceDB: "ERROR: c:1:5: Syntax error: extraneous input '>' expecting {...}".
    expect(rejection("x int", "x > > 0")).toBe(
      "ERROR: c:1:3: Syntax error: found > but expecting end of input\n | x > > 0\n | ..^",
    );
  });

  it("accepts an escape sequence cel-go rejects", () => {
    // SpiceDB: "Syntax error: token recognition error at: '\"a\\q'", and two more errors.
    compile("s string", 's == "a\\q"');
  });

  it.each([
    [
      "m map<int>",
      "m.?a.hasValue()",
      "ERROR: c:1:2: Syntax error: found . but expecting end of input\n | m.?a.hasValue()\n | .^",
    ],
    [
      "b bool",
      "b // a trailing comment",
      "ERROR: c:1:3: Syntax error: found / but expecting end of input\n | b // a trailing comment\n | ..^",
    ],
  ])(
    "rejects what cel-go parses but @bufbuild/cel does not: (%s) %s",
    (parameters, expression, expected) => {
      // SpiceDB accepts both: the optional syntax, and a comment ending the expression.
      expect(rejection(parameters, expression)).toBe(expected);
    },
  );

  // ---- the environment ----

  it("rejects a parameter redeclaring a standard type identifier", () => {
    expect(rejection("int int", "int == 1")).toBe(
      "ERROR: c:-1:0: overlapping identifier for name 'int'",
    );
  });

  it.each([
    ["foo", "unknown type `foo`"],
    ["list", "type `list` requires 1 generic types; found 0"],
    ["map<string, int>", "type `map` requires 1 generic types; found 2"],
    ["list<foo>", "unknown type `foo`"],
  ])("rejects an unknown parameter type: %s", (type, expected) => {
    const reference = parameterTypes(`x ${type}`).get("x") as CaveatTypeReference;
    expect(() => validateCaveatParameterType(reference)).toThrow(CaveatCompileException);
    expect(() => validateCaveatParameterType(reference)).toThrow(expected);
  });

  it("relocates errors to the expression's position in the schema", () => {
    // As SpiceDB: a location on the expression's first line shifts by the start column, every line
    // by the start line; the snippet is still the expression's own line.
    expect(() => compileCaveat("c", "x == 1 || y", parameterTypes("x int, y int"), 0, 25)).toThrow(
      "ERROR: c:1:36: expected type 'bool' but found 'int'\n | x == 1 || y\n | ...........^",
    );

    let message = "";
    try {
      compileCaveat("c", "b &&\n  i", parameterTypes("b bool, i int"), 3, 4);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("ERROR: c:5:3: expected type 'bool' but found 'int'");
  });
});
