import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import type { Relationship } from "@spacedb/core/relationship";
import { createRelationship } from "@spacedb/core/relationship";
import { LookupResourcesEngine } from "@spacedb/engine/lookup-resources-engine";

import type { ConsistencyWire } from "./consistency-wire";
import { FULLY_CONSISTENT_WIRE } from "./consistency-wire";
import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/Stage4LeopardMeshTests.cs`.
 *
 * Stage-4 gates for the Leopard membership-walk grain mesh (`MembershipWalkGrain`) wired into the
 * mesh behind the `useMembershipWalk` flag. Drives `ReverseOps.streamLookupResources` with the
 * accelerator ON and proves the result set is IDENTICAL to the accelerator-OFF engine over the same
 * snapshot (equivalence end-to-end), that every returned resource is Check-confirmed, that a
 * runtime schema swap rotates the walk-grain keyspace (a new schema hash addresses disjoint
 * activations rather than requiring cache invalidation), and that a delete immediately excludes the
 * detached subtree at the post-delete revision.
 *
 * PORT NOTES.
 *  - `useMembershipWalk: true` is a {@link MeshTestClusterOptions} field, and the PORTED DEFAULT IS
 *    ALREADY `true` (`membershipWalkOptions: { enabled: options.useMembershipWalk ?? true }`).
 *    Passing it here is therefore DOCUMENTATION of what these cases require, not a behaviour
 *    change - it is kept rather than dropped so the requirement stays stated at the site, and so a
 *    later default flip cannot silently turn the accelerator off underneath this suite.
 *  - `SortedSet<string>(StringComparer.Ordinal)` compared with `Assert.Equal` becomes an
 *    ordinal-sorted array compared with `toEqual`, sorted by the BARE `sort()` (UTF-16 code units),
 *    never `localeCompare`.
 *  - The three schema constants are deliberately DISTINCT and are NOT deduped:
 *    `FLAT_GROUP_SCHEMA` is non-self-referential because the dynamic WriteSchema validator rejects
 *    a relation listing its own `type#relation` as a subject, and `DELETE_HEAVY_SCHEMA` is a
 *    separate instance so this file's cases stay independent.
 *  - `ConsistencyWire.FullyConsistent` is {@link FULLY_CONSISTENT_WIRE} - the WIRE enum, distinct
 *    from the engine's `ConsistencyRequirement`.
 *  - ONE cluster per case, disposed in a `finally`, each with an explicit long timeout (the `unit`
 *    project's default is 5s).
 */

const NESTED_SCHEMA = `definition user {}

definition group {
    relation member: user | group#member
}

definition document {
    relation viewer: user | group#member
    relation editor: user
    permission view = viewer + editor
}`;

// A single-level (non-self-referential) group schema. The dynamic WriteSchema validator rejects a
// relation that lists its own `type#relation` as a subject, so the schema-swap gate uses this
// flatten-coverable but non-recursive shape (document.viewer still flattens through group#member).
const FLAT_GROUP_SCHEMA = `definition user {}

definition group {
    relation member: user
}

definition document {
    relation viewer: user | group#member
    permission view = viewer
}`;

// A distinct instance from FLAT_GROUP_SCHEMA above so this file's tests stay independent.
const DELETE_HEAVY_SCHEMA = `definition user {}

definition group {
    relation member: user | group#member
}

definition document {
    relation viewer: user | group#member
    permission view = viewer
}`;

function rel(rt: string, rid: string, relation: string, subject: ObjectAndRelation): Relationship {
  return createRelationship({ objectType: rt, objectId: rid, relation }, subject);
}

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

async function seed(cluster: MeshTestCluster, ...rels: readonly Relationship[]): Promise<void> {
  await cluster.datastore.readWriteTx((tx) =>
    tx.writeRelationships(
      rels.map((relationship) => ({ relationship, operation: "create" as const })),
    ),
  );
}

/** The index-OFF engine's answer over the same pinned snapshot the grain would use. */
async function engineResources(
  cluster: MeshTestCluster,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  resourceType: string,
  permission: string,
): Promise<string[]> {
  const schema = cluster.services.schemaProvider.current;
  const rev = await cluster.datastore.optimizedRevision();
  const reader = cluster.datastore.snapshotReader(rev.revision);
  const engine = new LookupResourcesEngine(schema.namespaces, schema.caveats);

  const ids = new Set<string>();
  // `coveredCandidateIds: null` is the plain (candidate-free) overload here.
  for await (const f of engine.lookupResources(
    reader,
    subjectType,
    subjectId,
    subjectRelation,
    resourceType,
    permission,
  )) {
    ids.add(f.resourceId);
  }
  return [...ids].sort();
}

async function grainResources(
  cluster: MeshTestCluster,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  resourceType: string,
  permission: string,
  consistency?: ConsistencyWire | undefined,
): Promise<string[]> {
  const ids = new Set<string>();
  for await (const r of cluster.reverseOps.streamLookupResources({
    resourceType,
    permission,
    subjectType,
    subjectId,
    subjectRelation,
    context: undefined,
    limit: undefined,
    cursor: undefined,
    consistency,
  })) {
    ids.add(r.resourceId);
  }
  return [...ids].sort();
}

async function assertGrainEqualsEngine(
  cluster: MeshTestCluster,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  resourceType: string,
  permission: string,
): Promise<void> {
  const engine = await engineResources(
    cluster,
    subjectType,
    subjectId,
    subjectRelation,
    resourceType,
    permission,
  );
  const grain = await grainResources(
    cluster,
    subjectType,
    subjectId,
    subjectRelation,
    resourceType,
    permission,
  );
  expect(grain).toEqual(engine);

  // The consistency invariant: every resource the index-accelerated grain returns is
  // Check-confirmed.
  for (const id of grain) {
    const result = await cluster.checker.check(
      resourceType,
      id,
      permission,
      onr(subjectType, subjectId, subjectRelation),
      undefined,
    );
    expect(result.verdict).not.toBe("notMember");
  }
}

describe("Stage4LeopardMeshTests", () => {
  it("IndexedLookupResources_EqualsLiveEngine_AcrossNestedGroups", async () => {
    const cluster = await MeshTestCluster.create(NESTED_SCHEMA, { useMembershipWalk: true });
    try {
      await seed(
        cluster,
        rel("group", "g1", "member", onr("user", "alice")),
        rel("group", "g2", "member", onr("group", "g1", "member")),
        rel("group", "g3", "member", onr("group", "g2", "member")),
        rel("group", "g3", "member", onr("user", "bob")),
        rel("document", "d1", "viewer", onr("group", "g3", "member")),
        rel("document", "d2", "viewer", onr("group", "g1", "member")),
        rel("document", "d3", "editor", onr("user", "alice")),
      );

      await assertGrainEqualsEngine(cluster, "user", "alice", ELLIPSIS, "group", "member");
      await assertGrainEqualsEngine(cluster, "user", "bob", ELLIPSIS, "group", "member");
      await assertGrainEqualsEngine(cluster, "user", "alice", ELLIPSIS, "document", "view");
      await assertGrainEqualsEngine(cluster, "user", "bob", ELLIPSIS, "document", "view");
      await assertGrainEqualsEngine(cluster, "user", "nobody", ELLIPSIS, "document", "view");
    } finally {
      await cluster.dispose();
    }
  }, 180_000);

  it("SchemaSwap_InvalidatesOldHashIndex_AndStaysCorrect", async () => {
    const cluster = await MeshTestCluster.create(FLAT_GROUP_SCHEMA, { useMembershipWalk: true });
    try {
      await seed(
        cluster,
        rel("group", "g1", "member", onr("user", "alice")),
        rel("document", "d1", "viewer", onr("group", "g1", "member")),
      );

      // Warm the walk-grain mesh under the original schema hash.
      await assertGrainEqualsEngine(cluster, "user", "alice", ELLIPSIS, "document", "view");

      // Swap the schema (add an unrelated definition) -> a new schema hash. Because the schema hash
      // is a SEGMENT of IMembershipWalkGrain's key (see membership-walk-key.ts), this proves KEY
      // ROTATION rather than any cache-invalidation logic: a walk request after the swap simply
      // addresses a disjoint set of grain activations under the new hash - there is nothing stale to
      // invalidate - and lookups stay correct under the new schema's coverage.
      await cluster.writeSchema(
        `${FLAT_GROUP_SCHEMA}\ndefinition folder { relation viewer: user }`,
      );

      await assertGrainEqualsEngine(cluster, "user", "alice", ELLIPSIS, "document", "view");
      await assertGrainEqualsEngine(cluster, "user", "alice", ELLIPSIS, "group", "member");
    } finally {
      await cluster.dispose();
    }
  }, 180_000);

  it("DeleteHeavy_DetachedSubtree_IsExcludedImmediatelyAtThePostDeleteRevision", async () => {
    // The retired per-silo replica's weak spot: a delete folded into a shared, revision-approximate
    // cache could still serve a stale membership for a request pinned exactly at the post-delete
    // revision. A walk over a reader pinned to that EXACT revision has no such window - this is its
    // trivial case, not a special one.
    const cluster = await MeshTestCluster.create(DELETE_HEAVY_SCHEMA, { useMembershipWalk: true });
    try {
      await seed(
        cluster,
        rel("group", "g1", "member", onr("user", "alice")),
        rel("group", "g2", "member", onr("group", "g1", "member")),
        rel("group", "g3", "member", onr("group", "g2", "member")),
        rel("document", "d1", "viewer", onr("group", "g3", "member")),
      );

      // Before the delete: alice reaches d1 through the nested chain. Fully-consistent reads
      // throughout this test so each request pins EXACTLY head - a minimize-latency read would
      // legitimately serve the quantized optimized revision, which can still predate the delete
      // (correct consistency semantics, but not what this gate is proving).
      const before = await grainResources(
        cluster,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
        FULLY_CONSISTENT_WIRE,
      );
      expect(before).toContain("d1");

      // Sever the middle edge (g2 no longer contains g1): the whole g1 subtree detaches from g3/d1.
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: rel("group", "g2", "member", onr("group", "g1", "member")),
            operation: "delete",
          },
        ]),
      );

      // At the post-delete revision, d1 (and any resource reachable only through the severed
      // subtree) must be excluded immediately - no fold lag, because the walk reads a fresh pinned
      // snapshot.
      const after = await grainResources(
        cluster,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
        FULLY_CONSISTENT_WIRE,
      );
      expect(after).not.toContain("d1");

      // alice is still a member of g1 itself (that edge was untouched), but g1 is no longer
      // reachable from g3, so the group-membership walk reflects the severed edge too.
      const groups = await grainResources(
        cluster,
        "user",
        "alice",
        ELLIPSIS,
        "group",
        "member",
        FULLY_CONSISTENT_WIRE,
      );
      expect(groups).toContain("g1");
      expect(groups).not.toContain("g3");

      // And the head-pinned engine agrees with the head-pinned grain result (walked == live at
      // head). This one pins HEAD, not the optimized revision `engineResources` uses.
      const head = await cluster.datastore.headRevision();
      const schema = cluster.schemaProvider.current;
      const engine = new LookupResourcesEngine(schema.namespaces, schema.caveats);
      const liveAtHead = new Set<string>();
      for await (const f of engine.lookupResources(
        cluster.datastore.snapshotReader(head.revision),
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
      )) {
        liveAtHead.add(f.resourceId);
      }
      expect(after).toEqual([...liveAtHead].sort());
    } finally {
      await cluster.dispose();
    }
  }, 180_000);
});
