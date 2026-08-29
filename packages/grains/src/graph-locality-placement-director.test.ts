import { GrainId } from "@thresh/core/grain-id";
import { SiloAddress } from "@thresh/core/silo-address";
import type { PlacementContext } from "@thresh/runtime/placement/placement-strategy";
import { describe, expect, it } from "vitest";

import { GraphLocalityPlacementDirector, localityKey } from "./graph-locality-placement-director";

// CHARACTERIZATION test for `src/Spiceport.Server/Grains/GraphLocalityPlacementDirector.cs`.
//
// The one reachable C# assertion (the `LocalityKey` agreement fact) is ported verbatim in
// `graph-locality-placement-tests.test.ts`; the rest of `GraphLocalityPlacementTests` drives a
// multi-silo mesh cluster. So `OnAddActivation`'s branch structure is pinned here, read off the C#:
//
//   1. an explicit placement hint wins - NOT re-implemented here, because Thresh's dispatcher
//      already does `resolvePlacementHint(req.headers, candidates) ?? strategy.choose(...)` at a
//      layer ABOVE the strategy, so duplicating it inside `choose` would be dead code;
//   2. `if (!CoLocateWithShards || silos.Length == 1) -> random`. The single-silo case
//      short-circuits BEFORE any hashing (it trivially picks the only silo);
//   3. `LocalityKey(...)` is null -> random;
//   4. otherwise: sort a COPY of the candidates, index by
//      `StableHash.Fnv1a64(localityKey) % (ulong)sorted.Length`.
//
// Two Thresh gaps this port had to close, both noted in the ported file:
//   * `PlacementStrategy.choose` received no grain key (only the grain TYPE), so the locality key
//     could not be computed at all. The grain id now reaches the strategy through
//     `PlacementContext`.
//   * `SiloAddress` has no ordering, where the C# does `Array.Sort(SiloAddress[])`. The sort here
//     is by `toString()`, ordinally - what matters is only that EVERY silo sorts identically, which
//     is the whole co-location property.

const silo = (n: number): SiloAddress => new SiloAddress(`silo-${n}`, `uid-${n}`, `silo-${n}:1`);

/** An 8-segment CheckGrain key for document:readme, locality key "document/readme". */
const CHECK_KEY = "document/readme/view/group/eng/member/42/hash";
/** The 3-segment forward-shard key for the same object - the same locality key. */
const FORWARD_SHARD_KEY = "f/document/readme";

function context(grainKey: string, random: () => number = () => 0): PlacementContext {
  return {
    localSilo: silo(1),
    grainId: new GrainId("CheckGrain", grainKey),
    random,
  };
}

describe("localityKey", () => {
  it("dispatches on segment count: 8 and 5 and 7 take the first pair", () => {
    // C#: `8 => $"{parts[0]}/{parts[1]}"` (GrainKey), `5 => ...` (MembershipWalkKey),
    // `7 => ...` (SubjectFrontierKey).
    expect(localityKey("a/b/c/d/e/f/g/h")).toBe("a/b");
    expect(localityKey("a/b/c/d/e")).toBe("a/b");
    expect(localityKey("a/b/c/d/e/f/g")).toBe("a/b");
  });

  it("SKIPS the direction segment of a 3-segment shard key", () => {
    // C#: `3 => $"{parts[1]}/{parts[2]}"`. Direction is deliberately ignored, so the forward and
    // reverse shards of one object co-locate.
    expect(localityKey("f/type/id")).toBe("type/id");
    expect(localityKey("r/type/id")).toBe("type/id");
  });

  it("returns undefined for every unrecognized segment count", () => {
    // C#: `_ => null`. The recognized set is exactly {3, 5, 7, 8}; the caller falls back to random.
    expect(localityKey("")).toBeUndefined(); // "".Split('/') is one empty segment
    expect(localityKey("only")).toBeUndefined();
    expect(localityKey("just/two")).toBeUndefined();
    expect(localityKey("a/b/c/d")).toBeUndefined();
    expect(localityKey("a/b/c/d/e/f")).toBeUndefined();
    expect(localityKey("a/b/c/d/e/f/g/h/i")).toBeUndefined();
  });

  it("counts empty segments, exactly as string.Split('/') does", () => {
    // Both C# `string.Split` and JS `String.prototype.split` keep empty segments, so "//" is three
    // segments and reads as a shard key whose type and id are both empty.
    expect(localityKey("//")).toBe("/");
    expect(localityKey("/b/c/d/e/f/g/h")).toBe("/b");
  });

  it("compares segments in their ESCAPED form and never unescapes", () => {
    // The class remarks are explicit: segments are compared escaped, because every key codec
    // escapes through the same deterministic `Uri.EscapeDataString`. Unescaping "a%2Fb" back to
    // "a/b" here would inject a stray separator into the locality key.
    expect(localityKey("f/doc/a%2Fb")).toBe("doc/a%2Fb");
    expect(localityKey("doc/a%2Fb/view/user/alice/.../42/hash")).toBe("doc/a%2Fb");
  });
});

