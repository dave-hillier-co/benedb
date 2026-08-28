import { describe, expect, expectTypeOf, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { IRevisionParser } from "@spacedb/core/i-revision-parser";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";

import type { RegisteredCounter } from "./counters";
import {
  CounterAlreadyRegisteredException,
  CounterNotRegisteredException,
  RevisionNotFoundException,
} from "./datastore-exceptions";
import type {
  DeleteRelationshipsResult,
  IDatastore,
  IDatastoreReader,
  IReadWriteTransaction,
  RevisionWithSchemaHash,
} from "./i-datastore";
import type { IGraphReader } from "./i-graph-reader";
import {
  relationshipsFilterMatches,
  subjectsFilterMatches,
  type RelationshipsFilter,
  type SubjectsFilter,
} from "./relationships-filter";
import type { ReverseQueryOptions } from "./reverse-query-options";
import { TimestampRevisionParser } from "./timestamp-revision-parser";
import type { RevisionChange, WatchOptions } from "./watch";

// Port of Spiceport `IDatastore.cs` - `IDatastoreReader`, `IReadWriteTransaction`, `IDatastore`
// and the `RevisionWithSchemaHash` record. No test of its own in Spiceport, so this is a
// characterization test over the seam. Every implementation (MvccSnapshotReader,
// MvccReadWriteTransaction, ReferenceDatastore, and in S3 GrainBackedDatastore) and every
// consumer is typed against it, so the representation decisions below are settled ONCE here and
// batches 4-5 must match them at every call site.
//
// 1. `ulong` becomes `bigint`, everywhere it appears: `countRelationships`' return,
//    `bulkLoad`'s return, and `deleteRelationships`' count and `ulong? limit`. Core already
//    chose bigint for revision nanos and the gRPC surface is uint64, so bigint is the consistent
//    choice; `number` would silently round past 2^53. The consequence for batch 5 is that the
//    C# `(ulong)matched.Count > lim` becomes a `BigInt(matched.length) > limit` comparison and
//    the `(int)lim` cast becomes `Number(limit)` - no mixed-mode arithmetic, which throws.
//
// 2. The `Task<(ulong Count, bool ReachedLimit)>` value tuple becomes a NAMED readonly
//    interface, `DeleteRelationshipsResult`, not a positional array. A tuple would put the
//    C# field names - which real call sites use - into positions nothing checks.
//
// 3. `byte[]?` becomes `Uint8Array | undefined`. `undefined`, not `null`.
//
// 4. `IsValid` is a PROPERTY that re-evaluates against the live datastore on every access, not a
//    boolean captured when the reader was made. Ported as a getter. A field snapshot leaves a
//    reader reporting "valid" forever after its revision is garbage-collected, which is exactly
//    the check callers rely on.
//
// 5. `Func<IReadWriteTransaction, Task>` becomes `(tx: IReadWriteTransaction) => Promise<void>`,
//    and `readWriteTx` resolves with the COMMITTED revision.
//
// 6. `snapshotReader` is SYNCHRONOUS and throws SYNCHRONOUSLY - Spiceport's own tests use
//    `Assert.Throws`, not `ThrowsAsync`. It must not become `async`, or every `expect(...)
//    .toThrow` at the call sites turns into an unhandled rejection that passes silently.
//
// 7. These are PLAIN interfaces, not grain interfaces: no `defineGrainInterface` here. S3's
//    GrainBackedDatastore implements them in front of grains; the interfaces themselves stay
//    framework-free so the reference datastore needs no runtime.
function rel(resourceId: string, subjectId = "alice"): Relationship {
  return createRelationship(
    { objectType: "document", objectId: resourceId, relation: "viewer" },
    { objectType: "user", objectId: subjectId, relation: ELLIPSIS },
  );
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of source) collected.push(item);
  return collected;
}

/**
 * A deliberately small in-memory datastore, standing in for ReferenceDatastore so the seam can
 * be exercised at all. It is NOT the port of ReferenceDatastore (batch 4) - there is no MVCC
 * here, only enough behaviour to show what the interface obliges an implementation to do.
 */
