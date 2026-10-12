import { createHash } from "node:crypto";

/**
 * The single definition of the stored-schema hash: a lowercase-hex SHA-256 over the persisted
 * UTF-8 schema bytes. Used when verifying fetched bytes on a `SchemaResolver` cache miss, and by the
 * tests' reference fold when minting a `SchemaVersionWire` (`eventFromProposal`) - one definition,
 * so the write-side and read-side hashes can never diverge.
 *
 * `createHash` (synchronous) rather than WebCrypto's `subtle.digest`, which is async and
 * unusable from a synchronous fold. `digest("hex")` is already lowercase, matching
 * `Convert.ToHexStringLower`.
 */
export function computeStoredSchemaHash(schemaBytes: Uint8Array): string {
  return createHash("sha256").update(schemaBytes).digest("hex");
}
