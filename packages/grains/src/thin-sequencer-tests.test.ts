import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import { loadValidationFile } from "@spacedb/conformance/validation-file-loader";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { UpdateOperation } from "@spacedb/core/relationship-update";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@spacedb/datastore/datastore-exceptions";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import type { IGraphReader } from "@spacedb/datastore/i-graph-reader";
import type { RelationshipsFilter } from "@spacedb/datastore/relationships-filter";
import type { RevisionChange } from "@spacedb/datastore/watch";
import { WatchContent } from "@spacedb/datastore/watch";
import type { GrainStorage, StateHolder } from "@thresh/core/grain-storage";
import { grainReferenceIdentity } from "@thresh/core/grain-reference";
import { JournaledGrain } from "@thresh/core/journaled-grain";
import { IManagementGrain } from "@thresh/core/management-grain";

import type { CommitPreconditionWire, CommitRequest } from "./commit-contract";
import type {
  DatastoreMetaEntry,
  KeyIndexBucketEntry,
  KeyIndexDeltaEntry,
} from "./datastore-meta-state";
import {
  DEFAULT_BUCKET_COUNT,
  KEY_INDEX_TOMBSTONE,
  datastoreMetaStateEmpty,
  keyIndexLayoutBucketOf,
} from "./datastore-meta-state";
import type { LogHeadEntry, StoredRelationshipWire } from "./datastore-dtos";
import { DatastoreGrain, datastoreGrainInternals } from "./datastore-grain";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { graphShardKeyForResource, graphShardKeyForSubject } from "./graph-shard-key";
import type { GraphShardState } from "./graph-shard-state";
import { GRAPH_SHARD_STATE_EMPTY } from "./graph-shard-state";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { IGraphShardGrain } from "./i-graph-shard-grain";
import type { LogEvent } from "./log-event";
import { MeshTestCluster } from "./mesh-test-cluster";
import type { RelationshipUpdateWire } from "./relationships-dtos";
import { shardFoldApplyEvent } from "./shard-fold";
import { ShardedGraphReader } from "./sharded-graph-reader";
import { toFullFilter, toRelationship, toWire } from "./wire-convert";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ThinSequencerTests.cs`.
 *
 * Closing gates for the THIN-SEQUENCER flush protocol (docs/graph-sharded-datastore.md section 6):
 * the `DatastoreGrain` journals only the small `DatastoreMetaState`, keeps a dirty buffer of touched
 * shard keys, and every `FLUSH_INTERVAL` (64) events writes the dirty keys' version-qualified
 * `shard/{flushVersion}/{dir}/{type}/{id}` rows, writes a `meta/{version}` row carrying the chunked
 * key-index layout, and trims the log.
 *
 * These tests pin: flush-boundary integrity (reads at head through the sharded reader AND the scan
 * seam stay exact after the buffer has been flushed and the log trimmed), the memory ceiling itself
 * (the journaled state type carries NO relationship-row collections), the clean-key relabel rule (a
 * stored row's content is complete unless an event touched its key - `shard-fold-lemma-tests`), lazy
 * row-GC (floor enforced on every serve path while stored rows compact only at their next
 * dirty+flush), the partial write base (Commit candidate-key resolution pulls in keys named only by
 * precondition filters, forward AND reverse), and recovery fidelity across a genuine deactivation
 * (head/schema/counters/rows/Watch tail all rebuilt from head+meta+shard rows+log tail).
 *
 * PORT DECISIONS.
 *
 *  1. STORAGE HANDLE. `cluster.Services.GetRequiredKeyedService<IGrainStorage>("datastore")` has no
 *     counterpart: Thresh has no keyed DI and the ported wiring passes the provider in as
 *     `SpiceportGrainServicesOptions.datastoreStorage`. `MeshTestCluster` now exposes the ONE shared
 *     provider it constructs as {@link MeshTestCluster.datastoreStorage} (its port decision 10), so
 *     these gates read the rows the grain actually wrote rather than a test-owned duplicate store
 *     that would grade nothing. `IGrainStorage.ReadStateAsync(name, id, entry)` ->
 *     `GrainStorage.read(name, id, holder)`, `GrainState<T>.RecordExists`/`.State` -> the
 *     `StateHolder<T>`'s `exists`/`value`.
 *  2. `((GrainReference)grain).GrainId` -> `grainReferenceIdentity(grain).grainId`, Thresh's
 *     reference-identity accessor - the same substitution `datastore-interleaved-read-tests` makes.
 *     The state NAMES are storage-visible strings and are transcribed verbatim: `head`,
 *     `meta/{version}`, `log/{version}`, `indexb/{version}/{dir}/{bucket}`, `indexd/{version}`.
 *  3. `ForceActivationCollection(TimeSpan.Zero)` + `GetDetailedGrainStatistics()` -> Thresh's
 *     `IManagementGrain` at the integer key `0n`. The "the sequencer activation is really gone"
 *     assertion stays a CASE-INSENSITIVE SUBSTRING on the registered grain-type name, but the
 *     literal shortens from `"datastoregrain"` to {@link SEQUENCER_GRAIN_TYPE_MATCH}: Thresh
 *     registers a grain under its class name MINUS the `Grain` suffix, so the C#'s spelling would
 *     never hit and the control would pass vacuously - exactly the failure `cold-start-tests`
 *     records for `graphshardgrain`.
 *  4. `DatastoreGrain.CreationBucketCount` (a mutable static the C# overrides and restores in a
 *     `finally`) -> the {@link datastoreGrainInternals} holder, overridden and restored in the same
 *     `finally`. An ES module binding cannot be reassigned from outside, hence the holder; the
 *     restore is what keeps the override from leaking into the neighbouring cases.
 *  5. THE REFLECTION TRIPWIRE IS RE-EXPRESSED STRUCTURALLY - see the comment on
 *     `Journaled_state_carries_no_relationship_rows_anywhere_in_its_shape`. TypeScript erases types,
 *     so there is no type graph to walk; the claim is re-made over VALUES.
 *  6. Caveat-context assertions become plain `ReadonlyMap` lookups (`'eu'`, `7`) rather than
 *     `JsonElement.GetRawText()` strings: the port carries caveat context as a
 *     `ReadonlyMap<string, unknown>` of decoded JSON values, so there is no raw text to compare.
 *     `Expiry` stays a FIXED instant, transcribed as its epoch-nanos `bigint` (the representation
 *     `Relationship.optionalExpiration` chose), and must survive recovery byte-exact.
 *  7. `await using var cluster` -> an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  8. Protocol constants are transcribed, never rounded: FlushInterval 64, the 67-/130-commit loops,
 *     the two flush boundaries (64 and 128) that leave the chunked key index genuinely
 *     MID-ROTATION, and the three-boundary full rotation at B=2.
 */

const requireFromHere = createRequire(import.meta.url);

/** The conformance corpus directory - the C#'s linked `TestData` output folder. */
const CORPUS_DIR = resolvePath(
  dirname(requireFromHere.resolve("@spacedb/conformance/validation-file-loader")),
  "..",
  "corpus",
);

/**
 * The case-insensitive grain-type substring the "the sequencer activation is really gone" controls
 * match on - see port decision 3.
 */
const SEQUENCER_GRAIN_TYPE_MATCH = "datastore";

const SCHEMA = `definition user {}

caveat is_active(level int) {
  level > 0
}

