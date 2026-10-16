import { describe, expect, it } from "vitest";

import {
  caveatDefinitionEquals,
  caveatTypeReferenceEquals,
  type CaveatDefinition,
  type CaveatTypeReference,
} from "./caveat-definition";
import { contextualizedCaveatEquals, type ContextualizedCaveat } from "./contextualized-caveat";
import { ELLIPSIS } from "./core-constants";
import type { ObjectAndRelation } from "./object-and-relation";
import { createRelationship, relationshipEquals, type Relationship } from "./relationship";
import { relationshipIntegrityEquals, type RelationshipIntegrity } from "./relationship-integrity";

// Ported from Spiceport `tests/Spiceport.Core.Tests/RecordValueEqualityTests.cs`, case for case.
//
// Records advertise value equality. The ones that hold a byte array, a dictionary or an immutable
// list must compare those members by content, or two equal values read as different the moment they
// meet a set, a Distinct or a diff.
//
// Three substitutions:
//
//   * `Assert.Equal(a, b)` / `a == b` on a record become the module's `...Equals` function: a
//     TypeScript interface has no equality of its own, so the port wrote these by content from the
//     start, and the C# now agrees.
//   * `GetHashCode` has no counterpart - nothing in the port hashes these records - so the C#'s
//     hash-consistency assertions are dropped. `Assert.Single(new HashSet<Relationship> { .. })` is
//     therefore the equality it rests on.
//   * A caveat context is a `Map` (see `contextualized-caveat.ts`); nested maps inside it may be
//     `Map`s or plain objects, the shape `JSON.parse` yields, so the parsed-JSON case uses those.

function ctx(entries: readonly (readonly [string, unknown])[]): ReadonlyMap<string, unknown> {
  return new Map(entries);
}

function caveat(name: string, context?: ReadonlyMap<string, unknown>): ContextualizedCaveat {
  return { caveatName: name, context };
}

function typeRef(
  typeName: string,
  childTypes?: readonly CaveatTypeReference[],
): CaveatTypeReference {
  return { typeName, childTypes };
}

function parsed(json: string): ReadonlyMap<string, unknown> {
  return new Map(Object.entries(JSON.parse(json) as Record<string, unknown>));
}

