import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";

import { FULLY_CONSISTENT_WIRE } from "./consistency-wire";
import { MeshTestCluster } from "./mesh-test-cluster";
import type {
  ReadRelationshipsArgs,
  RelationshipStreamItem,
  RelationshipUpdateWire,
  RelationshipsFilterWire,
} from "./relationships-dtos";
import { SchemaWriteValidationException } from "./schema-write-validation-exception";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/DataPlaneMeshTests.cs`.
 *
 * Exercises the dynamic-schema and relationship-write data plane THROUGH the real grain mesh
 * (Thresh's in-process `TestCluster`). Clusters start seeded from an initial schema; tests then
 * call the data-plane `IRelationshipsGrain` on the running cluster (writeSchema /
 * writeRelationships / read / delete) and assert that checks reflect the writes - including that a
 * schema swap correctly changes a Check outcome despite the dispatch cache (the schema hash flows
 * into every cache/grain key).
 *
 * PORT NOTES.
 *  - `[Collection(MeshClusterCollection.Name)]` maps to nothing: see `mesh-cluster-collection.ts`
 *    for why vitest's per-file isolation already supplies what the xunit collection asked for.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`
 *    in EVERY case. A leaked cluster is the orphaned-host hazard in miniature.
 *  - The positional C# records (`RelationshipWire`, `RelationshipsFilterWire`) become named DTO
 *    fields; every slot is mapped explicitly so no argument can slide one position.
 *  - `Assert.Equal(2UL, delReply.DeletedCount)` - the grains DTO carries `deletedCount: bigint`,
 *    so `2n` (only the PROTO surface renders uint64 as a string).
 *  - `Convert.FromBase64String(token)` becomes a base64 decode plus a non-empty assertion; the
 *    token's CONTENTS are deliberately not asserted, exactly as in the C#.
 *  - The grain surfaces a schema COMPILE failure as the serializable `ArgumentException`; the port
 *    of that analogue is `InvalidArgumentError`.
 *  - `Assert.Contains("document", ex.Message)` is a SUBSTRING assertion and stays one.
 *  - `ReadTake` breaks out of the `for await` early; a bare `break` calls the async iterator's
 *    `return()`, disposing it as `await foreach` disposes the C# enumerator. The early break is
 *    load-bearing: resuming from that item's cursor proves the cursor works from a fresh
 *    activation.
 */

const EmptySchema = "definition user {}";

const ViewerOnlySchema = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer
}`;

const ViewerOrEditorSchema = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

function touch(res: string, rel: string, subj: string): RelationshipUpdateWire {
  return {
    operation: "touch",
    relationship: {
      resourceType: "document",
      resourceId: res,
      resourceRelation: rel,
      subjectType: "user",
      subjectId: subj,
      subjectRelation: ELLIPSIS,
    },
  };
}

function user(id: string): ObjectAndRelation {
  return { objectType: "user", objectId: id, relation: ELLIPSIS };
}

// ReadRelationships streams from the in-process RelationshipReads helper. Collect the whole
// stream, or take a bounded prefix, so the assertions read as before.
async function readAll(
  cluster: MeshTestCluster,
  args: ReadRelationshipsArgs,
): Promise<RelationshipStreamItem[]> {
  const list: RelationshipStreamItem[] = [];
  for await (const item of cluster.relationshipReads.readRelationships(args)) {
    list.push(item);
  }
  return list;
}

async function readTake(
  cluster: MeshTestCluster,
  args: ReadRelationshipsArgs,
  n: number,
): Promise<RelationshipStreamItem[]> {
  const list: RelationshipStreamItem[] = [];
  for await (const item of cluster.relationshipReads.readRelationships(args)) {
    list.push(item);
    if (list.length >= n) break;
  }
  return list;
}

// ---- WriteSchema change validation fixtures, exercised directly over the grain mesh ----

const SubjectRefSchema = `definition user {}

definition group {
    relation member: user
}

