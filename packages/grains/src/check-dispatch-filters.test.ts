import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { MaxDepthExceededException } from "@spacedb/core/max-depth-exceeded-exception";
import { RejectionError } from "@thresh/core/errors";
import type { IncomingGrainCallContext } from "@thresh/core/grain-call-filter";
import { RequestContext } from "@thresh/core/request-context";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createCheckDispatchIncomingCallFilter,
  createCheckDispatchOutgoingCallFilter,
  matchesCheckDispatch,
} from "./check-dispatch-filters";
import { setDispatchContext } from "./dispatch-context";
import { DispatchFailedException } from "./dispatch-failed-exception";
import {
  fakeIncomingGrainCallContext,
  fakeOutgoingGrainCallContext,
} from "./fake-grain-call-contexts.test";
import { DispatchMetrics } from "./i-dispatch-metrics";
import { ICheckGrain } from "./i-check-grain";

// CHARACTERIZATION test for `src/Spiceport.Server/Grains/CheckDispatchFilters.cs`, alongside the
// four directly-drivable cases the C# test file itself has (ported in
// `check-dispatch-filters-tests.test.ts`). Everything else the C# has is a mesh test, so this file
// carries the invariants the mesh would otherwise be the only witness to.
//
// THE MATCH IS THE WHOLE FILTER. C# matches by reflection
// (`method.DeclaringType == typeof(ICheckGrain) && method.Name == nameof(ICheckGrain.DispatchCheck)`);
// Thresh gives `interfaceName` / `methodName` strings instead, and the TypeScript method spelling is
// `dispatchCheck` with a LOWERCASE d. Getting the casing wrong makes BOTH filters silent no-ops on
// every call in the mesh - no type check catches it, and the only symptom is a missing depth guard.
//
// THE INCOMING ORDER IS LOAD-BEARING, and the mesh metrics tests assert the counts it produces:
//   (1) match, (2) metrics?.RecordDispatch() - for EVERY matched call, so a REJECTED call is still
//   counted, (3) if (RequireDepthRemaining() <= 0) throw MaxDepthExceededException, (4) invoke().
// Moving (2) after (3) changes the count; moving (3) after (4) defeats the guard entirely, since
// the grain body (its activation-memo lookup and graph expansion) would already have run.

const OTHER_METHOD = { interfaceName: "IRelationshipsGrain", methodName: "writeSchema" };

beforeEach(() => {
  RequestContext.clear();
});

describe("matchesCheckDispatch", () => {
  it("matches the ICheckGrain.dispatchCheck identity, derived from the interface definition", () => {
    expect(ICheckGrain.name).toBe("ICheckGrain");
    expect(
      matchesCheckDispatch({ interfaceName: ICheckGrain.name, methodName: "dispatchCheck" }),
    ).toBe(true);
  });

  it("does NOT match the C# method spelling - the TypeScript member is lowercase-d", () => {
    expect(
      matchesCheckDispatch({ interfaceName: "ICheckGrain", methodName: "DispatchCheck" }),
    ).toBe(false);
  });

  it("does not match another interface's method of the same name", () => {
    expect(
      matchesCheckDispatch({ interfaceName: "ICheckGrainV2", methodName: "dispatchCheck" }),
    ).toBe(false);
  });

  it("does not match another method on ICheckGrain", () => {
    expect(matchesCheckDispatch({ interfaceName: "ICheckGrain", methodName: "getKey" })).toBe(
      false,
    );
  });

  it("does not match an unrelated grain call", () => {
    expect(matchesCheckDispatch(OTHER_METHOD)).toBe(false);
  });
});

describe("CheckDispatchOutgoingCallFilter", () => {
  it("passes a NON-matching call straight through, doing nothing at all", async () => {
    // "if it does not match: await invoke(); return" - every other grain call in the mesh takes
    // this branch, so it must add no behaviour whatsoever.
    let invoked = 0;
    const filter = createCheckDispatchOutgoingCallFilter();
    const context = fakeOutgoingGrainCallContext(async () => {
      invoked += 1;
    }, OTHER_METHOD);

    await filter(context);

    expect(invoked).toBe(1);
  });

  it("invokes a matching call and returns normally when it succeeds", async () => {
    let invoked = 0;
    const filter = createCheckDispatchOutgoingCallFilter();
    const context = fakeOutgoingGrainCallContext(async () => {
      invoked += 1;
    });

    await filter(context);

    expect(invoked).toBe(1);
  });

  it("translates a rejected call into a retriable DispatchFailedException", async () => {
    // Thresh's RejectionError is the refused-call/silo-unavailable family; the mapper classifies it
    // as the retriable `unavailable`, matching SpiceDB's remote-cluster boundary behaviour.
    const filter = createCheckDispatchOutgoingCallFilter();
    const context = fakeOutgoingGrainCallContext(async () => {
      throw new RejectionError("no compatible silo", "noCandidates");
    });

    const error: unknown = await filter(context).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(DispatchFailedException);
    expect((error as DispatchFailedException).code).toBe("unavailable");
  });

  it("collapses an unexpected failure to internal, never to a retriable code", async () => {
    // A programming fault must not be reported as retriable, or a client retries a bug forever.
    const filter = createCheckDispatchOutgoingCallFilter();
    const context = fakeOutgoingGrainCallContext(async () => {
      throw new TypeError("undefined is not a function");
    });

    const error: unknown = await filter(context).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(DispatchFailedException);
    expect((error as DispatchFailedException).code).toBe("internal");
  });

  it("keeps an already-classified DispatchFailedException from a deeper hop unchanged", async () => {
    // Otherwise its code would be re-collapsed at every hop up the recursion.
    const inner = new DispatchFailedException("cancelled", "the permission check was cancelled");
    const filter = createCheckDispatchOutgoingCallFilter();
    const context = fakeOutgoingGrainCallContext(async () => {
      throw inner;
    });

    await expect(filter(context)).rejects.toBe(inner);
  });

  it("rejects a missing context - the C#'s ArgumentNullException.ThrowIfNull(context)", async () => {
    const filter = createCheckDispatchOutgoingCallFilter();

    await expect(filter(undefined as unknown as IncomingGrainCallContext)).rejects.toThrow(
      InvalidArgumentError,
    );
  });
});

