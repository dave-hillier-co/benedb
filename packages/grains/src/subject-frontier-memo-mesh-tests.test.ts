import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship } from "@spacedb/core/relationship";

import { ISubjectFrontierGrain } from "./i-subject-frontier-grain";
import { MeshTestCluster } from "./mesh-test-cluster";
import type { Permissionship } from "./reverse-ops-dtos";
import { subjectFrontierKeyBuild } from "./subject-frontier-key";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/SubjectFrontierMemoMeshTests.cs`.
 *
 * `SubjectFrontierGrain`'s per-activation LookupSubjects frontier memo - the LookupSubjects
 * analogue of stage (a) of "Activation-as-cache". Every test resolves the `ISubjectFrontierGrain`
 * DIRECTLY by its `SubjectFrontierKey` (or drives `ReverseOps.streamLookupSubjects`, for the
 * caveat-context test), so only this feature's own memo/consumer behaviour is under test.
 *
 * PORT NOTES.
 *  - `head.Revision.ToString()` is the revision's CANONICAL STRING FORM, and it must be exactly
 *    what `parseRevision` accepts on the grain side. `TimestampRevision.toString()` is
 *    `timestampNanosSinceEpoch.toString()` - a plain integer, no `n` suffix - and that is what is
 *    used here. A differently-stringified bigint would silently address a DIFFERENT grain, and
 *    every memo assertion in this file would degrade to "always a miss" while the correctness half
 *    still passed.
 *  - `[Collection(MeshClusterCollection.Name)]` -> nothing (see `mesh-cluster-collection.ts`);
 *    `await using var cluster` -> an explicit `try/finally`.
 *  - `using var ct1 / ct2` -> nothing: the cancellation-token parameter is optional here and the
 *    C# never cancels these two sources, so passing no signal is the faithful translation.
 *  - `IReadOnlyDictionary<string, object?>` caveat context -> a `ReadonlyMap<string, unknown>`.
 */

const DOCUMENT_SCHEMA = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

// Verbatim from the C#: the caveat is what makes the differing-context collapse observable.
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
  subjectType: string,
  subjectRelation: string = ELLIPSIS,
): Promise<ISubjectFrontierGrain> {
  const head = await cluster.datastore.headRevision();
  const schemaHash = cluster.schemaProvider.current.schemaHash;
  const key = subjectFrontierKeyBuild(
    res,
    subjectType,
    subjectRelation,
    head.revision.toString(),
    schemaHash,
  );
  return cluster.grainFactory.getGrain(ISubjectFrontierGrain, key);
}

/** The ordinal `OrderBy(s => s, StringComparer.Ordinal)`: JavaScript's default code-unit sort. */
function ordinal(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

describe("SubjectFrontierMemoMeshTests", () => {
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

      const grain = await resolveGrain(cluster, resource("document", "readme", "view"), "user");

      const before = cluster.metricsSnapshot();
      const first = await grain.getFrontier();
      const afterFirst = cluster.metricsSnapshot();
      const second = await grain.getFrontier();
      const afterSecond = cluster.metricsSnapshot();

      // Not asserting reply equality directly: each grain call returns an independently marshalled
      // list, so two equal-content replies are distinct objects even when served from the same
      // memo. Compare by subject id instead.
      expect(ordinal(second.subjects.map((s) => s.subjectId))).toEqual(
        ordinal(first.subjects.map((s) => s.subjectId)),
      );
      expect(first.subjects.some((s) => s.subjectId === "alice")).toBe(true);

      expect(afterFirst.frontierMemoMiss).toBe(before.frontierMemoMiss + 1);
      expect(afterFirst.frontierMemoHit).toBe(before.frontierMemoHit);

      expect(afterSecond.frontierMemoHit).toBe(afterFirst.frontierMemoHit + 1);
      expect(afterSecond.frontierMemoMiss).toBe(afterFirst.frontierMemoMiss);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Memoized_frontier_collapses_differently_under_different_request_contexts_via_the_stream", async () => {
    // (b) The memoized frontier is the pre-context shape: caveat context is applied per-request at
    // ReverseOps, so two streamLookupSubjects calls sharing the SAME warm memoized frontier
    // correctly collapse to different verdicts for the caveated subject.
    const cluster = await MeshTestCluster.create(CAVEAT_SCHEMA);
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              resource("document", "doc1", "viewer"),
              subject("alice"),
              {
                caveatName: "over_age",
                context: new Map<string, unknown>([["min_age", 18]]),
              },
            ),
            operation: "create",
          },
        ]),
      );

      const streamOnce = async (
        context: ReadonlyMap<string, unknown> | undefined,
      ): Promise<Permissionship | undefined> => {
        for await (const item of cluster.reverseOps.streamLookupSubjects({
          resourceType: "document",
          resourceId: "doc1",
          permission: "view",
          subjectType: "user",
          subjectRelation: ELLIPSIS,
          context,
          limit: undefined,
          cursor: undefined,
        })) {
          if (item.subject.subjectId === "alice") return item.subject.permissionship;
        }
        return undefined;
      };

      const before = cluster.metricsSnapshot();
      const over = await streamOnce(new Map<string, unknown>([["age", 21]]));
      const afterFirst = cluster.metricsSnapshot();
      const under = await streamOnce(new Map<string, unknown>([["age", 16]]));
      const afterSecond = cluster.metricsSnapshot();

      expect(over).toBeDefined();
      // age 21 satisfies min_age 18 -> definite member.
      expect(over?.isCaveated).toBe(false);

      // age 16 fails min_age 18 -> definitely excluded, sheared off entirely.
      expect(under).toBeUndefined();

      // Same memoized activation served both requests: one miss (cold), then a hit.
      expect(afterFirst.frontierMemoMiss).toBe(before.frontierMemoMiss + 1);
      expect(afterSecond.frontierMemoHit).toBe(afterFirst.frontierMemoHit + 1);
      expect(afterSecond.frontierMemoMiss).toBe(afterFirst.frontierMemoMiss);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Over_cap_frontier_is_served_but_not_retained", async () => {
    // (c) A tiny maxMemoSubjects with a frontier that exceeds it: nothing is retained, so BOTH
    // calls register as misses even though they hit the SAME warm activation.
    const cluster = await MeshTestCluster.create(DOCUMENT_SCHEMA, {
      subjectFrontierMaxMemoSubjects: 1,
    });
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
          {
            relationship: createRelationship(
              resource("document", "readme", "viewer"),
              subject("bob"),
            ),
            operation: "create",
          },
        ]),
      );

      const grain = await resolveGrain(cluster, resource("document", "readme", "view"), "user");

      const before = cluster.metricsSnapshot();
      const first = await grain.getFrontier();
      const afterFirst = cluster.metricsSnapshot();
      const second = await grain.getFrontier();
      const afterSecond = cluster.metricsSnapshot();

      expect(first.subjects.length).toBe(2);
      expect(second.subjects.length).toBe(2);

      expect(afterFirst.frontierMemoMiss).toBe(before.frontierMemoMiss + 1);
      expect(afterSecond.frontierMemoMiss).toBe(afterFirst.frontierMemoMiss + 1);
      expect(afterSecond.frontierMemoHit).toBe(before.frontierMemoHit);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Disabled_memo_never_hits_or_misses", async () => {
    // (d) useSubjectFrontierMemo: false -> zero frontier hits AND misses across a run that would
    // otherwise (via streamLookupSubjects's memo-consulting branch) produce some. NOT "all misses":
    // both counters stay at zero.
    const cluster = await MeshTestCluster.create(DOCUMENT_SCHEMA, {
      useSubjectFrontierMemo: false,
    });
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

      cluster.resetMetrics();

      const args = {
        resourceType: "document",
        resourceId: "readme",
        permission: "view",
        subjectType: "user",
        subjectRelation: ELLIPSIS,
        context: undefined,
        limit: undefined,
        cursor: undefined,
      };

      const found: string[] = [];
      for await (const item of cluster.reverseOps.streamLookupSubjects(args)) {
        found.push(item.subject.subjectId);
      }
      for await (const item of cluster.reverseOps.streamLookupSubjects(args)) {
        found.push(item.subject.subjectId);
      }

      const snapshot = cluster.metricsSnapshot();

      expect(found).toContain("alice");
      expect(snapshot.frontierMemoHit).toBe(0);
      expect(snapshot.frontierMemoMiss).toBe(0);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
