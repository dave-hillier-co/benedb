import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@benedb/core/core-constants";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import type {
  BulkCheckPermissionRequestItem,
  BulkExportRelationshipsResponse,
  BulkImportRelationshipsRequest,
  ExpSchemaFilter,
} from "@benedb/protos/authzed/api/v1/experimental_service";
import { BulkCheckPermissionRequest } from "@benedb/protos/authzed/api/v1/experimental_service";
import type { RelationshipFilter } from "@benedb/protos/authzed/api/v1/permission_service";
import { CheckPermissionResponse_Permissionship } from "@benedb/protos/authzed/api/v1/permission_service";
import { describe, expect, it } from "vitest";

import { AuthzedExperimentalV1Service } from "./authzed-experimental-v1-service";
import { AuthzedPermissionsV1Service } from "./authzed-permissions-v1-service";
import { AuthzedSchemaV1Service } from "./authzed-schema-v1-service";
import { CollectingStreamWriter } from "./collecting-stream-writer";
import { assertErrorInfo } from "./error-info-assertions";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/AuthzedExperimentalV1ServiceTests.cs`.
 *
 * Drives the `authzed.api.v1` {@link AuthzedExperimentalV1Service} IN-PROCESS over the mesh
 * cluster's grain mesh (in-memory datastore). Verifies the on-demand relationship-counter RPCs:
 * register + count returns the matching count with a non-empty read-at token; the count tracks
 * subsequent matching / non-matching writes; unregister then count is FAILED_PRECONDITION;
 * re-registering an existing name is FAILED_PRECONDITION. Also verifies the deprecated aliases and
 * the Exp* schema-tooling RPCs, which upstream (`internal/services/v1/experimental.go`) serves from
 * the same code paths as their v1 equivalents.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@benedb/grains` does not depend on `@benedb/api`.
 *  - `FakeServerCallContext : ServerCallContext` DISAPPEARS: the ported methods take a trailing
 *    optional `AbortSignal`, so every call passes nothing.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - `CounterResultOneofCase.ReadCounterValue` becomes "the `readCounterValue` sibling field is
 *    defined", ts-proto's rendering of a oneof.
 *  - `Assert.Equal(2UL, ...RelationshipCount)`: the field is uint64 and ts-proto renders it as a
 *    STRING, so the expectation is `"2"`, never the number 2.
 *  - `resp.ReadCounterValue.ReadAt?.Token` is null-conditional in the C#, so the optional
 *    dereference is kept rather than asserting the submessage exists.
 *  - The non-matching write is `folder:docs#viewer`, a resource type the counter's filter
 *    (resource type "document", relation "viewer") never matches. It must still be a write the
 *    schema allows, because writes are validated against it.
 *  - The C#'s positional `RelationshipWire(...)` record is spelled with NAMED fields here so no
 *    argument can slide a slot.
 */

const Schema = `definition user {}
caveat ip_match(allowed string, user_ip string) {
    user_ip == allowed
}
definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
    permission manage = editor
}
definition folder {
    relation viewer: user
}`;

function service(cluster: MeshTestCluster): AuthzedExperimentalV1Service {
  return new AuthzedExperimentalV1Service(
    cluster.grainFactory,
    new AuthzedPermissionsV1Service(
      cluster.checker,
      cluster.grainFactory,
      cluster.reverseOps,
      cluster.relationshipReads,
      cluster.schemaProvider,
    ),
    new AuthzedSchemaV1Service(cluster.grainFactory, cluster.schemaProvider),
  );
}

function documentViewerFilter(): RelationshipFilter {
  return {
    resourceType: "document",
    optionalResourceId: "",
    optionalResourceIdPrefix: "",
    optionalRelation: "viewer",
    optionalSubjectFilter: undefined,
  };
}

function writeViewer(cluster: MeshTestCluster, document: string, user: string): Promise<unknown> {
  return cluster.relationships.writeRelationships({
    updates: [
      {
        operation: "touch",
        relationship: {
          resourceType: "document",
          resourceId: document,
          resourceRelation: "viewer",
          subjectType: "user",
          subjectId: user,
          subjectRelation: ELLIPSIS,
          caveatName: undefined,
          caveatContext: undefined,
          expiration: undefined,
        },
      },
    ],
  });
}

