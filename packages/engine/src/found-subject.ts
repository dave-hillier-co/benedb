import type { CaveatExpression } from "./caveat-expression";

/**
 * A subject found by `LookupSubjectsEngine.lookupSubjects` for a resource and relation.
 *
 * Ported from Spiceport `src/Spiceport.Server/Engine/Lookup/FoundSubject.cs`; port of SpiceDB's
 * `v1.FoundSubject`. A present `caveat` is the "Caveated marker": the subject is conditionally
 * included and the expression is carried verbatim so a caller can Collapse-evaluate it against a
 * request context. `isWildcard` is true when the subject is a public wildcard (`"*"`), meaning
 * "every subject of the requested type".
 *
 * Port decisions:
 *   * `IsWildcard` is a SEPARATE boolean from `SubjectId == "*"`. The engine sets both together,
 *     but consumers read the flag, so it is stored, never derived.
 *   * UNLIKE `CheckResult.missingExprFields`, `ExcludedSubjects` is NOT normalised from null to
 *     empty: `SubjectSet.ToFoundSubjects` emits `null` - never `[]` - when a wildcard has no
 *     exclusions, so `undefined` and `[]` stay DISTINCT here. They coincide in the C# only
 *     because it never constructs the empty-list case.
 *   * The type is RECURSIVE: each excluded entry is itself a `FoundSubject` with its own caveat.
 */
export interface FoundSubject {
  /** The concrete subject id, or `"*"` for a wildcard match. */
  readonly subjectId: string;
  /** The accumulated caveat, or absent if unconditional. */
  readonly caveat?: CaveatExpression | undefined;
  /** True when `subjectId` is the public wildcard `"*"` AND this entry is a wildcard match. */
  readonly isWildcard: boolean;
  /**
   * For a wildcard match, the concrete subjects excluded from it (SpiceDB's `excluded_subjects`):
   * the wildcard means "every subject of the type EXCEPT these". Each excluded entry carries its
   * own optional caveat (a conditionally-excluded subject). Absent for concrete subjects and for
   * wildcards with no exclusions.
   */
  readonly excludedSubjects?: readonly FoundSubject[] | undefined;
}

/** Creates a {@link FoundSubject}, applying the C# record's parameter defaults. */
export function createFoundSubject(
  subjectId: string,
  caveat?: CaveatExpression | undefined,
  isWildcard?: boolean | undefined,
  excludedSubjects?: readonly FoundSubject[] | undefined,
): FoundSubject {
  return { subjectId, caveat, isWildcard: isWildcard ?? false, excludedSubjects };
}
