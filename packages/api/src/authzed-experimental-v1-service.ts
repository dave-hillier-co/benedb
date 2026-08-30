import { status } from "@grpc/grpc-js";
import type { IRelationshipsGrain } from "@spacedb/grains/i-relationships-grain";
import {
  IRelationshipsGrain as IRelationshipsGrainDefinition,
  RELATIONSHIPS_GRAIN_KEY,
} from "@spacedb/grains/i-relationships-grain";
import type { ISchemaProvider } from "@spacedb/grains/i-schema-provider";
import type { RelationshipsFilterWire } from "@spacedb/grains/relationships-dtos";
import { CounterOperationException } from "@spacedb/grains/relationships-dtos";
import { SequencerOverloadedException } from "@spacedb/grains/sequencer-overloaded-exception";
import type {
  ExperimentalCountRelationshipsRequest,
  ExperimentalCountRelationshipsResponse,
  ExperimentalRegisterRelationshipCounterRequest,
  ExperimentalRegisterRelationshipCounterResponse,
  ExperimentalUnregisterRelationshipCounterRequest,
  ExperimentalUnregisterRelationshipCounterResponse,
} from "@spacedb/protos/authzed/api/v1/experimental_service";
import type { RelationshipFilter } from "@spacedb/protos/authzed/api/v1/permission_service";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import { RpcError } from "./rpc-error";

/**
 * Port of Spiceport `src/Spiceport.Api/AuthzedExperimentalV1Service.cs`: the gRPC front door for
 * `authzed.api.v1.ExperimentalService`. Only the relationship-counter RPCs are implemented; they
 * are pure data-plane operations delegated to the `IRelationshipsGrain`. Counts are computed on
 * demand (resolve a revision, look up the registered filter, count matching relationships at that
 * snapshot, mint a `read_at` ZedToken) - there is no async precomputation, so the response always
 * carries the `read_counter_value` arm and never `counter_still_calculating`.
 *
 * Error mapping follows the SpiceDB reference (`internal/services/shared/errors.go`), which maps
 * BOTH `CounterAlreadyRegistered` and `CounterNotRegistered` to `FAILED_PRECONDITION`; the kind
 * discriminator the ported `CounterOperationException` carries is deliberately NOT used to split
 * them.
 *
 * Port decisions (the C# constructs with no TypeScript counterpart):
 *   * THE REMAINING RPCs. The C# inherits `ExperimentalService.ExperimentalServiceBase`, whose
 *     generated members answer UNIMPLEMENTED for everything this class does not override.
 *     `@grpc/grpc-js` has no such base: it is handed an `UntypedServiceImplementation` map, and a
 *     method with no handler is answered UNIMPLEMENTED by the server itself. So the port registers
 *     ONLY these three methods in the host wiring and relies on grpc-js's own UNIMPLEMENTED for
 *     the rest, rather than writing throw-stubs the C# does not have. This class therefore carries
 *     the three methods and nothing else, exactly as the C# body does.
 *   * `RpcException(new Status(code, detail))` becomes {@link RpcError}.
 *   * `ServerCallContext` becomes a trailing `signal?: AbortSignal`; the C# reads nothing off it
 *     here, so nothing is passed on.
 *   * `request.RelationshipFilter is null` is `=== undefined`: ts-proto renders an absent
 *     submessage as `undefined`.
 *   * `RelationshipCount` is uint64. The grains DTO carries a `bigint` and ts-proto renders the
 *     field as a STRING (`forceLong=string`), so it is `String(reply.count)` - never a JS
 *     `number`, which would round past 2^53.
 *   * The empty Register/Unregister responses are `{}`, ts-proto's `create()` for an empty message.
 *   * {@link toWire} stays a LOCAL function. Its namesake in `authzed-permissions-v1-service.ts`
 *     differs (this one wraps a single `optional_resource_id` and a single `optional_subject_id`
 *     into one-element lists), and the C# maintains the two copies separately.
 */
export class AuthzedExperimentalV1Service {
  readonly #grains: GrainFactoryAccess;

  // `private readonly ISchemaProvider _schema = schema;` (line 24): accepted to mirror the sibling
  // v1 service constructor pattern, but counters need only the grain, so it is never read. The C#'s
  // own justification stands in for a lint suppression rather than dropping the parameter.
  // eslint-disable-next-line no-unused-private-class-members
  readonly #schema: ISchemaProvider;

  constructor(grains: GrainFactoryAccess, schema: ISchemaProvider) {
    this.#grains = grains;
    this.#schema = schema;
  }

  /** `private IRelationshipsGrain Relationships => grains.GetGrain<...>(Key)` - a getter, as the C# is. */
  get #relationships(): IRelationshipsGrain {
    return this.#grains.getGrain(IRelationshipsGrainDefinition, RELATIONSHIPS_GRAIN_KEY);
  }

  /** Registers a named relationship counter over the given filter. */
  async experimentalRegisterRelationshipCounter(
    request: ExperimentalRegisterRelationshipCounterRequest,
    _signal?: AbortSignal | undefined,
  ): Promise<ExperimentalRegisterRelationshipCounterResponse> {
    if (request.relationshipFilter === undefined) {
      throw new RpcError(status.INVALID_ARGUMENT, "relationship_filter is required");
    }

    try {
      await this.#relationships.registerRelationshipCounter({
        name: request.name,
        filter: toWire(request.relationshipFilter),
      });
    } catch (error) {
      if (error instanceof CounterOperationException) {
        throw toRpc(error);
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
    try {
      await this.#relationships.unregisterRelationshipCounter({ name: request.name });
    } catch (error) {
      if (error instanceof CounterOperationException) {
        throw toRpc(error);
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
    let reply;
    try {
      reply = await this.#relationships.countRelationships({ name: request.name });
    } catch (error) {
      if (error instanceof CounterOperationException) {
        throw toRpc(error);
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

/** Both counter failures map to FAILED_PRECONDITION, matching the SpiceDB reference. */
function toRpc(ex: CounterOperationException): RpcError {
  return new RpcError(status.FAILED_PRECONDITION, ex.message);
}
