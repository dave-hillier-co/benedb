import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import {
  createRelationship,
  relationshipEquals,
  withCaveat,
  type Relationship,
} from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";

import {
  CreateRelationshipExistsException,
  RevisionNotFoundException,
  SerializationException,
} from "./datastore-exceptions";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";

import type { DeleteRelationshipsResult } from "./i-datastore";
import { ReferenceDatastore } from "./reference-datastore";
import { WatchContent, type RevisionChange } from "./watch";

// Port of Spiceport `tests/Spiceport.Datastore.Tests/ReferenceDatastoreTests.cs`. It is the
// covering gate for BOTH `ReferenceDatastore.cs` and `MvccReadWriteTransaction.cs`: the
// transaction has no constructor anyone but the datastore calls, so every case below drives it
// through `readWriteTx`.
//
// The cases and their assertions are carried across one-for-one. What changes is only the
// mechanics that C# and TypeScript express differently, and those decisions are pinned here
// because the port that follows has to match them:
//
// 1. `lock (_writeLock)` DISAPPEARS. Every lock body in the C# is fully synchronous
//    (SnapshotReader, HeadRevision, OptimizedRevision, CheckRevision, Watch's snapshot block,
//    and both halves of ReadWriteTx contain no `await`), so on a single-threaded event loop each
//    is already atomic. `ConcurrentWrites_SecondCommitFailsSerialization` is what proves the
//    serialization check still bites: the user callback is awaited BETWEEN the two critical
//    sections, so a second transaction can interleave there and swap `_current`. The check must
//    stay a REFERENCE comparison (`_current !== baseState`) - a deep equality would call two
//    structurally-identical states equal and this test would stop catching anything.
//
// 2. `new ReferenceDatastore(quantization: ..., gcWindow: ...)` becomes two POSITIONAL optional
//    `Duration` parameters, in the C# order. `TimeSpan.Zero` is `{ ms: 0 }`, and it must keep
//    meaning "no quantization" / "zero-width GC window" rather than falling back to the default.
//
// 3. Revisions are `bigint` nanos. The C# clock is `Ticks * 100` (100ns resolution); JavaScript
//    has no epoch-nanosecond clock, so the port samples `BigInt(Date.now()) * 1_000_000n`. Two
//    commits inside one millisecond therefore land on the SAME sampled now and separate only
//    through `NextRevision`'s `_lastRevision + 1` monotonic bump - which fires far more often
//    here than in the C#. Every case below is written to survive that: nothing asserts a
//    revision's magnitude, only its ordering and identity.
//
// 4. `IRevision` comparisons go through `.equals` / `.compareTo`, never `===`: `NewRevision`
//    allocates a fresh `TimestampRevision` on every access, so identity is meaningless.
//
// 5. `CancellationTokenSource` becomes an `AbortController`, and a `Task.Run` tailing a Watch
//    becomes an async IIFE. Breaking out of a `for await` already runs the generator's cleanup;
//    the abort mirrors the C#'s `cts.Cancel()` and additionally proves the wait leaves no
//    dangling timer or unhandled rejection behind.
//
// Not pinned here, because the C# does not pin it either: the schema hash is
// `Convert.ToHexStringLower(SHA256.HashData(bytes))` - lowercase hex, no prefix - and this test
// only asserts that a hash EXISTS. That value is wire-visible inside ZedTokens, so its exactness
// is gated downstream, not here.

function rel(
  resType: string,
  resId: string,
  relation: string,
  subType: string,
  subId: string,
  subRel: string = ELLIPSIS,
): Relationship {
  return createRelationship(
    { objectType: resType, objectId: resId, relation },
    { objectType: subType, objectId: subId, relation: subRel },
  );
}

function create(relationship: Relationship): RelationshipUpdate {
  return { relationship, operation: "create" };
}

function touch(relationship: Relationship): RelationshipUpdate {
  return { relationship, operation: "touch" };
}

function remove(relationship: Relationship): RelationshipUpdate {
  return { relationship, operation: "delete" };
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of source) collected.push(item);
  return collected;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resourceIds(relationships: readonly Relationship[]): readonly string[] {
  return relationships.map((r) => r.reference.resource.objectId);
}

