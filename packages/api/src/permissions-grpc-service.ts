import { status } from "@grpc/grpc-js";
import type { CaveatEvaluationErrorKind } from "@benedb/core/caveat-evaluation-exception";
import { CaveatEvaluationException } from "@benedb/core/caveat-evaluation-exception";
import { ELLIPSIS } from "@benedb/core/core-constants";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { InvalidConsistencyTokenException } from "@benedb/core/invalid-consistency-token-exception";
import { MaxDepthExceededException } from "@benedb/core/max-depth-exceeded-exception";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { ConsistencyWire } from "@benedb/grains/consistency-wire";
import {
  consistencyWireToRequirement,
  MINIMIZE_LATENCY_WIRE,
} from "@benedb/grains/consistency-wire";
import { DispatchFailedException } from "@benedb/grains/dispatch-failed-exception";
import type { BatchCheckItem, IPermissionChecker } from "@benedb/grains/i-permission-checker";
import type { IRelationshipsGrain } from "@benedb/grains/i-relationships-grain";
import {
  IRelationshipsGrain as IRelationshipsGrainDefinition,
  RELATIONSHIPS_GRAIN_KEY,
} from "@benedb/grains/i-relationships-grain";
import { PreconditionFailedException } from "@benedb/grains/precondition-failed-exception";
import type { RelationshipReads } from "@benedb/grains/relationship-reads";
import type {
  PreconditionWire,
  RelationshipsFilterWire,
  RelationshipStreamItem,
  RelationshipUpdateOpWire,
  RelationshipUpdateWire,
  RelationshipWire,
} from "@benedb/grains/relationships-dtos";
import type { ReverseOps } from "@benedb/grains/reverse-ops";
import type {
  ExpandModeWire,
  ExpandSubjectWire,
  ExpandTreeNodeWire,
  ExpandTreeReply,
  FoundResourceWire,
  FoundSubjectStreamItem,
  FoundSubjectWire,
  Permissionship as PermissionshipWire,
  SetOpWire,
} from "@benedb/grains/reverse-ops-dtos";
import { SchemaWriteValidationException } from "@benedb/grains/schema-write-validation-exception";
import { SequencerOverloadedException } from "@benedb/grains/sequencer-overloaded-exception";
import type {
  BatchCheckPermissionRequest,
  BatchCheckPermissionResponse,
  CheckPermissionRequest,
  CheckPermissionResponse,
  Consistency,
  DeleteRelationshipsRequest,
  DeleteRelationshipsResponse,
  ExpandPermissionTreeRequest,
  ExpandPermissionTreeResponse,
  LookupResourcesRequest,
  LookupResourcesResponse,
  LookupSubjectsRequest,
  LookupSubjectsResponse,
  ObjectReference,
  Precondition,
  PermissionTreeNode,
  PermissionTreeNode_DirectSubject,
  Permissionship,
  ReadRelationshipsRequest,
  ReadRelationshipsResponse,
  ReadSchemaRequest,
  ReadSchemaResponse,
  Relationship,
  RelationshipFilter,
  RelationshipUpdate,
  SubjectReference,
  WriteRelationshipsRequest,
  WriteRelationshipsResponse,
  WriteSchemaRequest,
  WriteSchemaResponse,
} from "@benedb/protos/permissions";
import {
  CheckPermissionResponse_Permissionship,
  ExpandPermissionTreeRequest_ExpandMode,
  PermissionTreeNode_SetOpNode_Operation,
  Permissionship_Kind,
  Precondition_Operation,
  RelationshipUpdate_Operation,
} from "@benedb/protos/permissions";
import type { Membership } from "@benedb/engine/membership";
import { SchemaCompileException } from "@benedb/schema/schema-compile-exception";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import { RpcError } from "./rpc-error";

