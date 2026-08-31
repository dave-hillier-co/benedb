import { MaxDepthExceededException } from "@benedb/core/max-depth-exceeded-exception";
import { GrainCallTimeoutError } from "@thresh/core/errors";
import { RequestContext } from "@thresh/core/request-context";
import { describe, expect, it } from "vitest";

import {
  createCheckDispatchIncomingCallFilter,
  createCheckDispatchOutgoingCallFilter,
} from "./check-dispatch-filters";
import { DispatchFailedException } from "./dispatch-failed-exception";
import { MissingDispatchContextError } from "./dispatch-context";
import {
  fakeIncomingGrainCallContext,
  fakeOutgoingGrainCallContext,
} from "./fake-grain-call-contexts.test";

// Ported from Spiceport `tests/Spiceport.Grains.Tests/CheckDispatchFiltersTests.cs`.
//
// The file's first two cases -
//   * Mid_recursion_depth_exhaustion_still_surfaces_MaxDepthExceededException
//   * Incoming_filter_rejects_an_already_exhausted_call_before_the_grain_body_runs
// - are MESH tests: they build a TestCluster and need the grain implementations (CheckGrain and
// friends) that this slice deliberately does not have. They land with the mesh suites in the next
// slice; the second one's assertions (a rejected call still counts one Dispatch hop, and records
// NO memo hit or miss because the grain body never ran) are re-derived here from the filter's own
// side in `check-dispatch-filters.test.ts`.
//
// The four cases below are the ones the C# itself drives DIRECTLY against the filters, with no
// cluster, so they port as they stand.
//
// SUBSTITUTION. C#'s `TimeoutException` - the transport failure the mapped branch is provoked with
// - has no counterpart name in Thresh; `GrainCallTimeoutError` is the type `translateDispatchError`
// classifies as the same retriable transport failure (see `dispatch-error-mapper.ts`). A bare
// `Error` would NOT do: it classifies as `internal`, not `unavailable`.
describe("CheckDispatchOutgoingCallFilter, driven directly", () => {
  it("collapses a mapped non-domain exception into DispatchFailedException", async () => {
    const filter = createCheckDispatchOutgoingCallFilter();
    const context = fakeOutgoingGrainCallContext(async () => {
      throw new GrainCallTimeoutError("response timed out");
    });

    const error: unknown = await filter(context).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(DispatchFailedException);
    expect((error as DispatchFailedException).code).toBe("unavailable");
  });

  it("re-throws a domain exception unchanged", async () => {
    const filter = createCheckDispatchOutgoingCallFilter();
    const context = fakeOutgoingGrainCallContext(async () => {
      throw new MaxDepthExceededException();
    });

    await expect(filter(context)).rejects.toThrow(MaxDepthExceededException);
  });

  it("leaves calls to other methods untranslated", async () => {
    // A call to some other grain interface's method must pass straight through - no translation,
    // even though the underlying exception is exactly the kind the filter would otherwise collapse.
    const filter = createCheckDispatchOutgoingCallFilter();
    const context = fakeOutgoingGrainCallContext(
      async () => {
        throw new GrainCallTimeoutError("unrelated hop");
      },
      { interfaceName: "IRelationshipsGrain", methodName: "writeSchema" },
    );

    await expect(filter(context)).rejects.toThrow(GrainCallTimeoutError);
  });
});

describe("CheckDispatchIncomingCallFilter, driven directly", () => {
  it("throws loudly when the ambient depth context was never set", async () => {
    // A caller that reaches ICheckGrain.dispatchCheck without going through setDispatchContext (the
    // dispatcher in production, setTestDispatchContext in a direct-grain test) is a bug: the filter
    // must surface a loud error, never silently default to some depth. C# asserts an
    // InvalidOperationException whose message names `depthRemaining`; the port names the invariant
    // as MissingDispatchContextError and keeps the key in the message.
    RequestContext.clear();
    const filter = createCheckDispatchIncomingCallFilter();
    const context = fakeIncomingGrainCallContext();

    await expect(filter(context)).rejects.toThrow(MissingDispatchContextError);
    await expect(filter(context)).rejects.toThrow(/depthRemaining/i);
  });
});