/** Epoch nanoseconds `offsetMs` from now, matching core's `Relationship.optionalExpiration`. */
function expirationIn(offsetMs: number): bigint {
  return BigInt(Date.now() + offsetMs) * 1_000_000n;
}

describe("ReferenceDatastore.watch", () => {
  it("emits a change committed after the cursor", async () => {
    const ds = new ReferenceDatastore();
    const head = await ds.headRevision();
    const relationship = rel("document", "doc1", "viewer", "user", "alice");

    const controller = new AbortController();
    const collected: RevisionChange[] = [];
    const watching = (async () => {
      for await (const change of ds.watch(
        head.revision,
        { content: WatchContent.all },
        controller.signal,
      )) {
        collected.push(change);
        break;
      }
    })();

    const rev = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(relationship)]);
    });

    await watching;
    controller.abort();

    expect(collected).toHaveLength(1);
    const change = collected[0]!;
    expect(change.revision.equals(rev)).toBe(true);
    expect(change.relationshipChanges).toHaveLength(1);
    const update = change.relationshipChanges[0]!;
    // A commit surfaces as a TOUCH, whatever operation produced it.
    expect(update.operation).toBe("touch");
    expect(relationshipEquals(update.relationship, relationship)).toBe(true);
  });

  it("replays a committed write from an old cursor", async () => {
    const ds = new ReferenceDatastore();
    const head = await ds.headRevision();
    const relationship = rel("document", "doc2", "viewer", "user", "bob");

    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(relationship)]);
    });

    const controller = new AbortController();
    let first: RevisionChange | undefined;
    for await (const change of ds.watch(head.revision, {}, controller.signal)) {
      first = change;
      break;
    }
    controller.abort();

    expect(first).toBeDefined();
    expect(first!.relationshipChanges).toHaveLength(1);
    expect(first!.relationshipChanges[0]!.relationship.reference.resource.objectId).toBe("doc2");
  });

  it("emits a checkpoint after a change when checkpoints are requested", async () => {
    const ds = new ReferenceDatastore();
    const head = await ds.headRevision();
    const relationship = rel("document", "doc1", "viewer", "user", "alice");

    const controller = new AbortController();
    const collected: RevisionChange[] = [];
    const watching = (async () => {
      for await (const change of ds.watch(
        head.revision,
        { content: WatchContent.relationships | WatchContent.checkpoints },
        controller.signal,
      )) {
        collected.push(change);
        if (change.isCheckpoint === true) break;
      }
    })();

    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(relationship)]);
    });

    await watching;
    controller.abort();

    expect(collected).toHaveLength(2);
    expect(collected[0]!.isCheckpoint ?? false).toBe(false);
    expect(collected[0]!.relationshipChanges).toHaveLength(1);
    const checkpoint = collected[1]!;
    expect(checkpoint.isCheckpoint).toBe(true);
    expect(checkpoint.relationshipChanges).toEqual([]);
    // The checkpoint names the latest revision the changefeed advanced through.
    expect(checkpoint.revision.equals(collected[0]!.revision)).toBe(true);
  });

  it("does not emit a checkpoint when checkpoints are not requested", async () => {
    const ds = new ReferenceDatastore();
    const head = await ds.headRevision();
    const relationship = rel("document", "doc1", "viewer", "user", "alice");

    const controller = new AbortController();
    const collected: RevisionChange[] = [];
    const watching = (async () => {
      for await (const change of ds.watch(
        head.revision,
        { content: WatchContent.relationships },
        controller.signal,
      )) {
        collected.push(change);
        break;
      }
    })();

    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(relationship)]);
    });

    await watching;
    controller.abort();

    expect(collected).toHaveLength(1);
    expect(collected[0]!.isCheckpoint ?? false).toBe(false);
  });
});

