import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import type { Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { decodeRevision, zedTokenFromRevision } from "@benedb/core/zed-tokens";
import {
  RevisionNotFoundException,
  WatchDisabledException,
} from "@benedb/datastore/datastore-exceptions";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import type { RevisionChange, WatchContent, WatchOptions } from "@benedb/datastore/watch";
import { WatchContent as WatchContentFlags } from "@benedb/datastore/watch";
import type { ISchemaProvider, SchemaSnapshot } from "@benedb/grains/i-schema-provider";
import type {
  Relationship as ProtoRelationship,
  RelationshipUpdate as ProtoRelationshipUpdate,
} from "@benedb/protos/authzed/api/v1/core";
import { RelationshipUpdate_Operation } from "@benedb/protos/authzed/api/v1/core";
import type { RelationshipFilter } from "@benedb/protos/authzed/api/v1/permission_service";
import type { WatchRequest, WatchResponse } from "@benedb/protos/authzed/api/v1/watch_service";
import { WatchKind } from "@benedb/protos/authzed/api/v1/watch_service";
import { isCancellationError } from "@thresh/core/errors";

import { RpcError } from "./rpc-error";
import { checkNamespaceAndRelations } from "./schema-validation";
import type { ServerStreamWriter } from "./server-stream-writer";

/**
 * Port of Spiceport `src/Spiceport.Api/AuthzedWatchV1Service.cs`: the gRPC front door for
 * `authzed.api.v1.WatchService`. Server-streaming Watch tails the silo-singleton `IDatastore.watch`
 * directly (a long-lived stream is a poor fit for a request/response grain). Each emitted
 * `WatchResponse` carries its own ZedToken (`changes_through`) so a client can resume exactly once
 * after a disconnect. v1 deltas vs the internal `watch-grpc-service.ts`: an
 * `optional_object_types` filter on emitted updates, an `is_checkpoint` field, and
 * `WatchKind.INCLUDE_CHECKPOINTS` in the content selector.
 *
 * (The C# class doc-comment's "no `schema_updated` field (this snapshot watches relationships
 * only)" is STALE - `ToResponse` sets it - so the code is ported and the claim dropped.)
 *
 * Port decisions (the C# constructs with no TypeScript counterpart), all settled in
 * `watch-grpc-service.ts` and reused verbatim:
 *   * `(request, IServerStreamWriter<T>, ServerCallContext)` becomes
 *     `(request, ServerStreamWriter<T>, AbortSignal | undefined)`; Node stream backpressure lives
 *     in the host adapter, not in a service body.
 *   * `GetAsyncEnumerator` / `MoveNextAsync` / `DisposeAsync` becomes a MANUAL
 *     `[Symbol.asyncIterator]()` / `next()` / `return?.()` loop, not `for await`: the loop must
 *     distinguish cancellation from the two FAILED_PRECONDITION exceptions and must re-check the
 *     signal between the move and the write, and `for await` allows neither.
 *   * `catch (OperationCanceledException)` becomes `isCancellationError`, matched on the TYPE and
 *     never on a message string; a cancellation is a NORMAL end of stream.
 *   * `RpcException(new Status(code, detail))` becomes {@link RpcError}.
 *   * `HashSet<string>` over `optional_object_types` becomes a `Set`, ordinal membership. An EMPTY
 *     list is NO filter (`undefined`), never an empty set that matches nothing.
 *
 * {@link resolveContent} reproduces the C#'s `ResolveContent` with no additive fallback - the
 * source's stale comment claiming one was needed was corrected upstream (issue #43, Spiceport
 * `21dc4d3`): checkpoint emission is keyed off commit activity itself, so a checkpoints-only mask
 * still sees checkpoints on every commit.
 *
 * {@link toProtoRelationship} populates `optional_expires_at` from a stored expiry - the earlier
 * deliberate omission was fixed at the source (issue #39, Spiceport `ad647b4`).
 */
export class AuthzedWatchV1Service {
  readonly #datastore: IDatastore;
  readonly #schemaProvider: ISchemaProvider;

  constructor(datastore: IDatastore, schemaProvider: ISchemaProvider) {
    this.#datastore = datastore;
    this.#schemaProvider = schemaProvider;
  }

  /** Tails the datastore changefeed, writing one response per surviving revision change. */
  async watch(
    request: WatchRequest,
    responseStream: ServerStreamWriter<WatchResponse>,
    signal?: AbortSignal | undefined,
  ): Promise<void> {
    // `cannot specify both object types and relationship filters` (SpiceDB watch.go): the two
    // filter modes are mutually exclusive whenever the request's content selection would include
    // relationships at all - an empty kind list, UNSPECIFIED, or an explicit
    // INCLUDE_RELATIONSHIP_UPDATES. A schema-only or checkpoints-only request never reaches the
    // relationship filters at all, so upstream lets both lists ride unused in that case.
    if (
      request.optionalObjectTypes.length > 0 &&
      request.optionalRelationshipFilters.length > 0 &&
      (request.optionalUpdateKinds.length === 0 ||
        request.optionalUpdateKinds.includes(WatchKind.WATCH_KIND_UNSPECIFIED) ||
        request.optionalUpdateKinds.includes(WatchKind.WATCH_KIND_INCLUDE_RELATIONSHIP_UPDATES))
    ) {
      throw new RpcError(
        status.INVALID_ARGUMENT,
        "cannot specify both object types and relationship filters",
      );
    }

    // Validate and convert each relationship filter BEFORE opening the changefeed - an unknown
    // definition/relation or a malformed filter is a request-shape error, not a stream fault.
    const relationshipFilters =
      request.optionalRelationshipFilters.length === 0
        ? undefined
        : request.optionalRelationshipFilters.map((filter) => {
            validateRelationshipFilter(filter, this.#schemaProvider.current);
            return filter;
          });

    // Empty => no filter; otherwise emit only updates whose resource object type is in the set.
    const objectTypeFilter =
      request.optionalObjectTypes.length === 0
        ? undefined
        : new Set<string>(request.optionalObjectTypes);

    // Resolve the start cursor: a supplied token decodes to its revision (rejecting a mismatched
    // datastore); otherwise start from current head so only future writes are tailed.
    let afterRevision: IRevision;
    const cursor = request.optionalStartCursor;
    if (cursor !== undefined && cursor.token.length > 0) {
      const parser = await this.#datastore.getRevisionParser(signal);
      const decoded = decodeRevision({ token: cursor.token }, parser);
      if (decoded.status === "mismatchedDatastoreId") {
        throw new RpcError(
          status.INVALID_ARGUMENT,
          "start cursor was generated by a different datastore instance",
        );
      }
      if (decoded.status === "unknown") {
        throw new RpcError(status.INVALID_ARGUMENT, "invalid start cursor");
      }
      afterRevision = decoded.revision;
    } else {
      const head = await this.#datastore.headRevision(signal);
      afterRevision = head.revision;
    }

    const datastoreId = await this.#datastore.getUniqueId(signal);
    const options: WatchOptions = { content: resolveContent(request) };

    // The datastore watch is a lazy iterator: cursor-validity and watch-enablement checks throw on
    // the first `next()`, not at `[Symbol.asyncIterator]()` (an async-generator body does not run
    // until the first `next()` call), so the catch must wrap the iteration, not the iterator
    // creation.
    const stream = this.#datastore.watch(afterRevision, options, signal);
    const enumerator = stream[Symbol.asyncIterator]();

    try {
      for (;;) {
        let moved: IteratorResult<RevisionChange>;
        try {
          moved = await enumerator.next();
        } catch (error) {
          if (isCancellationError(error)) {
            break;
          }
          if (error instanceof RevisionNotFoundException) {
            // The cursor is older than the retained GC window - cannot replay from it.
            throw new RpcError(status.FAILED_PRECONDITION, error.message);
          }
          if (error instanceof WatchDisabledException) {
            // The backend cannot support Watch (e.g. Postgres without track_commit_timestamp=on).
            throw new RpcError(status.FAILED_PRECONDITION, error.message);
          }
          throw error;
        }

        if (moved.done === true) {
          break;
        }

        if (signal?.aborted === true) {
          break;
        }

        const change = moved.value;
        const response = this.#toResponse(
          change,
          datastoreId,
          objectTypeFilter,
          relationshipFilters,
        );

        // Checkpoints always flow through (they carry revision-progress liveness for filtered
        // consumers). Otherwise skip a content response whose every update was filtered out.
        // THE FOUR-WAY CONJUNCTION IS THE BEHAVIOUR, not a tidy "skip empties": with NO filter an
        // empty content response still goes on the wire.
        if (
          change.isCheckpoint !== true &&
          response.updates.length === 0 &&
          change.schemaChanged !== true &&
          (objectTypeFilter !== undefined || relationshipFilters !== undefined)
        ) {
          continue;
        }

        await responseStream.write(response);
      }
    } finally {
      await enumerator.return?.();
    }
  }

  /** `ToResponse`: mints this revision's ZedToken from the AMBIENT schema hash, read per response. */
  #toResponse(
    change: RevisionChange,
    datastoreId: string,
    objectTypeFilter: ReadonlySet<string> | undefined,
    relationshipFilters: readonly RelationshipFilter[] | undefined,
  ): WatchResponse {
    const token = zedTokenFromRevision(
      change.revision,
      this.#schemaProvider.current.schemaHash,
      datastoreId,
    );
    const metadatas = change.transactionMetadatas ?? [];
    const response: WatchResponse = {
      updates: [],
      changesThrough: { token: token.token },
      schemaUpdated: change.schemaChanged ?? false,
      isCheckpoint: change.isCheckpoint ?? false,
      // Ambiguity rule (SpiceDB watch.go): exactly one blob resolves `optional_transaction_metadata`;
      // zero or more than one leaves it unset (absent, or ambiguous which one to return).
      optionalTransactionMetadata: metadatas.length === 1 ? mapToStruct(metadatas[0]) : undefined,
      fullRevisionMetadata: metadatas.map((m) => mapToStruct(m) ?? {}),
    };

    // A checkpoint carries no content, only the revision - the updates list stays EMPTY even when
    // the change carries relationship changes.
    if (change.isCheckpoint === true) {
      return response;
    }

    for (const update of change.relationshipChanges) {
      if (
        objectTypeFilter !== undefined &&
        !objectTypeFilter.has(update.relationship.reference.resource.objectType)
      ) {
        continue;
      }

      // A relationship-filter update is emitted once it matches AT LEAST ONE supplied filter
      // (`filterRelationshipUpdates` in SpiceDB's watch.go).
      if (
        relationshipFilters !== undefined &&
        !relationshipFilters.some((filter) =>
          relationshipFilterMatches(filter, update.relationship),
        )
      ) {
        continue;
      }

      response.updates.push(toProtoUpdate(update));
    }

    return response;
  }
}

