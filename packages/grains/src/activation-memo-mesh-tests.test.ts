import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import { atExactSnapshot, MINIMIZE_LATENCY } from "@spacedb/core/consistency-requirement";
import { MaxDepthExceededException } from "@spacedb/core/max-depth-exceeded-exception";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { CheckEngine } from "@spacedb/engine/check-engine";
import { visitKeyOf, visitKeyToCanonicalString } from "@spacedb/engine/i-dispatcher";

import { caveatFromWire } from "./caveat-wire";
import { setTestDispatchContext } from "./dispatch-context-test-helper";
import { dispatchCheckReplyDepthRequired, ICheckGrain } from "./i-check-grain";
import type { ICheckGrain as ICheckGrainType } from "./i-check-grain";
import { grainKeyBuild } from "./grain-key";
import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ActivationMemoMeshTests.cs`.
 *
 * Stage (a) of "Activation-as-cache" (`docs/future-work.md` item 1.3): `CheckGrain` memoizes its
 * computed pre-context reply in activation state, so a re-dispatch of the same canonical
 * sub-problem to a warm activation is served without re-expanding the relation graph. Every test
 * here resolves the `ICheckGrain` directly by its `GrainKey` and calls `dispatchCheck` itself -
 * bypassing the silo-wide `OrleansDispatcher` entry point entirely - so only the grain's OWN memo
 * behaviour is under test.
 *
 * PORT NOTES.
 *  - `[Collection(MeshClusterCollection.Name)]` -> nothing (see `mesh-cluster-collection.ts`);
 *    `await using var cluster` -> an explicit `try/finally`.
 *  - `using var ct1 / ct2` -> nothing: the C# never cancels these sources, and the signal parameter
 *    is optional, so passing none is the faithful translation.
 *  - `SetDispatchContext(depth, seeded)` -> `setTestDispatchContext`, whose visited set is the
 *    canonical STRING form of each `VisitKey` (the port's set element type; TypeScript has no
 *    value-equality set).
 *  - `Assert.Equal(first, second)` is C# record VALUE equality over the reply; `toEqual` is the
 *    structural counterpart. Where the C# deliberately does NOT compare replies (the caveat case,
 *    because a `Dictionary` member has no value equality there), this port does not either -
 *    keeping the memo-hit counter as the proof of reuse exactly as the C# comment says.
 *  - `DispatchCheckResult.DepthRequired` is a required member on the engine record but an OPTIONAL
 *    one on the wire reply, so the collapse call reads it through
 *    `dispatchCheckReplyDepthRequired`.
 */

const DOCUMENT_SCHEMA = `definition user {}

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

// A finite (acyclic) two-hop schema used to provoke the dispatcher's visited-set loop-bypass
// WITHOUT a genuine relation cycle: doc1 has no direct viewer but a parent doc2 that does. A true
// self/mutual cycle only ever terminates via MaxDepthExceededException (see LocalDispatcher's
// remarks: "a true cycle simply consumes depth ... until it throws" - there is no visited-set cut on
// the verdict path), so it can never surface a graceful cycleCut = true reply to assert against.
// Instead this test hand-seeds the dispatched visited set with the SECOND hop's own visit key before
// making the call, so the dispatcher DETERMINISTICALLY sees that hop as already in flight and takes
// the loop-bypass path - the grain call still happens normally (doc2 has a direct viewer tuple, no
// further recursion needed) but the RETURNED result is unconditionally tagged cycleCut = true by the
// dispatcher, regardless of whether that resolution itself needed the loop guard. This reaches a
// genuinely successful cycleCut = true reply out of a normal, finite graph.
const ARROW_SCHEMA = `definition user {}

definition document {
    relation viewer: user
    relation parent: document
    permission view = viewer + parent->view
}`;

const CAVEAT_SCHEMA = `caveat over_age(age int, min_age int) {
  age >= min_age
}

definition user {}

definition document {
  relation viewer: user with over_age
  permission view = viewer
}`;

function resource(type: string, id: string, relation: string): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

function subject(id: string): ObjectAndRelation {
  return { objectType: "user", objectId: id, relation: ELLIPSIS };
}

async function resolveGrain(
  cluster: MeshTestCluster,
  res: ObjectAndRelation,
  subj: ObjectAndRelation,
): Promise<{ grain: ICheckGrainType; revision: string }> {
  const head = await cluster.datastore.headRevision();
  const schemaHash = cluster.schemaProvider.current.schemaHash;
  const key = grainKeyBuild(res, subj, head.revision.toString(), schemaHash);
  return {
    grain: cluster.grainFactory.getGrain(ICheckGrain, key),
    revision: head.revision.toString(),
  };
}

