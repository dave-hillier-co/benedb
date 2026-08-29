import { registerSurrogate } from "@thresh/core/value-codec";

import type { ConsistencyWire } from "./consistency-wire";

// A deliberately MULTI-EXPORT module, per the port ledger: `RelationshipsDtos.cs` carries the
// whole data-plane relationship wire surface and the shapes only make sense together.
//
// Port decisions settled once, here, for every DTO file in this layer:
//
// - Every C# `ulong` count/limit becomes a `bigint` (`OptionalLimit`, `DeletedCount`, `NumLoaded`,
//   `Count`); an `int? Limit` that is an advisory page size stays a `number`. The rule is per
//   FIELD, not per file.
// - `DateTimeOffset? Expiration` becomes NANOS since the epoch as a `bigint`, matching the
//   already-ported `Relationship.optionalExpiration`. Never a `Date`: the tuple-string format
//   emits 100ns ticks, which a millisecond `Date` cannot round-trip.
// - `IReadOnlyDictionary<string, object?>` caveat context becomes a `ReadonlyMap<string, unknown>`,
//   matching `ContextualizedCaveat.context` (a Map, so JSON key order survives).
// - The two enums become string-literal unions carrying the C#'s NAMES. Their numeric values are
//   Orleans-internal, and in one place they are not declaration-order-innocent: the core
//   `UpdateOperation` orders its members differently, so `WireConvert` maps by NAME and nothing
//   may ever derive one from the other numerically.
// - A C# default parameter value becomes an absent optional member plus a named `??` resolver,
//   never a default baked into the type.

/** The kind of relationship mutation. Mirrors the core `UpdateOperation` (by NAME, never by ordinal). */
export type RelationshipUpdateOpWire = "touch" | "create" | "delete";

/** The operation a `PreconditionWire` asserts about its filter. */
export type PreconditionOpWire = "mustMatch" | "mustNotMatch";

/** A relationship (tuple) on the wire: resource + subject ONR, optional caveat and expiration. */
export interface RelationshipWire {
  /** The resource namespace. */
  readonly resourceType: string;
  /** The resource object id. */
  readonly resourceId: string;
  /** The resource relation. */
  readonly resourceRelation: string;
  /** The subject namespace. */
  readonly subjectType: string;
  /** The subject object id. */
  readonly subjectId: string;
  /** The subject relation (ellipsis for a terminal subject). */
  readonly subjectRelation: string;
  /** The gating caveat's name, or absent for none. */
  readonly caveatName?: string | undefined;
  /** The caveat's relationship-supplied context, or absent for none. */
  readonly caveatContext?: ReadonlyMap<string, unknown> | undefined;
  /** The expiration as NANOS since the Unix epoch, or absent for none. */
  readonly expiration?: bigint | undefined;
}

/**
 * One item of a relationship stream (`readRelationships` / `bulkExportRelationships`): a
 * relationship plus the opaque resume cursor positioned immediately after it. For
 * ReadRelationships the cursor is the canonical tuple string (resumption skips tuples at or before
 * it) and `readAtToken` carries the per-message ZedToken; for BulkExport the cursor pins the export
 * revision plus the last tuple (so a reconnect reads the exact same snapshot) and `readAtToken` is
 * empty (that RPC carries no per-item token).
 *
 * Runs entirely IN-PROCESS - it crosses no grain boundary, so the C# gives it no
 * `[GenerateSerializer]`. Keep it that way: a later slice must not send it.
 */
export interface RelationshipStreamItem {
  /** The relationship on the wire. */
  readonly relationship: RelationshipWire;
  /** The opaque resume cursor positioned immediately after this relationship. */
  readonly resumeCursor: string;
  /** The read-at ZedToken for this item (ReadRelationships), or absent (BulkExport). */
  readonly readAtToken?: string | undefined;
}

/** Resolver for the C# default parameter `string ReadAtToken = ""`. */
export function relationshipStreamItemReadAtToken(item: RelationshipStreamItem): string {
  return item.readAtToken ?? "";
}

/** A single relationship mutation on the wire. */
export interface RelationshipUpdateWire {
  /** The mutation kind. */
  readonly operation: RelationshipUpdateOpWire;
  /** The relationship the mutation targets. */
  readonly relationship: RelationshipWire;
}

