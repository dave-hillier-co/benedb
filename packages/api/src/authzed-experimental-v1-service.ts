import { status } from "@grpc/grpc-js";
import type { IRelationshipsGrain } from "@benedb/grains/i-relationships-grain";
import {
  IRelationshipsGrain as IRelationshipsGrainDefinition,
  RELATIONSHIPS_GRAIN_KEY,
} from "@benedb/grains/i-relationships-grain";
import type { RelationshipsFilterWire } from "@benedb/grains/relationships-dtos";
import { CounterOperationException } from "@benedb/grains/relationships-dtos";
import { SequencerOverloadedException } from "@benedb/grains/sequencer-overloaded-exception";
import type {
  BulkCheckPermissionPair,
  BulkCheckPermissionRequest,
  BulkCheckPermissionResponse,
  BulkExportRelationshipsRequest,
  BulkExportRelationshipsResponse,
  BulkImportRelationshipsRequest,
  BulkImportRelationshipsResponse,
  ExperimentalComputablePermissionsRequest,
  ExperimentalCountRelationshipsRequest,
  ExperimentalCountRelationshipsResponse,
  ExperimentalDependentRelationsRequest,
  ExperimentalDiffSchemaRequest,
  ExperimentalReflectSchemaRequest,
  ExperimentalRegisterRelationshipCounterRequest,
  ExperimentalRegisterRelationshipCounterResponse,
  ExperimentalUnregisterRelationshipCounterRequest,
  ExperimentalUnregisterRelationshipCounterResponse,
} from "@benedb/protos/authzed/api/v1/experimental_service";
import { ErrorReason } from "@benedb/protos/authzed/api/v1/error_reason";
import {
  ExperimentalComputablePermissionsResponse,
  ExperimentalDependentRelationsResponse,
  ExperimentalDiffSchemaResponse,
  ExperimentalReflectSchemaResponse,
  ExpSchemaFilter,
} from "@benedb/protos/authzed/api/v1/experimental_service";
import type {
  CheckBulkPermissionsRequest,
  ExportBulkRelationshipsResponse,
  RelationshipFilter,
} from "@benedb/protos/authzed/api/v1/permission_service";
import {
  ComputablePermissionsResponse,
  DependentRelationsResponse,
  DiffSchemaResponse,
  ReflectionSchemaFilter,
  ReflectSchemaResponse,
} from "@benedb/protos/authzed/api/v1/schema_service";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import type { AuthzedPermissionsV1Service } from "./authzed-permissions-v1-service";
import type { AuthzedSchemaV1Service } from "./authzed-schema-v1-service";
import { mapAsyncStream } from "./mapped-async-stream-reader";
import { MappedServerStreamWriter } from "./mapped-server-stream-writer";
import { reshapeProto } from "./proto-reshape";
import { MAX_EXPERIMENTAL_BULK_EXPORT_RELATIONSHIPS_LIMIT } from "./request-ceilings";
import { validateRequest } from "./request-validation";
import { RpcError } from "./rpc-error";
import { rpcErrorWithReason } from "./rpc-errors";
import type { ServerStreamWriter } from "./server-stream-writer";

