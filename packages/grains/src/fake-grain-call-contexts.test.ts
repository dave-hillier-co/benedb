import type { GrainCallContext, IncomingGrainCallContext } from "@thresh/core/grain-call-filter";
import { GrainId } from "@thresh/core/grain-id";
import { describe, expect, it } from "vitest";

import { ICheckGrain } from "./i-check-grain";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/FakeGrainCallContexts.cs`.
 *
 * Minimal grain-call-context fakes for driving the two check-dispatch filters directly, with no
 * silo and no real grain call. Only the method identity and `invoke` are read by the filters under
 * test.
 *
 * PORT NOTE. The C# fakes implement Orleans' `IOutgoingGrainCallContext` /
 * `IIncomingGrainCallContext`, whose method identity is a reflected `MethodInfo` (the filters match
 * on `method.DeclaringType == typeof(ICheckGrain) && method.Name == nameof(DispatchCheck)`).
 * Thresh's `GrainCallContext` carries `interfaceName` / `methodName` STRINGS instead, so the
 * default identity here is `ICheckGrain.name` plus the TypeScript method spelling `"dispatchCheck"`
 * - lowercase `d`, not the C# `"DispatchCheck"`. `interfaceMethod`-typed parameters therefore
 * become the two strings.
 *
 * The C# members it never reads throw `NotSupportedException` if touched; the port keeps that for
 * `grain`, and gives the plain data members ordinary values (Thresh's context is an interface of
 * fields, not of throwing properties).
 *
 * It lives in a `.test.ts` file (per the port ledger) because it is test-only: nothing in the
 * shipped grains package may import it.
 */
export interface FakeGrainCallIdentity {
  /** The interface the filter sees as the target of this call. */
  readonly interfaceName?: string;
  /** The method the filter sees as the target of this call. */
  readonly methodName?: string;
}

/** The method identity both fakes default to: `ICheckGrain.dispatchCheck`. */
export const FAKE_CHECK_GRAIN_IDENTITY: Required<FakeGrainCallIdentity> = Object.freeze({
  interfaceName: ICheckGrain.name,
  methodName: "dispatchCheck",
});

function baseContext(identity: FakeGrainCallIdentity): Omit<GrainCallContext, "invoke"> {
  return {
    target: new GrainId("CheckGrain", "fake-key"),
    source: undefined,
    interfaceId: ICheckGrain.id,
    interfaceName: identity.interfaceName ?? FAKE_CHECK_GRAIN_IDENTITY.interfaceName,
    methodName: identity.methodName ?? FAKE_CHECK_GRAIN_IDENTITY.methodName,
    args: [],
    result: undefined,
    headers: {},
  };
}

/**
 * A fake OUTGOING call whose body is `invoke`: throw from it to simulate a faulted grain call, or
 * complete normally.
 */
export function fakeOutgoingGrainCallContext(
  invoke: () => Promise<void>,
  identity: FakeGrainCallIdentity = {},
): GrainCallContext {
  return { ...baseContext(identity), invoke };
}

/**
 * A fake INCOMING call whose body is `invoke` (the grain-body stand-in, completing normally unless
 * the filter rejects the call first).
 */
export function fakeIncomingGrainCallContext(
  invoke: () => Promise<void> = async () => {},
  identity: FakeGrainCallIdentity = {},
): IncomingGrainCallContext {
  return {
    ...baseContext(identity),
    invoke,
    // The C# fake throws NotSupportedException from `Grain`: the filters never read it, and a test
    // that starts to must supply a real one rather than silently observing a stub.
    get grain(): object {
      throw new Error("FakeIncomingGrainCallContext.grain is not supported");
    },
  };
}

describe("fake grain call contexts", () => {
  it("defaults to the ICheckGrain.dispatchCheck identity the filters match on", () => {
    const outgoing = fakeOutgoingGrainCallContext(async () => {});
    const incoming = fakeIncomingGrainCallContext();

    expect(outgoing.interfaceName).toBe("ICheckGrain");
    expect(outgoing.methodName).toBe("dispatchCheck");
    expect(incoming.interfaceName).toBe("ICheckGrain");
    expect(incoming.methodName).toBe("dispatchCheck");
  });

  it("lets a caller name a different method, standing in for the C#'s interfaceMethod override", () => {
    const context = fakeOutgoingGrainCallContext(async () => {}, {
      interfaceName: "IRelationshipsGrain",
      methodName: "writeSchema",
    });

    expect(context.interfaceName).toBe("IRelationshipsGrain");
    expect(context.methodName).toBe("writeSchema");
  });

  it("runs the supplied body when the filter proceeds", async () => {
    let ran = 0;
    const context = fakeIncomingGrainCallContext(async () => {
      ran += 1;
    });

    await context.invoke();

    expect(ran).toBe(1);
  });

  it("throws if a filter reads the incoming context's grain instance", () => {
    expect(() => fakeIncomingGrainCallContext().grain).toThrow(/not supported/);
  });
});