/**
 * Validates one `optional_relationship_filters` entry, mirroring SpiceDB's
 * `validateRelationshipsFilter` (`internal/services/v1/relationships.go`): the resource
 * type/relation and the subject type/relation (when supplied) must resolve against the schema, a
 * resource id and a resource id prefix cannot both be set, and at least one field must be set.
 */
function validateRelationshipFilter(filter: RelationshipFilter, snapshot: SchemaSnapshot): void {
  if (filter.resourceType.length > 0) {
    checkNamespaceAndRelations(snapshot, {
      definitionName: filter.resourceType,
      relationName: filter.optionalRelation.length > 0 ? filter.optionalRelation : ELLIPSIS,
      allowEllipsis: filter.optionalRelation.length === 0,
    });
  }

  const subjectFilter = filter.optionalSubjectFilter;
  if (subjectFilter !== undefined) {
    const subjectRelation = subjectFilter.optionalRelation?.relation ?? "";
    checkNamespaceAndRelations(snapshot, {
      definitionName: subjectFilter.subjectType,
      relationName: subjectRelation.length > 0 ? subjectRelation : ELLIPSIS,
      allowEllipsis: subjectRelation.length === 0,
    });
  }

  if (filter.optionalResourceId.length > 0 && filter.optionalResourceIdPrefix.length > 0) {
    throw new RpcError(
      status.INVALID_ARGUMENT,
      "the relationship filter provided is not valid: resource_id and resource_id_prefix " +
        "cannot be set at the same time",
    );
  }

  if (
    filter.resourceType.length === 0 &&
    filter.optionalResourceId.length === 0 &&
    filter.optionalResourceIdPrefix.length === 0 &&
    filter.optionalRelation.length === 0 &&
    filter.optionalSubjectFilter === undefined
  ) {
    throw new RpcError(
      status.INVALID_ARGUMENT,
      "the relationship filter provided is not valid: at least one field must be set",
    );
  }
}

