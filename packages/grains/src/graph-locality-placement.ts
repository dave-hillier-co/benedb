/**
 * Ported from Spiceport `Grains/GraphLocalityPlacement.cs`.
 *
 * The C# file is an Orleans `PlacementStrategy` marker class plus the `PlacementAttribute`
 * subclass that carries an instance of it - both pure plumbing for Orleans' strategy-to-director
 * DI lookup. Thresh has NEITHER: `PlacementStrategyRegistry`'s own doc records that this runtime
 * has no strategy-vs-director split (a director IS a `PlacementStrategy`), and there is no
 * attribute mechanism - a grain declares `{ placement: "custom", strategy: "<name>" }` in its
 * metadata and the silo builder calls `addPlacementStrategy(name, strategy)`. So the marker class
 * carries no state worth porting and what survives the pair is the NAME the two sides agree on.
 * `[Immutable]`, `[Serializable]` and `[GenerateSerializer]` map to nothing.
 *
 * Placement strategy for the graph compute/data grain families (`CheckGrain`, `GraphShardGrain`,
 * `MembershipWalkGrain`, `SubjectFrontierGrain`): first activations are directed by
 * `GraphLocalityPlacementDirector`, which - only when `GraphPlacementOptions.coLocateWithShards`
 * is enabled - steers a grain onto the same silo as the `GraphShardGrain` holding the data it
 * reads (the co-placement step of `docs/graph-sharded-datastore.md` §5).
 *
 * This is a LOCALITY HINT, not ownership, and it is NOT the deleted hash ring. The ring computed
 * OWNERSHIP - which silo a sub-problem belonged to, load-bearing for dedup - whereas this
 * strategy only biases where the FIRST activation of a grain lands; the grain directory remains
 * the single authority for identity and single-activation dedup. On membership change the
 * director's modulus moves and existing activations simply stay where the directory has them:
 * locality degrades gracefully, correctness is untouched.
 *
 * The strategy attaches per grain CLASS, which cannot be made conditional - so the four grain
 * classes name it unconditionally and the on/off decision lives in the DIRECTOR: when
 * `coLocateWithShards` is false (a deployment opt-out) the director mirrors random placement, a
 * uniform pick from the compatible silos.
 *
 * NOTHING CONSUMES THIS NAME YET: the four grain classes that will bear it are in the next slice,
 * as is the silo wiring that registers the director under it. Until then the file's only
 * obligation is that the name is a stable, exact string - a typo on either side of the registry
 * surfaces as a placement failure at activation time, not at compile time.
 */
export const GRAPH_LOCALITY_PLACEMENT_STRATEGY = "graphLocality";
