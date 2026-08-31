import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import {
  DispatchFailedException,
  type DispatchErrorCode,
} from "@benedb/grains/dispatch-failed-exception";
import type {
  BatchCheckItem,
  BatchCheckResult,
  IPermissionChecker,
  PermissionCheckResult,
} from "@benedb/grains/i-permission-checker";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import {
  AlgebraicSubjectSet_Operation,
  RelationshipUpdate_Operation,
  type PermissionRelationshipTree,
  type SubjectReference,
} from "@benedb/protos/authzed/api/v1/core";
import {
  CheckBulkPermissionsRequest,
  CheckPermissionRequest,
  CheckPermissionResponse_Permissionship,
  DeleteRelationshipsRequest,
  ExpandPermissionTreeRequest,
  ExportBulkRelationshipsRequest,
  ImportBulkRelationshipsRequest,
  LookupPermissionship,
  LookupResourcesRequest,
  LookupSubjectsRequest,
  Precondition_Operation,
  ReadRelationshipsRequest,
  WriteRelationshipsRequest,
  type CheckBulkPermissionsRequestItem,
  type ExportBulkRelationshipsResponse,
  type LookupResourcesResponse,
  type LookupSubjectsResponse,
  type ReadRelationshipsResponse,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { describe, expect, it } from "vitest";

import { AuthzedPermissionsV1Service } from "./authzed-permissions-v1-service";
import { CollectingStreamWriter } from "./collecting-stream-writer";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/AuthzedPermissionsV1ServiceTests.cs`.
 *
 * Drives the `authzed.api.v1` {@link AuthzedPermissionsV1Service} IN-PROCESS (no Kestrel, no
 * socket, no host): the service is constructed with the in-process {@link MeshTestCluster}'s
 * `IPermissionChecker` and grain factory, and server-streaming RPCs are drained through the shared
 * {@link CollectingStreamWriter}. Verifies the v1 proto <-> grain mapping: permissionship +
 * partial-caveat-info, preconditions, the nested v1 relationship filter, internal cursor paging,
 * and the modern + deprecated lookup-subject fields.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@benedb/grains` does not depend on `@benedb/api`. Same deviation as the sibling
 *    `*-tests.test.ts` files in this directory.
 *  - DISTINCT FROM `authzed-permissions-v1-service.test.ts`, the S5 characterization file over
 *    fakes. Both are kept: that one pins the translation/guard-order/limit arithmetic over fake
 *    collaborators, this one grades the same service against the real mesh.
 *  - `FakeServerCallContext : ServerCallContext` DISAPPEARS: the ported methods take a trailing
 *    optional `AbortSignal`, and the only member the C# read off the context was its
 *    `CancellationToken`, so every call here passes nothing.
 *  - `IServerStreamWriter<T>` becomes the {@link CollectingStreamWriter} seam settled in batch 4;
 *    `IAsyncStreamReader<T>` (the C#'s `FakeAsyncStreamReader`) becomes a plain `AsyncIterable<T>`,
 *    spelled here as {@link asyncStream}.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - Seeding goes through the datastore with CORE types (`createRelationship` + `ObjectAndRelation`
 *    + `ELLIPSIS`), never the wire DTOs.
 *  - `Google.Protobuf.WellKnownTypes.Struct` + `Value.ForString(...)` becomes a plain object: a
 *    ts-proto `Struct` field arrives auto-unwrapped. The 30_000/5000-char blobs are kept exactly,
 *    and the service measures them in SERIALIZED BYTES (`Struct.encode(...)`), never char count.
 *  - `resp.PartialCaveatInfo` / `resp.CheckedAt` being `null` in C# is `undefined` here (ts-proto
 *    renders an absent message field as `undefined`).
 *  - `V1::CheckBulkPermissionsPair.ResponseOneofCase.Item` / `.Error` become "the `item` sibling
 *    field is defined" / "the `error` sibling field is defined": ts-proto renders a oneof as
 *    optional sibling fields.
 *  - `PermissionRelationshipTree.TreeTypeOneofCase` is the same rendering, so
 *    {@link collectLeafSubjects} walks the `leaf` / `intermediate` siblings.
 *  - `Assert.Equal(3ul, resp.NumLoaded)`: `num_loaded` is uint64, which ts-proto renders as a
 *    STRING, so the assertion is against `"3"`.
 *  - The `[Theory]/[InlineData]` over `DispatchErrorCode` becomes an `it.each` over the four
 *    (code, status) pairs; `DispatchErrorCode` is a string-literal union in the port.
 *  - This file writes relationships carrying NO expiration, so it neither confirms nor contradicts
 *    spiceport#39 (v1 expiration dropped in both directions); no expiration handling is added to
 *    the service on its account.
 */

const Schema = `definition user {}

caveat over_limit(limit int, requested int) {
    requested <= limit
}

definition document {
    relation viewer: user | user with over_limit
    relation editor: user
    permission view = viewer + editor
}`;

function service(cluster: MeshTestCluster): AuthzedPermissionsV1Service {
  return new AuthzedPermissionsV1Service(
    cluster.checker,
    cluster.grainFactory,
    cluster.reverseOps,
    cluster.relationshipReads,
    cluster.schemaProvider,
  );
}

function onr(objectType: string, objectId: string, relation: string): ObjectAndRelation {
  return { objectType, objectId, relation };
}

async function seed(
  datastore: IDatastore,
  ...tuples: readonly (readonly [res: string, rel: string, subj: string])[]
): Promise<void> {
  const updates: RelationshipUpdate[] = tuples.map(([res, rel, subj]) => ({
    relationship: createRelationship(onr("document", res, rel), onr("user", subj, ELLIPSIS)),
    operation: "touch",
  }));
  await datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

async function seedCaveatedViewer(datastore: IDatastore, res: string, subj: string): Promise<void> {
  const relationship = createRelationship(
    onr("document", res, "viewer"),
    onr("user", subj, ELLIPSIS),
    { caveatName: "over_limit" },
  );
  await datastore.readWriteTx((tx) =>
    tx.writeRelationships([{ relationship, operation: "touch" }]),
  );
}

function userSubject(id: string): SubjectReference {
  return { object: { objectType: "user", objectId: id }, optionalRelation: "" };
}

function bulkItem(doc: string, perm: string, user: string): CheckBulkPermissionsRequestItem {
  return {
    resource: { objectType: "document", objectId: doc },
    permission: perm,
    subject: userSubject(user),
    context: undefined,
  };
}

function importBatch(
  ...tuples: readonly (readonly [doc: string, user: string])[]
): ImportBulkRelationshipsRequest {
  return ImportBulkRelationshipsRequest.fromPartial({
    relationships: tuples.map(([doc, user]) => ({
      resource: { objectType: "document", objectId: doc },
      relation: "viewer",
      subject: userSubject(user),
    })),
  });
}

function writeReq(
  operation: RelationshipUpdate_Operation,
  doc: string,
  user: string,
): WriteRelationshipsRequest {
  return WriteRelationshipsRequest.fromPartial({
    updates: [
      {
        operation,
        relationship: {
          resource: { objectType: "document", objectId: doc },
          relation: "viewer",
          subject: userSubject(user),
        },
      },
    ],
  });
}

/** The C#'s `FakeAsyncStreamReader<T>`: replays a fixed sequence of inbound messages. */
async function* asyncStream<T>(...messages: readonly T[]): AsyncIterable<T> {
  for (const message of messages) yield message;
}

/** `Assert.ThrowsAsync<RpcException>` - returns the error so the caller can assert on it. */
async function expectRpcError(promise: Promise<unknown>): Promise<RpcError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError;
}

/** `CollectLeafSubjects`: every concrete subject id in some leaf's DirectSubjectSet. */
function collectLeafSubjects(tree: PermissionRelationshipTree): string[] {
  if (tree.leaf !== undefined) {
    return tree.leaf.subjects.map((s) => s.object?.objectId ?? "");
  }
  if (tree.intermediate !== undefined) {
    return tree.intermediate.children.flatMap((child) => collectLeafSubjects(child));
  }
  return [];
}

/** An {@link IPermissionChecker} that always throws the supplied error. */
class ThrowingChecker implements IPermissionChecker {
  readonly #error: unknown;

  constructor(error: unknown) {
    this.#error = error;
  }

  check(): Promise<PermissionCheckResult> {
    throw this.#error;
  }

  batchCheck(_items: readonly BatchCheckItem[]): Promise<BatchCheckResult> {
    throw this.#error;
  }
}

describe("AuthzedPermissionsV1ServiceTests", () => {
  it("CheckPermission member has permission", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"]);

      const resp = await service(cluster).checkPermission(
        CheckPermissionRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
          subject: userSubject("alice"),
        }),
      );

      expect(resp.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
      expect(resp.checkedAt?.token).toBeTruthy();
      expect(resp.partialCaveatInfo).toBeUndefined();
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckPermission non-member has no permission", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"]);

      const resp = await service(cluster).checkPermission(
        CheckPermissionRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
          subject: userSubject("bob"),
        }),
      );

      expect(resp.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckPermission unknown definition is failed precondition", async () => {
    // An unknown resource definition is a client schema/typo bug. SpiceDB validates up front with
    // CheckNamespaceAndRelations and returns FailedPrecondition, NOT a NO_PERMISSION verdict.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const error = await expectRpcError(
        service(cluster).checkPermission(
          CheckPermissionRequest.fromPartial({
            resource: { objectType: "nonesuch", objectId: "readme" },
            permission: "view",
            subject: userSubject("alice"),
          }),
        ),
      );

      expect(error.code).toBe(status.FAILED_PRECONDITION);
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckPermission unknown permission is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const error = await expectRpcError(
        service(cluster).checkPermission(
          CheckPermissionRequest.fromPartial({
            resource: { objectType: "document", objectId: "readme" },
            permission: "no_such_permission",
            subject: userSubject("alice"),
          }),
        ),
      );

      expect(error.code).toBe(status.FAILED_PRECONDITION);
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckPermission unknown subject definition is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const error = await expectRpcError(
        service(cluster).checkPermission(
          CheckPermissionRequest.fromPartial({
            resource: { objectType: "document", objectId: "readme" },
            permission: "view",
            subject: { object: { objectType: "ghost", objectId: "alice" } },
          }),
        ),
      );

      expect(error.code).toBe(status.FAILED_PRECONDITION);
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckPermission wildcard subject is invalid argument", async () => {
    // A "*"-id subject is not a valid thing to check (SpiceDB: checkInternal returns
    // NewWildcardNotAllowedErr -> InvalidArgument). It must be rejected up front rather than
    // silently evaluated (where it could even match a stored wildcard tuple).
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"]);

      const error = await expectRpcError(
        service(cluster).checkPermission(
          CheckPermissionRequest.fromPartial({
            resource: { objectType: "document", objectId: "readme" },
            permission: "view",
            subject: userSubject("*"),
          }),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain("cannot perform check on wildcard subject");
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckBulkPermissions wildcard subject is a per-pair error", async () => {
    // SpiceDB's CheckBulkPermissions validates each pair independently and reports a bad pair via
    // that pair's google.rpc.Status error (CheckBulkPermissionsPair_Error), NOT by failing the
    // whole RPC. A wildcard ("*") check subject in one item must therefore error ONLY that pair;
    // valid items still return their verdict.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"]);

      const req = CheckBulkPermissionsRequest.fromPartial({});
      req.items.push(bulkItem("readme", "view", "alice"));
      req.items.push(bulkItem("readme", "view", "*"));

      const resp = await service(cluster).checkBulkPermissions(req);

      expect(resp.pairs).toHaveLength(2);
      expect(resp.pairs[0]?.item).toBeDefined();
      expect(resp.pairs[0]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );

      expect(resp.pairs[1]?.error).toBeDefined();
      expect(resp.pairs[1]?.error?.code).toBe(status.INVALID_ARGUMENT);
      expect(resp.pairs[1]?.error?.message).toContain("cannot perform check on wildcard subject");
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckBulkPermissions unknown definition is a per-pair error", async () => {
    // An unknown resource definition is a client schema/typo bug for that one pair: SpiceDB
    // surfaces it as ERROR_REASON_UNKNOWN_DEFINITION in the pair's error (FailedPrecondition code),
    // not a whole-RPC failure and not a silent NO_PERMISSION verdict.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"]);

      const req = CheckBulkPermissionsRequest.fromPartial({});
      req.items.push(bulkItem("readme", "view", "alice"));
      req.items.push({
        resource: { objectType: "missing_type", objectId: "x" },
        permission: "view",
        subject: userSubject("alice"),
        context: undefined,
      });

      const resp = await service(cluster).checkBulkPermissions(req);

      expect(resp.pairs).toHaveLength(2);
      expect(resp.pairs[0]?.item).toBeDefined();
      expect(resp.pairs[0]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );

      expect(resp.pairs[1]?.error).toBeDefined();
      expect(resp.pairs[1]?.error?.code).toBe(status.FAILED_PRECONDITION);
      expect(resp.pairs[1]?.error?.message).toContain("missing_type");
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckBulkPermissions unknown relation is a per-pair error", async () => {
    // An unknown relation/permission on a known definition is
    // ERROR_REASON_UNKNOWN_RELATION_OR_PERMISSION per pair (FailedPrecondition code), again leaving
    // sibling valid pairs untouched.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"]);

      const req = CheckBulkPermissionsRequest.fromPartial({});
      req.items.push(bulkItem("readme", "nonexistent_perm", "alice"));
      req.items.push(bulkItem("readme", "view", "alice"));

      const resp = await service(cluster).checkBulkPermissions(req);

      expect(resp.pairs).toHaveLength(2);
      expect(resp.pairs[0]?.error).toBeDefined();
      expect(resp.pairs[0]?.error?.code).toBe(status.FAILED_PRECONDITION);
      expect(resp.pairs[0]?.error?.message).toContain("nonexistent_perm");

      expect(resp.pairs[1]?.item).toBeDefined();
      expect(resp.pairs[1]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckBulkPermissions all pairs invalid emits no token", async () => {
    // When every pair fails validation no revision is pinned (nothing is dispatched), so the
    // response carries per-pair errors and no batch CheckedAt token.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = CheckBulkPermissionsRequest.fromPartial({});
      req.items.push(bulkItem("readme", "nonexistent_perm", "alice"));

      const resp = await service(cluster).checkBulkPermissions(req);

      expect(resp.pairs).toHaveLength(1);
      expect(resp.pairs[0]?.error).toBeDefined();
      expect(resp.checkedAt).toBeUndefined();
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships create of an existing relationship is already exists", async () => {
    // A CREATE on an already-existing relationship is a permanent duplicate-create: AlreadyExists,
    // distinct from a transient write-write serialization conflict (which maps to Aborted).
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await service(cluster).writeRelationships(
        writeReq(RelationshipUpdate_Operation.OPERATION_CREATE, "readme", "alice"),
      );

      const error = await expectRpcError(
        service(cluster).writeRelationships(
          writeReq(RelationshipUpdate_Operation.OPERATION_CREATE, "readme", "alice"),
        ),
      );

      expect(error.code).toBe(status.ALREADY_EXISTS);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships duplicate relationship is invalid argument", async () => {
    // A relationship may appear in an update only once per request (SpiceDB:
    // NewDuplicateRelationshipErr -> InvalidArgument). The key ignores caveat/expiration, so a
    // CREATE + DELETE of the same tuple in one request is a duplicate too.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = WriteRelationshipsRequest.fromPartial({
        updates: [
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              relation: "viewer",
              subject: userSubject("alice"),
            },
          },
          {
            operation: RelationshipUpdate_Operation.OPERATION_DELETE,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              relation: "viewer",
              subject: userSubject("alice"),
            },
          },
        ],
      });

      const error = await expectRpcError(service(cluster).writeRelationships(req));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain("more than one update with relationship");
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships two touches of the same tuple is invalid argument", async () => {
    // Verified against real SpiceDB (authzed/spicedb v1.49.2): two TOUCH updates for the identical
    // tuple in one request reject with InvalidArgument and this exact message, not silent dedup.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = writeReq(RelationshipUpdate_Operation.OPERATION_TOUCH, "readme", "alice");
      req.updates.push({
        operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
        relationship: {
          resource: { objectType: "document", objectId: "readme" },
          relation: "viewer",
          subject: userSubject("alice"),
          optionalCaveat: undefined,
          optionalExpiresAt: undefined,
        },
      });

      const error = await expectRpcError(service(cluster).writeRelationships(req));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain("more than one update with relationship");
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships create then touch of the same tuple is invalid argument", async () => {
    // Verified against real SpiceDB: mixing CREATE and TOUCH for the same tuple in one request is
    // ALSO a duplicate -- the key is the bare tuple, independent of operation kind.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = WriteRelationshipsRequest.fromPartial({
        updates: [
          {
            operation: RelationshipUpdate_Operation.OPERATION_CREATE,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              relation: "editor",
              subject: userSubject("alice"),
            },
          },
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              relation: "editor",
              subject: userSubject("alice"),
            },
          },
        ],
      });

      const error = await expectRpcError(service(cluster).writeRelationships(req));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain("more than one update with relationship");
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships two touches differing only by caveat context is invalid argument", async () => {
    // Verified against real SpiceDB: two updates for the same (resource, relation, subject) that
    // differ ONLY in caveat name/context are still a duplicate -- the dedup key is computed WITHOUT
    // the caveat (SpiceDB's V1StringRelationshipWithoutCaveatOrExpiration).
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = WriteRelationshipsRequest.fromPartial({
        updates: [
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              relation: "viewer",
              subject: userSubject("alice"),
              optionalCaveat: { caveatName: "over_limit" },
            },
          },
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              relation: "viewer",
              subject: userSubject("alice"),
              // No caveat on the second update -- still the same underlying tuple key.
            },
          },
        ],
      });

      const error = await expectRpcError(service(cluster).writeRelationships(req));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain("more than one update with relationship");
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships non-duplicate updates are unaffected", async () => {
    // Distinct tuples (different relation, different subject) in the same request are unaffected by
    // the duplicate check and both apply.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = WriteRelationshipsRequest.fromPartial({
        updates: [
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              relation: "editor",
              subject: userSubject("alice"),
            },
          },
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              relation: "editor",
              subject: userSubject("bob"),
            },
          },
        ],
      });

      const resp = await service(cluster).writeRelationships(req);

      expect(resp.writtenAt?.token).toBeTruthy();
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships too many updates is invalid argument", async () => {
    // More than MaxUpdatesPerWrite (1000) updates is rejected up front with InvalidArgument
    // (SpiceDB: NewExceedsMaximumUpdatesErr). The C# loop is `i <= 1000`, i.e. 1001 updates.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = WriteRelationshipsRequest.fromPartial({});
      for (let i = 0; i <= 1000; i += 1) {
        req.updates.push({
          operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
          relationship: {
            resource: { objectType: "document", objectId: `doc${i}` },
            relation: "viewer",
            subject: userSubject("alice"),
            optionalCaveat: undefined,
            optionalExpiresAt: undefined,
          },
        });
      }

      const error = await expectRpcError(service(cluster).writeRelationships(req));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain("too many updates");
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships too many preconditions is invalid argument", async () => {
    // More than MaxPreconditionsCount (1000) preconditions is rejected with InvalidArgument
    // (SpiceDB: NewExceedsMaximumPreconditionsErr). The C# loop is `i <= 1000`, i.e. 1001.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = writeReq(RelationshipUpdate_Operation.OPERATION_TOUCH, "readme", "alice");
      for (let i = 0; i <= 1000; i += 1) {
        req.optionalPreconditions.push({
          operation: Precondition_Operation.OPERATION_MUST_MATCH,
          filter: {
            resourceType: "document",
            optionalResourceId: `doc${i}`,
            optionalResourceIdPrefix: "",
            optionalRelation: "",
            optionalSubjectFilter: undefined,
          },
        });
      }

      const error = await expectRpcError(service(cluster).writeRelationships(req));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain("precondition count");
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships oversized relationship caveat context is invalid argument", async () => {
    // A per-relationship caveat context larger than MaxRelationshipContextSize (25000 bytes) is
    // rejected with InvalidArgument (SpiceDB: NewMaxRelationshipContextError).
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const context = { blob: "x".repeat(30_000) };

      const req = WriteRelationshipsRequest.fromPartial({
        updates: [
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              relation: "viewer",
              subject: userSubject("alice"),
              optionalCaveat: { caveatName: "over_limit", context },
            },
          },
        ],
      });

      const error = await expectRpcError(service(cluster).writeRelationships(req));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain("exceeded maximum allowed caveat size");
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckPermission oversized caveat context is invalid argument", async () => {
    // A request caveat context larger than MaxCaveatContextSize (4096 bytes) is rejected with
    // InvalidArgument (SpiceDB: GetCaveatContext).
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const error = await expectRpcError(
        service(cluster).checkPermission(
          CheckPermissionRequest.fromPartial({
            resource: { objectType: "document", objectId: "readme" },
            permission: "view",
            subject: userSubject("alice"),
            context: { blob: "x".repeat(5000) },
          }),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain("request caveat context should have less than");
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckBulkPermissions oversized caveat context is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = CheckBulkPermissionsRequest.fromPartial({});
      const item = bulkItem("readme", "view", "alice");
      item.context = { blob: "x".repeat(5000) };
      req.items.push(item);

      const error = await expectRpcError(service(cluster).checkBulkPermissions(req));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain("request caveat context should have less than");
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckPermission caveated with missing context populates partialCaveatInfo", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seedCaveatedViewer(cluster.datastore, "readme", "alice");

      // No context supplied: the caveat cannot be fully evaluated -> conditional + missing fields.
      const resp = await service(cluster).checkPermission(
        CheckPermissionRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
          subject: userSubject("alice"),
        }),
      );

      expect(resp.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION,
      );
      expect(resp.partialCaveatInfo).toBeDefined();
      expect(resp.partialCaveatInfo?.missingRequiredContext.length).toBeGreaterThan(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckPermission invalid consistency token is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const error = await expectRpcError(
        service(cluster).checkPermission(
          CheckPermissionRequest.fromPartial({
            resource: { objectType: "document", objectId: "readme" },
            permission: "view",
            subject: userSubject("alice"),
            consistency: { atExactSnapshot: { token: "not-a-real-token" } },
          }),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships writes and returns a token", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const resp = await service(cluster).writeRelationships(
        writeReq(RelationshipUpdate_Operation.OPERATION_TOUCH, "readme", "alice"),
      );

      expect(resp.writtenAt?.token).toBeTruthy();

      const check = await service(cluster).checkPermission(
        CheckPermissionRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
          subject: userSubject("alice"),
        }),
      );
      expect(check.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships unspecified operation is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const error = await expectRpcError(
        service(cluster).writeRelationships(
          writeReq(RelationshipUpdate_Operation.OPERATION_UNSPECIFIED, "readme", "alice"),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships MUST_MATCH precondition succeeds and fails", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"]);
      const svc = service(cluster);

      // MUST_MATCH on an existing relationship -> success.
      const ok = writeReq(RelationshipUpdate_Operation.OPERATION_TOUCH, "readme", "bob");
      ok.optionalPreconditions.push({
        operation: Precondition_Operation.OPERATION_MUST_MATCH,
        filter: {
          resourceType: "document",
          optionalResourceId: "readme",
          optionalResourceIdPrefix: "",
          optionalRelation: "",
          optionalSubjectFilter: undefined,
        },
      });
      const resp = await svc.writeRelationships(ok);
      expect(resp.writtenAt?.token).toBeTruthy();

      // MUST_MATCH on a non-existent resource -> FailedPrecondition.
      const bad = writeReq(RelationshipUpdate_Operation.OPERATION_TOUCH, "other", "carol");
      bad.optionalPreconditions.push({
        operation: Precondition_Operation.OPERATION_MUST_MATCH,
        filter: {
          resourceType: "document",
          optionalResourceId: "missing",
          optionalResourceIdPrefix: "",
          optionalRelation: "",
          optionalSubjectFilter: undefined,
        },
      });
      const error = await expectRpcError(svc.writeRelationships(bad));
      expect(error.code).toBe(status.FAILED_PRECONDITION);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships MUST_NOT_MATCH precondition failure is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"]);

      const req = writeReq(RelationshipUpdate_Operation.OPERATION_TOUCH, "readme", "bob");
      req.optionalPreconditions.push({
        operation: Precondition_Operation.OPERATION_MUST_NOT_MATCH,
        filter: {
          resourceType: "document",
          optionalResourceId: "readme",
          optionalResourceIdPrefix: "",
          optionalRelation: "",
          optionalSubjectFilter: undefined,
        },
      });

      const error = await expectRpcError(service(cluster).writeRelationships(req));
      expect(error.code).toBe(status.FAILED_PRECONDITION);
    } finally {
      await cluster.dispose();
    }
  });

  it("ReadRelationships streams all with readAt and the nested subject filter", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "alice"],
        ["readme", "viewer", "bob"],
        ["readme", "editor", "carol"],
      );
      const svc = service(cluster);

      // Resource filter only: all three viewer/editor relationships on readme.
      const allWriter = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
        }),
        allWriter,
      );

      expect(allWriter.collected).toHaveLength(3);
      for (const r of allWriter.collected) expect(r.readAt?.token).toBeTruthy();

      // Nested subject filter narrows to a single subject id.
      const narrowWriter = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({
          relationshipFilter: {
            resourceType: "document",
            optionalResourceId: "readme",
            optionalRelation: "viewer",
            optionalSubjectFilter: { subjectType: "user", optionalSubjectId: "alice" },
          },
        }),
        narrowWriter,
      );

      expect(narrowWriter.collected).toHaveLength(1);
      const only = narrowWriter.collected[0];
      expect(only?.relationship?.subject?.object?.objectId).toBe("alice");
      expect(only?.relationship?.relation).toBe("viewer");
    } finally {
      await cluster.dispose();
    }
  });

  it("DeleteRelationships deletes matching relationships and returns a token", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"], ["readme", "viewer", "bob"]);
      const svc = service(cluster);

      const resp = await svc.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
        }),
      );

      expect(resp.deletedAt?.token).toBeTruthy();

      const after = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
        }),
        after,
      );
      expect(after.collected).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("DeleteRelationships precondition failure is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"]);

      const req = DeleteRelationshipsRequest.fromPartial({
        relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
      });
      req.optionalPreconditions.push({
        operation: Precondition_Operation.OPERATION_MUST_NOT_MATCH,
        filter: {
          resourceType: "document",
          optionalResourceId: "readme",
          optionalResourceIdPrefix: "",
          optionalRelation: "",
          optionalSubjectFilter: undefined,
        },
      });

      const error = await expectRpcError(service(cluster).deleteRelationships(req));
      expect(error.code).toBe(status.FAILED_PRECONDITION);
    } finally {
      await cluster.dispose();
    }
  });

  it("LookupResources streams the accessible resources", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["doc1", "viewer", "alice"],
        ["doc2", "editor", "alice"],
        ["doc3", "viewer", "bob"],
      );

      const writer = new CollectingStreamWriter<LookupResourcesResponse>();
      await service(cluster).lookupResources(
        LookupResourcesRequest.fromPartial({
          resourceObjectType: "document",
          permission: "view",
          subject: userSubject("alice"),
        }),
        writer,
      );

      const ids = writer.collected.map((r) => r.resourceObjectId).sort();
      expect(ids).toEqual(["doc1", "doc2"]);
      for (const r of writer.collected) {
        expect(r.permissionship).toBe(LookupPermissionship.LOOKUP_PERMISSIONSHIP_HAS_PERMISSION);
        expect(r.lookedUpAt?.token).toBeTruthy();
      }
    } finally {
      await cluster.dispose();
    }
  });

  it("LookupSubjects populates the modern and the deprecated fields", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"], ["readme", "editor", "bob"]);

      const writer = new CollectingStreamWriter<LookupSubjectsResponse>();
      await service(cluster).lookupSubjects(
        LookupSubjectsRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
          subjectObjectType: "user",
        }),
        writer,
      );

      const ids = writer.collected.map((r) => r.subject?.subjectObjectId ?? "").sort();
      expect(ids).toEqual(["alice", "bob"]);

      // Both the modern ResolvedSubject and the deprecated mirror fields are populated.
      for (const r of writer.collected) {
        expect(r.subjectObjectId).toBe(r.subject?.subjectObjectId);
        expect(r.subject?.permissionship).toBe(
          LookupPermissionship.LOOKUP_PERMISSIONSHIP_HAS_PERMISSION,
        );
        expect(r.permissionship).toBe(LookupPermissionship.LOOKUP_PERMISSIONSHIP_HAS_PERMISSION);
      }
    } finally {
      await cluster.dispose();
    }
  });

  it("ExpandPermissionTree returns a union tree with leaves", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"], ["readme", "editor", "bob"]);

      const resp = await service(cluster).expandPermissionTree(
        ExpandPermissionTreeRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
        }),
      );

      expect(resp.treeRoot).toBeDefined();
      expect(resp.treeRoot?.expandedObject?.objectId).toBe("readme");
      expect(resp.treeRoot?.expandedRelation).toBe("view");
      expect(resp.treeRoot?.intermediate).toBeDefined();
      expect(resp.treeRoot?.leaf).toBeUndefined();
      expect(resp.treeRoot?.intermediate?.operation).toBe(
        AlgebraicSubjectSet_Operation.OPERATION_UNION,
      );

      // Every concrete subject lands in some leaf's DirectSubjectSet.
      const subjectIds = new Set(collectLeafSubjects(resp.treeRoot!));
      expect(subjectIds.has("alice")).toBe(true);
      expect(subjectIds.has("bob")).toBe(true);
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckBulkPermissions preserves item order with one token", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"]);

      const req = CheckBulkPermissionsRequest.fromPartial({});
      req.items.push(bulkItem("readme", "view", "alice")); // member
      req.items.push(bulkItem("readme", "view", "bob")); // non-member
      req.items.push(bulkItem("other", "view", "alice")); // non-member (no rel)

      const resp = await service(cluster).checkBulkPermissions(req);

      expect(resp.checkedAt?.token).toBeTruthy();
      expect(resp.pairs).toHaveLength(3);

      // Order preserved and each pair echoes its originating request.
      expect(resp.pairs[0]?.request?.subject?.object?.objectId).toBe("alice");
      expect(resp.pairs[1]?.request?.subject?.object?.objectId).toBe("bob");
      expect(resp.pairs[2]?.request?.resource?.objectId).toBe("other");

      expect(resp.pairs[0]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
      expect(resp.pairs[1]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );
      expect(resp.pairs[2]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );

      // One pinned revision -> all pairs share the single batch token.
      for (const pair of resp.pairs) expect(pair.item).toBeDefined();
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckBulkPermissions caveated item carries partialCaveatInfo", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seedCaveatedViewer(cluster.datastore, "readme", "alice");

      const req = CheckBulkPermissionsRequest.fromPartial({});
      req.items.push(bulkItem("readme", "view", "alice"));

      const resp = await service(cluster).checkBulkPermissions(req);

      expect(resp.pairs).toHaveLength(1);
      const pair = resp.pairs[0];
      expect(pair?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION,
      );
      expect(pair?.item?.partialCaveatInfo).toBeDefined();
      expect(pair?.item?.partialCaveatInfo?.missingRequiredContext.length).toBeGreaterThan(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("CheckBulkPermissions invalid consistency token is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = CheckBulkPermissionsRequest.fromPartial({
        consistency: { atExactSnapshot: { token: "not-a-real-token" } },
      });
      req.items.push(bulkItem("readme", "view", "alice"));

      const error = await expectRpcError(service(cluster).checkBulkPermissions(req));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
    } finally {
      await cluster.dispose();
    }
  });

  it("ImportBulkRelationships loads across batches and returns the count", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);
      const reader = asyncStream(
        importBatch(["doc1", "alice"], ["doc1", "bob"]),
        ImportBulkRelationshipsRequest.fromPartial({}), // empty batch -> skipped, no empty tx
        importBatch(["doc2", "carol"]),
      );

      const resp = await svc.importBulkRelationships(reader);

      // uint64 on the wire: ts-proto renders it as a string.
      expect(resp.numLoaded).toBe("3");

      // The imported relationships are visible via a check.
      const check = await svc.checkPermission(
        CheckPermissionRequest.fromPartial({
          resource: { objectType: "document", objectId: "doc2" },
          permission: "view",
          subject: userSubject("carol"),
        }),
      );
      expect(check.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("ImportBulkRelationships duplicate in the stream is already exists and applies nothing", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      // The duplicate sits in a LATER batch than a clean row: real SpiceDB rejects the whole stream
      // and applies nothing from it, including earlier batches (observed v1.49.2).
      const reader = asyncStream(
        importBatch(["doc1", "alice"], ["doc2", "bob"]),
        importBatch(["doc1", "alice"]),
      );

      const error = await expectRpcError(svc.importBulkRelationships(reader));

      expect(error.code).toBe(status.ALREADY_EXISTS);
      expect(error.details).toContain("could not CREATE relationship");
      expect(error.details).toContain("document:doc1#viewer@user:alice");
      expect(error.details).toContain("already existed");

      // Whole-stream atomicity: the clean row from the first batch must not be visible.
      const check = await svc.checkPermission(
        CheckPermissionRequest.fromPartial({
          consistency: { fullyConsistent: true },
          resource: { objectType: "document", objectId: "doc2" },
          permission: "view",
          subject: userSubject("bob"),
        }),
      );
      expect(check.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("ImportBulkRelationships pre-existing row is already exists", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(cluster.datastore, ["doc1", "viewer", "alice"]);
      const svc = service(cluster);

      const reader = asyncStream(importBatch(["doc1", "alice"], ["doc2", "bob"]));

      const error = await expectRpcError(svc.importBulkRelationships(reader));

      expect(error.code).toBe(status.ALREADY_EXISTS);
      expect(error.details).toContain("could not CREATE relationship");
      expect(error.details).toContain("document:doc1#viewer@user:alice");

      // Nothing from the failed import applied.
      const check = await svc.checkPermission(
        CheckPermissionRequest.fromPartial({
          consistency: { fullyConsistent: true },
          resource: { objectType: "document", objectId: "doc2" },
          permission: "view",
          subject: userSubject("bob"),
        }),
      );
      expect(check.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("ExportBulkRelationships pages all over one snapshot", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["doc1", "viewer", "alice"],
        ["doc2", "viewer", "bob"],
        ["doc3", "editor", "carol"],
        ["doc4", "viewer", "dave"],
        ["doc5", "viewer", "erin"],
      );

      const writer = new CollectingStreamWriter<ExportBulkRelationshipsResponse>();
      await service(cluster).exportBulkRelationships(
        ExportBulkRelationshipsRequest.fromPartial({
          optionalLimit: 2, // force multiple pages
        }),
        writer,
      );

      const all = writer.collected.flatMap((p) => p.relationships);
      expect(all).toHaveLength(5);

      // Every page carries a continuation cursor token.
      for (const p of writer.collected) expect(p.afterResultCursor).toBeDefined();

      // Multiple pages were produced under the limit.
      expect(writer.collected.length).toBeGreaterThanOrEqual(2);

      const resourceIds = all.map((r) => r.resource?.objectId ?? "").sort();
      expect(resourceIds).toEqual(["doc1", "doc2", "doc3", "doc4", "doc5"]);
    } finally {
      await cluster.dispose();
    }
  });

  it("ExportBulkRelationships filter narrows the results", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["doc1", "viewer", "alice"],
        ["doc1", "editor", "bob"],
        ["doc2", "viewer", "carol"],
      );

      const writer = new CollectingStreamWriter<ExportBulkRelationshipsResponse>();
      await service(cluster).exportBulkRelationships(
        ExportBulkRelationshipsRequest.fromPartial({
          optionalRelationshipFilter: {
            resourceType: "document",
            optionalResourceId: "doc1",
            optionalRelation: "viewer",
          },
        }),
        writer,
      );

      const all = writer.collected.flatMap((p) => p.relationships);
      expect(all).toHaveLength(1);
      const only = all[0];
      expect(only?.resource?.objectId).toBe("doc1");
      expect(only?.relation).toBe("viewer");
      expect(only?.subject?.object?.objectId).toBe("alice");
    } finally {
      await cluster.dispose();
    }
  });

  // A cross-silo dispatch failure (which the dispatcher re-raises as a DispatchFailedException
  // carrying its mapped code) must surface at the v1 front door as the corresponding stable gRPC
  // status, NOT as an opaque error. A genuine transport failure cannot be injected into the
  // in-process TestCluster, so we drive the SAME exception the dispatcher would raise through the
  // service via a fake checker, asserting the front-door mapping; the dispatcher's classification
  // of raw transport exceptions is covered by DispatchErrorMapperTests.
  it.each<[DispatchErrorCode, number]>([
    ["unavailable", status.UNAVAILABLE],
    ["cancelled", status.CANCELLED],
    ["deadlineExceeded", status.DEADLINE_EXCEEDED],
    ["internal", status.INTERNAL],
  ])(
    "CheckPermission maps a cross-silo %s dispatch failure to its gRPC code",
    async (code, expected) => {
      const cluster = await MeshTestCluster.create(Schema);
      try {
        const svc = new AuthzedPermissionsV1Service(
          new ThrowingChecker(new DispatchFailedException(code, "boom")),
          cluster.grainFactory,
          cluster.reverseOps,
          cluster.relationshipReads,
          cluster.schemaProvider,
        );

        const error = await expectRpcError(
          svc.checkPermission(
            CheckPermissionRequest.fromPartial({
              resource: { objectType: "document", objectId: "readme" },
              permission: "view",
              subject: userSubject("alice"),
            }),
          ),
        );

        expect(error.code).toBe(expected);
      } finally {
        await cluster.dispose();
      }
    },
  );
});