/**
 * Port of Spiceport `src/Spiceport.Api/AuthzedExperimentalV1Service.cs`: the gRPC front door for
 * `authzed.api.v1.ExperimentalService`. The relationship-counter RPCs are pure data-plane
 * operations delegated to the `IRelationshipsGrain`. Counts are computed on demand (resolve a
 * revision, look up the registered filter, count matching relationships at that snapshot, mint a
 * `read_at` ZedToken) - there is no async precomputation, so the response always carries the
 * `read_counter_value` arm and never `counter_still_calculating`.
 *
 * The remaining RPCs are, upstream (`internal/services/v1/experimental.go`), the same code paths as
 * their v1 replacements under older message names, so each is translated onto the v1 service:
 * BulkCheckPermission onto `AuthzedPermissionsV1Service.checkBulkPermissions`
 * (`toCheckBulkPermissionsRequest`/`toBulkCheckPermissionResponse`); BulkImportRelationships /
 * BulkExportRelationships onto Import/ExportBulkRelationships, the export with the experimental
 * server's larger `optional_limit` ceiling; and the `Experimental*` schema-tooling RPCs onto
 * `AuthzedSchemaV1Service`, re-typing its `Reflection*` messages as the wire-identical `Exp*` ones.
 *
 * Counter error mapping follows the SpiceDB reference (`internal/services/shared/errors.go`), which
 * maps BOTH `CounterAlreadyRegistered` and `CounterNotRegistered` to `FAILED_PRECONDITION`; the
 * kind discriminator the ported `CounterOperationException` carries is deliberately NOT used to
 * split them.
 *
 * Port decisions (the C# constructs with no TypeScript counterpart):
 *   * `RpcException(new Status(code, detail))` becomes {@link RpcError}.
 *   * `ServerCallContext` becomes a trailing `signal?: AbortSignal`, passed on to the v1 service
 *     wherever the C# passes `context` on.
 *   * `IAsyncStreamReader<T>` is an `AsyncIterable<T>` and `IServerStreamWriter<T>` a
 *     {@link ServerStreamWriter}, so the C#'s mapping wrappers become `mapAsyncStream` and
 *     {@link MappedServerStreamWriter}.
 *   * The C# reads `request.RelationshipFilter` knowing request validation has rejected an absent
 *     one; ts-proto still types it optional, so it is asserted present once, after validation.
 *   * `RelationshipCount` is uint64. The grains DTO carries a `bigint` and ts-proto renders the
 *     field as a STRING (`forceLong=string`), so it is `String(reply.count)` - never a JS
 *     `number`, which would round past 2^53.
 *   * The empty Register/Unregister responses are `{}`, ts-proto's `create()` for an empty message.
 *   * The C#'s `switch (pair.ResponseCase)` becomes two `!== undefined` tests: ts-proto renders
 *     the oneof as two optional fields, not a case enum. Its `default: throw` (Go: `panic`) is the
 *     final `else`.
 *   * {@link toWire} stays a LOCAL function. Its namesake in `authzed-permissions-v1-service.ts`
 *     differs (this one wraps a single `optional_resource_id` and a single `optional_subject_id`
 *     into one-element lists), and the C# maintains the two copies separately.
 */
export class AuthzedExperimentalV1Service {
  readonly #grains: GrainFactoryAccess;
  readonly #permissions: AuthzedPermissionsV1Service;
  readonly #schema: AuthzedSchemaV1Service;

  constructor(
    grains: GrainFactoryAccess,
    permissions: AuthzedPermissionsV1Service,
    schema: AuthzedSchemaV1Service,
  ) {
    this.#grains = grains;
    this.#permissions = permissions;
    this.#schema = schema;
  }