/**
 * A precondition checked atomically, inside the write transaction, against the same snapshot the
 * writes commit at. If it fails the whole write is rejected and nothing commits.
 */
export interface PreconditionWire {
  /** What the precondition asserts. */
  readonly operation: PreconditionOpWire;
  /** The filter the assertion is made about. */
  readonly filter: RelationshipsFilterWire;
}

/**
 * The subset of the datastore relationships filter the data-plane API surfaces: resource-side
 * constraints plus a single subject selector. Absent/empty fields place no constraint.
 */
export interface RelationshipsFilterWire {
  /** The resource namespace constraint. */
  readonly resourceType?: string | undefined;
  /** The resource id prefix constraint. */
  readonly resourceIdPrefix?: string | undefined;
  /** The explicit resource id constraint. */
  readonly resourceIds?: readonly string[] | undefined;
  /** The resource relation constraint. */
  readonly resourceRelation?: string | undefined;
  /** The subject namespace constraint. */
  readonly subjectType?: string | undefined;
  /** The explicit subject id constraint. */
  readonly subjectIds?: readonly string[] | undefined;
  /** The subject relation constraint. */
  readonly subjectRelation?: string | undefined;
}

/** Arguments for `IRelationshipsGrain.writeRelationships`. */
export interface WriteRelationshipsArgs {
  /** The mutations, applied in request order. */
  readonly updates: readonly RelationshipUpdateWire[];
  /** The preconditions, or absent for none (distinct from an empty list, as in the C#). */
  readonly preconditions?: readonly PreconditionWire[] | undefined;
}

/** Reply for `IRelationshipsGrain.writeRelationships`. */
export interface WriteRelationshipsReply {
  /** The ZedToken of the revision the write committed at. */
  readonly writtenAtToken: string;
}

/** Arguments for `IRelationshipsGrain.deleteRelationships`. */
export interface DeleteRelationshipsArgs {
  /** The filter naming the rows to close. */
  readonly filter: RelationshipsFilterWire;
  /** The `ulong?` row limit, or absent for unbounded (0n means "delete nothing"). */
  readonly optionalLimit?: bigint | undefined;
  /** The preconditions, or absent for none. */
  readonly preconditions?: readonly PreconditionWire[] | undefined;
}

/** Reply for `IRelationshipsGrain.deleteRelationships`. */
export interface DeleteRelationshipsReply {
  /** The number of rows deleted (`ulong`). */
  readonly deletedCount: bigint;
  /** True when the delete stopped at `optionalLimit`. */
  readonly reachedLimit: boolean;
  /** The ZedToken of the revision the delete committed at. */
  readonly deletedAtToken: string;
}

/**
 * Arguments for `readRelationships`. `limit` is advisory. Crosses no grain boundary - the C# gives
 * it no `[GenerateSerializer]`, and neither does the port.
 */
export interface ReadRelationshipsArgs {
  /** The filter naming the rows to read. */
  readonly filter: RelationshipsFilterWire;
  /** The advisory page size (`int?`), or absent for no advisory limit. */
  readonly limit?: number | undefined;
  /** The opaque continuation cursor, or absent to start. */
  readonly cursor?: string | undefined;
  /** The consistency requirement; absent means minimize-latency at the resolver. */
  readonly consistency?: ConsistencyWire | undefined;
}

/** Arguments for `IRelationshipsGrain.writeSchema`. */
export interface WriteSchemaArgs {
  /** The schema source text. */
  readonly schemaText: string;
}

/** Reply for `IRelationshipsGrain.writeSchema`. */
export interface WriteSchemaReply {
  /** The ZedToken of the revision the schema was written at. */
  readonly writtenAtToken: string;
}

/** Reply for `IRelationshipsGrain.readSchema`. */
export interface ReadSchemaReply {
  /** The schema source text. */
  readonly schemaText: string;
  /** The ZedToken of the revision the schema was read at. */
  readonly readAtToken: string;
}

/**
 * Arguments for `IRelationshipsGrain.bulkImportRelationships`: an entire import's relationships,
 * loaded with CREATE semantics in a single write transaction - a row that already exists (or
 * repeats within the import) rejects the whole import and nothing applies, matching real SpiceDB's
 * ImportBulkRelationships.
 */
export interface BulkImportRelationshipsArgs {
  /** The relationships to create. */
  readonly relationships: readonly RelationshipWire[];
}

