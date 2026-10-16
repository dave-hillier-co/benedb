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
  DeleteRelationshipsResponse_DeletionProgress,
  ExpandPermissionTreeRequest,
  ExportBulkRelationshipsRequest,
  ImportBulkRelationshipsRequest,
  LookupPermissionship,
  LookupResourcesRequest,
  LookupSubjectsRequest,
  LookupSubjectsRequest_WildcardOption,
  Precondition_Operation,
  ReadRelationshipsRequest,
  RelationshipFilter,
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
 *  - The expiration round trip (spiceport#39, fixed at the source in `ad647b4`) is pinned below:
 *    `optional_expires_at` survives write-then-read as a millisecond-precision ts-proto `Date`.
 */

const Schema = `use expiration

definition user {}

caveat over_limit(limit int, requested int) {
    requested <= limit
}

definition document {
    relation viewer: user | user with over_limit | user with expiration
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

const WildcardSchema = `definition user {}

definition doc {
    relation banned: user
    relation viewer: user | user:*
    permission view = viewer - banned
}`;

/** The C# `SeedDocAsync`: seeds `doc` tuples ("*" is the public wildcard subject id). */
async function seedDoc(
  datastore: IDatastore,
  ...tuples: readonly (readonly [res: string, rel: string, subj: string])[]
): Promise<void> {
  const updates: RelationshipUpdate[] = tuples.map(([res, rel, subj]) => ({
    relationship: createRelationship(onr("doc", res, rel), onr("user", subj, ELLIPSIS)),
    operation: "touch",
  }));
  await datastore.readWriteTx((tx) => tx.writeRelationships(updates));
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

/**
 * The schema from spiceport#56: `document#viewer` admits only `user`, so a `group#member` subject
 * is outside its allowed direct relations; plus a permission and a caveat-only relation to
 * exercise the other write-time rejections.
 */
const WriteValidationSchema = `definition user {}

caveat only_on_tuesday(day string) {
    day == "tuesday"
}

definition group {
    relation member: user
}

definition document {
    relation viewer: user
    relation tuesday_viewer: user with only_on_tuesday
    permission view = viewer
}`;

function writeOne(
  operation: RelationshipUpdate_Operation,
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
  subjectRelation?: string,
  caveat?: string,
): WriteRelationshipsRequest {
  return WriteRelationshipsRequest.fromPartial({
    updates: [
      {
        operation,
        relationship: {
          resource: { objectType: resourceType, objectId: resourceId },
          relation,
          subject: {
            object: { objectType: subjectType, objectId: subjectId },
            optionalRelation: subjectRelation ?? "",
          },
          optionalCaveat: caveat === undefined ? undefined : { caveatName: caveat },
        },
      },
    ],
  });
}

async function countStored(cluster: MeshTestCluster, resourceType: string): Promise<number> {
  const writer = new CollectingStreamWriter<ReadRelationshipsResponse>();
  await service(cluster).readRelationships(
    ReadRelationshipsRequest.fromPartial({
      consistency: { fullyConsistent: true },
      relationshipFilter: { resourceType },
    }),
    writer,
  );
  return writer.collected.length;
}

const LookupSeed: readonly (readonly [res: string, rel: string, subj: string])[] = [
  ["doc1", "viewer", "alice"],
  ["doc2", "editor", "alice"],
  ["doc3", "viewer", "bob"],
  ["doc4", "viewer", "alice"],
  ["doc5", "editor", "alice"],
  ["doc6", "viewer", "alice"],
  ["doc6", "editor", "alice"],
  ["doc7", "viewer", "alice"],
];

function aliceViewLookup(cursor?: string): LookupResourcesRequest {
  return LookupResourcesRequest.fromPartial({
    consistency: { fullyConsistent: true },
    resourceObjectType: "document",
    permission: "view",
    subject: userSubject("alice"),
    optionalCursor: cursor === undefined ? undefined : { token: cursor },
  });
}

/** `Order(StringComparer.Ordinal)`: an explicit code-unit comparator, never the locale default. */
function ordinalSort(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readmeFilter(): RelationshipFilter {
  return RelationshipFilter.fromPartial({ resourceType: "document", optionalResourceId: "readme" });
}

/**
 * `MetadataOfBytes`: a `Struct` whose one string field is about `approximateBytes` long. A ts-proto
 * `Struct` field arrives auto-unwrapped, so it is a plain object.
 */
function metadataOfBytes(approximateBytes: number): Record<string, unknown> {
  return { blob: "x".repeat(approximateBytes) };
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

  // --- spiceport#56: write-time schema validation ---

  it("WriteRelationships subject type not allowed on relation is invalid argument", async () => {
    // SpiceDB validates every update against the schema inside the write transaction
    // (relationships.ValidateRelationshipUpdates) and rejects a subject type outside the relation's
    // allowed direct relations with INVALID_ARGUMENT (InvalidSubjectTypeError). Nothing persists.
    const cluster = await MeshTestCluster.create(WriteValidationSchema);
    try {
      const error = await expectRpcError(
        service(cluster).writeRelationships(
          writeOne(
            RelationshipUpdate_Operation.OPERATION_CREATE,
            "document",
            "doc",
            "viewer",
            "group",
            "eng",
            "member",
          ),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain(
        "subjects of type `group#member` are not allowed on relation `document#viewer`",
      );
      expect(await countStored(cluster, "document")).toBe(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships unknown definition is failed precondition", async () => {
    // An unknown object definition is SpiceDB's NamespaceNotFound, which the v1 services rewrite to
    // FAILED_PRECONDITION (the same mapping SchemaValidation applies for Check).
    const cluster = await MeshTestCluster.create(WriteValidationSchema);
    try {
      const error = await expectRpcError(
        service(cluster).writeRelationships(
          writeOne(
            RelationshipUpdate_Operation.OPERATION_TOUCH,
            "nonesuch",
            "doc",
            "viewer",
            "user",
            "alice",
          ),
        ),
      );

      expect(error.code).toBe(status.FAILED_PRECONDITION);
      expect(error.details).toContain("object definition `nonesuch` not found");
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships unknown relation is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(WriteValidationSchema);
    try {
      const error = await expectRpcError(
        service(cluster).writeRelationships(
          writeOne(
            RelationshipUpdate_Operation.OPERATION_TOUCH,
            "document",
            "doc",
            "nonesuch",
            "user",
            "alice",
          ),
        ),
      );

      expect(error.code).toBe(status.FAILED_PRECONDITION);
      expect(error.details).toContain(
        "relation/permission `nonesuch` not found under definition `document`",
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships to a permission is invalid argument", async () => {
    // SpiceDB CannotWriteToPermissionError -> INVALID_ARGUMENT.
    const cluster = await MeshTestCluster.create(WriteValidationSchema);
    try {
      const error = await expectRpcError(
        service(cluster).writeRelationships(
          writeOne(
            RelationshipUpdate_Operation.OPERATION_TOUCH,
            "document",
            "doc",
            "view",
            "user",
            "alice",
          ),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain(
        "cannot write a relationship to permission `view` under definition `document`",
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships caveat not allowed on relation is invalid argument", async () => {
    // `document#viewer` admits only an uncaveated `user`; a caveated subject is not an allowed type.
    const cluster = await MeshTestCluster.create(WriteValidationSchema);
    try {
      const error = await expectRpcError(
        service(cluster).writeRelationships(
          writeOne(
            RelationshipUpdate_Operation.OPERATION_TOUCH,
            "document",
            "doc",
            "viewer",
            "user",
            "alice",
            undefined,
            "only_on_tuesday",
          ),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain(
        "subjects of type `user with only_on_tuesday` are not allowed on relation `document#viewer`",
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships uncaveated subject on caveat only relation names the required caveat", async () => {
    const cluster = await MeshTestCluster.create(WriteValidationSchema);
    try {
      const error = await expectRpcError(
        service(cluster).writeRelationships(
          writeOne(
            RelationshipUpdate_Operation.OPERATION_TOUCH,
            "document",
            "doc",
            "tuesday_viewer",
            "user",
            "alice",
          ),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toContain(
        "subjects of type `user` are not allowed on relation `document#tuesday_viewer` without one of the following caveats: only_on_tuesday",
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships delete ignores an unspecified caveat", async () => {
    // The DELETE rule (ValidateRelationshipForDeletion) ignores the caveat when none is given, so
    // an uncaveated DELETE of a caveat-only relation is valid; a disallowed subject type still is
    // not.
    const cluster = await MeshTestCluster.create(WriteValidationSchema);
    try {
      await service(cluster).writeRelationships(
        writeOne(
          RelationshipUpdate_Operation.OPERATION_DELETE,
          "document",
          "doc",
          "tuesday_viewer",
          "user",
          "alice",
        ),
      );

      const error = await expectRpcError(
        service(cluster).writeRelationships(
          writeOne(
            RelationshipUpdate_Operation.OPERATION_DELETE,
            "document",
            "doc",
            "viewer",
            "group",
            "eng",
            "member",
          ),
        ),
      );
      expect(error.code).toBe(status.INVALID_ARGUMENT);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships schema valid write succeeds", async () => {
    const cluster = await MeshTestCluster.create(WriteValidationSchema);
    try {
      await service(cluster).writeRelationships(
        writeOne(
          RelationshipUpdate_Operation.OPERATION_CREATE,
          "group",
          "eng",
          "member",
          "user",
          "alice",
        ),
      );

      expect(await countStored(cluster, "group")).toBe(1);
    } finally {
      await cluster.dispose();
    }
  });

  it("ImportBulkRelationships disallowed subject is invalid argument and imports nothing", async () => {
    const cluster = await MeshTestCluster.create(WriteValidationSchema);
    try {
      const bad = ImportBulkRelationshipsRequest.fromPartial({
        relationships: [
          {
            resource: { objectType: "document", objectId: "doc" },
            relation: "viewer",
            subject: {
              object: { objectType: "group", objectId: "eng" },
              optionalRelation: "member",
            },
          },
        ],
      });
      const reader = asyncStream(importBatch(["doc1", "alice"]), bad);

      const error = await expectRpcError(service(cluster).importBulkRelationships(reader));

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(await countStored(cluster, "document")).toBe(0);
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

  it("WriteRelationships then ReadRelationships round trips expiration", async () => {
    // `optional_expires_at` is core.proto field 5: a client-supplied expiry must survive the wire
    // in BOTH directions rather than silently turning a time-limited grant permanent (issue #39).
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const expiresAt = new Date(Date.UTC(2099, 0, 1));
      const req = WriteRelationshipsRequest.fromPartial({
        updates: [
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              relation: "viewer",
              subject: userSubject("alice"),
              optionalExpiresAt: expiresAt,
            },
          },
        ],
      });
      await service(cluster).writeRelationships(req);

      const writer = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await service(cluster).readRelationships(
        ReadRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
        }),
        writer,
      );

      expect(writer.collected).toHaveLength(1);
      expect(writer.collected[0]?.relationship?.optionalExpiresAt).toEqual(expiresAt);
    } finally {
      await cluster.dispose();
    }
  });

  // --- spiceport#46: limit ceilings and the transaction-metadata cap ---

  it("LookupResources limit above 1000 is invalid argument", async () => {
    // SpiceDB MaxLookupResourcesLimit (default 1000) -> ExceedsMaximumLimitErr, INVALID_ARGUMENT.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const request = aliceViewLookup();
      request.optionalLimit = 1001;
      const error = await expectRpcError(
        service(cluster).lookupResources(
          request,
          new CollectingStreamWriter<LookupResourcesResponse>(),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe("provided limit 1001 is greater than maximum allowed of 1000");
    } finally {
      await cluster.dispose();
    }
  });

  it("ReadRelationships limit above 1000 is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const error = await expectRpcError(
        service(cluster).readRelationships(
          ReadRelationshipsRequest.fromPartial({
            relationshipFilter: readmeFilter(),
            optionalLimit: 1001,
          }),
          new CollectingStreamWriter<ReadRelationshipsResponse>(),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe("provided limit 1001 is greater than maximum allowed of 1000");
    } finally {
      await cluster.dispose();
    }
  });

  it("DeleteRelationships limit above 1000 is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const error = await expectRpcError(
        service(cluster).deleteRelationships(
          DeleteRelationshipsRequest.fromPartial({
            relationshipFilter: readmeFilter(),
            optionalLimit: 1001,
          }),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe("provided limit 1001 is greater than maximum allowed of 1000");
    } finally {
      await cluster.dispose();
    }
  });

  it("ExportBulkRelationships limit above 10000 is invalid argument", async () => {
    // SpiceDB MaxBulkExportRelationshipsLimit (default 10000).
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const error = await expectRpcError(
        service(cluster).exportBulkRelationships(
          ExportBulkRelationshipsRequest.fromPartial({ optionalLimit: 10_001 }),
          new CollectingStreamWriter<ExportBulkRelationshipsResponse>(),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe("provided limit 10001 is greater than maximum allowed of 10000");
    } finally {
      await cluster.dispose();
    }
  });

  it("ReadRelationships honours optional limit and resumes from after result cursor", async () => {
    // SpiceDB returns at most optional_limit relationships, each with an after_result_cursor that
    // optional_cursor resumes from.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "alice"],
        ["readme", "viewer", "bob"],
        ["readme", "viewer", "carol"],
      );

      const first = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await service(cluster).readRelationships(
        ReadRelationshipsRequest.fromPartial({
          relationshipFilter: readmeFilter(),
          optionalLimit: 2,
        }),
        first,
      );

      expect(first.collected).toHaveLength(2);
      for (const r of first.collected) expect(r.afterResultCursor?.token ?? "").not.toBe("");

      const rest = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await service(cluster).readRelationships(
        ReadRelationshipsRequest.fromPartial({
          relationshipFilter: readmeFilter(),
          optionalLimit: 2,
          optionalCursor: first.collected[first.collected.length - 1]?.afterResultCursor,
        }),
        rest,
      );

      const subjects = [...first.collected, ...rest.collected].map(
        (r) => r.relationship?.subject?.object?.objectId ?? "",
      );
      expect(ordinalSort(subjects)).toEqual(["alice", "bob", "carol"]);
    } finally {
      await cluster.dispose();
    }
  });

  it("DeleteRelationships partial deletion honours optional limit", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "alice"],
        ["readme", "viewer", "bob"],
        ["readme", "viewer", "carol"],
      );

      const partial = await service(cluster).deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: readmeFilter(),
          optionalLimit: 2,
          optionalAllowPartialDeletions: true,
        }),
      );

      expect(partial.relationshipsDeletedCount).toBe("2");
      expect(partial.deletionProgress).toBe(
        DeleteRelationshipsResponse_DeletionProgress.DELETION_PROGRESS_PARTIAL,
      );
      expect(await countStored(cluster, "document")).toBe(1);

      const complete = await service(cluster).deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: readmeFilter(),
          optionalLimit: 2,
          optionalAllowPartialDeletions: true,
        }),
      );

      expect(complete.relationshipsDeletedCount).toBe("1");
      expect(complete.deletionProgress).toBe(
        DeleteRelationshipsResponse_DeletionProgress.DELETION_PROGRESS_COMPLETE,
      );
      expect(await countStored(cluster, "document")).toBe(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("DeleteRelationships over limit without partial deletion is invalid argument and deletes nothing", async () => {
    // SpiceDB CouldNotTransactionallyDeleteErr -> INVALID_ARGUMENT, nothing deleted.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "alice"],
        ["readme", "viewer", "bob"],
        ["readme", "viewer", "carol"],
      );

      const error = await expectRpcError(
        service(cluster).deleteRelationships(
          DeleteRelationshipsRequest.fromPartial({
            relationshipFilter: readmeFilter(),
            optionalLimit: 2,
          }),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe(
        "found more than 2 relationships to be deleted and partial deletion was not requested",
      );
      expect(await countStored(cluster, "document")).toBe(3);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships transaction metadata over 65000 bytes is invalid argument", async () => {
    // SpiceDB MaximumTransactionMetadataSize: TransactionMetadataTooLargeErr -> INVALID_ARGUMENT.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const request = writeReq(RelationshipUpdate_Operation.OPERATION_TOUCH, "readme", "alice");
      request.optionalTransactionMetadata = metadataOfBytes(65_000);
      const error = await expectRpcError(service(cluster).writeRelationships(request));

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toMatch(
        /^metadata size of [0-9]+ is greater than maximum allowed of 65000$/,
      );
      expect(await countStored(cluster, "document")).toBe(0);

      // Metadata under the cap is accepted.
      request.optionalTransactionMetadata = metadataOfBytes(100);
      await service(cluster).writeRelationships(request);
    } finally {
      await cluster.dispose();
    }
  });

  it("DeleteRelationships transaction metadata over 65000 bytes is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const error = await expectRpcError(
        service(cluster).deleteRelationships(
          DeleteRelationshipsRequest.fromPartial({
            relationshipFilter: readmeFilter(),
            optionalTransactionMetadata: metadataOfBytes(65_000),
          }),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toMatch(
        /^metadata size of [0-9]+ is greater than maximum allowed of 65000$/,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships schema violations carry SpiceDB's codes and commit nothing", async () => {
    // SpiceDB validates every update against the schema inside the write transaction: an unknown
    // definition or relation is FAILED_PRECONDITION, a write to a permission or a disallowed subject
    // type is INVALID_ARGUMENT.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const write = (
        resourceType: string,
        relation: string,
        subjectType: string,
        subjectRelation = "",
      ): Promise<unknown> =>
        service(cluster).writeRelationships(
          WriteRelationshipsRequest.fromPartial({
            updates: [
              {
                operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
                relationship: {
                  resource: { objectType: resourceType, objectId: "readme" },
                  relation,
                  subject: {
                    object: { objectType: subjectType, objectId: "alice" },
                    optionalRelation: subjectRelation,
                  },
                },
              },
            ],
          }),
        );

      const unknownDefinition = await expectRpcError(write("folder", "viewer", "user"));
      expect(unknownDefinition.code).toBe(status.FAILED_PRECONDITION);
      expect(unknownDefinition.details).toBe("object definition `folder` not found");

      const unknownRelation = await expectRpcError(write("document", "owner", "user"));
      expect(unknownRelation.code).toBe(status.FAILED_PRECONDITION);

      const permission = await expectRpcError(write("document", "view", "user"));
      expect(permission.code).toBe(status.INVALID_ARGUMENT);
      expect(permission.details).toBe(
        "cannot write a relationship to permission `view` under definition `document`",
      );

      const subjectType = await expectRpcError(write("document", "editor", "document"));
      expect(subjectType.code).toBe(status.INVALID_ARGUMENT);
      expect(subjectType.details).toBe(
        "subjects of type `document` are not allowed on relation `document#editor`",
      );

      const writer = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await service(cluster).readRelationships(
        ReadRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType: "document" } }),
        writer,
      );
      expect(writer.collected).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteRelationships deletes an expiring tuple without restating its expiration", async () => {
    // SpiceDB's deletion rule: an uncaveated DELETE is held to the subject type only.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await service(cluster).writeRelationships(
        WriteRelationshipsRequest.fromPartial({
          updates: [
            {
              operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
              relationship: {
                resource: { objectType: "document", objectId: "readme" },
                relation: "viewer",
                subject: userSubject("alice"),
                optionalExpiresAt: new Date(Date.UTC(2099, 0, 1)),
              },
            },
          ],
        }),
      );

      await service(cluster).writeRelationships(
        writeReq(RelationshipUpdate_Operation.OPERATION_DELETE, "readme", "alice"),
      );

      const writer = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await service(cluster).readRelationships(
        ReadRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType: "document" } }),
        writer,
      );
      expect(writer.collected).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("ImportBulkRelationships rejects a schema-invalid row and loads nothing", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const request = ImportBulkRelationshipsRequest.fromPartial({
        relationships: [
          {
            resource: { objectType: "document", objectId: "readme" },
            relation: "viewer",
            subject: userSubject("alice"),
          },
          {
            resource: { objectType: "document", objectId: "readme" },
            relation: "editor",
            subject: { object: { objectType: "document", objectId: "x" }, optionalRelation: "" },
          },
        ],
      });

      const error = await expectRpcError(
        service(cluster).importBulkRelationships(asyncStream(request)),
      );
      expect(error.code).toBe(status.INVALID_ARGUMENT);

      const writer = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await service(cluster).readRelationships(
        ReadRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType: "document" } }),
        writer,
      );
      expect(writer.collected).toHaveLength(0);
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

  it("DeleteRelationships without limit is complete with count", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "alice"],
        ["readme", "viewer", "bob"],
        ["readme", "editor", "carol"],
      );

      const resp = await service(cluster).deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
        }),
      );

      expect(resp.deletionProgress).toBe(
        DeleteRelationshipsResponse_DeletionProgress.DELETION_PROGRESS_COMPLETE,
      );
      expect(resp.relationshipsDeletedCount).toBe("3");
      expect(resp.deletedAt?.token).toBeTruthy();
    } finally {
      await cluster.dispose();
    }
  });

  it("DeleteRelationships limit with allow partial deletes up to limit and is partial", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "u1"],
        ["readme", "viewer", "u2"],
        ["readme", "viewer", "u3"],
        ["readme", "viewer", "u4"],
        ["readme", "viewer", "u5"],
      );
      const svc = service(cluster);

      const resp = await svc.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
          optionalLimit: 3,
          optionalAllowPartialDeletions: true,
        }),
      );

      expect(resp.deletionProgress).toBe(
        DeleteRelationshipsResponse_DeletionProgress.DELETION_PROGRESS_PARTIAL,
      );
      expect(resp.relationshipsDeletedCount).toBe("3");
      expect(resp.deletedAt?.token).toBeTruthy();

      // Exactly 2 remain past the limit.
      const writer = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
          consistency: { fullyConsistent: true },
        }),
        writer,
      );
      expect(writer.collected).toHaveLength(2);
    } finally {
      await cluster.dispose();
    }
  });

  it("DeleteRelationships limit exceeded without allow partial is invalid argument and deletes nothing", async () => {
    // Upstream (relationships.go DeleteRelationships): a limit with allow-partial false and MORE
    // matching rows than the limit rejects the whole call transactionally - InvalidArgument
    // (ERROR_REASON_TOO_MANY_RELATIONSHIPS_FOR_TRANSACTIONAL_DELETE), nothing deleted.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "u1"],
        ["readme", "viewer", "u2"],
        ["readme", "viewer", "u3"],
        ["readme", "viewer", "u4"],
        ["readme", "viewer", "u5"],
      );
      const svc = service(cluster);

      const error = await expectRpcError(
        svc.deleteRelationships(
          DeleteRelationshipsRequest.fromPartial({
            relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
            optionalLimit: 3,
          }),
        ),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.message).toContain("found more than 3 relationships to be deleted");

      // The rejection was transactional: all 5 rows survive.
      const writer = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
          consistency: { fullyConsistent: true },
        }),
        writer,
      );
      expect(writer.collected).toHaveLength(5);
    } finally {
      await cluster.dispose();
    }
  });

  it("DeleteRelationships limit covering all matches without allow partial is partial", async () => {
    // Exactly limit matches without allow-partial: upstream's limit+1 probe passes (only strictly
    // MORE matches than the limit trips the transactional rejection), every row is deleted - but
    // the response still reports PARTIAL, because upstream datastores flag the limit as reached
    // when deleted == limit (postgres readwrite.go: RowsAffected() == limit; memdb readwrite.go:
    // counter == limit), which relationships.go maps to DELETION_PROGRESS_PARTIAL. Note the
    // vendored proto doc says PARTIAL only when MORE rows matched than the limit; upstream's
    // implementation contradicts its own doc, and behavioral agreement with real spicedb wins.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "u1"],
        ["readme", "viewer", "u2"],
        ["readme", "viewer", "u3"],
      );
      const svc = service(cluster);

      const resp = await svc.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
          optionalLimit: 3,
        }),
      );

      expect(resp.deletionProgress).toBe(
        DeleteRelationshipsResponse_DeletionProgress.DELETION_PROGRESS_PARTIAL,
      );
      expect(resp.relationshipsDeletedCount).toBe("3");

      // The delete itself was complete: nothing remains.
      const writer = new CollectingStreamWriter<ReadRelationshipsResponse>();
      await svc.readRelationships(
        ReadRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
          consistency: { fullyConsistent: true },
        }),
        writer,
      );
      expect(writer.collected).toHaveLength(0);
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

  it.each([true, false])(
    "LookupResources without limit emits after result cursor on every item (walk %s)",
    async (useMembershipWalk) => {
      // spiceport#47: SpiceDB populates after_result_cursor on every streamed item whenever cursor
      // sections exist, with no limit condition (internal/services/v1/permissions.go). An
      // unlimited stream must be resumable from any item - on the Leopard path (walk on) as well
      // as the live traversal.
      const cluster = await MeshTestCluster.create(Schema, { useMembershipWalk });
      try {
        await seed(cluster.datastore, ...LookupSeed);

        const writer = new CollectingStreamWriter<LookupResourcesResponse>();
        await service(cluster).lookupResources(aliceViewLookup(), writer);

        expect(writer.collected.length).toBeGreaterThan(0);
        for (const r of writer.collected) expect(r.afterResultCursor?.token ?? "").not.toBe("");
      } finally {
        await cluster.dispose();
      }
    },
  );

  it.each([true, false])(
    "LookupResources unlimited resume from mid stream cursor yields the remainder (walk %s)",
    async (useMembershipWalk) => {
      const cluster = await MeshTestCluster.create(Schema, { useMembershipWalk });
      try {
        await seed(cluster.datastore, ...LookupSeed);

        const full = new CollectingStreamWriter<LookupResourcesResponse>();
        await service(cluster).lookupResources(aliceViewLookup(), full);
        const fullIds = new Set(full.collected.map((r) => r.resourceObjectId));
        expect(ordinalSort([...fullIds])).toEqual(["doc1", "doc2", "doc4", "doc5", "doc6", "doc7"]);

        for (let k = 1; k < full.collected.length; k++) {
          const resumed = new CollectingStreamWriter<LookupResourcesResponse>();
          await service(cluster).lookupResources(
            aliceViewLookup(full.collected[k - 1]?.afterResultCursor?.token),
            resumed,
          );

          const union = new Set([
            ...full.collected.slice(0, k).map((r) => r.resourceObjectId),
            ...resumed.collected.map((r) => r.resourceObjectId),
          ]);
          expect(ordinalSort([...union])).toEqual(ordinalSort([...fullIds]));

          // Resuming never re-emits an item already delivered before the cursor (beyond the
          // per-entrypoint repeats the live traversal emits within one stream).
          for (const r of resumed.collected) {
            expect(
              full.collected.slice(k).some((f) => f.resourceObjectId === r.resourceObjectId),
            ).toBe(true);
          }
        }
      } finally {
        await cluster.dispose();
      }
    },
  );

  it("LookupResources candidate cursor resumes when the walk declines on resume", async () => {
    // A cursor minted on the Leopard path must stay resumable when the accelerator is unavailable
    // on the resuming request (here: a cluster with the walk disabled, over the same data).
    let cursor: string;
    let firstIds: string[];
    const walkOn = await MeshTestCluster.create(Schema, { useMembershipWalk: true });
    try {
      await seed(walkOn.datastore, ...LookupSeed);
      const full = new CollectingStreamWriter<LookupResourcesResponse>();
      await service(walkOn).lookupResources(aliceViewLookup(), full);
      cursor = full.collected[2]?.afterResultCursor?.token ?? "";
      firstIds = full.collected.slice(0, 3).map((r) => r.resourceObjectId);
    } finally {
      await walkOn.dispose();
    }

    // The stream came from the accelerator: its cursors are candidate-resume cursors. A BeneDB
    // token prefixes its payload with the request-shape hash and a newline, so the C#'s
    // `StartsWith("C:")` applies to the payload after that separator.
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    expect(decoded.slice(decoded.indexOf("\n") + 1)).toMatch(/^C:/);

    const walkOff = await MeshTestCluster.create(Schema, { useMembershipWalk: false });
    try {
      await seed(walkOff.datastore, ...LookupSeed);
      const resumed = new CollectingStreamWriter<LookupResourcesResponse>();
      await service(walkOff).lookupResources(aliceViewLookup(cursor), resumed);

      const resumedIds = resumed.collected.map((r) => r.resourceObjectId);
      expect(resumedIds.filter((id) => firstIds.includes(id))).toEqual([]);
      expect(ordinalSort([...firstIds, ...resumedIds])).toEqual([
        "doc1",
        "doc2",
        "doc4",
        "doc5",
        "doc6",
        "doc7",
      ]);
      for (const r of resumed.collected) expect(r.afterResultCursor?.token ?? "").not.toBe("");
    } finally {
      await walkOff.dispose();
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

  it("LookupSubjects wildcard carries exclusions in modern and deprecated fields", async () => {
    const cluster = await MeshTestCluster.create(WildcardSchema);
    try {
      await seedDoc(cluster.datastore, ["d1", "viewer", "*"], ["d1", "banned", "alice"]);

      const writer = new CollectingStreamWriter<LookupSubjectsResponse>();
      await service(cluster).lookupSubjects(
        LookupSubjectsRequest.fromPartial({
          resource: { objectType: "doc", objectId: "d1" },
          permission: "view",
          subjectObjectType: "user",
        }),
        writer,
      );

      expect(writer.collected).toHaveLength(1);
      const resp = writer.collected[0]!;
      expect(resp.subject?.subjectObjectId).toBe("*");
      expect(resp.subject?.permissionship).toBe(
        LookupPermissionship.LOOKUP_PERMISSIONSHIP_HAS_PERMISSION,
      );

      // Modern field: the excluded subject with its own permissionship.
      expect(resp.excludedSubjects).toHaveLength(1);
      const excluded = resp.excludedSubjects[0]!;
      expect(excluded.subjectObjectId).toBe("alice");
      expect(excluded.permissionship).toBe(
        LookupPermissionship.LOOKUP_PERMISSIONSHIP_HAS_PERMISSION,
      );

      // Deprecated mirror: the excluded subject ids.
      expect(resp.excludedSubjectIds).toEqual(["alice"]);
    } finally {
      await cluster.dispose();
    }
  });

  it("LookupSubjects wildcard option exclude suppresses wildcard rows", async () => {
    const cluster = await MeshTestCluster.create(WildcardSchema);
    try {
      await seedDoc(
        cluster.datastore,
        ["d1", "viewer", "*"],
        ["d1", "viewer", "carol"],
        ["d1", "banned", "alice"],
      );

      const writer = new CollectingStreamWriter<LookupSubjectsResponse>();
      await service(cluster).lookupSubjects(
        LookupSubjectsRequest.fromPartial({
          resource: { objectType: "doc", objectId: "d1" },
          permission: "view",
          subjectObjectType: "user",
          wildcardOption: LookupSubjectsRequest_WildcardOption.WILDCARD_OPTION_EXCLUDE_WILDCARDS,
        }),
        writer,
      );

      // The wildcard row is suppressed entirely; concrete subjects still stream.
      const ids = writer.collected.map((r) => r.subject?.subjectObjectId ?? "");
      expect(ids).toEqual(["carol"]);
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
