import {
  MINIMIZE_LATENCY,
  type AtExactSnapshotRequirement,
  type AtLeastAsFreshRequirement,
} from "@spacedb/core/consistency-requirement";
import { atLeastAsFresh } from "@spacedb/core/consistency-requirement";
import type { ZedToken } from "@spacedb/core/zed-token";
import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import {
  consistencyWireFromRequirement,
  consistencyWireToRequirement,
  ConsistencyTokenRequiredError,
  FULLY_CONSISTENT_WIRE,
  MINIMIZE_LATENCY_WIRE,
  type ConsistencyWire,
} from "./consistency-wire";

// Port of `tests/Spiceport.Grains.Tests/ConsistencyWireSerializationTests.cs`.
//
// The C# proves two things: the [GenerateSerializer] DTO survives the Orleans serializer (so it can
// be carried across grain calls), and it maps losslessly to and from the domain requirement. The
// serializer half becomes a round trip through Thresh's value codec - the plain readonly interface
// needs no attribute and no surrogate, so what is left to prove is only that the codec rebuilds an
// equal value.
//
// `Assert.Equal(wire, back)` is C# RECORD equality, i.e. structural - so it stays `toEqual`, never
// `toBe`. That matters: `MINIMIZE_LATENCY_WIRE` is a frozen singleton and the codec necessarily
// hands back a fresh plain object, so a reference assertion here would fail for a reason the C#
// never had.
describe("ConsistencyWire round trips through the value codec", () => {
  const cases: readonly (readonly [string, ConsistencyWire])[] = [
    ["minimize-latency singleton", MINIMIZE_LATENCY_WIRE],
    ["fully-consistent", { mode: "fullyConsistent" }],
    ["at-least-as-fresh", { mode: "atLeastAsFresh", token: "tok-fresh" }],
    ["at-exact-snapshot", { mode: "atExactSnapshot", token: "tok-exact" }],
  ];

  it.each(cases)("preserves the value: %s", (_name, wire) => {
    const back = deserializeValue<ConsistencyWire>(serializeValue(wire));

    expect(back).toEqual(wire);
  });
});

describe("ConsistencyWire maps to and from the domain requirement", () => {
  const token: ZedToken = { token: "the-token" };

  it("maps each mode onto its domain requirement", () => {
    expect(consistencyWireToRequirement(MINIMIZE_LATENCY_WIRE).kind).toBe("minimizeLatency");
    expect(consistencyWireToRequirement({ mode: "fullyConsistent" }).kind).toBe("fullyConsistent");

    const atLeast = consistencyWireToRequirement({
      mode: "atLeastAsFresh",
      token: token.token,
    }) as AtLeastAsFreshRequirement;
    expect(atLeast.token).toEqual(token);

    const atExact = consistencyWireToRequirement({
      mode: "atExactSnapshot",
      token: token.token,
    }) as AtExactSnapshotRequirement;
    expect(atExact.token).toEqual(token);
  });

  it("round trips a token-carrying requirement back through fromRequirement", () => {
    expect(consistencyWireFromRequirement(atLeastAsFresh(token))).toEqual({
      mode: "atLeastAsFresh",
      token: token.token,
    });
  });
});

// Characterization beyond the C# test: the two static singletons and the asymmetry between them.
// `ConsistencyWire.MinimizeLatency` / `FullyConsistent` are `static ... { get; }` properties, so
// they are frozen module constants here rather than factory functions (the port guide's
// static-singleton row), and `FromRequirement` deliberately returns the SHARED MinimizeLatency
// instance for the minimize case while allocating a FRESH object for the fully-consistent case.
// That asymmetry is transliterated literally rather than tidied into one shape.
describe("the ConsistencyWire singletons", () => {
  it("exposes minimize-latency and fully-consistent as frozen constants", () => {
    expect(MINIMIZE_LATENCY_WIRE).toEqual({ mode: "minimizeLatency" });
    expect(FULLY_CONSISTENT_WIRE).toEqual({ mode: "fullyConsistent" });
    expect(Object.isFrozen(MINIMIZE_LATENCY_WIRE)).toBe(true);
    expect(Object.isFrozen(FULLY_CONSISTENT_WIRE)).toBe(true);
  });

  it("returns the SAME minimize-latency instance, but a fresh fully-consistent one", () => {
    expect(consistencyWireFromRequirement(MINIMIZE_LATENCY)).toBe(MINIMIZE_LATENCY_WIRE);

    const fully = consistencyWireFromRequirement({ kind: "fullyConsistent" });
    expect(fully).toEqual(FULLY_CONSISTENT_WIRE);
    expect(fully).not.toBe(FULLY_CONSISTENT_WIRE);
  });
});

// `RequireToken` throws `InvalidOperationException` when a token-bearing mode carries no token.
// The port names the error for the invariant it protects and keeps the message text, which
// interpolates the mode (in its ported spelling - the enum member names do not survive the move to
// a string-literal union).
describe("a token-bearing mode with no token", () => {
  it.each([["atLeastAsFresh"], ["atExactSnapshot"]] as const)("throws for mode %s", (mode) => {
    expect(() => consistencyWireToRequirement({ mode })).toThrow(ConsistencyTokenRequiredError);
    expect(() => consistencyWireToRequirement({ mode })).toThrow(
      `consistency mode ${mode} requires a token`,
    );
  });

  it("treats an explicitly undefined token the same as an absent one", () => {
    expect(() =>
      consistencyWireToRequirement({ mode: "atLeastAsFresh", token: undefined }),
    ).toThrow(ConsistencyTokenRequiredError);
  });

  // The C# `RequireToken` guards `Token ?? throw`, so an EMPTY token is a legal token: only null
  // trips the guard. Keeping that distinction matters because "" is what an unset proto string
  // field arrives as, and turning it into a throw here would reject requests the C# accepted.
  it("accepts an empty token string, which is not null", () => {
    const requirement = consistencyWireToRequirement({
      mode: "atLeastAsFresh",
      token: "",
    }) as AtLeastAsFreshRequirement;

    expect(requirement.token).toEqual({ token: "" });
  });
});