function fakeDatastore(): IDatastore & { collectGarbageUpTo(revision: IRevision): void } {
  let nanos = 1_000n;
  let head: TimestampRevision = new TimestampRevision(nanos);
  let gcFloor: TimestampRevision = new TimestampRevision(0n);
  let schemaHash: string | undefined;
  let schema: Uint8Array | undefined;
  const relationships: Relationship[] = [];
  const counters = new Map<string, RelationshipsFilter>();
  const changes: RevisionChange[] = [];

  const nextRevision = (): TimestampRevision => {
    nanos += 1_000n;
    return new TimestampRevision(nanos);
  };

  const makeReader = (revision: IRevision): IDatastoreReader => ({
    // `isValid` is a GETTER: it re-reads the live GC floor on every access.
    get isValid(): boolean {
      return revision.compareTo(gcFloor) >= 0;
    },

    async *queryRelationships(
      filter: RelationshipsFilter,
      signal?: AbortSignal,
    ): AsyncIterable<Relationship> {
      for (const candidate of relationships) {
        signal?.throwIfAborted();
        if (relationshipsFilterMatches(filter, candidate)) yield candidate;
      }
    },

    async *reverseQueryRelationships(
      subjectsFilter: SubjectsFilter,
      _options?: ReverseQueryOptions | undefined,
      signal?: AbortSignal,
    ): AsyncIterable<Relationship> {
      for (const candidate of relationships) {
        signal?.throwIfAborted();
        if (subjectsFilterMatches(subjectsFilter, candidate)) yield candidate;
      }
    },

    async readStoredSchema(): Promise<Uint8Array | undefined> {
      return schema;
    },

    async readCounterFilter(name: string): Promise<RelationshipsFilter | undefined> {
      return counters.get(name);
    },

    async countRelationships(name: string): Promise<bigint> {
      const filter = counters.get(name);
      if (filter === undefined) throw new CounterNotRegisteredException(name);
      let count = 0n;
      for (const candidate of relationships) {
        if (relationshipsFilterMatches(filter, candidate)) count += 1n;
      }
      return count;
    },

    async *lookupCounters(): AsyncIterable<RegisteredCounter> {
      for (const [name, filter] of counters) yield { name, filter };
    },
  });

  return {
    collectGarbageUpTo(revision: IRevision): void {
      gcFloor = revision as TimestampRevision;
    },

    snapshotReader(revision: IRevision): IDatastoreReader {
      // Synchronous throw, synchronous return. Never a promise.
      if (revision.compareTo(gcFloor) < 0) throw new RevisionNotFoundException(revision);
      if (revision.greaterThan(head)) throw new RevisionNotFoundException(revision);
      return makeReader(revision);
    },

    async headRevision(): Promise<RevisionWithSchemaHash> {
      return { revision: head, schemaHash };
    },

    async optimizedRevision(): Promise<RevisionWithSchemaHash> {
      return { revision: head, schemaHash };
    },

    async readWriteTx(
      transaction: (tx: IReadWriteTransaction) => Promise<void>,
    ): Promise<IRevision> {
      const newRevision = nextRevision();
      const staged: Relationship[] = [...relationships];
      const stagedChanges: RelationshipUpdate[] = [];
      const reader = makeReader(head);
      const tx: IReadWriteTransaction = {
        ...reader,
        get isValid(): boolean {
          return reader.isValid;
        },
        newRevision,

        async writeRelationships(mutations: readonly RelationshipUpdate[]): Promise<void> {
          for (const mutation of mutations) {
            stagedChanges.push(mutation);
            const key = JSON.stringify(mutation.relationship.reference);
            const at = staged.findIndex((r) => JSON.stringify(r.reference) === key);
            if (mutation.operation === "delete") {
              if (at >= 0) staged.splice(at, 1);
            } else if (at >= 0) {
              staged[at] = mutation.relationship;
            } else {
              staged.push(mutation.relationship);
            }
          }
        },

        async deleteRelationships(
          filter: RelationshipsFilter,
          limit?: bigint | undefined,
        ): Promise<DeleteRelationshipsResult> {
          const matched = staged.filter((candidate) =>
            relationshipsFilterMatches(filter, candidate),
          );
          // The C# `(ulong)matched.Count > lim` / `(int)lim` casts, in bigint terms.
          const reachedLimit = limit !== undefined && BigInt(matched.length) > limit;
          const doomed = reachedLimit ? matched.slice(0, Number(limit)) : matched;
          for (const victim of doomed) staged.splice(staged.indexOf(victim), 1);
          return { count: BigInt(doomed.length), reachedLimit };
        },

        async writeStoredSchema(schemaBytes: Uint8Array): Promise<void> {
          schema = schemaBytes;
          schemaHash = `h${schemaBytes.length}`;
        },

        async bulkLoad(source: AsyncIterable<Relationship>): Promise<bigint> {
          let loaded = 0n;
          for await (const item of source) {
            staged.push(item);
            loaded += 1n;
          }
          return loaded;
        },

        async writeCounter(name: string, filter: RelationshipsFilter): Promise<void> {
          if (counters.has(name)) throw new CounterAlreadyRegisteredException(name);
          counters.set(name, filter);
        },

        async deleteCounter(name: string): Promise<void> {
          if (!counters.delete(name)) throw new CounterNotRegisteredException(name);
        },
      };

      // Commits only if the function completes without throwing.
      await transaction(tx);
      relationships.length = 0;
      relationships.push(...staged);
      head = newRevision;
      changes.push({ revision: newRevision, relationshipChanges: stagedChanges });
      return newRevision;
    },

    async checkRevision(revision: IRevision): Promise<boolean> {
      return revision.compareTo(gcFloor) >= 0 && !revision.greaterThan(head);
    },

    async *watch(
      afterRevision: IRevision,
      _options: WatchOptions,
      signal?: AbortSignal,
    ): AsyncIterable<RevisionChange> {
      if (afterRevision.compareTo(gcFloor) < 0) throw new RevisionNotFoundException(afterRevision);
      for (const change of changes) {
        signal?.throwIfAborted();
        if (change.revision.greaterThan(afterRevision)) yield change;
      }
    },

    async getUniqueId(): Promise<string> {
      return "fake-datastore";
    },

    async getRevisionParser(): Promise<IRevisionParser> {
      return new TimestampRevisionParser("fake-datastore");
    },

    async close(): Promise<void> {},
  };
}

