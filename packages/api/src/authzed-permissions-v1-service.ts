import { status } from "@grpc/grpc-js";
import type { CaveatEvaluationErrorKind } from "@spacedb/core/caveat-evaluation-exception";
import { CaveatEvaluationException } from "@spacedb/core/caveat-evaluation-exception";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import { FormatError } from "@spacedb/core/format-error";
import { InvalidConsistencyTokenException } from "@spacedb/core/invalid-consistency-token-exception";
import { MaxDepthExceededException } from "@spacedb/core/max-depth-exceeded-exception";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { RevisionNotFoundException } from "@spacedb/datastore/datastore-exceptions";
import type { ConsistencyWire } from "@spacedb/grains/consistency-wire";
import {
  consistencyWireToRequirement,
  MINIMIZE_LATENCY_WIRE,
} from "@spacedb/grains/consistency-wire";
import { DispatchFailedException } from "@spacedb/grains/dispatch-failed-exception";
import type { BatchCheckItem, IPermissionChecker } from "@spacedb/grains/i-permission-checker";
import type { IRelationshipsGrain } from "@spacedb/grains/i-relationships-grain";
import {
  IRelationshipsGrain as IRelationshipsGrainDefinition,
  RELATIONSHIPS_GRAIN_KEY,
} from "@spacedb/grains/i-relationships-grain";
import type { ISchemaProvider } from "@spacedb/grains/i-schema-provider";
import { PreconditionFailedException } from "@spacedb/grains/precondition-failed-exception";
import type { RelationshipReads } from "@spacedb/grains/relationship-reads";
import type {
  PreconditionWire,
  RelationshipsFilterWire,
  RelationshipStreamItem,
  RelationshipUpdateOpWire,
  RelationshipUpdateWire,
  RelationshipWire,
} from "@spacedb/grains/relationships-dtos";
import { relationshipStreamItemReadAtToken } from "@spacedb/grains/relationships-dtos";
import type { ReverseOps } from "@spacedb/grains/reverse-ops";
import type {
  ExpandSubjectWire,
  ExpandTreeNodeWire,
  Permissionship as PermissionshipWire,
  SetOpWire,
} from "@spacedb/grains/reverse-ops-dtos";
import {
  expandTreeReplyExpandedAtToken,
  foundResourceWireLookedUpAtToken,
  foundSubjectStreamItemLookedUpAtToken,
} from "@spacedb/grains/reverse-ops-dtos";
import { SequencerOverloadedException } from "@spacedb/grains/sequencer-overloaded-exception";
import type { WriteConflictKind } from "@spacedb/grains/write-conflict-exception";
import { WriteConflictException } from "@spacedb/grains/write-conflict-exception";
import type { Membership } from "@spacedb/engine/membership";
import type {
  ObjectReference,
  PartialCaveatInfo,
  PermissionRelationshipTree,
  Relationship as ProtoRelationship,
  RelationshipUpdate,
  SubjectReference,
} from "@spacedb/protos/authzed/api/v1/core";
import {
  AlgebraicSubjectSet_Operation,
  RelationshipUpdate_Operation,
} from "@spacedb/protos/authzed/api/v1/core";
import type {
  CheckBulkPermissionsRequest,
  CheckBulkPermissionsResponse,
  CheckBulkPermissionsPair,
  CheckBulkPermissionsResponseItem,
  CheckPermissionRequest,
  CheckPermissionResponse,
  Consistency,
  DeleteRelationshipsRequest,
  DeleteRelationshipsResponse,
  ExpandPermissionTreeRequest,
  ExpandPermissionTreeResponse,
  ExportBulkRelationshipsRequest,
  ExportBulkRelationshipsResponse,
  ImportBulkRelationshipsRequest,
  ImportBulkRelationshipsResponse,
  LookupResourcesRequest,
  LookupResourcesResponse,
  LookupSubjectsRequest,
  LookupSubjectsResponse,
  Precondition,
  ReadRelationshipsRequest,
  ReadRelationshipsResponse,
  RelationshipFilter as ProtoRelationshipFilter,
  WriteRelationshipsRequest,
  WriteRelationshipsResponse,
} from "@spacedb/protos/authzed/api/v1/permission_service";
import {
  CheckPermissionResponse_Permissionship,
  DeleteRelationshipsResponse_DeletionProgress,
  LookupPermissionship,
  Precondition_Operation,
} from "@spacedb/protos/authzed/api/v1/permission_service";
import type { Status as RpcStatus } from "@spacedb/protos/google/rpc/status";
import { isCancellationError } from "@thresh/core/errors";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import { validateCaveatContextSize, validateWriteRelationships } from "./request-limits";
import { RpcError } from "./rpc-error";
import {
  checkNamespaceAndRelations,
  rejectWildcardSubject,
  toRpcStatus,
  tryCheckNamespaceAndRelations,
  wildcardSubjectError,
} from "./schema-validation";
import type { ServerStreamWriter } from "./server-stream-writer";

