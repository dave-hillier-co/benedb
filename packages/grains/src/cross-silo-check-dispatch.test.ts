import { FULLY_CONSISTENT } from "@benedb/core/consistency-requirement";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import type { GrainId } from "@thresh/core/grain-id";
import { grainReferenceIdentity } from "@thresh/core/grain-reference";
import { describe, expect, it } from "vitest";

import { grainKeyBuild } from "./grain-key";
import { ICheckGrain } from "./i-check-grain";
import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * PORT-LOCAL suite: there is no `CrossSiloCheckDispatchTests.cs`. It exists because the two hosts
 * became configurable for a MULTI-SILO deployment (`clustering-config.ts`), and the claim that
 * change rests on - dispatch fans out across a mesh that spans more than one silo - was until now
 * only graded statistically, by `DispatchMeshMetricsTests`' "more than one silo saw a hop". This
 * suite grades it POSITIONALLY instead: it names the exact `CheckGrain` activation a check
 * produces, asks each silo whether it hosts that activation, and asserts the answer is a silo the
 * caller did not enter.
 *
 * NO HOST IS BOOTED, and none may be. `MeshTestCluster` is Thresh's `TestCluster` - several silos
 * in ONE process, wired exactly as the production silo is - which is the sanctioned way to run a
 * cluster from a test.
 *
 * HOW THE ASSERTION IS MADE EXACT rather than statistical:
 *
 *  * `coLocateWithShards: true` (the production default) makes placement a DETERMINISTIC function
 *    of the grain key: `GraphLocalityPlacementDirector` indexes the sorted candidate silos by
 *    `fnv1a64(localityKey) % n`. Every silo computes the same answer, so which silo hosts a given
 *    sub-problem is fixed, not a coin toss.
 *  * The check runs under {@link FULLY_CONSISTENT}, so both calls pin the SAME head revision (no
 *    write happens between them) and therefore address the identical grain key. Under the default
 *    quantized revision the key could roll to a new bucket mid-test.
 *  * The grain id is not hand-assembled from a guessed type name: `getGrain(ICheckGrain, key)` is
 *    what `OrleansDispatcher` itself calls, and {@link grainReferenceIdentity} reads the resulting
 *    reference's target back out. So the id asserted on is the id the mesh really addressed.
 *  * `SiloHost.isActive` is Thresh's own "do I host this activation" hook - the same one Thresh's
 *    migration and placement suites use - so the assertion is about where the activation LIVES,
 *    not about a counter that could be nonzero for some unrelated reason.
 *
 * WHY IT IS LOAD-BEARING. `Single_silo_cluster_keeps_the_activation_on_the_caller` below runs the
 * identical scenario on a ONE-silo cluster and pins the exact inverse: the activation is on the
 * caller's own silo and the caller's own dispatch counter is what moves. So the two cases cannot
 * both be green under one behaviour.
 *
 * That was not left as an argument - the suite was FALSIFIED, twice, by mutating it and watching
 * it fail:
 *
 *  * `SILO_COUNT = 1` (the mesh collapsed to a single silo). The chain case fails with
 *    "Expected the chain to span more than one silo; got silo 0: 12", and the first case fails at
 *    its setup guard, because a one-silo cluster has no foreign silo to enter from.
 *  * `callerIndex = hostIndex` (dispatch never leaves the entering silo, three silos still
 *    running). The first case fails on `isActive` - "expected true to be false" for the caller's
 *    own silo - and, with that line removed to see the next one, on the counters:
 *    "The entering silo should have run no check grain; per-silo dispatches were [0, 1, 0]".
 *
 * Those numbers are also the positive result: in the passing run the check-grain body runs on
 * exactly one silo, and it is not the silo the call was made on.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE: that the mesh crosses a SOCKET. `TestCluster` builds its
 * silos on the in-process transport, and `SiloBuilder.useWebSocketTransport()` does not clear an
 * already-installed in-process network, so a `configureSilo` override that asked for WebSockets
 * here would run the WS listener while `embeddedClientLeg()` still handed back the in-process leg
 * - a configuration no host produces. The transport choice is graded where it is made, in the two
 * hosts' `program.test.ts`; what is graded HERE is the thing the transport choice exists to
 * enable, that a check's dispatch really does leave the silo it entered.
 */
const VIEW_SCHEMA = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

const CHAIN_SCHEMA = `definition user {}

definition group {
    relation direct_member: user
    relation parent: group
    permission member = direct_member + parent->member
}`;

