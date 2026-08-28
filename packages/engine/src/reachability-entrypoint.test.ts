import { describe, expect, it } from "vitest";

import {
  createReachabilityEntrypoint,
  isDirectResult,
  type EntrypointResultStatus,
  type ReachabilityEntrypoint,
  type ReachabilityEntrypointKind,
} from "./reachability-entrypoint";
import type { RelationReference } from "./relation-reference";

// Characterization of Spiceport `Engine/Reachability/ReachabilityEntrypoint.cs`. No C# test
// covers it: it is a record plus two enums, exercised only through `ReachabilityGraph` and,
// three stages up, the schema-introspection RPCs.
//
// Port decisions pinned here:
//
//   * BOTH enums mirror SpiceDB proto enum CONCEPTS but carry no explicit numeric values in the
//     C#, and nothing in this layer serializes them. They are therefore string-literal unions
//     with NO wire map. `ReachabilityGraph`'s internal dedup key is the only thing that ever read
//     their numbers; that key is private to the graph, so its text changing is fine.
//
//   * The C# record has FIVE constructor parameters, three of them with defaults. Under
//     `exactOptionalPropertyTypes` the two optional strings become `?: string | undefined` and
//     the defaulted `ResultStatus` is applied by the factory with `??`, so an explicitly passed
//     value survives - including a future value that happens to be falsy.
//
//   * `TargetRelation` and `ContainingRelation` are always given the SAME value in this two-level
//     model (the C# doc comment says so), but both fields are kept because call sites read both.
//
//   * `IsDirectResult` is a computed property on the record, so it becomes a free function.

const target: RelationReference = { namespace: "document", relation: "view" };

describe("createReachabilityEntrypoint", () => {
  it("defaults the result status to conditional", () => {
    const entrypoint = createReachabilityEntrypoint({
      kind: "relation",
      targetRelation: target,
      containingRelation: target,
    });

    expect(entrypoint.resultStatus).toBe("conditionalResult");
  });

  it("leaves the two optional relation names absent by default", () => {
    const entrypoint = createReachabilityEntrypoint({
      kind: "relation",
      targetRelation: target,
      containingRelation: target,
    });

    expect(entrypoint.computedUsersetRelation).toBeUndefined();
    expect(entrypoint.tuplesetRelation).toBeUndefined();
  });

  it("keeps an explicitly supplied result status", () => {
    const entrypoint = createReachabilityEntrypoint({
      kind: "computedUserset",
      targetRelation: target,
      containingRelation: target,
      computedUsersetRelation: "viewer",
      resultStatus: "directResult",
    });

    expect(entrypoint.resultStatus).toBe("directResult");
  });

  it("carries the tupleset and computed relations of an arrow edge", () => {
    const entrypoint = createReachabilityEntrypoint({
      kind: "tupleToUserset",
      targetRelation: target,
      containingRelation: target,
      computedUsersetRelation: "view",
      tuplesetRelation: "parent",
      resultStatus: "directResult",
    });

    expect(entrypoint).toEqual({
      kind: "tupleToUserset",
      targetRelation: target,
      containingRelation: target,
      computedUsersetRelation: "view",
      tuplesetRelation: "parent",
      resultStatus: "directResult",
    } satisfies ReachabilityEntrypoint);
  });

  it("keeps the target and containing relations as separate fields", () => {
    // They are the same value in this two-level model, but the record declares both and callers
    // read both, so the port does not collapse them.
    const containing: RelationReference = { namespace: "document", relation: "viewer" };
    const entrypoint = createReachabilityEntrypoint({
      kind: "relation",
      targetRelation: target,
      containingRelation: containing,
    });

    expect(entrypoint.targetRelation).toEqual(target);
    expect(entrypoint.containingRelation).toEqual(containing);
  });
});

describe("isDirectResult", () => {
  it("is true only for a direct result", () => {
    const direct = createReachabilityEntrypoint({
      kind: "relation",
      targetRelation: target,
      containingRelation: target,
      resultStatus: "directResult",
    });
    const conditional = createReachabilityEntrypoint({
      kind: "relation",
      targetRelation: target,
      containingRelation: target,
      resultStatus: "conditionalResult",
    });

    expect(isDirectResult(direct)).toBe(true);
    expect(isDirectResult(conditional)).toBe(false);
  });
});

describe("the enum unions", () => {
  it("names the four entrypoint kinds", () => {
    const kinds: readonly ReachabilityEntrypointKind[] = [
      "relation",
      "computedUserset",
      "tupleToUserset",
      "self",
    ];
    expect(new Set(kinds).size).toBe(4);
  });

  it("names the two result statuses", () => {
    const statuses: readonly EntrypointResultStatus[] = ["directResult", "conditionalResult"];
    expect(new Set(statuses).size).toBe(2);
  });
});
