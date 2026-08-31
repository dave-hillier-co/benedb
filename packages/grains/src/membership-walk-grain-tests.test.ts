import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { DEFAULT_MAX_DEPTH } from "@benedb/engine/check-engine";
import { LookupResourcesEngine } from "@benedb/engine/lookup-resources-engine";

import { IMembershipWalkGrain } from "./i-membership-walk-grain";
import { membershipWalkKeyBuild } from "./membership-walk-key";
import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/MembershipWalkGrainTests.cs`.
 *
 * Mesh-level gates for `MembershipWalkGrain`: warm-activation reuse, correctness over a genuine
 * data cycle end-to-end, the depth-exhaustion/incomplete-reply contract (and that
 * `ReverseOps.streamLookupResources` falls back to the live traversal rather than trusting a
 * partial candidate set), and that `MembershipWalkOptions.enabled = false` still produces correct
 * results via the unaccelerated live path.
 *
 * PORT NOTES.
 *  - `SortedSet<string>(StringComparer.Ordinal)` is an ORDERED, DEDUPLICATING set with ORDINAL
 *    comparison. It becomes a `Set<string>` drained through `[...set].sort()`: JavaScript's default
 *    array sort compares UTF-16 code units, which is the ordinal comparison. `localeCompare` would
 *    be a different order and must never appear here - two runs that agree under one collation and
 *    disagree under another would make this suite's accelerated-vs-live equality vacuous.
 *  - `Assert.Equal(SortedSet, SortedSet)` therefore becomes `toEqual` over the two sorted arrays.
 *  - `Task.WhenAny(task, Task.Delay(30s))` + `Assert.Same` becomes a race against a distinguishable
 *    sentinel, with the losing timer always cleared so it cannot keep the process alive.
 *  - `CheckEngine.DefaultMaxDepth` -> `DEFAULT_MAX_DEPTH`.
 *  - `[Collection(MeshClusterCollection.Name)]` -> nothing; see `mesh-cluster-collection.ts` for the
 *    vitest isolation decision (each file gets its own module registry, and every cluster here is
 *    built and disposed inside its own case).
 *  - `await using var cluster` -> an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - `cluster.Services.GetRequiredService<ISchemaProvider>()` -> `cluster.schemaProvider`, the same
 *    primary-silo instance the C# resolves out of the silo container.
 *  - `LookupResources(..., coveredCandidateIds: null)` -> the plain `lookupResources` overload,
 *    which is exactly the C#'s null-candidate call: the TypeScript port keeps the candidate-bearing
 *    form on `lookupResourcesWithCandidates`.
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

/** The C#'s 30s guard on the cyclic-data lookup. Load-bearing: a non-terminating walk blows it. */
const CYCLE_TIMEOUT_MS = 30_000;

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

function rel(rt: string, rid: string, relation: string, subject: ObjectAndRelation): Relationship {
  return createRelationship(onr(rt, rid, relation), subject);
}

async function seed(cluster: MeshTestCluster, ...rels: readonly Relationship[]): Promise<void> {
  const updates: RelationshipUpdate[] = rels.map((relationship) => ({
    relationship,
    operation: "create",
  }));
  await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

/** The ordinal-sorted, deduplicated drain of a resource-id set - the `SortedSet` stand-in. */
function sorted(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/** The ACCELERATED path: `ReverseOps.streamLookupResources` over the grain mesh. */
async function grainResources(
  cluster: MeshTestCluster,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  resourceType: string,
  permission: string,
): Promise<string[]> {
  const ids: string[] = [];
  for await (const found of cluster.reverseOps.streamLookupResources({
    resourceType,
    permission,
    subjectType,
    subjectId,
    subjectRelation,
    context: undefined,
    limit: undefined,
    cursor: undefined,
  })) {
    ids.push(found.resourceId);
  }
  return sorted(ids);
}

/** The UNACCELERATED path: the engine run directly over a snapshot reader at the optimized revision. */
async function engineResources(
  cluster: MeshTestCluster,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  resourceType: string,
  permission: string,
): Promise<string[]> {
  const schema = cluster.schemaProvider.current;
  const rev = await cluster.datastore.optimizedRevision();
  const reader = cluster.datastore.snapshotReader(rev.revision);
  const engine = new LookupResourcesEngine(schema.namespaces, schema.caveats);

  const ids: string[] = [];
  for await (const found of engine.lookupResources(
    reader,
    subjectType,
    subjectId,
    subjectRelation,
    resourceType,
    permission,
  )) {
    ids.push(found.resourceId);
  }
  return sorted(ids);
}

/** `Task.WhenAny(work, Task.Delay(timeout))`: `work` is reflected so a rejection never escapes. */
async function raceAgainstTimeout(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<"completed" | "timedOut"> {
  const settled = work.then(
    () => "completed" as const,
    () => "completed" as const,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timedOut">((resolve) => {
    timer = setTimeout(() => resolve("timedOut"), timeoutMs);
  });
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("MembershipWalkGrainTests", () => {
  it("WarmActivation_ServesTheSecondIdenticalLookup_Identically", async () => {
    const cluster = await MeshTestCluster.create(NESTED_SCHEMA);
    try {
      await seed(
        cluster,
        rel("group", "g1", "member", onr("user", "alice")),
        rel("document", "d1", "viewer", onr("group", "g1", "member")),
      );

      const first = await grainResources(cluster, "user", "alice", ELLIPSIS, "document", "view");
      const second = await grainResources(cluster, "user", "alice", ELLIPSIS, "document", "view");

      expect(second).toEqual(first);
      expect(first).toContain("d1");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("CyclicMembershipData_LookupTerminatesAndIsCorrect", async () => {
    const cluster = await MeshTestCluster.create(NESTED_SCHEMA);
    try {
      // group a member of b, b member of a: a genuine cycle in the stored data.
      await seed(
        cluster,
        rel("group", "a", "member", onr("group", "b", "member")),
        rel("group", "b", "member", onr("group", "a", "member")),
        rel("group", "a", "member", onr("user", "alice")),
        rel("document", "d1", "viewer", onr("group", "b", "member")),
      );

      const task = grainResources(cluster, "user", "alice", ELLIPSIS, "document", "view");
      expect(await raceAgainstTimeout(task, CYCLE_TIMEOUT_MS)).toBe("completed");

      const grainResult = await task;
      const engineResult = await engineResources(
        cluster,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
      );
      expect(grainResult).toEqual(engineResult);
      expect(grainResult).toContain("d1");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("CyclicMembershipData_CutsOnTheBackEdge_NotOnDepthExhaustion", async () => {
    const cluster = await MeshTestCluster.create(NESTED_SCHEMA);
    try {
      await seed(
        cluster,
        rel("group", "a", "member", onr("group", "b", "member")),
        rel("group", "b", "member", onr("group", "a", "member")),
        rel("group", "a", "member", onr("user", "alice")),
      );

      const head = await cluster.datastore.headRevision();
      const schemaHash = cluster.schemaProvider.current.schemaHash;
      const key = membershipWalkKeyBuild(
        "user",
        "alice",
        ELLIPSIS,
        head.revision.toString(),
        schemaHash,
      );
      const grain = cluster.grainFactory.getGrain(IMembershipWalkGrain, key);

      const reply = await grain.getContainingSet({ path: [], depthRemaining: DEFAULT_MAX_DEPTH });

      // The a<->b cycle must terminate via the exact path-list back-edge cut - cycleCut, with plenty
      // of depth budget left - never by burning the whole budget down to an incomplete reply (which
      // would silently disable the fast path for all cyclic data). Both groups still appear as
      // candidates.
      expect(reply.cycleCut).toBe(true);
      expect(reply.incomplete).toBe(false);
      expect(
        reply.nodes.some((n) => n.type === "group" && n.id === "a" && n.relation === "member"),
      ).toBe(true);
      expect(
        reply.nodes.some((n) => n.type === "group" && n.id === "b" && n.relation === "member"),
      ).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("DepthExhaustion_UnitLevel_ReportsIncomplete", async () => {
    const cluster = await MeshTestCluster.create(NESTED_SCHEMA);
    try {
      await seed(
        cluster,
        rel("group", "g1", "member", onr("user", "alice")),
        rel("group", "g2", "member", onr("group", "g1", "member")),
      );

      const head = await cluster.datastore.headRevision();
      const schemaHash = cluster.schemaProvider.current.schemaHash;
      const key = membershipWalkKeyBuild(
        "user",
        "alice",
        ELLIPSIS,
        head.revision.toString(),
        schemaHash,
      );
      const grain = cluster.grainFactory.getGrain(IMembershipWalkGrain, key);

      // Budget exhausted before it can recurse past alice's own direct parent (g1): the walk still
      // returns g1 as a direct-parent node, but marks the reply incomplete because it never
      // explored beyond it.
      const reply = await grain.getContainingSet({ path: [], depthRemaining: 0 });

      expect(reply.incomplete).toBe(true);
      expect(
        reply.nodes.some((n) => n.type === "group" && n.id === "g1" && n.relation === "member"),
      ).toBe(true);
      expect(
        reply.nodes.some((n) => n.type === "group" && n.id === "g2" && n.relation === "member"),
      ).toBe(false);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("DepthExhaustion_EndToEnd_FallsBackToLiveAndStaysCorrect", async () => {
    const cluster = await MeshTestCluster.create(NESTED_SCHEMA);
    try {
      // A chain longer than DEFAULT_MAX_DEPTH (both the walk grain's root budget AND the live
      // LookupResourcesEngine's own recursion cap - a genuine, documented depth limit on both
      // paths, not an accelerator-only shortfall). "shallow" sits well inside the budget on a
      // separate branch; "deep" sits past it. The point of this test is that the accelerated path
      // must not DIVERGE from live once the walk grain reports incomplete: it must fall back rather
      // than trust a partial candidate set - proven by grain and live agreeing on BOTH the
      // reachable and the capped resource.
      const chainLength = DEFAULT_MAX_DEPTH + 10;
      const rels: Relationship[] = [
        rel("group", "g0", "member", onr("user", "alice")),
        rel("group", "s0", "member", onr("user", "alice")),
        rel("document", "shallow", "viewer", onr("group", "s0", "member")),
      ];
      for (let i = 1; i < chainLength; i += 1) {
        rels.push(rel("group", `g${i}`, "member", onr("group", `g${i - 1}`, "member")));
      }
      rels.push(rel("document", "deep", "viewer", onr("group", `g${chainLength - 1}`, "member")));
      await seed(cluster, ...rels);

      const grainResult = await grainResources(
        cluster,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
      );
      const engineResult = await engineResources(
        cluster,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
      );

      expect(grainResult).toEqual(engineResult);
      expect(grainResult).toContain("shallow");
      // Beyond the documented depth cap on both paths.
      expect(grainResult).not.toContain("deep");
    } finally {
      await cluster.dispose();
    }
  }, 300_000);

  it("Disabled_MembershipWalk_StillProducesCorrectResults", async () => {
    const cluster = await MeshTestCluster.create(NESTED_SCHEMA, { useMembershipWalk: false });
    try {
      await seed(
        cluster,
        rel("group", "g1", "member", onr("user", "alice")),
        rel("group", "g2", "member", onr("group", "g1", "member")),
        rel("document", "d1", "viewer", onr("group", "g2", "member")),
      );

      const grainResult = await grainResources(
        cluster,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
      );
      const engineResult = await engineResources(
        cluster,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
      );

      expect(grainResult).toEqual(engineResult);
      expect(grainResult).toContain("d1");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
