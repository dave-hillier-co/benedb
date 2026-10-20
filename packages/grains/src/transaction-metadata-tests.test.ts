import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import { createRelationship } from "@benedb/core/relationship";
import type { TimestampRevision } from "@benedb/core/timestamp-revision";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import { WatchContent, type RevisionChange } from "@benedb/datastore/watch";
import { IManagementGrain } from "@thresh/core/management-grain";

import type { CommitReply, CommitRequest } from "./commit-contract";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { MeshTestCluster } from "./mesh-test-cluster";
import type { RelationshipWire } from "./relationships-dtos";
import { toRelationship, toWire } from "./wire-convert";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/TransactionMetadataTests.cs`.
 *
 * Transaction metadata (SpiceDB `optional_transaction_metadata` on WriteRelationships and
 * DeleteRelationships, stored with the transaction by `options.WithMetadata` and returned by Watch for
 * that revision) is part of the log: it rides the declarative `CommitRequest` into the journaled
 * `LogEvent` of the revision the commit mints, so it survives journal replay and projection exactly as
 * the event does, and the Watch feed reads it from there. These gates drive the real sequencer through
 * a `MeshTestCluster`; the metadata is opaque bytes to everything below the gRPC service.
 *
 * PORT NOTES.
 *  - `byte[]` -> `Uint8Array`; `Encoding.UTF8.GetBytes` -> `TextEncoder`.
 *  - The C#'s note about collection expressions (Orleans has no codec for the compiler-synthesized
 *    list types) has no TypeScript counterpart: an array literal is an array.
 *  - `[Collection(MeshClusterCollection.Name)]` -> nothing; see `mesh-cluster-collection.ts`.
 */

const SCHEMA = `definition user {}
definition doc {
    relation viewer: user
}`;

function sequencer(cluster: MeshTestCluster): IDatastoreGrain {
  return cluster.grainFactory.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
}

function viewer(doc: string, user: string): RelationshipWire {
  return toWire(
    createRelationship(
      { objectType: "doc", objectId: doc, relation: "viewer" },
      { objectType: "user", objectId: user, relation: ELLIPSIS },
    ),
  );
}

function touch(doc: string, user: string, metadata: Uint8Array | undefined): CommitRequest {
  return {
    preconditions: [],
    updates: [{ operation: "touch", relationship: viewer(doc, user) }],
    counterChanges: [],
    transactionMetadata: metadata,
  };
}

function metadata(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function nanos(revision: IRevision): bigint {
  return (revision as TimestampRevision).timestampNanosSinceEpoch;
}

/** Takes `count` changes from a Watch after `after`, then cancels the stream. */
async function watchUntil(
  datastore: IDatastore,
  after: IRevision,
  count: number,
  content: number = WatchContent.relationships,
): Promise<RevisionChange[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  const changes: RevisionChange[] = [];
  try {
    for await (const change of datastore.watch(after, { content }, controller.signal)) {
      changes.push(change);
      if (changes.length === count) break;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return changes;
}

async function withCluster(body: (cluster: MeshTestCluster) => Promise<void>): Promise<void> {
  const cluster = await MeshTestCluster.create(SCHEMA);
  try {
    await body(cluster);
  } finally {
    await cluster.dispose();
  }
}

describe("TransactionMetadataTests", () => {
  it("A_declarative_commit_journals_its_metadata_on_its_own_event_and_watch_returns_it", async () => {
    await withCluster(async (cluster) => {
      const grain = sequencer(cluster);
      const from = await cluster.datastore.headRevision();

      const tagged = await grain.commit(touch("a", "alice", metadata('{"who":"alice"}')));
      const untagged = await grain.commit(touch("b", "bob", undefined));
      // SpiceDB stores no metadata for an empty struct (AddRevisionMetadata skips Len() == 0); an
      // empty struct serializes to zero bytes.
      const empty = await grain.commit(touch("c", "carol", new Uint8Array(0)));

      const events = (await grain.readFrom(nanos(from.revision), -1)).events;
      expect(events.map((e) => e.revision)).toEqual([
        tagged.revision,
        untagged.revision,
        empty.revision,
      ]);
      expect(events[0]!.transactionMetadata).toEqual(metadata('{"who":"alice"}'));
      expect(events[1]!.transactionMetadata).toBeUndefined();
      expect(events[2]!.transactionMetadata).toBeUndefined();

      const changes = await watchUntil(cluster.datastore, from.revision, 3);
      expect(changes[0]!.transactionMetadata).toEqual(metadata('{"who":"alice"}'));
      expect(changes[1]!.transactionMetadata).toBeUndefined();
      expect(changes[2]!.transactionMetadata).toBeUndefined();
    });
  }, 120_000);

  it("A_rejected_commit_appends_nothing_so_its_metadata_never_reaches_the_log", async () => {
    await withCluster(async (cluster) => {
      const grain = sequencer(cluster);
      const from = (await grain.getHead()).head;

      const create: CommitRequest = {
        preconditions: [],
        updates: [{ operation: "create", relationship: viewer("a", "alice") }],
        counterChanges: [],
        transactionMetadata: metadata("first"),
      };
      expect((await grain.commit(create)).failure).toBeUndefined();
      const rejected = await grain.commit({ ...create, transactionMetadata: metadata("second") });
      expect(rejected.failure?.kind).toBe("createAlreadyExists");

      const events = (await grain.readFrom(from, -1)).events;
      expect(events).toHaveLength(1);
      expect(events[0]!.transactionMetadata).toEqual(metadata("first"));
    });
  }, 120_000);

  it("Relationship_writes_and_deletes_carry_their_metadata_into_the_log", async () => {
    await withCluster(async (cluster) => {
      const from = await cluster.datastore.headRevision();

      await cluster.relationships.writeRelationships({
        updates: [{ operation: "touch", relationship: viewer("a", "alice") }],
        transactionMetadata: metadata("write"),
      });
      await cluster.relationships.deleteRelationships({
        filter: { resourceType: "doc", resourceIds: ["a"] },
        transactionMetadata: metadata("delete"),
      });

      const changes = await watchUntil(cluster.datastore, from.revision, 2);
      expect(changes[0]!.relationshipChanges.map((u) => u.operation)).toEqual(["touch"]);
      expect(changes[0]!.transactionMetadata).toEqual(metadata("write"));
      // A delete-by-filter's deletions all belong to the one revision, and so to its metadata.
      expect(changes[1]!.relationshipChanges.map((u) => u.operation)).toEqual(["delete"]);
      expect(changes[1]!.transactionMetadata).toEqual(metadata("delete"));
    });
  }, 120_000);

  it("The_compatibility_path_carries_metadata_through_the_expected_head_commit", async () => {
    await withCluster(async (cluster) => {
      const from = await cluster.datastore.headRevision();

      const revision = await cluster.datastore.readWriteTx(
        (tx) =>
          tx.writeRelationships([
            { relationship: toRelationship(viewer("a", "alice")), operation: "touch" },
          ]),
        metadata("compat"),
      );

      const changes = await watchUntil(cluster.datastore, from.revision, 1);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.revision.equals(revision)).toBe(true);
      expect(changes[0]!.transactionMetadata).toEqual(metadata("compat"));
    });
  }, 120_000);

  /**
   * The metadata is part of the journaled event, so it survives the sequencer's reactivation (replay
   * of the journaled state) and is untouched by a projection flush: events still pending after a
   * flush keep their own metadata, and a Watch resumed across the reactivation returns it.
   */
  it("Metadata_survives_projection_and_journal_replay", async () => {
    await withCluster(async (cluster) => {
      const grain = sequencer(cluster);

      // Cross the 64-event flush boundary so the auto-flush projects most events; the tail after it
      // stays pending in the journaled state.
      for (let i = 0; i < 66; i++) {
        expect((await grain.commit(touch(`p${i}`, "alice", metadata(`pre-${i}`)))).failure).toBe(
          undefined,
        );
      }

      const cursor = await cluster.datastore.headRevision();
      const replies: CommitReply[] = [];
      for (let i = 0; i < 3; i++) {
        replies.push(
          await grain.commit(touch(`t${i}`, "bob", i === 1 ? undefined : metadata(`tail-${i}`))),
        );
      }

      const management = cluster.grainFactory.getGrain(IManagementGrain, 0n);
      await management.forceActivationCollection({ ms: 0 });
      const stats = await management.getDetailedGrainStatistics();
      expect(
        stats
          .filter((s) => s.grainType.toLowerCase().includes("datastore"))
          .map((s) => s.grainType),
        "the sequencer activation survived the forced collection",
      ).toEqual([]);

      const changes = await watchUntil(cluster.datastore, cursor.revision, 3);
      expect(changes.map((c) => nanos(c.revision))).toEqual(replies.map((r) => r.revision));
      expect(changes[0]!.transactionMetadata).toEqual(metadata("tail-0"));
      expect(changes[1]!.transactionMetadata).toBeUndefined();
      expect(changes[2]!.transactionMetadata).toEqual(metadata("tail-2"));
    });
  }, 120_000);

  /**
   * A revision whose only content is metadata (a delete that matched nothing) is not a Watch change:
   * SpiceDB's Watch service sends a response only for relationship updates, schema changes or a
   * checkpoint, so the metadata alone emits nothing.
   */
  it("A_revision_with_metadata_but_no_changes_emits_no_watch_change", async () => {
    await withCluster(async (cluster) => {
      const from = await cluster.datastore.headRevision();

      await cluster.relationships.deleteRelationships({
        filter: { resourceType: "doc", resourceIds: ["nothing"] },
        transactionMetadata: metadata("empty-delete"),
      });
      await cluster.relationships.writeRelationships({
        updates: [{ operation: "touch", relationship: viewer("a", "alice") }],
      });

      const changes = await watchUntil(cluster.datastore, from.revision, 1);
      expect(changes).toHaveLength(1);
      expect(
        changes[0]!.relationshipChanges.map((u) => u.relationship.reference.resource.objectId),
      ).toEqual(["a"]);
      expect(changes[0]!.transactionMetadata).toBeUndefined();
    });
  }, 120_000);
});