/** Reply for `IRelationshipsGrain.bulkImportRelationships`: this batch's load. */
export interface BulkImportRelationshipsReply {
  /** The number of relationships loaded (`ulong`). */
  readonly numLoaded: bigint;
  /** The ZedToken of the revision the import committed at. */
  readonly loadedAtToken: string;
}

/**
 * Arguments for `bulkExportRelationships`: an export over a single pinned snapshot. With no cursor
 * the read resolves and pins a revision from `consistency`; with a cursor it reads the exact
 * revision the cursor encodes (the consistency is then ignored). `limit` is advisory (the caller
 * applies batching/limit by how it consumes the stream). Crosses no grain boundary - no
 * `[GenerateSerializer]` in the C#, and none intended here.
 */
export interface BulkExportRelationshipsArgs {
  /** The filter naming the rows to export. */
  readonly filter: RelationshipsFilterWire;
  /** The advisory batch size. */
  readonly limit: number;
  /** The opaque continuation cursor, or absent to start. */
  readonly cursor?: string | undefined;
  /** The consistency requirement; absent means minimize-latency at the resolver. */
  readonly consistency?: ConsistencyWire | undefined;
}

/**
 * Distinguishes the two on-demand counter failures so the gRPC front door can map them to the
 * right status code. The underlying datastore exceptions are not serializable across the grain
 * boundary, so the grain rethrows a serializable `CounterOperationException` carrying this.
 */
export type CounterErrorKind = "alreadyRegistered" | "notRegistered";

/**
 * Serializable carrier for a counter failure raised inside the grain. Mirrors how schema-compile
 * failures are rethrown as a serializable type across the grain boundary.
 */
export class CounterOperationException extends Error {
  /** Which of the two on-demand counter failures this is. */
  readonly kind: CounterErrorKind;

  /** Creates the exception for the given kind, carrying the message verbatim. */
  constructor(kind: CounterErrorKind, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "CounterOperationException";
    this.kind = kind;
  }
}

// Orleans got this from `[GenerateSerializer]` on the exception type. Both the kind AND the
// message cross: unlike the datastore counter exceptions, the message is not derivable from the
// carried data - the grain composes it from the datastore exception it caught.
registerSurrogate<CounterOperationException>({
  tag: "spacedb.counterOperationException",
  test: (value) => value instanceof CounterOperationException,
  encode: (error) => ({ kind: error.kind, message: error.message }),
  decode: (fields) =>
    new CounterOperationException(fields.kind as CounterErrorKind, fields.message as string),
});

/** Arguments for `IRelationshipsGrain.registerRelationshipCounter`. */
export interface RegisterCounterArgs {
  /** The counter's name. */
  readonly name: string;
  /** The filter the counter counts. */
  readonly filter: RelationshipsFilterWire;
}

/**
 * Reply for `IRelationshipsGrain.registerRelationshipCounter` (empty).
 *
 * An empty record used as a proto placeholder: a bare empty interface is structurally satisfied by
 * every object, so it carries a phantom brand named after ITS OWN type - two brands spelled the
 * same would unify with each other, which is the mis-wiring the brand exists to catch.
 */
export interface RegisterCounterReply {
  readonly __registerCounterReply?: never;
}

/** The single frozen instance of the empty register-counter reply. */
export const REGISTER_COUNTER_REPLY: RegisterCounterReply = Object.freeze({});

/** Arguments for `IRelationshipsGrain.unregisterRelationshipCounter`. */
export interface UnregisterCounterArgs {
  /** The counter's name. */
  readonly name: string;
}

/** Reply for `IRelationshipsGrain.unregisterRelationshipCounter` (empty). Branded, as above. */
export interface UnregisterCounterReply {
  readonly __unregisterCounterReply?: never;
}

/** The single frozen instance of the empty unregister-counter reply. */
export const UNREGISTER_COUNTER_REPLY: UnregisterCounterReply = Object.freeze({});

/** Arguments for `IRelationshipsGrain.countRelationships`. */
export interface CountRelationshipsArgs {
  /** The counter's name. */
  readonly name: string;
}

/** Reply for `IRelationshipsGrain.countRelationships`: the on-demand count + read-at token. */
export interface CountRelationshipsReply {
  /** The counted rows (`ulong`). */
  readonly count: bigint;
  /** The ZedToken of the revision the count was taken at. */
  readonly readAtToken: string;
}