definition document {
    relation viewer: user | group#member
    relation editor: user
    permission view = viewer + editor
}`;

function viewerGroup(doc: string, group: string): RelationshipUpdateWire {
  return {
    operation: "touch",
    relationship: {
      resourceType: "document",
      resourceId: doc,
      resourceRelation: "viewer",
      subjectType: "group",
      subjectId: group,
      subjectRelation: "member",
    },
  };
}

/**
 * The C#'s `Assert.ThrowsAsync<T>` returns THE exception so the message can be asserted on the same
 * throw. `expect(...).rejects` cannot, and calling the action twice would run the write twice, so
 * the rejection is captured once here.
 */
async function captureRejection(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the operation to reject, but it resolved");
}

describe("DataPlaneMeshTests", () => {
  it("WriteSchema_then_WriteRelationships_then_Check_reflects_write", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      const schemaReply = await cluster.writeSchema(ViewerOrEditorSchema);
      expect(schemaReply.writtenAtToken).toBeTruthy();

      const writeReply = await cluster.relationships.writeRelationships({
        updates: [touch("readme", "viewer", "alice")],
      });
      expect(writeReply.writtenAtToken).toBeTruthy();

      const result = await cluster.checker.check(
        "document",
        "readme",
        "view",
        user("alice"),
        undefined,
      );
      expect(result.verdict).toBe("member");

      // The token is an opaque, base64-encoded ZedToken payload.
      const bytes = Buffer.from(writeReply.writtenAtToken, "base64");
      expect(bytes.byteLength).toBeGreaterThan(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("ReadSchema_returns_current_source_text", async () => {
    const cluster = await MeshTestCluster.create(EmptySchema);
    try {
      await cluster.writeSchema(ViewerOrEditorSchema);

      const reply = await cluster.relationships.readSchema();
      expect(reply.schemaText).toBe(ViewerOrEditorSchema);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("ReadRelationships_pages_with_cursor", async () => {
    const cluster = await MeshTestCluster.create(ViewerOrEditorSchema);
    try {
      await cluster.relationships.writeRelationships({
        updates: [
          touch("a", "viewer", "alice"),
          touch("b", "viewer", "alice"),
          touch("c", "viewer", "alice"),
        ],
      });

      const filter: RelationshipsFilterWire = {
        resourceType: "document",
        resourceIdPrefix: undefined,
        resourceIds: undefined,
        resourceRelation: "viewer",
        subjectType: undefined,
        subjectIds: undefined,
        subjectRelation: undefined,
      };

      // Take 2 from a fresh stream, then resume from the 2nd item's cursor on a FRESH grain
      // activation.
      const first = await readTake(cluster, { filter, limit: 2, cursor: undefined }, 2);
      expect(first.length).toBe(2);
      const lastFirst = first.at(-1);
      if (lastFirst === undefined) {
        throw new Error("readTake returned no items");
      }
      // `Assert.False(string.IsNullOrEmpty(...))`: a present, non-empty cursor.
      expect(lastFirst.resumeCursor).toBeTruthy();

      const second = await readAll(cluster, {
        filter,
        limit: 2,
        cursor: lastFirst.resumeCursor,
      });
      expect(second.length).toBe(1);

      const all = new Set([...first, ...second].map((r) => r.relationship.resourceId));
      expect(all).toEqual(new Set(["a", "b", "c"]));
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("DeleteRelationships_by_filter_removes_them", async () => {
    const cluster = await MeshTestCluster.create(ViewerOrEditorSchema);
    try {
      await cluster.relationships.writeRelationships({
        updates: [touch("readme", "viewer", "alice"), touch("readme", "viewer", "bob")],
      });

      const readFilter: RelationshipsFilterWire = {
        resourceType: "document",
        resourceIdPrefix: undefined,
        resourceIds: undefined,
        resourceRelation: "viewer",
        subjectType: undefined,
        subjectIds: undefined,
        subjectRelation: undefined,
      };
      const beforeRead = await readAll(cluster, {
        filter: readFilter,
        limit: undefined,
        cursor: undefined,
      });
      expect(beforeRead.length).toBe(2);

      const delFilter: RelationshipsFilterWire = {
        resourceType: "document",
        resourceIdPrefix: undefined,
        resourceIds: ["readme"],
        resourceRelation: "viewer",
        subjectType: undefined,
        subjectIds: undefined,
        subjectRelation: undefined,
      };
      const delReply = await cluster.relationships.deleteRelationships({
        filter: delFilter,
        optionalLimit: undefined,
      });
      expect(delReply.deletedCount).toBe(2n);

      // Read FullyConsistent to observe the delete immediately: a default (minimize-latency) read
      // resolves to the optimized revision, a real-but-cached head held stable for the
      // quantization window (matching SpiceDB's CachedOptimizedRevisions / memdb floored bucket),
      // so a write that lands mid-window is not yet reflected. To see one's own just-committed
      // mutation deterministically a caller asks for full consistency (or reads at the mutation's
      // returned token).
      const afterRead = await readAll(cluster, {
        filter: readFilter,
        limit: undefined,
        cursor: undefined,
        consistency: FULLY_CONSISTENT_WIRE,
      });
      expect(afterRead).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("SchemaChange_flips_Check_outcome_across_cache", async () => {
    // Schema A: view = viewer. Bob is editor (NOT viewer) -> NO permission (this caches under
    // hash(A)).
    const cluster = await MeshTestCluster.create(ViewerOnlySchema);
    try {
      await cluster.relationships.writeRelationships({
        updates: [touch("readme", "editor", "bob")],
      });

      const hashA = cluster.schemaProvider.current.schemaHash;
      const before = await cluster.checker.check(
        "document",
        "readme",
        "view",
        user("bob"),
        undefined,
      );
      expect(before.verdict).toBe("notMember");

      // Schema B: view = viewer + editor. Swap the live schema -> new hash.
      await cluster.writeSchema(ViewerOrEditorSchema);
      const hashB = cluster.schemaProvider.current.schemaHash;
      expect(hashB).not.toBe(hashA);

      // Same check must now be HAS_PERMISSION: the stale hash(A) NO entry can never be returned
      // because every new cache/grain key is prefixed with the current hash(B).
      const after = await cluster.checker.check(
        "document",
        "readme",
        "view",
        user("bob"),
        undefined,
      );
      expect(after.verdict).toBe("member");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("SchemaChange_reverse_direction_flips_Member_to_NotMember", async () => {
    const cluster = await MeshTestCluster.create(ViewerOrEditorSchema);
    try {
      await cluster.relationships.writeRelationships({
        updates: [touch("readme", "editor", "bob")],
      });

      const before = await cluster.checker.check(
        "document",
        "readme",
        "view",
        user("bob"),
        undefined,
      );
      expect(before.verdict).toBe("member");

      await cluster.writeSchema(ViewerOnlySchema);

      const after = await cluster.checker.check(
        "document",
        "readme",
        "view",
        user("bob"),
        undefined,
      );
      expect(after.verdict).toBe("notMember");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("WriteSchema_invalid_throws_and_leaves_current_unchanged", async () => {
    const cluster = await MeshTestCluster.create(ViewerOrEditorSchema);
    try {
      const hashBefore = cluster.schemaProvider.current.schemaHash;

      // The grain surfaces a compile failure as a serializable ArgumentException across the
      // boundary.
      const ex = await captureRejection(cluster.writeSchema("definition document { relation"));
      expect(ex).toBeInstanceOf(InvalidArgumentError);

      expect(cluster.schemaProvider.current.schemaHash).toBe(hashBefore);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- WriteSchema change validation, exercised directly over the grain mesh ----
  //
  // These complement the write-safety gRPC suite (which drives the same paths through the gRPC
  // service) by asserting, at the grain boundary, that a rejected schema change surfaces the
  // serializable SchemaWriteValidationException AND leaves the LIVE schema snapshot intact (the
  // datastore-persist and the in-memory swap are both abandoned).

  it("WriteSchema_removing_referenced_definition_is_rejected_and_live_schema_unchanged", async () => {
    const cluster = await MeshTestCluster.create(ViewerOrEditorSchema);
    try {
      await cluster.relationships.writeRelationships({
        updates: [touch("readme", "viewer", "alice")],
      });

      const hashBefore = cluster.schemaProvider.current.schemaHash;

      // Drop `document` entirely while a relationship is written under it.
      const ex = await captureRejection(cluster.writeSchema(EmptySchema));
      expect(ex).toBeInstanceOf(SchemaWriteValidationException);
      expect((ex as Error).message).toContain("document");

      // Live schema snapshot untouched, and the check still resolves against the old schema.
      expect(cluster.schemaProvider.current.schemaHash).toBe(hashBefore);
      const check = await cluster.checker.check(
        "document",
        "readme",
        "view",
        user("alice"),
        undefined,
      );
      expect(check.verdict).toBe("member");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("WriteSchema_removing_referenced_relation_is_rejected_and_live_schema_unchanged", async () => {
    const cluster = await MeshTestCluster.create(ViewerOrEditorSchema);
    try {
      await cluster.relationships.writeRelationships({
        updates: [touch("readme", "viewer", "alice")],
      });

      const hashBefore = cluster.schemaProvider.current.schemaHash;

      // Drop the `viewer` relation while it is still written.
      const withoutViewer = `definition user {}