/**
 * Port of Spiceport `src/Spiceport.Api/PermissionsGrpcService.cs`: the `spiceport.v0` gRPC front
 * door. It translates the proto request into a top-level permission check dispatched across the
 * grain mesh, and maps the verdict back to proto. The reverse / tree ops run in-process through
 * {@link ReverseOps}, and the relationship reads through {@link RelationshipReads}; nothing in this
 * file re-implements engine or datastore logic.
 *
 * Port decisions (the C# constructs with no TypeScript counterpart):
 *   * `ServerCallContext` becomes an optional `AbortSignal` parameter - the C# reads nothing off
 *     the context except `CancellationToken`.
 *   * `RpcException(new Status(code, detail))` becomes {@link RpcError}, which is what
 *     `@grpc/grpc-js` consumes as a `ServiceError`.
 *   * `int64`/`uint64` fields arrive as STRINGS (ts-proto `forceLong=string`), so
 *     `deleted_count` renders through `String(bigint)` and `optional_expires_at_unix_seconds`
 *     through `BigInt(...)` - never a JS `number`, which would round past 2^53.
 *   * The grains DTOs carry expiration as epoch NANOS `bigint`, so seconds convert with
 *     `* 1_000_000_000n` / `/ 1_000_000_000n`. BigInt division truncates toward ZERO where
 *     `DateTimeOffset.ToUnixTimeSeconds` floors; the two differ only for a sub-second pre-1970
 *     expiration.
 *   * `DateTimeOffset.FromUnixTimeSeconds` throws outside `[-62135596800, 253402300799]`; the port
 *     keeps that guard explicitly (an epoch-nanos bigint would otherwise accept any magnitude) and,
 *     as in the C#, the conversion runs BEFORE the try block, so the failure escapes unmapped.
 *   * A ts-proto `Struct` field arrives auto-unwrapped as a plain object while the grains DTOs take
 *     a `ReadonlyMap`, so the conversion is object <-> `Map` at every level. A `Map` - never a
 *     plain object - so `objectToValue` cannot confuse a context dictionary with a list and so
 *     prototype keys like `__proto__` stay ordinary entries.
 *   * A submessage the C# dereferences unconditionally (`request.Subject.Object`) is `undefined`
 *     here rather than a null reference, so {@link deref} throws a `TypeError` where the C# would
 *     throw a `NullReferenceException`. Both surface as an unmapped server fault.
 *   * The C# overload sets (`ToWire`, `ToProto`) become distinctly named free functions.
 */
export class PermissionsGrpcService {
  readonly #checker: IPermissionChecker;
  readonly #grains: GrainFactoryAccess;
  readonly #reverseOps: ReverseOps;
  readonly #relationshipReads: RelationshipReads;

  constructor(
    checker: IPermissionChecker,
    grains: GrainFactoryAccess,
    reverseOps: ReverseOps,
    relationshipReads: RelationshipReads,
  ) {
    this.#checker = checker;
    this.#grains = grains;
    this.#reverseOps = reverseOps;
    this.#relationshipReads = relationshipReads;
  }