describe("RevisionWithSchemaHash", () => {
  it("pairs a revision with the schema hash current at it", () => {
    const value: RevisionWithSchemaHash = {
      revision: new TimestampRevision(42n),
      schemaHash: "abc",
    };

    expect(value.revision.toString()).toBe("42");
    expect(value.schemaHash).toBe("abc");
  });

  it("makes the schema hash optional, and absent means no schema has been written", () => {
    // The C# `string? SchemaHash = null` default becomes an omitted member, NOT `null`.
    const value: RevisionWithSchemaHash = { revision: new TimestampRevision(42n) };

    expect(value.schemaHash).toBeUndefined();
    expectTypeOf<RevisionWithSchemaHash["schemaHash"]>().toEqualTypeOf<string | undefined>();
  });
});

describe("interface shape", () => {
  it("has IDatastoreReader extend IGraphReader", () => {
    const reader: IDatastoreReader = fakeDatastore().snapshotReader(new TimestampRevision(1_000n));
    const asGraphReader: IGraphReader = reader;

    expect(typeof asGraphReader.queryRelationships).toBe("function");
    expect(typeof asGraphReader.reverseQueryRelationships).toBe("function");
  });

  it("counts relationships as a bigint, not a number", () => {
    expectTypeOf<ReturnType<IDatastoreReader["countRelationships"]>>().toEqualTypeOf<
      Promise<bigint>
    >();
    expectTypeOf<ReturnType<IReadWriteTransaction["bulkLoad"]>>().toEqualTypeOf<Promise<bigint>>();
  });

  it("returns the delete outcome as a named record with a bigint count", () => {
    expectTypeOf<DeleteRelationshipsResult>().toEqualTypeOf<{
      readonly count: bigint;
      readonly reachedLimit: boolean;
    }>();
    expectTypeOf<ReturnType<IReadWriteTransaction["deleteRelationships"]>>().toEqualTypeOf<
      Promise<DeleteRelationshipsResult>
    >();
  });

  it("takes an optional bigint delete limit and an optional signal", () => {
    expectTypeOf<Parameters<IReadWriteTransaction["deleteRelationships"]>>().toEqualTypeOf<
      [filter: RelationshipsFilter, limit?: bigint | undefined, signal?: AbortSignal | undefined]
    >();
  });

  it("reads and writes the stored schema as Uint8Array, with undefined for absent", () => {
    expectTypeOf<ReturnType<IDatastoreReader["readStoredSchema"]>>().toEqualTypeOf<
      Promise<Uint8Array | undefined>
    >();
    expectTypeOf<Parameters<IReadWriteTransaction["writeStoredSchema"]>>().toEqualTypeOf<
      [schemaBytes: Uint8Array, signal?: AbortSignal | undefined]
    >();
  });

  it("returns undefined, not null, for an unregistered counter filter", () => {
    expectTypeOf<ReturnType<IDatastoreReader["readCounterFilter"]>>().toEqualTypeOf<
      Promise<RelationshipsFilter | undefined>
    >();
  });

  it("streams counters as an AsyncIterable", () => {
    expectTypeOf<ReturnType<IDatastoreReader["lookupCounters"]>>().toEqualTypeOf<
      AsyncIterable<RegisteredCounter>
    >();
  });

  it("declares isValid as a plain boolean member", () => {
    expectTypeOf<IDatastoreReader["isValid"]>().toEqualTypeOf<boolean>();
  });

  it("returns a reader synchronously from snapshotReader", () => {
    expectTypeOf<ReturnType<IDatastore["snapshotReader"]>>().toEqualTypeOf<IDatastoreReader>();
  });

  it("takes the transaction body as a function returning Promise<void> and resolves with the committed revision", () => {
    expectTypeOf<Parameters<IDatastore["readWriteTx"]>>().toEqualTypeOf<
      [transaction: (tx: IReadWriteTransaction) => Promise<void>, signal?: AbortSignal | undefined]
    >();
    expectTypeOf<ReturnType<IDatastore["readWriteTx"]>>().toEqualTypeOf<Promise<IRevision>>();
  });

  it("requires watch options and streams changes as an AsyncIterable", () => {
    // `WatchOptions options` has NO default in the C#, unlike the reverse-query options.
    expectTypeOf<Parameters<IDatastore["watch"]>>().toEqualTypeOf<
      [afterRevision: IRevision, options: WatchOptions, signal?: AbortSignal | undefined]
    >();
    expectTypeOf<ReturnType<IDatastore["watch"]>>().toEqualTypeOf<AsyncIterable<RevisionChange>>();
  });

  it("takes bulkLoad's source as an AsyncIterable of relationships", () => {
    expectTypeOf<Parameters<IReadWriteTransaction["bulkLoad"]>>().toEqualTypeOf<
      [relationships: AsyncIterable<Relationship>, signal?: AbortSignal | undefined]
    >();
  });

  it("has close take no cancellation token, matching the C# `Task Close()`", () => {
    expectTypeOf<Parameters<IDatastore["close"]>>().toEqualTypeOf<[]>();
    expectTypeOf<ReturnType<IDatastore["close"]>>().toEqualTypeOf<Promise<void>>();
  });
});