/** `Assert.Throws<RpcException>` + `Assert.Equal(code, ex.StatusCode)`. */
async function expectRpcStatus(promise: Promise<unknown>, code: number): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RpcError);
  expect((error as RpcError).code).toBe(code);
}

describe("AuthzedExperimentalV1ServiceTests", () => {
  it("Register then Count returns matching count with read at token", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await writeViewer(cluster, "readme", "alice");
      await writeViewer(cluster, "readme", "bob");

      await svc.experimentalRegisterRelationshipCounter({
        name: "doc_viewers",
        relationshipFilter: documentViewerFilter(),
      });

      const resp = await svc.experimentalCountRelationships({ name: "doc_viewers" });

      expect(resp.readCounterValue).toBeDefined();
      expect(resp.readCounterValue?.relationshipCount).toBe("2");
      expect(resp.readCounterValue?.readAt?.token ?? "").not.toBe("");
    } finally {
      await cluster.dispose();
    }
  });

  it("Count tracks matching and non matching writes", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await writeViewer(cluster, "readme", "alice");

      await svc.experimentalRegisterRelationshipCounter({
        name: "doc_viewers",
        relationshipFilter: documentViewerFilter(),
      });

      const first = await svc.experimentalCountRelationships({ name: "doc_viewers" });
      expect(first.readCounterValue?.relationshipCount).toBe("1");

      // A matching write bumps the count.
      await writeViewer(cluster, "guide", "carol");
      const second = await svc.experimentalCountRelationships({ name: "doc_viewers" });
      expect(second.readCounterValue?.relationshipCount).toBe("2");

      // A non-matching write (different resource type) does not.
      await cluster.relationships.writeRelationships({
        updates: [
          {
            operation: "touch",
            relationship: {
              resourceType: "folder",
              resourceId: "docs",
              resourceRelation: "viewer",
              subjectType: "user",
              subjectId: "carol",
              subjectRelation: ELLIPSIS,
              caveatName: undefined,
              caveatContext: undefined,
              expiration: undefined,
            },
          },
        ],
      });
      const third = await svc.experimentalCountRelationships({ name: "doc_viewers" });
      expect(third.readCounterValue?.relationshipCount).toBe("2");
    } finally {
      await cluster.dispose();
    }
  });

  it("Unregister then Count is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await svc.experimentalRegisterRelationshipCounter({
        name: "doc_viewers",
        relationshipFilter: documentViewerFilter(),
      });

      await svc.experimentalUnregisterRelationshipCounter({ name: "doc_viewers" });

      await expectRpcStatus(
        svc.experimentalCountRelationships({ name: "doc_viewers" }),
        status.FAILED_PRECONDITION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("Unregister unknown counter is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      await expectRpcStatus(
        svc.experimentalUnregisterRelationshipCounter({ name: "nope" }),
        status.FAILED_PRECONDITION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("Register existing name is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      const request = {
        name: "doc_viewers",
        relationshipFilter: documentViewerFilter(),
      };
      await svc.experimentalRegisterRelationshipCounter(request);

      await expectRpcStatus(
        svc.experimentalRegisterRelationshipCounter(request),
        status.FAILED_PRECONDITION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  // ---- BulkCheckPermission (deprecated alias of PermissionsService.CheckBulkPermissions) ----

  it("BulkCheckPermission returns pairs in request order with checked at", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await writeViewer(cluster, "readme", "alice");

      const req = BulkCheckPermissionRequest.fromPartial({});
      req.items.push(bulkItem("readme", "view", "alice"));
      req.items.push(bulkItem("readme", "view", "bob"));
      req.items.push(bulkItem("readme", "nonexistent_perm", "alice"));

      const resp = await service(cluster).bulkCheckPermission(req);

      expect(resp.checkedAt?.token ?? "").not.toBe("");
      expect(resp.pairs).toHaveLength(3);
      for (let i = 0; i < req.items.length; i += 1) {
        expect(resp.pairs[i]?.request).toEqual(req.items[i]);
      }

      expect(resp.pairs[0]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
      expect(resp.pairs[1]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      );

      // A per-pair schema error is reported on that pair, not as a whole-request failure.
      expect(resp.pairs[2]?.item).toBeUndefined();
      expect(resp.pairs[2]?.error?.message).toContain("nonexistent_perm");
    } finally {
      await cluster.dispose();
    }
  });

  it("BulkCheckPermission honours request consistency", async () => {
    // The consistency on the deprecated request must reach the shared check path: a malformed
    // at_exact_snapshot token is the same InvalidArgument CheckBulkPermissions returns.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = BulkCheckPermissionRequest.fromPartial({
        consistency: { atExactSnapshot: { token: "not-a-token" } },
      });
      req.items.push(bulkItem("readme", "view", "alice"));

      await expectRpcStatus(service(cluster).bulkCheckPermission(req), status.INVALID_ARGUMENT);
    } finally {
      await cluster.dispose();
    }
  });

  it("BulkCheckPermission more than 10000 items is invalid argument", async () => {
    // SpiceDB maxBulkCheckCount, enforced on the bulk-check path both RPCs share.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const req = BulkCheckPermissionRequest.fromPartial({});
      for (let i = 0; i < 10_001; i += 1) req.items.push(bulkItem("readme", "view", "alice"));

      const error = await rpcErrorFrom(service(cluster).bulkCheckPermission(req));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe("check count of 10001 is greater than maximum allowed of 10000");
      // ExceedsMaximumChecksError attaches ErrorInfo with reason UNSPECIFIED and the counts.
      assertErrorInfo(
        error,
        status.INVALID_ARGUMENT,
        "ERROR_REASON_UNSPECIFIED",
        ["check_count", "10001"],
        ["maximum_checks_allowed", "10000"],
      );
    } finally {
      await cluster.dispose();
    }
  });

  // ---- BulkImportRelationships / BulkExportRelationships (deprecated aliases) ----

  it("BulkImportRelationships loads across batches and returns count", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const svc = service(cluster);

      const resp = await svc.bulkImportRelationships(
        asyncStream(
          importBatch(["doc1", "alice"], ["doc1", "bob"]),
          importBatch(["doc2", "carol"]),
        ),
      );

      expect(resp.numLoaded).toBe("3");

      const check = BulkCheckPermissionRequest.fromPartial({});
      check.items.push(bulkItem("doc2", "view", "carol"));
      const verdict = await svc.bulkCheckPermission(check);
      expect(verdict.pairs[0]?.item?.permissionship).toBe(
        CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("BulkImportRelationships duplicate is already exists", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await expectRpcStatus(
        service(cluster).bulkImportRelationships(
          asyncStream(importBatch(["doc1", "alice"]), importBatch(["doc1", "alice"])),
        ),
        status.ALREADY_EXISTS,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("BulkExportRelationships pages by limit with continuation cursor", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await writeViewer(cluster, "a", "alice");
      await writeViewer(cluster, "b", "bob");
      await writeViewer(cluster, "c", "carol");

      const writer = new CollectingStreamWriter<BulkExportRelationshipsResponse>();
      await service(cluster).bulkExportRelationships({ optionalLimit: 2 }, writer);

      expect(writer.collected.map((r) => r.relationships.length)).toEqual([2, 1]);
      for (const r of writer.collected) expect(r.afterResultCursor?.token ?? "").not.toBe("");
      expect(
        writer.collected
          .flatMap((r) => r.relationships)
          .map((r) => r.resource?.objectId)
          .sort(),
      ).toEqual(["a", "b", "c"]);

      // Resuming from the first page's cursor yields exactly the remainder.
      const resumed = new CollectingStreamWriter<BulkExportRelationshipsResponse>();
      await service(cluster).bulkExportRelationships(
        { optionalLimit: 2, optionalCursor: writer.collected[0]?.afterResultCursor },
        resumed,
      );
      expect(resumed.collected.flatMap((r) => r.relationships)).toHaveLength(1);
    } finally {
      await cluster.dispose();
    }
  });

  it("BulkExportRelationships allows limits up to the experimental maximum of 100000", async () => {
    // Upstream's experimental export ceiling is ExperimentalServerOptions.MaxExportBatchSize
    // (default 100_000), not PermissionsService's 10_000.
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await writeViewer(cluster, "a", "alice");

      const writer = new CollectingStreamWriter<BulkExportRelationshipsResponse>();
      await service(cluster).bulkExportRelationships({ optionalLimit: 100_000 }, writer);
      expect(writer.collected.flatMap((r) => r.relationships)).toHaveLength(1);

      const error = await rpcErrorFrom(
        service(cluster).bulkExportRelationships(
          { optionalLimit: 100_001 },
          new CollectingStreamWriter<BulkExportRelationshipsResponse>(),
        ),
      );
      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe("provided limit 100001 is greater than maximum allowed of 100000");
    } finally {
      await cluster.dispose();
    }
  });

  // ---- Exp* schema tooling (same behaviour as SchemaService, Exp-typed messages) ----

  it("ExperimentalReflectSchema returns definitions relations permissions and caveats", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const resp = await service(cluster).experimentalReflectSchema({ optionalFilters: [] });

      expect(resp.definitions.map((d) => d.name).sort()).toEqual(["document", "folder", "user"]);
      const doc = resp.definitions.find((d) => d.name === "document");
      const viewer = doc?.relations.find((r) => r.name === "viewer");
      expect(viewer?.parentDefinitionName).toBe("document");
      expect(viewer?.subjectTypes).toHaveLength(1);
      const subject = viewer?.subjectTypes[0];
      expect(subject?.subjectDefinitionName).toBe("user");
      expect(subject?.isTerminalSubject).toBe(true);
      expect(doc?.permissions.map((p) => p.name).sort()).toEqual(["manage", "view"]);

      expect(resp.caveats).toHaveLength(1);
      const caveat = resp.caveats[0];
      expect(caveat?.name).toBe("ip_match");
      expect(caveat?.parameters).toContainEqual({
        name: "allowed",
        type: "string",
        parentCaveatName: "ip_match",
      });
      expect(caveat?.expression).toContain("user_ip == allowed");
    } finally {
      await cluster.dispose();
    }
  });

  it("ExperimentalReflectSchema applies filters", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const resp = await service(cluster).experimentalReflectSchema({
        optionalFilters: [expFilter({ optionalDefinitionNameFilter: "doc" })],
      });

      expect(resp.definitions.map((d) => d.name)).toEqual(["document"]);
      expect(resp.caveats).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  });

  it("ExperimentalReflectSchema mutually exclusive filter is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await expectRpcStatus(
        service(cluster).experimentalReflectSchema({
          optionalFilters: [
            expFilter({ optionalDefinitionNameFilter: "document", optionalCaveatNameFilter: "ip" }),
          ],
        }),
        status.INVALID_ARGUMENT,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("ExperimentalDiffSchema reports expected oneof cases", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const comparison = `definition user {}
definition group {}
caveat ip_match(allowed string, user_ip string) {
    user_ip == allowed
}
definition document {
    relation viewer: user | group
    relation editor: user
    relation owner: user
    permission view = viewer
}
definition folder {
    relation viewer: user
}`;

      const resp = await service(cluster).experimentalDiffSchema({ comparisonSchema: comparison });

      expect(resp.diffs.some((d) => d.definitionAdded?.name === "group")).toBe(true);
      expect(
        resp.diffs.some(
          (d) =>
            d.relationAdded?.name === "owner" &&
            d.relationAdded.parentDefinitionName === "document",
        ),
      ).toBe(true);
      expect(resp.diffs.some((d) => d.permissionRemoved?.name === "manage")).toBe(true);
      expect(
        resp.diffs.some(
          (d) =>
            d.relationSubjectTypeAdded?.relation?.name === "viewer" &&
            d.relationSubjectTypeAdded.changedSubjectType?.subjectDefinitionName === "group",
        ),
      ).toBe(true);
      expect(resp.diffs.some((d) => d.permissionExprChanged?.name === "view")).toBe(true);
    } finally {
      await cluster.dispose();
    }
  });

  it("ExperimentalDiffSchema invalid comparison is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await expectRpcStatus(
        service(cluster).experimentalDiffSchema({ comparisonSchema: "definition {{{ bad" }),
        status.INVALID_ARGUMENT,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("ExperimentalComputablePermissions returns permissions reachable from a relation", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const resp = await service(cluster).experimentalComputablePermissions({
        definitionName: "document",
        relationName: "editor",
        optionalDefinitionNameFilter: "",
      });

      expect(resp.permissions.map((p) => p.relationName)).toEqual(["manage", "view"]);
      for (const p of resp.permissions) {
        expect(p.definitionName).toBe("document");
        expect(p.isPermission).toBe(true);
      }
    } finally {
      await cluster.dispose();
    }
  });

  it("ExperimentalComputablePermissions unknown relation is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await expectRpcStatus(
        service(cluster).experimentalComputablePermissions({
          definitionName: "document",
          relationName: "nope",
          optionalDefinitionNameFilter: "",
        }),
        status.FAILED_PRECONDITION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("ExperimentalDependentRelations returns relations a permission depends on", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      const resp = await service(cluster).experimentalDependentRelations({
        definitionName: "document",
        permissionName: "view",
      });

      expect(resp.relations.map((r) => r.relationName).sort()).toEqual(["editor", "viewer"]);
      for (const r of resp.relations) expect(r.isPermission).toBe(false);
    } finally {
      await cluster.dispose();
    }
  });

  it("ExperimentalDependentRelations on base relation is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await expectRpcStatus(
        service(cluster).experimentalDependentRelations({
          definitionName: "document",
          permissionName: "viewer",
        }),
        status.INVALID_ARGUMENT,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("ExperimentalDependentRelations unknown definition is not found", async () => {
    const cluster = await MeshTestCluster.create(Schema);
    try {
      await expectRpcStatus(
        service(cluster).experimentalDependentRelations({
          definitionName: "missing",
          permissionName: "view",
        }),
        status.NOT_FOUND,
      );
    } finally {
      await cluster.dispose();
    }
  });
});