/**
 * Port of Spiceport `src/Spiceport.Api/AuthzedPermissionsV1Service.cs`: the gRPC front door for
 * `authzed.api.v1.PermissionsService`, the compatibility surface `zed` actually calls.
 *
 * A pure translation layer over the SAME grain mesh and in-process read helpers the internal
 * `PermissionsGrpcService` uses: unary check/write/delete dispatch through
 * {@link IPermissionChecker} / {@link IRelationshipsGrain}; expand and the read + lookup RPCs run
 * in-process through {@link ReverseOps} / {@link RelationshipReads} (mirroring `BulkGrpcService`).
 * Nothing here re-implements engine or datastore logic.
 *
 * Port decisions (the C# constructs with no TypeScript counterpart):
 *   * `IServerStreamWriter<T>` becomes {@link ServerStreamWriter} and `IAsyncStreamReader<T>` a
 *     plain `AsyncIterable<T>`; `ServerCallContext` becomes a trailing `signal?: AbortSignal`, the
 *     only member the C# reads off it. The `@grpc/grpc-js` `ServerWritableStream` /
 *     `ServerReadableStream` are adapted onto those seams in the host wiring, where Node
 *     backpressure is handled. Settled in the `bulk-grpc-service` port and reused verbatim.
 *   * `RpcException(new Status(code, detail))` becomes {@link RpcError}, which `@grpc/grpc-js`
 *     consumes as a `ServiceError`.
 *   * `catch (OperationCanceledException) when (ct.IsCancellationRequested)` becomes
 *     `isCancellationError(error) && signal?.aborted === true`, matched on the TYPE and paired with
 *     the same guard: a cancellation raised while the call was NOT cancelled still propagates.
 *   * `FormatException` (a malformed bulk-export cursor) is `@spacedb/core`'s {@link FormatError}.
 *   * `num_loaded` is uint64: a ts-proto STRING minted from the reply's `bigint`, never a JS
 *     `number`, which would round past 2^53.
 *   * `partial.Clone()` into the deprecated top-level `LookupSubjectsResponse.partial_caveat_info`
 *     becomes a STRUCTURAL copy - ts-proto messages are plain objects, so writing the same
 *     reference twice would alias, and a later mutation of one would be visible through the other.
 *   * A `Struct` field arrives auto-unwrapped by ts-proto as a plain object while the grains DTOs
 *     take a `ReadonlyMap`, so the conversion is object <-> `Map` at every level. A `Map` - never a
 *     plain object - so {@link objectToValue} cannot confuse a context dictionary with a list and
 *     so prototype keys like `__proto__` stay ordinary entries.
 *   * A submessage the C# dereferences unconditionally (`request.Subject.Object`) reads as the
 *     proto DEFAULT instance here (the frozen constants below) rather than throwing a
 *     `NullReferenceException`: that is what Go's generated getters, and therefore SpiceDB itself,
 *     do. Same substitution as `permissions-grpc-service.ts`.
 *   * `ArgumentNullException.ThrowIfNull(requestStream/request/responseStream)` has no counterpart
 *     for a non-optional TypeScript parameter and is dropped, as in `bulk-grpc-service.ts`.
 *   * The C# overload sets (`ToWire`, `ToProto`) become distinctly named free functions.
 *
 * SOURCE CONCERN, transliterated rather than fixed. {@link toWireRelationship} reproduces the C#'s
 * `ToWire(V1::Relationship)` (line 774), whose comment claims "v1 core.proto Relationship has no
 * expiration field in this snapshot" and passes `null` for the expiration; {@link
 * toProtoRelationship} reproduces `ToProto(RelationshipWire)` (783-805), which never sets it
 * either. The claim is FALSE - the vendored `authzed/api/v1/core.proto` declares
 * `google.protobuf.Timestamp optional_expires_at = 5`, and the generated bindings DO carry
 * `optionalExpiresAt` - so an authzed-v1 client's expiry is silently dropped on the way in and a
 * stored expiry is invisible on the way out. The omission below is deliberate.
 */
export class AuthzedPermissionsV1Service {
  readonly #checker: IPermissionChecker;
  readonly #grains: GrainFactoryAccess;
  readonly #reverseOps: ReverseOps;
  readonly #relationshipReads: RelationshipReads;
  readonly #schema: ISchemaProvider;

  constructor(
    checker: IPermissionChecker,
    grains: GrainFactoryAccess,
    reverseOps: ReverseOps,
    relationshipReads: RelationshipReads,
    schema: ISchemaProvider,
  ) {
    this.#checker = checker;
    this.#grains = grains;
    this.#reverseOps = reverseOps;
    this.#relationshipReads = relationshipReads;
    this.#schema = schema;
  }

