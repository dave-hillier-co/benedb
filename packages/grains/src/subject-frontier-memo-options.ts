import type { Duration } from "@thresh/core/duration";

import { type MemoGrainOptions, resolveMemoGrainOptions } from "./memo-grain-options";

/**
 * Toggle and idle-collection tuning for `SubjectFrontierGrain`'s per-activation frontier memo
 * (the LookupSubjects analogue of stage (a) of "Activation-as-cache"). Default ON. When
 * `enabled` is false the grain never consults or populates its memo and `StreamLookupSubjects`
 * falls back to its direct engine walk.
 */
export interface SubjectFrontierMemoOptions extends MemoGrainOptions {
  /**
   * The largest frontier size this activation will retain in its memo. A freshly computed
   * frontier larger than this is still returned to the caller unconditionally - only the
   * retention is capped, so an oversized frontier is served but not cached, bounding
   * per-activation memory. The grain that enforces this is a later slice.
   *
   * A plain `number`: the C# member is `int` and it bounds an in-memory collection, never a
   * wire count.
   */
  readonly maxMemoSubjects?: number | undefined;
}

/** `SubjectFrontierMemoOptions` with every default applied. */
export interface ResolvedSubjectFrontierMemoOptions {
  readonly enabled: boolean;
  readonly collectionAge: Duration;
  readonly maxMemoSubjects: number;
}

export function resolveSubjectFrontierMemoOptions(
  options?: SubjectFrontierMemoOptions,
): ResolvedSubjectFrontierMemoOptions {
  return {
    ...resolveMemoGrainOptions(options),
    maxMemoSubjects: options?.maxMemoSubjects ?? 4096,
  };
}
