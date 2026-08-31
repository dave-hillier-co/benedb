import type { IRevision } from "@benedb/core/i-revision";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { InvalidRevisionException } from "@benedb/datastore/datastore-exceptions";
import type { GrainInterface } from "@thresh/core/grain-interface";
import { describe, expect, it } from "vitest";

import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { GrainSchemaSource } from "./i-schema-source";

/**
 * No covering C# test - a characterization of `Grains/ISchemaSource.cs` (`ISchemaSource` and the
 * internal `GrainSchemaSource`).
 *
 * The mesh suites reach this class only through a live cluster and only ever with a
 * `TimestampRevision`, so the unsupported-revision arm and the null guard have NO other gate.
 *
 * PINNED CHOICE (the ledger leaves it open): `revision.GetType().Name` has no TypeScript
 * counterpart, so the message uses the CONSTRUCTOR NAME, exactly as the already-ported
 * `reference-datastore.ts` `revisionTypeName` helper does, falling back to "unknown" for an
 * object with no constructor. The two must agree, because both render the same C# message.
 */

interface GetGrainCall {
  readonly definition: unknown;
  readonly key: unknown;
}

/** A `{ getGrain }` seam that records the lookup and answers with a scripted `readSchemaAt`. */
function fakeRuntime(readSchemaAt: (revision: bigint) => Promise<Uint8Array | undefined>): {
  readonly seam: { getGrain<T>(def: GrainInterface<T>, key: never): T };
  readonly lookups: GetGrainCall[];
  readonly nanos: bigint[];
} {
  const lookups: GetGrainCall[] = [];
  const nanos: bigint[] = [];
  const grain = {
    readSchemaAt(revision: bigint): Promise<Uint8Array | undefined> {
      nanos.push(revision);
      return readSchemaAt(revision);
    },
  };
  const seam = {
    getGrain<T>(definition: GrainInterface<T>, key: never): T {
      lookups.push({ definition, key });
      return grain as unknown as T;
    },
  };
  return { seam, lookups, nanos };
}

const NO_SCHEMA = async (): Promise<Uint8Array | undefined> => undefined;