  /** `private IRelationshipsGrain Relationships => grains.GetGrain<...>(Key)` - a getter, as the C# is. */
  get #relationships(): IRelationshipsGrain {
    return this.#grains.getGrain(IRelationshipsGrainDefinition, RELATIONSHIPS_GRAIN_KEY);
  }

  /** Checks one permission, guarding the request against the schema before dispatching. */
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

    // A wildcard ("*") subject is not a valid thing to check (SpiceDB: checkInternal returns
    // NewWildcardNotAllowedErr -> InvalidArgument). It is only meaningful as a stored subject.
    rejectWildcardSubject(subjectObject.objectId);

    // Validate the resource definition+permission and the subject definition+relation up front, as
    // SpiceDB does (namespace.CheckNamespaceAndRelations). An unknown definition/relation is a
    // client schema/typo bug surfaced as FailedPrecondition, NOT silently masked as a NO_PERMISSION
    // verdict.
    checkNamespaceAndRelations(
      this.#schema.current,
      {
        definitionName: resource.objectType,
        relationName: request.permission,
        allowEllipsis: false,
      },
      {
        definitionName: subjectObject.objectType,
        relationName: subjectRelation,
        allowEllipsis: true,
      },
    );

    // Reject an oversized request caveat context (SpiceDB: GetCaveatContext) -> InvalidArgument.
    validateCaveatContextSize(request.context);

    let result;
    try {
      result = await this.#checker.check(
        resource.objectType,
        resource.objectId,
        request.permission,
        subject,
        structToMap(request.context),
        consistencyWireToRequirement(toWireConsistency(request.consistency)),
        signal,
      );
    } catch (error) {
      if (error instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof RevisionNotFoundException) {
        // The pinned revision has been garbage-collected (or never existed): same client-facing
        // contract as an invalid consistency token.
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof MaxDepthExceededException) {
        // The check exhausted its recursion budget (deep schema/data or a cycle). SpiceDB surfaces
        // this as FailedPrecondition, NOT a NoPermission verdict, so the client can tell "the
        // server gave up" apart from "not authorized".
        throw new RpcError(status.FAILED_PRECONDITION, error.message);
      }
      if (error instanceof CaveatEvaluationException) {
        throw toRpcCaveat(error);
      }
      if (error instanceof DispatchFailedException) {
        throw toRpcDispatch(error);
      }
      throw error;
    }

    const response: CheckPermissionResponse = {
      permissionship: toProtoCheckPermissionship(result.verdict),
      checkedAt: { token: result.evaluatedToken },
    };

    // partial_caveat_info carries a min_items=1 repeated field, so only populate it when the
    // verdict is caveated AND there is at least one missing field to report.
    if (result.verdict === "caveated" && result.missingFields.length > 0) {
      response.partialCaveatInfo = { missingRequiredContext: [...result.missingFields] };
    }

    return response;
  }

  /** Applies a batch of relationship updates under any preconditions. */
  async writeRelationships(
    request: WriteRelationshipsRequest,
  ): Promise<WriteRelationshipsResponse> {
    // Reject over-limit/duplicate/oversized-context requests up front (SpiceDB validates the
    // request shape before applying it). All of these are InvalidArgument, not FailedPrecondition.
    validateWriteRelationships(request);

    const updates = request.updates.map(toWireRelationshipUpdate);
    const preconditions = toWirePreconditions(request.optionalPreconditions);
    try {
      const reply = await this.#relationships.writeRelationships({ updates, preconditions });
      return { writtenAt: { token: reply.writtenAtToken } };
    } catch (error) {
      if (error instanceof PreconditionFailedException) {
        throw new RpcError(status.FAILED_PRECONDITION, error.message);
      }
      if (error instanceof WriteConflictException) {
        // CreateExisting -> AlreadyExists (SpiceDB CreateRelationshipExistsError): a permanent
        // duplicate-create the client must NOT retry as transient. Serialization -> Aborted
        // (SpiceDB SerializationError): a genuine write-write conflict the client retries as a
        // whole tx.
        throw new RpcError(toStatusCode(error.kind), error.message);
      }
      if (error instanceof SequencerOverloadedException) {
        // The per-silo admission gate shed this commit - the sequencer is saturated. A deliberate,
        // retryable overload signal (back off and retry), never an opaque timeout.
        throw new RpcError(status.RESOURCE_EXHAUSTED, error.message);
      }
      throw error;
    }
  }

  /** Streams the filtered relationships back, one response message per relationship. */
  async readRelationships(
    request: ReadRelationshipsRequest,
    responseStream: ServerStreamWriter<ReadRelationshipsResponse>,
    signal?: AbortSignal | undefined,
  ): Promise<void> {
    const filter = toWireFilter(request.relationshipFilter ?? EMPTY_RELATIONSHIP_FILTER);
    const consistency = toWireConsistency(request.consistency);

    // One in-process read over one pinned snapshot (the grain hop and page loop are both gone).
    // Each item carries the per-message read-at token, exactly as every page-message did before.
    try {
      for await (const item of this.#relationshipReads.readRelationships(
        { filter, limit: undefined, cursor: undefined, consistency },
        signal,
      )) {
        await responseStream.write({
          readAt: { token: relationshipStreamItemReadAtToken(item) },
          relationship: toProtoRelationship(item.relationship),
        });
      }
    } catch (error) {
      if (error instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof RevisionNotFoundException) {
        // The pinned revision has been garbage-collected (or never existed): same client-facing
        // contract as an invalid consistency token.
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (!isClientDisconnect(error, signal)) {
        throw error;
      }
      // A client that stops reading (or disconnects) cancels the request token; treat it as a
      // normal end of the stream, not an error (mirrors AuthzedWatchV1Service.watch).
    }
  }

  /** Deletes every relationship matching the filter, under any preconditions. */
  async deleteRelationships(
    request: DeleteRelationshipsRequest,
  ): Promise<DeleteRelationshipsResponse> {
    try {
      const reply = await this.#relationships.deleteRelationships({
        filter: toWireFilter(request.relationshipFilter ?? EMPTY_RELATIONSHIP_FILTER),
        optionalLimit: undefined,
        preconditions: toWirePreconditions(request.optionalPreconditions),
      });

      // v1 DeleteRelationshipsResponse carries only deleted_at in this snapshot; the request's
      // optional_limit and the reply's deleted count are both discarded.
      return {
        deletedAt: { token: reply.deletedAtToken },
        deletionProgress:
          DeleteRelationshipsResponse_DeletionProgress.DELETION_PROGRESS_UNSPECIFIED,
        relationshipsDeletedCount: "0",
      };
    } catch (error) {
      if (error instanceof PreconditionFailedException) {
        throw new RpcError(status.FAILED_PRECONDITION, error.message);
      }
      if (error instanceof SequencerOverloadedException) {
        // Sequencer overload shed by the admission gate: retryable RESOURCE_EXHAUSTED.
        throw new RpcError(status.RESOURCE_EXHAUSTED, error.message);
      }
      throw error;
    }
  }

  /** Expands a permission into its subject tree. */
  async expandPermissionTree(
    request: ExpandPermissionTreeRequest,
  ): Promise<ExpandPermissionTreeResponse> {
    const resource = request.resource ?? EMPTY_OBJECT_REFERENCE;

    // Validate the resource definition+permission up front (SpiceDB: CheckNamespaceAndRelation).
    checkNamespaceAndRelations(this.#schema.current, {
      definitionName: resource.objectType,
      relationName: request.permission,
      allowEllipsis: false,
    });

    // v1 ExpandPermissionTreeRequest has no mode field; authzed's expand is the recursive walk.
    let reply;
    try {
      reply = await this.#reverseOps.expandPermissionTree({
        resourceType: resource.objectType,
        resourceId: resource.objectId,
        permission: request.permission,
        mode: "recursive",
        consistency: toWireConsistency(request.consistency),
      });
    } catch (error) {
      if (error instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof RevisionNotFoundException) {
        // The pinned revision has been garbage-collected (or never existed): same client-facing
        // contract as an invalid consistency token.
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof DispatchFailedException) {
        throw toRpcDispatch(error);
      }
      throw error;
    }

    return {
      treeRoot: toProtoTreeNode(reply.root),
      expandedAt: { token: expandTreeReplyExpandedAtToken(reply) },
    };
  }

  /** Streams the resources on which the subject holds the permission. */
  async lookupResources(
    request: LookupResourcesRequest,
    responseStream: ServerStreamWriter<LookupResourcesResponse>,
    signal?: AbortSignal | undefined,
  ): Promise<void> {
    const requestSubject = request.subject ?? EMPTY_SUBJECT_REFERENCE;
    const subjectRelation = isNullOrEmpty(requestSubject.optionalRelation)
      ? ELLIPSIS
      : requestSubject.optionalRelation;
    const subjectObject = requestSubject.object ?? EMPTY_OBJECT_REFERENCE;

    // Reject an oversized request caveat context (SpiceDB: GetCaveatContext) -> InvalidArgument.
    const context5 = structToMap(validateCaveatContextSize(request.context));
    const consistency = toWireConsistency(request.consistency);

    // v1 contract: optional_limit (field 6) caps the resources returned; optional_cursor (field 7)
    // resumes after a prior page. SpiceDB disables cursors entirely when no limit is set, so we
    // only attach after_result_cursor when a limit was requested.
    // `(int)request.OptionalLimit` on a proto uint32: C# is unchecked, so a value above
    // int.MaxValue WRAPS NEGATIVE. `| 0` is that same narrowing and is the identity for every
    // value a real client sends; without it the port would accept a 3-billion limit the C#
    // fast-fails on.
    const limit = request.optionalLimit === 0 ? undefined : request.optionalLimit | 0;
    const emitCursors = limit !== undefined;
    const requestCursor = request.optionalCursor;
    const cursor =
      requestCursor !== undefined && !isNullOrEmpty(requestCursor.token)
        ? requestCursor.token
        : undefined;

    // Validate the resource definition+permission and subject definition+relation up front
    // (SpiceDB: CheckNamespaceAndRelations) before streaming any results.
    checkNamespaceAndRelations(
      this.#schema.current,
      {
        definitionName: request.resourceObjectType,
        relationName: request.permission,
        allowEllipsis: false,
      },
      {
        definitionName: subjectObject.objectType,
        relationName: subjectRelation,
        allowEllipsis: true,
      },
    );

    // One in-process stream. A limited request takes at most `limit` items then stops (the RPC
    // stream terminates; the client resumes via the last item's cursor). An unlimited request
    // drains the whole reachable set. `limit` also drives the engine path: a limited walk is
    // cursor-bearing (so every item has a resume cursor), an unlimited/cursorless walk may take
    // the Leopard fast path.
    let emitted = 0;
    try {
      for await (const r of this.#reverseOps.streamLookupResources(
        {
          resourceType: request.resourceObjectType,
          permission: request.permission,
          subjectType: subjectObject.objectType,
          subjectId: subjectObject.objectId,
          subjectRelation,
          context: context5,
          limit,
          cursor,
          consistency,
        },
        signal,
      )) {
        const response: LookupResourcesResponse = {
          lookedUpAt: { token: foundResourceWireLookedUpAtToken(r) },
          resourceObjectId: r.resourceId,
          permissionship: toLookupPermissionship(r.permissionship),
        };
        if (r.permissionship.isCaveated && r.permissionship.missingContextParams.length > 0) {
          response.partialCaveatInfo = {
            missingRequiredContext: [...r.permissionship.missingContextParams],
          };
        }
        if (emitCursors && !isNullOrEmpty(r.afterResultCursor)) {
          response.afterResultCursor = { token: r.afterResultCursor as string };
        }
        await responseStream.write(response);

        emitted += 1;
        if (limit !== undefined && emitted >= limit) break;
      }
    } catch (error) {
      if (error instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof RevisionNotFoundException) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof CaveatEvaluationException) {
        throw toRpcCaveat(error);
      }
      if (error instanceof DispatchFailedException) {
        throw toRpcDispatch(error);
      }
      if (!isClientDisconnect(error, signal)) {
        throw error;
      }
      // A client that stops reading (or disconnects) cancels the request token; treat it as a
      // normal end of the stream, not an error (mirrors AuthzedWatchV1Service.watch).
    }
  }

  /** Streams the subjects holding the permission on the resource. */
  async lookupSubjects(
    request: LookupSubjectsRequest,
    responseStream: ServerStreamWriter<LookupSubjectsResponse>,
    signal?: AbortSignal | undefined,
  ): Promise<void> {
    const subjectRelation = isNullOrEmpty(request.optionalSubjectRelation)
      ? ELLIPSIS
      : request.optionalSubjectRelation;

    // Reject an oversized request caveat context (SpiceDB: GetCaveatContext) -> InvalidArgument.
    const context6 = structToMap(validateCaveatContextSize(request.context));
    const consistency = toWireConsistency(request.consistency);

    // v1 contract: optional_concrete_limit (field 7) caps the *concrete* (non-wildcard) subjects
    // returned. optional_cursor is not supported for LookupSubjects (the proto documents it as
    // ignored), so we do not read it.
    const limit = request.optionalConcreteLimit === 0 ? undefined : request.optionalConcreteLimit;

    const resource = request.resource ?? EMPTY_OBJECT_REFERENCE;

    // Validate the resource definition+permission and subject definition+relation up front
    // (SpiceDB: CheckNamespaceAndRelations) before streaming any results.
    checkNamespaceAndRelations(
      this.#schema.current,
      {
        definitionName: resource.objectType,
        relationName: request.permission,
        allowEllipsis: false,
      },
      {
        definitionName: request.subjectObjectType,
        relationName: subjectRelation,
        allowEllipsis: true,
      },
    );

    // One in-process stream: count non-wildcard emissions and stop once the concrete limit is met.
    let emitted = 0;
    try {
      for await (const item of this.#reverseOps.streamLookupSubjects(
        {
          resourceType: resource.objectType,
          resourceId: resource.objectId,
          permission: request.permission,
          subjectType: request.subjectObjectType,
          subjectRelation,
          context: context6,
          limit,
          cursor: undefined,
          consistency,
        },
        signal,
      )) {
        const s = item.subject;
        const ship = toLookupPermissionship(s.permissionship);
        let partial: PartialCaveatInfo | undefined;
        if (s.permissionship.isCaveated && s.permissionship.missingContextParams.length > 0) {
          partial = { missingRequiredContext: [...s.permissionship.missingContextParams] };
        }

        const response: LookupSubjectsResponse = {
          lookedUpAt: { token: foundSubjectStreamItemLookedUpAtToken(item) },
          // Modern field.
          subject: { subjectObjectId: s.subjectId, permissionship: ship },
          // Deprecated mirror fields for older clients.
          subjectObjectId: s.subjectId,
          permissionship: ship,
          // Neither exclusion list is populated by the C#; ts-proto types them as required
          // repeated fields, so they carry the proto default.
          excludedSubjectIds: [],
          excludedSubjects: [],
        };
        if (partial !== undefined) {
          // `resp.Subject.PartialCaveatInfo = partial; resp.PartialCaveatInfo = partial.Clone();`
          // A ts-proto message is a plain object, so the second write is a STRUCTURAL copy: the
          // same reference twice would alias, and so would a shared missing-context array.
          response.subject!.partialCaveatInfo = partial;
          response.partialCaveatInfo = {
            missingRequiredContext: [...partial.missingRequiredContext],
          };
        }
        await responseStream.write(response);

        // The cap is a *concrete* limit: wildcards do not count against it. The C#'s
        // `++emitted == limit` compares against an `int?`, which a null limit never equals, so
        // `undefined` must not compare equal to a number here either.
        if (!s.isWildcard) {
          emitted += 1;
          if (limit !== undefined && emitted === limit) break;
        }
      }
    } catch (error) {
      if (error instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof RevisionNotFoundException) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof CaveatEvaluationException) {
        throw toRpcCaveat(error);
      }
      if (error instanceof DispatchFailedException) {
        throw toRpcDispatch(error);
      }
      if (!isClientDisconnect(error, signal)) {
        throw error;
      }
      // A client that stops reading (or disconnects) cancels the request token; treat it as a
      // normal end of the stream, not an error (mirrors AuthzedWatchV1Service.watch).
    }
  }

  /** Checks a batch of pairs, reporting a per-pair schema failure as THAT pair's error. */
  async checkBulkPermissions(
    request: CheckBulkPermissionsRequest,
    signal?: AbortSignal | undefined,
  ): Promise<CheckBulkPermissionsResponse> {
    const snapshot = this.#schema.current;

    // Validate each pair against the schema UP FRONT and PER PAIR. An unknown resource definition,
    // unknown relation/permission, or a wildcard ("*") check subject is a client schema/typo bug
    // for that one pair; SpiceDB's CheckBulkPermissions surfaces it as that pair's
    // google.rpc.Status error (CheckBulkPermissionsPair_Error) rather than failing the whole RPC.
    // Valid pairs are dispatched; invalid pairs are short-circuited to their error and never sent
    // to the grain.
    //
    // (Oversized request caveat context remains a WHOLE-request InvalidArgument, matching SpiceDB's
    // groupItems/GetCaveatContext which aborts the entire bulk request.)
    const pairErrors: (RpcStatus | undefined)[] = new Array<RpcStatus | undefined>(
      request.items.length,
    ).fill(undefined);
    const validItems: BatchCheckItem[] = [];

    for (let i = 0; i < request.items.length; i += 1) {
      const it = request.items[i]!;
      const itemSubject = it.subject ?? EMPTY_SUBJECT_REFERENCE;
      const subjectRelation = isNullOrEmpty(itemSubject.optionalRelation)
        ? ELLIPSIS
        : itemSubject.optionalRelation;
      const subjectObject = itemSubject.object ?? EMPTY_OBJECT_REFERENCE;
      const itemResource = it.resource ?? EMPTY_OBJECT_REFERENCE;

      const perPairError =
        wildcardSubjectError(subjectObject.objectId) ??
        tryCheckNamespaceAndRelations(
          snapshot,
          {
            definitionName: itemResource.objectType,
            relationName: it.permission,
            allowEllipsis: false,
          },
          {
            definitionName: subjectObject.objectType,
            relationName: subjectRelation,
            allowEllipsis: true,
          },
        );

      if (perPairError !== undefined) {
        pairErrors[i] = toRpcStatus(perPairError);
        continue;
      }

      validItems.push({
        resourceType: itemResource.objectType,
        resourceId: itemResource.objectId,
        permission: it.permission,
        subject: {
          objectType: subjectObject.objectType,
          objectId: subjectObject.objectId,
          relation: subjectRelation,
        },
        // Reject an oversized per-item caveat context (SpiceDB: GetCaveatContext) ->
        // whole-request InvalidArgument. The size check THROWS from inside this loop.
        caveatContext: structToMap(validateCaveatContextSize(it.context)),
      });
    }

    let result;
    if (validItems.length > 0) {
      try {
        result = await this.#checker.batchCheck(
          validItems,
          consistencyWireToRequirement(toWireConsistency(request.consistency)),
          signal,
        );
      } catch (error) {
        if (error instanceof InvalidConsistencyTokenException) {
          throw new RpcError(status.INVALID_ARGUMENT, error.message);
        }
        if (error instanceof RevisionNotFoundException) {
          // The pinned revision has been garbage-collected (or never existed): same client-facing
          // contract as an invalid consistency token.
          throw new RpcError(status.INVALID_ARGUMENT, error.message);
        }
        if (error instanceof CaveatEvaluationException) {
          throw toRpcCaveat(error);
        }
        if (error instanceof DispatchFailedException) {
          throw toRpcDispatch(error);
        }
        throw error;
      }
    }

    // One token for the whole batch (the single pinned revision every dispatched item was evaluated
    // at). When every pair failed validation, no revision was pinned, so no CheckedAt is emitted.
    const response: CheckBulkPermissionsResponse = { pairs: [] };
    if (result !== undefined) {
      response.checkedAt = { token: result.evaluatedToken };
    }

    // Re-interleave verdicts (from valid items, in dispatch order) and per-pair errors back into
    // the original request order. Each pair echoes its originating request item alongside either
    // its verdict or its google.rpc.Status error.
    let verdictPos = 0;
    for (let i = 0; i < request.items.length; i += 1) {
      const pair: CheckBulkPermissionsPair = { request: request.items[i] };

      const error = pairErrors[i];
      if (error !== undefined) {
        pair.error = error;
      } else {
        const verdict = result!.items[verdictPos]!;
        verdictPos += 1;

        const item: CheckBulkPermissionsResponseItem = {
          permissionship: toProtoCheckPermissionship(verdict.verdict),
        };
        if (verdict.verdict === "caveated" && verdict.missingFields.length > 0) {
          item.partialCaveatInfo = { missingRequiredContext: [...verdict.missingFields] };
        }

        pair.item = item;
      }

      response.pairs.push(pair);
    }

    return response;
  }

  /** Buffers the whole client stream and loads it in ONE grain commit. */
  async importBulkRelationships(
    requestStream: AsyncIterable<ImportBulkRelationshipsRequest>,
    signal?: AbortSignal | undefined,
  ): Promise<ImportBulkRelationshipsResponse> {
    // Buffer the WHOLE client stream, then load it in ONE grain commit: real SpiceDB's
    // ImportBulkRelationships is atomic across the entire stream (observed v1.49.2 - a duplicate in
    // a later batch leaves NOTHING applied, including earlier batches), and one commit is the only
    // shape that reproduces that. Rows apply with CREATE semantics: a row already stored, or
    // repeated within the stream, rejects the import with AlreadyExists (SpiceDB's verbatim
    // "could not CREATE relationship ..." message) so the client does not retry the doomed import;
    // a genuine write-write serialization conflict maps to Aborted so the client retries.
    // Cost of the one-commit shape, accepted with eyes open: the buffered rows cross the grain
    // boundary as ONE message and the import executes as one commit turn on the sequencer's single
    // non-reentrant activation, serializing against every other cluster write for its duration. A
    // truly huge import should be split by the CALLER into idempotent-safe disjoint streams;
    // chunking here would silently forfeit the observed whole-stream atomicity.
    const relationships: RelationshipWire[] = [];
    // `MoveNext(context.CancellationToken)` observes the call's token on every pull.
    signal?.throwIfAborted();
    for await (const message of requestStream) {
      signal?.throwIfAborted();
      for (const relationship of message.relationships) {
        relationships.push(toWireRelationship(relationship));
      }
    }

    if (relationships.length === 0) {
      return { numLoaded: "0" };
    }

    try {
      const reply = await this.#relationships.bulkImportRelationships({ relationships });

      // v1 ImportBulkRelationshipsResponse carries only num_loaded (no token). uint64 on the wire:
      // a STRING minted from the reply's bigint, never a JS number.
      return { numLoaded: String(reply.numLoaded) };
    } catch (error) {
      if (error instanceof WriteConflictException) {
        throw new RpcError(toStatusCode(error.kind), error.message);
      }
      if (error instanceof SequencerOverloadedException) {
        // Sequencer overload shed by the admission gate: retryable RESOURCE_EXHAUSTED.
        throw new RpcError(status.RESOURCE_EXHAUSTED, error.message);
      }
      throw error;
    }
  }

  /** Streams the whole filtered relationship set back, batched per response message. */
  async exportBulkRelationships(
    request: ExportBulkRelationshipsRequest,
    responseStream: ServerStreamWriter<ExportBulkRelationshipsResponse>,
    signal?: AbortSignal | undefined,
  ): Promise<void> {
    const filter =
      request.optionalRelationshipFilter !== undefined
        ? toWireFilter(request.optionalRelationshipFilter)
        : EMPTY_FILTER;
    // `(int)request.OptionalLimit` on a proto uint32: C# is unchecked, so a value above
    // int.MaxValue WRAPS NEGATIVE. `| 0` is that same narrowing and is the identity for every
    // value a real client sends; without it the port would accept a 3-billion limit the C#
    // fast-fails on.
    const limit = request.optionalLimit | 0;
    const consistency = toWireConsistency(request.consistency);
    const requestCursor = request.optionalCursor;
    const cursor =
      requestCursor !== undefined && requestCursor.token.length > 0
        ? requestCursor.token
        : undefined;

    // One in-process stream over a single pinned snapshot (pinned once from the cursor or the
    // request consistency). Batch up to `limit` relationships per response message - mirroring the
    // prior per-page reply shape - carrying the last item's cursor as that batch's continuation
    // cursor.
    const batchSize = limit > 0 ? limit : DEFAULT_EXPORT_BATCH_SIZE;
    let batch: RelationshipStreamItem[] = [];
    try {
      for await (const item of this.#relationshipReads.bulkExportRelationships(
        { filter, limit, cursor, consistency },
        signal,
      )) {
        batch.push(item);
        if (batch.length >= batchSize) {
          await writeExportBatch(responseStream, batch);
          batch = [];
        }
      }
    } catch (error) {
      if (error instanceof InvalidConsistencyTokenException) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof RevisionNotFoundException) {
        // The pinned revision has been garbage-collected (or never existed): same client-facing
        // contract as an invalid consistency token.
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof FormatError) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (!isClientDisconnect(error, signal)) {
        throw error;
      }
      // A client that stops reading (or disconnects) cancels the request token; treat it as a
      // normal end of the stream, not an error (mirrors AuthzedWatchV1Service.watch). Any
      // already-written batches stand; the trailing partial batch below is STILL written.
    }

    if (batch.length > 0) {
      await writeExportBatch(responseStream, batch);
    }
  }
}

