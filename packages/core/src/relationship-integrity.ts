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
 * Content equality over the key id, hash bytes and instant.
 *
 * DIVERGES FROM C#: C# record equality on a `byte[]` member is REFERENCE equality, so two
 * Spiceport values holding identical bytes are NOT equal, and that propagates into
 * `Relationship` equality. TypeScript gives no equality for free, so the comparison has to be
 * written by hand regardless; this port compares content, because a hash is a value.
 */
export function relationshipIntegrityEquals(
  a: RelationshipIntegrity | undefined,
  b: RelationshipIntegrity | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.keyId !== b.keyId) return false;
  if (a.hashedAt !== b.hashedAt) return false;
  if (a.hash.length !== b.hash.length) return false;
  for (let i = 0; i < a.hash.length; i++) {
    if (a.hash[i] !== b.hash[i]) return false;
  }
  return true;
}
