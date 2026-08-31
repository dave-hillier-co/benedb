import type { IRevision } from "@benedb/core/i-revision";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { Relationship } from "@benedb/core/relationship";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import type { RegisteredCounter } from "@benedb/datastore/counters";
import { InvalidRevisionException } from "@benedb/datastore/datastore-exceptions";
import { MvccSnapshotReader } from "@benedb/datastore/mvcc-snapshot-reader";
import type { RelationshipsFilter } from "@benedb/datastore/relationships-filter";
import type { GrainRuntime } from "@thresh/core/grain-runtime";

import { toMemoryState } from "./datastore-state-converters";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { stateCovering } from "./sequencer-state-fetch";

/**
 * Ported from Spiceport `Grains/ISnapshotScanner.cs` (the seam plus the internal
 * `GrainSnapshotScanner`).
 *
 * The storage-direct scan seam of the graph-sharded design (`docs/graph-sharded-datastore.md` §3):
 * broad/admin reads - ReadRelationships with loose filters, bulk export, counter evaluation, the
 * schema-change data guards - fetch the sequencer snapshot per scan instead of keeping a per-silo
 * whole-graph replica. Scans are the workload actors are worst at, so this seam routes them AROUND
 * the shard-grain mesh; it is deliberately OFF the per-Check hot path, which reads through
 * `IGraphReaderSource`.
 */
export interface ISnapshotScanner {
  /**
   * Streams the relationships matching the filter, visible at the pinned revision.
   *
   * The scan seam carries exactly the shapes production needs: forward filter scans and the
   * counter reads below. There is deliberately no reverse-shaped scan - reverse reads are the
   * shard mesh's workload (`IGraphReaderSource`), and the one reverse-shaped admin check became a
   * forward-filter precondition.
   */
  scan(
    filter: RelationshipsFilter,
    revision: IRevision,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship>;

  /**
   * Counts the relationships matching the named registered counter's filter at the pinned
   * revision. Throws `CounterNotRegisteredException` when the counter is not registered there.
   */
  countRelationships(
    counterName: string,
    revision: IRevision,
    signal?: AbortSignal | undefined,
  ): Promise<bigint>;

  /**
   * Returns the filter registered for the named counter at the pinned revision, or `undefined`
   * when the counter is not registered there.
   */
  readCounterFilter(
    name: string,
    revision: IRevision,
    signal?: AbortSignal | undefined,
  ): Promise<RelationshipsFilter | undefined>;

  /** Streams the counters registered (not tombstoned) at the pinned revision. */
  lookupCounters(
    revision: IRevision,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<RegisteredCounter>;
}

/** The `{ getGrain }` seam `GrainSnapshotScanner` needs - one slice of Thresh's `GrainRuntime`. */
export type SnapshotScannerGrainFactory = Pick<GrainRuntime, "getGrain">;

function revisionTypeName(revision: IRevision): string {
  const ctor = (revision as { constructor?: { readonly name?: string } }).constructor;
  return ctor?.name ?? "unknown";
}

/**
 * `ToNanos`. A deliberate DUPLICATE of the same throw in `i-schema-source.ts`, exactly as the C#
 * duplicates it between `ISchemaSource.cs` and `ISnapshotScanner.cs`; extracting a shared helper
 * would be a redesign.
 */
function toNanos(revision: IRevision): bigint {
  if (revision instanceof TimestampRevision) return revision.timestampNanosSinceEpoch;
  throw new InvalidRevisionException(`unsupported revision type: ${revisionTypeName(revision)}`);
}

/**
 * The grain-backed scanner: per CALL, one `IDatastoreGrain.readState` snapshot fetch from the
 * cluster-singleton sequencer, folded to memory form and served through the same
 * `MvccSnapshotReader` the reference model uses - so scan semantics (MVCC visibility, expiration,
 * counter folds) cannot drift from the reference reader semantics. State at head always covers any
 * resolvable pinned revision (the grain minted it at or below that head); a revision below the GC
 * floor is rejected by `MvccSnapshotReader`'s own constructor guard (`RevisionNotFoundException`).
 *
 * Port decisions:
 *   * `IGrainFactory` becomes the narrow `{ getGrain }` slice, as in `i-schema-source.ts`.
 *   * `Scan` and `LookupCounters` are C# ITERATOR methods, so `await ReaderAt(...)` runs at the
 *     FIRST MoveNext, not at the call. They are ported as `async *` generators so the sequencer
 *     hop - and the `RevisionNotFoundException` it can raise - stays exactly as late.
 *   * `ulong` -> `bigint` on `countRelationships`; a `number` is wrong at the top of the range.
 *   * `[EnumeratorCancellation]` maps to nothing: the signal is just a parameter.
 */
export class GrainSnapshotScanner implements ISnapshotScanner {
  readonly #grainFactory: SnapshotScannerGrainFactory;

  constructor(grainFactory: SnapshotScannerGrainFactory) {
    this.#grainFactory = grainFactory;
  }

  get #grain(): IDatastoreGrain {
    return this.#grainFactory.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
  }

  async #readerAt(
    revision: IRevision,
    signal: AbortSignal | undefined,
  ): Promise<MvccSnapshotReader> {
    // `ArgumentNullException.ThrowIfNull(revision);`
    if (revision === undefined || revision === null) {
      throw new InvalidArgumentError("revision is required");
    }
    signal?.throwIfAborted();

    // Closed-timestamp gate: a stale duplicate activation during membership churn can serve an old
    // head, and a scan pinned at R must never fold over state whose head < R (rows committed at or
    // below R could be silently missing). `stateCovering` refetches until the head covers the pin -
    // the successor of the retired projection's watermark wait.
    const pinned = toNanos(revision);
    const state = await stateCovering(this.#grain, pinned, signal);
    // A permissive isValid is sound here for the same reason as GrainBackedDatastore's readers: the
    // hard floor check lives in MvccSnapshotReader's constructor, not the validity delegate.
    return new MvccSnapshotReader(toMemoryState(state), pinned, () => true);
  }

  /** @inheritdoc */
  async *scan(
    filter: RelationshipsFilter,
    revision: IRevision,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship> {
    const reader = await this.#readerAt(revision, signal);
    for await (const rel of reader.queryRelationships(filter, signal)) yield rel;
  }

  /** @inheritdoc */
  async countRelationships(
    counterName: string,
    revision: IRevision,
    signal?: AbortSignal | undefined,
  ): Promise<bigint> {
    const reader = await this.#readerAt(revision, signal);
    return reader.countRelationships(counterName, signal);
  }

  /** @inheritdoc */
  async readCounterFilter(
    name: string,
    revision: IRevision,
    signal?: AbortSignal | undefined,
  ): Promise<RelationshipsFilter | undefined> {
    const reader = await this.#readerAt(revision, signal);
    return reader.readCounterFilter(name, signal);
  }

  /** @inheritdoc */
  async *lookupCounters(
    revision: IRevision,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<RegisteredCounter> {
    const reader = await this.#readerAt(revision, signal);
    for await (const counter of reader.lookupCounters(signal)) yield counter;
  }
}
