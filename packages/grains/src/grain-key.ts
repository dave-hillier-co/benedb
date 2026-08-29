import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";

import { joinGrainKey, splitGrainKey } from "./grain-key-codec";

/** The decoded components of an `ICheckGrain` string key. */
export interface GrainKeyParts {
  /** The resource side of the sub-problem. */
  readonly resource: ObjectAndRelation;
  /** The subject side of the sub-problem. */
  readonly subject: ObjectAndRelation;
  /** The pinned revision string, verbatim as the resolver produced it. */
  readonly revision: string;
  /** The stored-schema hash the grain must evaluate under. */
  readonly schemaHash: string;
}

/**
 * Encodes the `ICheckGrain` string key, which IS the canonical sub-problem identity:
 * `resType/resId/relation/subjType/subjId/subjRelation/quantizedRevision/schemaHash`.
 *
 * The ORDER of the eight segments is the identity: reordering silently repartitions the check
 * cache, and no test above this layer would notice.
 *
 * The revision component is the request's revision string form, carried VERBATIM - never parsed and
 * re-formatted, which would normalise a leading zero or lose precision beyond 2^53 and split one
 * sub-problem across two cache entries. Callers are expected to pin an already-quantized
 * (optimized) revision at the top of a check, so structurally-identical sub-problems made within
 * the same window collide on the same grain identity (and hence cache entry), while the component
 * remains a real, snapshot-able revision the grain can resolve a reader for. Components are
 * URL-style escaped so a literal separator in any field cannot corrupt the key.
 *
 * `schemaHash` scopes the routing keyspace (a schema change yields a fresh set of grain identities
 * for structurally-identical sub-problems) AND names the schema the grain must evaluate under:
 * `CheckGrain` resolves the compiled schema for this hash at its pinned revision, so the schema is
 * a pure function of the key's revision rather than the grain's local `ISchemaProvider.current`.
 *
 * The key deliberately carries NO optimized-vs-exact mode segment. That distinction matters only at
 * `RevisionResolver` time, when deciding WHICH revision string to pin for a
 * `ConsistencyRequirement`. Once a revision string is chosen, every hop reads a snapshot pinned at
 * exactly that string (`IDatastore.snapshotReader` is a pure function of the revision value, not of
 * why it was chosen) - there is no caller-side branch cache left to protect from folding an exact
 * read into a quantized bucket (that dispatcher was removed). So two sub-problems with the
 * identical revision string always compute the identical answer regardless of the mode that
 * produced the string, and sharing one grain activation (and its activation memo) between them is
 * exact, not approximate, for both.
 */
export function grainKeyBuild(
  resource: ObjectAndRelation,
  subject: ObjectAndRelation,
  revision: string,
  schemaHash: string,
): string {
  return joinGrainKey(
    resource.objectType,
    resource.objectId,
    resource.relation,
    subject.objectType,
    subject.objectId,
    subject.relation,
    revision,
    schemaHash,
  );
}

/**
 * Decodes an `ICheckGrain` string key. Throws `FormatError` when the key does not have exactly
 * eight segments.
 */
export function grainKeyParse(key: string): GrainKeyParts {
  // `splitGrainKey` has already thrown unless there are exactly eight segments, so the tuple
  // assertion is sound; it exists only because `noUncheckedIndexedAccess` widens every index of
  // the `string[]` the C# indexed freely.
  const [
    resourceType,
    resourceId,
    relation,
    subjectType,
    subjectId,
    subjectRelation,
    revision,
    schemaHash,
  ] = splitGrainKey(key, 8) as [string, string, string, string, string, string, string, string];

  // schemaHash is carried back: the grain resolves the compiled schema for it at the pinned
  // revision (see CheckGrain), so evaluation is a pure function of the key's revision.
  return {
    resource: { objectType: resourceType, objectId: resourceId, relation },
    subject: { objectType: subjectType, objectId: subjectId, relation: subjectRelation },
    revision,
    schemaHash,
  };
}
