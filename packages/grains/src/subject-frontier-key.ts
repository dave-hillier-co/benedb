import type { ObjectAndRelation } from "@benedb/core/object-and-relation";

import { joinGrainKey, splitGrainKey } from "./grain-key-codec";

/** The decoded components of an `ISubjectFrontierGrain` string key. */
export interface SubjectFrontierKeyParts {
  /** The frontier's root resource#relation. */
  readonly resource: ObjectAndRelation;
  /** The subject namespace the frontier enumerates. */
  readonly subjectType: string;
  /** The subject relation the frontier enumerates. */
  readonly subjectRelation: string;
  /** The pinned revision string, verbatim as the resolver produced it. */
  readonly revision: string;
  /** The stored-schema hash the frontier was computed under. */
  readonly schemaHash: string;
}

/**
 * Encodes the `ISubjectFrontierGrain` string key, which IS the canonical identity of "the
 * pre-context subject frontier of resource#relation for subjectType(#subjectRelation) at
 * (quantizedRevision, schemaHash)":
 * `resType/resId/relation/subjType/subjRelation/quantizedRevision/schemaHash`.
 *
 * SEVEN segments, not `GrainKey`'s eight: there is no subject id, because the frontier is the whole
 * set of subjects and so is keyed by subject TYPE and relation. That in turn is because there is no
 * dispatcher seam on `ISubjectFrontierGrain` (unlike `ICheckGrain`) - the engine walk computes the
 * whole frontier in-process behind one grain call, so there is no per-subject sub-problem to name.
 *
 * Mirrors `grainKeyBuild`'s escaping/parsing conventions exactly (see its remarks for why the key
 * carries no optimized-vs-exact mode segment): components are URL-style escaped so a literal
 * separator in any field cannot corrupt the key, and two requests naming the identical revision
 * string always compute the identical frontier regardless of the consistency mode that produced
 * that string.
 */
export function subjectFrontierKeyBuild(
  resource: ObjectAndRelation,
  subjectType: string,
  subjectRelation: string,
  revision: string,
  schemaHash: string,
): string {
  return joinGrainKey(
    resource.objectType,
    resource.objectId,
    resource.relation,
    subjectType,
    subjectRelation,
    revision,
    schemaHash,
  );
}

/**
 * Decodes an `ISubjectFrontierGrain` string key. Throws `FormatError` when the key does not have
 * exactly seven segments.
 */
export function subjectFrontierKeyParse(key: string): SubjectFrontierKeyParts {
  // Sound because `splitGrainKey` has already thrown unless there are exactly seven segments; the
  // assertion exists only because `noUncheckedIndexedAccess` widens every index of a `string[]`.
  const [resourceType, resourceId, relation, subjectType, subjectRelation, revision, schemaHash] =
    splitGrainKey(key, 7) as [string, string, string, string, string, string, string];

  return {
    resource: { objectType: resourceType, objectId: resourceId, relation },
    subjectType,
    subjectRelation,
    revision,
    schemaHash,
  };
}