  /** `private IRelationshipsGrain Relationships => grains.GetGrain<...>(Key)` - a getter, as the C# is. */
  get #relationships(): IRelationshipsGrain {
    return this.#grains.getGrain(IRelationshipsGrainDefinition, RELATIONSHIPS_GRAIN_KEY);
  }

  /** Checks a single permission and maps the verdict onto the proto permissionship. */
  async checkPermission(
    request: CheckPermissionRequest,
    signal?: AbortSignal | undefined,
  ): Promise<CheckPermissionResponse> {
    const requestSubject = request.subject ?? EMPTY_SUBJECT_REFERENCE;
    const subjectRelation = isNullOrEmpty(requestSubject.optionalRelation)
      ? ELLIPSIS
      : requestSubject.optionalRelation;

    const subjectObject = requestSubject.object ?? EMPTY_OBJECT_REFERENCE;
    const subject: ObjectAndRelation = {
      objectType: subjectObject.objectType,
      objectId: subjectObject.objectId,
      relation: subjectRelation,
    };

    const resource = request.resource ?? EMPTY_OBJECT_REFERENCE;

    try {
      const result = await this.#checker.check(
        resource.objectType,
        resource.objectId,
        request.permission,
        subject,
        structToMap(request.context),
        consistencyWireToRequirement(toWireConsistency(request.consistency)),
        signal,
      );

      const response: CheckPermissionResponse = {
        permissionship: toProtoCheckPermissionship(result.verdict),
        partialCaveatMissingFields: [...result.missingFields],
        checkedAt: { token: result.evaluatedToken },
      };
      return response;
    } catch (ex) {
      if (ex instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof RevisionNotFoundException) {
        // The pinned revision has been garbage-collected (or never existed): same client-facing
        // contract as an invalid consistency token.
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof MaxDepthExceededException) {
        throw new RpcError(status.FAILED_PRECONDITION, ex.message);
      }
      if (ex instanceof CaveatEvaluationException) {
        throw new RpcError(caveatStatus(ex.kind), ex.message);
      }
      if (ex instanceof DispatchFailedException) {
        throw toRpc(ex);
      }
      throw ex;
    }
  }

  /**
   * Checks a batch of items against ONE pinned revision, pairing each verdict with the ORIGINAL
   * request item by index.
   *
   * Note the deliberate asymmetry with {@link checkPermission}: there is no
   * `CaveatEvaluationException` filter here, so such a failure escapes the RPC unmapped. That is
   * the C#'s behaviour and is reproduced.
   */
  async batchCheckPermission(
    request: BatchCheckPermissionRequest,
    signal?: AbortSignal | undefined,
  ): Promise<BatchCheckPermissionResponse> {
    const items = request.items.map((it): BatchCheckItem => {
      const itemSubject = it.subject ?? EMPTY_SUBJECT_REFERENCE;
      const subjectRelation = isNullOrEmpty(itemSubject.optionalRelation)
        ? ELLIPSIS
        : itemSubject.optionalRelation;
      const subjectObject = itemSubject.object ?? EMPTY_OBJECT_REFERENCE;
      const itemResource = it.resource ?? EMPTY_OBJECT_REFERENCE;
      return {
        resourceType: itemResource.objectType,
        resourceId: itemResource.objectId,
        permission: it.permission,
        subject: {
          objectType: subjectObject.objectType,
          objectId: subjectObject.objectId,
          relation: subjectRelation,
        },
        caveatContext: structToMap(it.context),
      };
    });

    try {
      const result = await this.#checker.batchCheck(
        items,
        consistencyWireToRequirement(toWireConsistency(request.consistency)),
        signal,
      );

      const response: BatchCheckPermissionResponse = {
        pairs: [],
        checkedAt: { token: result.evaluatedToken },
      };
      for (let i = 0; i < result.items.length; i += 1) {
        const verdict = result.items[i] as (typeof result.items)[number];
        response.pairs.push({
          request: request.items[i],
          item: {
            permissionship: toProtoCheckPermissionship(verdict.verdict),
            partialCaveatMissingFields: [...verdict.missingFields],
          },
        });
      }
      return response;
    } catch (ex) {
      if (ex instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof RevisionNotFoundException) {
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof DispatchFailedException) {
        throw toRpc(ex);
      }
      throw ex;
    }
  }

  /** Compiles and commits a schema, or maps the rejection onto its deliberately chosen status. */
  async writeSchema(request: WriteSchemaRequest): Promise<WriteSchemaResponse> {
    try {
      const reply = await this.#relationships.writeSchema({ schemaText: request.schema });
      return { writtenAt: { token: reply.writtenAtToken } };
    } catch (ex) {
      // The grain surfaces a compile failure as a serializable argument error across the grain
      // boundary; in-process calls may still see SchemaCompileException directly.
      if (ex instanceof SchemaCompileException || ex instanceof InvalidArgumentError) {
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof SchemaWriteValidationException) {
        // The change would orphan existing relationships: reject and commit nothing.
        throw new RpcError(status.FAILED_PRECONDITION, ex.message);
      }
      if (ex instanceof SequencerOverloadedException) {
        // The per-silo admission gate shed this commit - the sequencer is saturated. A deliberate,
        // retryable overload signal (back off and retry), never an opaque timeout.
        throw new RpcError(status.RESOURCE_EXHAUSTED, ex.message);
      }
      throw ex;
    }
  }

  /**
   * Returns the current schema text. Deliberately unlike the authzed v1 service, an EMPTY schema is
   * returned as an empty response rather than raised as NOT_FOUND.
   */
  async readSchema(request: ReadSchemaRequest): Promise<ReadSchemaResponse> {
    void request;
    const reply = await this.#relationships.readSchema();
    return {
      schemaText: reply.schemaText,
      readAt: { token: reply.readAtToken },
    };
  }

  /** Applies a batch of relationship updates under any preconditions. */
  async writeRelationships(
    request: WriteRelationshipsRequest,
  ): Promise<WriteRelationshipsResponse> {
    const updates = request.updates.map(toWireRelationshipUpdate);
    const preconditions = toWirePreconditions(request.optionalPreconditions);
    try {
      const reply = await this.#relationships.writeRelationships({ updates, preconditions });
      return { writtenAt: { token: reply.writtenAtToken } };
    } catch (ex) {
      if (ex instanceof PreconditionFailedException) {
        throw new RpcError(status.FAILED_PRECONDITION, ex.message);
      }
      if (ex instanceof SequencerOverloadedException) {
        // Sequencer overload shed by the admission gate: retryable RESOURCE_EXHAUSTED.
        throw new RpcError(status.RESOURCE_EXHAUSTED, ex.message);
      }
      throw ex;
    }
  }

  /** Reads one page of relationships, plus the continuation cursor the {@link drain} contract mints. */
  async readRelationships(
    request: ReadRelationshipsRequest,
    signal?: AbortSignal | undefined,
  ): Promise<ReadRelationshipsResponse> {
    // `(int)request.OptionalLimit` on a proto uint32: C# is unchecked, so a value above
    // int.MaxValue WRAPS NEGATIVE. `| 0` is that same narrowing and is the identity for every
    // value a real client sends; without it the port would accept a 3-billion limit the C#
    // fast-fails on.
    const limit = request.optionalLimit === 0 ? undefined : request.optionalLimit | 0;
    let items: readonly RelationshipStreamItem[];
    let cursor: string | undefined;
    try {
      ({ items, cursor } = await drain(
        this.#relationshipReads.readRelationships(
          {
            filter: toWireFilter(request.filter ?? EMPTY_RELATIONSHIP_FILTER),
            limit,
            cursor: nullIfEmpty(request.optionalCursor),
            consistency: toWireConsistency(request.consistency),
          },
          signal,
        ),
        limit,
        (i) => i.resumeCursor,
        signal,
      ));
    } catch (ex) {
      if (ex instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof RevisionNotFoundException) {
        // The pinned revision has been garbage-collected (or never existed): same client-facing
        // contract as an invalid consistency token.
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      throw ex;
    }

    return {
      relationships: items.map((i) => toProtoRelationship(i.relationship)),
      afterResultCursor: cursor ?? "",
      readAt: { token: items.length > 0 ? (items[0]?.readAtToken ?? "") : "" },
    };
  }

  /** Deletes the relationships matching a filter, under any preconditions. */
  async deleteRelationships(
    request: DeleteRelationshipsRequest,
  ): Promise<DeleteRelationshipsResponse> {
    try {
      const reply = await this.#relationships.deleteRelationships({
        filter: toWireFilter(request.filter ?? EMPTY_RELATIONSHIP_FILTER),
        optionalLimit: request.optionalLimit === 0 ? undefined : BigInt(request.optionalLimit),
        preconditions: toWirePreconditions(request.optionalPreconditions),
      });

      return {
        deletedCount: String(reply.deletedCount),
        reachedLimit: reply.reachedLimit,
        deletedAt: { token: reply.deletedAtToken },
      };
    } catch (ex) {
      if (ex instanceof PreconditionFailedException) {
        throw new RpcError(status.FAILED_PRECONDITION, ex.message);
      }
      if (ex instanceof SequencerOverloadedException) {
        // Sequencer overload shed by the admission gate: retryable RESOURCE_EXHAUSTED.
        throw new RpcError(status.RESOURCE_EXHAUSTED, ex.message);
      }
      throw ex;
    }
  }

  /** Expands a permission into its subject tree. */
  async expandPermissionTree(
    request: ExpandPermissionTreeRequest,
  ): Promise<ExpandPermissionTreeResponse> {
    const mode: ExpandModeWire =
      request.mode === ExpandPermissionTreeRequest_ExpandMode.EXPAND_MODE_RECURSIVE
        ? "recursive"
        : "shallow";

    const resource = request.resource ?? EMPTY_OBJECT_REFERENCE;
    let reply: ExpandTreeReply;
    try {
      reply = await this.#reverseOps.expandPermissionTree({
        resourceType: resource.objectType,
        resourceId: resource.objectId,
        permission: request.permission,
        mode,
        consistency: toWireConsistency(request.consistency),
      });
    } catch (ex) {
      if (ex instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof RevisionNotFoundException) {
        // The pinned revision has been garbage-collected (or never existed): same client-facing
        // contract as an invalid consistency token.
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof DispatchFailedException) {
        throw toRpc(ex);
      }
      throw ex;
    }

    return {
      treeRoot: toProtoTreeNode(reply.root),
      expandedAt: { token: reply.expandedAtToken ?? "" },
    };
  }

  /** Looks up one page of subjects holding the permission on the resource. */
  async lookupSubjects(
    request: LookupSubjectsRequest,
    signal?: AbortSignal | undefined,
  ): Promise<LookupSubjectsResponse> {
    const subjectRelation = isNullOrEmpty(request.optionalSubjectRelation)
      ? ELLIPSIS
      : request.optionalSubjectRelation;

    const resource = request.resource ?? EMPTY_OBJECT_REFERENCE;
    // `(int)request.OptionalLimit` on a proto uint32: C# is unchecked, so a value above
    // int.MaxValue WRAPS NEGATIVE. `| 0` is that same narrowing and is the identity for every
    // value a real client sends; without it the port would accept a 3-billion limit the C#
    // fast-fails on.
    const limit = request.optionalLimit === 0 ? undefined : request.optionalLimit | 0;
    let items: readonly FoundSubjectStreamItem[];
    let cursor: string | undefined;
    try {
      ({ items, cursor } = await drain(
        this.#reverseOps.streamLookupSubjects(
          {
            resourceType: resource.objectType,
            resourceId: resource.objectId,
            permission: request.permission,
            subjectType: request.subjectObjectType,
            subjectRelation,
            context: structToMap(request.context),
            limit,
            cursor: nullIfEmpty(request.optionalCursor),
            consistency: toWireConsistency(request.consistency),
          },
          signal,
        ),
        limit,
        (i) => i.resumeCursor,
        signal,
      ));
    } catch (ex) {
      if (ex instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof RevisionNotFoundException) {
        // The pinned revision has been garbage-collected (or never existed): same client-facing
        // contract as an invalid consistency token.
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof CaveatEvaluationException) {
        throw new RpcError(caveatStatus(ex.kind), ex.message);
      }
      if (ex instanceof DispatchFailedException) {
        throw toRpc(ex);
      }
      throw ex;
    }

    return {
      subjects: items.map((i) => toProtoFoundSubject(i.subject)),
      afterResultCursor: cursor ?? "",
      lookedUpAt: { token: items.length > 0 ? (items[0]?.lookedUpAtToken ?? "") : "" },
    };
  }

  /** Looks up one page of resources on which the subject holds the permission. */
  async lookupResources(
    request: LookupResourcesRequest,
    signal?: AbortSignal | undefined,
  ): Promise<LookupResourcesResponse> {
    const requestSubject = request.subject ?? EMPTY_SUBJECT_REFERENCE;
    const subjectRelation = isNullOrEmpty(requestSubject.optionalRelation)
      ? ELLIPSIS
      : requestSubject.optionalRelation;

    const subjectObject = requestSubject.object ?? EMPTY_OBJECT_REFERENCE;
    // `(int)request.OptionalLimit` on a proto uint32: C# is unchecked, so a value above
    // int.MaxValue WRAPS NEGATIVE. `| 0` is that same narrowing and is the identity for every
    // value a real client sends; without it the port would accept a 3-billion limit the C#
    // fast-fails on.
    const limit = request.optionalLimit === 0 ? undefined : request.optionalLimit | 0;
    let items: readonly FoundResourceWire[];
    let cursor: string | undefined;
    try {
      ({ items, cursor } = await drain(
        this.#reverseOps.streamLookupResources(
          {
            resourceType: request.resourceObjectType,
            permission: request.permission,
            subjectType: subjectObject.objectType,
            subjectId: subjectObject.objectId,
            subjectRelation,
            context: structToMap(request.context),
            limit,
            cursor: nullIfEmpty(request.optionalCursor),
            consistency: toWireConsistency(request.consistency),
          },
          signal,
        ),
        limit,
        (r) => r.afterResultCursor,
        signal,
      ));
    } catch (ex) {
      if (ex instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof RevisionNotFoundException) {
        // The pinned revision has been garbage-collected (or never existed): same client-facing
        // contract as an invalid consistency token.
        throw new RpcError(status.INVALID_ARGUMENT, ex.message);
      }
      if (ex instanceof CaveatEvaluationException) {
        throw new RpcError(caveatStatus(ex.kind), ex.message);
      }
      if (ex instanceof DispatchFailedException) {
        throw toRpc(ex);
      }
      throw ex;
    }

    return {
      resources: items.map(toProtoFoundResource),
      afterResultCursor: cursor ?? "",
      lookedUpAt: { token: items.length > 0 ? (items[0]?.lookedUpAtToken ?? "") : "" },
    };
  }
}