  /** `private IRelationshipsGrain Relationships => grains.GetGrain<...>(Key)` - a getter, as the C# is. */
  get #relationships(): IRelationshipsGrain {
    return this.#grains.getGrain(IRelationshipsGrainDefinition, RELATIONSHIPS_GRAIN_KEY);
  }

  /** Deprecated alias of CheckBulkPermissions: the same check under the older message names. */
  async bulkCheckPermission(
    request: BulkCheckPermissionRequest,
    signal?: AbortSignal | undefined,
  ): Promise<BulkCheckPermissionResponse> {
    validateRequest("BulkCheckPermissionRequest", request);

    const converted: CheckBulkPermissionsRequest = {
      consistency: request.consistency,
      items: request.items.map((item) => ({
        resource: item.resource,
        permission: item.permission,
        subject: item.subject,
        context: item.context,
      })),
      withTracing: false,
    };

    const result = await this.#permissions.checkBulkPermissionsCore(converted, signal);

    const response: BulkCheckPermissionResponse = { checkedAt: result.checkedAt, pairs: [] };
    for (const pair of result.pairs) {
      const mapped: BulkCheckPermissionPair = {
        request:
          pair.request === undefined
            ? undefined
            : {
                resource: pair.request.resource,
                permission: pair.request.permission,
                subject: pair.request.subject,
                context: pair.request.context,
              },
      };

      if (pair.item !== undefined) {
        mapped.item = {
          permissionship: pair.item.permissionship,
          partialCaveatInfo: pair.item.partialCaveatInfo,
        };
      } else if (pair.error !== undefined) {
        mapped.error = pair.error;
      } else {
        throw new Error("unknown CheckBulkPermissionsPair response: neither item nor error is set");
      }

      response.pairs.push(mapped);
    }

    return response;
  }

  /** Deprecated alias of ImportBulkRelationships. */
  async bulkImportRelationships(
    requestStream: AsyncIterable<BulkImportRelationshipsRequest>,
    signal?: AbortSignal | undefined,
  ): Promise<BulkImportRelationshipsResponse> {
    const reply = await this.#permissions.importBulk(
      mapAsyncStream(requestStream, (batch) => {
        validateRequest("BulkImportRelationshipsRequest", batch);
        return { relationships: batch.relationships };
      }),
      signal,
    );

    return { numLoaded: reply.numLoaded };
  }

  /** Deprecated alias of ExportBulkRelationships, with the experimental server's ceiling. */
  async bulkExportRelationships(
    request: BulkExportRelationshipsRequest,
    responseStream: ServerStreamWriter<BulkExportRelationshipsResponse>,
    signal?: AbortSignal | undefined,
  ): Promise<void> {
    validateRequest("BulkExportRelationshipsRequest", request);
    return this.#permissions.exportBulk(
      {
        consistency: request.consistency,
        optionalLimit: request.optionalLimit,
        optionalCursor: request.optionalCursor,
        optionalRelationshipFilter: request.optionalRelationshipFilter,
      },
      new MappedServerStreamWriter<
        ExportBulkRelationshipsResponse,
        BulkExportRelationshipsResponse
      >(responseStream, (page) => ({
        afterResultCursor: page.afterResultCursor,
        relationships: page.relationships,
      })),
      signal,
      MAX_EXPERIMENTAL_BULK_EXPORT_RELATIONSHIPS_LIMIT,
    );
  }

  /** `ReflectSchema` under the `Exp*` message names. */
  async experimentalReflectSchema(
    request: ExperimentalReflectSchemaRequest,
    signal?: AbortSignal | undefined,
  ): Promise<ExperimentalReflectSchemaResponse> {
    validateRequest("ExperimentalReflectSchemaRequest", request);

    const optionalFilters = request.optionalFilters.map((filter) =>
      reshapeProto(filter, ExpSchemaFilter, ReflectionSchemaFilter),
    );

    return reshapeProto(
      await this.#schema.reflectSchemaCore(
        { consistency: request.consistency, optionalFilters },
        signal,
      ),
      ReflectSchemaResponse,
      ExperimentalReflectSchemaResponse,
    );
  }

  /** `DiffSchema` under the `Exp*` message names. */
  async experimentalDiffSchema(
    request: ExperimentalDiffSchemaRequest,
    signal?: AbortSignal | undefined,
  ): Promise<ExperimentalDiffSchemaResponse> {
    validateRequest("ExperimentalDiffSchemaRequest", request);

    return reshapeProto(
      await this.#schema.diffSchemaCore(
        { consistency: request.consistency, comparisonSchema: request.comparisonSchema },
        signal,
      ),
      DiffSchemaResponse,
      ExperimentalDiffSchemaResponse,
    );
  }

  /** `ComputablePermissions` under the `Exp*` message names. */
  async experimentalComputablePermissions(
    request: ExperimentalComputablePermissionsRequest,
    signal?: AbortSignal | undefined,
  ): Promise<ExperimentalComputablePermissionsResponse> {
    validateRequest("ExperimentalComputablePermissionsRequest", request);

    return reshapeProto(
      await this.#schema.computablePermissionsCore(
        {
          consistency: request.consistency,
          definitionName: request.definitionName,
          relationName: request.relationName,
          optionalDefinitionNameFilter: request.optionalDefinitionNameFilter,
        },
        signal,
      ),
      ComputablePermissionsResponse,
      ExperimentalComputablePermissionsResponse,
    );
  }

  /** `DependentRelations` under the `Exp*` message names. */
  async experimentalDependentRelations(
    request: ExperimentalDependentRelationsRequest,
    signal?: AbortSignal | undefined,
  ): Promise<ExperimentalDependentRelationsResponse> {
    validateRequest("ExperimentalDependentRelationsRequest", request);

    return reshapeProto(
      await this.#schema.dependentRelationsCore(
        {
          consistency: request.consistency,
          definitionName: request.definitionName,
          permissionName: request.permissionName,
        },
        signal,
      ),
      DependentRelationsResponse,
      ExperimentalDependentRelationsResponse,
    );
  }

  /** Registers a named relationship counter over the given filter. */
  async experimentalRegisterRelationshipCounter(
    request: ExperimentalRegisterRelationshipCounterRequest,
    _signal?: AbortSignal | undefined,
  ): Promise<ExperimentalRegisterRelationshipCounterResponse> {
    validateRequest("ExperimentalRegisterRelationshipCounterRequest", request);
    requireName(request.name);

    // The validation above rejects a request without its required relationship_filter.
    const relationshipFilter = request.relationshipFilter as RelationshipFilter;

    try {
      await this.#relationships.registerRelationshipCounter({
        name: request.name,
        filter: toWire(relationshipFilter),
      });
    } catch (error) {
      if (error instanceof CounterOperationException) {
        throw toRpc(error, request.name, relationshipFilter);
      }
      if (error instanceof SequencerOverloadedException) {
        // The per-silo admission gate shed this commit - the sequencer is saturated. A deliberate,
        // retryable overload signal (back off and retry), never an opaque timeout.
        throw new RpcError(status.RESOURCE_EXHAUSTED, error.message);
      }
      throw error;
    }

    return {};
  }

  /** Tombstones the named counter. */
  async experimentalUnregisterRelationshipCounter(
    request: ExperimentalUnregisterRelationshipCounterRequest,
    _signal?: AbortSignal | undefined,
  ): Promise<ExperimentalUnregisterRelationshipCounterResponse> {
    validateRequest("ExperimentalUnregisterRelationshipCounterRequest", request);
    requireName(request.name);

    try {
      await this.#relationships.unregisterRelationshipCounter({ name: request.name });
    } catch (error) {
      if (error instanceof CounterOperationException) {
        throw toRpc(error, request.name, undefined);
      }
      if (error instanceof SequencerOverloadedException) {
        // Sequencer overload shed by the admission gate: retryable RESOURCE_EXHAUSTED.
        throw new RpcError(status.RESOURCE_EXHAUSTED, error.message);
      }
      throw error;
    }

    return {};
  }

  /**
   * Counts the relationships matching the named counter's filter, on demand.
   *
   * ASYMMETRY, reproduced: unlike its two siblings this RPC has NO `SequencerOverloadedException`
   * catch (it is a read, never admitted through the gate), so an overload escapes unwrapped.
   */
  async experimentalCountRelationships(
    request: ExperimentalCountRelationshipsRequest,
    _signal?: AbortSignal | undefined,
  ): Promise<ExperimentalCountRelationshipsResponse> {
    validateRequest("ExperimentalCountRelationshipsRequest", request);
    requireName(request.name);

    let reply;
    try {
      reply = await this.#relationships.countRelationships({ name: request.name });
    } catch (error) {
      if (error instanceof CounterOperationException) {
        throw toRpc(error, request.name, undefined);
      }
      throw error;
    }

    // On-demand: the value is always available, so always emit the read_counter_value arm.
    return {
      readCounterValue: {
        relationshipCount: String(reply.count),
        readAt: { token: reply.readAtToken },
      },
    };
  }
}

