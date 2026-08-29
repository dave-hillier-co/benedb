import { defineGrainInterface } from "@thresh/core/grain-interface";
import type { GrainKeyFor } from "@thresh/core/key-kinds";
import { describe, expect, it } from "vitest";

import {
  ICheckGrain,
  dispatchCheckReplyDepthRequired,
  type DispatchCheckReply,
} from "./i-check-grain";
import type { SerializedCaveat } from "./serialized-caveat";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/ICheckGrain.cs`, which has
// no covering C# test of its own. Two things live in that file and both are pinned here: the
// `DispatchCheckReply` DTO (whose `int DepthRequired = 1` default parameter has no TypeScript
// counterpart on an interface) and the grain interface itself.
//
// NOTHING HERE ACTIVATES A GRAIN. `ICheckGrain` is a declaration; `CheckGrain` is a later slice.

describe("DispatchCheckReply", () => {
  it("resolves the C#'s `DepthRequired = 1` default parameter through a named resolver", () => {
    // The C# is `int DepthRequired = 1`: a default PARAMETER, so a caller that omits it gets 1
    // while a caller that passes 0 gets 0. Porting it as a required field with a `1` literal at
    // every construction site, or as `depthRequired || 1`, both lose the explicit zero.
    const omitted: DispatchCheckReply = { member: true, cycleCut: false };
    const explicitZero: DispatchCheckReply = { member: true, cycleCut: false, depthRequired: 0 };
    const explicitThree: DispatchCheckReply = { member: true, cycleCut: false, depthRequired: 3 };

    expect(dispatchCheckReplyDepthRequired(omitted)).toBe(1);
    expect(dispatchCheckReplyDepthRequired(explicitZero)).toBe(0);
    expect(dispatchCheckReplyDepthRequired(explicitThree)).toBe(3);
  });

  it("carries the PRE-CONTEXT caveat as a SerializedCaveat, absent for unconditional results", () => {
    // The C#'s `SerializedCaveat? Caveat` is null for BOTH unconditional membership and
    // non-membership; the reply is the pre-context branch, never a collapsed verdict.
    const caveat: SerializedCaveat = { kind: "leaf", caveatName: "over18" };
    const caveated: DispatchCheckReply = { member: true, caveat, cycleCut: false };
    const unconditional: DispatchCheckReply = { member: true, cycleCut: false };

    expect(caveated.caveat).toBe(caveat);
    expect(unconditional.caveat).toBeUndefined();
  });

  it("keeps CycleCut independent of Member: the flag excludes from the memo, it is not a verdict", () => {
    // The C# remark is explicit that the dispatcher force-sets this flag on the RETURNED reply
    // purely so the result is excluded from the activation memo - the verdict itself is unaltered.
    const cut: DispatchCheckReply = { member: true, cycleCut: true };

    expect(cut.member).toBe(true);
    expect(cut.cycleCut).toBe(true);
  });
});

describe("ICheckGrain", () => {
  it("is both a type and a registered GrainInterface VALUE named for the C# interface", () => {
    // `getGrain(ICheckGrain, key)` dispatches through the value, so the type alone is not enough.
    expect(ICheckGrain.name).toBe("ICheckGrain");
    expect(ICheckGrain.id).toBe(defineGrainInterface<ICheckGrain>("ICheckGrain").id);
  });

  it("carries NO per-method invocation options: DispatchCheck has no Orleans method attribute", () => {
    // The C# `DispatchCheck` declares neither [AlwaysInterleave] nor [ReadOnly] nor [OneWay].
    // Adding one here would be an invention, not a port.
    expect(ICheckGrain.options).toEqual({});
  });

  it("is string-keyed, because the grain key IS the canonical sub-problem identity", () => {
    const key: GrainKeyFor<ICheckGrain> = "document/readme/view/user/alice/.../12345/hash-abc";

    expect(typeof key).toBe("string");
  });

  it("declares DispatchCheck as (signal?) => Promise<DispatchCheckReply>", () => {
    // The C# takes ONLY a CancellationToken: depth and the exact visited set ride ambiently in the
    // request context (see dispatch-context.ts), never in the signature. An implementation that
    // needs another argument has broken that design, and the excess-property check below is the
    // gate that says so.
    const reply: DispatchCheckReply = { member: false, cycleCut: false };
    const fake: ICheckGrain = {
      dispatchCheck: (_signal?: AbortSignal) => Promise.resolve(reply),
    };

    expect(Object.keys(fake)).toEqual(["dispatchCheck"]);
    return expect(fake.dispatchCheck(new AbortController().signal)).resolves.toEqual(reply);
  });
});
