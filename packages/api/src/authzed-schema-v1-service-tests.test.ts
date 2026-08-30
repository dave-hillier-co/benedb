import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import { MeshTestCluster } from "@spacedb/grains/mesh-test-cluster";
import type { ReflectionSchemaFilter } from "@spacedb/protos/authzed/api/v1/schema_service";
import { describe, expect, it } from "vitest";

import { AuthzedSchemaV1Service } from "./authzed-schema-v1-service";
import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/AuthzedSchemaV1ServiceTests.cs`.
 *
 * Drives the `authzed.api.v1` {@link AuthzedSchemaV1Service} IN-PROCESS over the mesh cluster's
 * grain mesh. Verifies: write-then-read round-trips the schema text; invalid schema text maps to
 * INVALID_ARGUMENT; an orphaning change maps to FAILED_PRECONDITION; reading a never-written
 * schema maps to NOT_FOUND; plus the reflection, diff and introspection RPCs.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@spacedb/grains` does not depend on `@spacedb/api`.
 *  - `FakeServerCallContext : ServerCallContext` DISAPPEARS: the ported methods take a trailing
 *    optional `AbortSignal`, so every call passes nothing.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - The C#'s positional `RelationshipWire(...)` record is spelled with NAMED fields here so no
 *    argument can slide a slot; the LAST positional slot is the expiration, which the port carries
 *    as epoch NANOS (`bigint`), so `DateTimeOffset.UtcNow.AddDays(7)` becomes
 *    `BigInt(Date.now() + 7 days) * 1_000_000n`.
 *  - `ReflectionSchemaFilter` is a ts-proto message whose four string fields are all required, so
 *    {@link reflectFilter} fills the unset ones with "" - the proto default the C# builder leaves.
 *  - `ReflectionSchemaDiff.DiffOneofCase.X` becomes "the `x` sibling field is defined", ts-proto's
 *    rendering of a oneof; the nested `name` / `relation` / `changedSubjectType` fields are
 *    matched exactly as the C# matches them.
 *  - `Assert.Equal(["manage", "view"], ...)` and `["editor", "viewer"]` (the latter after an
 *    explicit `OrderBy`) are ORDERED assertions and keep the C#'s sort, or its absence.
 */

const Schema = `definition user {}
definition document {
    relation viewer: user
    permission view = viewer
}`;

// A cluster needs a compiled schema to start, so the "no schema" case starts from an empty schema text.
const EmptySchema = "";

function service(cluster: MeshTestCluster): AuthzedSchemaV1Service {
  return new AuthzedSchemaV1Service(cluster.grainFactory, cluster.schemaProvider);
}