/** The default per-message bulk-export batch size when the request leaves the limit unset. */
const DEFAULT_EXPORT_BATCH_SIZE = 1000;

/** `WriteExportBatch`: the batch's continuation cursor is the LAST item's resume cursor. */
async function writeExportBatch(
  responseStream: ServerStreamWriter<ExportBulkRelationshipsResponse>,
  batch: readonly RelationshipStreamItem[],
): Promise<void> {
  const last = batch[batch.length - 1] as RelationshipStreamItem;
  await responseStream.write({
    afterResultCursor: { token: last.resumeCursor },
    relationships: batch.map((i) => toProtoRelationship(i.relationship)),
  });
}

/** `EmptyFilter`: a static all-absent filter, so a frozen module constant rather than a factory. */
const EMPTY_FILTER: RelationshipsFilterWire = Object.freeze({
  resourceType: undefined,
  resourceIdPrefix: undefined,
  resourceIds: undefined,
  resourceRelation: undefined,
  subjectType: undefined,
  subjectIds: undefined,
  subjectRelation: undefined,
});

// ---- conversions ----

/**
 * Maps a wire permissionship onto the v1 lookup permissionship: caveated is CONDITIONAL and
 * EVERYTHING ELSE is HAS_PERMISSION. It never emits UNSPECIFIED and never NO_PERMISSION - a
 * non-member is simply not streamed.
 */
