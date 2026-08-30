import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import { MeshTestCluster } from "@spacedb/grains/mesh-test-cluster";
import type { RelationshipFilter } from "@spacedb/protos/authzed/api/v1/permission_service";
import { describe, expect, it } from "vitest";

import { AuthzedExperimentalV1Service } from "./authzed-experimental-v1-service";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/AuthzedExperimentalV1ServiceTests.cs`.
 *
 * Drives the `authzed.api.v1` {@link AuthzedExperimentalV1Service} IN-PROCESS over the mesh
 * cluster's grain mesh (in-memory datastore). Verifies the on-demand relationship-counter RPCs:
 * register + count returns the matching count with a non-empty read-at token; the count tracks
 * subsequent matching / non-matching writes; unregister then count is FAILED_PRECONDITION;
 * re-registering an existing name is FAILED_PRECONDITION.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@spacedb/grains` does not depend on `@spacedb/api`.
 *  - `FakeServerCallContext : ServerCallContext` DISAPPEARS: the ported methods take a trailing
 *    optional `AbortSignal`, so every call passes nothing.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - `CounterResultOneofCase.ReadCounterValue` becomes "the `readCounterValue` sibling field is
 *    defined", ts-proto's rendering of a oneof.
 *  - `Assert.Equal(2UL, ...RelationshipCount)`: the field is uint64 and ts-proto renders it as a
 *    STRING, so the expectation is `"2"`, never the number 2.
 *  - `resp.ReadCounterValue.ReadAt?.Token` is null-conditional in the C#, so the optional
 *    dereference is kept rather than asserting the submessage exists.
 *  - The non-matching write uses resource type "user" with relation `...` - an ELLIPSIS as a
 *    RELATION on the resource side, which the schema does not define. Kept verbatim: it is
 *    deliberately outside the counter's filter.
 *  - The C#'s positional `RelationshipWire(...)` record is spelled with NAMED fields here so no
 *    argument can slide a slot.
 */

const Schema = `definition user {}
definition document {
    relation viewer: user
    permission view = viewer
}`;

function service(cluster: MeshTestCluster): AuthzedExperimentalV1Service {
  return new AuthzedExperimentalV1Service(cluster.grainFactory, cluster.schemaProvider);
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
              resourceType: "user",
              resourceId: "alice",
              resourceRelation: ELLIPSIS,
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
});