function reflectFilter(overrides: Partial<ReflectionSchemaFilter> = {}): ReflectionSchemaFilter {
  return {
    optionalDefinitionNameFilter: "",
    optionalCaveatNameFilter: "",
    optionalRelationNameFilter: "",
    optionalPermissionNameFilter: "",
    ...overrides,
  };
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

describe("AuthzedSchemaV1ServiceTests", () => {
  it("WriteSchema then ReadSchema round trips text", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      await svc.writeSchema({ schema: Schema });

      const read = await svc.readSchema({});
      expect(read.schemaText).toContain("definition document");
      expect(read.schemaText).toContain("permission view");
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteSchema invalid text is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      await expectRpcStatus(
        svc.writeSchema({ schema: "this is not a valid schema {{{" }),
        status.INVALID_ARGUMENT,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteSchema orphaning change is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      await svc.writeSchema({ schema: Schema });

      // Write a viewer relationship, then attempt to drop the viewer relation that backs it.
      await cluster.relationships.writeRelationships({
        updates: [
          {
            operation: "touch",
            relationship: {
              resourceType: "document",
              resourceId: "readme",
              resourceRelation: "viewer",
              subjectType: "user",
              subjectId: "alice",
              subjectRelation: ELLIPSIS,
              caveatName: undefined,
              caveatContext: undefined,
              expiration: undefined,
            },
          },
        ],
      });

      const orphaning = `definition user {}
definition document {
    permission view = nil
}`;

      await expectRpcStatus(svc.writeSchema({ schema: orphaning }), status.FAILED_PRECONDITION);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteSchema with type error is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      // A permission referencing an undefined relation: rejected at write time as a type error.
      const bad = `definition user {}
definition document {
    permission view = nonexistent
}`;

      await expectRpcStatus(svc.writeSchema({ schema: bad }), status.FAILED_PRECONDITION);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteSchema removing caveat parameter is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      const withTwo = `definition user {}
definition document {
    relation viewer: user with c
}
caveat c(a int, b int) { a > 0 && b > 0 }`;
      await svc.writeSchema({ schema: withTwo });

      // Removing parameter `b` is rejected unconditionally (existing relationships may be typed by it).
      const withOne = `definition user {}
definition document {
    relation viewer: user with c
}
caveat c(a int) { a > 0 }`;
      await expectRpcStatus(svc.writeSchema({ schema: withOne }), status.FAILED_PRECONDITION);
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteSchema removing expiration trait with expiring relationship is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      // `user with expiration` requires the expiration trait. The trait is part of the allowed-type
      // identity, so dropping it is a RelationSubjectTypeRemoved delta that the orphan check inspects.
      const withExpiration = `use expiration

definition user {}
definition document {
    relation viewer: user with expiration
}`;
      await svc.writeSchema({ schema: withExpiration });

      // A relationship that actually carries an expiration: it references `user with expiration`.
      await cluster.relationships.writeRelationships({
        updates: [
          {
            operation: "touch",
            relationship: {
              resourceType: "document",
              resourceId: "readme",
              resourceRelation: "viewer",
              subjectType: "user",
              subjectId: "alice",
              subjectRelation: ELLIPSIS,
              caveatName: undefined,
              caveatContext: undefined,
              // `DateTimeOffset.UtcNow.AddDays(7)` as epoch nanos.
              expiration: BigInt(Date.now() + 7 * 24 * 60 * 60 * 1000) * 1_000_000n,
            },
          },
        ],
      });

      // Dropping the expiration trait orphans that relationship, so the change is rejected.
      const withoutExpiration = `definition user {}
definition document {
    relation viewer: user
}`;
      await expectRpcStatus(
        svc.writeSchema({ schema: withoutExpiration }),
        status.FAILED_PRECONDITION,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("WriteSchema removing expiration trait with non expiring relationship is allowed", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      // The relation allows BOTH an expiring and a non-expiring `user` subject, so a relationship
      // without an expiration references the plain `user` allowed type, not `user with expiration`.
      const withBoth = `use expiration

definition user {}
definition document {
    relation viewer: user | user with expiration
}`;
      await svc.writeSchema({ schema: withBoth });

      await cluster.relationships.writeRelationships({
        updates: [
          {
            operation: "touch",
            relationship: {
              resourceType: "document",
              resourceId: "readme",
              resourceRelation: "viewer",
              subjectType: "user",
              subjectId: "alice",
              subjectRelation: ELLIPSIS,
              caveatName: undefined,
              caveatContext: undefined,
              expiration: undefined,
            },
          },
        ],
      });

      // Dropping only the `with expiration` allowed type: the non-expiring relationship is filtered
      // out by the orphan check's expiration filter, so the change is accepted.
      const withoutExpiration = `definition user {}
definition document {
    relation viewer: user
}`;
      await svc.writeSchema({ schema: withoutExpiration });

      const read = await svc.readSchema({});
      expect(read.schemaText).toContain("relation viewer: user");
    } finally {
      await cluster.dispose();
    }
  });

  it("ReadSchema on fresh cluster is not found", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      await expectRpcStatus(svc.readSchema({}), status.NOT_FOUND);
    } finally {
      await cluster.dispose();
    }
  });

  const ReflectSchema = `definition user {}
caveat ip_match(allowed string, user_ip string) {
    user_ip == allowed
}
definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

  it("ReflectSchema returns definitions relations permissions and caveats", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);
      await svc.writeSchema({ schema: ReflectSchema });

      const resp = await svc.reflectSchema({ optionalFilters: [] });

      expect(resp.definitions).toHaveLength(2);
      expect(resp.definitions.some((d) => d.name === "user")).toBe(true);
      const docs = resp.definitions.filter((d) => d.name === "document");
      expect(docs).toHaveLength(1);
      const doc = docs[0]!;

      expect(doc.relations).toHaveLength(2);
      const viewers = doc.relations.filter((r) => r.name === "viewer");
      expect(viewers).toHaveLength(1);
      const viewer = viewers[0]!;
      expect(viewer.subjectTypes).toHaveLength(1);
      const subject = viewer.subjectTypes[0]!;
      expect(subject.subjectDefinitionName).toBe("user");
      expect(subject.isTerminalSubject).toBe(true);

      expect(doc.permissions).toHaveLength(1);
      const view = doc.permissions[0]!;
      expect(view.name).toBe("view");

      expect(resp.caveats).toHaveLength(1);
      const caveat = resp.caveats[0]!;
      expect(caveat.name).toBe("ip_match");
      expect(caveat.parameters).toHaveLength(2);
      expect(caveat.parameters.some((p) => p.name === "allowed" && p.type === "string")).toBe(true);
      expect(caveat.expression).toContain("user_ip == allowed");
    } finally {
      await cluster.dispose();
    }
  });

  it("ReflectSchema definition name filter returns only matching definitions", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);
      await svc.writeSchema({ schema: ReflectSchema });

      const resp = await svc.reflectSchema({
        optionalFilters: [reflectFilter({ optionalDefinitionNameFilter: "doc" })],
      });

      expect(resp.definitions).toHaveLength(1);
      expect(resp.definitions[0]!.name).toBe("document");
      expect(resp.caveats).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("ReflectSchema mutually exclusive filter is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);
      await svc.writeSchema({ schema: ReflectSchema });

      await expectRpcStatus(
        svc.reflectSchema({
          optionalFilters: [
            reflectFilter({
              optionalDefinitionNameFilter: "document",
              optionalCaveatNameFilter: "ip",
            }),
          ],
        }),
        status.INVALID_ARGUMENT,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("DiffSchema reports expected oneof cases", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      const baseSchema = `definition user {}
definition group {}
definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer
    permission manage = editor
}`;
      await svc.writeSchema({ schema: baseSchema });

      const comparison = `definition user {}
definition group {}
definition folder {}
definition document {
    relation viewer: user | group
    relation editor: user
    relation owner: user
    permission view = viewer + editor
}`;

      const resp = await svc.diffSchema({ comparisonSchema: comparison });

      expect(
        resp.diffs.some(
          (d) => d.definitionAdded !== undefined && d.definitionAdded.name === "folder",
        ),
      ).toBe(true);
      expect(
        resp.diffs.some((d) => d.relationAdded !== undefined && d.relationAdded.name === "owner"),
      ).toBe(true);
      expect(
        resp.diffs.some(
          (d) => d.permissionRemoved !== undefined && d.permissionRemoved.name === "manage",
        ),
      ).toBe(true);
      expect(
        resp.diffs.some(
          (d) =>
            d.relationSubjectTypeAdded !== undefined &&
            d.relationSubjectTypeAdded.relation?.name === "viewer" &&
            d.relationSubjectTypeAdded.changedSubjectType?.subjectDefinitionName === "group",
        ),
      ).toBe(true);
      expect(
        resp.diffs.some(
          (d) => d.permissionExprChanged !== undefined && d.permissionExprChanged.name === "view",
        ),
      ).toBe(true);
    } finally {
      await cluster.dispose();
    }
  });

  it("DiffSchema adding expiration trait reports subject type add and remove", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      // The expiration trait is part of the allowed-type identity, so `user` -> `user with expiration`
      // is a genuine subject-type change: the old `user` is removed and `user with expiration` is added.
      const baseSchema = `use expiration

definition user {}
definition document {
    relation viewer: user
}`;
      await svc.writeSchema({ schema: baseSchema });

      const comparison = `use expiration

definition user {}
definition document {
    relation viewer: user with expiration
}`;

      const resp = await svc.diffSchema({ comparisonSchema: comparison });

      expect(
        resp.diffs.some(
          (d) =>
            d.relationSubjectTypeRemoved !== undefined &&
            d.relationSubjectTypeRemoved.relation?.name === "viewer" &&
            d.relationSubjectTypeRemoved.changedSubjectType?.subjectDefinitionName === "user",
        ),
      ).toBe(true);
      expect(
        resp.diffs.some(
          (d) =>
            d.relationSubjectTypeAdded !== undefined &&
            d.relationSubjectTypeAdded.relation?.name === "viewer" &&
            d.relationSubjectTypeAdded.changedSubjectType?.subjectDefinitionName === "user",
        ),
      ).toBe(true);
    } finally {
      await cluster.dispose();
    }
  });

  it("DiffSchema identical schema yields no diffs", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);
      await svc.writeSchema({ schema: ReflectSchema });

      const resp = await svc.diffSchema({ comparisonSchema: ReflectSchema });

      expect(resp.diffs).toHaveLength(0);
    } finally {
      await cluster.dispose();
    }
  });

  it("DiffSchema invalid comparison is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);
      await svc.writeSchema({ schema: ReflectSchema });

      await expectRpcStatus(
        svc.diffSchema({ comparisonSchema: "definition {{{ bad" }),
        status.INVALID_ARGUMENT,
      );
    } finally {
      await cluster.dispose();
    }
  });

  const ComputableSchema = `definition user {}
definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
    permission manage = editor
}`;

  it("ComputablePermissions returns permissions reachable from a relation", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);
      await svc.writeSchema({ schema: ComputableSchema });

      const viewer = await svc.computablePermissions({
        definitionName: "document",
        relationName: "viewer",
        optionalDefinitionNameFilter: "",
      });
      expect(viewer.permissions.map((p) => p.relationName)).toEqual(["view"]);
      for (const p of viewer.permissions) expect(p.isPermission).toBe(true);

      const editor = await svc.computablePermissions({
        definitionName: "document",
        relationName: "editor",
        optionalDefinitionNameFilter: "",
      });
      expect(editor.permissions.map((p) => p.relationName)).toEqual(["manage", "view"]);
    } finally {
      await cluster.dispose();
    }
  });

  it("ComputablePermissions unknown relation is failed precondition", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);
      await svc.writeSchema({ schema: ComputableSchema });

      await expectRpcStatus(
        svc.computablePermissions({
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

  it("DependentRelations returns relations a permission depends on", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);
      await svc.writeSchema({ schema: ComputableSchema });

      const resp = await svc.dependentRelations({
        definitionName: "document",
        permissionName: "view",
      });

      expect(resp.relations.map((r) => r.relationName).sort()).toEqual(["editor", "viewer"]);
      for (const r of resp.relations) expect(r.isPermission).toBe(false);
    } finally {
      await cluster.dispose();
    }
  });

  it("DependentRelations through arrow includes tupleset and parent permission", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);

      const arrowSchema = `definition user {}
