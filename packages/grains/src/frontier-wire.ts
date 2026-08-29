import type { FoundSubject } from "@spacedb/engine/found-subject";

import { caveatFromWire, caveatToWire } from "./caveat-wire";
import type { FrontierSubjectWire } from "./subject-frontier-dtos";

/**
 * Maps between the engine's in-process `FoundSubject` tree and the serializable
 * {@link FrontierSubjectWire} form carried across the `ISubjectFrontierGrain` boundary, delegating
 * caveat (de)serialization to `caveat-wire.ts`.
 *
 * Both the live engine-walk path AND the memoized path in `ReverseOps` consume the SAME
 * `FoundSubject` shape (the memoized path reconstructs it via {@link frontierSubjectFromWire}), so
 * the caveat-collapse / cursor-skip post-processing loop downstream is written ONCE and shared by
 * both. Keep that: a later slice must not duplicate the collapse loop for the memoized path.
 *
 * `excludedSubjects` propagates ABSENT as absent - `subjectSetToFoundSubjects` emits no exclusions
 * rather than an empty list, and the round-trip test asserts a plain subject comes back with none -
 * so it is `?.map(...)` and never `?? []`.
 */
export function frontierSubjectToWire(subject: FoundSubject): FrontierSubjectWire {
  return {
    subjectId: subject.subjectId,
    caveat: caveatToWire(subject.caveat),
    isWildcard: subject.isWildcard,
    excludedSubjects: subject.excludedSubjects?.map(frontierSubjectToWire),
  };
}

/** The inverse of {@link frontierSubjectToWire}. */
export function frontierSubjectFromWire(wire: FrontierSubjectWire): FoundSubject {
  return {
    subjectId: wire.subjectId,
    caveat: caveatFromWire(wire.caveat),
    isWildcard: wire.isWildcard,
    excludedSubjects: wire.excludedSubjects?.map(frontierSubjectFromWire),
  };
}
