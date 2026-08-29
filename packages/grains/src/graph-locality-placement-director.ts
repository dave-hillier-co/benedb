import { keyToString } from "@thresh/core/grain-key";
import type { GrainType } from "@thresh/core/grain-type";
import type { SiloAddress } from "@thresh/core/silo-address";
import {
  pickRandom,
  type PlacementContext,
  type PlacementStrategy,
} from "@thresh/runtime/placement/placement-strategy";

import {
  resolveGraphPlacementOptions,
  type GraphPlacementOptions,
  type ResolvedGraphPlacementOptions,
} from "./graph-placement-options";
import { fnv1a64 } from "./stable-hash";

/**
 * Ported from Spiceport `Grains/GraphLocalityPlacementDirector.cs`.
 *
 * The placement director behind `GRAPH_LOCALITY_PLACEMENT_STRATEGY`: chooses the silo for the
 * FIRST activation of a graph grain by a stable hash of the grain key's locality key - the
 * (type, id) of the object whose `GraphShardGrain` the grain reads - so compute lands on the silo
 * that (under the same rule) hosts its data shard. Every silo sorts the candidate list before
 * indexing, so every silo computes the same answer for the same key. That "same answer" holds PER
 * GRAIN TYPE: co-location additionally assumes the four grain families share one candidate set
 * (true here - all four are hosted on every silo). Under heterogeneous hosting the per-type lists
 * differ and the modulus names different silos for the same key - correctness is unaffected (this
 * is only a hint) but the locality benefit silently disappears; revisit the indexing rule before
 * ever splitting the families across silo subsets.
 *
 * A pure locality hint: when the option is off - or a key shape is unrecognized - the director
 * mirrors random placement.
 *
 * Locality-key extraction dispatches on the key's SEGMENT COUNT, which is unique across the four
 * grain classes (the closed set this director can ever see). Segments are compared in their
 * ESCAPED form: all four key codecs escape through the same `GrainKeyCodec`
 * (`encodeURIComponent` is deterministic), so the same object yields the same locality key from
 * every key shape without unescaping.
 *
 *   * `GrainKey` (CheckGrain, 8 segments): the (resourceType, resourceId) prefix - the check's
 *     first data read is the resource's forward shard.
 *   * `GraphShardGrainKey` (GraphShardGrain, 3 segments): the (type, id) after the direction
 *     segment. Direction is deliberately ignored: the forward and reverse shards of the same
 *     object co-locate, which is fine and simple.
 *   * `MembershipWalkKey` (MembershipWalkGrain, 5 segments): the (subjectType, subjectId) prefix
 *     - the walk's one data read is the subject's REVERSE shard, whose locality key is that same
 *     (type, id).
 *   * `SubjectFrontierKey` (SubjectFrontierGrain, 7 segments): the (resourceType, resourceId)
 *     prefix. The frontier key names its subject side by TYPE only, and the frontier's whole
 *     lookup-subjects walk starts by reading the RESOURCE root's forward shard.
 *
 * PORT DECISIONS:
 *   * Orleans' `IPlacementDirector` becomes a Thresh `PlacementStrategy` - this runtime has no
 *     strategy-vs-director DI split, so a director IS a strategy.
 *   * The C#'s FIRST branch, `IPlacementDirector.GetPlacementHint(target.RequestContextData,
 *     silos)`, is NOT re-implemented here: Thresh's dispatcher already does
 *     `resolvePlacementHint(req.headers, candidates) ?? strategy.choose(...)` at a layer ABOVE the
 *     strategy, so duplicating it inside `choose` would be dead code.
 *   * THRESH GAP CLOSED: `PlacementStrategy.choose` received only the grain TYPE, so the locality
 *     key could not be computed at all. `PlacementContext.grainId` was added in Thresh
 *     (test-first) and the dispatcher now passes `req.target`; `orleans-to-thresh-port.md` gained
 *     the row. `grainId` is optional in the context, and an absent one falls back to the random
 *     pick - the same fallback an unrecognized key shape takes.
 *   * THRESH GAP, DECIDED HERE: the C# does `Array.Sort(SiloAddress[])` on a CLONE, but Thresh's
 *     `SiloAddress` exposes no comparator. The sort here is by `toString()`, ordinally. Which
 *     order it is does not matter; that EVERY silo produces the identical order does, and
 *     `toString()` is a total function of the address's three components.
 *   * `Array.prototype.sort` sorts IN PLACE where `Array.Sort` follows `Clone()`, so the copy is
 *     kept: the dispatcher's own candidate list must not be reordered.
 */