describe("IDatastore.snapshotReader", () => {
  it("returns a reader, not a promise", async () => {
    const ds = fakeDatastore();
    const head = await ds.headRevision();

    const reader = ds.snapshotReader(head.revision);

    expect(typeof (reader as { then?: unknown }).then).toBe("undefined");
    expect(reader.isValid).toBe(true);
  });

  it("throws SYNCHRONOUSLY for a revision that is not available", async () => {
    const ds = fakeDatastore();
    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([{ relationship: rel("doc1"), operation: "create" }]);
    });
    ds.collectGarbageUpTo(new TimestampRevision(2_000n));

    // `Assert.Throws`, not `ThrowsAsync`: an async signature here would turn this into a passing
    // unhandled rejection.
    expect(() => ds.snapshotReader(new TimestampRevision(1n))).toThrow(RevisionNotFoundException);
  });
});

describe("IDatastoreReader.isValid", () => {
  it("re-evaluates against the live datastore rather than snapshotting at construction", async () => {
    const ds = fakeDatastore();
    const revision = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([{ relationship: rel("doc1"), operation: "create" }]);
    });
    const reader = ds.snapshotReader(revision);
    expect(reader.isValid).toBe(true);

    // The revision is garbage-collected out from under the reader THAT ALREADY EXISTS.
    ds.collectGarbageUpTo(new TimestampRevision(1_000_000n));

    // A captured boolean field would still report true here, forever.
    expect(reader.isValid).toBe(false);
  });
});

