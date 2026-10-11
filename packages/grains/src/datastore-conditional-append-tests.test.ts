import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { GrainId } from "@thresh/core/grain-id";
import type { JournalEntry, JournalSegment, JournalStorage } from "@thresh/core/journal-storage";
import { MemoryJournalStorage } from "@thresh/journaling/memory-journal-storage";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { TestCluster } from "@thresh/testing/test-cluster";

import type { IDatastore } from "@benedb/datastore/i-datastore";

import type { CommitRequest } from "./commit-contract";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import type { IDatastoreGrain as IDatastoreGrainType } from "./i-datastore-grain";
import type { RelationshipUpdateWire } from "./relationships-dtos";
import {
  addSpiceportGrainServices,
  SPICEPORT_GRAIN_REGISTRATIONS,
} from "./service-collection-extensions";

/**
 * Regression gate for the conditional-append semantics of `DatastoreGrain.commit` - the
 * `RaiseConditionalEvent` translation (thresh's `raiseConditionalEvent` / adaptor `tryAppend`).
 *
 * THE DEFECT THIS PINS: the earlier `raiseEvent` + `confirmEvents` transliteration left a
 * rejected commit's event PENDING in the log-view adaptor after the bounded CAS budget
 * exhausted. The caller was told the commit failed (`headMoved`), but the NEXT commit's confirm
 * appended the leftover event anyway - a write the client was told failed got applied. Orleans'
 * `RaiseConditionalEvent` drops a stale conditional entry on the first conflict instead
 * (`PrimaryBasedLogViewAdaptor.RemoveStaleConditionalUpdates`), which is what
 * `raiseConditionalEvent` now provides; the adaptor-level shapes are pinned in thresh's
 * `custom-storage-log-view-adaptor-impl.test.ts`, and this suite pins the grain-level consequence
 * through a real `TestCluster`.
 *
 * The failure is injected at the true boundary (the journal fake): every append - the commit
 * point - throws, which the adaptor treats as a failed write (re-read, retry, bounded budget, then
 * drop and report `false`). No grain internals are reached into.
 */

const SCHEMA = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

/**
 * A `JournalStorage` decorator over the real in-memory journal that can be armed to throw on
 * appends - the datastore grain's commit point - while reads and snapshots go through untouched.
 */
class FlakyJournal implements JournalStorage {
  failAppends = 0;

  constructor(private readonly inner: JournalStorage) {}

  read(logName: string, grainId: GrainId, signal?: AbortSignal): Promise<JournalSegment> {
    return this.inner.read(logName, grainId, signal);
  }

  append(
    logName: string,
    grainId: GrainId,
    entries: readonly JournalEntry[],
    expectedVersion: number | undefined,
    signal?: AbortSignal,
  ): Promise<number> {
    if (this.failAppends > 0) {
      this.failAppends--;
      return Promise.reject(new Error("injected append failure"));
    }
    return this.inner.append(logName, grainId, entries, expectedVersion, signal);
  }

  replace(
    logName: string,
    grainId: GrainId,
    entries: readonly JournalEntry[],
    expectedVersion: number | undefined,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.inner.replace(logName, grainId, entries, expectedVersion, signal);
  }

  clear(logName: string, grainId: GrainId, signal?: AbortSignal): Promise<void> {
    return this.inner.clear(logName, grainId, signal);
  }
}

function touch(res: string, subj: string): RelationshipUpdateWire {
  return {
    operation: "touch",
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

/** A declarative direct-grain `CommitRequest` (no expectedHead CAS; the sequencer serializes). */
function directCommit(updates: readonly RelationshipUpdateWire[]): CommitRequest {
  return {
    preconditions: [],
    updates,
    deleteByFilter: undefined,
    schemaBytes: undefined,
    expectedSchemaHash: undefined,
    counterChanges: [],
    expectedHead: undefined,
  };
}

async function buildCluster(
  journal: JournalStorage,
): Promise<{ cluster: TestCluster; grain: IDatastoreGrainType }> {
  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: SPICEPORT_GRAIN_REGISTRATIONS,
    configureSilo: (builder) => {
      builder.addStorage("datastore", new MemoryGrainStorage());
      builder.useMemoryJournaling(journal);
      let datastore: IDatastore | undefined;
      const services = addSpiceportGrainServices(builder, {
        schemaText: SCHEMA,
        // The host-owned `IDatastore`, resolved lazily over the DI-singleton watch hub - the
        // same wiring `datastore-grain-durability-tests` uses.
        datastore: () =>
          (datastore ??= new GrainBackedDatastore(services.grainFactory, services.hub)),
      });
    },
  });
  const client = await cluster.client;
  return { cluster, grain: client.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY) };
}

describe("DatastoreConditionalAppendTests", () => {
  it("Commit_ToldFailed_IsNeverAppliedByALaterCommit", async () => {
    const journal = new FlakyJournal(new MemoryJournalStorage());
    const { cluster, grain } = await buildCluster(journal);
    try {
      // A first successful commit pins the baseline (and activates the grain).
      const first = await grain.commit(directCommit([touch("doc1", "alice")]));
      expect(first.failure).toBeUndefined();

      // Every append - the commit point - now fails: the conditional append exhausts its bounded
      // retry budget and the commit is REJECTED to the caller.
      journal.failAppends = Number.MAX_SAFE_INTEGER;
      const rejectedReply = await grain.commit(directCommit([touch("doc2", "bob")]));
      expect(rejectedReply.failure?.kind).toBe("headMoved");
      expect(rejectedReply.revision).toBeUndefined();

      // Storage heals. The next, unrelated commit must apply ONLY its own write: the doc2 event
      // the caller was told failed must never ride along.
      journal.failAppends = 0;
      const second = await grain.commit(directCommit([touch("doc3", "carol")]));
      expect(second.failure).toBeUndefined();
      expect(second.revision).toBeDefined();

      const state = await grain.readState();
      const liveResources = state.relationships
        .filter((row) => row.deletedRevision === undefined)
        .map((row) => row.relationship.resourceId)
        .sort();
      expect(liveResources).toEqual(["doc1", "doc3"]);
      expect(state.headRevision).toBe(second.revision);
    } finally {
      await cluster.dispose();
    }
  });
});
