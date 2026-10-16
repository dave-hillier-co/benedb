import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@benedb/core/core-constants";
import { zedTokenFromRevision } from "@benedb/core/zed-tokens";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import type { RelationshipUpdateWire } from "@benedb/grains/relationships-dtos";
import { RelationshipUpdate_Operation } from "@benedb/protos/authzed/api/v1/core";
import type { RelationshipFilter } from "@benedb/protos/authzed/api/v1/permission_service";
import { RelationshipFilter as RelationshipFilterMessage } from "@benedb/protos/authzed/api/v1/permission_service";
import type { WatchRequest, WatchResponse } from "@benedb/protos/authzed/api/v1/watch_service";
import { WatchKind } from "@benedb/protos/authzed/api/v1/watch_service";
import { describe, expect, it } from "vitest";

import { AuthzedWatchV1Service } from "./authzed-watch-v1-service";
import { CollectingStreamWriter } from "./collecting-stream-writer";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/AuthzedWatchV1ServiceTests.cs`.
 *
 * Drives the server-streaming `authzed.api.v1` {@link AuthzedWatchV1Service} IN-PROCESS (no listener,
 * no socket). Verifies: tailing from head sees a subsequent write with its `changes_through` token;
 * resuming from a pre-write token replays the write exactly once; cancellation terminates the stream
 * cleanly; the `optional_object_types` filter excludes updates of other resource types;
 * `optional_relationship_filters` emit only updates matching any filter, cannot be combined with
 * `optional_object_types`, and are validated in upstream's order; and the two
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
 *  - `Assert.ThrowsAsync<RpcException>` with `ex.StatusCode` / `ex.Status.Detail` becomes
 *    `rpcErrorFrom` with the {@link RpcError}'s `code` / `details`; the `InvalidFilters` theory is
 *    an `it.each` table.
 *
 * The checkpoints-ONLY case (spiceport#43) and the expiration round trip (spiceport#39) are both
 * pinned below, following the source's fixes (`21dc4d3`, `ad647b4`).
 */

// `document#viewer` allows `user with expiration` so the expiration round trip writes a tuple the
// schema permits: SpiceDB rejects an expiring tuple on a relation without the expiration trait.
const SchemaText = `use expiration
definition user {}
definition document {
    relation viewer: user | user with expiration
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

/** `WriteViewerWithExpiration(cluster, type, id, user, expiration)` - epoch-nanos expiry. */
function writeViewerWithExpiration(
  cluster: MeshTestCluster,
  type: string,
  id: string,
  user: string,
  expirationNanos: bigint,
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
      expiration: expirationNanos,
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

/** A v1 relationship filter with every field the C# leaves at its proto default filled in. */
function relFilter(
  overrides: Parameters<typeof RelationshipFilterMessage.fromPartial>[0],
): RelationshipFilter {
  return RelationshipFilterMessage.fromPartial(overrides);
}

/** The C#'s `Assert.ThrowsAsync<RpcException>`. */
async function rpcErrorFrom(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(RpcError);
    return thrown as RpcError;
  }
  throw new Error("expected an RpcError, but the call succeeded");
}

const GroupSchema = `definition user {}
definition group {
    relation member: user
}
definition document {
    relation viewer: user | group | group#member
    permission view = viewer
}`;

/** `WriteGroupViewer(cluster, id, group, subjectRelation)`. */
function writeGroupViewer(
  cluster: MeshTestCluster,
  id: string,
  group: string,
  subjectRelation: string,
): Promise<unknown> {
  const update: RelationshipUpdateWire = {
    operation: "touch",
    relationship: {
      resourceType: "document",
      resourceId: id,
      resourceRelation: "viewer",
      subjectType: "group",
      subjectId: group,
      subjectRelation,
    },
  };
  return cluster.relationships.writeRelationships({ updates: [update] });
}

/** `InvalidFilters()`: the filter, the expected status and the expected detail, verbatim. */
const invalidFilters: ReadonlyArray<readonly [string, RelationshipFilter, status, string]> = [
  [
    "empty",
    relFilter({}),
    status.INVALID_ARGUMENT,
    "the relationship filter provided is not valid: at least one field must be set",
  ],
  [
    "id and prefix",
    relFilter({ resourceType: "document", optionalResourceId: "d", optionalResourceIdPrefix: "d" }),
    status.INVALID_ARGUMENT,
    "the relationship filter provided is not valid: resource_id and resource_id_prefix cannot be set at the same time",
  ],
  [
    "unknown resource type",
    relFilter({ resourceType: "nope" }),
    status.FAILED_PRECONDITION,
    "object definition `nope` not found",
  ],
  [
    "unknown resource relation",
    relFilter({ resourceType: "document", optionalRelation: "nope" }),
    status.FAILED_PRECONDITION,
    "relation/permission `nope` not found under definition `document`",
  ],
  [
    "unknown subject type",
    relFilter({ optionalSubjectFilter: { subjectType: "nope" } }),
    status.FAILED_PRECONDITION,
    "object definition `nope` not found",
  ],
  [
    "unknown subject relation",
    relFilter({
      optionalSubjectFilter: { subjectType: "group", optionalRelation: { relation: "nope" } },
    }),
    status.FAILED_PRECONDITION,
    "relation/permission `nope` not found under definition `group`",
  ],
];

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

  it("Watch_includes_relationship_expiration", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const watchTask = svc.watch(watchRequest(), writer, controller.signal);

      const expiresAt = new Date(Date.UTC(2099, 0, 1));
      await writeViewerWithExpiration(
        cluster,
        "document",
        "doc3",
        "dana",
        BigInt(expiresAt.getTime()) * 1_000_000n,
      );

      const response = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      expect(response.updates.length).toBe(1);
      expect(response.updates[0]?.relationship?.optionalExpiresAt).toEqual(expiresAt);
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

  it("Watch_with_relationship_filter_emits_only_matching_updates", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const request = watchRequest({
        optionalRelationshipFilters: [
          relFilter({
            resourceType: "document",
            optionalRelation: "viewer",
            optionalSubjectFilter: { subjectType: "user", optionalSubjectId: "alice" },
          }),
        ],
      });
      const watchTask = svc.watch(request, writer, controller.signal);

      // Same resource type and relation, but a different subject: filtered out server-side.
      await writeViewer(cluster, "document", "doc1", "bob");
      await writeViewer(cluster, "document", "doc2", "alice");

      const response = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      expect(response.updates.length).toBe(1);
      const update = response.updates[0]!;
      expect(update.relationship?.resource?.objectId).toBe("doc2");
      expect(update.relationship?.subject?.object?.objectId).toBe("alice");
      for (const r of writer.collected) {
        for (const u of r.updates) {
          expect(u.relationship?.subject?.object?.objectId).toBe("alice");
        }
      }
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it("Watch_with_multiple_relationship_filters_emits_updates_matching_any", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const request = watchRequest({
        optionalRelationshipFilters: [
          relFilter({ resourceType: "document", optionalResourceId: "doc1" }),
          relFilter({ resourceType: "folder", optionalResourceIdPrefix: "f" }),
        ],
      });
      const watchTask = svc.watch(request, writer, controller.signal);

      // doc2 matches neither filter; f1 matches the second; doc1 matches the first.
      await writeViewer(cluster, "document", "doc2", "alice");
      await writeViewer(cluster, "folder", "f1", "alice");
      await writeViewer(cluster, "document", "doc1", "alice");

      const first = await writer.waitForNext(10_000, watchTask);
      const second = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      expect(first.updates.map((u) => u.relationship?.resource?.objectId)).toEqual(["f1"]);
      expect(second.updates.map((u) => u.relationship?.resource?.objectId)).toEqual(["doc1"]);
      for (const r of writer.collected) {
        for (const u of r.updates) {
          expect(u.relationship?.resource?.objectId).not.toBe("doc2");
        }
      }
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it("Watch_with_both_object_types_and_relationship_filters_is_invalid_argument", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const request = watchRequest({
        optionalObjectTypes: ["document"],
        optionalRelationshipFilters: [relFilter({ resourceType: "document" })],
      });

      const error = await rpcErrorFrom(svc.watch(request, writer, controller.signal));

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe("cannot specify both object types and relationship filters");
      expect(writer.collected).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it("Watch_with_empty_subject_relation_emits_only_ellipsis_subjects", async () => {
    const cluster = await MeshTestCluster.create(GroupSchema);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      // A present-but-empty optional_relation selects only ellipsis subjects, as upstream's
      // RelationshipsFilterFromPublicFilter does (WithEllipsisRelation).
      const request = watchRequest({
        optionalRelationshipFilters: [
          relFilter({
            optionalSubjectFilter: { subjectType: "group", optionalRelation: { relation: "" } },
          }),
        ],
      });
      const watchTask = svc.watch(request, writer, controller.signal);

      await writeGroupViewer(cluster, "doc1", "eng", "member");
      await writeGroupViewer(cluster, "doc2", "eng", ELLIPSIS);

      const response = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      expect(response.updates.length).toBe(1);
      const update = response.updates[0]!;
      expect(update.relationship?.resource?.objectId).toBe("doc2");
      expect(update.relationship?.subject?.optionalRelation).toBe("");
      for (const r of writer.collected) {
        for (const u of r.updates) {
          expect(u.relationship?.resource?.objectId).not.toBe("doc1");
        }
      }
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it("Watch_with_named_subject_relation_emits_only_that_relation", async () => {
    const cluster = await MeshTestCluster.create(GroupSchema);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const request = watchRequest({
        optionalRelationshipFilters: [
          relFilter({
            optionalSubjectFilter: {
              subjectType: "group",
              optionalRelation: { relation: "member" },
            },
          }),
        ],
      });
      const watchTask = svc.watch(request, writer, controller.signal);

      await writeGroupViewer(cluster, "doc1", "eng", ELLIPSIS);
      await writeGroupViewer(cluster, "doc2", "eng", "member");

      const response = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      expect(response.updates.length).toBe(1);
      const update = response.updates[0]!;
      expect(update.relationship?.resource?.objectId).toBe("doc2");
      expect(update.relationship?.subject?.optionalRelation).toBe("member");
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it("Watch_with_absent_subject_relation_emits_any_subject_relation", async () => {
    const cluster = await MeshTestCluster.create(GroupSchema);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      const request = watchRequest({
        optionalRelationshipFilters: [
          relFilter({ optionalSubjectFilter: { subjectType: "group" } }),
        ],
      });
      const watchTask = svc.watch(request, writer, controller.signal);

      await writeGroupViewer(cluster, "doc1", "eng", "member");
      await writeGroupViewer(cluster, "doc2", "eng", ELLIPSIS);

      const first = await writer.waitForNext(10_000, watchTask);
      const second = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      expect(first.updates.map((u) => u.relationship?.resource?.objectId)).toEqual(["doc1"]);
      expect(second.updates.map((u) => u.relationship?.resource?.objectId)).toEqual(["doc2"]);
    } finally {
      await cluster.dispose();
    }
  }, 60_000);

  it.each(invalidFilters)(
    "Watch_with_invalid_relationship_filter_is_rejected (%s)",
    async (_name, filter, expectedCode, expectedDetail) => {
      const cluster = await MeshTestCluster.create(GroupSchema);
      try {
        const svc = service(cluster);

        const controller = new AbortController();
        const writer = new CollectingStreamWriter<WatchResponse>();

        const request = watchRequest({ optionalRelationshipFilters: [filter] });

        const error = await rpcErrorFrom(svc.watch(request, writer, controller.signal));

        expect(error.code).toBe(expectedCode);
        expect(error.details).toBe(expectedDetail);
        expect(writer.collected).toEqual([]);
      } finally {
        await cluster.dispose();
      }
    },
    60_000,
  );

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

  it("Watch_with_checkpoints_only_still_emits_checkpoints_with_no_content", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const controller = new AbortController();
      const writer = new CollectingStreamWriter<WatchResponse>();

      // Requesting checkpoints ONLY (no INCLUDE_RELATIONSHIP_UPDATES, no INCLUDE_SCHEMA_UPDATES):
      // the resulting WatchContent has just the checkpoints bit set. Content selection is additive
      // in name only here -- checkpoint emission is driven by commit activity, not by the content
      // mask matching anything, so this must still see a checkpoint (and never relationship
      // content). Pins issue #43.
      const request = watchRequest({
        optionalUpdateKinds: [WatchKind.WATCH_KIND_INCLUDE_CHECKPOINTS],
      });
      const watchTask = svc.watch(request, writer, controller.signal);

      await writeViewer(cluster, "document", "doc1", "alice");

      const response = await writer.waitForNext(10_000, watchTask);
      controller.abort();
      await watchTask;

      expect(response.isCheckpoint).toBe(true);
      expect(response.updates).toEqual([]);
      expect(response.changesThrough?.token ?? "").not.toBe("");
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