definition doc {
  relation viewer: user | user with is_active
}`;

function row(docId: string, userId: string): Relationship {
  const resource: ObjectAndRelation = { objectType: "doc", objectId: docId, relation: "viewer" };
  const subject: ObjectAndRelation = { objectType: "user", objectId: userId, relation: ELLIPSIS };
  return createRelationship(resource, subject);
}

function write(
  ds: IDatastore,
  rel: Relationship,
  operation: UpdateOperation = "create",
): Promise<IRevision> {
  return ds.readWriteTx((tx) => tx.writeRelationships([{ relationship: rel, operation }]));
}

function sequencer(cluster: MeshTestCluster): IDatastoreGrain {
  return cluster.grainFactory.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
}

function nanos(revision: IRevision): bigint {
  return (revision as TimestampRevision).timestampNanosSinceEpoch;
}

async function collect(source: AsyncIterable<Relationship>): Promise<string[]> {
  const rows: string[] = [];
  for await (const rel of source) rows.push(canonical(rel));
  // `List<string>.Sort(StringComparer.Ordinal)`: the JS default comparator is UTF-16 code-unit
  // order, which IS ordinal.
  rows.sort();
  return rows;
}

function canonical(rel: Relationship): string {
  const resource = rel.reference.resource;
  const subject = rel.reference.subject;
  return (
    `${resource.objectType}:${resource.objectId}#${resource.relation}` +
    `@${subject.objectType}:${subject.objectId}#${subject.relation}`
  );
}

/** Reads one raw storage row of the sequencer through the SAME provider the grain uses. */
async function readRow<T>(cluster: MeshTestCluster, stateName: string): Promise<StateHolder<T>> {
  const storage: GrainStorage = cluster.datastoreStorage;
  const identity = grainReferenceIdentity(sequencer(cluster));
  expect(identity, "the sequencer reference carries no grain identity").toBeDefined();
  const entry: StateHolder<T> = { value: undefined as unknown as T, exists: false };
  await storage.read(stateName, identity!.grainId, entry);
  return entry;
}

/** Drops every activation in the cluster and proves the sequencer's is really gone. */
async function forceCollectAllActivations(cluster: MeshTestCluster): Promise<void> {
  const management = cluster.grainFactory.getGrain(IManagementGrain, 0n);
  await management.forceActivationCollection({ ms: 0 });
  const stats = await management.getDetailedGrainStatistics();
  const survivors = stats.filter((s) =>
    s.grainType.toLowerCase().includes(SEQUENCER_GRAIN_TYPE_MATCH),
  );
  expect(
    survivors.map((s) => s.grainType),
    "the sequencer activation survived the forced collection",
  ).toEqual([]);
}

/** The single live subject id of a shard state (the C#'s local `LiveSubject`). */
function liveSubject(shard: GraphShardState): string {
  const live = shard.rows.filter((r) => r.deletedRevision === undefined);
  expect(live).toHaveLength(1);
  return live[0]!.relationship.subjectId;
}

