import { joinGrainKey, splitGrainKey } from "./grain-key-codec";

/** The decoded components of an `IMembershipWalkGrain` string key. */
export interface MembershipWalkKeyParts {
  /** The subject's namespace. */
  readonly subjectType: string;
  /** The subject's id. */
  readonly subjectId: string;
  /** The subject's relation. */
  readonly subjectRelation: string;
  /** The EXACT pinned revision string, verbatim. */
  readonly revision: string;
  /** The stored-schema hash the walk was computed under. */
  readonly schemaHash: string;
}

/**
 * Encodes the `IMembershipWalkGrain` string key, which IS the canonical identity of "the
 * membership-walk closure rooted at subject key `subjType:subjId#subjRelation` at
 * `(revision, schemaHash)`": `subjType/subjId/subjRelation/revision/schemaHash`.
 *
 * Five segments, plain strings all the way through - no `ObjectAndRelation` here, unlike
 * `grainKeyBuild` and `subjectFrontierKeyBuild`.
 *
 * Mirrors `subjectFrontierKeyBuild`'s escaping/parsing conventions exactly: components are
 * URL-style escaped so a literal separator in any field cannot corrupt the key. UNLIKE
 * `grainKeyBuild`'s quantized window, the revision here is the EXACT pinned revision - a walk runs
 * over a reader pinned to it, which is the whole reason this grain family has no fold/catch-up
 * machinery. It is carried verbatim, never parsed and re-formatted: that would normalise a leading
 * zero or lose precision beyond 2^53, and either would break the exactness.
 */
export function membershipWalkKeyBuild(
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  revision: string,
  schemaHash: string,
): string {
  return joinGrainKey(subjectType, subjectId, subjectRelation, revision, schemaHash);
}

/**
 * Decodes an `IMembershipWalkGrain` string key. Throws `FormatError` when the key does not have
 * exactly five segments.
 */
export function membershipWalkKeyParse(key: string): MembershipWalkKeyParts {
  // Sound because `splitGrainKey` has already thrown unless there are exactly five segments; the
  // assertion exists only because `noUncheckedIndexedAccess` widens every index of a `string[]`.
  const [subjectType, subjectId, subjectRelation, revision, schemaHash] = splitGrainKey(key, 5) as [
    string,
    string,
    string,
    string,
    string,
  ];

  return { subjectType, subjectId, subjectRelation, revision, schemaHash };
}