describe("record value equality", () => {
  it("RelationshipIntegrity compares its hash by content", () => {
    const at = 0n;
    const a: RelationshipIntegrity = {
      keyId: "key1",
      hash: new Uint8Array([1, 2, 3]),
      hashedAt: at,
    };
    const b: RelationshipIntegrity = {
      keyId: "key1",
      hash: new Uint8Array([1, 2, 3]),
      hashedAt: at,
    };
    const c: RelationshipIntegrity = {
      keyId: "key1",
      hash: new Uint8Array([1, 2, 4]),
      hashedAt: at,
    };

    expect(relationshipIntegrityEquals(a, b)).toBe(true);
    expect(relationshipIntegrityEquals(a, c)).toBe(false);
    expect(relationshipIntegrityEquals(a, { ...a, keyId: "key2" })).toBe(false);
  });

  it("ContextualizedCaveat compares its context by content", () => {
    const a = caveat(
      "ip_allowed",
      ctx([
        ["cidr", "10.0.0.0/8"],
        ["limit", 3.0],
        ["tags", ["a", "b"]],
        ["nested", ctx([["x", true]])],
      ]),
    );
    const b = caveat(
      "ip_allowed",
      ctx([
        ["nested", ctx([["x", true]])],
        ["tags", ["a", "b"]],
        ["limit", 3.0],
        ["cidr", "10.0.0.0/8"],
      ]),
    );

    expect(contextualizedCaveatEquals(a, b)).toBe(true);
    expect(contextualizedCaveatEquals(a, { ...a, context: ctx([["cidr", "10.0.0.0/8"]]) })).toBe(
      false,
    );
    expect(contextualizedCaveatEquals(a, { ...b, caveatName: "other" })).toBe(false);
  });

  it("ContextualizedCaveat compares parsed JSON context by content", () => {
    const a = caveat("c", parsed(`{"n":1,"l":[1,2]}`));
    const b = caveat("c", parsed(`{"l":[1,2],"n":1}`));
    const c = caveat("c", parsed(`{"l":[2,1],"n":1}`));

    expect(contextualizedCaveatEquals(a, b)).toBe(true);
    expect(contextualizedCaveatEquals(a, c)).toBe(false);
  });

  it("ContextualizedCaveat without context still equals itself", () => {
    expect(contextualizedCaveatEquals(caveat("c"), caveat("c"))).toBe(true);
    // The record documents absent and empty alike as "no context".
    expect(contextualizedCaveatEquals(caveat("c"), caveat("c", ctx([])))).toBe(true);
    expect(contextualizedCaveatEquals(caveat("c"), caveat("c", ctx([["k", 1]])))).toBe(false);
  });

  it("CaveatTypeReference compares its child types by content", () => {
    const a = typeRef("map", [typeRef("list", [typeRef("int")])]);
    const b = typeRef("map", [typeRef("list", [typeRef("int")])]);
    const c = typeRef("map", [typeRef("list", [typeRef("string")])]);

    expect(caveatTypeReferenceEquals(a, b)).toBe(true);
    expect(caveatTypeReferenceEquals(a, c)).toBe(false);
    expect(caveatTypeReferenceEquals(typeRef("list"), typeRef("list", []))).toBe(false);
  });

  it("CaveatDefinition compares its expression and parameters by content", () => {
    const make = (expr: readonly number[], paramType: string): CaveatDefinition => ({
      name: "ip_allowed",
      serializedExpression: new Uint8Array(expr),
      parameterTypes: new Map([
        ["cidr", typeRef(paramType)],
        ["tags", typeRef("list", [typeRef("string")])],
      ]),
    });

    const a = make([7, 8], "string");
    const b = make([7, 8], "string");

    expect(caveatDefinitionEquals(a, b)).toBe(true);
    expect(caveatDefinitionEquals(a, make([7, 9], "string"))).toBe(false);
    expect(caveatDefinitionEquals(a, make([7, 8], "ipaddress"))).toBe(false);
  });

  it("Relationship equality follows its caveat and integrity content", () => {
    const resource: ObjectAndRelation = {
      objectType: "document",
      objectId: "readme",
      relation: "viewer",
    };
    const subject: ObjectAndRelation = {
      objectType: "user",
      objectId: "alice",
      relation: ELLIPSIS,
    };
    const make = (): Relationship =>
      createRelationship(resource, subject, caveat("c", ctx([["k", "v"]])), undefined, {
        keyId: "key",
        hash: new Uint8Array([1]),
        hashedAt: 0n,
      });

    expect(relationshipEquals(make(), make())).toBe(true);
  });

  function nestedContext(
    innerFlag: unknown,
    reverseInsertion: boolean,
  ): ReadonlyMap<string, unknown> {
    const nested = ctx([
      ["regions", ["eu", "us", 7, null]],
      ["flag", innerFlag],
    ]);
    const entries: (readonly [string, unknown])[] = [
      ["level", 7],
      ["name", "alice"],
      ["missing", null],
      ["nested", nested],
      ["tags", [ctx([["k", "v"]]), 1]],
    ];
    if (reverseInsertion) entries.reverse();
    return ctx(entries);
  }

  it("ContextualizedCaveat compares null members and maps inside lists by content", () => {
    const a = caveat("c", nestedContext(true, false));
    const b = caveat("c", nestedContext(true, true));

    expect(contextualizedCaveatEquals(a, b)).toBe(true);
  });

  it("ContextualizedCaveat differing only in a nested value is not equal", () => {
    const a = caveat("c", nestedContext(true, false));
    const b = caveat("c", nestedContext(false, false));
    const c = caveat("c", nestedContext(null, false));

    expect(contextualizedCaveatEquals(a, b)).toBe(false);
    expect(contextualizedCaveatEquals(a, c)).toBe(false);
  });

  it("ContextualizedCaveat does not equate an empty map with an empty list", () => {
    // A context is a protobuf Struct: {} (a struct) and [] (a list) are different values.
    const map = caveat("c", ctx([["x", new Map()]]));
    const list = caveat("c", ctx([["x", []]]));

    expect(contextualizedCaveatEquals(map, list)).toBe(false);
    expect(contextualizedCaveatEquals(list, map)).toBe(false);

    // The port's other map shape, a plain object, is held to the same rule.
    const objectMap = caveat("c", ctx([["x", {}]]));
    expect(contextualizedCaveatEquals(objectMap, list)).toBe(false);
    expect(contextualizedCaveatEquals(list, objectMap)).toBe(false);
  });

  it("CaveatDefinition equality ignores parameter insertion order and sees nested child types", () => {
    const make = (listElement: string, reverseInsertion: boolean): CaveatDefinition => {
      const entries: [string, CaveatTypeReference][] = [
        ["ip", typeRef("ipaddress")],
        ["allowed", typeRef("list", [typeRef(listElement)])],
        ["limits", typeRef("map", [typeRef("int")])],
      ];
      if (reverseInsertion) entries.reverse();
      return {
        name: "org/ip_allowed",
        serializedExpression: new Uint8Array([1, 2, 3, 4]),
        parameterTypes: new Map(entries),
      };
    };

    const a = make("string", false);
    const b = make("string", true);

    expect(caveatDefinitionEquals(a, b)).toBe(true);
    expect(caveatDefinitionEquals(a, make("int", false))).toBe(false);
  });
});