describe("ThinSequencerTests", () => {
  // ---- (a) Flush-boundary integrity: dirty-buffer flush + log trim + meta write. ----

  /**
   * More than `FLUSH_INTERVAL` (64) commits across several keys - creates, a delete, a touch, and a
   * post-flush key - then, WITHOUT any restart, reads at head through BOTH the shard mesh
   * (`ShardedGraphReader`) and the scan seam (`ISnapshotScanner`) must equal the
   * independently-tracked expectation. The storage-level probes then pin that the flush protocol
   * actually ran: the head row's `snapshotVersion` sits on the 64-boundary, the `meta/{version}` row
   * exists, the seed `meta/0` row and every log entry at or below the flush boundary are trimmed,
   * and the post-flush log tail is still present.
   */
  it("Reads_stay_exact_after_the_dirty_buffer_flush_trims_the_log", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      const ds = cluster.datastore;

      // The live-set model the reads must reproduce, keyed by resource id.
      const expected = new Map<string, Set<string>>();
      const add = (res: string, subj: string): void => {
        let set = expected.get(res);
        if (set === undefined) {
          set = new Set<string>();
          expected.set(res, set);
        }
        set.add(subj);
      };

      // 67 creates across five keys (commits 1..67) - comfortably past the 64-event flush boundary.
      for (let i = 0; i < 67; i += 1) {
        const res = `k${i % 5}`;
        const subj = `u${i}`;
        await write(ds, row(res, subj));
        add(res, subj);
      }

      // Commit 68: delete a PRE-flush row (its tombstone must land on the already-flushed key).
      await write(ds, row("k0", "u0"), "delete");
      expected.get("k0")!.delete("u0");

      // Commit 69: touch an existing pre-flush row (replace-in-place; the live set is unchanged).
      await write(ds, row("k1", "u1"), "touch");

      // Commit 70: a key that never existed before the flush (dirty-buffer-only at read time).
      await write(ds, row("k9", "fresh"));
      add("k9", "fresh");

      const head = (await ds.headRevision()).revision;

      // Scan seam: the whole live set in one broad scan.
      const scanner = cluster.services.snapshotScanner;
      const expectedAll = [...expected]
        .flatMap(([res, subjects]) => [...subjects].map((subj) => canonical(row(res, subj))))
        .sort();
      const scanned = await collect(scanner.scan({ optionalResourceType: "doc" }, head));
      expect(scanned).toEqual(expectedAll);

      // Shard mesh: per-key forward reads, plus reverse probes for the deleted/touched/fresh
      // subjects.
      const sharded: IGraphReader = new ShardedGraphReader(cluster.grainFactory, nanos(head));
      for (const [res, subjects] of expected) {
        const viaShard = await collect(
          sharded.queryRelationships({
            optionalResourceType: "doc",
            optionalResourceIds: [res],
          }),
        );
        expect(viaShard).toEqual([...subjects].map((s) => canonical(row(res, s))).sort());
      }
      expect(
        await collect(
          sharded.reverseQueryRelationships({ subjectType: "user", optionalSubjectIds: ["u0"] }),
        ),
      ).toEqual([]);
      expect(
        await collect(
          sharded.reverseQueryRelationships({ subjectType: "user", optionalSubjectIds: ["u1"] }),
        ),
      ).toEqual([canonical(row("k1", "u1"))]);
      expect(
        await collect(
          sharded.reverseQueryRelationships({ subjectType: "user", optionalSubjectIds: ["fresh"] }),
        ),
      ).toEqual([canonical(row("k9", "fresh"))]);

      // Storage-level: the flush protocol really ran. 70 commits => logVersion 70, flush boundary
      // 64.
      const headRow = await readRow<LogHeadEntry>(cluster, "head");
      expect(headRow.exists).toBe(true);
      const logVersion = headRow.value.logVersion;
      const flushVersion = headRow.value.snapshotVersion;
      expect(
        logVersion >= 70,
        `expected at least the 70 test commits, saw logVersion ${logVersion}`,
      ).toBe(true);
      // The meta row is the latest 64-boundary.
      expect(flushVersion).toBe(logVersion - (logVersion % 64));
      expect(flushVersion >= 64, "no flush happened - the gate exercised nothing").toBe(true);

      const metaRow = await readRow<DatastoreMetaEntry>(cluster, `meta/${flushVersion}`);
      expect(metaRow.exists, "the flush's meta/{version} row is missing").toBe(true);
      expect(metaRow.value.flushedThroughLogVersion).toBe(flushVersion);

      // Durable layout v2 (docs/scalability-program.md 3.4): the meta row is SLIM - no inline key
      // maps (the cardinality-independence tripwire) - and carries the chunked-index layout; the
      // flush wrote its delta row and rotated bucket 0 in both directions (the rotation cursor
      // starts at 0, and this store has seen exactly one flush).
      expect(metaRow.value.indexLayout).toBeDefined();
      expect([...metaRow.value.meta.forwardKeys]).toEqual([]);
      expect([...metaRow.value.meta.reverseKeys]).toEqual([]);
      expect(metaRow.value.indexLayout!.bucketCount).toBe(DEFAULT_BUCKET_COUNT);
      expect(metaRow.value.indexLayout!.deltaVersions).toContain(flushVersion);
      const deltaRow = await readRow<KeyIndexDeltaEntry>(cluster, `indexd/${flushVersion}`);
      expect(deltaRow.exists, "the flush's indexd/{version} delta row is missing").toBe(true);
      // Every key flushed in the window rides the delta at the flush version (k0..k4 were all
      // dirty).
      const k0Forward = graphShardGrainKeyBuild(graphShardKeyForResource("doc", "k0"));
      expect(deltaRow.value.forwardEntries.get(k0Forward)).toBe(flushVersion);
      expect(
        (await readRow<KeyIndexBucketEntry>(cluster, `indexb/${flushVersion}/f/0`)).exists,
        "the rotated forward bucket row is missing",
      ).toBe(true);
      expect(
        (await readRow<KeyIndexBucketEntry>(cluster, `indexb/${flushVersion}/r/0`)).exists,
        "the rotated reverse bucket row is missing",
      ).toBe(true);

      // Log trim: entries at or below the boundary cleared; the post-flush tail retained; the seed
      // meta/0 row cleared once superseded.
      expect((await readRow<LogEvent>(cluster, "log/1")).exists, "log/1 survived compaction").toBe(
        false,
      );
      expect(
        (await readRow<LogEvent>(cluster, `log/${flushVersion}`)).exists,
        "the flush-boundary log entry survived compaction",
      ).toBe(false);
      expect(
        (await readRow<LogEvent>(cluster, `log/${flushVersion + 1}`)).exists,
        "the first post-flush log entry is missing - the tail was over-trimmed",
      ).toBe(true);
      expect(
        (await readRow<DatastoreMetaEntry>(cluster, "meta/0")).exists,
        "meta/0 survived compaction",
      ).toBe(false);
    } finally {
      await cluster.dispose();
    }
  }, 300_000);

  /**
   * The TOMBSTONE path of the chunked key index (durable layout v2): a key whose shard state EMPTIES
   * at a flush (its rows GC-collected) is dropped from the index with an explicit tombstone entry in
   * that flush's `indexd/{version}` delta row - and a recovery that reconstructs the index must
   * REPLAY that tombstone, or the dropped key would resurrect from the earlier delta that added it.
   * The probed keys are chosen so their buckets are NOT among the ones the two flushes rotate
   * (buckets 0 and 1), making the delta overlay the ONLY durable carrier of both the key's addition
   * and its removal - the reconstruction path this test pins deterministically.
   */
  it("Key_removed_at_flush_disappears_from_the_index_after_recovery_replays_its_tombstone_delta", async () => {
    // Window=Zero lets runGc advance the floor to the current head, so dead rows below it are
    // physically collected at the key's next flush - the only way a key's shard state empties.
    const cluster = await MeshTestCluster.create(SCHEMA, { gcWindow: { ms: 0 } });
    try {
      const ds = cluster.datastore;
      const grain = sequencer(cluster);

      const bucket = (key: string): number => keyIndexLayoutBucketOf(key, DEFAULT_BUCKET_COUNT);
      const findId = (prefix: string, keyOf: (id: string) => string): string => {
        for (let i = 0; i < 10_000; i += 1) {
          const id = `${prefix}${i}`;
          if (bucket(keyOf(id)) > 1) return id;
        }
        throw new Error(`no ${prefix} id lands outside the rotated buckets`);
      };
      const goneId = findId("gone", (id) =>
        graphShardGrainKeyBuild(graphShardKeyForResource("doc", id)),
      );
      const victimId = findId("victim", (id) =>
        graphShardGrainKeyBuild(graphShardKeyForSubject("user", id)),
      );
      const goneForwardKey = graphShardGrainKeyBuild(graphShardKeyForResource("doc", goneId));
      const victimReverseKey = graphShardGrainKeyBuild(graphShardKeyForSubject("user", victimId));

      // Commits 1-2: create and delete a first row on the key, then 62 fillers cross the first flush
      // boundary (64): the key's row (a retained tombstoned MVCC row - the floor is still 0) becomes
      // durable and the key enters the durable index ONLY via delta 64 (its bucket is never
      // rotated).
      await write(ds, row(goneId, "seed"));
      await write(ds, row(goneId, "seed"), "delete");
      for (let i = 0; i < 62; i += 1) await write(ds, row(`tf${i}`, "filler"));

      // Commits 65-66 re-dirty the key (create+delete the probed victim subject), then a GC puts the
      // floor above every delete: at the SECOND flush the key's collected state is EMPTY, so the
      // flush drops it from the index and records tombstones in delta 128 - for the forward key AND
      // the victim's reverse key (also dirtied to empty in this window, also in an unrotated
      // bucket).
      await write(ds, row(goneId, victimId));
      await write(ds, row(goneId, victimId), "delete");
      expect(await grain.runGc()).toBeDefined();
      for (let i = 0; i < 61; i += 1) await write(ds, row(`tg${i}`, "filler"));

      // The second flush really ran and its delta carries the explicit tombstones.
      const headRow = await readRow<LogHeadEntry>(cluster, "head");
      expect(headRow.exists).toBe(true);
      const flushVersion = headRow.value.snapshotVersion;
      expect(
        flushVersion >= 128,
        `expected the second flush boundary, saw snapshotVersion ${flushVersion}`,
      ).toBe(true);
      const deltaRow = await readRow<KeyIndexDeltaEntry>(cluster, `indexd/${flushVersion}`);
      expect(deltaRow.exists, "the second flush's delta row is missing").toBe(true);
      expect(deltaRow.value.forwardEntries.get(goneForwardKey)).toBe(KEY_INDEX_TOMBSTONE);
      expect(deltaRow.value.reverseEntries.get(victimReverseKey)).toBe(KEY_INDEX_TOMBSTONE);

      const headBefore = await grain.getHead();

      // Drop every activation so recovery reconstructs the index from bucket rows + deltas.
      await forceCollectAllActivations(cluster);

      // Negative control (lost state re-seeds a different head), then the tombstone's observable:
      // the removed key resolves to EMPTY through the reconstructed index - forward and reverse.
      const headAfter = await grain.getHead();
      expect(headAfter.head).toBe(headBefore.head);
      expect((await grain.readShard(graphShardKeyForResource("doc", goneId))).rows).toEqual([]);
      expect((await grain.readShard(graphShardKeyForSubject("user", victimId))).rows).toEqual([]);
      const sharded: IGraphReader = new ShardedGraphReader(cluster.grainFactory, headAfter.head);
      expect(
        await collect(
          sharded.queryRelationships({
            optionalResourceType: "doc",
            optionalResourceIds: [goneId],
          }),
        ),
      ).toEqual([]);
      expect(
        await collect(
          sharded.reverseQueryRelationships({
            subjectType: "user",
            optionalSubjectIds: [victimId],
          }),
        ),
      ).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 300_000);

  /**
   * The REPLAY-ORDER discriminator for the pending-delta overlay: a key is deleted so flush A
   * records its TOMBSTONE in delta A, then RECREATED so flush B records a LIVE entry in delta B -
   * and after recovery the key must be SERVED at head. Ascending replay applies the tombstone first
   * and the live entry last (correct); a descending or otherwise disordered replay would apply the
   * tombstone LAST and visibly lose the recreated key. The key's bucket is chosen provably UNROTATED
   * across both flushes (only buckets 0 and 1 are rotated), so the two delta rows are the only
   * durable carriers of both facts - the ordering is the whole story.
   */
  it("Recreated_key_survives_recovery_because_delta_replay_is_ascending", async () => {
    // Window=Zero lets runGc put the floor at head, so the pre-flush delete's rows physically
    // collect at flush A and the key's state EMPTIES there (the tombstone-producing condition).
    const cluster = await MeshTestCluster.create(SCHEMA, { gcWindow: { ms: 0 } });
    try {
      const ds = cluster.datastore;
      const grain = sequencer(cluster);

      const bucket = (key: string): number => keyIndexLayoutBucketOf(key, DEFAULT_BUCKET_COUNT);
      let phoenixId: string | undefined;
      for (let i = 0; i < 10_000 && phoenixId === undefined; i += 1) {
        const id = `phoenix${i}`;
        if (bucket(graphShardGrainKeyBuild(graphShardKeyForResource("doc", id))) > 1)
          phoenixId = id;
      }
      expect(phoenixId, "no phoenix id lands outside the rotated buckets").toBeDefined();
      const phoenixForwardKey = graphShardGrainKeyBuild(
        graphShardKeyForResource("doc", phoenixId!),
      );

      // Window 1 (commits 1..64): create + delete the key, GC the floor past the delete, fill to the
      // boundary. Flush A (version 64) collects the key to empty and tombstones it in delta 64.
      await write(ds, row(phoenixId!, "seed"));
      await write(ds, row(phoenixId!, "seed"), "delete");
      expect(await grain.runGc()).toBeDefined();
      for (let i = 0; i < 61; i += 1) await write(ds, row(`ra${i}`, "filler"));

      // Window 2 (commits 65..128): RECREATE the key, fill to the next boundary. Flush B (version
      // 128) records the live entry in delta 128.
      await write(ds, row(phoenixId!, "back"));
      for (let i = 0; i < 63; i += 1) await write(ds, row(`rb${i}`, "filler"));

      // Both flushes ran, and the two deltas carry tombstone-then-live for the SAME key.
      const headRow = await readRow<LogHeadEntry>(cluster, "head");
      expect(headRow.exists).toBe(true);
      expect(headRow.value.snapshotVersion).toBe(128);
      const deltaA = await readRow<KeyIndexDeltaEntry>(cluster, "indexd/64");
      expect(deltaA.exists, "flush A's delta row is missing").toBe(true);
      expect(deltaA.value.forwardEntries.get(phoenixForwardKey)).toBe(KEY_INDEX_TOMBSTONE);
      const deltaB = await readRow<KeyIndexDeltaEntry>(cluster, "indexd/128");
      expect(deltaB.exists, "flush B's delta row is missing").toBe(true);
      expect(deltaB.value.forwardEntries.get(phoenixForwardKey)).toBe(128);

      const headBefore = await grain.getHead();

      // Drop every activation so recovery reconstructs the index from bucket rows + delta overlay.
      await forceCollectAllActivations(cluster);

      // The recreated key is SERVED at head: delta 128's live entry was applied after delta 64's
      // tombstone. Descending replay would resolve the key to empty here.
      const headAfter = await grain.getHead();
      expect(headAfter.head).toBe(headBefore.head);
      const shard = await grain.readShard(graphShardKeyForResource("doc", phoenixId!));
      expect(liveSubject(shard)).toBe("back");
      const sharded: IGraphReader = new ShardedGraphReader(cluster.grainFactory, headAfter.head);
      expect(
        await collect(
          sharded.queryRelationships({
            optionalResourceType: "doc",
            optionalResourceIds: [phoenixId!],
          }),
        ),
      ).toEqual([canonical(row(phoenixId!, "back"))]);
    } finally {
      await cluster.dispose();
    }
  }, 300_000);

  /**
   * Delta PRUNING made test-reachable: with the creation bucket count lowered to 2 (the count is
   * stored in the layout, so this store honors B=2 for its whole life; changing it for an existing
   * store is forbidden), three flush boundaries drive the rotation over every bucket twice -
   * `deltaFloorVersion` advances (the MIN over both directions' bucket versions) and the deltas at
   * or below it are pruned from the layout and cleared from storage. Pins, across a genuine
   * deactivation: a key tombstoned in a since-PRUNED delta stays gone (its absence carried by the
   * post-tombstone bucket rows alone), a key whose index entry survives ONLY via bucket rows (its
   * delta pruned) is still served, and keys from every window survive. A Max-instead-of-Min floor or
   * an over-eager prune loses one of these observably - this is the only test path that reaches the
   * floor computation at all.
   */
  it("Full_rotation_prunes_deltas_and_recovery_still_serves_exactly", async () => {
    const originalBucketCount = datastoreGrainInternals.creationBucketCount;
    datastoreGrainInternals.creationBucketCount = 2;
    try {
      const cluster = await MeshTestCluster.create(SCHEMA, { gcWindow: { ms: 0 } });
      try {
        const ds = cluster.datastore;
        const grain = sequencer(cluster);

        // Window 1 (commits 1..64): a key that tombstones at the first flush (create + delete below
        // the GC floor), a keeper whose only index carriers after pruning are bucket rows, the GC,
        // and fillers to the boundary. Flush 64 rewrites bucket 0.
        await write(ds, row("gone", "seed"));
        await write(ds, row("gone", "seed"), "delete");
        await write(ds, row("keeper", "keep"));
        expect(await grain.runGc()).toBeDefined();
        for (let i = 0; i < 60; i += 1) await write(ds, row(`w1-${i}`, "filler"));

        // Windows 2 and 3 (commits 65..192): flush 128 rewrites bucket 1 - the rotation is FULL, the
        // floor advances to min(64, 128) = 64 and delta 64 is pruned. Flush 192 rewrites bucket 0
        // again - floor min(192, 128) = 128, delta 128 pruned.
        for (let i = 0; i < 64; i += 1) await write(ds, row(`w2-${i}`, "filler"));
        for (let i = 0; i < 64; i += 1) await write(ds, row(`w3-${i}`, "filler"));

        // Storage-level: the layout really rotated fully and pruned both early deltas.
        const headRow = await readRow<LogHeadEntry>(cluster, "head");
        expect(headRow.exists).toBe(true);
        expect(headRow.value.snapshotVersion).toBe(192);
        const metaRow = await readRow<DatastoreMetaEntry>(cluster, "meta/192");
        expect(metaRow.exists, "the third flush's meta row is missing").toBe(true);
        const layout = metaRow.value.indexLayout;
        expect(layout).toBeDefined();
        expect(layout!.bucketCount).toBe(2);
        expect(layout!.deltaFloorVersion).toBe(128);
        expect([...layout!.deltaVersions]).toEqual([192]);
        expect(
          (await readRow<KeyIndexDeltaEntry>(cluster, "indexd/64")).exists,
          "delta 64 survived pruning",
        ).toBe(false);
        expect(
          (await readRow<KeyIndexDeltaEntry>(cluster, "indexd/128")).exists,
          "delta 128 survived pruning",
        ).toBe(false);

        const headBefore = await grain.getHead();

        // Deactivate + reactivate: recovery must reconstruct the index from the two bucket rows
        // (versions 192 and 128) plus the single pending delta 192 - deltas 64/128 are gone.
        await forceCollectAllActivations(cluster);

        const headAfter = await grain.getHead();
        expect(headAfter.head).toBe(headBefore.head);

        // The key tombstoned in the pruned delta stays gone; the bucket-carried keys - one per
        // window - are all still served.
        expect((await grain.readShard(graphShardKeyForResource("doc", "gone"))).rows).toEqual([]);
        expect(liveSubject(await grain.readShard(graphShardKeyForResource("doc", "keeper")))).toBe(
          "keep",
        );
        expect(liveSubject(await grain.readShard(graphShardKeyForResource("doc", "w1-0")))).toBe(
          "filler",
        );
        expect(liveSubject(await grain.readShard(graphShardKeyForResource("doc", "w2-0")))).toBe(
          "filler",
        );
        expect(liveSubject(await grain.readShard(graphShardKeyForResource("doc", "w3-0")))).toBe(
          "filler",
        );
      } finally {
        await cluster.dispose();
      }
    } finally {
      datastoreGrainInternals.creationBucketCount = originalBucketCount;
    }
  }, 300_000);

  // ---- (b) The memory ceiling: no relationship rows in the journaled state; the relabel rule. ----

  /**
   * The tripwire for the ceiling this rework removed: the sequencer's journaled state must be the
   * slim `DatastoreMetaState` and must not reach - anywhere in its shape - a
   * `StoredRelationshipWire` or any collection of them. A regression that re-materializes the whole
   * fold in grain state cannot pass.
   *
   * HOW THE CLAIM IS RE-EXPRESSED (port decision 5). The C# walks the TYPE GRAPH by reflection:
   * locate `JournaledGrain<TState, TEvent>` in `DatastoreGrain`'s base chain, take `TState`, then
   * transitively enqueue every public property type, every private instance field type and every
   * generic argument, tripping on `StoredRelationshipWire` or an `IEnumerable<StoredRelationshipWire>`.
   * TypeScript erases all of that - there is no `TState` at runtime and no field types to reflect
   * over - so the same claim is made STRUCTURALLY, over VALUES, in three parts:
   *
   *  1. The base-chain locate becomes an `instanceof JournaledGrain` check on a constructed
   *     `DatastoreGrain`, plus the two members that Thresh's journaling substrate uses in place of
   *     `TState`: `initialState()` and `transitionState(state, event)`, both pure and both callable
   *     without a runtime.
   *  2. `Assert.Equal(typeof(DatastoreMetaHolder), stateType)` becomes an EXACT key-set assertion on
   *     the state `initialState()` returns: the six `DatastoreMetaState` members and nothing else. A
   *     regression that adds a rows collection to the journaled state adds a key here, which fails
   *     before any walk runs - this is the part that catches a field whose value happens to be
   *     empty.
   *  3. The transitive walk becomes a deep walk of a REAL folded state: fold a create event, a
   *     delete event and a GC event through `transitionState`, then walk every reachable value
   *     (objects, arrays, Map keys and values) asserting that nothing STORED-RELATIONSHIP-SHAPED is
   *     reachable. "Shaped" is decided structurally by {@link isStoredRelationshipShaped}, because
   *     an erased type cannot be compared by identity. Folding real relationship events is what
   *     makes the walk non-vacuous: a regression that re-materializes rows puts them here.
   */
  it("Journaled_state_carries_no_relationship_rows_anywhere_in_its_shape", () => {
    const grain = new DatastoreGrain();

    // (1) The journaled-grain base chain and the two members standing in for `TState`.
    expect(grain).toBeInstanceOf(JournaledGrain);
    expect(typeof grain.initialState).toBe("function");
    expect(typeof grain.transitionState).toBe("function");

    // (2) The state IS the slim meta state: exactly its six members, no more.
    const initial = grain.initialState();
    const metaKeys = Object.keys(datastoreMetaStateEmpty(0n)).sort();
    expect(metaKeys).toEqual([
      "counters",
      "forwardKeys",
      "gcFloor",
      "headRevision",
      "reverseKeys",
      "schemas",
    ]);
    expect(Object.keys(initial).sort()).toEqual(metaKeys);

    // (3) The transitive walk, over a state folded from REAL relationship events.
    const event = (
      revision: bigint,
      changes: readonly RelationshipUpdateWire[],
      gcFloor?: bigint,
    ): LogEvent => ({
      revision,
      relationshipChanges: changes,
      schemaChange: undefined,
      counterChanges: [],
      gcFloor,
    });
    let folded = initial;
    folded = grain.transitionState(
      folded,
      event(10n, [{ operation: "touch", relationship: toWire(row("d1", "alice")) }]),
    );
    folded = grain.transitionState(
      folded,
      event(20n, [{ operation: "touch", relationship: toWire(row("d2", "bob")) }]),
    );
    folded = grain.transitionState(
      folded,
      event(30n, [{ operation: "delete", relationship: toWire(row("d1", "alice")) }]),
    );
    folded = grain.transitionState(folded, event(40n, [], 15n));

    // The fold really did something - a vacuous walk grades nothing.
    expect(folded.headRevision).toBe(40n);
    expect(folded.forwardKeys.size).toBeGreaterThan(0);
    expect(folded.reverseKeys.size).toBeGreaterThan(0);

    for (const { value, path } of reachableValues(folded)) {
      expect(
        isStoredRelationshipShaped(value),
        `the journaled state reaches a stored relationship row (via ${path})`,
      ).toBe(false);
      expect(
        Array.isArray(value) && value.some((v) => isStoredRelationshipShaped(v)),
        `the journaled state reaches a collection of stored relationship rows (via ${path})`,
      ).toBe(false);
    }
  });

  /**
   * The behavioral half of the memory bound - the CLEAN-KEY RELABEL RULE the whole design rests on
   * (pinned as a fold lemma by `shard-fold-lemma-tests`, here proven live): seed a real corpus file,
   * push the sequencer across a flush boundary with commits that never touch the probed resource's
   * forward key, keep committing past the flush - and `readShard` for that clean key must answer
   * with `appliedRevision === the CURRENT head` (its stored row relabeled, no per-key tail replay)
   * while its rows still exactly match the snapshot reader.
   */
  it("Clean_key_ReadShard_serves_its_stored_row_relabeled_to_the_current_head", async () => {
    const path = join(CORPUS_DIR, "multipleops.yaml");
    const file = loadValidationFile(path);
    expect(file.relationships.length).toBeGreaterThan(0);

    const cluster = await MeshTestCluster.create(file.schemaText);
    try {
      const updates = file.relationships.map((relationship) => ({
        relationship,
        operation: "create" as const,
      }));
      await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(updates));

      const probe = file.relationships[0]!;
      const probeResource = probe.reference.resource;

      // 64 filler commits cross the flush boundary (clearing the dirty buffer), then 3 more advance
      // the head PAST the flush revision - so at read time the probed key's stored row is stamped
      // strictly below head and only the relabel rule can make the reply's watermark reach it. The
      // fillers reuse the corpus's own resource type/relation/subject (schema-valid) under fresh
      // resource ids, so the probed FORWARD key is never touched again after the seed commit.
      for (let i = 0; i < 67; i += 1) {
        const filler = createRelationship(
          { ...probeResource, objectId: `thin-seq-filler-${i}` },
          probe.reference.subject,
        );
        await write(cluster.datastore, filler);
      }

      const head = await sequencer(cluster).getHead();
      const shard = await sequencer(cluster).readShard(
        graphShardKeyForResource(probeResource.objectType, probeResource.objectId),
      );

      expect(shard.appliedRevision).toBe(head.head); // the relabel rule, live
      expect(shard.gcFloor).toBe(head.gcFloor);

      // And the relabeled content is exact: it equals the snapshot reader's rows for the same key.
      const viaReader = await collect(
        cluster.datastore.snapshotReader(new TimestampRevision(head.head)).queryRelationships({
          optionalResourceType: probeResource.objectType,
          optionalResourceIds: [probeResource.objectId],
        }),
      );
      const viaShard = shard.rows
        .filter((r) => r.deletedRevision === undefined)
        .map((r) => canonical(toRelationship(r.relationship)))
        .sort();
      expect(viaReader.length).toBeGreaterThan(0);
      expect(viaShard).toEqual(viaReader);
    } finally {
      await cluster.dispose();
    }
  }, 300_000);

  // ---- (c) Lazy row-GC: floor on every serve path; physical compaction at the next dirty+flush. --

  /**
   * Lazy-GC correctness end to end. A key ("cold") accumulates a dead row, is flushed (so its stored
   * row physically retains the tombstone), and is never re-dirtied while a GC advances the floor
   * past the tombstone: the CLEAN key must still serve exactly right at head (the serve-path
   * `collectBelow` hides the lazily-retained dead row) and a below-floor pin must be rejected. The
   * key is then re-dirtied and pushed through another flush (which physically compacts its row), the
   * whole cluster's activations are dropped, and the reactivated sequencer - now recovering over the
   * compacted row - must still serve the same answers and still reject the below-floor pin
   * (compaction itself is internal; the restart makes its correctness observable).
   */
  it("Lazy_gc_serves_clean_keys_exactly_and_compaction_survives_recovery", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA, { gcWindow: { ms: 0 } });
    try {
      const ds = cluster.datastore;
      const grain = sequencer(cluster);

      const rev1 = await ds.readWriteTx((tx) =>
        tx.writeRelationships([
          { relationship: row("cold", "carol"), operation: "create" },
          { relationship: row("cold", "dead"), operation: "create" },
          { relationship: row("x", "alice"), operation: "create" },
        ]),
      );
      await write(ds, row("cold", "dead"), "delete");

      // Cross the flush boundary on OTHER keys: "cold"'s stored row (carol live + dead's tombstone)
      // is durable and its dirty entry cleared - from here on "cold" is the clean key under test.
      for (let i = 0; i < 64; i += 1) await write(ds, row(`f${i}`, "filler"));

      // Dirty a DIFFERENT key, then GC: Window=Zero makes the floor land at the current head, past
      // the tombstone - but "cold" is never dirtied, so its stored row keeps the dead row lazily.
      await write(ds, row("x", "alice"), "delete");
      const floor = await grain.runGc();
      expect(floor).toBeDefined();
      expect(floor! > nanos(rev1)).toBe(true);

      // The clean key serves exactly at head: the serve path re-applies the floor, so the lazily
      // retained dead row is invisible, and the reply is relabeled to the current head.
      const head = await grain.getHead();
      const shard = await grain.readShard(graphShardKeyForResource("doc", "cold"));
      expect(shard.appliedRevision).toBe(head.head);
      expect(shard.rows).toHaveLength(1);
      expect(shard.rows[0]!.relationship.subjectId).toBe("carol");

      // Below-floor pins are rejected outright - through the snapshot reader AND the shard mesh.
      await expect(
        (async () => {
          for await (const _ of ds.snapshotReader(rev1).queryRelationships({})) {
            // drain
          }
        })(),
      ).rejects.toThrow(RevisionNotFoundException);
      const coldShardGrain = cluster.grainFactory.getGrain(
        IGraphShardGrain,
        graphShardGrainKeyBuild(graphShardKeyForResource("doc", "cold")),
      );
      await expect(coldShardGrain.rowsAt(nanos(rev1), undefined)).rejects.toThrow(
        RevisionNotFoundException,
      );

      // Re-dirty "cold" and push another flush past it: this flush is where its stored row
      // physically compacts (the tombstone is finally dropped from storage).
      await write(ds, row("cold", "late"));
      for (let i = 0; i < 64; i += 1) await write(ds, row(`g${i}`, "filler"));
      const headBeforeRestart = await grain.getHead();

      // Drop EVERY activation (grain state survives only in the storage provider), then re-read:
      // recovery over the compacted row must serve the same answers.
      await forceCollectAllActivations(cluster);

      const headAfter = await grain.getHead();
      // Negative control: lost state re-seeds a new head.
      expect(headAfter.head).toBe(headBeforeRestart.head);

      const shardAfter = await grain.readShard(graphShardKeyForResource("doc", "cold"));
      expect(shardAfter.appliedRevision).toBe(headAfter.head);
      expect(
        shardAfter.rows
          .filter((r) => r.deletedRevision === undefined)
          .map((r) => r.relationship.subjectId)
          .sort(),
      ).toEqual(["carol", "late"]);

      const sharded: IGraphReader = new ShardedGraphReader(cluster.grainFactory, headAfter.head);
      expect(
        await collect(
          sharded.queryRelationships({
            optionalResourceType: "doc",
            optionalResourceIds: ["cold"],
          }),
        ),
      ).toEqual([canonical(row("cold", "carol")), canonical(row("cold", "late"))]);

      // The below-floor rejection also survives recovery.
      await expect(
        (async () => {
          for await (const _ of ds.snapshotReader(rev1).queryRelationships({})) {
            // drain
          }
        })(),
      ).rejects.toThrow(RevisionNotFoundException);
    } finally {
      await cluster.dispose();
    }
  }, 300_000);

  // ---- (d) Partial-base sufficiency: candidate-key resolution pulls in filter-only keys. ----

  /**
   * A declarative Commit whose precondition filter names a resource NOT otherwise touched by the
   * commit - and whose key is CLEAN (flushed to storage, not in the dirty buffer) - so the partial
   * write base is sufficient only if candidate-key resolution pulls that key in from its stored row.
   * Both outcomes are pinned: mustMatch satisfied commits the guarded update; mustMatch against a
   * missing resource rejects with `preconditionFailed` and applies nothing.
   */
  it("Commit_precondition_on_an_untouched_clean_resource_key_behaves_exactly", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      const ds = cluster.datastore;
      const grain = sequencer(cluster);

      await write(ds, row("a", "alice"));

      // Flush "a" out of the dirty buffer so the precondition can only be answered from its stored
      // shard row (the partial-base storage path, not the in-memory overlay).
      for (let i = 0; i < 64; i += 1) await write(ds, row(`pf${i}`, "filler"));

      const onA = toFullFilter({
        optionalResourceType: "doc",
        optionalResourceIds: ["a"],
      });
      const satisfied = await grain.commit(
        guarded({ filter: onA, mustMatch: true }, touchWire("b", "bob")),
      );
      expect(satisfied.failure).toBeUndefined();
      expect(satisfied.revision).toBeDefined();
      expect(await exists(ds, "b")).toBe(true);

      const onMissing = toFullFilter({
        optionalResourceType: "doc",
        optionalResourceIds: ["nonexistent"],
      });
      const violated = await grain.commit(
        guarded({ filter: onMissing, mustMatch: true }, touchWire("c", "carol")),
      );
      expect(violated.revision).toBeUndefined();
      expect(violated.failure!.kind).toBe("preconditionFailed");
      expect(await exists(ds, "c")).toBe(false); // atomic rejection: nothing applied
    } finally {
      await cluster.dispose();
    }
  }, 300_000);

  /**
   * The reverse-index candidate path: a precondition filter constraining ONLY subjects must resolve
   * its candidates through the REVERSE key index (the updated resource's forward key alone cannot
   * answer it). Satisfied (an existing subject) commits; violated (a subject that matches nothing)
   * rejects with `preconditionFailed` and applies nothing.
   */
  it("Commit_subject_only_precondition_resolves_through_the_reverse_index_both_ways", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      const ds = cluster.datastore;
      const grain = sequencer(cluster);

      await write(ds, row("a", "alice"));

      // Flush so user:alice's reverse key lives only in its stored row at commit time.
      for (let i = 0; i < 64; i += 1) await write(ds, row(`sf${i}`, "filler"));

      const subjectAlice = toFullFilter({
        optionalSubjectsSelectors: [{ optionalSubjectType: "user", optionalSubjectIds: ["alice"] }],
      });
      const satisfied = await grain.commit(
        guarded({ filter: subjectAlice, mustMatch: true }, touchWire("b", "bob")),
      );
      expect(satisfied.failure).toBeUndefined();
      expect(satisfied.revision).toBeDefined();
      expect(await exists(ds, "b")).toBe(true);

      const subjectNobody = toFullFilter({
        optionalSubjectsSelectors: [
          { optionalSubjectType: "user", optionalSubjectIds: ["nobody"] },
        ],
      });
      const violated = await grain.commit(
        guarded({ filter: subjectNobody, mustMatch: true }, touchWire("d", "dave")),
      );
      expect(violated.revision).toBeUndefined();
      expect(violated.failure!.kind).toBe("preconditionFailed");
      expect(await exists(ds, "d")).toBe(false);
    } finally {
      await cluster.dispose();
    }
  }, 300_000);

  // ---- (e) Restart fidelity across a genuine deactivation. ----

  /**
   * The recovery gate over the full mixed load: relationships (plain, caveated-with-context,
   * expiring), a stored-schema write, a counter, a delete, and a REAL GC event, all crossing a flush
   * boundary - then every activation in the cluster is force-collected (the in-process equivalent of
   * a restart under the shared in-memory storage provider) and, after reactivation,
   * head/schema-hash/floor/counters must be identical, sharded reads at head must equal the
   * pre-deactivation captures, and a Watch resumed from a pre-deactivation cursor must replay
   * exactly the remaining committed events from the rebuilt log tail. The head-equality assertion
   * doubles as the negative control: lost state would re-seed a fresh, different head with nothing
   * in it.
   */
  it("Deactivation_recovery_preserves_head_schema_counters_reads_and_watch_tail", async () => {
    // A realistic (1h) GC window: runGc genuinely appends a GC event with a floor at now-1h (far
    // below every revision this test mints), so the mixed load contains a real GC without ever
    // invalidating the Watch cursor captured below.
    const cluster = await MeshTestCluster.create(SCHEMA, { gcWindow: { hours: 1 } });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 30_000);
    try {
      const ds = cluster.datastore;
      const grain = sequencer(cluster);

      // `JsonSerializer.Deserialize<Dictionary<string, object?>>` -> the decoded context map the
      // port carries (port decision 6).
      const caveatContext = new Map<string, unknown>([
        ["region", "eu"],
        ["level", 7],
      ]);
      const schemaBytes = new TextEncoder().encode(SCHEMA);

      await ds.readWriteTx(async (tx) => {
        await tx.writeStoredSchema(schemaBytes);
        await tx.writeRelationships([
          { relationship: row("plain", "alice"), operation: "create" },
          {
            relationship: createRelationship(
              { objectType: "doc", objectId: "caveated", relation: "viewer" },
              { objectType: "user", objectId: "bob", relation: ELLIPSIS },
              { caveatName: "is_active", context: caveatContext },
            ),
            operation: "create",
          },
          {
            relationship: createRelationship(
              { objectType: "doc", objectId: "expiring", relation: "viewer" },
              { objectType: "user", objectId: "carol", relation: ELLIPSIS },
              undefined,
              EXPIRY,
            ),
            operation: "create",
          },
        ]);
        await tx.writeCounter("doc_viewers", {
          optionalResourceType: "doc",
          optionalResourceRelation: "viewer",
        });
      });

      // Cross TWO flush boundaries (64 and 128), capturing doc:m0's create revision for the
      // row-level gate below. Two flushes leave the store genuinely MID-ROTATION for the chunked key
      // index: buckets 0 and 1 hold rows (at different versions), every other bucket has none, and
      // TWO delta rows are pending - so the recovery below must reconstruct the index almost
      // entirely from the delta overlay (m0's own entry rides delta 64 unless its bucket happens to
      // be a rotated one).
      let m0CreateRev: IRevision | undefined;
      for (let i = 0; i < 130; i += 1) {
        const rev = await write(ds, row(`m${i}`, `w${i}`));
        if (i === 0) m0CreateRev = rev;
      }

      // A delete and a real GC event. The delete lands ABOVE the second (128-event) flush boundary,
      // making doc:m0's forward key TAIL-RESIDENT: recovery must seed it from its flushed row (the
      // create) and replay the tail's delete on top.
      const m0DeleteRev = await write(ds, row("m0", "w0"), "delete");
      expect(await grain.runGc()).toBeDefined();

      // The Watch cursor, then the two events it must replay after recovery.
      const cursor = (await ds.headRevision()).revision;
      await write(ds, row("post-1", "zoe"));
      await write(ds, row("post-2", "zed"));

      // Pre-deactivation captures.
      const headBefore = await ds.headRevision();
      const floorBefore = (await grain.getHead()).gcFloor;
      const readerBefore = ds.snapshotReader(headBefore.revision);
      const liveBefore = await collect(
        readerBefore.queryRelationships({ optionalResourceType: "doc" }),
      );
      const countBefore = await readerBefore.countRelationships("doc_viewers");
      const shardedBefore: IGraphReader = new ShardedGraphReader(
        cluster.grainFactory,
        nanos(headBefore.revision),
      );
      const shardCaptureBefore = await collect(
        shardedBefore.queryRelationships({
          optionalResourceType: "doc",
          optionalResourceIds: ["plain", "caveated", "expiring", "m0", "post-1"],
        }),
      );

      // Drop every activation; prove the sequencer's is gone before re-reading.
      await forceCollectAllActivations(cluster);

      // Head, schema hash, floor, counters: identical after recovery.
      const headAfter = await ds.headRevision();
      expect(nanos(headAfter.revision)).toBe(nanos(headBefore.revision));
      expect(headAfter.schemaHash).toBe(headBefore.schemaHash);
      // The stored-schema write is what made it non-undefined.
      expect(headAfter.schemaHash).toBeDefined();
      expect((await grain.getHead()).gcFloor).toBe(floorBefore);

      const readerAfter = ds.snapshotReader(headAfter.revision);
      expect(
        await collect(readerAfter.queryRelationships({ optionalResourceType: "doc" })),
      ).toEqual(liveBefore);
      expect(await readerAfter.countRelationships("doc_viewers")).toBe(countBefore);
      const counterFilter = await readerAfter.readCounterFilter("doc_viewers");
      expect(counterFilter!.optionalResourceType).toBe("doc");
      expect(counterFilter!.optionalResourceRelation).toBe("viewer");
      const schemaAfter = await readerAfter.readStoredSchema();
      expect(schemaAfter).toEqual(schemaBytes);

      // Payload fidelity through recovery: caveat context and expiration byte-exact.
      const rels: Relationship[] = [];
      for await (const rel of readerAfter.queryRelationships({
        optionalResourceType: "doc",
        optionalResourceIds: ["caveated", "expiring"],
      }))
        rels.push(rel);
      const caveated = rels.find((r) => r.reference.resource.objectId === "caveated")!;
      expect(caveated.optionalCaveat!.caveatName).toBe("is_active");
      expect(caveated.optionalCaveat!.context!.get("region")).toBe("eu");
      expect(caveated.optionalCaveat!.context!.get("level")).toBe(7);
      expect(
        rels.find((r) => r.reference.resource.objectId === "expiring")!.optionalExpiration,
      ).toBe(EXPIRY);

      // RAW ROW-LEVEL GATE for a TAIL-RESIDENT key: doc:m0's last touch (the delete) sits above the
      // flush boundary, so its recovered state is a flushed-row seed plus a tail replay. Assert the
      // EXACT row multiset (payload identity + MVCC stamps) equals a fresh ShardFold fold of the
      // key's touching log events from empty - the visibility-filtered reads above cannot see a
      // recovery double-fold (re-applying tail events over a row that already contains them leaves a
      // same-revision duplicate or a same-revision live+tombstone pair, both invisible at head).
      const m0Key = graphShardKeyForResource("doc", "m0");
      const m0Events: readonly LogEvent[] = [
        {
          revision: nanos(m0CreateRev!),
          relationshipChanges: [{ operation: "touch", relationship: toWire(row("m0", "w0")) }],
          schemaChange: undefined,
          counterChanges: [],
          gcFloor: undefined,
        },
        {
          revision: nanos(m0DeleteRev),
          relationshipChanges: [{ operation: "delete", relationship: toWire(row("m0", "w0")) }],
          schemaChange: undefined,
          counterChanges: [],
          gcFloor: undefined,
        },
      ];
      const expectedM0 = m0Events.reduce(
        (state, ev) => shardFoldApplyEvent(state, ev, m0Key),
        GRAPH_SHARD_STATE_EMPTY,
      );
      const m0Shard = await grain.readShard(m0Key);
      expect(rowMultiset(m0Shard.rows)).toEqual(rowMultiset(expectedM0.rows));
      // Explicitly: no two rows share (identity, createdRevision) - the same-revision
      // tombstone+live duplicate shape a crashed in-place flush used to be able to leave behind.
      expect(new Set(m0Shard.rows.map(rowCreationIdentity)).size).toBe(m0Shard.rows.length);

      // Sharded reads at head equal the pre-deactivation capture (m0 was deleted; post-1 present).
      const shardedAfter: IGraphReader = new ShardedGraphReader(
        cluster.grainFactory,
        nanos(headAfter.revision),
      );
      expect(
        await collect(
          shardedAfter.queryRelationships({
            optionalResourceType: "doc",
            optionalResourceIds: ["plain", "caveated", "expiring", "m0", "post-1"],
          }),
        ),
      ).toEqual(shardCaptureBefore);

      // Watch resumes from the pre-deactivation cursor with exactly the two remaining events, in
      // order - served from the reactivated grain's rebuilt in-memory log tail.
      const replayed: RevisionChange[] = [];
      for await (const change of ds.watch(
        cursor,
        { content: WatchContent.relationships },
        controller.signal,
      )) {
        replayed.push(change);
        if (replayed.length === 2) break;
      }
      expect(replayed[0]!.relationshipChanges).toHaveLength(1);
      expect(replayed[0]!.relationshipChanges[0]!.relationship.reference.resource.objectId).toBe(
        "post-1",
      );
      expect(replayed[1]!.relationshipChanges).toHaveLength(1);
      expect(replayed[1]!.relationshipChanges[0]!.relationship.reference.resource.objectId).toBe(
        "post-2",
      );
      expect(nanos(replayed[0]!.revision) < nanos(replayed[1]!.revision)).toBe(true);
      expect(nanos(replayed[0]!.revision) > nanos(cursor)).toBe(true);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await cluster.dispose();
    }
  }, 300_000);

  // ---- (f) Log-row ETag hygiene: a retried append overwrites its own crashed attempt's orphan. ---

  /**
   * The Phase 0 hygiene rider (docs/scalability-program.md section 2): a crashed append attempt can
   * leave an ORPHAN log row - the `log/{version}` entry written but the head never advanced, so the
   * durable log version still names the row's slot for the next append. Log-row writes must be the
   * same ETag-tolerant read-then-write the versioned shard/meta rows use, so the retried append
   * OVERWRITES the orphan instead of ETag-clashing against it (a fresh empty-ETag wrapper would be
   * rejected by every provider that enforces optimistic concurrency, `MemoryGrainStorage` included).
   * Plant the orphan directly through the grain's own storage provider at the next log version, then
   * commit through the grain: the commit must succeed and the row must hold the NEW event.
   */
  it("Commit_overwrites_an_orphan_log_row_left_by_a_crashed_append_attempt", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      const ds = cluster.datastore;

      // A baseline commit so the grain is active and the durable head row exists.
      await write(ds, row("k0", "u0"));

      const headRow = await readRow<LogHeadEntry>(cluster, "head");
      expect(headRow.exists, "no durable head after the baseline commit").toBe(true);
      const nextVersion = headRow.value.logVersion + 1;

      // Plant the orphan exactly where a crashed append attempt leaves it: the next log version's
      // row written (with its own storage ETag minted), the head untouched.
      const storage = cluster.datastoreStorage;
      const grainId = grainReferenceIdentity(sequencer(cluster))!.grainId;
      const orphan: LogEvent = {
        // `long.MaxValue`.
        revision: 9223372036854775807n,
        relationshipChanges: [],
        schemaChange: undefined,
        counterChanges: [],
        gcFloor: undefined,
      };
      await storage.write(`log/${nextVersion}`, grainId, { value: orphan, exists: false });

      // The retried append must succeed (no ETag clash) ...
      const revision = await write(ds, row("k1", "u1"));

      // ... and the slot must hold the NEW commit's event, not the orphan's content.
      const logRow = await readRow<LogEvent>(cluster, `log/${nextVersion}`);
      expect(logRow.exists, `log/${nextVersion} is missing after the retried append`).toBe(true);
      expect(logRow.value.revision).toBe(nanos(revision));
    } finally {
      await cluster.dispose();
    }
  }, 300_000);
});