definition document {
    relation editor: user
    permission view = editor
}`;

      const ex = await captureRejection(cluster.writeSchema(withoutViewer));
      expect(ex).toBeInstanceOf(SchemaWriteValidationException);
      expect((ex as Error).message).toContain("viewer");

      expect(cluster.schemaProvider.current.schemaHash).toBe(hashBefore);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("WriteSchema_removing_relation_referenced_as_subject_is_rejected_and_live_schema_unchanged", async () => {
    const cluster = await MeshTestCluster.create(SubjectRefSchema);
    try {
      await cluster.relationships.writeRelationships({
        updates: [viewerGroup("readme", "eng")],
      });

      const hashBefore = cluster.schemaProvider.current.schemaHash;

      // Remove group#member: it is referenced on the SUBJECT side of document#viewer.
      const withoutGroupMember = `definition user {}

definition group {}

definition document {
    relation viewer: user | group#member
    relation editor: user
    permission view = viewer + editor
}`;

      const ex = await captureRejection(cluster.writeSchema(withoutGroupMember));
      expect(ex).toBeInstanceOf(SchemaWriteValidationException);
      expect((ex as Error).message).toContain("member");

      expect(cluster.schemaProvider.current.schemaHash).toBe(hashBefore);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("WriteSchema_removing_referenced_allowed_subject_type_is_rejected_and_live_schema_unchanged", async () => {
    const cluster = await MeshTestCluster.create(SubjectRefSchema);
    try {
      await cluster.relationships.writeRelationships({
        updates: [touch("readme", "viewer", "alice")],
      });

      const hashBefore = cluster.schemaProvider.current.schemaHash;

      // Keep `viewer` but drop `user` from its allowed subject types while a user subject is
      // written.
      const viewerWithoutUser = `definition user {}

