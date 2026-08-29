import { visitKeyOf, visitKeyToCanonicalString } from "@spacedb/engine/i-dispatcher";
import { RequestContext } from "@thresh/core/request-context";
import { beforeEach, describe, expect, it } from "vitest";

import { requireDepthRemaining, requireVisited, setDispatchContext } from "./dispatch-context";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/DispatchContextTestHelper.cs`.
 *
 * Test-only convenience wrapper over {@link setDispatchContext}. Production callers only ever reach
 * `ICheckGrain.dispatchCheck` through the dispatcher, which sets the ambient depth budget and exact
 * visited-set cycle guard immediately before each grain call. Tests that resolve an `ICheckGrain`
 * DIRECTLY (bypassing the dispatcher, to isolate the grain's own behaviour) must do the same - this
 * is the honest cost of moving those fields out of the method signature and into ambient context.
 *
 * Set it immediately before each direct grain call, never once up front for several calls: Thresh's
 * `RequestContext.set` mutates the ambient store in place rather than copying it (unlike Orleans),
 * so a value set for one call is still there for the next unless it is overwritten. See
 * `dispatch-context.test.ts`.
 *
 * The C# takes an `ImmutableHashSet<VisitKey>` and canonicalises each key. In the port that
 * conversion has already happened one layer down - `ResolverMeta.visited` is a
 * `ReadonlySet<string>` of canonical strings, because TypeScript has no value-equality set - so
 * this takes the canonical strings directly. `visited` defaults to the empty set (no in-flight
 * visit keys), matching the C#'s optional parameter.
 *
 * It lives in a `.test.ts` file (per the port ledger) because it is test-only: nothing in the
 * shipped grains package may import it.
 */
export function setTestDispatchContext(
  depthRemaining: number,
  visited: Iterable<string> = [],
): void {
  setDispatchContext(depthRemaining, [...visited]);
}

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