describe("GrainSchemaSource.readSchemaAt", () => {
  it("routes to the cluster-singleton datastore grain under its constant key", () => {
    // `grainFactory.GetGrain<IDatastoreGrain>(IDatastoreGrain.Key)`.
    const { seam, lookups } = fakeRuntime(NO_SCHEMA);

    void new GrainSchemaSource(seam).readSchemaAt(new TimestampRevision(1n));

    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.definition).toBe(IDatastoreGrain);
    expect(lookups[0]?.key).toBe(DATASTORE_GRAIN_KEY);
  });

  it("passes TimestampNanosSinceEpoch through as a bigint, undiminished", async () => {
    // The C# `long` reaches `ReadSchemaAt(long)`. Narrowing through `number` would round any
    // realistic wall-clock nanosecond value, so the bigint must arrive intact.
    const beyondSafeInteger = 1_756_000_000_123_456_789n;
    const { seam, nanos } = fakeRuntime(NO_SCHEMA);

    await new GrainSchemaSource(seam).readSchemaAt(new TimestampRevision(beyondSafeInteger));

    expect(nanos).toEqual([beyondSafeInteger]);
    expect(typeof nanos[0]).toBe("bigint");
  });

  it("passes a zero and a negative revision through unchanged", async () => {
    const { seam, nanos } = fakeRuntime(NO_SCHEMA);
    const source = new GrainSchemaSource(seam);

    await source.readSchemaAt(new TimestampRevision(0n));
    await source.readSchemaAt(new TimestampRevision(-5n));

    expect(nanos).toEqual([0n, -5n]);
  });

  it("returns the grain's bytes by identity", async () => {
    const bytes = new TextEncoder().encode("definition user {}");
    const { seam } = fakeRuntime(async () => bytes);

    const result = await new GrainSchemaSource(seam).readSchemaAt(new TimestampRevision(9n));

    expect(result).toBe(bytes);
  });

  it("returns undefined - NOT an empty array - for the seed-only window", async () => {
    // `Task<byte[]?>` -> `Promise<Uint8Array | undefined>`. `SchemaResolver` branches on
    // `bytes is null`, so an empty array here would be compiled as an empty schema instead of
    // falling back to the seed.
    const { seam } = fakeRuntime(NO_SCHEMA);

    const result = await new GrainSchemaSource(seam).readSchemaAt(new TimestampRevision(9n));

    expect(result).toBeUndefined();
  });

  it("propagates a zero-length byte array as itself, distinct from the seed window", async () => {
    const empty = new Uint8Array(0);
    const { seam } = fakeRuntime(async () => empty);

    expect(await new GrainSchemaSource(seam).readSchemaAt(new TimestampRevision(9n))).toBe(empty);
  });

  it("rejects a null/undefined revision before any grain lookup", async () => {
    // `ArgumentNullException.ThrowIfNull(revision);`
    const { seam, lookups } = fakeRuntime(NO_SCHEMA);
    const source = new GrainSchemaSource(seam);

    await expect(source.readSchemaAt(undefined as unknown as IRevision)).rejects.toThrow(
      InvalidArgumentError,
    );
    await expect(source.readSchemaAt(null as unknown as IRevision)).rejects.toThrow(
      InvalidArgumentError,
    );
    expect(lookups).toHaveLength(0);
  });

  it("throws InvalidRevisionException for any non-timestamp revision", async () => {
    // `_ => throw new InvalidRevisionException($"unsupported revision type: {..Name}")`. This is
    // NOT a fallback arm: "anything else is a caller bug".
    class FakeRevision implements IRevision {
      readonly byteSortable = false;
      compareTo(): number {
        return 0;
      }
      equals(): boolean {
        return false;
      }
      greaterThan(): boolean {
        return false;
      }
      toString(): string {
        return "fake";
      }
    }

    const { seam, lookups } = fakeRuntime(NO_SCHEMA);

    await expect(new GrainSchemaSource(seam).readSchemaAt(new FakeRevision())).rejects.toThrow(
      new InvalidRevisionException("unsupported revision type: FakeRevision"),
    );
    // The throw happens before the grain call, so nothing is dispatched.
    expect(lookups).toHaveLength(0);
  });

  it("names a plain object revision 'Object' and a prototype-less one 'unknown'", () => {
    // Matches `reference-datastore.ts`'s `revisionTypeName`: `constructor?.name ?? "unknown"`.
    const literal = {
      byteSortable: false,
      compareTo: () => 0,
      equals: () => false,
      greaterThan: () => false,
    } as unknown as IRevision;
    const bare = Object.assign(Object.create(null) as object, literal) as IRevision;
    const { seam } = fakeRuntime(NO_SCHEMA);
    const source = new GrainSchemaSource(seam);

    void expect(source.readSchemaAt(literal)).rejects.toThrow("unsupported revision type: Object");
    void expect(source.readSchemaAt(bare)).rejects.toThrow("unsupported revision type: unknown");
  });

  it("ignores the cancellation signal - the C# never passes ct to the grain call", async () => {
    // `ReadSchemaAt(IRevision, CancellationToken ct)` accepts `ct` and does not use it: the grain
    // method takes no token. An already-aborted signal must therefore NOT short-circuit the call.
    const aborted = AbortSignal.abort();
    const bytes = new TextEncoder().encode("definition user {}");
    const { seam, nanos } = fakeRuntime(async () => bytes);

    const result = await new GrainSchemaSource(seam).readSchemaAt(
      new TimestampRevision(4n),
      aborted,
    );

    expect(result).toBe(bytes);
    expect(nanos).toEqual([4n]);
  });

  it("makes one grain call per invocation - nothing is cached at this seam", async () => {
    // The caching lives in SchemaResolver ("once per hash per silo"), not here.
    const { seam, lookups } = fakeRuntime(NO_SCHEMA);
    const source = new GrainSchemaSource(seam);

    await source.readSchemaAt(new TimestampRevision(1n));
    await source.readSchemaAt(new TimestampRevision(1n));

    expect(lookups).toHaveLength(2);
  });
});