/**
 * Maps an authzed v1 `RelationshipFilter` to the grain's filter wire. The v1 filter carries a
 * single optional resource id (not a list) and a nested optional subject filter.
 */
function toWire(f: RelationshipFilter): RelationshipsFilterWire {
  const resourceIds: readonly string[] | undefined = isNullOrEmpty(f.optionalResourceId)
    ? undefined
    : [f.optionalResourceId];

  let subjectType: string | undefined;
  let subjectId: string | undefined;
  let subjectRelation: string | undefined;
  const sf = f.optionalSubjectFilter;
  if (sf !== undefined) {
    subjectType = nullIfEmpty(sf.subjectType);
    subjectId = nullIfEmpty(sf.optionalSubjectId);
    subjectRelation =
      sf.optionalRelation !== undefined ? nullIfEmpty(sf.optionalRelation.relation) : undefined;
  }

  return {
    resourceType: nullIfEmpty(f.resourceType),
    resourceIdPrefix: nullIfEmpty(f.optionalResourceIdPrefix),
    resourceIds,
    resourceRelation: nullIfEmpty(f.optionalRelation),
    subjectType,
    subjectIds: subjectId === undefined ? undefined : [subjectId],
    subjectRelation,
  };
}

/** C# `NullIfEmpty`: `string.IsNullOrEmpty(value) ? null : value`. */
function nullIfEmpty(value: string | undefined): string | undefined {
  return isNullOrEmpty(value) ? undefined : value;
}