describe("ReferenceDatastore changefeed retention", () => {
  it("prunes the changefeed in lockstep with the GC window", async () => {
    // A tiny GC window means each new commit pushes prior commits out of the retained window. The
    // changefeed must not retain expired revisions, so a fresh Watch from head only ever sees the
    // changes still inside the window - never an unbounded backlog.
    const ds = new ReferenceDatastore({ ms: 0 }, { ms: 1 });

    for (let i = 0; i < 5; i++) {
      const relationship = rel("document", `doc${i}`, "viewer", "user", "alice");
      await ds.readWriteTx(async (tx) => {
        await tx.writeRelationships([create(relationship)]);
      });
      await delay(5);
    }

    // After the writes, watching from a fresh head must succeed and the older (GC'd) revisions
    // must no longer be replayable as cursors.
    const head = await ds.headRevision();
    expect(await ds.checkRevision(head.revision)).toBe(true);

    // One more commit advances head; the prior commits have aged out of the 1ms window.
    const lastRel = rel("document", "docLast", "viewer", "user", "alice");
    const lastRev = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(lastRel)]);
    });

    // Watching from the just-committed revision yields nothing pending and does not throw - the
    // changefeed has been trimmed but the live cursor is still valid.
    expect(await ds.checkRevision(lastRev)).toBe(true);
  });
});