// ---- shared helpers (the C#'s private statics) ----

/** `private static readonly DateTimeOffset Expiry = new(2031, 6, 1, 0, 0, 0, TimeSpan.Zero)`. */
const EXPIRY = BigInt(Date.UTC(2031, 5, 1, 0, 0, 0)) * 1_000_000n;

function touchWire(docId: string, userId: string): RelationshipUpdateWire {
  return { operation: "touch", relationship: toWire(row(docId, userId)) };
}

/**
 * The C#'s `Guarded`. Its note about "concrete `List<T>`s, not collection expressions" is an Orleans
 * serialization-codec constraint with no analogue here - Thresh serializes plain arrays structurally
 * - so the arrays are ordinary literals.
 */
function guarded(
  precondition: CommitPreconditionWire,
  update: RelationshipUpdateWire,
): CommitRequest {
  return {
    preconditions: [precondition],
    updates: [update],
    deleteByFilter: undefined,
    schemaBytes: undefined,
    expectedSchemaHash: undefined,
    counterChanges: [],
    expectedHead: undefined,
  };
}

async function exists(ds: IDatastore, docId: string): Promise<boolean> {
  const head = (await ds.headRevision()).revision;
  const filter: RelationshipsFilter = {
    optionalResourceType: "doc",
    optionalResourceIds: [docId],
  };
  for await (const _ of ds.snapshotReader(head).queryRelationships(filter)) return true;
  return false;
}

