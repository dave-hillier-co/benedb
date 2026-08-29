import { PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import type { CaveatExpression } from "@spacedb/engine/caveat-expression";
import { caveatExpressionFromCaveat } from "@spacedb/engine/caveat-expression";
import type { FoundSubject } from "@spacedb/engine/found-subject";
import { createFoundSubject } from "@spacedb/engine/found-subject";
import { describe, expect, it } from "vitest";

import { caveatFromWire, caveatToWire } from "./caveat-wire";
import { frontierSubjectFromWire, frontierSubjectToWire } from "./frontier-wire";

/**
 * Ported from `tests/Spiceport.Grains.Tests/FrontierWireRoundTripTests.cs`.
 *
 * `FrontierWire` round-trips the engine's `FoundSubject` tree (subject id, verbatim caveat
 * expression, wildcard flag, exclusions) through the serializable `FrontierSubjectWire` shape
 * unchanged, exactly as `CaveatWire` round-trips a bare `CaveatExpression`.
 *
 * SANCTIONED DIVERGENCE. The C# pins that a context value written as `18` comes back as an `int`
 * and one written as `3L` comes back as a `long` - a distinction the CLR's boxed `object?` carries
 * and JavaScript has no counterpart for. Caveat context in this port is JSON-shaped
 * (`ContextualizedCaveat.context` holds scalars, arrays and nested maps), so BOTH are plain
 * `number`s and the assertions below compare them as such. Nothing downstream reads the width:
 * CEL's numeric tower is entered at the caveat evaluator, not here.
 */
describe("frontier wire round trip", () => {
  it("round-trips a plain concrete subject with no caveat", () => {
    const subject = createFoundSubject("alice");

    const wire = frontierSubjectToWire(subject);
    const back = frontierSubjectFromWire(wire);

    expect(back.subjectId).toBe(subject.subjectId);
    expect(back.caveat).toBeUndefined();
    expect(back.isWildcard).toBe(false);
    // ABSENT, never `[]`: `SubjectSet.toFoundSubjects` emits no exclusions rather than an empty
    // list, and the two must stay distinguishable through the wire.
    expect(back.excludedSubjects).toBeUndefined();
  });

  it("round-trips a caveated wildcard with caveated exclusions and a nested expression tree", () => {
    // A nested And/Or/Not tree gating the wildcard itself.
    const wildcardCaveat: CaveatExpression = {
      kind: "or",
      children: [
        {
          kind: "and",
          children: [
            caveatExpressionFromCaveat({
              caveatName: "over_age",
              context: new Map<string, unknown>([["min_age", 18]]),
            }),
            { kind: "not", child: caveatExpressionFromCaveat({ caveatName: "banned" }) },
          ],
        },
        caveatExpressionFromCaveat({
          caveatName: "is_admin",
          context: new Map<string, unknown>([["level", 3]]),
        }),
      ],
    };

    const excluded: readonly FoundSubject[] = [
      createFoundSubject("frank", caveatExpressionFromCaveat({ caveatName: "blocked" })),
      createFoundSubject("james"), // unconditionally excluded.
    ];

    const subject = createFoundSubject(PUBLIC_WILDCARD, wildcardCaveat, true, excluded);

    const wire = frontierSubjectToWire(subject);
    const back = frontierSubjectFromWire(wire);

    expect(back.subjectId).toBe(PUBLIC_WILDCARD);
    expect(back.isWildcard).toBe(true);
    expect(back.excludedSubjects).toBeDefined();
    expect(back.excludedSubjects).toHaveLength(2);

    const excludedBack = back.excludedSubjects ?? [];
    expect(excludedBack[0]?.subjectId).toBe("frank");
    expect(excludedBack[0]?.caveat?.kind).toBe("leaf");
    expect(excludedBack[1]?.subjectId).toBe("james");
    expect(excludedBack[1]?.caveat).toBeUndefined();

    const roundTrippedOr = back.caveat;
    expect(roundTrippedOr?.kind).toBe("or");
    if (roundTrippedOr?.kind !== "or") throw new Error("expected an or node");
    expect(roundTrippedOr.children).toHaveLength(2);

    const and = roundTrippedOr.children[0];
    expect(and?.kind).toBe("and");
    if (and?.kind !== "and") throw new Error("expected an and node");

    const leaf1 = and.children[0];
    expect(leaf1?.kind).toBe("leaf");
    if (leaf1?.kind !== "leaf") throw new Error("expected a leaf node");
    expect(leaf1.caveat.caveatName).toBe("over_age");
    expect(leaf1.caveat.context?.get("min_age")).toBe(18);

    const not = and.children[1];
    expect(not?.kind).toBe("not");
    if (not?.kind !== "not") throw new Error("expected a not node");
    expect(not.child.kind).toBe("leaf");
    if (not.child.kind !== "leaf") throw new Error("expected a leaf node");
    expect(not.child.caveat.caveatName).toBe("banned");

    const leaf3 = roundTrippedOr.children[1];
    expect(leaf3?.kind).toBe("leaf");
    if (leaf3?.kind !== "leaf") throw new Error("expected a leaf node");
    expect(leaf3.caveat.caveatName).toBe("is_admin");
    expect(leaf3.caveat.context?.get("level")).toBe(3);
  });

  it("maps an absent caveat expression to an absent wire caveat in both directions", () => {
    expect(caveatToWire(undefined)).toBeUndefined();
    expect(caveatFromWire(undefined)).toBeUndefined();
  });

  it("round-trips each caveat node kind on its own", () => {
    const leaf = caveatExpressionFromCaveat({ caveatName: "solo" });
    const nodes: readonly CaveatExpression[] = [
      leaf,
      { kind: "or", children: [leaf] },
      { kind: "and", children: [leaf] },
      { kind: "not", child: leaf },
    ];

    for (const node of nodes) {
      expect(caveatFromWire(caveatToWire(node))).toEqual(node);
    }
  });

  it("throws on an unrecognised node kind arriving from the wire", () => {
    // The C# default arm throws `NotSupportedException` naming the node type; the port keeps the
    // THROWING assertNever there, because a node kind neither side knows is a wire-contract
    // break, never a tolerated default.
    const bogus = { kind: "xor", children: [] } as unknown as CaveatExpression;

    expect(() => caveatToWire(bogus)).toThrow();
  });
});
