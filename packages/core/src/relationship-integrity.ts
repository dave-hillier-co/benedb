import { bytesEqual } from "./structural-equality";

/**
 * Cryptographic integrity information used to verify a relationship was written by a trusted
 * source.
 *
 * `hashedAt` is NANOSECONDS SINCE THE UNIX EPOCH as a `bigint` - the representation decided
 * once for `Relationship.optionalExpiration` and shared here, and the same currency
 * `TimestampRevision` uses. Epoch millis as a `number` was rejected because the tuple-string
 * expiration format emits 7 fractional digits (100ns ticks); nanosecond values exceed 2^53, so
 * `bigint` it is.
 */
export interface RelationshipIntegrity {
  /** Identifier of the key used to compute the hash. */
  readonly keyId: string;
  /** The integrity hash bytes. */
  readonly hash: Uint8Array;
  /** When the hash was computed, in nanoseconds since the Unix epoch. */
  readonly hashedAt: bigint;
}

/**
 * Value equality, comparing `hash` by content rather than by array reference. Ported from the C#
 * record's `Equals` override.
 */
export function relationshipIntegrityEquals(
  a: RelationshipIntegrity | undefined,
  b: RelationshipIntegrity | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.keyId === b.keyId && bytesEqual(a.hash, b.hash) && a.hashedAt === b.hashedAt;
}
