import { visitKeyOf, visitKeyToCanonicalString } from "@benedb/engine/i-dispatcher";
import { RequestContext } from "@thresh/core/request-context";
import { beforeEach, describe, expect, it } from "vitest";

import { requireDepthRemaining, requireVisited } from "./dispatch-context";
import { setTestDispatchContext } from "./dispatch-context-test-helper";

/**
 * The characterization cases for `dispatch-context-test-helper.ts`, ported from Spiceport
 * `tests/Spiceport.Grains.Tests/DispatchContextTestHelper.cs`.
 *
 * The helper itself moved to `dispatch-context-test-helper.ts` so a suite that needs it (the ported
 * `CancellationAndImmutabilityTests`, which does `using static DispatchContextTestHelper`) can
 * import it without re-registering these cases inside its own file. See that module for the ledger
 * deviation.
 */
describe("dispatch context test helper", () => {
  beforeEach(() => {
    RequestContext.clear();
  });

  it("defaults the visited set to empty, so a test need only name a depth budget", () => {
    setTestDispatchContext(5);

    expect(requireDepthRemaining()).toBe(5);
    expect(requireVisited()).toEqual([]);
  });

  it("sets the canonical visit keys a direct grain call will read back", () => {
    const key = visitKeyToCanonicalString(
      visitKeyOf(
        { objectType: "document", objectId: "doc1", relation: "view" },
        { objectType: "user", objectId: "alice", relation: "..." },
      ),
    );

    setTestDispatchContext(3, new Set([key]));

    expect(requireDepthRemaining()).toBe(3);
    expect(requireVisited()).toEqual([key]);
  });
});
