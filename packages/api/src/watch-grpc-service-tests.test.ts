import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import { createRelationship } from "@spacedb/core/relationship";
import { zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import type { DatastoreGcOptions } from "@spacedb/grains/datastore-gc-options";
import { GrainBackedDatastore } from "@spacedb/grains/grain-backed-datastore";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "@spacedb/grains/i-datastore-grain";
import { createIsolatedWatchHub } from "@spacedb/grains/isolated-watch-hub";
import { MeshTestCluster } from "@spacedb/grains/mesh-test-cluster";
import type { RelationshipUpdateWire } from "@spacedb/grains/relationships-dtos";
import type { SpiceportGrainServices } from "@spacedb/grains/service-collection-extensions";
import {
  addSpiceportGrainServices,
  SPICEPORT_GRAIN_REGISTRATIONS,
} from "@spacedb/grains/service-collection-extensions";
import type { WatchRequest, WatchResponse } from "@spacedb/protos/permissions";
import { RelationshipUpdate_Operation } from "@spacedb/protos/permissions";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { TestCluster } from "@thresh/testing/test-cluster";
import { describe, expect, it } from "vitest";

import { CollectingStreamWriter } from "./collecting-stream-writer";
import { RpcError } from "./rpc-error";
import { WatchGrpcService } from "./watch-grpc-service";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/WatchGrpcServiceTests.cs`.
 *
 * Drives the server-streaming {@link WatchGrpcService} IN-PROCESS (no listener, no socket): a
 * collecting {@link CollectingStreamWriter} records emitted responses and signals each arrival, and
 * an `AbortSignal` stops the stream. Verifies: tailing from head sees a subsequent write with its
 * token; resuming from a pre-write token replays the write exactly once; cancellation terminates the
 * stream; and a cursor below the GC floor surfaces as FAILED_PRECONDITION.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@spacedb/grains` does not depend on `@spacedb/api` (see `data-plane-grpc-service-tests.test.ts`
 *    for the full note). It is DISTINCT from the S5 characterization file `watch-grpc-service.test.ts`,
 *    which pins the order of operations and proto translation over a scripted fake changefeed.
 *  - STREAMING SEAM. `IServerStreamWriter<T>` becomes the port-local `ServerStreamWriter<T>` and
 *    `ServerCallContext` becomes a trailing `AbortSignal`, so `FakeServerCallContext` disappears.
 *    The C#'s private `CollectingStreamWriter` (a `List` plus an unbounded `Channel`) is the shared
 *    {@link CollectingStreamWriter}, written once for this batch: its `waitForNext(timeout, watchTask)`
 *    keeps the C#'s race, so a FAULT in the watch stream surfaces as itself rather than as a timeout.
 *  - `new CancellationTokenSource(TimeSpan.FromSeconds(30))` becomes a plain `AbortController` with NO
 *    timer: vitest's per-case timeout is the backstop, and a stray timer would keep the event loop
 *    alive past the end of the run. `TimeSpan.FromSeconds(10)` on `WaitForNext` stays a real timeout,
 *    because it is the assertion's own patience.
 *  - `Assert.True(watchTask.IsCompletedSuccessfully)` after a cancel becomes "the promise RESOLVES":
 *    an aborted watch that rejected with an AbortError would be a service defect, not a test detail.
 *  - `await watchTask.WaitAsync(TimeSpan.FromSeconds(10))` is the awaited promise plus the case's own
 *    vitest timeout; TypeScript has no per-await deadline to transliterate.
 *  - GC-FLOOR CASE. It builds its OWN cluster (`Window = TimeSpan.Zero`, reminder disabled), exactly
 *    as `datastore-gc-mesh-tests.test.ts` does, because `MeshTestCluster` cannot express the C#'s
 *    directly-wired `GrainBackedDatastore(gf, hub, gcOptions: gcOptions)`. Orleans' silo-container
 *    resolution (`((InProcessSiloHandle)cluster.Primary!).SiloHost.Services`) has no counterpart: the
 *    services record returned by `addSpiceportGrainServices` IS the silo's, and the SAME options
 *    object is handed to the silo and to the facade.
 *  - `ZedTokens.FromRevision` is `zedTokenFromRevision` from `@spacedb/core/zed-tokens`.
 *  - `await using` becomes an explicit `try { ... } finally { ... }` for the cluster AND the hub: a
 *    leaked hub leaves a live heartbeat loop running past the end of the test.
 */

const SchemaText = `definition user {}
definition document {
    relation viewer: user
    permission view = viewer
}`;

function service(cluster: MeshTestCluster): WatchGrpcService {
  return new WatchGrpcService(cluster.datastore, cluster.services.schemaProvider);
}

/** `WriteViewer(cluster, doc, user)`. */
function writeViewer(cluster: MeshTestCluster, doc: string, user: string): Promise<unknown> {
  const update: RelationshipUpdateWire = {
    operation: "touch",
    relationship: {
      resourceType: "document",
      resourceId: doc,
      resourceRelation: "viewer",
      subjectType: "user",
      subjectId: user,
      subjectRelation: ELLIPSIS,
    },
  };
  return cluster.relationships.writeRelationships({ updates: [update] });
}

/** A watch request with every field the C# leaves at its proto default spelled out. */
function watchRequest(fields: Partial<WatchRequest> = {}): WatchRequest {
  return { optionalUpdateKinds: [], ...fields };
}

describe("WatchGrpcServiceTests", () => {
  it("Watch_from_head_sees_subsequent_write_with_token", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      // No start cursor -> tail from head (future writes only).
      const watchTask = svc.watch(watchRequest(), writer, controller.signal);

      await writeViewer(cluster, "doc1", "alice");

      const response = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      expect(response.changesThrough?.token ?? "").not.toBe("");
      expect(response.updates.length).toBe(1);
      const update = response.updates[0]!;
      expect(update.operation).toBe(RelationshipUpdate_Operation.OPERATION_TOUCH);
      expect(update.relationship?.resource?.objectId).toBe("doc1");
      expect(update.relationship?.subject?.object?.objectId).toBe("alice");
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it("Watch_resumes_from_pre_write_token_and_replays_the_write", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      // Capture a token at head BEFORE the write.
      const preWrite = await cluster.datastore.headRevision();
      const datastoreId = await cluster.datastore.getUniqueId();
      const startToken = zedTokenFromRevision(preWrite.revision, preWrite.schemaHash, datastoreId);

      // Write AFTER capturing the cursor.
      await writeViewer(cluster, "doc2", "bob");

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const request = watchRequest({ optionalStartCursor: { token: startToken.token } });
      const watchTask = svc.watch(request, writer, controller.signal);

      // The resumed stream must replay the already-committed write.
      const response = await writer.waitForNext(10_000);
      controller.abort();
      await watchTask;

      expect(response.updates.length).toBe(1);
      const update = response.updates[0]!;
      expect(update.relationship?.resource?.objectId).toBe("doc2");
      expect(update.relationship?.subject?.object?.objectId).toBe("bob");
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it("Watch_cancellation_stops_the_stream", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const watchTask = svc.watch(watchRequest(), writer, controller.signal);

      // No writes -> the stream is parked waiting. Cancelling must complete the task promptly.
      controller.abort();
      await expect(watchTask).resolves.toBeUndefined();

      expect(writer.collected).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  /**
   * Regression test: once reminder-driven MVCC GC has actually collected past a client's cursor,
   * `GrainBackedDatastore.watch` throws `RevisionNotFoundException` from inside the async-iterator
   * BODY - which only runs lazily on the FIRST `next()`, not on `[Symbol.asyncIterator]()`. The gRPC
   * handler must map that into FAILED_PRECONDITION (mirroring `AuthzedWatchV1Service`), not let it
   * propagate unmapped.
   */
  it("Watch_from_a_cursor_below_the_gc_floor_yields_FailedPrecondition", async () => {
    // `GcSiloConfigurator`: Window = Zero makes the floor deterministically equal to head after one
    // RunGc call, with no dependence on wall-clock timing. The reminder stays OFF so `runGc` only
    // ever runs when this test invokes it.
    const gcOptions: DatastoreGcOptions = { window: { ms: 0 }, reminderEnabled: false };
    const storage = new MemoryGrainStorage();
    let services!: SpiceportGrainServices;
    const cluster = await TestCluster.start({
      initialSilos: 1,
      grains: SPICEPORT_GRAIN_REGISTRATIONS,
      configureSilo: (builder) => {
        builder.addStorage("datastore", storage);
        let hosted: IDatastore | undefined;
        services = addSpiceportGrainServices(builder, {
          schemaText: SchemaText,
          datastoreStorage: storage,
          datastoreGcOptions: gcOptions,
          datastore: () =>
            (hosted ??= new GrainBackedDatastore(
              services.grainFactory,
              services.hub,
              undefined,
              undefined,
              gcOptions,
            )),
        });
      },
    });
    const client = await cluster.client;
    const hub = createIsolatedWatchHub(client);
    try {
      const grain = client.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
      const datastore: IDatastore = new GrainBackedDatastore(
        client,
        hub,
        undefined,
        undefined,
        gcOptions,
      );
      const svc = new WatchGrpcService(datastore, services.schemaProvider);

      // Capture a cursor, then write past it and collect everything at/below that cursor via GC.
      const staleRevision = await datastore.headRevision();
      const datastoreId = await datastore.getUniqueId();
      const staleToken = zedTokenFromRevision(
        staleRevision.revision,
        staleRevision.schemaHash,
        datastoreId,
      );

      await datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              { objectType: "document", objectId: "doc1", relation: "viewer" },
              { objectType: "user", objectId: "alice", relation: ELLIPSIS },
            ),
            operation: "create",
          },
        ]),
      );

      const floor = await grain.runGc();
      expect(floor).not.toBeUndefined();

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();
      const request = watchRequest({ optionalStartCursor: { token: staleToken.token } });

      const error = await svc
        .watch(request, writer, controller.signal)
        .then(() => undefined)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RpcError);
      expect((error as RpcError).code).toBe(status.FAILED_PRECONDITION);
    } finally {
      await hub.dispose();
      await cluster.dispose();
    }
  }, 60_000);
});
