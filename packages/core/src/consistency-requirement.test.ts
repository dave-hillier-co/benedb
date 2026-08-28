import { describe, expect, it } from "vitest";

import {
  FULLY_CONSISTENT,
  MINIMIZE_LATENCY,
  atExactSnapshot,
  atLeastAsFresh,
  type ConsistencyRequirement,
} from "./consistency-requirement";
import { InvalidArgumentError } from "./invalid-argument-error";
import type { ZedToken } from "./zed-token";

// Characterization of Spiceport `ConsistencyRequirement` (no covering C# test).
//
// Port decisions pinned here:
//
// 1. An abstract record with a PRIVATE constructor and four nested sealed variants is exactly the
//    closed hierarchy the house rules turn into a discriminated union with a literal `kind`, plus
//    a local `assertNever` at every match site. The private constructor means the C# set of four
//    is closed; the union keeps that.
//
// 2. `MinimizeLatency` and `FullyConsistent` are static singleton PROPERTIES in C#, so a caller
//    may legitimately compare by reference. The port exports frozen module-level SINGLETONS, not
//    factory functions - a factory would hand out fresh objects and quietly break any identity
//    comparison, and would also let a caller mutate a shared default.
//
// 3. `AtLeastAsFresh` / `AtExactSnapshot` throw `ArgumentNullException` on a null token. The
//    guard is kept (as `InvalidArgumentError`, this port's stand-in): a missing token here would
//    otherwise surface much later as a corrupt read or a null deref inside the resolver.
//
// The SEMANTICS - max(token, optimized) for at-least-as-fresh, exact pinning for
// at-exact-snapshot - live in `RevisionResolver` (a later stage). This file only carries the
// union, so this test asserts shape and construction only.

const token: ZedToken = { token: "djEKZHMtMQo0MgpzaGEtYWJj" };

function assertNever(value: never): never {
  throw new Error(`unexpected consistency requirement: ${JSON.stringify(value)}`);
}

/** A stand-in for every downstream match site, proving the union is exhaustive over four kinds. */
function describeRequirement(requirement: ConsistencyRequirement): string {
  switch (requirement.kind) {
    case "minimizeLatency":
      return "minimize";
    case "fullyConsistent":
      return "full";
    case "atLeastAsFresh":
      return `fresh:${requirement.token.token}`;
    case "atExactSnapshot":
      return `exact:${requirement.token.token}`;
    default:
      return assertNever(requirement);
  }
}

describe("consistency requirement", () => {
  describe("the singletons", () => {
    it("tags minimize-latency, the default mode", () => {
      expect(MINIMIZE_LATENCY.kind).toBe("minimizeLatency");
    });

    it("tags fully-consistent", () => {
      expect(FULLY_CONSISTENT.kind).toBe("fullyConsistent");
    });

    it("are frozen, since they are shared across every request", () => {
      expect(Object.isFrozen(MINIMIZE_LATENCY)).toBe(true);
      expect(Object.isFrozen(FULLY_CONSISTENT)).toBe(true);
    });

    it("are distinct from each other", () => {
      expect(MINIMIZE_LATENCY).not.toBe(FULLY_CONSISTENT);
    });
  });

  describe("atLeastAsFresh", () => {
    it("carries the floor token", () => {
      const requirement = atLeastAsFresh(token);

      expect(requirement.kind).toBe("atLeastAsFresh");
      expect(requirement.token).toBe(token);
    });

    it("rejects a missing token", () => {
      expect(() => atLeastAsFresh(undefined as unknown as ZedToken)).toThrow(InvalidArgumentError);
    });
  });

  describe("atExactSnapshot", () => {
    it("carries the exact token", () => {
      const requirement = atExactSnapshot(token);

      expect(requirement.kind).toBe("atExactSnapshot");
      expect(requirement.token).toBe(token);
    });

    it("rejects a missing token", () => {
      expect(() => atExactSnapshot(undefined as unknown as ZedToken)).toThrow(InvalidArgumentError);
    });

    it("is a different kind from atLeastAsFresh even with the same token", () => {
      expect(atExactSnapshot(token).kind).not.toBe(atLeastAsFresh(token).kind);
    });
  });

  it("matches exhaustively over exactly four kinds", () => {
    const all: ConsistencyRequirement[] = [
      MINIMIZE_LATENCY,
      FULLY_CONSISTENT,
      atLeastAsFresh(token),
      atExactSnapshot(token),
    ];

    expect(all.map(describeRequirement)).toEqual([
      "minimize",
      "full",
      `fresh:${token.token}`,
      `exact:${token.token}`,
    ]);
    expect(new Set(all.map((r) => r.kind)).size).toBe(4);
  });
});
