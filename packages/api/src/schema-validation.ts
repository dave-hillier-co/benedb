import { status } from "@grpc/grpc-js";
import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import type { SchemaSnapshot } from "@spacedb/grains/i-schema-provider";
import type { Status as RpcStatus } from "@spacedb/protos/google/rpc/status";

import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `src/Spiceport.Api/SchemaValidation.cs`.
 *
 * Up-front schema validation at the gRPC service boundary, mirroring SpiceDB's
 * `namespace.CheckNamespaceAndRelation(s)` (see `internal/namespace/util.go`).
 *
 * SpiceDB validates the requested object type and relation/permission (and, for checks, the
 * subject type/relation) against the schema BEFORE dispatching, and returns a
 * `FAILED_PRECONDITION` error for an unknown definition or relation/permission. Without this the
 * engine would silently return a `NO_PERMISSION` verdict for a client schema/typo bug, masking it
 * as a legitimate negative answer. Keeping the check here (not in the engine) preserves the
 * engine's narrow missing-relation tolerance for TTU/arrow targets.
 *
 * Port decisions:
 *   * The C# `internal static class` is a namespace, so its members become sibling exports, and
 *     `readonly record struct TypeAndRelation` becomes a plain readonly `interface` - it is only
 *     ever a `params` array element, never a dictionary key, so value equality is never used.
 *   * `params TypeAndRelation[]` becomes a rest parameter. The ORDER of the pairs is load-bearing:
 *     the first failure wins and its message differs.
 *   * The linear `FirstOrDefault` / `Any` scans are reproduced as `find` / `some` rather than
 *     replaced by a `Map`; the snapshot's shape and its ordinal string equality (C# `==` on
 *     strings is ordinal, as is `===`) are what the messages depend on.
 *   * Both the throwing and the non-throwing variants are kept: the bulk-check path needs a
 *     returned error so a bad pair becomes THAT pair's `google.rpc.Status`.
 */

/** A (definition, relation/permission) pair to validate against the schema. */
export interface TypeAndRelation {
  /** The object/definition type name. */
  readonly definitionName: string;
  /** The relation or permission name. */
  readonly relationName: string;
  /**
   * When true, a relation name equal to the ellipsis (`...`) is accepted without a schema lookup
   * (used for subject references, whose relation is normalized to the ellipsis when absent).
   */
  readonly allowEllipsis: boolean;
}

/**
 * Validates each (definition, relation) pair against the snapshot, throwing an {@link RpcError}
 * with `FAILED_PRECONDITION` on the first unknown definition or unknown relation/permission
 * (matching SpiceDB's error messages).
 */
export function checkNamespaceAndRelations(
  snapshot: SchemaSnapshot,
  ...checks: readonly TypeAndRelation[]
): void {
  const error = tryCheckNamespaceAndRelations(snapshot, ...checks);
  if (error !== undefined) throw error;
}

/**
 * Non-throwing variant of {@link checkNamespaceAndRelations}: returns the {@link RpcError} for the
 * first unknown definition or relation/permission, or `undefined` when every pair validates. Used
 * by the bulk-check path, which surfaces a schema/typo bug PER PAIR (in that pair's
 * `google.rpc.Status` error) rather than failing the whole RPC - mirroring SpiceDB's
 * `CheckBulkPermissions` (it validates each grouped item's namespaces/relations and emits a
 * `CheckBulkPermissionsPair_Error` on failure).
 */
export function tryCheckNamespaceAndRelations(
  snapshot: SchemaSnapshot,
  ...checks: readonly TypeAndRelation[]
): RpcError | undefined {
  for (const check of checks) {
    const ns = snapshot.namespaces.find((n) => n.name === check.definitionName);
    if (ns === undefined) return namespaceNotFound(check.definitionName);

    if (check.allowEllipsis && check.relationName === ELLIPSIS) continue;

    if (!ns.relations.some((r) => r.name === check.relationName))
      return relationNotFound(check.definitionName, check.relationName);
  }

  return undefined;
}

/**
 * Rejects a check whose subject is the public wildcard (object id `*`), mirroring SpiceDB's
 * `checkInternal` guard (`internal/graph/check.go`): a wildcard is only meaningful as a stored
 * subject in a relationship, never as the subject being checked. Surfaces as `INVALID_ARGUMENT`
 * with SpiceDB's exact message, rather than letting the engine silently evaluate it (where a
 * `*`-id subject could even match a stored wildcard tuple).
 */
export function rejectWildcardSubject(subjectObjectId: string): void {
  const error = wildcardSubjectError(subjectObjectId);
  if (error !== undefined) throw error;
}

/**
 * Non-throwing variant of {@link rejectWildcardSubject}: returns the {@link RpcError} when the
 * subject is the public wildcard, otherwise `undefined`. Used by the bulk-check path so a wildcard
 * subject is reported in that one pair's error rather than failing the whole request.
 */
export function wildcardSubjectError(subjectObjectId: string): RpcError | undefined {
  return subjectObjectId === PUBLIC_WILDCARD
    ? new RpcError(
        status.INVALID_ARGUMENT,
        "invalid argument: cannot perform check on wildcard subject",
      )
    : undefined;
}

/**
 * Converts an {@link RpcError} into a `google.rpc.Status` proto for embedding in a per-pair
 * bulk-check result, mirroring SpiceDB's `status.FromError(...).Proto()`: the numeric `code` is
 * the gRPC status code (whose values coincide with `google.rpc.Code`) and the `message` is the
 * status detail. ts-proto emits `details` as a required field, so an empty list is supplied.
 */
export function toRpcStatus(ex: RpcError): RpcStatus {
  return { code: ex.code, message: ex.details, details: [] };
}

function namespaceNotFound(definition: string): RpcError {
  return new RpcError(status.FAILED_PRECONDITION, `object definition \`${definition}\` not found`);
}

function relationNotFound(definition: string, relation: string): RpcError {
  return new RpcError(
    status.FAILED_PRECONDITION,
    `relation/permission \`${relation}\` not found under definition \`${definition}\``,
  );
}