/**
 * Tests a single relationship against one `RelationshipFilter`, mirroring
 * `RelationshipsFilter.Test` / `SubjectsSelector.Test` (`pkg/datastore/datastore.go`) applied to the
 * wire shape of a v1 `RelationshipFilter` directly (a single resource id / subject id rather than the
 * datastore's list form).
 */
function relationshipFilterMatches(
  filter: RelationshipFilter,
  relationship: Relationship,
): boolean {
  const resource = relationship.reference.resource;
  if (filter.resourceType.length > 0 && filter.resourceType !== resource.objectType) return false;
  if (filter.optionalResourceId.length > 0 && filter.optionalResourceId !== resource.objectId)
    return false;
  if (
    filter.optionalResourceIdPrefix.length > 0 &&
    !resource.objectId.startsWith(filter.optionalResourceIdPrefix)
  )
    return false;
  if (filter.optionalRelation.length > 0 && filter.optionalRelation !== resource.relation)
    return false;

  const subjectFilter = filter.optionalSubjectFilter;
  if (subjectFilter !== undefined) {
    const subject = relationship.reference.subject;
    if (subjectFilter.subjectType.length > 0 && subjectFilter.subjectType !== subject.objectType)
      return false;
    if (
      subjectFilter.optionalSubjectId.length > 0 &&
      subjectFilter.optionalSubjectId !== subject.objectId
    )
      return false;

    const relationFilter = subjectFilter.optionalRelation;
    if (relationFilter !== undefined) {
      const wantEllipsis = relationFilter.relation.length === 0;
      const wantRelation = wantEllipsis ? ELLIPSIS : relationFilter.relation;
      if (subject.relation !== wantRelation) return false;
    }
  }

  return true;
}