describe("IReadWriteTransaction", () => {
  it("exposes the revision it will commit as, and commits at it", async () => {
    const ds = fakeDatastore();
    let promised: IRevision | undefined;

    const committed = await ds.readWriteTx(async (tx) => {
      promised = tx.newRevision;
      await tx.writeRelationships([{ relationship: rel("doc1"), operation: "create" }]);
    });

    expect(committed.equals(promised!)).toBe(true);
    const head = await ds.headRevision();
    expect(head.revision.equals(committed)).toBe(true);
  });

  it("is itself a reader: reads are available inside the transaction", async () => {
    const ds = fakeDatastore();

    await ds.readWriteTx(async (tx) => {
      const asReader: IDatastoreReader = tx;
      expect(await collect(asReader.queryRelationships({}))).toEqual([]);
    });
  });

  it("propagates a throw from the transaction body and does not commit", async () => {
    const ds = fakeDatastore();
    const before = await ds.headRevision();

    await expect(
      ds.readWriteTx(async (tx) => {
        await tx.writeRelationships([{ relationship: rel("doc1"), operation: "create" }]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const after = await ds.headRevision();
    expect(after.revision.equals(before.revision)).toBe(true);
    const reader = ds.snapshotReader(after.revision);
    expect(await collect(reader.queryRelationships({}))).toEqual([]);
  });

  it("reports the delete outcome by name, not by position", async () => {
    const ds = fakeDatastore();
    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([
        { relationship: rel("doc1"), operation: "create" },
        { relationship: rel("doc2"), operation: "create" },
      ]);
    });

    let result: DeleteRelationshipsResult | undefined;
    await ds.readWriteTx(async (tx) => {
      result = await tx.deleteRelationships({ optionalResourceType: "document" });
    });

    expect(result).toEqual({ count: 2n, reachedLimit: false });
    expect(Array.isArray(result)).toBe(false);
  });

  it("bounds a delete by a bigint limit and reports that the limit was reached", async () => {
    const ds = fakeDatastore();
    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([
        { relationship: rel("doc1"), operation: "create" },
        { relationship: rel("doc2"), operation: "create" },
        { relationship: rel("doc3"), operation: "create" },
      ]);
    });

    let result: DeleteRelationshipsResult | undefined;
    await ds.readWriteTx(async (tx) => {
      result = await tx.deleteRelationships({ optionalResourceType: "document" }, 2n);
    });

    expect(result).toEqual({ count: 2n, reachedLimit: true });
  });

  it("treats an omitted limit as unbounded, so reachedLimit is false", async () => {
    const ds = fakeDatastore();
    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([{ relationship: rel("doc1"), operation: "create" }]);
    });

    let result: DeleteRelationshipsResult | undefined;
    await ds.readWriteTx(async (tx) => {
      result = await tx.deleteRelationships({ optionalResourceType: "document" }, undefined);
    });

    expect(result).toEqual({ count: 1n, reachedLimit: false });
  });

  it("counts a bulk load as a bigint", async () => {
    const ds = fakeDatastore();
    async function* source(): AsyncIterable<Relationship> {
      yield rel("doc1");
      yield rel("doc2");
    }

    let loaded: bigint | undefined;
    await ds.readWriteTx(async (tx) => {
      loaded = await tx.bulkLoad(source());
    });

    expect(loaded).toBe(2n);
  });

  it("round-trips the stored schema as bytes", async () => {
    const ds = fakeDatastore();
    const bytes = new TextEncoder().encode("definition user {}");

    const revision = await ds.readWriteTx(async (tx) => {
      await tx.writeStoredSchema(bytes);
    });

    const stored = await ds.snapshotReader(revision).readStoredSchema();
    expect(stored).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(stored)).toBe("definition user {}");
  });

  it("reports an unwritten schema as undefined, not null", async () => {
    const ds = fakeDatastore();
    const head = await ds.headRevision();

    const stored = await ds.snapshotReader(head.revision).readStoredSchema();

    expect(stored).toBeUndefined();
    expect(stored).not.toBeNull();
  });
});