/** One drained page: the kept items and the continuation cursor, if any. */
interface DrainedPage<T> {
  readonly items: readonly T[];
  readonly cursor: string | undefined;
}

/**
 * Drains an in-process stream up to `limit` items. When a further item exists beyond the limit, the
 * LAST KEPT item's cursor is returned as the continuation cursor (mirroring the prior grain's "one
 * extra row detects more" paging); an unlimited (undefined) drain returns no cursor.
 *
 * The limit is checked BEFORE the item is added, so a page that exactly fills the limit with
 * nothing beyond it returns an EMPTY cursor and the client makes one more round trip.
 */
async function drain<T>(
  stream: AsyncIterable<T>,
  limit: number | undefined,
  cursorOf: (item: T) => string | undefined,
  signal?: AbortSignal | undefined,
): Promise<DrainedPage<T>> {
  const items: T[] = [];
  let cursor: string | undefined;
  for await (const item of stream) {
    // `stream.WithCancellation(ct)`.
    signal?.throwIfAborted();
    if (limit !== undefined && items.length >= limit) {
      cursor = cursorOf(items[items.length - 1] as T);
      break;
    }
    items.push(item);
  }
  return { items, cursor };
}

/**
 * Maps a cross-silo dispatch failure surfaced by the dispatcher onto its deliberately chosen gRPC
 * status (cf. SpiceDB `rewriteError`): transient transport/silo-availability is retriable
 * `UNAVAILABLE`; cancellation is `CANCELLED`; a deadline is `DEADLINE_EXCEEDED`; anything else is
 * `INTERNAL`.
 */
