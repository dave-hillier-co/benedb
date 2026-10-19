import type { CaveatTypeReference } from "@benedb/core/caveat-definition";
import { describe, expect, it } from "vitest";

import { CaveatCompileException } from "./caveat-compile-exception";
import { compileCaveat } from "./caveat-compiler";
import { CelIssues } from "./cel-issues";
import { parseCelExpr } from "./cel-parsed-expr";
import { compileStoredSchema } from "./schema-compiler";

// BeneDB-only: the conversion of `@bufbuild/cel`'s parse into the tree cel-go's parser builds.
// Every expected message is SpiceDB v1.49.2's for the same parameters and body
// (`caveats.CompileCaveatWithName`), so each case pins a place where `@bufbuild/cel`'s tree differs
// from cel-go's and the conversion has to restore cel-go's shape or position.

function rejection(parameters: string, expression: string): string {
  const caveat = compileStoredSchema(`caveat c(${parameters}) { true }`).caveats[0];
  if (caveat === undefined) throw new Error("expected a caveat");
  const types: ReadonlyMap<string, CaveatTypeReference> = caveat.parameterTypes;
  try {
    compileCaveat("c", expression, types);
  } catch (error) {
    if (error instanceof CaveatCompileException) return error.message;
    throw error;
  }
  return "accepted";
}

describe("parseCelExpr", () => {
  it("restores the double negations @bufbuild/cel folds away", () => {
    expect(rejection("a any", "!(!a)")).toBe("accepted");
    expect(rejection("i int", "!(!i)")).toBe(
      "ERROR: c:1:3: found no matching overload for '!_' applied to '(int)'\n | !(!i)\n | ..^",
    );
    expect(rejection("s string", "-(-s)")).toBe(
      "ERROR: c:1:3: found no matching overload for '-_' applied to '(string)'\n | -(-s)\n | ..^",
    );
    expect(rejection("i int", "!(!(i + 1))")).toBe(
      "ERROR: c:1:3: found no matching overload for '!_' applied to '(int)'\n | !(!(i + 1))\n | ..^",
    );
    expect(rejection("i int", "(!(!i)).foo")).toBe(
      "ERROR: c:1:4: found no matching overload for '!_' applied to '(int)'\n | (!(!i)).foo\n | ...^\n" +
        "ERROR: c:1:8: type 'bool' does not support field selection\n | (!(!i)).foo\n | .......^",
    );
  });

  it("places nodes on later lines", () => {
    expect(rejection("i int, l list<int>", "l.all(x, x > 0) &&\n!(!i)")).toBe(
      "ERROR: c:2:3: found no matching overload for '!_' applied to '(int)'\n | !(!i)\n | ..^",
    );
  });

  it("reads a sign written apart from its number as cel-go does", () => {
    expect(rejection("i int", "- 9223372036854775808 == i")).toBe("accepted");
    expect(rejection("m map<int>", "- 9223372036854775808.isSubtreeOf(m)")).toBe(
      "ERROR: c:1:34: found no matching overload for 'isSubtreeOf' applied to 'int.(map(string, int))'\n" +
        " | - 9223372036854775808.isSubtreeOf(m)\n | .................................^",
    );
  });

  it.each([
    ["i int", "9223372036854775808 == i", "invalid int literal"],
    ["d double", "1e400 == d", "invalid double literal"],
    ["u uint", "18446744073709551616u == u", "invalid uint literal"],
  ])("rejects an out-of-range literal: (%s) %s", (parameters, expression, message) => {
    expect(rejection(parameters, expression)).toBe(
      `ERROR: c:1:1: ${message}\n | ${expression}\n | ^`,
    );
  });

  it("keeps a leading dot on an identifier or function name", () => {
    expect(rejection("i int", ".x == 1")).toBe(
      "ERROR: c:1:2: undeclared reference to '.x' (in container '')\n | .x == 1\n | .^",
    );
    expect(rejection("s string", ".foo(s)")).toBe(
      "ERROR: c:1:5: undeclared reference to '.foo' (in container '')\n | .foo(s)\n | ....^",
    );
  });

  it("applies cel-go's macro table, not @bufbuild/cel's", () => {
    expect(rejection("i int", "has(i)")).toBe(
      "ERROR: c:1:5: invalid argument to has() macro\n | has(i)\n | ....^",
    );
    expect(rejection("l list<int>", "l.all(x.y, true)")).toBe(
      "ERROR: c:1:8: argument must be a simple name\n | l.all(x.y, true)\n | .......^",
    );
    expect(rejection("l list<int>", "l.map(1, 2)")).toBe(
      "ERROR: c:1:7: argument is not an identifier\n | l.map(1, 2)\n | ......^",
    );
    expect(rejection("i int", "optional.of(1).optMap(x.y, x)")).toBe(
      "ERROR: c:1:24: optMap() variable name must be a simple identifier\n" +
        " | optional.of(1).optMap(x.y, x)\n | .......................^",
    );
    expect(rejection("i int", "optional.of(i).optMap(x, x)")).toBe(
      "caveat expression must result in a boolean value: found `optional_type(int)`",
    );
    // `existsOne` is an alias @bufbuild/cel expands and cel-go does not have.
    expect(rejection("l list<int>", "l.existsOne(x, x > 0)")).toBe(
      "ERROR: c:1:12: undeclared reference to 'existsOne' (in container '')\n | l.existsOne(x, x > 0)\n | ...........^\n" +
        "ERROR: c:1:13: undeclared reference to 'x' (in container '')\n | l.existsOne(x, x > 0)\n | ............^\n" +
        "ERROR: c:1:16: undeclared reference to 'x' (in container '')\n | l.existsOne(x, x > 0)\n | ...............^",
    );
  });

  it("balances a logical chain @bufbuild/cel parses as one call", () => {
    expect(
      rejection(
        "b bool, i int, s string, d double, l list<int>, m map<int>",
        "b || i || s || d || l || m",
      ),
    ).toBe(
      "ERROR: c:1:6: expected type 'bool' but found 'int'\n | b || i || s || d || l || m\n | .....^\n" +
        "ERROR: c:1:11: expected type 'bool' but found 'string'\n | b || i || s || d || l || m\n | ..........^\n" +
        "ERROR: c:1:16: expected type 'bool' but found 'double'\n | b || i || s || d || l || m\n | ...............^\n" +
        "ERROR: c:1:21: expected type 'bool' but found 'list(int)'\n | b || i || s || d || l || m\n | ....................^\n" +
        "ERROR: c:1:26: expected type 'bool' but found 'map(string, int)'\n | b || i || s || d || l || m\n | .........................^",
    );
  });

  it("places a message field at its colon", () => {
    expect(rejection("s string", "google.protobuf.Int64Value{value: s}")).toBe(
      "ERROR: c:1:33: expected type of field 'value' is 'int' but provided type is 'string'\n" +
        " | google.protobuf.Int64Value{value: s}\n | ................................^",
    );
  });

  it("reports @bufbuild/cel's syntax error at its position, in code points", () => {
    const issues = new CelIssues();
    parseCelExpr("'\u{1D538}' == > 1", issues);
    expect(issues.errors.map((e) => e.location)).toEqual([{ line: 1, column: 4 }]);
    expect(issues.errors[0]?.message).toMatch(/^Syntax error: /);
  });

  it("reports a reserved identifier as cel-go does", () => {
    expect(rejection("b bool", "b && while")).toBe(
      "ERROR: c:1:6: reserved identifier: while\n | b && while\n | .....^",
    );
  });
});
