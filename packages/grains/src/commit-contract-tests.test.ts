import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { decodeRevision } from "@benedb/core/zed-tokens";
import { WatchContent, type RevisionChange } from "@benedb/datastore/watch";
import { GrainCallAbortedError } from "@thresh/core/errors";

import type { CommitPreconditionWire, CommitRequest, DeleteByFilterWire } from "./commit-contract";
import { FULLY_CONSISTENT_WIRE } from "./consistency-wire";
import type { FullRelationshipsFilterWire } from "./datastore-dtos";
import type { IDatastoreGrain as IDatastoreGrainType } from "./i-datastore-grain";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import type { IDatastoreWatcher as IDatastoreWatcherType } from "./i-datastore-watcher";
import { IDatastoreWatcher } from "./i-datastore-watcher";
import { MeshTestCluster } from "./mesh-test-cluster";
import { CounterOperationException } from "./relationships-dtos";
import type {
  RelationshipsFilterWire,
  RelationshipUpdateOpWire,
  RelationshipUpdateWire,
  RelationshipWire,
} from "./relationships-dtos";
import { PreconditionFailedException } from "./precondition-failed-exception";
import { WriteConflictException } from "./write-conflict-exception";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/CommitContractTests.cs`.
 *
 * Step-4 gates for the Commit wire contract (`docs/graph-sharded-datastore.md` section 3):
 * relationship writes/deletes/counters are DECLARATIVE `CommitRequest`s executed inside the
 * sequencer (`IDatastoreGrain.commit` - one hop, no client retry), while the lambda
 * `GrainBackedDatastore.readWriteTx` survives as the ExpectedHead-CAS compatibility path. Every
 * rejection crosses the grain boundary as STRUCTURED REPLY DATA and is rethrown by the client as
 * the exact typed exception the write surface has always thrown, so the gRPC status mappings
 * (FailedPrecondition / AlreadyExists / Aborted) are pinned unchanged. Driven THROUGH the real
 * grain mesh (Thresh's in-process `TestCluster` via `MeshTestCluster`), the same way the data-plane
 * suite drives its writes.
 *
 * PORT NOTES.
 *  - `[Collection(MeshClusterCollection.Name)]` -> nothing; see `mesh-cluster-collection.ts`.
 *  - `await using var cluster` -> an explicit `try { ... } finally { await cluster.dispose(); }`.
 *    A leaked cluster is the orphaned-host hazard in miniature.
 *  - `Sequencer(cluster)` resolves through `cluster.grainFactory` - the cluster CLIENT, not a silo
 *    handle - because the same factory has to mint the `RecordingWatcher` observer reference the
 *    last case hands to `subscribeWatch`, exactly the way `LogWatchHub` does.
 *  - The C# enums `PreconditionFailureKind`, `WriteConflictKind`, `CommitFailureKind` and
 *    `CounterErrorKind` are string-literal unions here; the spellings come from
 *    `precondition-failed-exception.ts`, `write-conflict-exception.ts`, `commit-contract.ts` and
 *    `relationships-dtos.ts`.
 *  - `Assert.ThrowsAsync<T>` -> `rejectsWith`, which returns the caught error so the case can go on
 *    to assert its `kind` / `preconditionIndex` / message the way the C# does.
 *  - `long` heads and revisions, and `ulong` counts, are `bigint`: `head - 1` is `head - 1n`,
 *    `3UL` is `3n`.
 *  - `Encoding.UTF8.GetBytes` -> `new TextEncoder().encode`.
 *  - ABSENT vs EMPTY on `expectedSchemaHash` is kept exactly: `""` claims the pre-first-schema seed
 *    window and is a different case from an absent hash.
 *  - The racing-`readWriteTx` case starts both lambdas WITHOUT awaiting and only then joins them.
 *    Awaiting them in sequence would delete the CAS race the case exists to prove.
 *  - The 500ms settle window for the ONE-WAY `headAdvanced` push is a real wall-clock wait. Fake
 *    timers would fast-forward past exactly the window in which a phantom push would arrive.
 */

const VIEWER_SCHEMA = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

function update(
  operation: RelationshipUpdateOpWire,
  res: string,
  subj: string,
): RelationshipUpdateWire {
  return {
    operation,
    relationship: {
      resourceType: "document",
      resourceId: res,
      resourceRelation: "viewer",
      subjectType: "user",
      subjectId: subj,
      subjectRelation: ELLIPSIS,
      caveatName: undefined,
      caveatContext: undefined,
      expiration: undefined,
    },
  };
}

function touch(res: string, subj: string): RelationshipUpdateWire {
  return update("touch", res, subj);
}

function create(res: string, subj: string): RelationshipUpdateWire {
  return update("create", res, subj);
}

/** A filter over document#viewer rows, optionally narrowed to one resource id. */
function viewerFilter(resourceId?: string | undefined): RelationshipsFilterWire {
  return {
    resourceType: "document",
    resourceIdPrefix: undefined,
    resourceIds: resourceId === undefined ? undefined : [resourceId],
    resourceRelation: "viewer",
    subjectType: undefined,
    subjectIds: undefined,
    subjectRelation: undefined,
  };
}

/** The lossless full-filter form of {@link viewerFilter} for direct grain commits. */
function fullViewerFilter(resourceId: string): FullRelationshipsFilterWire {
  return {
    optionalResourceType: "document",
    optionalResourceIds: [resourceId],
    optionalResourceIdPrefix: undefined,
    optionalResourceRelation: "viewer",
    optionalSubjectsSelectors: undefined,
    optionalCaveatNameFilter: undefined,
    optionalExpirationOption: 0,
  };
}

/** A direct-grain `CommitRequest` with everything defaulted to empty/absent. */
function directCommit(
  options: {
    readonly preconditions?: readonly CommitPreconditionWire[] | undefined;
    readonly updates?: readonly RelationshipUpdateWire[] | undefined;
    readonly deleteByFilter?: DeleteByFilterWire | undefined;
    readonly schemaBytes?: Uint8Array | undefined;
    readonly expectedSchemaHash?: string | undefined;
    readonly expectedHead?: bigint | undefined;
  } = {},
): CommitRequest {
  return {
    preconditions: options.preconditions ?? [],
    updates: options.updates ?? [],
    deleteByFilter: options.deleteByFilter,
    schemaBytes: options.schemaBytes,
    expectedSchemaHash: options.expectedSchemaHash,
    counterChanges: [],
    expectedHead: options.expectedHead,
  };
}

function sequencer(cluster: MeshTestCluster): IDatastoreGrainType {
  return cluster.grainFactory.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
}

/** Decodes a reply token back to the grain-minted revision (nanos). */
async function revisionOf(cluster: MeshTestCluster, token: string): Promise<bigint> {
  const parser = await cluster.datastore.getRevisionParser();
  const decoded = decodeRevision({ token }, parser);
  expect(decoded.status).toBe("valid");
  return (decoded.revision as TimestampRevision).timestampNanosSinceEpoch;
}

/** Fully-consistent read of the live document#viewer rows for one resource. */
async function readViewers(
  cluster: MeshTestCluster,
  resourceId: string,
): Promise<RelationshipWire[]> {
  const rows: RelationshipWire[] = [];
  for await (const item of cluster.relationshipReads.readRelationships({
    filter: viewerFilter(resourceId),
    limit: undefined,
    cursor: undefined,
    consistency: FULLY_CONSISTENT_WIRE,
  })) {
    rows.push(item.relationship);
  }
  return rows;
}

/** `Assert.ThrowsAsync<T>`: awaits, requires the rejection, and hands the typed error back. */
async function rejectsWith<T>(
  work: Promise<unknown>,
  ctor: new (...args: never[]) => T,
): Promise<T> {
  let caught: unknown;
  let threw = false;
  try {
    await work;
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw, `expected a ${ctor.name}, but the call succeeded`).toBe(true);
  expect(caught).toBeInstanceOf(ctor);
  return caught as T;
}

/** A real wall-clock delay. Never replace with fake timers - see the port notes. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CommitContractTests", () => {
  // ---- 1. MustMatch preconditions ride the declarative commit. ----

  it("MustMatch_precondition_satisfied_commits_the_write", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      await cluster.relationships.writeRelationships({ updates: [touch("seed", "alice")] });

      const reply = await cluster.relationships.writeRelationships({
        updates: [touch("guarded", "bob")],
        preconditions: [{ operation: "mustMatch", filter: viewerFilter("seed") }],
      });

      expect(reply.writtenAtToken.length > 0).toBe(true);
      expect(await readViewers(cluster, "guarded")).toHaveLength(1);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("MustMatch_precondition_failure_throws_the_typed_exception_and_nothing_commits", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      await cluster.relationships.writeRelationships({ updates: [touch("seed", "alice")] });

      // Two preconditions: the first passes, the SECOND fails - pins that the failing index (not
      // just "a failure") survives the reply-data round trip into the rethrown exception.
      const ex = await rejectsWith(
        cluster.relationships.writeRelationships({
          updates: [touch("guarded", "bob")],
          preconditions: [
            { operation: "mustMatch", filter: viewerFilter("seed") },
            { operation: "mustMatch", filter: viewerFilter("missing") },
          ],
        }),
        PreconditionFailedException,
      );

      expect(ex.kind).toBe("mustMatchFoundNone");
      expect(ex.preconditionIndex).toBe(1);

      // Atomic rejection: the guarded update never landed.
      expect(await readViewers(cluster, "guarded")).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 2. MustNotMatch preconditions. ----

  it("MustNotMatch_precondition_satisfied_commits_the_write", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const reply = await cluster.relationships.writeRelationships({
        updates: [touch("guarded", "bob")],
        preconditions: [{ operation: "mustNotMatch", filter: viewerFilter("missing") }],
      });

      expect(reply.writtenAtToken.length > 0).toBe(true);
      expect(await readViewers(cluster, "guarded")).toHaveLength(1);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("MustNotMatch_precondition_failure_throws_the_typed_exception_and_nothing_commits", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      await cluster.relationships.writeRelationships({ updates: [touch("seed", "alice")] });

      const ex = await rejectsWith(
        cluster.relationships.writeRelationships({
          updates: [touch("guarded", "bob")],
          preconditions: [{ operation: "mustNotMatch", filter: viewerFilter("seed") }],
        }),
        PreconditionFailedException,
      );

      expect(ex.kind).toBe("mustNotMatchFoundOne");
      expect(ex.preconditionIndex).toBe(0);
      expect(await readViewers(cluster, "guarded")).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 3. Duplicate CREATE is a typed conflict; the first create survives. ----

  it("Duplicate_create_throws_the_typed_conflict_and_first_create_survives", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const first = await cluster.relationships.writeRelationships({
        updates: [create("readme", "alice")],
      });
      expect(first.writtenAtToken.length > 0).toBe(true);

      const ex = await rejectsWith(
        cluster.relationships.writeRelationships({ updates: [create("readme", "alice")] }),
        WriteConflictException,
      );
      expect(ex.kind).toBe("createExisting");

      // The first create landed and is untouched by the rejected duplicate.
      const rows = await readViewers(cluster, "readme");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.subjectId).toBe("alice");

      // A Touch of the same tuple afterwards is the documented upsert escape hatch and still works.
      const touched = await cluster.relationships.writeRelationships({
        updates: [touch("readme", "alice")],
      });
      expect(touched.writtenAtToken.length > 0).toBe(true);
      expect(await readViewers(cluster, "readme")).toHaveLength(1);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 4. DeleteByFilter with a limit reports count/reached-limit and stops exactly at the limit. ----

  it("Delete_with_limit_reports_reached_and_leaves_the_remainder", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      await cluster.relationships.writeRelationships({
        updates: [1, 2, 3, 4, 5].map((i) => touch("bulk", `user${i}`)),
      });

      const limited = await cluster.relationships.deleteRelationships({
        filter: viewerFilter("bulk"),
        optionalLimit: 3n,
      });
      expect(limited.deletedCount).toBe(3n);
      expect(limited.reachedLimit).toBe(true);

      // Exactly 2 remain, observed via a snapshot reader pinned at the delete's own token revision.
      const deleteRevision = await revisionOf(cluster, limited.deletedAtToken);
      const reader = cluster.datastore.snapshotReader(new TimestampRevision(deleteRevision));
      const remaining: Relationship[] = [];
      for await (const rel of reader.queryRelationships({
        optionalResourceType: "document",
        optionalResourceIds: ["bulk"],
      })) {
        remaining.push(rel);
      }
      expect(remaining).toHaveLength(2);

      const rest = await cluster.relationships.deleteRelationships({
        filter: viewerFilter("bulk"),
        optionalLimit: undefined,
      });
      expect(rest.deletedCount).toBe(2n);
      expect(rest.reachedLimit).toBe(false);
      expect(await readViewers(cluster, "bulk")).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 5. ExpectedHead CAS: the lambda compatibility path retries a lost race and loses no update. ----

  /**
   * The Commit-path equivalent of `GrainBackedDatastoreWriteBaseTests.RacingWrites_*` (which pins
   * the retry/call-count mechanics against a counting fake): here two concurrent readWriteTx
   * lambdas race THROUGH the real sequencer grain, each doing a read-modify-write (create a row
   * whose id is the number of rows it currently sees). A lost update would make both writers see
   * the same count - the second Create would then conflict (or a row would silently vanish) - so
   * both committing with rows "s0" AND "s1" present proves the ExpectedHead CAS rejected the stale
   * commit and the loser re-ran its whole lambda against the fresh base.
   */
  it("Racing_ReadWriteTx_lambdas_both_commit_and_the_state_reflects_both", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const ds = cluster.datastore;

      const filter = {
        optionalResourceType: "document",
        optionalResourceIds: ["tally"],
      } as const;

      const writeNext = (): Promise<TimestampRevision> =>
        ds.readWriteTx(async (tx) => {
          let count = 0;
          for await (const _ of tx.queryRelationships(filter)) count++;
          await tx.writeRelationships([
            {
              relationship: createRelationship(
                { objectType: "document", objectId: "tally", relation: "viewer" },
                { objectType: "user", objectId: `s${count}`, relation: ELLIPSIS },
              ),
              operation: "create",
            },
          ]);
        }) as Promise<TimestampRevision>;

      // BOTH lambdas start before either is awaited: awaiting them in sequence would delete the
      // CAS race this case exists to prove.
      const first = writeNext();
      const second = writeNext();
      const revisions = await Promise.all([first, second]);

      expect(revisions[0].timestampNanosSinceEpoch).not.toBe(revisions[1].timestampNanosSinceEpoch);

      const subjects = new Set((await readViewers(cluster, "tally")).map((r) => r.subjectId));
      expect(subjects).toEqual(new Set(["s0", "s1"]));
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 6. ExpectedSchemaHash: schema-write serializability at the grain, convergence at the RPC. ----

  it("Stale_ExpectedSchemaHash_is_rejected_as_SchemaHashMoved_and_normal_WriteSchema_converges", async () => {
    const schemaA = VIEWER_SCHEMA;
    const schemaB = `${VIEWER_SCHEMA}\ndefinition folder {}`;
    const schemaC = `${VIEWER_SCHEMA}\ndefinition team {}`;

    const cluster = await MeshTestCluster.create(schemaA);
    try {
      // Store schema A and pin the stored-schema hash the sequencer's gate compares.
      await cluster.writeSchema(schemaA);
      const hashA = (await cluster.datastore.headRevision()).schemaHash;
      expect(hashA !== undefined && hashA.length > 0).toBe(true);

      // Schema C lands through the RPC - the hash at head has now moved past A's.
      await cluster.writeSchema(schemaC);
      const hashC = (await cluster.datastore.headRevision()).schemaHash;
      expect(hashC).not.toBe(hashA);

      // A commit carrying B validated against A's hash (the simulated in-flight WriteSchema B) must
      // be rejected as SchemaHashMoved at the grain - as reply data, with nothing applied.
      const reply = await sequencer(cluster).commit({
        preconditions: [],
        updates: [],
        deleteByFilter: undefined,
        schemaBytes: new TextEncoder().encode(schemaB),
        expectedSchemaHash: hashA,
        counterChanges: [],
        expectedHead: undefined,
      });

      expect(reply.revision).toBeUndefined();
      expect(reply.failure?.kind).toBe("schemaHashMoved");
      expect((await cluster.datastore.headRevision()).schemaHash).toBe(hashC);

      // Driven normally, the RPC's validate-and-commit loop re-pins a fresh hash and converges.
      const written = await cluster.writeSchema(schemaB);
      expect(written.writtenAtToken.length > 0).toBe(true);
      expect(cluster.schemaProvider.current.sourceText).toBe(schemaB);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 7. Serialized declarative commits need no retry. ----

  it("Parallel_declarative_writes_all_commit_with_strictly_increasing_revisions", async () => {
    const writers = 20;
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const preHead = ((await cluster.datastore.headRevision()).revision as TimestampRevision)
        .timestampNanosSinceEpoch;

      // Distinct tuples in parallel through the RPC path. A declarative commit executes inside the
      // single-threaded sequencer, so every one must succeed first try - a SerializationException
      // here (or any other throw) fails the Promise.all and the test.
      const replies = await Promise.all(
        Array.from({ length: writers }, (_, i) =>
          cluster.relationships.writeRelationships({ updates: [touch(`doc${i}`, "alice")] }),
        ),
      );

      const tokenRevisions = new Set<bigint>();
      for (const reply of replies)
        tokenRevisions.add(await revisionOf(cluster, reply.writtenAtToken));
      expect(tokenRevisions.size).toBe(writers);

      // The log is the authority on the commit order: exactly one event per write, strictly
      // increasing, and carrying exactly the revisions the reply tokens minted.
      const segment = await sequencer(cluster).readFrom(preHead, -1);
      expect(segment.events).toHaveLength(writers);
      for (let i = 1; i < segment.events.length; i++) {
        expect(
          (segment.events[i] as { revision: bigint }).revision >
            (segment.events[i - 1] as { revision: bigint }).revision,
          `log revisions not strictly increasing at index ${i}`,
        ).toBe(true);
      }
      expect(new Set(segment.events.map((e) => e.revision))).toEqual(tokenRevisions);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 8. Watch continuity over the new write path. ----

  it("Watch_tails_declarative_commits_with_their_minted_revisions", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 20_000);
    try {
      const ds = cluster.datastore;

      const preWrite = (await ds.headRevision()).revision;

      const expected: bigint[] = [];
      for (const res of ["a", "b", "c"]) {
        const reply = await cluster.relationships.writeRelationships({
          updates: [touch(res, "alice")],
        });
        expected.push(await revisionOf(cluster, reply.writtenAtToken));
      }

      const changes: RevisionChange[] = [];
      try {
        for await (const change of ds.watch(
          preWrite,
          { content: WatchContent.relationships },
          controller.signal,
        )) {
          changes.push(change);
          if (changes.length >= 3) {
            controller.abort();
            break;
          }
        }
      } catch (error) {
        // Cancellation racing the final yield is fine; the assertions below are the gate. Anything
        // that is not the abort is a real fault and must still escape.
        if (!(error instanceof GrainCallAbortedError)) throw error;
      }

      expect(changes).toHaveLength(3);
      expect(
        changes.map((c) => {
          expect(c.relationshipChanges).toHaveLength(1);
          return c.relationshipChanges[0]?.relationship.reference.resource.objectId;
        }),
      ).toEqual(["a", "b", "c"]);
      expect(
        changes.map((c) => (c.revision as TimestampRevision).timestampNanosSinceEpoch),
      ).toEqual(expected);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 9. Counter guards: typed rejections and the happy path. ----

  it("Register_counter_twice_throws_the_typed_already_registered_exception", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      await cluster.relationships.registerRelationshipCounter({
        name: "viewers",
        filter: viewerFilter(),
      });

      const ex = await rejectsWith(
        cluster.relationships.registerRelationshipCounter({
          name: "viewers",
          filter: viewerFilter(),
        }),
        CounterOperationException,
      );
      expect(ex.kind).toBe("alreadyRegistered");
      expect(ex.message).toContain("viewers");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Unregister_missing_counter_throws_the_typed_not_registered_exception", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const ex = await rejectsWith(
        cluster.relationships.unregisterRelationshipCounter({ name: "missing" }),
        CounterOperationException,
      );
      expect(ex.kind).toBe("notRegistered");
      expect(ex.message).toContain("missing");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 10. Preconditions evaluate against the PRE-mutation snapshot. ----

  it("Preconditions_evaluate_before_the_commits_own_mutations", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const grain = sequencer(cluster);

      // x currently has NO viewers: a MustNotMatch(viewers-of-x) riding the very commit that
      // touches a viewer of x must SUCCEED - the precondition is evaluated before any mutation, so
      // the commit's own update cannot trip it.
      const reply = await grain.commit(
        directCommit({
          preconditions: [{ filter: fullViewerFilter("x"), mustMatch: false }],
          updates: [touch("x", "bob")],
        }),
      );
      expect(reply.failure).toBeUndefined();
      expect(reply.revision).not.toBeUndefined();
      expect(await readViewers(cluster, "x")).toHaveLength(1);

      // The inverse: a MustMatch that only the commit's OWN update would satisfy must FAIL - the
      // pre-mutation evaluation never sees the staged update, so nothing commits.
      const inverse = await grain.commit(
        directCommit({
          preconditions: [{ filter: fullViewerFilter("y"), mustMatch: true }],
          updates: [touch("y", "carol")],
        }),
      );
      expect(inverse.revision).toBeUndefined();
      expect(inverse.failure?.kind).toBe("preconditionFailed");
      expect(await readViewers(cluster, "y")).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 11. Failed commits leave the head and the log untouched. ----

  it("Failed_commits_leave_the_head_and_the_log_untouched", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const grain = sequencer(cluster);
      const headBefore = (await grain.getHead()).head;

      // A PreconditionFailed commit: rejected, and neither the head nor the log moved.
      const rejected = await grain.commit(
        directCommit({
          preconditions: [{ filter: fullViewerFilter("missing"), mustMatch: true }],
          updates: [touch("x", "bob")],
        }),
      );
      expect(rejected.failure?.kind).toBe("preconditionFailed");
      expect((await grain.getHead()).head).toBe(headBefore);
      expect((await grain.readFrom(headBefore, -1)).events).toEqual([]);

      // A HeadMoved commit (stale ExpectedHead): same guarantee.
      const stale = await grain.commit(
        directCommit({ updates: [touch("x", "bob")], expectedHead: headBefore - 1n }),
      );
      expect(stale.failure?.kind).toBe("headMoved");
      expect((await grain.getHead()).head).toBe(headBefore);
      expect((await grain.readFrom(headBefore, -1)).events).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 12. Updates stage BEFORE DeleteByFilter runs (the declared contract order). ----

  it("Updates_stage_before_the_delete_by_filter_runs", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const grain = sequencer(cluster);

      // Empty store: the commit touches a viewer of x AND deletes viewers-of-x. Contract order
      // stages the touch first, so the delete sees (and removes) it: deletedCount is 1 and the
      // final state has no viewers of x. A swapped order would delete nothing and leave the touched
      // row live.
      const reply = await grain.commit(
        directCommit({
          updates: [touch("x", "alice")],
          deleteByFilter: { filter: fullViewerFilter("x"), limit: undefined },
        }),
      );
      expect(reply.failure).toBeUndefined();
      expect(reply.revision).not.toBeUndefined();
      expect(reply.deletedCount).toBe(1n);
      expect(reply.reachedLimit).toBe(false);
      expect(await readViewers(cluster, "x")).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 13. The empty ExpectedSchemaHash is a SEED-WINDOW claim, rejected once a schema is stored. ----

  it("Empty_expected_schema_hash_is_rejected_once_a_schema_hash_exists", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const grain = sequencer(cluster);

      // Store a schema so the hash at head is non-absent (the seed window is over).
      await cluster.writeSchema(VIEWER_SCHEMA);
      const storedHash = (await cluster.datastore.headRevision()).schemaHash;
      expect(storedHash !== undefined && storedHash.length > 0).toBe(true);

      // An empty ExpectedSchemaHash claims the pre-first-schema seed window; with a real hash
      // stored it must be rejected as SchemaHashMoved with nothing applied. EMPTY, not absent - an
      // absent hash is the "no schema gate at all" case and would commit.
      const reply = await grain.commit(
        directCommit({
          schemaBytes: new TextEncoder().encode(`${VIEWER_SCHEMA}\ndefinition intruder {}`),
          expectedSchemaHash: "",
        }),
      );
      expect(reply.revision).toBeUndefined();
      expect(reply.failure?.kind).toBe("schemaHashMoved");
      expect((await cluster.datastore.headRevision()).schemaHash).toBe(storedHash);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 14. Deterministic ExpectedHead CAS (the racing case above covers the concurrent shape). ----

  it("Stale_ExpectedHead_is_rejected_as_HeadMoved_with_the_head_unchanged", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const grain = sequencer(cluster);
      const head = (await grain.getHead()).head;

      const reply = await grain.commit(
        directCommit({ updates: [touch("cas", "alice")], expectedHead: head - 1n }),
      );

      expect(reply.revision).toBeUndefined();
      expect(reply.failure?.kind).toBe("headMoved");
      expect((await grain.getHead()).head).toBe(head);
      expect(await readViewers(cluster, "cas")).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- 15. Failed commits never notify watchers; successful ones do. ----

  it("Failed_commit_never_notifies_watchers_and_a_successful_commit_does", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      const grain = sequencer(cluster);

      // Register a watcher observer exactly the way LogWatchHub does (createObjectReference +
      // subscribeWatch); the subscribe reply pins the pre-failure head.
      const watcher = new RecordingWatcher();
      const reference = cluster.grainFactory.createObjectReference<IDatastoreWatcherType>(
        IDatastoreWatcher,
        watcher,
      );
      const preFailureHead = (await grain.subscribeWatch(reference)).head;

      const rejected = await grain.commit(
        directCommit({
          preconditions: [{ filter: fullViewerFilter("missing"), mustMatch: true }],
          updates: [touch("x", "bob")],
        }),
      );
      expect(rejected.failure?.kind).toBe("preconditionFailed");

      // headAdvanced is ONE-WAY, so give the (phantom) push a short deterministic settle window and
      // require that NO notification past the pre-failure head ever arrives.
      const settleDeadline = Date.now() + 500;
      while (Date.now() < settleDeadline) {
        expect(watcher.heads().some((h) => h > preFailureHead)).toBe(false);
        await delay(25);
      }
      expect(watcher.heads().some((h) => h > preFailureHead)).toBe(false);

      // Positive control in the same registration: a successful commit DOES notify, with exactly
      // the minted revision.
      const committed = await grain.commit(directCommit({ updates: [touch("notify", "alice")] }));
      expect(committed.failure).toBeUndefined();
      const minted = committed.revision as bigint;

      const notifyDeadline = Date.now() + 10_000;
      while (!watcher.heads().includes(minted) && Date.now() < notifyDeadline) await delay(25);
      expect(watcher.heads()).toContain(minted);

      cluster.grainFactory.deleteObjectReference(reference);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Counter_register_count_unregister_happy_path", async () => {
    const cluster = await MeshTestCluster.create(VIEWER_SCHEMA);
    try {
      await cluster.relationships.registerRelationshipCounter({
        name: "viewers",
        filter: viewerFilter(),
      });
      await cluster.relationships.writeRelationships({
        updates: [touch("a", "alice"), touch("b", "bob")],
      });

      const counted = await cluster.relationships.countRelationships({ name: "viewers" });
      expect(counted.count).toBe(2n);
      expect(counted.readAtToken.length > 0).toBe(true);

      await cluster.relationships.unregisterRelationshipCounter({ name: "viewers" });

      // The unregister is live: counting again is the typed not-registered failure.
      const ex = await rejectsWith(
        cluster.relationships.countRelationships({ name: "viewers" }),
        CounterOperationException,
      );
      expect(ex.kind).toBe("notRegistered");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});

/**
 * Records every `IDatastoreWatcher.headAdvanced` and `IDatastoreWatcher.schemaAdvanced` push it
 * receives.
 *
 * The C#'s `lock (_lock)` and defensive `ToArray` copies are gone: JavaScript has one thread, so
 * the pushes and the polling assertions can never interleave mid-mutation. The accessors still
 * return copies, because the assertions read them repeatedly while pushes keep arriving.
 */
class RecordingWatcher implements IDatastoreWatcherType {
  readonly #heads: bigint[] = [];
  readonly #schemaHashes: string[] = [];

  headAdvanced(head: bigint): Promise<void> {
    this.#heads.push(head);
    return Promise.resolve();
  }

  schemaAdvanced(_schemaBytes: Uint8Array, storedHash: string): Promise<void> {
    this.#schemaHashes.push(storedHash);
    return Promise.resolve();
  }

  heads(): readonly bigint[] {
    return [...this.#heads];
  }

  schemaHashes(): readonly string[] {
    return [...this.#schemaHashes];
  }
}
