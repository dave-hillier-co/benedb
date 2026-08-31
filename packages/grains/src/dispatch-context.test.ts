import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { RequestContext } from "@thresh/core/request-context";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DISPATCH_DEPTH_REMAINING_KEY,
  DISPATCH_VISITED_KEY,
  MissingDispatchContextError,
  requireDepthRemaining,
  requireVisited,
  setDispatchContext,
  tryGetDepthRemaining,
} from "./dispatch-context";

// `DispatchContextTests.cs` (ported in `dispatch-context-tests.test.ts`) covers the three cases the
// C# has. This file characterizes what the C# CANNOT have: the two places Thresh's RequestContext
// genuinely differs from Orleans', and the encoding that difference forces.
//
//   1. THRESH VALUES ARE STRINGS ONLY. Orleans stored an `int` and a `string[]` directly. Here the
//      depth is a decimal string and the visited set is JSON, encoded at the set and decoded at the
//      get. A decode failure must throw the SAME loud error as an absent key: the C# treats a lost
//      context as a bug that must surface, never a silent default of zero, and a corrupted value is
//      no less lost than a missing one.
//   2. SCOPING SEMANTICS DIVERGE. Orleans' `Set` is copy-on-write (a fresh dictionary each time),
//      so a value set inside an async prefix never leaked back UP to the caller. Thresh's `set`
//      MUTATES the ambient store in place, so it does. Sibling isolation - the property the
//      dispatcher actually relies on - still holds, because every dispatch site sets both values
//      immediately before its own call. Both halves are pinned below.
describe("dispatch context keys", () => {
  it("uses the verbatim key literals - they are the wire contract between silos", () => {
    expect(DISPATCH_DEPTH_REMAINING_KEY).toBe("spiceport.dispatch.depthRemaining");
    expect(DISPATCH_VISITED_KEY).toBe("spiceport.dispatch.visited");
  });
});

describe("dispatch context encoding", () => {
  beforeEach(() => {
    RequestContext.clear();
  });

  it("stores the depth as a decimal string, because Thresh values are strings only", () => {
    setDispatchContext(42, []);

    expect(RequestContext.get(DISPATCH_DEPTH_REMAINING_KEY)).toBe("42");
  });

  it("round-trips a zero depth as zero, never as absent", () => {
    setDispatchContext(0, []);

    expect(tryGetDepthRemaining()).toBe(0);
    expect(requireDepthRemaining()).toBe(0);
  });

  it("round-trips an empty visited set as an empty array", () => {
    setDispatchContext(5, []);

    expect(requireVisited()).toEqual([]);
  });

  it("round-trips visited entries containing the canonical U+001F separator", () => {
    // A canonical VisitKey string is length-prefixed and unit-separated, so a naive join on any
    // printable delimiter would corrupt it. Whatever encoding the port picks must survive this.
    const separator = String.fromCharCode(0x1f);
    const visited = [
      `8${separator}document5${separator}doc1 4${separator}view`,
      `line1\nline2\t"quoted"`,
      "",
    ];

    setDispatchContext(1, visited);

    expect(requireVisited()).toEqual(visited);
  });

  it("preserves the order of the visited entries", () => {
    setDispatchContext(1, ["c", "a", "b"]);

    expect(requireVisited()).toEqual(["c", "a", "b"]);
  });

  it("rejects a missing visited set (the ArgumentNullException guard)", () => {
    expect(() => setDispatchContext(1, undefined as unknown as readonly string[])).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("dispatch context decode failures", () => {
  beforeEach(() => {
    RequestContext.clear();
  });

  it("treats an undecodable depth as loudly as an absent one", () => {
    RequestContext.set(DISPATCH_DEPTH_REMAINING_KEY, "not-a-number");

    expect(() => requireDepthRemaining()).toThrow(MissingDispatchContextError);
    expect(tryGetDepthRemaining()).toBeUndefined();
  });

  it.each([[""], ["  "], ["1.5"], ["0x10"], ["1e3"], ["4 2"]])(
    "rejects the malformed depth encoding %j rather than silently defaulting",
    (raw) => {
      RequestContext.set(DISPATCH_DEPTH_REMAINING_KEY, raw);

      expect(() => requireDepthRemaining()).toThrow(MissingDispatchContextError);
    },
  );

  it("treats an undecodable visited set as loudly as an absent one", () => {
    RequestContext.set(DISPATCH_VISITED_KEY, "{not json");

    expect(() => requireVisited()).toThrow(MissingDispatchContextError);
  });

  it("rejects a decodable value of the wrong shape", () => {
    // Well-formed JSON, but not an array of strings: a silo running a different build, or a key
    // collision, must not degrade into a half-populated cycle guard.
    RequestContext.set(DISPATCH_VISITED_KEY, '{"a":1}');

    expect(() => requireVisited()).toThrow(MissingDispatchContextError);
  });
});

describe("dispatch context scoping", () => {
  beforeEach(() => {
    RequestContext.clear();
  });

  it("makes the values visible to code running after the set, on the same flow", () => {
    setDispatchContext(7, ["x"]);

    expect(requireDepthRemaining()).toBe(7);
    expect(requireVisited()).toEqual(["x"]);
  });

  it("DIVERGES from Orleans: a value set inside an awaited callee leaks back UP to the caller", () => {
    // Orleans' copy-on-write `Set` restored the caller's ambient dictionary once the callee yielded,
    // so the C# doc comment could promise "never leaks back UP". Thresh's `set` mutates the ambient
    // store in place, so it does leak up. Pinned deliberately rather than worked around: the
    // dispatcher must not rely on the Orleans guarantee, and a future Thresh change here should
    // break this test loudly rather than pass silently.
    setDispatchContext(1, ["caller"]);

    const callee = async (): Promise<void> => {
      setDispatchContext(7, ["callee"]);
      await Promise.resolve();
    };

    return callee().then(() => {
      expect(requireDepthRemaining()).toBe(7);
      expect(requireVisited()).toEqual(["callee"]);
    });
  });

  it("still isolates siblings, because each dispatch site sets immediately before its own call", () => {
    // The discipline the C# already requires, and the one the leak above cannot break: whatever a
    // previous sibling left behind is overwritten before the next call reads it.
    const observed: Array<[number, readonly string[]]> = [];

    const dispatch = async (depth: number, visited: readonly string[]): Promise<void> => {
      setDispatchContext(depth, visited);
      await Promise.resolve();
      observed.push([requireDepthRemaining(), requireVisited()]);
    };

    return dispatch(3, ["a"])
      .then(() => dispatch(2, ["b"]))
      .then(() => dispatch(1, ["c"]))
      .then(() => {
        expect(observed).toEqual([
          [3, ["a"]],
          [2, ["b"]],
          [1, ["c"]],
        ]);
      });
  });
});