/**
 * `ResolveContent`: an empty kind list is relationships; otherwise the flags are OR-ed, with
 * INCLUDE_SCHEMA_UPDATES -> schema, INCLUDE_CHECKPOINTS -> checkpoints, and EVERYTHING ELSE
 * (UNSPECIFIED and INCLUDE_RELATIONSHIP_UPDATES alike) -> relationships.
 */
function resolveContent(request: WatchRequest): WatchContent {
  if (request.optionalUpdateKinds.length === 0) {
    return WatchContentFlags.relationships;
  }

  let content = 0;
  for (const kind of request.optionalUpdateKinds) {
    content |=
      kind === WatchKind.WATCH_KIND_INCLUDE_SCHEMA_UPDATES
        ? WatchContentFlags.schema
        : kind === WatchKind.WATCH_KIND_INCLUDE_CHECKPOINTS
          ? WatchContentFlags.checkpoints
          : WatchContentFlags.relationships;
  }

  // No additive fallback needed here: the datastore's checkpoint emission (see IDatastore.watch /
  // WatchOptions) is keyed off commit activity itself, not off whether the requested content flags
  // matched anything, so a checkpoints-only (or schema-only) mask still sees checkpoints emitted
  // on every commit.
  return content;
}

/** `ToProto(RelationshipUpdate)`: anything that is not create/delete is a TOUCH. */
function toProtoUpdate(update: RelationshipUpdate): ProtoRelationshipUpdate {
  const op =
    update.operation === "create"
      ? RelationshipUpdate_Operation.OPERATION_CREATE
      : update.operation === "delete"
        ? RelationshipUpdate_Operation.OPERATION_DELETE
        : RelationshipUpdate_Operation.OPERATION_TOUCH;
  return { operation: op, relationship: toProtoRelationship(update.relationship) };
}

/** `ToProto(Relationship)`, blanking an ellipsis subject relation. */
function toProtoRelationship(rel: Relationship): ProtoRelationship {
  const resource = rel.reference.resource;
  const subject = rel.reference.subject;
  const subjectRelation = subject.relation === ELLIPSIS ? "" : subject.relation;
  const proto: ProtoRelationship = {
    resource: { objectType: resource.objectType, objectId: resource.objectId },
    relation: resource.relation,
    subject: {
      object: { objectType: subject.objectType, objectId: subject.objectId },
      optionalRelation: subjectRelation,
    },
  };

  const caveat = rel.optionalCaveat;
  if (caveat !== undefined) {
    const pc: { caveatName: string; context?: { [key: string]: unknown } | undefined } = {
      caveatName: caveat.caveatName,
    };
    const ctx = mapToStruct(caveat.context);
    if (ctx !== undefined) {
      pc.context = ctx;
    }
    proto.optionalCaveat = pc;
  }

  if (rel.optionalExpiration !== undefined) {
    proto.optionalExpiresAt = new Date(Number(rel.optionalExpiration / NANOS_PER_MILLISECOND));
  }

  return proto;
}

/** ts-proto Timestamps are millisecond `Date`s; core `optionalExpiration` is epoch nanos. */
const NANOS_PER_MILLISECOND = 1_000_000n;

/** `DictToStruct`: an absent or EMPTY dictionary is `undefined` (C# `null`). */
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
 *
 * The C# keeps a private copy of this block per gRPC service; the port keeps that duplication
 * rather than lifting a shared module the source does not have.
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