/** The C#'s local `RowMultiset`: payload identity plus both MVCC stamps, ordinal-sorted. */
function rowMultiset(rows: readonly StoredRelationshipWire[]): string[] {
  return rows
    .map((r) => {
      const rel = r.relationship;
      return (
        `${rel.resourceType}:${rel.resourceId}#${rel.resourceRelation}` +
        `@${rel.subjectType}:${rel.subjectId}#${rel.subjectRelation}` +
        `|created=${r.createdRevision}` +
        `|deleted=${r.deletedRevision === undefined ? "live" : r.deletedRevision.toString()}`
      );
    })
    .sort();
}

/** The (identity, createdRevision) key of the distinct-count assertion. */
function rowCreationIdentity(r: StoredRelationshipWire): string {
  const rel = r.relationship;
  return (
    `${rel.resourceType}:${rel.resourceId}#${rel.resourceRelation}` +
    `@${rel.subjectType}:${rel.subjectId}#${rel.subjectRelation}` +
    `|${r.createdRevision}`
  );
}

/**
 * The structural stand-in for `type == typeof(StoredRelationshipWire)`: an object carrying a
 * relationship payload plus a `createdRevision` MVCC stamp IS a stored relationship row, whatever it
 * is nominally called. Deliberately shape-based - TypeScript erases the type, so identity comparison
 * is not available, and a regression that renamed the type would still be caught.
 */
