import { status } from "@grpc/grpc-js";

import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `src/Spiceport.Api/RequestCeilings.cs`.
 *
 * Per-RPC ceilings on the `authzed.api.v1` surface, mirroring SpiceDB's `PermissionsServerConfig`
 * defaults (`internal/services/v1/relationships.go`) and the checks its handlers run before doing
 * any work. Every violation is INVALID_ARGUMENT with SpiceDB's message.
 *
 * PORT NOTE. The C# class also holds `MaxTransactionMetadataSize` and
 * `ValidateTransactionMetadata`. BeneDB already enforced that cap before Spiceport did, as
 * `MAX_TRANSACTION_METADATA_SIZE` / `validateTransactionMetadataSize` in `request-limits.ts`,
 * where `validateWriteRelationships` runs it in SpiceDB's order (request shape, then metadata,
 * then the update and precondition counts). It stays there rather than being duplicated here.
 */

/** Maximum `optional_limit` for ReadRelationships (SpiceDB `MaxReadRelationshipsLimit`). */
export const MAX_READ_RELATIONSHIPS_LIMIT = 1_000;

/** Maximum `optional_limit` for DeleteRelationships (SpiceDB `MaxDeleteRelationshipsLimit`). */
export const MAX_DELETE_RELATIONSHIPS_LIMIT = 1_000;

/** Maximum `optional_limit` for LookupResources (SpiceDB `MaxLookupResourcesLimit`). */
export const MAX_LOOKUP_RESOURCES_LIMIT = 1_000;

/**
 * Maximum `optional_limit` for ExportBulkRelationships (SpiceDB
 * `MaxBulkExportRelationshipsLimit`).
 */
export const MAX_BULK_EXPORT_RELATIONSHIPS_LIMIT = 10_000;

/**
 * Rejects a non-zero `providedLimit` above `maxLimit` (SpiceDB `NewExceedsMaximumLimitErr`). Zero
 * means "no limit" and always passes. Both are proto `uint32`s, which ts-proto renders as plain
 * non-negative numbers, so the comparison is exact.
 */
export function validateLimit(providedLimit: number, maxLimit: number): void {
  if (providedLimit > 0 && providedLimit > maxLimit) {
    throw new RpcError(
      status.INVALID_ARGUMENT,
      `provided limit ${providedLimit} is greater than maximum allowed of ${maxLimit}`,
    );
  }
}