function toRpc(ex: DispatchFailedException): RpcError {
  switch (ex.code) {
    case "unavailable":
      return new RpcError(status.UNAVAILABLE, ex.message);
    case "cancelled":
      return new RpcError(status.CANCELLED, ex.message);
    case "deadlineExceeded":
      return new RpcError(status.DEADLINE_EXCEEDED, ex.message);
    default:
      return new RpcError(status.INTERNAL, ex.message);
  }
}

/** `ParameterTypeMismatch` is a client error; every other kind is a precondition failure. */
function caveatStatus(kind: CaveatEvaluationErrorKind): status {
  return kind === "parameterTypeMismatch" ? status.INVALID_ARGUMENT : status.FAILED_PRECONDITION;
}

/** Maps a membership verdict onto the proto permissionship. */
function toProtoCheckPermissionship(verdict: Membership): CheckPermissionResponse_Permissionship {
  switch (verdict) {
    case "member":
      return CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION;
    case "caveated":
      return CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION;
    default:
      return CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION;
  }
}

/** `preconditions.Count == 0 ? null : ...`, mapping every non-MUST_NOT_MATCH operation to MUST_MATCH. */
function toWirePreconditions(
  preconditions: readonly Precondition[],
): readonly PreconditionWire[] | undefined {
  if (preconditions.length === 0) {
    return undefined;
  }

  return preconditions.map((p) => ({
    // UNSPECIFIED silently means MUST_MATCH on this surface; the v1 service instead rejects it.
    operation:
      p.operation === Precondition_Operation.OPERATION_MUST_NOT_MATCH
        ? ("mustNotMatch" as const)
        : ("mustMatch" as const),
    filter: toWireFilter(p.filter ?? EMPTY_RELATIONSHIP_FILTER),
  }));
}