function isStoredRelationshipShaped(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!("createdRevision" in candidate)) return false;
  const relationship = candidate["relationship"];
  if (typeof relationship !== "object" || relationship === null) return false;
  const rel = relationship as Record<string, unknown>;
  return "resourceType" in rel && "resourceId" in rel && "subjectType" in rel && "subjectId" in rel;
}

/**
 * Every value transitively reachable from `root` - objects, arrays, and Map keys and values - with
 * the path that reached it. The value-level analogue of the C#'s type-graph BFS over public
 * properties, private fields and generic arguments; `seen` plays the role of its `visited` set and
 * keeps a cyclic state from looping.
 */
function* reachableValues(root: unknown): Generator<{ value: unknown; path: string }> {
  const seen = new Set<unknown>();
  const queue: Array<{ value: unknown; path: string }> = [{ value: root, path: "state" }];
  while (queue.length > 0) {
    const entry = queue.shift()!;
    const { value, path } = entry;
    if (typeof value !== "object" || value === null) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    yield entry;

    if (Array.isArray(value)) {
      value.forEach((item, i) => queue.push({ value: item, path: `${path}[${i}]` }));
      continue;
    }
    if (value instanceof Map) {
      for (const [k, v] of value) {
        queue.push({ value: k, path: `${path}.key` });
        queue.push({ value: v, path: `${path}[${String(k)}]` });
      }
      continue;
    }
    if (value instanceof Set) {
      for (const v of value) queue.push({ value: v, path: `${path}.item` });
      continue;
    }
    if (ArrayBuffer.isView(value)) continue;
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      queue.push({ value: v, path: `${path}.${k}` });
  }
}