function isNullOrEmpty(value: string | undefined): value is undefined | "" {
  return value === undefined || value.length === 0;
}

/**
 * Both counter failures map to FAILED_PRECONDITION, matching the SpiceDB reference, with the
 * `ErrorInfo` `rewriteError` gives `CounterAlreadyRegisteredError` (the counter name and the NEW
 * filter, every field present) and `CounterNotRegisteredError` (the counter name).
 */
function toRpc(
  ex: CounterOperationException,
  name: string,
  filter: RelationshipFilter | undefined,
): RpcError {
  if (ex.kind !== "alreadyRegistered" || filter === undefined)
    return rpcErrorWithReason(
      status.FAILED_PRECONDITION,
      ex.message,
      ErrorReason.ERROR_REASON_COUNTER_NOT_REGISTERED,
      [["counter_name", name]],
    );

  const subjectFilter = filter.optionalSubjectFilter;
  return rpcErrorWithReason(
    status.FAILED_PRECONDITION,
    ex.message,
    ErrorReason.ERROR_REASON_COUNTER_ALREADY_REGISTERED,
    [
      ["counter_name", name],
      ["new_filter_resource_type", filter.resourceType],
      ["new_filter_resource_id", filter.optionalResourceId],
      ["new_filter_resource_id_prefix", filter.optionalResourceIdPrefix],
      ["new_filter_relation", filter.optionalRelation],
      ["new_filter_subject_type", subjectFilter?.subjectType ?? ""],
      ["new_filter_subject_id", subjectFilter?.optionalSubjectId ?? ""],
      ["new_filter_subject_relation", subjectFilter?.optionalRelation?.relation ?? ""],
    ],
  );
}

/**
 * SpiceDB's counter handlers reject an empty name themselves (the name pattern admits the empty
 * string): INVALID_ARGUMENT, "name must be provided", reason UNSPECIFIED.
 */
function requireName(name: string): void {
  if (name === "")
    throw rpcErrorWithReason(
      status.INVALID_ARGUMENT,
      "name must be provided",
      ErrorReason.ERROR_REASON_UNSPECIFIED,
    );
}
