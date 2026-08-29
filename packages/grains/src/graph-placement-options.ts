/**
 * Toggle for the graph co-placement director (`GraphLocalityPlacementDirector`).
 *
 * Default ON: the enablement was gated on measurement and the real-network rig's A/B decided it
 * - on real sockets, co-locating compute with its shard turns cross-silo hops into local calls
 * for a consistent, large latency/throughput win. Opting OUT remains a deployment override.
 *
 * When false the director places exactly like random placement (a uniform pick from the
 * compatible silos), so nothing about correctness, identity, or dedup changes either way - the
 * grain directory remains the single authority for where an activation lives once placed. The
 * flag only biases WHERE a first activation lands.
 */
export interface GraphPlacementOptions {
  /**
   * When true, first activations of the graph compute/data grain families (`CheckGrain`,
   * `GraphShardGrain`, `MembershipWalkGrain`, `SubjectFrontierGrain`) are steered onto the silo
   * chosen by a stable hash of their locality key, so compute lands beside the shard holding its
   * data.
   */
  readonly coLocateWithShards?: boolean | undefined;
}

/** `GraphPlacementOptions` with every default applied. */
export interface ResolvedGraphPlacementOptions {
  readonly coLocateWithShards: boolean;
}

export function resolveGraphPlacementOptions(
  options?: GraphPlacementOptions,
): ResolvedGraphPlacementOptions {
  return { coLocateWithShards: options?.coLocateWithShards ?? true };
}
