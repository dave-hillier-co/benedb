import { describe, expect, it } from "vitest";

import { relationshipIntegrityEquals, type RelationshipIntegrity } from "./relationship-integrity";

// Characterization of Spiceport `RelationshipIntegrity` (no covering C# test).
//
// Port decisions pinned here:
//
// 1. `byte[] Hash` becomes `Uint8Array`.
//
// 2. EQUALITY IS BY CONTENT, WHICH DIVERGES FROM C#. C# record equality on a `byte[]` member is
//    REFERENCE equality: two `RelationshipIntegrity` values holding identical bytes are NOT
//    equal in Spiceport, and that propagates into `Relationship` equality. TypeScript gives no
//    equality for free, so the comparison has to be written by hand regardless; this port writes
//    a content comparison, because a hash is a value and reference identity here is a C# codegen
//    artifact rather than a decision anyone made. Recorded loudly because it is a behaviour
//    change: anything in Spiceport that relied on two equal-byte integrities comparing unequal
//    would behave differently here.
//
// 3. `DateTimeOffset HashedAt` becomes NANOSECONDS SINCE THE UNIX EPOCH as a `bigint` - the same
//    representation chosen for `Relationship.optionalExpiration`, and the same currency
//    `TimestampRevision` already uses (`long TimestampNanosSinceEpoch`). A `number` of epoch
//    millis was rejected because the tuple-string expiration format emits 7 fractional digits
//    (100ns ticks), which a millisecond value cannot round-trip; nanosecond values exceed 2^53,
//    so `bigint` it is.
const hashedAt = BigInt(Date.UTC(2024, 0, 2, 3, 4, 5)) * 1_000_000n;

describe("relationship integrity", () => {
  it("carries a key id, hash bytes, and a hashed-at instant", () => {
    const integrity: RelationshipIntegrity = {
      keyId: "key-1",
      hash: new Uint8Array([1, 2, 3]),
      hashedAt,
    };

    expect(integrity.keyId).toBe("key-1");
    expect([...integrity.hash]).toEqual([1, 2, 3]);
    expect(integrity.hashedAt).toBe(1_704_164_645_000_000_000n);
  });

  it("represents hashedAt with sub-millisecond resolution", () => {
    const integrity: RelationshipIntegrity = {
      keyId: "key-1",
      hash: new Uint8Array(),
      hashedAt: hashedAt + 123_456_700n,
    };

    expect(integrity.hashedAt % 1_000_000n).toBe(456_700n);
  });

  describe("equality", () => {
    it("compares hash bytes by content, not by reference (diverges from C#)", () => {
      const a: RelationshipIntegrity = { keyId: "k", hash: new Uint8Array([1, 2, 3]), hashedAt };
      const b: RelationshipIntegrity = { keyId: "k", hash: new Uint8Array([1, 2, 3]), hashedAt };

      expect(a.hash).not.toBe(b.hash);
      expect(relationshipIntegrityEquals(a, b)).toBe(true);
    });

    it("distinguishes differing bytes, lengths, key ids and instants", () => {
      const base: RelationshipIntegrity = { keyId: "k", hash: new Uint8Array([1, 2, 3]), hashedAt };

      expect(relationshipIntegrityEquals(base, { ...base, hash: new Uint8Array([1, 2, 4]) })).toBe(
        false,
      );
      expect(relationshipIntegrityEquals(base, { ...base, hash: new Uint8Array([1, 2]) })).toBe(
        false,
      );
      expect(relationshipIntegrityEquals(base, { ...base, keyId: "other" })).toBe(false);
      expect(relationshipIntegrityEquals(base, { ...base, hashedAt: hashedAt + 1n })).toBe(false);
    });

    it("handles absent values on either side", () => {
      const a: RelationshipIntegrity = { keyId: "k", hash: new Uint8Array(), hashedAt };

      expect(relationshipIntegrityEquals(undefined, undefined)).toBe(true);
      expect(relationshipIntegrityEquals(a, undefined)).toBe(false);
      expect(relationshipIntegrityEquals(undefined, a)).toBe(false);
    });
  });
});