describe("CheckDispatchIncomingCallFilter", () => {
  it("passes a NON-matching call through without reading the dispatch context at all", async () => {
    // The ambient context is deliberately unset: any other grain call in the mesh reaches this
    // filter without one, so touching requireDepthRemaining before the match check would make every
    // unrelated call throw.
    let invoked = 0;
    const metrics = new DispatchMetrics();
    const filter = createCheckDispatchIncomingCallFilter(metrics);
    const context = fakeIncomingGrainCallContext(async () => {
      invoked += 1;
    }, OTHER_METHOD);

    await filter(context);

    expect(invoked).toBe(1);
    expect(metrics.snapshot().dispatch).toBe(0);
  });

  it("counts one dispatch hop per matched call and lets a budgeted call through", async () => {
    let invoked = 0;
    const metrics = new DispatchMetrics();
    const filter = createCheckDispatchIncomingCallFilter(metrics);
    setDispatchContext(5, []);

    await filter(
      fakeIncomingGrainCallContext(async () => {
        invoked += 1;
      }),
    );

    expect(invoked).toBe(1);
    expect(metrics.snapshot().dispatch).toBe(1);
  });

  it("rejects an already-exhausted call with MaxDepthExceededException before the grain body runs", async () => {
    // DepthRemaining = 0: no activation-memo lookup, no relation-graph expansion.
    let invoked = 0;
    const filter = createCheckDispatchIncomingCallFilter();
    setDispatchContext(0, []);

    await expect(
      filter(
        fakeIncomingGrainCallContext(async () => {
          invoked += 1;
        }),
      ),
    ).rejects.toThrow(MaxDepthExceededException);
    expect(invoked).toBe(0);
  });

  it("still counts the boundary crossing of a REJECTED call - the metric precedes the guard", async () => {
    // This is the mesh test's assertion (a rejected call records Dispatch = 1 while MemoHit and
    // MemoMiss stay 0) observed from the filter's own side, since the grain body it would have run
    // does not exist yet.
    const metrics = new DispatchMetrics();
    const filter = createCheckDispatchIncomingCallFilter(metrics);
    setDispatchContext(0, []);

    await expect(filter(fakeIncomingGrainCallContext())).rejects.toThrow(MaxDepthExceededException);

    expect(metrics.snapshot().dispatch).toBe(1);
    expect(metrics.snapshot().memoHit).toBe(0);
    expect(metrics.snapshot().memoMiss).toBe(0);
  });

  it("rejects a NEGATIVE remaining budget too - the guard is `<= 0`, not `=== 0`", async () => {
    const filter = createCheckDispatchIncomingCallFilter();
    setDispatchContext(-1, []);

    await expect(filter(fakeIncomingGrainCallContext())).rejects.toThrow(MaxDepthExceededException);
  });

  it("admits the smallest positive budget", async () => {
    let invoked = 0;
    const filter = createCheckDispatchIncomingCallFilter();
    setDispatchContext(1, []);

    await filter(
      fakeIncomingGrainCallContext(async () => {
        invoked += 1;
      }),
    );

    expect(invoked).toBe(1);
  });

  it("works with NO metrics sink - the C# dependency is optional", async () => {
    let invoked = 0;
    const filter = createCheckDispatchIncomingCallFilter();
    setDispatchContext(3, []);

    await filter(
      fakeIncomingGrainCallContext(async () => {
        invoked += 1;
      }),
    );

    expect(invoked).toBe(1);
  });

  it("lets the grain body's own failure propagate unchanged - only the OUTGOING side translates", async () => {
    const failure = new RejectionError("grain body refused", "noActivation");
    const filter = createCheckDispatchIncomingCallFilter();
    setDispatchContext(3, []);

    await expect(
      filter(
        fakeIncomingGrainCallContext(async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
  });

  it("rejects a missing context - the C#'s ArgumentNullException.ThrowIfNull(context)", async () => {
    const filter = createCheckDispatchIncomingCallFilter();

    await expect(filter(undefined as unknown as IncomingGrainCallContext)).rejects.toThrow(
      InvalidArgumentError,
    );
  });
});