definition folder {
    relation viewer: user
    permission view = viewer
}
definition document {
    relation viewer: user
    relation parent: folder
    permission view = viewer + parent->view
}`;
      await svc.writeSchema({ schema: arrowSchema });

      const resp = await svc.dependentRelations({
        definitionName: "document",
        permissionName: "view",
      });

      expect(
        resp.relations.some((r) => r.definitionName === "document" && r.relationName === "parent"),
      ).toBe(true);
      expect(
        resp.relations.some((r) => r.definitionName === "folder" && r.relationName === "view"),
      ).toBe(true);
      expect(
        resp.relations.some((r) => r.definitionName === "folder" && r.relationName === "viewer"),
      ).toBe(true);
    } finally {
      await cluster.dispose();
    }
  });

  it("DependentRelations on base relation is invalid argument", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);
      await svc.writeSchema({ schema: ComputableSchema });

      await expectRpcStatus(
        svc.dependentRelations({ definitionName: "document", permissionName: "viewer" }),
        status.INVALID_ARGUMENT,
      );
    } finally {
      await cluster.dispose();
    }
  });

  it("DependentRelations unknown definition is not found", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const svc = service(cluster);
      await svc.writeSchema({ schema: ComputableSchema });

      await expectRpcStatus(
        svc.dependentRelations({ definitionName: "missing", permissionName: "view" }),
        status.NOT_FOUND,
      );
    } finally {
      await cluster.dispose();
    }
  });
});
