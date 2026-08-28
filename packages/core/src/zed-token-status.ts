/**
 * Result status of decoding a `ZedToken`.
 *
 * The C# enum (Unknown = 0, LegacyEmptyDatastoreId = 1, Valid = 2, MismatchedDatastoreId = 3)
 * becomes a string-literal union: it is internal, not a proto enum, so unlike `UpdateOperation`
 * there is no wire-number map.
 *
 * - `unknown` - decoding failed or the token is malformed.
 * - `legacyEmptyDatastoreId` - legacy token with no datastore id.
 * - `valid` - token is valid and matches the current datastore.
 * - `mismatchedDatastoreId` - token came from a different datastore instance.
 */
export type ZedTokenStatus =
  "unknown" | "legacyEmptyDatastoreId" | "valid" | "mismatchedDatastoreId";
