import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { GrainId } from "@thresh/core/grain-id";
import type { GrainStorage, StateHolder } from "@thresh/core/grain-storage";
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
 * The CAS failure is injected at the true boundary (the storage fake): the commit's log rows are
 * allowed through but every `head` write - the commit point - throws, which the adaptor treats
 * exactly like a lost CAS (re-read, retry, bounded budget). No grain internals are reached into.
 */

const SCHEMA = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

const HEAD_STATE_NAME = "head";

/**
 * A `GrainStorage` decorator over the real in-memory provider that can be armed to throw on
 * writes of the datastore grain's `head` row - the commit point - while letting every other row
 * (log entries, meta, shards) through untouched.
 */
class FlakyHeadStorage implements GrainStorage {
  failHeadWrites = 0;
  headWriteAttempts = 0;

  constructor(private readonly inner: GrainStorage) {}

  read<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inner.read(stateName, grainId, state, signal);
  }

  write<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    if (stateName === HEAD_STATE_NAME) {
      this.headWriteAttempts++;
      if (this.failHeadWrites > 0) {
        this.failHeadWrites--;
        return Promise.reject(new Error("injected head-write failure"));
      }
    }
    return this.inner.write(stateName, grainId, state, signal);
  }

  clear<T>(
    stateName: string,
    grainId: GrainId,
    state: StateHolder<T>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.inner.clear(stateName, grainId, state, signal);
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
  storage: GrainStorage,
): Promise<{ cluster: TestCluster; grain: IDatastoreGrainType }> {
  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: SPICEPORT_GRAIN_REGISTRATIONS,
    configureSilo: (builder) => {
      builder.addStorage("datastore", storage);
      let datastore: IDatastore | undefined;
      const services = addSpiceportGrainServices(builder, {
        schemaText: SCHEMA,
        datastoreStorage: storage,
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
    const storage = new FlakyHeadStorage(new MemoryGrainStorage());
    const { cluster, grain } = await buildCluster(storage);
    try {
      // A first successful commit pins the baseline (and activates the grain).
      const first = await grain.commit(directCommit([touch("doc1", "alice")]));
      expect(first.failure).toBeUndefined();

      // Every head write - the commit point - now fails: the conditional append exhausts its
      // bounded CAS budget and the commit is REJECTED to the caller.
      storage.failHeadWrites = Number.MAX_SAFE_INTEGER;
      const rejectedReply = await grain.commit(directCommit([touch("doc2", "bob")]));
      expect(rejectedReply.failure?.kind).toBe("headMoved");
      expect(rejectedReply.revision).toBeUndefined();

      // Storage heals. The next, unrelated commit must apply ONLY its own write: the doc2 event
      // the caller was told failed must never ride along.
      storage.failHeadWrites = 0;
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
