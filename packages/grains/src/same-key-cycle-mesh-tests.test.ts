import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import { MaxDepthExceededException } from "@spacedb/core/max-depth-exceeded-exception";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import { CheckEngine } from "@spacedb/engine/check-engine";
import { compileSchema } from "@spacedb/schema/schema-compiler";

import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/SameKeyCycleMeshTests.cs`.
 *
 * THE regression test for the re-entrant same-key grain deadlock.
 *
 * A genuine same-key cycle (`group:a#member -> group:b#member -> group:a#member`) re-addresses the
 * SAME grain key on the way back round, because the grain key excludes the visited set and the
 * depth. On the pre-change code (a non-reentrant grain, with the visited-set cycle-cut living below
 * the grain hop) the outer grain call blocks awaiting the inner call to its own key - a deadlock
 * that only breaks on a timeout. Two independent mechanisms must both be present: the dispatcher
 * detects the genuine loop via the EXACT visited set and recurses in-process rather than
 * re-entering the busy grain, AND `CheckGrain` is reentrant so a re-entry that slips past that is
 * accepted rather than blocked. Either one alone leaves a latent deadlock.
 *
 * With correctness resting SOLELY on the depth budget, the cycle terminates by THROWING
 * {@link MaxDepthExceededException}. A confident `notMember` is the WRONG answer here: a port whose
 * cycle guard returns `notMember` passes a naive test and fails this one.
 *
 * PORT NOTES.
 *  - The TIGHT 20s timeout is LOAD-BEARING: a deadlock blows it, and the depth-bounded cycle must
 *    complete well inside it. It must never be raised to accommodate a slow port, because a raised
 *    timeout converts a deadlock into a slow pass.
 *  - `Task.WhenAny(check, Task.Delay(20s))` + `ReferenceEquals(completed, check)` becomes a
 *    `Promise.race` over a DISTINGUISHABLE SENTINEL. `Promise.race` rejects as soon as the check
 *    rejects, and the check is EXPECTED to reject, so the check is first reflected into a
 *    never-rejecting settle marker - otherwise the race itself would throw the very rejection the
 *    case wants to inspect afterwards. The losing timer is always cleared so it cannot keep the
 *    process alive.
 *  - `await using` -> an explicit `try/finally`.
 */

const CYCLE_SCHEMA = `definition user {}

definition group {
    relation member: user | group#member
}`;

/** The load-bearing deadlock budget: 20 seconds, exactly as in the C#. */
const CYCLE_TIMEOUT_MS = 20_000;

function onr(objectType: string, objectId: string, relation: string): ObjectAndRelation {
  return { objectType, objectId, relation };
}

/**
 * The `Task.WhenAny(work, Task.Delay(timeout))` shape: resolves `"completed"` if `work` settles
 * first (either way), `"timedOut"` otherwise. `work` is reflected so a rejection never escapes here
 * - the caller inspects it afterwards.
 */
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
    // The losing timer must never keep the process alive.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `group:a#member -> group:b#member -> group:a#member`: a true cycle, no real member inside. */
function cycleRelationships(): readonly RelationshipUpdate[] {
  return [
    {
      relationship: createRelationship(onr("group", "a", "member"), onr("group", "b", "member")),
      operation: "create",
    },
    {
      relationship: createRelationship(onr("group", "b", "member"), onr("group", "a", "member")),
      operation: "create",
    },
  ];
}

describe("SameKeyCycleMeshTests", () => {
  it("SameKeyCycle_terminates_with_error_and_never_deadlocks_the_mesh", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(CYCLE_SCHEMA, 3);
    try {
      await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(cycleRelationships()));

      // TIGHT timeout: a deadlock would hang here; the depth-bounded cycle must complete (by
      // throwing) well inside it.
      const check = cluster.checker.check(
        "group",
        "a",
        "member",
        onr("user", "x", ELLIPSIS),
        undefined,
      );

      const outcome = await raceAgainstTimeout(check, CYCLE_TIMEOUT_MS);
      expect(
        outcome,
        "The same-key cycle did not terminate within the timeout - the grain mesh deadlocked.",
      ).toBe("completed");

      // It must surface an ERROR (depth exhausted), never a confident notMember. The exception
      // round-trips the grain boundary as MaxDepthExceededException.
      await expect(check).rejects.toBeInstanceOf(MaxDepthExceededException);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("DeepAcyclicChain_within_budget_resolves_member_across_the_mesh", async () => {
    // A linear chain of 49 hops (under maxDepth 50) must resolve Member across the real grain
    // mesh: the exact visited-set loop guard must not falsely terminate a legitimately deep,
    // acyclic graph.
    const cluster = await MeshTestCluster.createMultiSilo(CYCLE_SCHEMA, 3);
    try {
      const updates: RelationshipUpdate[] = [];
      for (let i = 0; i < 48; i++) {
        updates.push({
          relationship: createRelationship(
            onr("group", `g${i}`, "member"),
            onr("group", `g${i + 1}`, "member"),
          ),
          operation: "create",
        });
      }
      updates.push({
        relationship: createRelationship(onr("group", "g48", "member"), onr("user", "x", ELLIPSIS)),
        operation: "create",
      });
      await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(updates));

      const result = await cluster.checker.check(
        "group",
        "g0",
        "member",
        onr("user", "x", ELLIPSIS),
        undefined,
      );

      expect(result.verdict).toBe("member");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("SameKeyCycle_mesh_verdict_matches_the_ReferenceDatastore_reference_model", async () => {
    const relationships = cycleRelationships();
    const subject = onr("user", "x", ELLIPSIS);

    // The reference model: a plain in-process CheckEngine over a ReferenceDatastore, no grains,
    // no visited-set wiring.
    const compiled = compileSchema(CYCLE_SCHEMA);
    const referenceStore = new ReferenceDatastore();
    const referenceRevision = await referenceStore.readWriteTx((tx) =>
      tx.writeRelationships(relationships),
    );
    const referenceReader = referenceStore.snapshotReader(referenceRevision);
    const referenceEngine = new CheckEngine(compiled.namespaces, compiled.caveats);

    await expect(
      referenceEngine.check(referenceReader, "group", "a", "member", subject, undefined),
    ).rejects.toBeInstanceOf(MaxDepthExceededException);

    // The mesh: the same schema/relationships/request across a real 3-silo cluster, where the
    // cycle's second hop re-addresses the SAME grain key the check started from.
    const cluster = await MeshTestCluster.createMultiSilo(CYCLE_SCHEMA, 3);
    try {
      await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(relationships));

      const meshCheck = cluster.checker.check("group", "a", "member", subject, undefined);

      const outcome = await raceAgainstTimeout(meshCheck, CYCLE_TIMEOUT_MS);
      expect(
        outcome,
        "The same-key cycle did not terminate within the timeout - the grain mesh deadlocked.",
      ).toBe("completed");

      await expect(meshCheck).rejects.toBeInstanceOf(MaxDepthExceededException);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
