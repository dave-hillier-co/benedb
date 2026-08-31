import { ELLIPSIS } from "@benedb/core/core-constants";
import { zedTokenFromRevision } from "@benedb/core/zed-tokens";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import type { RelationshipUpdateWire } from "@benedb/grains/relationships-dtos";
import { RelationshipUpdate_Operation } from "@benedb/protos/authzed/api/v1/core";
import type { WatchRequest, WatchResponse } from "@benedb/protos/authzed/api/v1/watch_service";
import { WatchKind } from "@benedb/protos/authzed/api/v1/watch_service";
import { describe, expect, it } from "vitest";

import { AuthzedWatchV1Service } from "./authzed-watch-v1-service";
import { CollectingStreamWriter } from "./collecting-stream-writer";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/AuthzedWatchV1ServiceTests.cs`.
 *
 * Drives the server-streaming `authzed.api.v1` {@link AuthzedWatchV1Service} IN-PROCESS (no listener,
 * no socket). Verifies: tailing from head sees a subsequent write with its `changes_through` token;
 * resuming from a pre-write token replays the write exactly once; cancellation terminates the stream
 * cleanly; the `optional_object_types` filter excludes updates of other resource types; and the two
 * checkpoint cases - a content response followed by a checkpoint, and a checkpoint STILL emitted when
 * the object-type filter excludes the change.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@benedb/grains` does not depend on `@benedb/api` (see `data-plane-grpc-service-tests.test.ts`
 *    for the full note). It is DISTINCT from the S5 characterization file
 *    `authzed-watch-v1-service.test.ts`, which pins the same service over a scripted fake changefeed.
 *  - TYPES COME FROM THE authzed v1 GENERATED TREE, never from `@benedb/protos/permissions`: the v0
 *    and v1 `WatchResponse` are different messages with different fields (v1 alone carries
 *    `is_checkpoint`), and crossing them would silently grade the wrong surface.
 *  - The C#'s private `CollectingStreamWriter` (a `List` plus an unbounded `Channel`) is the shared
 *    {@link CollectingStreamWriter}, written once for this batch and imported by both watch suites -
 *    the C# forks a copy per suite only because a nested private class cannot be shared.
 *  - `new CancellationTokenSource(TimeSpan.FromSeconds(30))` becomes a plain `AbortController` with NO
 *    timer (vitest's per-case timeout is the backstop); the 10s `WaitForNext` deadline stays real,
 *    because it is the assertion's own patience.
 *  - `Assert.True(watchTask.IsCompletedSuccessfully)` after a cancel becomes "the promise RESOLVES":
 *    an aborted watch that rejected with an AbortError would be a service defect, not a test detail.
 *  - `ZedTokens.FromRevision` is `zedTokenFromRevision` from `@benedb/core/zed-tokens`.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 *
 * WHAT THIS FILE DOES NOT BEAR ON. Neither checkpoint case is a checkpoints-ONLY watch (both select
 * INCLUDE_RELATIONSHIP_UPDATES as well), so nothing here confirms or contradicts spiceport#43
 * (`ResolveContent` returning checkpoints alone for a checkpoints-only watch) - the service is left
 * exactly as it stands. Nor does any case read `optional_expires_at`, so nothing here bears on
 * spiceport#39 (expiration dropped in both directions on the v1 surface).
 */

const SchemaText = `definition user {}
definition document {
    relation viewer: user
    permission view = viewer
}
definition folder {
    relation viewer: user
    permission view = viewer
}`;

function service(cluster: MeshTestCluster): AuthzedWatchV1Service {
  return new AuthzedWatchV1Service(cluster.datastore, cluster.services.schemaProvider);
}

/** `WriteViewer(cluster, type, id, user)`. */
function writeViewer(
  cluster: MeshTestCluster,
  type: string,
  id: string,
  user: string,
): Promise<unknown> {
  const update: RelationshipUpdateWire = {
    operation: "touch",
    relationship: {
      resourceType: type,
      resourceId: id,
      resourceRelation: "viewer",
      subjectType: "user",
      subjectId: user,
      subjectRelation: ELLIPSIS,
    },
  };
  return cluster.relationships.writeRelationships({ updates: [update] });
}

/** A v1 watch request with every field the C# leaves at its proto default spelled out. */
function watchRequest(fields: Partial<WatchRequest> = {}): WatchRequest {
  return {
    optionalObjectTypes: [],
    optionalRelationshipFilters: [],
    optionalUpdateKinds: [],
    ...fields,
  };
}

describe("AuthzedWatchV1ServiceTests", () => {
  it("Watch_from_head_sees_subsequent_write_with_token", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const watchTask = svc.watch(watchRequest(), writer, controller.signal);

      await writeViewer(cluster, "document", "doc1", "alice");

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

      const preWrite = await cluster.datastore.headRevision();
      const datastoreId = await cluster.datastore.getUniqueId();
      const startToken = zedTokenFromRevision(preWrite.revision, preWrite.schemaHash, datastoreId);

      await writeViewer(cluster, "document", "doc2", "bob");

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const request = watchRequest({ optionalStartCursor: { token: startToken.token } });
      const watchTask = svc.watch(request, writer, controller.signal);

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

      controller.abort();
      await expect(watchTask).resolves.toBeUndefined();

      expect(writer.collected).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it("Watch_object_type_filter_excludes_other_types", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const request = watchRequest({ optionalObjectTypes: ["document"] });
      const watchTask = svc.watch(request, writer, controller.signal);

      // A folder write must be filtered out; a document write must come through.
      await writeViewer(cluster, "folder", "f1", "alice");
      await writeViewer(cluster, "document", "doc3", "carol");

      const response = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      // The emitted response carries only the document update, never the folder update.
      expect(response.updates.length).toBe(1);
      const update = response.updates[0]!;
      expect(update.relationship?.resource?.objectType).toBe("document");
      expect(update.relationship?.resource?.objectId).toBe("doc3");

      for (const r of writer.collected) {
        for (const u of r.updates) {
          expect(u.relationship?.resource?.objectType).toBe("document");
        }
      }
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it("Watch_with_checkpoints_emits_a_checkpoint_response_after_a_change", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const request = watchRequest({
        optionalUpdateKinds: [
          WatchKind.WATCH_KIND_INCLUDE_RELATIONSHIP_UPDATES,
          WatchKind.WATCH_KIND_INCLUDE_CHECKPOINTS,
        ],
      });
      const watchTask = svc.watch(request, writer, controller.signal);

      await writeViewer(cluster, "document", "doc1", "alice");

      // First the content response, then the checkpoint marking the revision progressed through.
      const content = await writer.waitForNext(10_000, watchTask);
      const checkpoint = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      expect(content.isCheckpoint).toBe(false);
      expect(content.updates.length).toBe(1);
      expect(checkpoint.isCheckpoint).toBe(true);
      expect(checkpoint.updates).toEqual([]);
      expect(checkpoint.changesThrough?.token ?? "").not.toBe("");
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it("Watch_with_checkpoints_emits_checkpoint_even_when_filter_excludes_the_change", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const request = watchRequest({
        optionalObjectTypes: ["document"],
        optionalUpdateKinds: [
          WatchKind.WATCH_KIND_INCLUDE_RELATIONSHIP_UPDATES,
          WatchKind.WATCH_KIND_INCLUDE_CHECKPOINTS,
        ],
      });
      const watchTask = svc.watch(request, writer, controller.signal);

      // A folder write is filtered out of content, but the checkpoint must still surface so the
      // consumer sees the revision advanced (liveness for a filtered subset).
      await writeViewer(cluster, "folder", "f1", "alice");

      const first = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      expect(first.isCheckpoint).toBe(true);
      expect(first.updates).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 60_000);
});
