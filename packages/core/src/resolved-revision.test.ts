import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import type { RevisionMode } from "./revision-mode";
import type { ResolvedRevision } from "./resolved-revision";
import { TimestampRevision } from "./timestamp-revision";

// Characterization of Spiceport `ResolvedRevision` / `RevisionMode` (no covering C# test).
//
// Port decisions pinned here:
//
// 1. `RevisionMode` (Optimized = 0, Exact = 1) becomes a string-literal union. It is internal
//    provenance, not a proto enum, so there is no wire-number map.
//
// 2. The XML remarks are load-bearing: `Mode` is RESOLUTION-TIME PROVENANCE ONLY. It says why a
//    revision was picked - sampled from the quantized bucket, or pinned to a caller's snapshot -
//    and must never travel into a grain key or a cache key. Two requests that resolve to the same
//    revision string must hit the same cache entry regardless of how each got there; letting the
//    mode into a key fragments the cache along a dimension evaluation does not depend on. There
//    is no assertion that can enforce that from here, so it is written down here and enforced
//    where grain keys are built.
//
// 3. `SchemaHash` is nullable in C# and becomes `string | undefined`.
describe("resolved revision", () => {
  it("pins the two revision modes", () => {
    const modes: RevisionMode[] = ["optimized", "exact"];

    expect(new Set(modes).size).toBe(2);
  });

  it("carries the revision that will actually be evaluated, its schema hash, and the mode", () => {
    const resolved: ResolvedRevision = {
      revision: new TimestampRevision(1700000000123456789n),
      schemaHash: "sha-abc",
      mode: "optimized",
    };

    expect(resolved.revision.toString()).toBe("1700000000123456789");
    expect(resolved.schemaHash).toBe("sha-abc");
    expect(resolved.mode).toBe("optimized");
  });

  it("allows an absent schema hash", () => {
    const resolved: ResolvedRevision = {
      revision: new TimestampRevision(1n),
      schemaHash: undefined,
      mode: "exact",
    };

    expect(resolved.schemaHash).toBeUndefined();
  });

  it("crosses a grain boundary with a live revision inside it", () => {
    const resolved: ResolvedRevision = {
      revision: new TimestampRevision(200n),
      schemaHash: "sha",
      mode: "exact",
    };

    const revived = deserializeValue<ResolvedRevision>(serializeValue(resolved));

    expect(revived.mode).toBe("exact");
    expect(revived.schemaHash).toBe("sha");
    expect(revived.revision).toBeInstanceOf(TimestampRevision);
    expect(revived.revision.greaterThan(new TimestampRevision(100n))).toBe(true);
  });
});