describe("ReferenceDatastore reads and writes", () => {
  it("reads back a written relationship", async () => {
    const ds = new ReferenceDatastore();
    const relationship = rel("document", "doc1", "viewer", "user", "alice");

    const rev = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(relationship)]);
    });

    const reader = ds.snapshotReader(rev);
    const results = await collect(reader.queryRelationships({ optionalResourceType: "document" }));

    expect(results).toHaveLength(1);
    expect(relationshipEquals(results[0]!, relationship)).toBe(true);
  });

  it("does not show a new write at an older revision", async () => {
    const ds = new ReferenceDatastore();
    const relA = rel("document", "doc1", "viewer", "user", "alice");
    const relB = rel("document", "doc2", "viewer", "user", "bob");

    const rev1 = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(relA)]);
    });
    const rev2 = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(relB)]);
    });

    const atRev1 = await collect(ds.snapshotReader(rev1).queryRelationships({}));
    const atRev2 = await collect(ds.snapshotReader(rev2).queryRelationships({}));

    expect(atRev1).toHaveLength(1);
    expect(relationshipEquals(atRev1[0]!, relA)).toBe(true);
    expect(atRev2).toHaveLength(2);
  });

  it("does not show a delete at an older revision", async () => {
    const ds = new ReferenceDatastore();
    const relationship = rel("document", "doc1", "viewer", "user", "alice");

    const rev1 = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(relationship)]);
    });
    const rev2 = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([remove(relationship)]);
    });

    const atRev1 = await collect(ds.snapshotReader(rev1).queryRelationships({}));
    const atRev2 = await collect(ds.snapshotReader(rev2).queryRelationships({}));

    expect(atRev1).toHaveLength(1);
    expect(atRev2).toEqual([]);
  });

  it("throws CreateRelationshipExists when creating an existing relationship", async () => {
    // A CREATE on an already-existing relationship is a permanent conflict (AlreadyExists at the
    // gRPC boundary), NOT a transient write-write serialization failure (Aborted).
    const ds = new ReferenceDatastore();
    const relationship = rel("document", "doc1", "viewer", "user", "alice");

    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(relationship)]);
    });

    await expect(
      ds.readWriteTx(async (tx) => {
        await tx.writeRelationships([create(relationship)]);
      }),
    ).rejects.toThrow(CreateRelationshipExistsException);
  });

  it("upserts on touch without throwing", async () => {
    const ds = new ReferenceDatastore();
    const relationship = rel("document", "doc1", "viewer", "user", "alice");
    const withCaveated = withCaveat(relationship, { caveatName: "only_office" });

    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([touch(relationship)]);
    });
    const rev = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([touch(withCaveated)]);
    });

    const results = await collect(ds.snapshotReader(rev).queryRelationships({}));
    expect(results).toHaveLength(1);
    expect(results[0]!.optionalCaveat?.caveatName).toBe("only_office");
  });

  it("filters by resource id", async () => {
    const ds = new ReferenceDatastore();
    const rev = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([
        create(rel("document", "doc1", "viewer", "user", "alice")),
        create(rel("document", "doc2", "viewer", "user", "bob")),
      ]);
    });

    const results = await collect(
      ds
        .snapshotReader(rev)
        .queryRelationships({ optionalResourceType: "document", optionalResourceIds: ["doc2"] }),
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.reference.resource.objectId).toBe("doc2");
  });

  it("filters by resource id prefix", async () => {
    const ds = new ReferenceDatastore();
    const rev = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([
        create(rel("document", "report-1", "viewer", "user", "alice")),
        create(rel("document", "report-2", "viewer", "user", "bob")),
        create(rel("document", "memo-1", "viewer", "user", "carol")),
      ]);
    });

    const results = await collect(
      ds.snapshotReader(rev).queryRelationships({
        optionalResourceType: "document",
        optionalResourceIdPrefix: "report-",
      }),
    );

    expect(results).toHaveLength(2);
    for (const r of results) expect(r.reference.resource.objectId.startsWith("report-")).toBe(true);
  });

  it("filters a reverse query by subject", async () => {
    const ds = new ReferenceDatastore();
    const rev = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([
        create(rel("document", "doc1", "viewer", "user", "alice")),
        create(rel("document", "doc2", "viewer", "user", "bob")),
        create(rel("folder", "f1", "viewer", "user", "alice")),
      ]);
    });

    const results = await collect(
      ds
        .snapshotReader(rev)
        .reverseQueryRelationships({ subjectType: "user", optionalSubjectIds: ["alice"] }),
    );

    expect(results).toHaveLength(2);
    for (const r of results) expect(r.reference.subject.objectId).toBe("alice");
  });

  it("orders a bySubject reverse query and resumes after a keyset", async () => {
    const ds = new ReferenceDatastore();
    const rev = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([
        // Inserted out of order; bySubject must yield doc1, doc2, doc3.
        create(rel("document", "doc3", "viewer", "user", "alice")),
        create(rel("document", "doc1", "viewer", "user", "alice")),
        create(rel("document", "doc2", "viewer", "user", "alice")),
      ]);
    });
    const reader = ds.snapshotReader(rev);
    const filter = { subjectType: "user", optionalSubjectIds: ["alice"] } as const;

    const ordered = await collect(reader.reverseQueryRelationships(filter, { sort: "bySubject" }));
    expect(resourceIds(ordered)).toEqual(["doc1", "doc2", "doc3"]);

    // Exclusive keyset resume after the first row does not repeat it.
    const after = await collect(
      reader.reverseQueryRelationships(filter, {
        sort: "bySubject",
        after: ordered[0]!.reference,
      }),
    );
    expect(resourceIds(after)).toEqual(["doc2", "doc3"]);
  });

  it("filters by caveat", async () => {
    const ds = new ReferenceDatastore();
    const plain = rel("document", "doc1", "viewer", "user", "alice");
    const caveated = withCaveat(rel("document", "doc2", "viewer", "user", "bob"), {
      caveatName: "biz_hours",
    });

    const rev = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(plain), create(caveated)]);
    });

    const hasCaveat = await collect(
      ds.snapshotReader(rev).queryRelationships({
        optionalCaveatNameFilter: { option: "hasMatchingCaveat", caveatName: "biz_hours" },
      }),
    );
    const noCaveat = await collect(
      ds.snapshotReader(rev).queryRelationships({
        optionalCaveatNameFilter: { option: "noCaveat" },
      }),
    );

    expect(hasCaveat).toHaveLength(1);
    expect(hasCaveat[0]!.reference.resource.objectId).toBe("doc2");
    expect(noCaveat).toHaveLength(1);
    expect(noCaveat[0]!.reference.resource.objectId).toBe("doc1");
  });

  it("excludes an expired relationship", async () => {
    const ds = new ReferenceDatastore();
    const expired = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      undefined,
      expirationIn(-60_000),
    );
    const live = createRelationship(
      { objectType: "document", objectId: "doc2", relation: "viewer" },
      { objectType: "user", objectId: "bob", relation: ELLIPSIS },
      undefined,
      expirationIn(3_600_000),
    );

    const rev = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(expired), create(live)]);
    });

    const results = await collect(ds.snapshotReader(rev).queryRelationships({}));
    expect(results).toHaveLength(1);
    expect(results[0]!.reference.resource.objectId).toBe("doc2");
  });

  it("deletes matching relationships and reports the count", async () => {
    const ds = new ReferenceDatastore();
    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([
        create(rel("document", "doc1", "viewer", "user", "alice")),
        create(rel("document", "doc2", "viewer", "user", "bob")),
      ]);
    });

    let deleteResult: DeleteRelationshipsResult | undefined;
    const rev = await ds.readWriteTx(async (tx) => {
      deleteResult = await tx.deleteRelationships({ optionalResourceType: "document" });
    });

    expect(deleteResult?.count).toBe(2n);
    const remaining = await collect(ds.snapshotReader(rev).queryRelationships({}));
    expect(remaining).toEqual([]);
  });

  it("respects a delete limit", async () => {
    const ds = new ReferenceDatastore();
    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([
        create(rel("document", "doc1", "viewer", "user", "alice")),
        create(rel("document", "doc2", "viewer", "user", "bob")),
        create(rel("document", "doc3", "viewer", "user", "carol")),
      ]);
    });

    let deleteResult: DeleteRelationshipsResult | undefined;
    const rev = await ds.readWriteTx(async (tx) => {
      deleteResult = await tx.deleteRelationships({ optionalResourceType: "document" }, 2n);
    });

    expect(deleteResult?.count).toBe(2n);
    expect(deleteResult?.reachedLimit).toBe(true);
    const remaining = await collect(ds.snapshotReader(rev).queryRelationships({}));
    expect(remaining).toHaveLength(1);
  });

  it("writes and reads back the stored schema", async () => {
    const ds = new ReferenceDatastore();
    const schema = new TextEncoder().encode("definition user {}");

    const rev = await ds.readWriteTx(async (tx) => {
      await tx.writeStoredSchema(schema);
    });

    const read = await ds.snapshotReader(rev).readStoredSchema();
    expect(read).toBeDefined();
    expect(read).toEqual(schema);

    const head = await ds.headRevision();
    expect(head.schemaHash).toBeDefined();
  });

  it("keeps the schema snapshot-isolated", async () => {
    const ds = new ReferenceDatastore();
    const v1 = new TextEncoder().encode("definition user {}");
    const v2 = new TextEncoder().encode("definition user {}\ndefinition doc {}");

    const rev1 = await ds.readWriteTx(async (tx) => {
      await tx.writeStoredSchema(v1);
    });
    const rev2 = await ds.readWriteTx(async (tx) => {
      await tx.writeStoredSchema(v2);
    });

    expect(await ds.snapshotReader(rev1).readStoredSchema()).toEqual(v1);
    expect(await ds.snapshotReader(rev2).readStoredSchema()).toEqual(v2);
  });

  it("bulk loads every relationship from the source", async () => {
    const ds = new ReferenceDatastore();

    async function* source(): AsyncGenerator<Relationship> {
      yield rel("document", "doc1", "viewer", "user", "alice");
      yield rel("document", "doc2", "viewer", "user", "bob");
    }

    let loaded: bigint | undefined;
    const rev = await ds.readWriteTx(async (tx) => {
      loaded = await tx.bulkLoad(source());
    });

    expect(loaded).toBe(2n);
    const results = await collect(ds.snapshotReader(rev).queryRelationships({}));
    expect(results).toHaveLength(2);
  });
});

