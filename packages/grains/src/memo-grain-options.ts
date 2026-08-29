import type { Duration } from "@thresh/core/duration";

/**
 * Common toggle + idle-collection-age shape shared by every per-activation grain memo
 * (`ActivationMemoOptions`, `SubjectFrontierMemoOptions`, `MembershipWalkOptions`). The owning
 * grain's key already embeds the revision/quantization and schema hash, so the keyspace rotates
 * on its own as revisions/schema advance; idle activation collection at `collectionAge` IS the
 * memo's eviction policy - no separate cache/TTL bookkeeping is needed.
 *
 * The C# is an abstract class with `init` properties and defaults. Thresh has no container, so
 * per the guide's `IOptions<T>` row this is a plain options object with every member optional and
 * the defaults applied by a resolver using `??` - `||` would turn an explicit `false` or an
 * explicit zero age back into the default, which is the whole point of having an off switch.
 */
export interface MemoGrainOptions {
  /** When false, the owning grain never consults or populates its memo. */
  readonly enabled?: boolean | undefined;

  /**
   * The owning grain activation's idle-collection age. Default 2 minutes.
   *
   * The silo's collection quantum rejects an age that does not exceed it (default 1 minute); the
   * wiring clamps a smaller configured value up rather than failing configuration validation.
   */
  readonly collectionAge?: Duration | undefined;
}

/** `MemoGrainOptions` with every default applied. */
export interface ResolvedMemoGrainOptions {
  readonly enabled: boolean;
  readonly collectionAge: Duration;
}

export function resolveMemoGrainOptions(options?: MemoGrainOptions): ResolvedMemoGrainOptions {
  return {
    enabled: options?.enabled ?? true,
    collectionAge: options?.collectionAge ?? { minutes: 2 },
  };
}
