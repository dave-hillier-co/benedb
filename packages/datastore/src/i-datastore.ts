import type { IRevision } from "@spacedb/core/i-revision";
import type { IRevisionParser } from "@spacedb/core/i-revision-parser";
import type { Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";

import type { RegisteredCounter } from "./counters";
import type { IGraphReader } from "./i-graph-reader";
import type { RelationshipsFilter } from "./relationships-filter";
import type { RevisionChange, WatchOptions } from "./watch";

/**
 * A revision paired with the schema hash that was current at that revision.
 *
 * The C# `string? SchemaHash = null` default becomes an optional member whose absence - never
 * `null` - means no schema has been written.
 */
export interface RevisionWithSchemaHash {
  /** The datastore revision. */
  readonly revision: IRevision;
  /** The schema hash at this revision, or absent if no schema has been written. */
  readonly schemaHash?: string | undefined;
}

/**
 * The outcome of `IReadWriteTransaction.deleteRelationships`.
 *
 * The C# `Task<(ulong Count, bool ReachedLimit)>` value tuple becomes a NAMED readonly
 * interface, not a positional array: a tuple would put the C# field names, which real call sites
 * use, into positions nothing checks.
 */
export interface DeleteRelationshipsResult {
  /** The number of relationships deleted. */
  readonly count: bigint;
  /** True if the delete was cut short by the supplied limit. */
  readonly reachedLimit: boolean;
}

/**
 * Read-only accessor over a datastore snapshot at a fixed revision.
 *
 * `ulong` becomes `bigint` throughout this seam (counts, bulk-load totals, delete limits): core
 * already chose bigint for revision nanos and the gRPC surface is uint64, so `number` would
 * silently round past 2^53. `byte[]?` becomes `Uint8Array | undefined`.
 */
export interface IDatastoreReader extends IGraphReader {
  /** Reads the unified stored schema bytes at this revision, or `undefined` if none written. */
  readStoredSchema(signal?: AbortSignal | undefined): Promise<Uint8Array | undefined>;

  /**
   * Returns the filter registered for the named counter live at this reader's revision, or
   * `undefined` if no live counter with that name exists at this snapshot.
   */
  readCounterFilter(
    name: string,
    signal?: AbortSignal | undefined,
  ): Promise<RelationshipsFilter | undefined>;

  /**
   * Counts the relationships matching the named counter's registered filter at this reader's
   * snapshot. The filter is resolved at the same revision as the count, so the result is
   * consistent.
   *
   * @throws CounterNotRegisteredException If no live counter with this name exists at this
   * snapshot.
   */
  countRelationships(name: string, signal?: AbortSignal | undefined): Promise<bigint>;

  /** Enumerates the counters live at this reader's revision. */
  lookupCounters(signal?: AbortSignal | undefined): AsyncIterable<RegisteredCounter>;

  /**
   * True if this reader's snapshot is still valid (its revision has not been garbage collected).
   *
   * The C# is a PROPERTY that re-evaluates against the live datastore on every access, so an
   * implementation must port it as a getter, never as a boolean captured when the reader was
   * made - a field snapshot leaves a reader reporting valid forever after its revision is
   * collected, which is exactly the check callers rely on.
   */
  readonly isValid: boolean;
}

/** A read-write transaction that will commit at a new revision. */
export interface IReadWriteTransaction extends IDatastoreReader {
  /** The revision this transaction will commit as. */
  readonly newRevision: IRevision;

  /** Applies relationship mutations (create / touch / delete). */
  writeRelationships(
    mutations: readonly RelationshipUpdate[],
    signal?: AbortSignal | undefined,
  ): Promise<void>;

  /**
   * Deletes relationships matching the filter, optionally bounded by a limit.
   *
   * @returns The number deleted and whether the limit was reached.
   */
  deleteRelationships(
    filter: RelationshipsFilter,
    limit?: bigint | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<DeleteRelationshipsResult>;

  /** Writes the unified stored schema bytes. */
  writeStoredSchema(schemaBytes: Uint8Array, signal?: AbortSignal | undefined): Promise<void>;

  /** Bulk loads relationships from a source. Returns the number loaded. */
  bulkLoad(
    relationships: AsyncIterable<Relationship>,
    signal?: AbortSignal | undefined,
  ): Promise<bigint>;

  /**
   * Registers a relationship counter, writing an MVCC version visible from this transaction's
   * revision onward. The count is computed on demand at read time, not precomputed here.
   *
   * @throws CounterAlreadyRegisteredException If a live counter with this name already exists.
   */
  writeCounter(
    name: string,
    filter: RelationshipsFilter,
    signal?: AbortSignal | undefined,
  ): Promise<void>;

  /**
   * Unregisters a relationship counter by tombstoning its live version.
   *
   * @throws CounterNotRegisteredException If no live counter with this name exists.
   */
  deleteCounter(name: string, signal?: AbortSignal | undefined): Promise<void>;
}

/**
 * An MVCC datastore: snapshot reads at any valid revision and serialized read-write
 * transactions.
 *
 * These are PLAIN interfaces, not grain interfaces: no `defineGrainInterface`. The grain-backed
 * datastore implements them in front of grains, but the interfaces themselves stay
 * framework-free so the reference datastore needs no runtime.
 */
export interface IDatastore {
  /**
   * Returns a read-only snapshot reader at the given revision. SYNCHRONOUS, and it throws
   * SYNCHRONOUSLY - Spiceport's own tests use `Assert.Throws`, not `ThrowsAsync`.
   *
   * @throws RevisionNotFoundException If the revision is not available.
   */
  snapshotReader(revision: IRevision): IDatastoreReader;

  /** Returns the current head revision (freshest committed state). */
  headRevision(signal?: AbortSignal | undefined): Promise<RevisionWithSchemaHash>;

  /** Returns a revision suitable for caching, quantized to the configured interval. */
  optimizedRevision(signal?: AbortSignal | undefined): Promise<RevisionWithSchemaHash>;

  /**
   * Runs a read-write transaction; commits if the function completes without throwing.
   *
   * @returns The committed revision.
   */
  readWriteTx(
    transaction: (tx: IReadWriteTransaction) => Promise<void>,
    signal?: AbortSignal | undefined,
  ): Promise<IRevision>;

  /** Returns true if the revision is still available. */
  checkRevision(revision: IRevision, signal?: AbortSignal | undefined): Promise<boolean>;

  /**
   * Streams changes committed strictly AFTER `afterRevision`, in increasing revision order, then
   * tails live as new transactions commit. Each `RevisionChange` carries its own revision so a
   * client can mint a resume token and continue exactly once after a disconnect. The stream runs
   * until `signal` fires.
   *
   * @param afterRevision Resume cursor: changes made at or before this revision are not emitted.
   * Pass the current head to tail only future writes.
   * @throws RevisionNotFoundException If `afterRevision` is older than the retained GC window
   * (cannot replay from it).
   */
  watch(
    afterRevision: IRevision,
    options: WatchOptions,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<RevisionChange>;

  /** Returns a stable unique id for this datastore instance. */
  getUniqueId(signal?: AbortSignal | undefined): Promise<string>;

  /**
   * Returns a parser that decodes minted token revision strings back into `IRevision` for this
   * datastore. The parser's `datastoreUniqueId` matches `getUniqueId`, so a token minted by this
   * datastore decodes as `ZedTokenStatus` "valid".
   */
  getRevisionParser(signal?: AbortSignal | undefined): Promise<IRevisionParser>;

  /** Releases resources held by the datastore. Takes no cancellation token, as in the C#. */
  close(): Promise<void>;
}
