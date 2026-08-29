import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { InvalidRevisionException } from "@spacedb/datastore/datastore-exceptions";
import type { IGraphReader } from "@spacedb/datastore/i-graph-reader";

import { ShardedGraphReader, type GraphReaderGrainFactory } from "./sharded-graph-reader";

/**
 * The seam that hands the evaluation engines their revision-pinned `IGraphReader` - always the
 * `IGraphShardGrain` mesh (`ShardedGraphReader`); the retired per-silo whole-graph projection
 * alternative is gone. Schema resolution, token minting and every other snapshot-wide read
 * deliberately stay OFF this seam: only the graph-shaped reads the engines perform go to the shard
 * mesh (`docs/graph-sharded-datastore.md`). The fold-equivalence gates compare the shard mesh
 * against a sequencer-snapshot reader (one full-state fetch per reader) - see
 * `ShardedReaderEquivalenceTests`.
 */
export interface IGraphReaderSource {
  /**
   * Returns a graph reader pinned at the given revision.
   *
   * SYNCHRONOUS, as in the C#: it returns the reader, not a `Task`/`Promise`. Making it async
   * would change every call site in the reverse-ops path and `IPermissionChecker`.
   */
  graphReaderAt(revision: IRevision): IGraphReader;
}

/**
 * `revision.GetType().Name` has no TypeScript counterpart; the CONSTRUCTOR NAME renders the same
 * message, as in `i-schema-source.ts` and `i-snapshot-scanner.ts`.
 */
function revisionTypeName(revision: IRevision): string {
  const ctor = (revision as { constructor?: { readonly name?: string } }).constructor;
  return ctor?.name ?? "unknown";
}

/**
 * The shard-mesh source: a `ShardedGraphReader` resolving each pinned read to the matching
 * `IGraphShardGrain`.
 *
 * C# `internal sealed`; TypeScript has no assembly-internal visibility, so it is exported and the
 * "no barrels" rule keeps it reachable only from this module.
 */
export class ShardedGraphReaderSource implements IGraphReaderSource {
  readonly #grainFactory: GraphReaderGrainFactory;

  constructor(grainFactory: GraphReaderGrainFactory) {
    // `ArgumentNullException.ThrowIfNull(grainFactory);` - before the assignment.
    if (grainFactory === undefined || grainFactory === null) {
      throw new InvalidArgumentError("grainFactory is required");
    }
    this.#grainFactory = grainFactory;
  }

  /**
   * @inheritdoc
   *
   * Deliberately does NOT null-check `revision`: the C# falls straight into the switch, where a
   * null reaches the default arm and `revision.GetType()` raises. The port reaches the same place
   * through the constructor-name lookup, so a missing revision still throws rather than yielding a
   * reader pinned at nothing.
   */
  graphReaderAt(revision: IRevision): IGraphReader {
    // Mirrors `ReferenceDatastore.ToNanos`: the timestamp form is the only revision identity the
    // datastore mints, so anything else is a caller bug, not a fallback case.
    const nanos =
      revision instanceof TimestampRevision
        ? revision.timestampNanosSinceEpoch
        : (() => {
            throw new InvalidRevisionException(
              `unsupported revision type: ${revisionTypeName(revision)}`,
            );
          })();
    return new ShardedGraphReader(this.#grainFactory, nanos);
  }
}