/** Maps a proto relationship update, treating an unrecognised operation as TOUCH. */
function toWireRelationshipUpdate(u: RelationshipUpdate): RelationshipUpdateWire {
  let op: RelationshipUpdateOpWire;
  switch (u.operation) {
    case RelationshipUpdate_Operation.OPERATION_CREATE:
      op = "create";
      break;
    case RelationshipUpdate_Operation.OPERATION_DELETE:
      op = "delete";
      break;
    default:
      op = "touch";
      break;
  }
  return { operation: op, relationship: toWireRelationship(u.relationship ?? EMPTY_RELATIONSHIP) };
}

/** The lower bound `DateTimeOffset.FromUnixTimeSeconds` accepts (0001-01-01T00:00:00Z). */
const MIN_UNIX_SECONDS = -62135596800n;
/** The upper bound `DateTimeOffset.FromUnixTimeSeconds` accepts (9999-12-31T23:59:59Z). */
const MAX_UNIX_SECONDS = 253402300799n;
/** Nanoseconds per second: the grains DTOs carry expiration as epoch nanos. */
const NANOS_PER_SECOND = 1_000_000_000n;

/**
 * Maps a proto relationship onto the cross-grain wire form. Exported for
 * `relationship-wire-mapping-tests.test.ts` - the C# is `internal` + `InternalsVisibleTo`.
 */
export function toWireRelationship(r: Relationship): RelationshipWire {
  const subject = r.subject ?? EMPTY_SUBJECT_REFERENCE;
  const subjectRelation = isNullOrEmpty(subject.optionalRelation)
    ? ELLIPSIS
    : subject.optionalRelation;
  const subjectObject = subject.object ?? EMPTY_OBJECT_REFERENCE;
  const resource = r.resource ?? EMPTY_OBJECT_REFERENCE;
  const seconds = BigInt(r.optionalExpiresAtUnixSeconds || "0");
  const expiration = seconds === 0n ? undefined : unixSecondsToNanos(seconds);
  const caveat = r.optionalCaveat;
  return {
    resourceType: resource.objectType,
    resourceId: resource.objectId,
    resourceRelation: r.resourceRelation,
    subjectType: subjectObject.objectType,
    subjectId: subjectObject.objectId,
    subjectRelation,
    caveatName:
      caveat !== undefined && caveat.caveatName.length > 0 ? caveat.caveatName : undefined,
    caveatContext:
      caveat !== undefined && caveat.caveatName.length > 0
        ? structToMap(caveat.context)
        : undefined,
    expiration,
  };
}

/**
 * `DateTimeOffset.FromUnixTimeSeconds(seconds)` as epoch nanos, INCLUDING its range guard: the C#
 * throws `ArgumentOutOfRangeException` outside `[MIN_UNIX_SECONDS, MAX_UNIX_SECONDS]`, and a bare
 * `bigint` multiply would silently accept any magnitude.
 */
function unixSecondsToNanos(seconds: bigint): bigint {
  if (seconds < MIN_UNIX_SECONDS || seconds > MAX_UNIX_SECONDS) {
    throw new InvalidArgumentError(
      `optional_expires_at_unix_seconds ${seconds} is outside the representable range`,
    );
  }
  return seconds * NANOS_PER_SECOND;
}

/** Maps a wire relationship back to proto, blanking an ellipsis subrelation. */
function toProtoRelationship(w: RelationshipWire): Relationship {
  const rel: Relationship = {
    resource: { objectType: w.resourceType, objectId: w.resourceId },
    resourceRelation: w.resourceRelation,
    subject: {
      object: { objectType: w.subjectType, objectId: w.subjectId },
      optionalRelation: w.subjectRelation === ELLIPSIS ? "" : w.subjectRelation,
    },
    // BigInt division truncates toward ZERO where `ToUnixTimeSeconds` floors: the two differ only
    // for a sub-second pre-1970 expiration.
    optionalExpiresAtUnixSeconds:
      w.expiration !== undefined ? String(w.expiration / NANOS_PER_SECOND) : "0",
  };
  if (w.caveatName !== undefined && w.caveatName.length > 0) {
    rel.optionalCaveat = {
      caveatName: w.caveatName,
      context: mapToStruct(w.caveatContext),
    };
  }

  return rel;
}