describe("ReferenceDatastore revisions", () => {
  it("increases the head revision after a write", async () => {
    const ds = new ReferenceDatastore();
    const before: IRevision = (await ds.headRevision()).revision;

    const committed = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(rel("document", "doc1", "viewer", "user", "alice"))]);
    });

    const after = (await ds.headRevision()).revision;
    expect(after.compareTo(before)).toBeGreaterThan(0);
    expect(after.compareTo(committed)).toBe(0);
  });

  it("rejects a revision that has fallen outside the GC window", async () => {
    const ds = new ReferenceDatastore(undefined, { ms: 0 });

    const rev1 = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(rel("document", "doc1", "viewer", "user", "alice"))]);
    });

    // A second commit advances the head; rev1 now falls outside the zero-width GC window.
    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(rel("document", "doc2", "viewer", "user", "bob"))]);
    });

    expect(await ds.checkRevision(rev1)).toBe(false);
    // snapshotReader throws SYNCHRONOUSLY, so this is `toThrow`, not `rejects.toThrow`.
    expect(() => ds.snapshotReader(rev1)).toThrow(RevisionNotFoundException);
  });

  it("fails the second concurrent commit with a serialization error", async () => {
    const ds = new ReferenceDatastore();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    // First transaction begins and pauses inside its body, holding the base state.
    const first = ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(rel("document", "doc1", "viewer", "user", "alice"))]);
      await gate;
    });

    // Second transaction starts and commits against the same base while the first is paused.
    const second = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(rel("document", "doc2", "viewer", "user", "bob"))]);
    });
    expect(second).toBeDefined();

    // Release the first; it should now fail to commit because the base changed.
    releaseGate();
    await expect(first).rejects.toThrow(SerializationException);
  });

  // The optimized revision is a real, committed head sampled when a window opens - never floored
  // BELOW head - so a minimize-latency read at it sees everything committed before the window
  // opened and is snapshot-readable. (SpiceDB's CachedOptimizedRevisions / memdb behaviour.)
  it("returns an optimized revision at or above head that is snapshot readable", async () => {
    const ds = new ReferenceDatastore();
    const committed = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(rel("document", "doc1", "viewer", "user", "alice"))]);
    });
    const head = await ds.headRevision();

    const opt = await ds.optimizedRevision();

    // Not pinned below head: the optimized read sees the committed write (no silent stale read).
    expect(opt.revision.compareTo(committed)).toBeGreaterThanOrEqual(0);
    expect(opt.revision.equals(head.revision)).toBe(true);
    // And it is a snapshot the datastore can actually read at.
    expect(ds.snapshotReader(opt.revision).isValid).toBe(true);
  });

  // Within one quantization window the optimized revision is STABLE, so near-in-time
  // minimize-latency checks share a single revision - and therefore a single cache key (read
  // snapshot == cache key).
  it("keeps the optimized revision stable within the quantization window", async () => {
    const ds = new ReferenceDatastore({ seconds: 5 });
    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([create(rel("document", "doc1", "viewer", "user", "alice"))]);
    });

    const first = await ds.optimizedRevision();
    const second = await ds.optimizedRevision();

    expect(first.revision.equals(second.revision)).toBe(true);
  });
});

