import type { SerializedCaveat } from "./serialized-caveat";

/**
 * A serializable mirror of the engine's `FoundSubject`, carried across the `ISubjectFrontierGrain`
 * boundary. Unlike `FoundSubjectWire` (the post-collapse client-edge shape), this is the
 * PRE-CONTEXT shape: the caveat travels as its stable serialized form (never collapsed against a
 * request context) and wildcard exclusions are carried in full, because this reply is the whole
 * memoized frontier a caller collapses per-request, not a single already-collapsed result.
 */
export interface FrontierSubjectWire {
  /** The concrete subject id, or "*" for a wildcard match. */
  readonly subjectId: string;
  /** The verbatim gating caveat expression, or absent if unconditional. */
  readonly caveat?: SerializedCaveat | undefined;
  /** True when `subjectId` is the public wildcard. */
  readonly isWildcard: boolean;
  /**
   * For a wildcard match, the concrete subjects excluded from it. ABSENT and EMPTY are distinct
   * (the C# round-trip test asserts a plain subject's list is null), so this starts life absent and
   * is never initialised to `[]` for tidiness.
   *
   * Note: `FoundSubjectWire` (the client-facing collapsed shape) still has no excluded-subjects
   * field, so `ReverseOps` drops these at the client edge exactly as it always has - carrying them
   * here only keeps the memoized frontier a byte-faithful mirror of the engine's own output.
   */
  readonly excludedSubjects?: readonly FrontierSubjectWire[] | undefined;
}

/** The reply from `ISubjectFrontierGrain.getFrontier`: the whole materialized frontier. */
export interface SubjectFrontierReply {
  /** Every subject the engine's full walk found, in the engine's own walk order. */
  readonly subjects: readonly FrontierSubjectWire[];
}