/** Maps a proto relationship filter, dropping every empty field. */
function toWireFilter(f: RelationshipFilter): RelationshipsFilterWire {
  return {
    resourceType: nullIfEmpty(f.resourceType),
    resourceIdPrefix: nullIfEmpty(f.optionalResourceIdPrefix),
    resourceIds: f.optionalResourceIds.length > 0 ? [...f.optionalResourceIds] : undefined,
    resourceRelation: nullIfEmpty(f.optionalResourceRelation),
    subjectType: nullIfEmpty(f.optionalSubjectType),
    subjectIds: f.optionalSubjectIds.length > 0 ? [...f.optionalSubjectIds] : undefined,
    subjectRelation: nullIfEmpty(f.optionalSubjectRelation),
  };
}

/** Maps the wire permissionship (caveated or not) onto the proto one. */
function toProtoPermissionship(p: PermissionshipWire): Permissionship {
  return {
    kind: p.isCaveated
      ? Permissionship_Kind.KIND_CONDITIONAL_PERMISSION
      : Permissionship_Kind.KIND_HAS_PERMISSION,
    partialCaveatMissingFields: [...p.missingContextParams],
  };
}

/** Maps a found subject onto proto. */
function toProtoFoundSubject(s: FoundSubjectWire): {
  subjectObjectId: string;
  isWildcard: boolean;
  permissionship: Permissionship;
} {
  return {
    subjectObjectId: s.subjectId,
    isWildcard: s.isWildcard,
    permissionship: toProtoPermissionship(s.permissionship),
  };
}

/** Maps a found resource onto proto. */
function toProtoFoundResource(r: FoundResourceWire): {
  resourceObjectId: string;
  permissionship: Permissionship;
} {
  return {
    resourceObjectId: r.resourceId,
    permissionship: toProtoPermissionship(r.permissionship),
  };
}

/** Maps an expansion tree node onto proto, recursively. Exactly one of `leaf` / `setOp` is set. */
function toProtoTreeNode(node: ExpandTreeNodeWire): PermissionTreeNode {
  const result: PermissionTreeNode = {
    expandedObject: { objectType: node.expandedType, objectId: node.expandedId },
    expandedRelation: node.expandedRelation,
    caveatMissingFields: [...node.caveatMissingFields],
  };

  if (node.isLeaf) {
    result.leaf = { subjects: node.subjects.map(toProtoDirectSubject) };
  } else {
    result.setOp = {
      operation: toProtoSetOperation(node.operation),
      children: node.children.map(toProtoTreeNode),
    };
  }

  return result;
}

/** Maps one direct subject of a leaf node onto proto, blanking an ellipsis subrelation. */
function toProtoDirectSubject(s: ExpandSubjectWire): PermissionTreeNode_DirectSubject {
  return {
    subject: {
      object: { objectType: s.subjectType, objectId: s.subjectId },
      optionalRelation: s.subjectRelation === ELLIPSIS ? "" : s.subjectRelation,
    },
    isWildcard: s.isWildcard,
    caveatMissingFields: [...s.caveatMissingFields],
  };
}

/** Maps the set operation of an internal tree node onto proto. */
function toProtoSetOperation(op: SetOpWire): PermissionTreeNode_SetOpNode_Operation {
  switch (op) {
    case "union":
      return PermissionTreeNode_SetOpNode_Operation.OPERATION_UNION;
    case "intersection":
      return PermissionTreeNode_SetOpNode_Operation.OPERATION_INTERSECTION;
    case "exclusion":
      return PermissionTreeNode_SetOpNode_Operation.OPERATION_EXCLUSION;
    default:
      return PermissionTreeNode_SetOpNode_Operation.OPERATION_UNSPECIFIED;
  }
}

/**
 * Maps the proto consistency oneof onto the cross-grain {@link ConsistencyWire}. An absent message
 * or an unset oneof is minimize-latency - the server default - so existing clients are unchanged.
 *
 * The C# switches on `RequirementCase`, which is set by ASSIGNMENT, so the port tests which FIELD
 * is defined (in the C#'s case order) rather than whether its value is truthy: a
 * `fully_consistent: false` still selects fully-consistent.
 */
function toWireConsistency(consistency: Consistency | undefined): ConsistencyWire {
  if (consistency === undefined) {
    return MINIMIZE_LATENCY_WIRE;
  }
  if (consistency.atLeastAsFresh !== undefined) {
    return { mode: "atLeastAsFresh", token: consistency.atLeastAsFresh.token };
  }
  if (consistency.fullyConsistent !== undefined) {
    return { mode: "fullyConsistent" };
  }
  if (consistency.atExactSnapshot !== undefined) {
    return { mode: "atExactSnapshot", token: consistency.atExactSnapshot.token };
  }
  // minimize_latency, or unset / absent.
  return MINIMIZE_LATENCY_WIRE;
}