describe("ActivationMemoMeshTests", () => {
  it("Warm_activation_serves_the_second_identical_call_from_the_memo", async () => {
    const cluster = await MeshTestCluster.create(DOCUMENT_SCHEMA);
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              resource("document", "readme", "viewer"),
              subject("alice"),
            ),
            operation: "create",
          },
        ]),
      );

      const { grain } = await resolveGrain(
        cluster,
        resource("document", "readme", "view"),
        subject("alice"),
      );

      const before = cluster.metricsSnapshot();
      setTestDispatchContext(50);
      const first = await grain.dispatchCheck();
      const afterFirst = cluster.metricsSnapshot();
      setTestDispatchContext(50);
      const second = await grain.dispatchCheck();
      const afterSecond = cluster.metricsSnapshot();

      expect(second).toEqual(first);
      expect(first.member).toBe(true);

      // First call: TWO cold activations, not one - "view = viewer" compiles the bare "viewer"
      // reference as a ComputedUsersetChild, so evaluating it is a genuine Sub-dispatch (a real
      // grain call, now that there is no in-process local-recurse shortcut) to the document's OWN
      // "viewer" grain, in addition to the root "view" grain itself.
      expect(afterFirst.memoMiss).toBe(before.memoMiss + 2);
      expect(afterFirst.memoHit).toBe(before.memoHit);

      // Second call: the ROOT's own memo answers immediately without re-expanding the relation
      // graph at all, so the "viewer" child grain is never touched again - exactly one hit (the
      // root), no misses.
      expect(afterSecond.memoHit).toBe(afterFirst.memoHit + 1);
      expect(afterSecond.memoMiss).toBe(afterFirst.memoMiss);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Memoized_branch_collapses_correctly_under_different_caveat_contexts", async () => {
    // (b) A pre-context branch served from a WARM activation's memo is not itself the verdict: the
    // request-time caveat context is applied per-request at Collapse, so two callers of the exact
    // same memoized sub-problem with different contexts correctly get different verdicts.
    const cluster = await MeshTestCluster.create(CAVEAT_SCHEMA);
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              resource("document", "doc1", "viewer"),
              subject("alice"),
              { caveatName: "over_age", context: new Map<string, unknown>([["min_age", 18]]) },
            ),
            operation: "create",
          },
        ]),
      );

      const { grain } = await resolveGrain(
        cluster,
        resource("document", "doc1", "view"),
        subject("alice"),
      );

      const before = cluster.metricsSnapshot();
      setTestDispatchContext(50);
      const first = await grain.dispatchCheck();
      const afterFirst = cluster.metricsSnapshot();
      // Second call to the SAME warm activation: served from the memo (a miss, then a hit).
      setTestDispatchContext(50);
      const second = await grain.dispatchCheck();
      const afterSecond = cluster.metricsSnapshot();

      // (Not asserting first == second: the C# declines to, because the caveat's context has no
      // value equality there. The memo-hit counter below is the real proof of reuse.)
      expect(first.member).toBe(true);
      expect(second.member).toBe(true);
      // Same shape as the plain document schema: "view = viewer" dispatches the bare "viewer"
      // reference as a genuine Sub to a second grain, so the first call is TWO misses (root +
      // viewer), not one.
      expect(afterFirst.memoMiss).toBe(before.memoMiss + 2);
      // Second call: served entirely from the root's own memo (no re-expansion, no touching the
      // viewer grain again) - exactly one hit.
      expect(afterSecond.memoHit).toBe(afterFirst.memoHit + 1);

      // Collapse the SAME memoized reply with two different request-time contexts.
      const engine = new CheckEngine(
        cluster.schemaProvider.current.namespaces,
        cluster.schemaProvider.current.caveats,
      );
      const caveat = caveatFromWire(second.caveat);

      const over = engine.collapse(
        {
          member: second.member,
          caveat,
          cycleCut: second.cycleCut,
          depthRequired: dispatchCheckReplyDepthRequired(second),
        },
        new Map<string, unknown>([["age", 21]]),
      );
      const under = engine.collapse(
        {
          member: second.member,
          caveat,
          cycleCut: second.cycleCut,
          depthRequired: dispatchCheckReplyDepthRequired(second),
        },
        new Map<string, unknown>([["age", 16]]),
      );

      expect(over.verdict).toBe("member");
      expect(under.verdict).toBe("notMember");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Depth_guard_recomputes_rather_than_serving_a_memo_primed_at_a_tighter_budget", async () => {
    // A deep, distinctly-keyed chain so depthRequired at the root is > 1 (deterministic: this
    // schema has exactly one path, direct_member at the bottom of a linear parent chain, so
    // depthRequired equals the chain depth).
    const depth = 5;
    const cluster = await MeshTestCluster.create(CHAIN_SCHEMA);
    try {
      const updates: RelationshipUpdate[] = [];
      for (let i = 0; i < depth - 1; i++) {
        updates.push({
          relationship: createRelationship(
            resource("group", `g${i}`, "parent"),
            resource("group", `g${i + 1}`, ELLIPSIS),
          ),
          operation: "create",
        });
      }
      updates.push({
        relationship: createRelationship(
          resource("group", `g${depth - 1}`, "direct_member"),
          subject("u"),
        ),
        operation: "create",
      });
      await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(updates));

      const { grain } = await resolveGrain(
        cluster,
        resource("group", "g0", "member"),
        subject("u"),
      );

      // Prime the memo with a generous budget so it genuinely completes and records the
      // sub-problem's real depthRequired (D).
      setTestDispatchContext(1_000);
      const primed = await grain.dispatchCheck();
      expect(primed.member).toBe(true);
      const required = dispatchCheckReplyDepthRequired(primed);
      expect(required, "expected the chain to require more than one hop of depth.").toBeGreaterThan(
        1,
      );

      // Served: a budget exactly equal to what the memo required is sufficient (depthRemaining >=
      // depthRequired), so the memo answers without touching the datastore/graph again.
      const beforeServed = cluster.metricsSnapshot();
      setTestDispatchContext(required);
      const served = await grain.dispatchCheck();
      const afterServed = cluster.metricsSnapshot();
      expect(served).toEqual(primed);
      expect(afterServed.memoHit).toBe(beforeServed.memoHit + 1);

      // Not served: a budget ONE SHORT of what the memo required must fall through and recompute
      // under the tighter budget - proven by the recompute legitimately exhausting depth and
      // throwing MaxDepthExceededException (the memo, had it been (wrongly) served, would have
      // returned successfully instead).
      const beforeTight = cluster.metricsSnapshot();
      setTestDispatchContext(required - 1);
      await expect(grain.dispatchCheck()).rejects.toBeInstanceOf(MaxDepthExceededException);
      const afterTight = cluster.metricsSnapshot();

      // The root's own memo must NOT serve this call (its depthRequired is one more than the
      // offered budget), so the root itself recomputes - at least one new miss.
      expect(
        afterTight.memoMiss,
        "a budget one short of what the root's memo required must fall through the memo and recompute.",
      ).toBeGreaterThan(beforeTight.memoMiss);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Cycle_cut_replies_are_never_memoized", async () => {
    const cluster = await MeshTestCluster.create(ARROW_SCHEMA);
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              resource("document", "doc1", "parent"),
              resource("document", "doc2", ELLIPSIS),
            ),
            operation: "create",
          },
          {
            relationship: createRelationship(
              resource("document", "doc2", "viewer"),
              subject("alice"),
            ),
            operation: "create",
          },
        ]),
      );

      const { grain } = await resolveGrain(
        cluster,
        resource("document", "doc1", "view"),
        subject("alice"),
      );

      // Hand-seed the visited set with the SECOND hop's own visit key (doc2/view/alice), so the
      // dispatcher's loop-bypass fires when the root's parent->view arrow reaches it, and the
      // dispatcher unconditionally tags the resulting reply cycleCut = true (see the remarks on
      // ARROW_SCHEMA).
      const seeded = [
        visitKeyToCanonicalString(
          visitKeyOf(resource("document", "doc2", "view"), subject("alice")),
        ),
      ];

      const before = cluster.metricsSnapshot();
      setTestDispatchContext(50, seeded);
      const first = await grain.dispatchCheck();
      const afterFirst = cluster.metricsSnapshot();

      expect(first.member).toBe(true);
      expect(
        first.cycleCut,
        "expected the pre-seeded visited set to provoke a cycle-cut reply.",
      ).toBe(true);
      // Every hop of this check is now a genuine grain, since there is no in-process local-recurse
      // shortcut: the root (doc1/view), the root's bare "viewer" reference (doc1/viewer, a
      // ComputedUsersetChild Sub), the arrow target (doc2/view, the loop-bypassed hop) and ITS bare
      // "viewer" reference (doc2/viewer) - four cold activations, four misses. The root's own reply
      // is a miss (it was computed) but must NOT populate ITS memo, because it inherited
      // cycleCut = true from the force-tagged doc2/view branch.
      expect(afterFirst.memoMiss).toBe(before.memoMiss + 4);

      // A second call with an EMPTY visited set (no seeding) asks the exact same sub-problem; if the
      // root's cycle-cut reply had been (wrongly) memoized, this would be served from it. It must
      // instead recompute at the root (a miss) - but doc1/viewer and doc2/view are each warm from
      // the first call (their OWN replies were computed with cycleCut = false, since the force-tag
      // is applied only to what the dispatcher hands back to the CALLER, never to a callee's own
      // memo decision), so both are served from their own memos (two hits) without re-touching
      // doc2/viewer at all.
      setTestDispatchContext(50);
      const second = await grain.dispatchCheck();
      const afterSecond = cluster.metricsSnapshot();

      expect(second.member).toBe(true);
      expect(second.cycleCut).toBe(false);
      expect(afterSecond.memoMiss).toBe(afterFirst.memoMiss + 1);
      expect(afterSecond.memoHit).toBe(afterFirst.memoHit + 2);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Optimized_and_exact_checks_at_the_same_revision_share_one_activation_memo", async () => {
    // The post-CachingDispatcher invariant this pins (see `grain-key.ts`'s remarks): once a
    // revision string is resolved, an exact-snapshot check and a minimize-latency check that happen
    // to name the SAME revision string compute the identical answer and legitimately share the
    // CheckGrain activation (and its memo) - there is no mode segment left to keep them apart.
    const cluster = await MeshTestCluster.create(DOCUMENT_SCHEMA);
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              resource("document", "readme", "viewer"),
              subject("alice"),
            ),
            operation: "create",
          },
        ]),
      );

      const checker = cluster.checker;
      const subj = subject("alice");

      cluster.resetMetrics();
      setTestDispatchContext(50);

      // First call: MinimizeLatency (Optimized resolution). No prior write happened since, so the
      // datastore's cached "optimized" revision IS the real current head - a cold pair of
      // activations (root "view" + its bare "viewer" Sub).
      const optimized = await checker.check(
        "document",
        "readme",
        "view",
        subj,
        undefined,
        MINIMIZE_LATENCY,
      );
      const afterOptimized = cluster.metricsSnapshot();
      expect(optimized.verdict).toBe("member");

      // Second call: AtExactSnapshot pinned to the token the FIRST call itself just evaluated at.
      // The decoded revision round-trips to the identical string, so this must hit the very same
      // ROOT grain activation warmed a moment ago - served entirely from its memo.
      setTestDispatchContext(50);
      const exact = await checker.check(
        "document",
        "readme",
        "view",
        subj,
        undefined,
        atExactSnapshot({ token: optimized.evaluatedToken }),
      );
      const afterExact = cluster.metricsSnapshot();

      expect(exact.verdict).toBe("member");
      expect(exact.evaluatedRevision.toString()).toBe(optimized.evaluatedRevision.toString());

      // Shared activation memo: the second call adds a hit, not a miss.
      expect(afterExact.memoHit).toBe(afterOptimized.memoHit + 1);
      expect(afterExact.memoMiss).toBe(afterOptimized.memoMiss);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Disabled_memo_never_hits_or_misses", async () => {
    const cluster = await MeshTestCluster.create(DOCUMENT_SCHEMA, { useActivationMemo: false });
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              resource("document", "readme", "viewer"),
              subject("alice"),
            ),
            operation: "create",
          },
        ]),
      );

      const { grain } = await resolveGrain(
        cluster,
        resource("document", "readme", "view"),
        subject("alice"),
      );

      cluster.resetMetrics();
      setTestDispatchContext(50);
      const first = await grain.dispatchCheck();
      setTestDispatchContext(50);
      const second = await grain.dispatchCheck();
      const snapshot = cluster.metricsSnapshot();

      expect(first.member).toBe(true);
      expect(second.member).toBe(true);
      expect(snapshot.memoHit).toBe(0);
      expect(snapshot.memoMiss).toBe(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