describe("GraphLocalityPlacementDirector", () => {
  it("hashes the locality key over the SORTED candidate list", () => {
    // fnv1a64("document/readme") = 14804011359153909235; % 4 = 3, so the sorted list's LAST silo.
    const director = new GraphLocalityPlacementDirector({ coLocateWithShards: true });

    const chosen = director.choose(
      "CheckGrain",
      [silo(1), silo(2), silo(3), silo(4)],
      context(CHECK_KEY),
    );

    expect(chosen.podName).toBe("silo-4");
  });

  it("does the modulus in bigint, not after narrowing the hash to a double", () => {
    // The same case as above, chosen for the discriminator: 14804011359153909235 % 4 is 3, but
    // Number(hash) rounds to 14804011359153910000, whose % 4 is 0 - a DIFFERENT silo. Narrowing
    // before the modulus loses the low bits and silently names the wrong one everywhere.
    const director = new GraphLocalityPlacementDirector({ coLocateWithShards: true });

    const chosen = director.choose(
      "CheckGrain",
      [silo(1), silo(2), silo(3), silo(4)],
      context(CHECK_KEY),
    );

    expect(chosen.podName).not.toBe("silo-1");
    expect(chosen.podName).toBe("silo-4");
  });

  it("gives the same answer whatever order the candidates arrive in", () => {
    // `GetCompatibleSilos` makes no ordering promise, which is why the C# sorts a CLONE before
    // indexing. Without the sort each silo would index a differently-ordered list and the whole
    // co-location property would evaporate.
    const director = new GraphLocalityPlacementDirector({ coLocateWithShards: true });
    const candidates = [silo(1), silo(2), silo(3), silo(4)];

    const forwards = director.choose("CheckGrain", candidates, context(CHECK_KEY));
    const backwards = director.choose("CheckGrain", [...candidates].reverse(), context(CHECK_KEY));
    const shuffled = director.choose(
      "CheckGrain",
      [silo(3), silo(1), silo(4), silo(2)],
      context(CHECK_KEY),
    );

    expect(backwards.podName).toBe(forwards.podName);
    expect(shuffled.podName).toBe(forwards.podName);
  });

  it("does not mutate the caller's candidate array while sorting", () => {
    // C#: `var sorted = (SiloAddress[])silos.Clone(); Array.Sort(sorted);` - the clone is the point.
    // `Array.prototype.sort` sorts IN PLACE, so a port that forgets to copy reorders the
    // dispatcher's own list.
    const director = new GraphLocalityPlacementDirector({ coLocateWithShards: true });
    const candidates = [silo(4), silo(2), silo(3), silo(1)];

    director.choose("CheckGrain", candidates, context(CHECK_KEY));

    expect(candidates.map((s) => s.podName)).toEqual(["silo-4", "silo-2", "silo-3", "silo-1"]);
  });

  it("puts every key shape that reads one object's shard on the SAME silo", () => {
    // The co-location property, end to end through `choose` rather than only through `LocalityKey`:
    // the CheckGrain of document:readme and that object's forward shard land together.
    const director = new GraphLocalityPlacementDirector({ coLocateWithShards: true });
    const candidates = [silo(1), silo(2), silo(3)];

    const check = director.choose("CheckGrain", candidates, context(CHECK_KEY));
    const shard = director.choose("GraphShardGrain", candidates, context(FORWARD_SHARD_KEY));

    expect(shard.podName).toBe(check.podName);
    // fnv1a64("document/readme") % 3 = 1 -> the middle silo of the sorted list.
    expect(check.podName).toBe("silo-2");
  });

  it("falls back to a random pick when the key shape is unrecognized", () => {
    // C#: `if (localityKey is null) return silos[Random.Shared.Next(silos.Length)];` - over the
    // UNSORTED candidate array. With the RNG pinned to 0 that is the first candidate as given,
    // which here is deliberately not the silo the locality path would have chosen.
    const director = new GraphLocalityPlacementDirector({ coLocateWithShards: true });

    const chosen = director.choose(
      "CheckGrain",
      [silo(1), silo(2), silo(3), silo(4)],
      context("just/two"),
    );

    expect(chosen.podName).toBe("silo-1");
  });

  it("falls back to a random pick when co-location is switched off", () => {
    // C#: `if (!_options.CoLocateWithShards || silos.Length == 1) -> random`. The key here IS
    // recognized, so a result of silo-1 rather than silo-4 is what proves the branch was taken.
    const director = new GraphLocalityPlacementDirector({ coLocateWithShards: false });

    const chosen = director.choose(
      "CheckGrain",
      [silo(1), silo(2), silo(3), silo(4)],
      context(CHECK_KEY),
    );

    expect(chosen.podName).toBe("silo-1");
  });

  it("honours the RNG the placement context injects, rather than a private one", () => {
    const director = new GraphLocalityPlacementDirector({ coLocateWithShards: false });
    const candidates = [silo(1), silo(2), silo(3), silo(4)];

    expect(
      director.choose(
        "CheckGrain",
        candidates,
        context(CHECK_KEY, () => 0.99),
      ).podName,
    ).toBe("silo-4");
    expect(
      director.choose(
        "CheckGrain",
        candidates,
        context(CHECK_KEY, () => 0.5),
      ).podName,
    ).toBe("silo-3");
  });

  it("short-circuits a single-candidate cluster to that silo, before any hashing", () => {
    // `silos.Length == 1` is the single-silo fast path: the random pick trivially picks the only
    // silo, and it must hold for an unrecognized key shape too.
    const director = new GraphLocalityPlacementDirector({ coLocateWithShards: true });

    expect(director.choose("CheckGrain", [silo(7)], context(CHECK_KEY)).podName).toBe("silo-7");
    expect(director.choose("CheckGrain", [silo(7)], context("nope")).podName).toBe("silo-7");
  });

  it("co-locates by default, following the ported GraphPlacementOptions default", () => {
    // The two C# comments CONTRADICT each other: the director's own remarks say "default OFF"
    // while `GraphLocalityPlacement.cs` says "the default is ON". `graph-placement-options.ts` is
    // what actually decides, and its resolver defaults `coLocateWithShards` to true (the
    // real-network A/B settled it), so a director given no options takes the locality path.
    const withNoOptions = new GraphLocalityPlacementDirector();
    const withEmptyOptions = new GraphLocalityPlacementDirector({});
    const candidates = [silo(1), silo(2), silo(3), silo(4)];

    expect(withNoOptions.choose("CheckGrain", candidates, context(CHECK_KEY)).podName).toBe(
      "silo-4",
    );
    expect(withEmptyOptions.choose("CheckGrain", candidates, context(CHECK_KEY)).podName).toBe(
      "silo-4",
    );
  });
});