export class GraphLocalityPlacementDirector implements PlacementStrategy {
  readonly #options: ResolvedGraphPlacementOptions;

  /**
   * NOTE - a CONTRADICTION in the C# comments, transliterated rather than resolved: the director's
   * own remarks say the option is "default OFF" while `GraphLocalityPlacement.cs`'s remarks say
   * "the default is ON". `graph-placement-options.ts` is what actually decides, and its resolver
   * defaults `coLocateWithShards` to true (the real-network A/B settled it), so a director given
   * no options takes the locality path.
   */
  constructor(options?: GraphPlacementOptions) {
    this.#options = resolveGraphPlacementOptions(options);
  }

  /** @inheritdoc */
  choose(
    _grainType: GrainType,
    candidates: readonly SiloAddress[],
    context: PlacementContext,
  ): SiloAddress {
    const random = context.random ?? Math.random;

    // The single-silo fast path short-circuits BEFORE any hashing (the random pick trivially
    // picks the only silo).
    if (!this.#options.coLocateWithShards || candidates.length === 1) {
      return pickRandom(candidates, random);
    }

    const grainId = context.grainId;
    const key = grainId === undefined ? undefined : localityKey(keyToString(grainId.key));
    if (key === undefined) return pickRandom(candidates, random);

    // Sort a COPY so every silo indexes an identically-ordered list (the candidate set makes no
    // ordering promise); the modulus then names one silo cluster-wide for this key.
    const sorted = [...candidates].sort((a, b) => {
      const left = a.toString();
      const right = b.toString();
      // A bare comparator is UTF-16 ordinal, which is what C#'s `StringComparer.Ordinal` is; a
      // locale-aware compare would order differently on different hosts.
      return left < right ? -1 : left > right ? 1 : 0;
    });
    // The modulus stays in BIGINT space: `fnv1a64` exceeds 2^53, so narrowing to `number` first
    // would round away the low bits and name a different silo.
    const index = Number(fnv1a64(key) % BigInt(sorted.length));
    return sorted[index]!;
  }
}

/**
 * Extracts the locality key - the escaped `type/id` of the object whose shard the grain reads -
 * from a graph grain's string key, dispatching on segment count (see the class doc); `undefined`
 * for an unrecognized shape (the caller falls back to a random pick). The C# returns `null`;
 * `undefined` here, per the repo's convention.
 *
 * A free function because the C# is `internal static` and the C# test calls it directly.
 * `String.prototype.split('/')` matches `string.Split('/')` here - both keep empty segments - and
 * because every codec escapes through `GrainKeyCodec`, no id can contribute a stray '/'.
 */
export function localityKey(grainKey: string): string | undefined {
  const parts = grainKey.split("/");
  switch (parts.length) {
    case 8: // GrainKey (CheckGrain): resourceType/resourceId
      return `${parts[0]}/${parts[1]}`;
    case 3: // GraphShardGrainKey: type/id (direction ignored)
      return `${parts[1]}/${parts[2]}`;
    case 5: // MembershipWalkKey: subjectType/subjectId
      return `${parts[0]}/${parts[1]}`;
    case 7: // SubjectFrontierKey: resourceType/resourceId
      return `${parts[0]}/${parts[1]}`;
    default:
      return undefined;
  }
}
