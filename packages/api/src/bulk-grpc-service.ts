import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@benedb/core/core-constants";
import { FormatError } from "@benedb/core/format-error";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { InvalidConsistencyTokenException } from "@benedb/core/invalid-consistency-token-exception";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { ConsistencyWire } from "@benedb/grains/consistency-wire";
import { MINIMIZE_LATENCY_WIRE } from "@benedb/grains/consistency-wire";
import type { IRelationshipsGrain } from "@benedb/grains/i-relationships-grain";
import {
  IRelationshipsGrain as IRelationshipsGrainDefinition,
  RELATIONSHIPS_GRAIN_KEY,
} from "@benedb/grains/i-relationships-grain";
import type { RelationshipReads } from "@benedb/grains/relationship-reads";
import type {
  RelationshipsFilterWire,
  RelationshipStreamItem,
  RelationshipWire,
} from "@benedb/grains/relationships-dtos";
import { SequencerOverloadedException } from "@benedb/grains/sequencer-overloaded-exception";
import { WriteConflictException } from "@benedb/grains/write-conflict-exception";
import type {
  Consistency,
  ExportBulkRelationshipsRequest,
  ExportBulkRelationshipsResponse,
  ImportBulkRelationshipsRequest,
  ImportBulkRelationshipsResponse,
  Relationship as ProtoRelationship,
  RelationshipFilter as ProtoRelationshipFilter,
} from "@benedb/protos/permissions";
import { isCancellationError } from "@thresh/core/errors";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import { RpcError } from "./rpc-error";
import type { ServerStreamWriter } from "./server-stream-writer";

/** The default per-message bulk-export batch size when the request leaves the limit unset. */
const DEFAULT_EXPORT_BATCH_SIZE = 1000;

/** The lower bound `DateTimeOffset.FromUnixTimeSeconds` accepts (0001-01-01T00:00:00Z). */
const MIN_UNIX_SECONDS = -62135596800n;
/** The upper bound `DateTimeOffset.FromUnixTimeSeconds` accepts (9999-12-31T23:59:59Z). */
const MAX_UNIX_SECONDS = 253402300799n;
/** Nanoseconds per second: the grains DTOs carry expiration as epoch nanos. */
const NANOS_PER_SECOND = 1_000_000_000n;

/**
 * Port of Spiceport `src/Spiceport.Api/BulkGrpcService.cs`: the `spiceport.v0` gRPC front door for
 * streaming bulk import / export of relationships. Both RPCs stream but the data-plane grain stays
 * request/response: import buffers the whole client stream and commits it in ONE grain call, and
 * export drives the server stream by reading in-process through {@link RelationshipReads}. Mirrors
 * authzed.api.v1 ImportBulk / ExportBulk.
 *
 * The C# class doc-comment says import "calls the grain ONCE PER inbound batch"; the CODE (and its
 * inline comment) buffers the whole stream and commits once, for whole-stream atomicity observed
 * against real spicedb 1.49.2. The code is what is ported; the stale doc-comment is not.
 *
 * Port decisions (the C# constructs with no TypeScript counterpart):
 *   * `IServerStreamWriter<T>` becomes {@link ServerStreamWriter} and `IAsyncStreamReader<T>` a
 *     plain `AsyncIterable<T>`; `ServerCallContext` becomes a trailing `AbortSignal`, the only
 *     member the C# reads off it. `@grpc/grpc-js`'s `ServerWritableStream` / `ServerReadableStream`
 *     are adapted onto those seams in `program.ts`, where Node backpressure is handled too.
 *   * `FormatException` has no TypeScript analogue; what a malformed bulk-export cursor throws is
 *     `@benedb/core`'s {@link FormatError}, and that is what the INVALID_ARGUMENT arm catches.
 *   * `catch (OperationCanceledException) when (ct.IsCancellationRequested)` becomes
 *     `isCancellationError(error) && signal?.aborted === true`, matched on the TYPE, never on a
 *     message string.
 *   * `num_loaded` is uint64: a ts-proto STRING out of the `bigint` reply, never a JS `number`.
 *   * `new List<RelationshipStreamItem>(Math.Min(batchSize, 1024))` is a capacity hint only, so the
 *     port is a plain array.
 */
export class BulkGrpcService {
  readonly #grains: GrainFactoryAccess;
  readonly #relationshipReads: RelationshipReads;

  constructor(grains: GrainFactoryAccess, relationshipReads: RelationshipReads) {
    this.#grains = grains;
    this.#relationshipReads = relationshipReads;
  }