// Not from the C# suite: these pin two invariants the C# type system carried for free and the
// port had to restore by hand.
describe("ReferenceDatastore port-only invariants", () => {
  it("rejects a negative delete limit rather than counting from the end", async () => {
    // The C# parameter is `ulong? limit`, so a negative value is unrepresentable. `bigint` is
    // signed, and `slice(0, Number(-1n))` counts from the END -- without a guard, a negative
    // limit silently deletes all but |limit| rows and reports the limit as reached.
    const ds = new ReferenceDatastore();
    await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([
        touch(rel("document", "a", "viewer", "user", "alice")),
        touch(rel("document", "b", "viewer", "user", "alice")),
        touch(rel("document", "c", "viewer", "user", "alice")),
      ]);
    });

    await expect(
      ds.readWriteTx(async (tx) => {
        await tx.deleteRelationships({}, -1n);
      }),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it("keeps two relationships whose fields differ only by where a boundary falls", async () => {
    // Nothing on this path enforces the SpiceDB grammar, so a field may contain any character.
    // With a separator-joined canonical key these two collapse into one row.
    const straddling = rel("document", "a b", "viewer", "user", "alice");
    const shifted = rel("document", "a", "b viewer", "user", "alice");

    const ds = new ReferenceDatastore();
    const revision = await ds.readWriteTx(async (tx) => {
      await tx.writeRelationships([touch(straddling), touch(shifted)]);
    });

    const rows = await collect(ds.snapshotReader(revision).queryRelationships({}));
    expect(rows).toHaveLength(2);
  });

  it("stops a bulk load when its signal aborts", async () => {
    // The C# is `relationships.WithCancellation(token)`; `AsyncIterable` has no signal channel,
    // so the check has to live in the loop body.
    const controller = new AbortController();
    let produced = 0;
    async function* source(): AsyncIterable<Relationship> {
      for (let i = 0; i < 5; i++) {
        produced++;
        if (i === 1) controller.abort();
        yield rel("document", `d${i}`, "viewer", "user", "alice");
      }
    }

    const ds = new ReferenceDatastore();
    await expect(
      ds.readWriteTx(async (tx) => {
        await tx.bulkLoad(source(), controller.signal);
      }),
    ).rejects.toThrow();
    expect(produced).toBeLessThan(5);
  });
});