/** `string.IsNullOrEmpty`. */
function isNullOrEmpty(s: string | undefined): boolean {
  return s === undefined || s.length === 0;
}

/** `NullIfEmpty`. */
function nullIfEmpty(s: string | undefined): string | undefined {
  return isNullOrEmpty(s) ? undefined : s;
}

/**
 * The C# dereferences every submessage unconditionally (`request.Subject.Object.ObjectType`), which
 * on an ABSENT submessage is a `NullReferenceException` - Google.Protobuf for C# leaves an unset
 * message field null. TypeScript has no such reference, and reproducing the fault would mean
 * throwing where the port has nothing to throw about, so an absent submessage reads as the proto
 * DEFAULT instance instead, which is what Go's generated getters (and therefore SpiceDB itself) do:
 * every scalar comes back empty and the request fails its own validation downstream.
 *
 * The four frozen defaults below are that substitution, one per submessage this file dereferences.
 */
const EMPTY_OBJECT_REFERENCE: ObjectReference = Object.freeze({ objectType: "", objectId: "" });

/** The default `SubjectReference`; its own `object` is likewise absent. */
const EMPTY_SUBJECT_REFERENCE: SubjectReference = Object.freeze({ optionalRelation: "" });

/** The default `RelationshipFilter`: every field empty, so the filter matches everything. */
const EMPTY_RELATIONSHIP_FILTER: RelationshipFilter = Object.freeze({
  resourceType: "",
  optionalResourceIdPrefix: "",
  optionalResourceIds: [],
  optionalResourceRelation: "",
  optionalSubjectType: "",
  optionalSubjectIds: [],
  optionalSubjectRelation: "",
});

/** The default `Relationship`, for an update that carries none. */
const EMPTY_RELATIONSHIP: Relationship = Object.freeze({
  resourceRelation: "",
  optionalExpiresAtUnixSeconds: "0",
});

/**
 * `StructToDict`: an absent or EMPTY struct is `undefined` (C# `null`), never an empty map. The
 * result is a `Map` because the grains DTOs take a `ReadonlyMap` - and because a plain object would
 * collide with the `Map` branch of {@link objectToValue} and with prototype keys.
 */
function structToMap(
  s: { [key: string]: unknown } | undefined,
): ReadonlyMap<string, unknown> | undefined {
  if (s === undefined || s === null || Object.keys(s).length === 0) {
    return undefined;
  }

  return structFieldsToMap(s);
}

/** The nested-struct conversion, which - unlike {@link structToMap} - keeps an EMPTY struct. */
function structFieldsToMap(s: { [key: string]: unknown }): ReadonlyMap<string, unknown> {
  const d = new Map<string, unknown>();
  for (const [k, v] of Object.entries(s)) {
    d.set(k, valueToObject(v));
  }
  return d;
}

/** `DictToStruct`: an absent or EMPTY dictionary is `undefined`. */
function mapToStruct(
  dict: ReadonlyMap<string, unknown> | undefined,
): { [key: string]: unknown } | undefined {
  if (dict === undefined || dict.size === 0) {
    return undefined;
  }

  // A NULL-PROTOTYPE object, not `{}`: C# writes into `Struct.Fields`, an ordinary dictionary,
  // so a key called `__proto__` is stored like any other. On an object literal that same
  // assignment hits the inherited setter on `Object.prototype` and the key vanishes with no
  // error - silent loss of an input to an authorization decision.
  const s = Object.create(null) as { [key: string]: unknown };
  for (const [k, v] of dict) {
    s[k] = objectToValue(v);
  }
  return s;
}

/**
 * `ObjectToValue`. THE ORDER OF THE BRANCHES IS THE BEHAVIOUR: the C# matches `string` before
 * `IEnumerable` and `IReadOnlyDictionary` before `IEnumerable`, and in TypeScript a string is
 * itself iterable, so a string tested after the list branch would be exploded into characters.
 *
 * A `bigint` has no C# counterpart at all (`int`/`long`/`double` all collapse to `ForNumber`), so
 * it deliberately takes the `o.ToString()` fallback rather than a lossy `Number(...)`.
 */
function objectToValue(o: unknown): unknown {
  if (o === null || o === undefined) return null;
  if (typeof o === "boolean") return o;
  if (typeof o === "string") return o;
  if (typeof o === "number") return o;
  if (o instanceof Map) return mapToStruct(o as ReadonlyMap<string, unknown>) ?? {};
  if (Array.isArray(o)) return o.map(objectToValue);
  return String(o);
}

/**
 * `ValueToObject`. ts-proto unwraps a `Struct` into plain JS, so the C#'s `KindCase` switch becomes
 * a type test; an unrecognised kind is `null`, as the C# default arm is.
 */
function valueToObject(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(valueToObject);
  if (typeof v === "object") return structFieldsToMap(v as { [key: string]: unknown });
  return null;
}