  /** `private IRelationshipsGrain Relationships => grains.GetGrain<...>(Key)` - a getter, as the C# is. */
  get #relationships(): IRelationshipsGrain {
    return this.#grains.getGrain(IRelationshipsGrainDefinition, RELATIONSHIPS_GRAIN_KEY);
  }

  /** Buffers the whole client stream and loads it in one grain commit. */
  async importBulkRelationships(
    requestStream: AsyncIterable<ImportBulkRelationshipsRequest>,
    signal?: AbortSignal | undefined,
  ): Promise<ImportBulkRelationshipsResponse> {
    // Buffer the WHOLE client stream, then load it in ONE grain commit - the same shape as the
    // authzed.api.v1 surface (see AuthzedPermissionsV1Service.importBulkRelationships): real
    // SpiceDB's import is atomic across the entire stream and applies CREATE semantics per row
    // (a duplicate anywhere rejects the import, nothing applies). This internal proto surface
    // mirrors ImportBulk deliberately, so it carries the same semantics.
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
      return {
        numLoaded: String(reply.numLoaded),
        loadedAt: { token: reply.loadedAtToken },
      };
    } catch (error) {
      if (error instanceof WriteConflictException) {
        // CREATE-conflict is permanent (do not retry the doomed import); a genuine write-write
        // serialization conflict is retryable - the same split the authzed surface maps.
        const code = error.kind === "createExisting" ? status.ALREADY_EXISTS : status.ABORTED;
        throw new RpcError(code, error.message);
      }
      if (error instanceof SequencerOverloadedException) {
        // The per-silo admission gate shed this commit - the sequencer is saturated. A deliberate,
        // retryable overload signal (back off and retry), never an opaque timeout.
        throw new RpcError(status.RESOURCE_EXHAUSTED, error.message);
      }
      throw error;
    }
  }

  /** Streams the filtered relationship set back to the client, one batch per response message. */
  async exportBulkRelationships(
    request: ExportBulkRelationshipsRequest,
    responseStream: ServerStreamWriter<ExportBulkRelationshipsResponse>,
    signal?: AbortSignal | undefined,
  ): Promise<void> {
    const filter =
      request.optionalFilter !== undefined ? toWireFilter(request.optionalFilter) : EMPTY_FILTER;
    // `(int)request.OptionalLimit` on a proto uint32: C# is unchecked, so a value above
    // int.MaxValue WRAPS NEGATIVE. `| 0` is that same narrowing and is the identity for every
    // value a real client sends; without it the port would accept a 3-billion limit the C#
    // fast-fails on.
    const limit = request.optionalLimit | 0;
    const consistency = toWireConsistency(request.consistency);
    const cursor = isNullOrEmpty(request.optionalCursor) ? undefined : request.optionalCursor;

    // One in-process stream over a single pinned snapshot (pinned once from the cursor or the
    // request consistency). Batch up to `limit` relationships per response message, carrying the
    // last item's cursor as that batch's continuation cursor.
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
      if (!(isCancellationError(error) && signal?.aborted === true)) {
        throw error;
      }
      // A client that stops reading (or disconnects) cancels the request token; treat it as a
      // normal end of the stream, not an error (mirrors AuthzedWatchV1Service.watch's cancellation
      // handling). Any already-written batches stand; the trailing partial batch below is still
      // written.
    }

    if (batch.length > 0) {
      await writeExportBatch(responseStream, batch);
    }
  }
}

/** `WriteExportBatch`: the batch's continuation cursor is the LAST item's resume cursor. */
async function writeExportBatch(
  responseStream: ServerStreamWriter<ExportBulkRelationshipsResponse>,
  batch: readonly RelationshipStreamItem[],
): Promise<void> {
  const last = batch[batch.length - 1] as RelationshipStreamItem;
  const response: ExportBulkRelationshipsResponse = {
    afterCursor: last.resumeCursor,
    relationships: batch.map((i) => toProtoRelationship(i.relationship)),
  };
  await responseStream.write(response);
}

/** `EmptyFilter`: every field unset, so the filter constrains nothing. */
const EMPTY_FILTER: RelationshipsFilterWire = Object.freeze({
  resourceType: undefined,
  resourceIdPrefix: undefined,
  resourceIds: undefined,
  resourceRelation: undefined,
  subjectType: undefined,
  subjectIds: undefined,
  subjectRelation: undefined,
});

/** Maps a proto relationship filter, dropping every empty field. */
function toWireFilter(f: ProtoRelationshipFilter): RelationshipsFilterWire {
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

/** Maps a proto relationship onto the cross-grain wire form. */
function toWireRelationship(r: ProtoRelationship): RelationshipWire {
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
    caveatContext: caveat !== undefined ? structToMap(caveat.context) : undefined,
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
function toProtoRelationship(w: RelationshipWire): ProtoRelationship {
  const rel: ProtoRelationship = {
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

/**
 * `ToWire(Consistency)`. The C# switches on `RequirementCase`, which is set by ASSIGNMENT, so the
 * port tests which FIELD is defined (in the C#'s case order) rather than whether its value is
 * truthy: a `fully_consistent: false` still selects fully-consistent.
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
 * The C# dereferences every submessage unconditionally (`r.Subject.Object.ObjectType`), which on an
 * ABSENT submessage is a `NullReferenceException`. As in `permissions-grpc-service.ts`, an absent
 * submessage reads as the proto DEFAULT instance instead, which is what Go's generated getters do.
 */
const EMPTY_OBJECT_REFERENCE = Object.freeze({ objectType: "", objectId: "" });

/** The default `SubjectReference`; its own `object` is likewise absent. */
const EMPTY_SUBJECT_REFERENCE = Object.freeze({ optionalRelation: "" }) as {
  optionalRelation: string;
  object?: { objectType: string; objectId: string } | undefined;
};

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
