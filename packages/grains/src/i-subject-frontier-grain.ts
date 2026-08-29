import { defineGrainInterface } from "@thresh/core/grain-interface";
import type { GrainWithStringKey } from "@thresh/core/key-kinds";

import type { SubjectFrontierReply } from "./subject-frontier-dtos";

/**
 * A grain keyed by "the pre-context subject frontier of resource#relation for
 * subjectType(#subjectRelation) at (quantizedRevision, schemaHash)" - the whole result of a
 * `LookupSubjectsEngine.lookupSubjects` walk from that root, memoized per activation exactly as
 * `ICheckGrain` memoizes a Check sub-problem's pre-context branch (stage (a) of
 * "Activation-as-cache", `docs/future-work.md` item 1.3). The grain's STRING KEY is, in order:
 * `resourceType/resourceId/relation/subjectType/subjectRelation/quantizedRevision/schemaHash`.
 *
 * Unlike `ICheckGrain` there is NO dispatcher seam here: the engine walk it wraps
 * (`LookupSubjectsEngine`) is consumed unchanged and computes the whole frontier in-process behind
 * a single grain call, not a recursive dispatch tree. That is exactly why the key has SEVEN
 * segments rather than eight - there is no per-subject sub-problem to name, so no subject id - and
 * `subject-frontier-key.ts` keeps that remark next to the codec.
 */
export interface ISubjectFrontierGrain extends GrainWithStringKey {
  /** Returns the pre-context frontier this grain is keyed to, computing it on a cold activation. */
  getFrontier(signal?: AbortSignal | undefined): Promise<SubjectFrontierReply>;
}

/**
 * The runtime value for `ISubjectFrontierGrain`. `getFrontier` carries no Orleans interleave
 * attribute, so the options map is empty.
 */
export const ISubjectFrontierGrain =
  defineGrainInterface<ISubjectFrontierGrain>("ISubjectFrontierGrain");
