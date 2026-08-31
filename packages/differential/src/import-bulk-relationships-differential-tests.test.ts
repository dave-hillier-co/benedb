import { status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { AuthzedPermissionsV1Service } from "@spacedb/api/authzed-permissions-v1-service";
import { RpcError } from "@spacedb/api/rpc-error";
import { MeshTestCluster } from "@spacedb/grains/mesh-test-cluster";
import type { Relationship, SubjectReference } from "@spacedb/protos/authzed/api/v1/core";
import {
  CheckPermissionRequest,
  CheckPermissionResponse_Permissionship,
  ImportBulkRelationshipsRequest,
  ReadRelationshipsRequest,
} from "@spacedb/protos/authzed/api/v1/permission_service";
import { WriteSchemaRequest } from "@spacedb/protos/authzed/api/v1/schema_service";

import {
  spiceDbAvailable,
  spiceDbSkipReason,
  useSpiceDbContainer,
} from "./spice-db-container-fixture";
import { SpiceDbGrpcClient } from "./spice-db-grpc-client";
import { resetSpiceDb } from "./spice-db-reset";

/**
 * Ported from Spiceport
 * `tests/Spiceport.Differential.Tests/ImportBulkRelationshipsDifferentialTests.cs`.
 *
 * Directed differential gate for spiceport issue #35: `ImportBulkRelationships` applies CREATE
 * semantics. Runs the SAME import streams against a real `authzed/spicedb` container and against
 * SpaceDB's in-process `AuthzedPermissionsV1Service` and asserts both agree.
 *
 * Real SpiceDB (authzed/spicedb v1.49.2), empirically observed by driving the client-streaming
 * `ImportBulkRelationships` directly over gRPC:
 *  - a duplicate row within one streamed batch -> `AlreadyExists`: "could not CREATE relationship
 *    `document:d1#viewer@user:alice`, as it already existed. If this is persistent, please switch
 *    to TOUCH operations or specify a precondition".
 *  - a duplicate across two batches of the same stream -> the same `AlreadyExists`, and the failed
 *    import is atomic across the WHOLE stream: afterwards ReadRelationships shows ZERO rows -
 *    including the clean rows of the batch that streamed before the duplicate.
 *  - a row already stored by an earlier WriteRelationships -> the same `AlreadyExists`; only the
 *    pre-existing row remains, nothing from the failed stream applies.
 *  - a clean import of 3 distinct rows across two batches -> success, `NumLoaded = 3`.
 *
 * PORT DECISIONS.
 *
 *  1. `forceLong=string`: `numLoaded` is uint64 and arrives as a STRING. `Assert.Equal(3ul, ...)`
 *     becomes `toBe("3")`, and the cross-system check compares string to string. NEVER `Number(...)`
 *     or `parseInt` on either side - a revision or count quantised through a float64 is a silent
 *     corruption.
 *  2. `FakeAsyncStreamReader<T>` has NO counterpart: SpaceDB's `importBulkRelationships` takes a
 *     plain `AsyncIterable<T>` plus a trailing optional `AbortSignal` instead of
 *     `IAsyncStreamReader` + `ServerCallContext` - the deviation already recorded in
 *     `authzed-permissions-v1-service-tests.test.ts`, whose `asyncStream` replay helper this reuses
 *     in shape rather than reinventing as a class.
 *  3. `Batches()` STAYS A FUNCTION returning a fresh array on each call, because the same batches
 *     are consumed twice (real side, then SpaceDB side) and a stateful reader or a reused async
 *     generator would silently deliver nothing the second time.
 *  4. The SpiceDB side goes through the client-streaming WIRE; the SpaceDB side goes through the
 *     in-process service. Both get the same batch boundaries - the (2 rows, then 1) split is
 *     deliberate for the cross-batch case.
 *  5. ERROR SHAPES DIFFER BY SIDE: real SpiceDB yields a grpc-js `ServiceError` (numeric `.code`,
 *     `.details`); SpaceDB throws `RpcError`. Each is asserted against its own shape.
 *  6. `[Collection(SpiceDbCollection.Name)]` -> `useSpiceDbContainer` + `describe.sequential`, with
 *     `resetSpiceDb` then `WriteSchema` per test, and an explicit `finally` cluster dispose.
 */

const fixture = useSpiceDbContainer();

const Schema = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

function subject(user: string): SubjectReference {
  return { object: { objectType: "user", objectId: user }, optionalRelation: "" };
}

function rel(doc: string, user: string): Relationship {
  return {
    resource: { objectType: "document", objectId: doc },
    relation: "viewer",
    subject: subject(user),
    optionalCaveat: undefined,
    optionalExpiresAt: undefined,
  };
}

function batch(...rels: readonly Relationship[]): ImportBulkRelationshipsRequest {
  return ImportBulkRelationshipsRequest.fromPartial({ relationships: [...rels] });
}

/** The C#'s `FakeAsyncStreamReader<T>`: replays a fixed sequence of inbound messages (decision 2). */
async function* asyncStream<T>(messages: readonly T[]): AsyncIterable<T> {
  for (const message of messages) yield message;
}

function service(cluster: MeshTestCluster): AuthzedPermissionsV1Service {
  return new AuthzedPermissionsV1Service(
    cluster.checker,
    cluster.grainFactory,
    cluster.reverseOps,
    cluster.relationshipReads,
    cluster.schemaProvider,
  );
}

/** `Assert.ThrowsAsync<RpcException>` - returns the caught reason so the caller can assert on it. */
async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe.sequential("ImportBulkRelationshipsDifferentialTests", () => {
  it("Duplicate across stream batches fails already exists and applies nothing on both systems", async (ctx) => {
    ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

    // Batch 1 is clean; the duplicate arrives in batch 2 - exercising both the AlreadyExists verdict
    // and whole-stream atomicity (batch 1's clean rows must not survive the failed import).
    const batches = (): ImportBulkRelationshipsRequest[] => [
      batch(rel("d1", "alice"), rel("d2", "bob")),
      batch(rel("d1", "alice")),
    ];

    const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
    try {
      await resetSpiceDb(spiceDbClient);
      await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema: Schema }));

      const spiceDbError = await caught(spiceDbClient.importBulkRelationships(batches()));
      expect(spiceDbError).toBeInstanceOf(Error);
      expect((spiceDbError as { code?: unknown }).code).toBe(status.ALREADY_EXISTS);
      const detail = String((spiceDbError as { details?: unknown }).details);
      expect(detail).toContain("could not CREATE relationship");
      expect(detail).toContain("document:d1#viewer@user:alice");

      const spiceDbRows = await spiceDbClient.readRelationships(
        ReadRelationshipsRequest.fromPartial({
          consistency: { fullyConsistent: true },
          relationshipFilter: { resourceType: "document" },
        }),
      );
      expect(spiceDbRows).toHaveLength(0);
    } finally {
      spiceDbClient.close();
    }

    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      const spacedbError = await caught(svc.importBulkRelationships(asyncStream(batches())));
      expect(spacedbError).toBeInstanceOf(RpcError);
      expect((spacedbError as RpcError).code).toBe(status.ALREADY_EXISTS);
      expect((spacedbError as RpcError).details).toContain("could not CREATE relationship");
      expect((spacedbError as RpcError).details).toContain("document:d1#viewer@user:alice");

      // Same whole-stream atomicity: batch 1's clean row is not visible after the failed import.
      const check = await svc.checkPermission(
        CheckPermissionRequest.fromPartial({
          consistency: { fullyConsistent: true },
          resource: { objectType: "document", objectId: "d2" },
          permission: "view",
          subject: subject("bob"),
        }),
      );
      expect(check.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("Duplicate within single batch fails already exists on both systems", async (ctx) => {
    ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

    // The duplicate sits INSIDE one batch - the remarks' observation (a), distinct from the
    // cross-batch shape above, since SpiceDB could in principle pre-validate a single batch.
    const batches = (): ImportBulkRelationshipsRequest[] => [
      batch(rel("d1", "alice"), rel("d1", "alice")),
    ];

    const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
    try {
      await resetSpiceDb(spiceDbClient);
      await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema: Schema }));

      const spiceDbError = await caught(spiceDbClient.importBulkRelationships(batches()));
      expect(spiceDbError).toBeInstanceOf(Error);
      expect((spiceDbError as { code?: unknown }).code).toBe(status.ALREADY_EXISTS);
      expect(String((spiceDbError as { details?: unknown }).details)).toContain(
        "could not CREATE relationship",
      );
    } finally {
      spiceDbClient.close();
    }

    const cluster = await MeshTestCluster.create(Schema);
    try {
      const spacedbError = await caught(
        service(cluster).importBulkRelationships(asyncStream(batches())),
      );
      expect(spacedbError).toBeInstanceOf(RpcError);
      expect((spacedbError as RpcError).code).toBe(status.ALREADY_EXISTS);
      expect((spacedbError as RpcError).details).toContain("could not CREATE relationship");
    } finally {
      await cluster.dispose();
    }
  });

  it("Clean import succeeds with matching loaded count on both systems", async (ctx) => {
    ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

    const batches = (): ImportBulkRelationshipsRequest[] => [
      batch(rel("d1", "alice"), rel("d2", "bob")),
      batch(rel("d3", "carol")),
    ];

    const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
    let spiceDbNumLoaded: string;
    try {
      await resetSpiceDb(spiceDbClient);
      await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema: Schema }));

      const spiceDbResp = await spiceDbClient.importBulkRelationships(batches());
      // uint64 under `forceLong=string`: a STRING, never `Number(...)` (decision 1).
      expect(spiceDbResp.numLoaded).toBe("3");
      spiceDbNumLoaded = spiceDbResp.numLoaded;
    } finally {
      spiceDbClient.close();
    }

    const cluster = await MeshTestCluster.create(Schema);
    try {
      const spacedbResp = await service(cluster).importBulkRelationships(asyncStream(batches()));
      expect(spacedbResp.numLoaded).toBe(spiceDbNumLoaded);
    } finally {
      await cluster.dispose();
    }
  });
});
