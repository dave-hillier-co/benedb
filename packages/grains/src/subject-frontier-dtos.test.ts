import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import type { SerializedCaveat } from "./serialized-caveat";
import type { FrontierSubjectWire, SubjectFrontierReply } from "./subject-frontier-dtos";

// `src/Spiceport.Server/Grains.Abstractions/SubjectFrontierDtos.cs`.
//
// The covering C# test, `FrontierWireRoundTripTests`, reaches these types only THROUGH
// `FrontierWire` (a later batch); it is ported alongside that converter, not here. What this file
// pins is the DTOs' own contract, and in particular the one assertion the C# test makes that the
// shape alone has to guarantee: `Assert.Null(back.ExcludedSubjects)` on a plain subject. Absent and
// empty are DISTINCT here, so `excludedSubjects` must start life `undefined` - initialising it to
// `[]` for tidiness merges the two states and that assertion fails.
describe("FrontierSubjectWire", () => {
  it("leaves excludedSubjects ABSENT on a plain concrete subject", () => {
    const subject: FrontierSubjectWire = { subjectId: "alice", isWildcard: false };

    const back = deserializeValue<FrontierSubjectWire>(serializeValue(subject));

    expect(back.subjectId).toBe("alice");
    expect(back.isWildcard).toBe(false);
    expect(back.caveat).toBeUndefined();
    expect(back.excludedSubjects).toBeUndefined();
  });

  it("keeps an EMPTY exclusion list distinct from an absent one", () => {
    // A wildcard whose exclusions were all filtered out is not the same as a subject that never
    // had any - the same lazily-allocated-collection distinction the port keeps everywhere.
    const empty: FrontierSubjectWire = {
      subjectId: "*",
      isWildcard: true,
      excludedSubjects: [],
    };

    const back = deserializeValue<FrontierSubjectWire>(serializeValue(empty));

    expect(back.excludedSubjects).toEqual([]);
    expect(back.excludedSubjects).not.toBeUndefined();
  });

  it("carries the caveat VERBATIM as a SerializedCaveat tree, not a collapsed missing-fields list", () => {
    // This is the PRE-CONTEXT shape, unlike `FoundSubjectWire`: the memoized frontier is collapsed
    // per-request by the caller, so the caveat must survive as the engine's own expression tree.
    const caveat: SerializedCaveat = {
      kind: "or",
      children: [
        {
          kind: "and",
          children: [
            {
              kind: "leaf",
              caveatName: "over_age",
              context: new Map<string, unknown>([["min_age", 18]]),
            },
            { kind: "not", child: { kind: "leaf", caveatName: "banned" } },
          ],
        },
        {
          kind: "leaf",
          caveatName: "is_admin",
          context: new Map<string, unknown>([["level", 3]]),
        },
      ],
    };
    const subject: FrontierSubjectWire = { subjectId: "*", caveat, isWildcard: true };

    const back = deserializeValue<FrontierSubjectWire>(serializeValue(subject));

    expect(back.caveat).toEqual(caveat);
  });

  it("is recursive through excludedSubjects, each exclusion carrying its own caveat or none", () => {
    const subject: FrontierSubjectWire = {
      subjectId: "*",
      isWildcard: true,
      excludedSubjects: [
        { subjectId: "frank", caveat: { kind: "leaf", caveatName: "blocked" }, isWildcard: false },
        // Unconditionally excluded.
        { subjectId: "james", isWildcard: false },
      ],
    };

    const back = deserializeValue<FrontierSubjectWire>(serializeValue(subject));

    expect(back.excludedSubjects).toHaveLength(2);
    expect(back.excludedSubjects?.[0]?.subjectId).toBe("frank");
    expect(back.excludedSubjects?.[0]?.caveat?.kind).toBe("leaf");
    expect(back.excludedSubjects?.[1]?.subjectId).toBe("james");
    expect(back.excludedSubjects?.[1]?.caveat).toBeUndefined();
    // Wildcard exclusions are carried IN FULL here; `ReverseOps` drops them at the client edge,
    // where `FoundSubjectWire` still has no excluded-subjects field at all.
    expect(back.excludedSubjects?.[0]?.excludedSubjects).toBeUndefined();
  });
});

describe("SubjectFrontierReply", () => {
  it("carries every subject the full walk found, in the engine's own walk order", () => {
    // Order is observable: the reply is the whole memoized frontier and the caller pages over it,
    // so a reordering would change which subjects a limited stream returns.
    const reply: SubjectFrontierReply = {
      subjects: [
        { subjectId: "zeta", isWildcard: false },
        { subjectId: "alpha", isWildcard: false },
      ],
    };

    const back = deserializeValue<SubjectFrontierReply>(serializeValue(reply));

    expect(back.subjects.map((s) => s.subjectId)).toEqual(["zeta", "alpha"]);
  });

  it("round trips an empty frontier as an empty list", () => {
    expect(
      deserializeValue<SubjectFrontierReply>(serializeValue({ subjects: [] })).subjects,
    ).toEqual([]);
  });
});
