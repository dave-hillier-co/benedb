import { describe, expect, it } from "vitest";

import { resolveGraphPlacementOptions } from "./graph-placement-options";

/**
 * No covering C# test - a characterization of `GraphPlacementOptions`.
 *
 * The single flag defaults TRUE, and that default is a MEASURED decision (the real-network rig's
 * A/B: on real sockets, co-locating compute with its shard turns cross-silo hops into local
 * calls). A port that flips it to false "for safety" throws that measurement away. It is a
 * first-activation locality hint only - nothing about correctness or dedup changes either way, so
 * no test can catch a wrong default except this one.
 */
describe("resolveGraphPlacementOptions", () => {
  it("defaults to co-locating compute with its shard", () => {
    expect(resolveGraphPlacementOptions().coLocateWithShards).toBe(true);
    expect(resolveGraphPlacementOptions({}).coLocateWithShards).toBe(true);
  });

  it("honours an explicit opt-out", () => {
    expect(resolveGraphPlacementOptions({ coLocateWithShards: false }).coLocateWithShards).toBe(
      false,
    );
  });

  it("carries no other members", () => {
    expect(Object.keys(resolveGraphPlacementOptions())).toEqual(["coLocateWithShards"]);
  });
});
