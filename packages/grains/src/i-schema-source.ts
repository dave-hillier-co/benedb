import type { IRevision } from "@benedb/core/i-revision";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { InvalidRevisionException } from "@benedb/datastore/datastore-exceptions";
import type { GrainRuntime } from "@thresh/core/grain-runtime";

import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";

/**
 * Ported from Spiceport `Grains/ISchemaSource.cs` (the `ISchemaSource` seam plus the internal
 * `GrainSchemaSource`).
 *
 * Port decisions:
 *   * `IGrainFactory` becomes the narrow `{ getGrain }` slice of Thresh's `GrainRuntime`, per the
 *     port guide's `GrainFactory.GetGrain<IFoo>(id)` -> `runtime.getGrain(IFoo, id)` row. Taking
 *     the whole runtime would make every test build one.
 *   * `Task<byte[]?>` -> `Promise<Uint8Array | undefined>`. `undefined` MEANS the seed-only window
 *     and `SchemaResolver` branches on it, so an empty array must never stand in for it.
 *   * `revision.GetType().Name` has no TypeScript counterpart. The message uses the CONSTRUCTOR
 *     NAME, matching `reference-datastore.ts`'s `revisionTypeName` helper (which renders the same
 *     C# message), falling back to "unknown" for a prototype-less object.
 *   * The method is `async` where the C# is a plain `Task`-returning method that throws
 *     SYNCHRONOUSLY on its guards. In TypeScript a guard failure therefore arrives as a rejected
 *     promise, not a synchronous throw; every caller already awaits.
 */
export interface ISchemaSource {
  /**
   * Returns the schema bytes effective at `revision` (the last version persisted at or before it),
   * or `undefined` when none exists (the seed-only window).
   */
  readSchemaAt(
    revision: IRevision,
    signal?: AbortSignal | undefined,
  ): Promise<Uint8Array | undefined>;
}

/** The `{ getGrain }` seam `GrainSchemaSource` needs - one slice of Thresh's `GrainRuntime`. */
export type SchemaSourceGrainFactory = Pick<GrainRuntime, "getGrain">;

function revisionTypeName(revision: IRevision): string {
  const ctor = (revision as { constructor?: { readonly name?: string } }).constructor;
  return ctor?.name ?? "unknown";
}

/**
 * The grain-backed source: one `IDatastoreGrain.readSchemaAt` call against the cluster-singleton
 * sequencer, whose confirmed fold serves any resolvable pinned revision (every resolvable revision
 * is at or below the head the grain minted it under).
 */
export class GrainSchemaSource implements ISchemaSource {
  readonly #grainFactory: SchemaSourceGrainFactory;

  constructor(grainFactory: SchemaSourceGrainFactory) {
    this.#grainFactory = grainFactory;
  }

  /**
   * @inheritdoc
   *
   * `signal` is accepted and NOT used, exactly as the C# accepts `ct` and never passes it on: the
   * grain method takes no token.
   */
  async readSchemaAt(
    revision: IRevision,
    _signal?: AbortSignal | undefined,
  ): Promise<Uint8Array | undefined> {
    // `ArgumentNullException.ThrowIfNull(revision);`
    if (revision === undefined || revision === null) {
      throw new InvalidArgumentError("revision is required");
    }

    // Mirrors `ReferenceDatastore.ToNanos`: the timestamp form is the only revision identity the
    // datastore mints, so anything else is a caller bug, not a fallback case.
    if (!(revision instanceof TimestampRevision)) {
      throw new InvalidRevisionException(
        `unsupported revision type: ${revisionTypeName(revision)}`,
      );
    }
    const nanos = revision.timestampNanosSinceEpoch;

    return this.#grainFactory.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY).readSchemaAt(nanos);
  }
}
