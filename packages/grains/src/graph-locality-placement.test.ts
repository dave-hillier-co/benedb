import { describe, expect, it } from "vitest";

import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";

// CHARACTERIZATION test for `src/Spiceport.Server/Grains/GraphLocalityPlacement.cs`.
//
// The C# file is an Orleans `PlacementStrategy` marker class plus a `PlacementAttribute` subclass
// that carries an instance of it - both pure plumbing for Orleans' strategy-to-director DI lookup.
// Thresh has NEITHER: `PlacementStrategyRegistry`'s own doc says a director IS a
// `PlacementStrategy`, and there is no attribute mechanism - a grain declares
// `{ placement: "custom", strategy: "<name>" }` in its metadata and the silo builder calls
// `addPlacementStrategy(name, strategy)`. So the marker class carries no state worth porting and
// what survives is the NAME the two sides agree on. `[Immutable]`, `[Serializable]` and
// `[GenerateSerializer]` map to nothing.
//
// Nothing consumes this name yet: the four grain classes that will bear it (`CheckGrain`,
// `GraphShardGrain`, `MembershipWalkGrain`, `SubjectFrontierGrain`) are in the next slice. Until
// then this file's only obligation is that the name is a stable, exact string - a typo on either
// side of the registry surfaces as a placement failure at activation time, not at compile time.
describe("GRAPH_LOCALITY_PLACEMENT_STRATEGY", () => {
  it("is the exact registry name the grain metadata and the silo builder must both spell", () => {
    // Thresh's own `placement-strategy-registry.test.ts` already uses "graphLocality" as the
    // worked example of "the seam Spiceport's GraphLocalityPlacementDirector needs", so the two
    // repos agree on the spelling.
    expect(GRAPH_LOCALITY_PLACEMENT_STRATEGY).toBe("graphLocality");
  });

  it("is a plain string, not an object standing in for the Orleans marker class", () => {
    // The marker class held no state; inventing a class here to carry none would be a
    // transliteration of Orleans' DI plumbing rather than of the behaviour.
    expect(typeof GRAPH_LOCALITY_PLACEMENT_STRATEGY).toBe("string");
  });
});