definition group {
    relation member: user
}

definition document {
    relation viewer: group#member
    relation editor: user
    permission view = viewer + editor
}`;

      const ex = await captureRejection(cluster.writeSchema(viewerWithoutUser));
      expect(ex).toBeInstanceOf(SchemaWriteValidationException);

      expect(cluster.schemaProvider.current.schemaHash).toBe(hashBefore);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("WriteSchema_removing_unreferenced_definition_is_allowed", async () => {
    const cluster = await MeshTestCluster.create(SubjectRefSchema);
    try {
      // Only document relationships exist; `group` carries none, so dropping it is safe.
      await cluster.relationships.writeRelationships({
        updates: [touch("readme", "viewer", "alice")],
      });

      const withoutGroup = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

      const reply = await cluster.writeSchema(withoutGroup);
      expect(reply.writtenAtToken).toBeTruthy();
      expect(cluster.schemaProvider.current.sourceText).toBe(withoutGroup);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("WriteSchema_removing_unreferenced_relation_is_allowed", async () => {
    const cluster = await MeshTestCluster.create(ViewerOrEditorSchema);
    try {
      // Only viewer is written; editor carries no relationships, so dropping editor is safe.
      await cluster.relationships.writeRelationships({
        updates: [touch("readme", "viewer", "alice")],
      });

      const withoutEditor = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

      const reply = await cluster.writeSchema(withoutEditor);
      expect(reply.writtenAtToken).toBeTruthy();
      expect(cluster.schemaProvider.current.sourceText).toBe(withoutEditor);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("WriteSchema_permission_only_change_is_always_allowed", async () => {
    const cluster = await MeshTestCluster.create(ViewerOnlySchema);
    try {
      await cluster.relationships.writeRelationships({
        updates: [touch("readme", "viewer", "alice")],
      });

      // Relations untouched; only the permission expression changes -> always safe.
      const reply = await cluster.writeSchema(ViewerOrEditorSchema);
      expect(reply.writtenAtToken).toBeTruthy();
      expect(cluster.schemaProvider.current.sourceText).toBe(ViewerOrEditorSchema);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
