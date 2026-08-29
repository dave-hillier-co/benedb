import { visitKeyToCanonicalString } from "@spacedb/engine/i-dispatcher";
import { RequestContext } from "@thresh/core/request-context";
import { beforeEach, describe, expect, it } from "vitest";

import {
  MissingDispatchContextError,
  requireDepthRemaining,
  requireVisited,
  setDispatchContext,
} from "./dispatch-context";

// Ported from Spiceport `tests/Spiceport.Grains.Tests/DispatchContextTests.cs`, case for case.
//
// Orleans' static `RequestContext` maps onto Thresh's `RequestContext` from
// `@thresh/core/request-context` - also `AsyncLocalStorage`-backed, also usable from non-grain code
// - so the C#'s shape ports directly and `RequestContext.Clear()` has an exact counterpart. Each
// test clears first, for the same reason the C# does: a value left behind on the same async flow
// would mask a missing-key bug.
//
// `Assert.Throws<InvalidOperationException>` becomes the project `MissingDispatchContextError`,
// named for the invariant it protects, per the port guide. The C#'s substring assertions are
// case-insensitive, so the message may name the key however it likes as long as the key is in it.
describe("dispatch context", () => {
  beforeEach(() => {
    RequestContext.clear();
  });

  it("throws loudly from requireDepthRemaining when never set", () => {
    expect(() => requireDepthRemaining()).toThrow(MissingDispatchContextError);
    expect(() => requireDepthRemaining()).toThrow(/depthRemaining/i);
  });

  it("throws loudly from requireVisited when never set", () => {
    expect(() => requireVisited()).toThrow(MissingDispatchContextError);
    expect(() => requireVisited()).toThrow(/visited/i);
  });

  it("round-trips the depth and visited set through set/require", () => {
    const key = visitKeyToCanonicalString({
      resourceType: "document",
      resourceId: "doc1",
      resourceRelation: "view",
      subjectType: "user",
      subjectId: "alice",
      subjectRelation: "...",
    });
    const visited = [key];

    setDispatchContext(42, visited);

    expect(requireDepthRemaining()).toBe(42);
    expect(new Set(requireVisited())).toEqual(new Set(visited));
  });
});
