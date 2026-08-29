import { defineGrainInterface } from "@thresh/core/grain-interface";
import type { GrainWithIntegerKey } from "@thresh/core/key-kinds";

import type {
  BulkImportRelationshipsArgs,
  BulkImportRelationshipsReply,
  CountRelationshipsArgs,
  CountRelationshipsReply,
  DeleteRelationshipsArgs,
  DeleteRelationshipsReply,
  ReadSchemaReply,
  RegisterCounterArgs,
  RegisterCounterReply,
  UnregisterCounterArgs,
  UnregisterCounterReply,
  WriteRelationshipsArgs,
  WriteRelationshipsReply,
  WriteSchemaArgs,
  WriteSchemaReply,
} from "./relationships-dtos";

/**
 * The fixed key every caller uses; the grain is a stateless worker so this is a routing address,
 * not an identity.
 *
 * The C#'s `public const long Key = 0` lives on the interface, which TypeScript has no counterpart
 * for, so it folds to a module constant per the static-class rule. `GrainWithIntegerKey`'s key type
 * is BIGINT in Thresh, hence `0n`.
 */
export const RELATIONSHIPS_GRAIN_KEY = 0n;

/**
 * The data-plane grain: schema reads/writes and relationship reads/writes/deletes. It is the write
 * side of the system (the check / reverse-ops grains are the read side).
 *
 * Every method here is a whole operation against the datastore (or the live schema provider) rather
 * than a per-key dispatch, so it is exposed on ONE grain keyed by the constant integer
 * `RELATIONSHIPS_GRAIN_KEY`, and the implementation is `[StatelessWorker]` so the silo scales
 * activations with load without fragmenting any keyspace. That marking is a GRAIN-side option
 * (`defineGrain(..., { stateless: true })`) in a later slice, never an interface option - it does
 * not belong in the options map below.
 *
 * Writes persist through the host-owned `IDatastore` and (for schema) swap the live schema
 * snapshot; replies carry an opaque revision token.
 *
 * The relationship READ ops (`readRelationships`, `bulkExportRelationships`) and the reverse-ops
 * reads (`expandPermissionTree`, `lookupSubjects`, `lookupResources`) are deliberately NOT on this
 * interface: they run IN-PROCESS via `RelationshipReads` and `ReverseOps` respectively. A later
 * slice must not "complete" the interface by adding them.
 */
export interface IRelationshipsGrain extends GrainWithIntegerKey {
  /** Compiles and installs a new schema, persisting it and swapping the live snapshot. */
  writeSchema(args: WriteSchemaArgs): Promise<WriteSchemaReply>;

  /** Returns the current schema source text and a read-at token. */
  readSchema(): Promise<ReadSchemaReply>;

  /** Applies relationship mutations (create / touch / delete) in one transaction. */
  writeRelationships(args: WriteRelationshipsArgs): Promise<WriteRelationshipsReply>;

  /** Deletes relationships matching the filter, optionally bounded by a limit. */
  deleteRelationships(args: DeleteRelationshipsArgs): Promise<DeleteRelationshipsReply>;

  /**
   * Loads an import's relationships with CREATE semantics in a single, all-or-nothing write
   * transaction: a row that already exists, or repeats within the import, rejects the whole import
   * (nothing applies) - real SpiceDB's ImportBulkRelationships behavior. The bulk-import gRPC
   * services buffer the client stream and call this once - the grain stays request/response.
   */
  bulkImportRelationships(args: BulkImportRelationshipsArgs): Promise<BulkImportRelationshipsReply>;

  /**
   * Registers an MVCC relationship counter under `args.name` with the given filter. Throws
   * `CounterOperationException` (`alreadyRegistered`) if a counter with that name is already live.
   */
  registerRelationshipCounter(args: RegisterCounterArgs): Promise<RegisterCounterReply>;

  /**
   * Tombstones the live counter named `args.name`. Throws `CounterOperationException`
   * (`notRegistered`) if no such counter is live.
   */
  unregisterRelationshipCounter(args: UnregisterCounterArgs): Promise<UnregisterCounterReply>;

  /**
   * Computes, on demand, the count of relationships matching the registered counter's filter at a
   * freshly resolved snapshot and returns the count plus a read-at token. Throws
   * `CounterOperationException` (`notRegistered`) if no counter named `args.name` is live.
   */
  countRelationships(args: CountRelationshipsArgs): Promise<CountRelationshipsReply>;
}

/**
 * The runtime value for `IRelationshipsGrain`. No method on the C# interface carries an interleave
 * attribute, so the options map is empty.
 */
export const IRelationshipsGrain = defineGrainInterface<IRelationshipsGrain>("IRelationshipsGrain");