/**
 * The cluster width every multi-silo case here builds. The assertions below compare against this
 * CONSTANT rather than against `cluster.siloCount`, so that a mesh which collapsed to one silo
 * fails them instead of satisfying them vacuously (`1 === 1`).
 */
const SILO_COUNT = 3;

function user(id: string): ObjectAndRelation {
  return { objectType: "user", objectId: id, relation: ELLIPSIS };
}

/** Seeds a chain g0 -> g1 -> ... -> g(depth-1), with user u a direct member of the last group. */
async function seedChain(datastore: IDatastore, depth: number): Promise<void> {
  const updates: RelationshipUpdate[] = [];
  for (let i = 0; i < depth - 1; i++) {
    updates.push({
      relationship: createRelationship(
        { objectType: "group", objectId: `g${i}`, relation: "parent" },
        { objectType: "group", objectId: `g${i + 1}`, relation: ELLIPSIS },
      ),
      operation: "create",
    });
  }
  updates.push({
    relationship: createRelationship(
      { objectType: "group", objectId: `g${depth - 1}`, relation: "direct_member" },
      user("u"),
    ),
    operation: "create",
  });
  await datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

/**
 * The `GrainId` the mesh addresses for one sub-problem, built the way `OrleansDispatcher` builds
 * it: the eight-segment key, then `getGrain` for the type resolution. Any silo's runtime resolves
 * the same type, so the reference is minted on the primary purely to have a runtime to ask.
 */
function checkGrainId(
  cluster: MeshTestCluster,
  resource: ObjectAndRelation,
  subject: ObjectAndRelation,
  revision: string,
  schemaHash: string,
): GrainId {
  const key = grainKeyBuild(resource, subject, revision, schemaHash);
  const reference = cluster.cluster.primary.host.getGrain(ICheckGrain, key);
  const identity = grainReferenceIdentity(reference);
  if (identity === undefined) throw new Error("getGrain did not return a grain reference");
  return identity.grainId;
}

/** The indexes of the silos that currently host `grainId` (exactly one, once it has activated). */
function hostingSilos(cluster: MeshTestCluster, grainId: GrainId): number[] {
  return cluster.cluster.silos
    .filter((silo) => silo.host.isActive(grainId))
    .map((silo) => silo.index);
}

/** Every silo's `dispatchCheck` incoming-filter count, by silo index. */
function perSiloDispatches(cluster: MeshTestCluster): number[] {
  return cluster.allSiloServices.map((services) => services.dispatchMetrics.snapshot().dispatch);
}

describe("cross-silo check dispatch", () => {
  it("Check_entered_on_one_silo_runs_its_check_grain_on_another", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(VIEW_SCHEMA, SILO_COUNT, {
      coLocateWithShards: true,
    });
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              { objectType: "document", objectId: "readme", relation: "viewer" },
              user("u"),
            ),
            operation: "create",
          },
        ]),
      );

      const resource: ObjectAndRelation = {
        objectType: "document",
        objectId: "readme",
        relation: "view",
      };

      // A probe check, only to learn where the deterministic locality hash puts this sub-problem's
      // activation. Which silo it picks is fixed by the key, but hard-coding the answer here would
      // pin the hash rather than the property under test.
      const probe = await cluster
        .servicesForSilo(0)
        .checker.check("document", "readme", "view", user("u"), undefined, FULLY_CONSISTENT);
      expect(probe.verdict).toBe("member");

      const rootId = checkGrainId(
        cluster,
        resource,
        user("u"),
        probe.evaluatedRevision.toString(),
        probe.schemaHash ?? cluster.schemaProvider.current.schemaHash,
      );
      const hosts = hostingSilos(cluster, rootId);
      expect(
        hosts.length,
        `Expected exactly one silo to host ${rootId.toString()}; hosts were [${hosts.join(", ")}].`,
      ).toBe(1);
      const hostIndex = hosts[0]!;

      // Enter the SECOND check from a silo that is provably not the one hosting the activation, so
      // the whole check is work this silo cannot do locally.
      const callerIndex = (hostIndex + 1) % SILO_COUNT;
      expect(
        callerIndex,
        "A cluster with a single silo has no foreign silo to enter the check from.",
      ).not.toBe(hostIndex);

      cluster.resetMetrics();
      const result = await cluster
        .servicesForSilo(callerIndex)
        .checker.check("document", "readme", "view", user("u"), undefined, FULLY_CONSISTENT);
      expect(result.verdict).toBe("member");
      // Same revision, hence the same grain key, hence the same activation the probe found.
      expect(result.evaluatedRevision.toString()).toBe(probe.evaluatedRevision.toString());

      // THE CROSS-SILO CLAIM, positionally: the activation the check reached is hosted by another
      // silo's process, and is NOT hosted by the silo the caller entered.
      expect(cluster.cluster.silos[hostIndex]!.host.isActive(rootId)).toBe(true);
      expect(cluster.cluster.silos[callerIndex]!.host.isActive(rootId)).toBe(false);

      // And the work landed there too: the entering silo ran no check-grain body at all, while the
      // hosting silo's incoming dispatch filter fired. On a single-silo cluster both numbers move
      // together on the one silo, which is what the control case below pins.
      const dispatches = perSiloDispatches(cluster);
      expect(
        dispatches[callerIndex],
        `The entering silo should have run no check grain; per-silo dispatches were ` +
          `[${dispatches.join(", ")}], caller was silo ${callerIndex}.`,
      ).toBe(0);
      expect(dispatches[hostIndex]!).toBeGreaterThan(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Single_silo_cluster_keeps_the_activation_on_the_caller", async () => {
    // The control that makes the case above load-bearing: the SAME scenario with the mesh
    // collapsed to one silo. Every assertion above inverts here - the activation is on the
    // caller's own silo and the caller's own dispatch counter is the one that moves - so a
    // regression that stopped the mesh spanning silos could not leave both cases green.
    const cluster = await MeshTestCluster.create(VIEW_SCHEMA, { coLocateWithShards: true });
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              { objectType: "document", objectId: "readme", relation: "viewer" },
              user("u"),
            ),
            operation: "create",
          },
        ]),
      );

      cluster.resetMetrics();
      const result = await cluster
        .servicesForSilo(0)
        .checker.check("document", "readme", "view", user("u"), undefined, FULLY_CONSISTENT);
      expect(result.verdict).toBe("member");

      const rootId = checkGrainId(
        cluster,
        { objectType: "document", objectId: "readme", relation: "view" },
        user("u"),
        result.evaluatedRevision.toString(),
        result.schemaHash ?? cluster.schemaProvider.current.schemaHash,
      );

      expect(hostingSilos(cluster, rootId)).toEqual([0]);
      expect(perSiloDispatches(cluster)[0]!).toBeGreaterThan(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Deep_chain_check_spreads_its_activations_over_every_silo", async () => {
    // The recursion, not just its root: a 12-deep chain is 12 distinct sub-problems over 12
    // distinct group objects, each placed by the same deterministic locality hash. Naming each
    // activation and asking every silo who hosts it turns "the mesh spreads" into a positional
    // fact - and shows the check's own recursion crossing silo boundaries repeatedly, which is
    // the whole reason the engine sits on a virtual-actor runtime.
    const depth = 12;
    const cluster = await MeshTestCluster.createMultiSilo(CHAIN_SCHEMA, SILO_COUNT, {
      coLocateWithShards: true,
    });
    try {
      await seedChain(cluster.datastore, depth);

      cluster.resetMetrics();
      const result = await cluster
        .servicesForSilo(0)
        .checker.check("group", "g0", "member", user("u"), undefined, FULLY_CONSISTENT);
      expect(result.verdict).toBe("member");

      const revision = result.evaluatedRevision.toString();
      const schemaHash = result.schemaHash ?? cluster.schemaProvider.current.schemaHash;
      const placements = new Map<number, number>();
      for (let i = 0; i < depth; i++) {
        const id = checkGrainId(
          cluster,
          { objectType: "group", objectId: `g${i}`, relation: "member" },
          user("u"),
          revision,
          schemaHash,
        );
        const hosts = hostingSilos(cluster, id);
        expect(hosts, `group:g${i}#member should be hosted by exactly one silo`).toHaveLength(1);
        placements.set(hosts[0]!, (placements.get(hosts[0]!) ?? 0) + 1);
      }

      // Every silo in the cluster took part, and the entering silo hosted only its share.
      const spread = `got ${[...placements.entries()].map(([silo, n]) => `silo ${silo}: ${n}`).join(", ")}.`;
      expect(
        placements.size,
        `Expected the chain to span more than one silo; ${spread}`,
      ).toBeGreaterThan(1);
      expect(placements.size, `Expected all ${SILO_COUNT} silos to take part; ${spread}`).toBe(
        SILO_COUNT,
      );
      expect(placements.get(0)!).toBeLessThan(depth);

      // The dispatch counters agree with the placement: more than one silo ran check-grain bodies.
      const dispatches = perSiloDispatches(cluster);
      expect(dispatches.filter((count) => count > 0).length).toBe(SILO_COUNT);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