describe("counters across the seam", () => {
  it("counts matching relationships at the reader's snapshot as a bigint", async () => {
    const ds = fakeDatastore();
    const revision = await ds.readWriteTx(async (tx) => {
      await tx.writeCounter("docs", { optionalResourceType: "document" });
      await tx.writeRelationships([
        { relationship: rel("doc1"), operation: "create" },
        { relationship: rel("doc2"), operation: "create" },
      ]);
    });

    const count = await ds.snapshotReader(revision).countRelationships("docs");

    expect(count).toBe(2n);
    expect(typeof count).toBe("bigint");
  });

  it("keeps a count above 2^53 exact, which a number would round", async () => {
    // The reason `ulong` is `bigint` and not `number`. 2^53 + 1 is the smallest integer a
    // float64 cannot represent; the seam must carry it unchanged.
    const beyondSafe = 9_007_199_254_740_993n;

    expect(beyondSafe.toString()).toBe("9007199254740993");
    expect(Number(beyondSafe).toString()).not.toBe("9007199254740993");
  });

  it("throws CounterNotRegisteredException when counting an unknown counter", async () => {
    const ds = fakeDatastore();
    const head = await ds.headRevision();

    await expect(ds.snapshotReader(head.revision).countRelationships("nope")).rejects.toThrow(
      CounterNotRegisteredException,
    );
  });

  it("reports an unregistered counter's filter as undefined", async () => {
    const ds = fakeDatastore();
    const head = await ds.headRevision();

    await expect(
      ds.snapshotReader(head.revision).readCounterFilter("nope"),
    ).resolves.toBeUndefined();
  });

  it("throws CounterAlreadyRegisteredException on a duplicate registration", async () => {
    const ds = fakeDatastore();
    await ds.readWriteTx(async (tx) => {
      await tx.writeCounter("docs", { optionalResourceType: "document" });
    });

    await expect(
      ds.readWriteTx(async (tx) => {
        await tx.writeCounter("docs", { optionalResourceType: "document" });
      }),
    ).rejects.toThrow(CounterAlreadyRegisteredException);
  });

  it("throws CounterNotRegisteredException when deleting an unknown counter", async () => {
    const ds = fakeDatastore();

    await expect(
      ds.readWriteTx(async (tx) => {
        await tx.deleteCounter("nope");
      }),
    ).rejects.toThrow(CounterNotRegisteredException);
  });

  it("enumerates live counters as a stream", async () => {
    const ds = fakeDatastore();
    const revision = await ds.readWriteTx(async (tx) => {
      await tx.writeCounter("docs", { optionalResourceType: "document" });
      await tx.writeCounter("folders", { optionalResourceType: "folder" });
    });

    const live = await collect(ds.snapshotReader(revision).lookupCounters());

    expect(live.map((c) => c.name)).toEqual(["docs", "folders"]);
  });
});

describe("IDatastore revisions and identity", () => {
  it("reports head and optimized revisions with the schema hash current at them", async () => {
    const ds = fakeDatastore();
    const before = await ds.headRevision();
    expect(before.schemaHash).toBeUndefined();

    await ds.readWriteTx(async (tx) => {
      await tx.writeStoredSchema(new TextEncoder().encode("definition user {}"));
    });

    const head = await ds.headRevision();
    const optimized = await ds.optimizedRevision();
    expect(head.schemaHash).toBeDefined();
    expect(optimized.revision.greaterThan(before.revision)).toBe(true);
  });

  it("checks whether a revision is still available", async () => {
    const ds = fakeDatastore();
    const revision = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([{ relationship: rel("doc1"), operation: "create" }]);
    });

    await expect(ds.checkRevision(revision)).resolves.toBe(true);

    ds.collectGarbageUpTo(new TimestampRevision(1_000_000n));
    await expect(ds.checkRevision(revision)).resolves.toBe(false);
  });

  it("hands out a parser whose datastore id matches getUniqueId, so its own tokens decode as valid", async () => {
    const ds = fakeDatastore();

    const [uniqueId, parser] = await Promise.all([ds.getUniqueId(), ds.getRevisionParser()]);

    expect(parser.datastoreUniqueId).toBe(uniqueId);
  });

  it("streams changes committed strictly after the cursor, in revision order", async () => {
    const ds = fakeDatastore();
    const first = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([{ relationship: rel("doc1"), operation: "create" }]);
    });
    const second = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([{ relationship: rel("doc2"), operation: "create" }]);
    });

    const seen = await collect(ds.watch(first, {}));

    // Strictly AFTER: the cursor's own revision is not re-emitted.
    expect(seen.map((change) => change.revision.toString())).toEqual([second.toString()]);
  });

  it("closes without a cancellation token", async () => {
    await expect(fakeDatastore().close()).resolves.toBeUndefined();
  });
});
