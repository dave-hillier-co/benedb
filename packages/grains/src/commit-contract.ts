import type { CounterDeltaWire } from "./log-event";
import type { FullRelationshipsFilterWire } from "./datastore-dtos";
import type { RelationshipUpdateWire } from "./relationships-dtos";

// A deliberately MULTI-EXPORT module, per the port ledger: `CommitContract.cs` is the one write
// contract and its five types only make sense together.

/**
 * A precondition inside a `CommitRequest`: an existence-only probe of `filter` against the
 * transaction snapshot the commit would apply at. `mustMatch` true requires at least one matching
 * relationship; false requires none. Carried as the lossless `FullRelationshipsFilterWire` so the
 * filter round-trips the grain boundary exactly (the same form the counter filters already use).
 *
 * Named `CommitPreconditionWire` (not `PreconditionWire`) because the data-plane RPC surface
 * already defines `PreconditionWire`.
 */
export interface CommitPreconditionWire {
  /** The filter probed. */
  readonly filter: FullRelationshipsFilterWire;
  /** True requires at least one match; false requires none. */
  readonly mustMatch: boolean;
}

/**
 * A bulk delete-by-filter inside a `CommitRequest`: close every live relationship matching
 * `filter`, up to `limit` rows when present (the reply reports the deleted count and whether the
 * limit was reached, mirroring the DeleteRelationships RPC semantics).
 */
export interface DeleteByFilterWire {
  /** The filter naming the rows to close. */
  readonly filter: FullRelationshipsFilterWire;
  /** The `ulong?` row limit, or absent for unbounded. */
  readonly limit?: bigint | undefined;
}

/**
 * The write wire contract of the graph-sharded design: a fully DECLARATIVE description of one
 * commit, executed inside the sequencer grain (`IDatastoreGrain.commit`) whose single-threaded,
 * non-reentrant activation is the serialization point - the request replaces the caller-side
 * read-transact-CAS loop, so a declarative commit needs no retry. The lambda compatibility path
 * (`GrainBackedDatastore.readWriteTx`) survives by passing `expectedHead`, keeping the old
 * caller-evaluated CAS semantics.
 */
export interface CommitRequest {
  /**
   * Evaluated in request ORDER before any mutation, against the same snapshot the mutations commit
   * at (the semantics the data-plane write path historically evaluated inline, now the sequencer's
   * job).
   */
  readonly preconditions: readonly CommitPreconditionWire[];
  /** Relationship mutations (Create/Touch/Delete), applied in request order. */
  readonly updates: readonly RelationshipUpdateWire[];
  /** Optional bulk delete applied after `updates`. */
  readonly deleteByFilter?: DeleteByFilterWire | undefined;
  /** Optional new schema source bytes written at the minted revision. */
  readonly schemaBytes?: Uint8Array | undefined;
  /**
   * When present: schema-write serializability - the commit is rejected (`schemaHashMoved`) unless
   * the schema hash effective at the grain's head still matches. An absent CURRENT hash (the
   * pre-first-schema seed window) matches only an absent/empty expected hash.
   *
   * That conflation of absent and empty is the C#'s own deliberate choice, so the port keeps it
   * rather than applying its usual absent-versus-empty rule.
   */
  readonly expectedSchemaHash?: string | undefined;
  /**
   * Counter deltas: a present `CounterDeltaWire.filter` registers, an absent filter unregisters.
   * Their semantics are keyed off `expectedHead`, like the CAS itself: on a declarative commit
   * (absent `expectedHead`) each delta is a guarded INTENT run through the transaction's
   * register/unregister preconditions, so already-registered / not-registered are rejected as
   * reply failures; on the compatibility path (present `expectedHead`) each delta is the
   * already-RESOLVED net counter version the caller's lambda produced against that exact base,
   * applied by direct append (never re-guarded - a same-commit register+unregister nets to a delta
   * whose guard is false in the base, the same reason the log fold appends counter versions
   * directly).
   */
  readonly counterChanges: readonly CounterDeltaWire[];
  /**
   * When present: compare-and-swap - the commit is rejected (`headMoved`) if the grain's head
   * differs (the lambda compatibility path, whose preconditions were evaluated caller-side against
   * this head). When ABSENT the grain serializes the commit unconditionally.
   *
   * The absent-versus-present distinction IS the semantic switch between the declarative commit
   * and the CAS compatibility path, so it must never be defaulted - 0n is a legal head (a freshly
   * seeded store).
   */
  readonly expectedHead?: bigint | undefined;
}

/**
 * How a `CommitRequest` was rejected. Failures cross the grain boundary as STRUCTURED REPLY DATA
 * (`CommitFailureWire`), never as serialized exceptions, so the client rethrows the exact same
 * typed exceptions the write surface throws today and every gRPC status mapping is preserved. The
 * member names are load-bearing documentation of that rethrow table:
 *
 * - `preconditionFailed` -> `PreconditionFailedException` (FailedPrecondition), reconstructed from
 *   the detail via `preconditionMessagesTryParseFailure`.
 * - `createAlreadyExists` -> `CreateRelationshipExistsException` (AlreadyExists).
 * - `counterAlreadyRegistered` / `counterNotRegistered` -> `CounterOperationException`
 *   (`CounterAlreadyRegisteredException` / `CounterNotRegisteredException` client-side).
 * - `headMoved` / `schemaHashMoved` -> the caller's CAS-conflict handling (retry, or
 *   `SerializationException` - Aborted - on exhaustion).
 */
export type CommitFailureKind =
  /** The grain's head no longer equals `CommitRequest.expectedHead`. */
  | "headMoved"
  /** The schema hash at head no longer matches `CommitRequest.expectedSchemaHash`. */
  | "schemaHashMoved"
  /** A precondition was violated; nothing was applied. */
  | "preconditionFailed"
  /** A Create update targeted a relationship that already exists. */
  | "createAlreadyExists"
  /** A counter register targeted a name that is already live. */
  | "counterAlreadyRegistered"
  /** A counter unregister targeted a name that is not registered. */
  | "counterNotRegistered";

/**
 * A rejected commit as reply data. `detail` carries exactly what the client needs to rethrow its
 * existing typed exception unchanged: the canonical relationship string for `createAlreadyExists`,
 * the counter name for the counter kinds, and the full precondition-failure message for
 * `preconditionFailed` (the shared `PreconditionMessages` text the client parses back into an
 * exact `PreconditionFailedException`). The CAS kinds need no detail.
 */
export interface CommitFailureWire {
  /** Why the commit was rejected. */
  readonly kind: CommitFailureKind;
  /** The exception's constructor argument, or absent where the kind carries none. */
  readonly detail?: string | undefined;
}

/**
 * The result of `IDatastoreGrain.commit`. On success `revision` is the grain-minted authoritative
 * revision and `failure` is absent; on rejection `revision` is absent, `failure` says why, and
 * nothing was applied (the whole request is atomic). `deletedCount` / `reachedLimit` report the
 * `CommitRequest.deleteByFilter` outcome (0n/false when no delete-by-filter was requested).
 */
export interface CommitReply {
  /** The minted revision on success, or absent on rejection. */
  readonly revision?: bigint | undefined;
  /** The rejection, or absent on success. */
  readonly failure?: CommitFailureWire | undefined;
  /** The rows the delete-by-filter closed (`ulong`). */
  readonly deletedCount: bigint;
  /** True when the delete-by-filter stopped at its limit. */
  readonly reachedLimit: boolean;
}