function toLookupPermissionship(p: PermissionshipWire): LookupPermissionship {
  return p.isCaveated
    ? LookupPermissionship.LOOKUP_PERMISSIONSHIP_CONDITIONAL_PERMISSION
    : LookupPermissionship.LOOKUP_PERMISSIONSHIP_HAS_PERMISSION;
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

/**
 * `preconditions.Count == 0 ? null : ...`. Unlike the v0 surface, an UNSPECIFIED operation is
 * REJECTED with INVALID_ARGUMENT rather than silently defaulted; ts-proto decodes an absent enum
 * as 0 = UNSPECIFIED, so this fires for any client that omits the field.
 */
function toWirePreconditions(
  preconditions: readonly Precondition[],
): readonly PreconditionWire[] | undefined {
  if (preconditions.length === 0) {
    return undefined;
  }

  return preconditions.map((p) => {
    let op: PreconditionWire["operation"];
    switch (p.operation) {
      case Precondition_Operation.OPERATION_MUST_MATCH:
        op = "mustMatch";
        break;
      case Precondition_Operation.OPERATION_MUST_NOT_MATCH:
        op = "mustNotMatch";
        break;
      default:
        throw new RpcError(status.INVALID_ARGUMENT, "precondition operation is unspecified");
    }
    return { operation: op, filter: toWireFilter(p.filter ?? EMPTY_RELATIONSHIP_FILTER) };
  });
}

/** Maps a proto relationship update, REJECTING an unspecified operation with INVALID_ARGUMENT. */
function toWireRelationshipUpdate(u: RelationshipUpdate): RelationshipUpdateWire {
  let op: RelationshipUpdateOpWire;
  switch (u.operation) {
    case RelationshipUpdate_Operation.OPERATION_CREATE:
      op = "create";
      break;
    case RelationshipUpdate_Operation.OPERATION_TOUCH:
      op = "touch";
      break;
    case RelationshipUpdate_Operation.OPERATION_DELETE:
      op = "delete";
      break;
    default:
      throw new RpcError(status.INVALID_ARGUMENT, "relationship update operation is unspecified");
  }
  return { operation: op, relationship: toWireRelationship(u.relationship ?? EMPTY_RELATIONSHIP) };
}

/**
 * Maps a v1 proto relationship onto the cross-grain wire form.
 *
 * SOURCE CONCERN, transliterated: the C# passes `null` for the expiration on the claim that "v1
 * core.proto Relationship has no expiration field in this snapshot". The vendored proto DOES
 * declare `optional_expires_at = 5` and the generated binding carries `optionalExpiresAt`, so an
 * authzed-v1 client's expiry is silently dropped and the relationship is stored as non-expiring.
 * The field is deliberately NOT read here.
 */
function toWireRelationship(r: ProtoRelationship): RelationshipWire {
  const subject = r.subject ?? EMPTY_SUBJECT_REFERENCE;
  const subjectRelation = isNullOrEmpty(subject.optionalRelation)
    ? ELLIPSIS
    : subject.optionalRelation;
  const subjectObject = subject.object ?? EMPTY_OBJECT_REFERENCE;
  const resource = r.resource ?? EMPTY_OBJECT_REFERENCE;
  const caveat = r.optionalCaveat;
  return {
    resourceType: resource.objectType,
    resourceId: resource.objectId,
    resourceRelation: r.relation,
    subjectType: subjectObject.objectType,
    subjectId: subjectObject.objectId,
    subjectRelation,
    // `CaveatName.Length: > 0` gates only the NAME; the context is taken from any present caveat.
    caveatName:
      caveat !== undefined && caveat.caveatName.length > 0 ? caveat.caveatName : undefined,
    caveatContext: caveat !== undefined ? structToMap(caveat.context) : undefined,
    expiration: undefined,
  };
}

/**
 * Maps a wire relationship back to v1 proto, blanking an ellipsis subrelation.
 *
 * SOURCE CONCERN, transliterated: `optional_expires_at` is never populated, so a stored expiry is
 * invisible to a v1 client on ReadRelationships and ExportBulkRelationships alike. See
 * {@link toWireRelationship}.
 */
function toProtoRelationship(w: RelationshipWire): ProtoRelationship {
  const rel: ProtoRelationship = {
    resource: { objectType: w.resourceType, objectId: w.resourceId },
    relation: w.resourceRelation,
    subject: {
      object: { objectType: w.subjectType, objectId: w.subjectId },
      optionalRelation: w.subjectRelation === ELLIPSIS ? "" : w.subjectRelation,
    },
  };
  if (w.caveatName !== undefined && w.caveatName.length > 0) {
    rel.optionalCaveat = {
      caveatName: w.caveatName,
      context: mapToStruct(w.caveatContext),
    };
  }

  return rel;
}

/**
 * Maps a v1 relationship filter onto the grains filter wire. The v1 filter carries a SINGLE
 * `optional_resource_id` and a NESTED `optional_subject_filter` (with its own nested
 * `optional_relation` MESSAGE, hence two levels of absence), while the wire filter takes LISTS -
 * hence the one-element list wrapping.
 */
function toWireFilter(f: ProtoRelationshipFilter): RelationshipsFilterWire {
  const resourceIds = isNullOrEmpty(f.optionalResourceId) ? undefined : [f.optionalResourceId];

  let subjectType: string | undefined;
  let subjectIds: readonly string[] | undefined;
  let subjectRelation: string | undefined;
  const sub = f.optionalSubjectFilter;
  if (sub !== undefined) {
    subjectType = nullIfEmpty(sub.subjectType);
    subjectIds = isNullOrEmpty(sub.optionalSubjectId) ? undefined : [sub.optionalSubjectId];
    subjectRelation =
      sub.optionalRelation !== undefined ? nullIfEmpty(sub.optionalRelation.relation) : undefined;
  }

  return {
    resourceType: nullIfEmpty(f.resourceType),
    resourceIdPrefix: nullIfEmpty(f.optionalResourceIdPrefix),
    resourceIds,
    resourceRelation: nullIfEmpty(f.optionalRelation),
    subjectType,
    subjectIds,
    subjectRelation,
  };
}

/** Maps an expansion tree node onto proto, recursively. Exactly one of `leaf` / `intermediate`. */
function toProtoTreeNode(node: ExpandTreeNodeWire): PermissionRelationshipTree {
  const result: PermissionRelationshipTree = {
    expandedObject: { objectType: node.expandedType, objectId: node.expandedId },
    expandedRelation: node.expandedRelation,
  };

  if (node.isLeaf) {
    // v1 DirectSubjectSet carries plain SubjectReferences with no per-subject caveat slots; a
    // wildcard is represented by object_id == "*".
    result.leaf = { subjects: node.subjects.map(toProtoSubjectReference) };
  } else {
    result.intermediate = {
      operation: toProtoSetOperation(node.operation),
      children: node.children.map(toProtoTreeNode),
    };
  }

  return result;
}

/** Maps one expansion subject onto a v1 SubjectReference, blanking an ellipsis subrelation. */
function toProtoSubjectReference(s: ExpandSubjectWire): SubjectReference {
  return {
    object: { objectType: s.subjectType, objectId: s.subjectId },
    optionalRelation: s.subjectRelation === ELLIPSIS ? "" : s.subjectRelation,
  };
}

/** Maps the set operation of an internal tree node onto proto. */
function toProtoSetOperation(op: SetOpWire): AlgebraicSubjectSet_Operation {
  switch (op) {
    case "union":
      return AlgebraicSubjectSet_Operation.OPERATION_UNION;
    case "intersection":
      return AlgebraicSubjectSet_Operation.OPERATION_INTERSECTION;
    case "exclusion":
      return AlgebraicSubjectSet_Operation.OPERATION_EXCLUSION;
    default:
      return AlgebraicSubjectSet_Operation.OPERATION_UNSPECIFIED;
  }
}

/**
 * Maps the proto consistency oneof onto the cross-grain {@link ConsistencyWire}. An absent message
 * or an unset oneof is minimize-latency - the server default.
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

/**
 * Maps a caveat-evaluation failure onto a gRPC status: a context value that does not match a
 * declared parameter type is `INVALID_ARGUMENT` (SpiceDB `ParameterTypeError`); a reference to a
 * caveat absent from the schema is `FAILED_PRECONDITION` (SpiceDB `CaveatNameNotFoundErr`, a
 * schema-skew condition).
 */
function toRpcCaveat(ex: CaveatEvaluationException): RpcError {
  return new RpcError(caveatStatus(ex.kind), ex.message);
}

/** `ParameterTypeMismatch` is a client error; every other kind is a precondition failure. */
function caveatStatus(kind: CaveatEvaluationErrorKind): status {
  return kind === "parameterTypeMismatch" ? status.INVALID_ARGUMENT : status.FAILED_PRECONDITION;
}

/**
 * Maps a cross-silo dispatch failure surfaced by the dispatcher onto its deliberately chosen gRPC
 * status (cf. SpiceDB `rewriteError`): a transient transport/silo-availability failure is retriable
 * `UNAVAILABLE`; a cancellation is `CANCELLED`; a deadline is `DEADLINE_EXCEEDED`; anything else is
 * `INTERNAL`.
 */
function toRpcDispatch(ex: DispatchFailedException): RpcError {
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

/** `ToStatusCode(WriteConflictKind)`: a duplicate CREATE is permanent, a serialization race is not. */
function toStatusCode(kind: WriteConflictKind): status {
  return kind === "createExisting" ? status.ALREADY_EXISTS : status.ABORTED;
}

/** `catch (OperationCanceledException) when (context.CancellationToken.IsCancellationRequested)`. */
function isClientDisconnect(error: unknown, signal: AbortSignal | undefined): boolean {
  return isCancellationError(error) && signal?.aborted === true;
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
 * message field null. TypeScript has no such reference, so an absent submessage reads as the proto
 * DEFAULT instance instead, which is what Go's generated getters (and therefore SpiceDB itself) do:
 * every scalar comes back empty and the request fails its own validation downstream.
 */
const EMPTY_OBJECT_REFERENCE: ObjectReference = Object.freeze({ objectType: "", objectId: "" });

/** The default `SubjectReference`; its own `object` is likewise absent. */
const EMPTY_SUBJECT_REFERENCE: SubjectReference = Object.freeze({ optionalRelation: "" });

/** The default v1 `RelationshipFilter`: every field empty, so the filter matches everything. */
const EMPTY_RELATIONSHIP_FILTER: ProtoRelationshipFilter = Object.freeze({
  resourceType: "",
  optionalResourceId: "",
  optionalResourceIdPrefix: "",
  optionalRelation: "",
});

/** The default v1 `Relationship`, for an update that carries none. */
const EMPTY_RELATIONSHIP: ProtoRelationship = Object.freeze({ relation: "" });

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
