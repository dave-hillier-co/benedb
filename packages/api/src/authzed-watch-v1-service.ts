import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { decodeRevision, zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import {
  RevisionNotFoundException,
  WatchDisabledException,
} from "@spacedb/datastore/datastore-exceptions";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import type { RevisionChange, WatchContent, WatchOptions } from "@spacedb/datastore/watch";
import { WatchContent as WatchContentFlags } from "@spacedb/datastore/watch";
import type { ISchemaProvider } from "@spacedb/grains/i-schema-provider";
import type {
  Relationship as ProtoRelationship,
  RelationshipUpdate as ProtoRelationshipUpdate,
} from "@spacedb/protos/authzed/api/v1/core";
import { RelationshipUpdate_Operation } from "@spacedb/protos/authzed/api/v1/core";
import type { WatchRequest, WatchResponse } from "@spacedb/protos/authzed/api/v1/watch_service";
import { WatchKind } from "@spacedb/protos/authzed/api/v1/watch_service";
import { isCancellationError } from "@thresh/core/errors";

import { RpcError } from "./rpc-error";
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
 * SOURCE CONCERN, transliterated rather than fixed (unsure). {@link resolveContent} reproduces the
 * C#'s `ResolveContent` (lines 145-163), whose comment says "If only checkpoints (or only schema)
 * were selected, we still need a content slice or the changefeed would emit nothing to checkpoint
 * over; SpiceDB's content selection is additive" - but the code adds no content slice, so
 * `optional_update_kinds = [WATCH_KIND_INCLUDE_CHECKPOINTS]` alone yields `checkpoints` (4) with
 * the `relationships` bit (1) UNSET. The comment and the code disagree; the CODE is ported.
 *
 * SOURCE CONCERN, second, already recorded on `authzed-permissions-v1-service.ts`:
 * {@link toProtoRelationship} never sets `optional_expires_at`, although the vendored
 * `authzed/api/v1/core.proto` declares it and the generated bindings carry `optionalExpiresAt`, so
 * a watched relationship's expiration is dropped on this surface. The omission is deliberate.
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
        const response = this.#toResponse(change, datastoreId, objectTypeFilter);

        // Checkpoints always flow through (they carry revision-progress liveness for filtered
        // consumers). Otherwise skip a content response whose every update was filtered out.
        // THE FOUR-WAY CONJUNCTION IS THE BEHAVIOUR, not a tidy "skip empties": with NO filter an
        // empty content response still goes on the wire.
        if (
          change.isCheckpoint !== true &&
          response.updates.length === 0 &&
          change.schemaChanged !== true &&
          objectTypeFilter !== undefined
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
  ): WatchResponse {
    const token = zedTokenFromRevision(
      change.revision,
      this.#schemaProvider.current.schemaHash,
      datastoreId,
    );
    const response: WatchResponse = {
      updates: [],
      changesThrough: { token: token.token },
      schemaUpdated: change.schemaChanged ?? false,
      isCheckpoint: change.isCheckpoint ?? false,
      // Not set by the C# at all; the proto default for a repeated field, spelled out because a
      // ts-proto message is a plain object with no defaults of its own.
      fullRevisionMetadata: [],
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

      response.updates.push(toProtoUpdate(update));
    }

    return response;
  }
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

  // The C# comment here promises an additive content slice when only checkpoints (or only schema)
  // were selected; the code does not add one, and the code is what is ported. See the class
  // doc-comment's source concern.
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

  return proto;
}

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
