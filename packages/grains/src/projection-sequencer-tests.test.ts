import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import { loadValidationFile } from "@benedb/conformance/validation-file-loader";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { UpdateOperation } from "@benedb/core/relationship-update";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import type { IGraphReader } from "@benedb/datastore/i-graph-reader";
import type { RelationshipsFilter } from "@benedb/datastore/relationships-filter";
import type { RevisionChange } from "@benedb/datastore/watch";
import { WatchContent } from "@benedb/datastore/watch";
import { JournaledGrain } from "@thresh/core/journaled-grain";
import { IManagementGrain } from "@thresh/core/management-grain";

import type { CommitPreconditionWire, CommitRequest } from "./commit-contract";
import { datastoreMetaStateEmpty } from "./datastore-meta-state";
import type { StoredRelationshipWire } from "./datastore-dtos";
import { DatastoreGrain } from "./datastore-grain";
import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { graphShardKeyForResource } from "./graph-shard-key";
import { GRAPH_SHARD_STATE_EMPTY } from "./graph-shard-state";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { IGraphShardGrain, IShardIndexGrain } from "./i-graph-shard-grain";
import type { LogEvent } from "./log-event";
import { MeshTestCluster } from "./mesh-test-cluster";
import type { RelationshipUpdateWire } from "./relationships-dtos";
import { shardFoldApplyEvent } from "./shard-fold";
import { shardIndexList } from "./shard-index-grain";
import { ShardedGraphReader } from "./sharded-graph-reader";
import { toFullFilter, toRelationship, toWire } from "./wire-convert";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ProjectionSequencerTests.cs`.
 *
 * Closing gates for the journaled sequencer and its shard projection
 * (docs/graph-sharded-datastore.md): the `DatastoreGrain` journals only the small
 * `DatastoreMetaState` plus the pending tail, and every `FLUSH_INTERVAL` (64) events projects the
 * tail into the shard grains it touches and the shard index. These tests pin: flush-boundary
 * integrity (reads at head through the sharded reader AND the scan seam stay exact across a
 * projection), the memory ceiling (the journaled state carries NO relationship-row collections),
 * the clean-key relabel rule (a projected state is complete unless a pending event touches its key
 * - `shard-fold-lemma-tests`), lazy row-GC (floor enforced on every serve path while projected
 * rows compact only at their key's next projection), the partial write base (Commit candidate-key
 * resolution pulls in keys named only by precondition filters, forward AND reverse), projection
 * idempotence, and recovery fidelity across a genuine deactivation.
 *
 * PORT DECISIONS.
 *
 *  1. `ForceActivationCollection(TimeSpan.Zero)` + `GetDetailedGrainStatistics()` -> Thresh's
 *     `IManagementGrain` at the integer key `0n`. The "the sequencer activation is really gone"
 *     assertion stays a CASE-INSENSITIVE SUBSTRING on the registered grain-type name, but the
 *     literal shortens from `"datastoregrain"` to {@link SEQUENCER_GRAIN_TYPE_MATCH}: Thresh
 *     registers a grain under its class name MINUS the `Grain` suffix, so the C#'s spelling would
 *     never hit and the control would pass vacuously - exactly the failure `cold-start-tests`
 *     records for `graphshardgrain`.
 *  2. THE REFLECTION TRIPWIRE IS RE-EXPRESSED STRUCTURALLY - see the comment on
 *     `Journaled_state_carries_no_relationship_rows_anywhere_in_its_shape`. TypeScript erases types,
 *     so there is no type graph to walk; the claim is re-made over VALUES.
 *  3. Caveat-context assertions become plain `ReadonlyMap` lookups (`'eu'`, `7`) rather than
 *     `JsonElement.GetRawText()` strings: the port carries caveat context as a
 *     `ReadonlyMap<string, unknown>` of decoded JSON values, so there is no raw text to compare.
 *     `Expiry` stays a FIXED instant, transcribed as its epoch-nanos `bigint`, and must survive
 *     recovery byte-exact.
 *  4. `await using var cluster` -> an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  5. Protocol constants are transcribed, never rounded: FlushInterval 64, the 67-/130-commit
 *     loops, the two flush boundaries (64 and 128).
 */

const requireFromHere = createRequire(import.meta.url);

/** The conformance corpus directory - the C#'s linked `TestData` output folder. */
const CORPUS_DIR = resolvePath(
  dirname(requireFromHere.resolve("@benedb/conformance/validation-file-loader")),
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

/** The object ids the shard index lists for a forward type. */
async function listForwardIds(cluster: MeshTestCluster, type: string): Promise<string[]> {
  const keys = await shardIndexList(
    (key) => cluster.grainFactory.getGrain(IShardIndexGrain, key),
    "forward",
    type,
  );
  return keys.map((key) => key.objectId);
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

describe("ProjectionSequencerTests", () => {
  // ---- (a) Flush-boundary integrity across a projection. ----

  /**
   * More than `FLUSH_INTERVAL` (64) commits across several keys - creates, a delete, a touch, and a
   * post-flush key - then, WITHOUT any restart, reads at head through BOTH the shard mesh
   * (`ShardedGraphReader`) and the scan seam (`ISnapshotScanner`) must equal the
   * independently-tracked expectation. Probes of the shard grains' projected state and the shard
   * index then pin that the projection actually ran, and that an explicit flush projects the rest.
   */
  it("Reads_stay_exact_across_a_projection_flush", async () => {
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
      // The projection really ran: the pending tail was flushed at 64 events, so k0..k4 (all
      // touched before the flush) have projected state of their own, and the index lists them. k0's
      // projected rows hold u0 live - its delete (commit 68) is still pending, folded over at read
      // time.
      const k0Shard = cluster.grainFactory.getGrain(
        IGraphShardGrain,
        graphShardGrainKeyBuild(graphShardKeyForResource("doc", "k0")),
      );
      let k0 = await k0Shard.readProjected();
      expect(
        k0.rows.some((r) => r.relationship.subjectId === "u0" && r.deletedRevision === undefined),
      ).toBe(true);
      let listed = await listForwardIds(cluster, "doc");
      for (const id of ["k0", "k1", "k2", "k3", "k4"]) expect(listed).toContain(id);
      expect(listed).not.toContain("k9"); // still only pending

      // An explicit flush projects the rest: k0's projected state now carries the tombstone.
      await sequencer(cluster).flushProjection();
      k0 = await k0Shard.readProjected();
      expect(
        k0.rows.some((r) => r.relationship.subjectId === "u0" && r.deletedRevision !== undefined),
      ).toBe(true);
      listed = await listForwardIds(cluster, "doc");
      expect(listed).toContain("k9");
    } finally {
      await cluster.dispose();
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

    // (2) The state IS the slim meta state: exactly its eight members, no more.
    const initial = grain.initialState();
    const metaKeys = Object.keys(datastoreMetaStateEmpty(0n)).sort();
    expect(metaKeys).toEqual([
      "counters",
      "forwardTypes",
      "gcFloor",
      "headRevision",
      "pending",
      "projectedThrough",
      "reverseTypes",
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
    folded = grain.transitionState(folded, {
      kind: "committed",
      event: event(10n, [{ operation: "touch", relationship: toWire(row("d1", "alice")) }]),
    });
    folded = grain.transitionState(folded, {
      kind: "committed",
      event: event(20n, [{ operation: "touch", relationship: toWire(row("d2", "bob")) }]),
    });
    folded = grain.transitionState(folded, {
      kind: "committed",
      event: event(30n, [{ operation: "delete", relationship: toWire(row("d1", "alice")) }]),
    });
    folded = grain.transitionState(folded, { kind: "committed", event: event(40n, [], 15n) });

    // The fold really did something - a vacuous walk grades nothing.
    expect(folded.headRevision).toBe(40n);
    expect(folded.pending.length).toBe(4);
    expect(folded.forwardTypes).toEqual(["doc"]);

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
   * with `appliedRevision === the CURRENT head` (its projected state relabeled, no per-key replay)
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

      // 64 filler commits cross the flush boundary (projecting the tail), then 3 more advance the
      // head PAST the flush revision - so at read time the probed key's projected state is stamped
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

  // ---- (c) Lazy row-GC: floor on every serve path; physical compaction at the next projection. --

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

      // Cross the flush boundary on OTHER keys: "cold"'s projected state (carol live + dead's
      // tombstone) is durable and nothing pending touches it - from here on "cold" is the clean key.
      for (let i = 0; i < 64; i += 1) await write(ds, row(`f${i}`, "filler"));

      // Dirty a DIFFERENT key, then GC: Window=Zero makes the floor land at the current head, past
      // the tombstone - but "cold" is never touched, so its projection keeps the dead row lazily.
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

      // Touch "cold" again and push another flush past it: this flush is where its projection
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
   * commit - and whose key is CLEAN (projected, with nothing pending) - so the partial write base is
   * sufficient only if candidate-key resolution pulls that key in from its shard grain's projection.
   * Both outcomes are pinned: mustMatch satisfied commits the guarded update; mustMatch against a
   * missing resource rejects with `preconditionFailed` and applies nothing.
   */
  it("Commit_precondition_on_an_untouched_clean_resource_key_behaves_exactly", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      const ds = cluster.datastore;
      const grain = sequencer(cluster);

      await write(ds, row("a", "alice"));

      // Project "a" so the precondition can only be answered from its shard grain's projected state
      // (the partial base's projection path, not the pending overlay).
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

      // Flush so user:alice's reverse key lives only in its projected state at commit time.
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
      // row-level gate below.
      let m0CreateRev: IRevision | undefined;
      for (let i = 0; i < 130; i += 1) {
        const rev = await write(ds, row(`m${i}`, `w${i}`));
        if (i === 0) m0CreateRev = rev;
      }

      // A delete and a real GC event. The delete lands ABOVE the second (128-event) flush boundary,
      // making doc:m0's forward key TAIL-RESIDENT: recovery must take its projected state (the
      // create) and fold the pending delete on top.
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
      // flush boundary, so its recovered state is its projected state plus the pending tail. Assert the
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
      // tombstone+live duplicate shape a double-applied pending event would leave behind.
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

  // ---- (f) Projection idempotence: a replayed projection changes nothing but the label. ----

  /**
   * The sequencer replays a projection whenever it cannot be sure the previous one was journaled (a
   * failure or a crash between the shard writes and the `projected` entry). Replaying events the
   * shard already persisted must leave its rows identical - only the label may advance - and
   * replaying with a label at or below the persisted one must be a no-op.
   */
  it("Replaying_a_projection_leaves_the_shard_rows_unchanged", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      const ds = cluster.datastore;
      const created = await write(ds, row("r", "alice"));
      const deleted = await write(ds, row("r", "alice"), "delete");
      await sequencer(cluster).flushProjection();

      const shard = cluster.grainFactory.getGrain(
        IGraphShardGrain,
        graphShardGrainKeyBuild(graphShardKeyForResource("doc", "r")),
      );
      const before = await shard.readProjected();
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0]!.deletedRevision).toBeDefined();

      const replay: LogEvent[] = [
        {
          revision: nanos(created),
          relationshipChanges: [{ operation: "touch", relationship: toWire(row("r", "alice")) }],
          schemaChange: undefined,
          counterChanges: [],
          gcFloor: undefined,
        },
        {
          revision: nanos(deleted),
          relationshipChanges: [{ operation: "delete", relationship: toWire(row("r", "alice")) }],
          schemaChange: undefined,
          counterChanges: [],
          gcFloor: undefined,
        },
      ];

      // At the persisted label: a no-op.
      await shard.project(replay, before.appliedRevision, before.gcFloor);
      const unchanged = await shard.readProjected();
      expect(unchanged.appliedRevision).toBe(before.appliedRevision);
      expect(unchanged.rows).toEqual(before.rows);

      // Above it: the events are skipped by the label; only the label advances.
      await shard.project(replay, before.appliedRevision + 1n, before.gcFloor);
      const after = await shard.readProjected();
      expect(after.appliedRevision).toBe(before.appliedRevision + 1n);
      expect(after.rows).toEqual(before.rows);
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