function bulkItem(
  document: string,
  permission: string,
  user: string,
): BulkCheckPermissionRequestItem {
  return {
    resource: { objectType: "document", objectId: document },
    permission,
    subject: { object: { objectType: "user", objectId: user }, optionalRelation: "" },
  };
}

function importBatch(
  ...tuples: readonly (readonly [string, string])[]
): BulkImportRelationshipsRequest {
  return {
    relationships: tuples.map(([doc, user]) => ({
      resource: { objectType: "document", objectId: doc },
      relation: "viewer",
      subject: { object: { objectType: "user", objectId: user }, optionalRelation: "" },
      optionalCaveat: undefined,
      optionalExpiresAt: undefined,
    })),
  };
}

function expFilter(overrides: {
  readonly optionalDefinitionNameFilter?: string;
  readonly optionalCaveatNameFilter?: string;
}): ExpSchemaFilter {
  return {
    optionalDefinitionNameFilter: "",
    optionalCaveatNameFilter: "",
    optionalRelationNameFilter: "",
    optionalPermissionNameFilter: "",
    ...overrides,
  };
}

/** A client stream (`FakeAsyncStreamReader<T>`) replaying a fixed sequence of inbound messages. */
async function* asyncStream<T>(...messages: readonly T[]): AsyncIterable<T> {
  for (const message of messages) yield message;
}

/** `Assert.ThrowsAsync<RpcException>`, returning the error for its detail. */
async function rpcErrorFrom(promise: Promise<unknown>): Promise<RpcError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError;
}
