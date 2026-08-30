import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import { LookupResourcesEngine } from "@spacedb/engine/lookup-resources-engine";
import { GrainCallAbortedError, GrainTaskCanceledError } from "@thresh/core/errors";

import { MeshTestCluster } from "./mesh-test-cluster";
import { encodeSubjectId } from "./reverse-ops-cursor-codec";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ReverseOpsMeshTests.cs`.
 *
 * Exercises the three reverse / tree ops through the {@link MeshTestCluster}'s `ReverseOps`
 * in-process read helper (the same instance a silo's gRPC services resolve), running
 * ExpandPermissionTree, LookupSubjects and LookupResources against the silo's datastore snapshot
 * (and, for LookupResources, still dispatching onward to the SubjectFrontierGrain /
 * MembershipWalkGrain mesh).
 *
 * PORT NOTES.
 *  - ONE cluster per case, as in the C#. `await using` has no TypeScript counterpart here, so every
 *    case wraps its body in `try { ... } finally { await cluster.dispose(); }` (mesh-test-cluster's
 *    port decision 9). Each case carries an explicit long timeout: the `unit` project's default is
 *    5s and standing up a cluster costs more than that.
 *  - `TakeN` `break`s out of the `await foreach` SPECIFICALLY to prove BACKPRESSURE stops the
 *    upstream engine walk. `break` out of a `for await` calls the async iterator's `return()`,
 *    which finishes the generator and so unwinds the engine walk the same way - that propagation is
 *    part of what these cases assert, not an implementation detail to work around.
 *  - `[Collection(MeshClusterCollection.Name)]` has no counterpart: see `mesh-cluster-collection.ts`
 *    for the vitest file-level isolation this leans on.
 *  - `SortedSet<string>(StringComparer.Ordinal)` and `HashSet<string>` comparisons become sorted
 *    arrays compared with `toEqual`, sorted by the BARE `sort()` (UTF-16 code units), never
 *    `localeCompare`.
 *  - `$"d{i:D3}"` is zero-padded to three digits; the padding is what makes the id order match the
 *    ordinal order, so it is reproduced with `padStart(3, "0")`.
 *  - `CancellationToken` / `CancellationTokenSource` become `AbortSignal` / `AbortController`, and
 *    `OperationCanceledException` becomes the abort FAMILY {@link isCancellation} covers (the list
 *    `dispatch-error-mapper.ts` already carries). Both cancellation cases keep the C#'s 10s race:
 *    a token-ignoring regression must FAIL, not hang CI.
 */

const SCHEMA_TEXT = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

const NESTED_SCHEMA_TEXT = `definition user {}

definition group {
    relation member: user | group#member
}

definition document {
    relation viewer: user | group#member
    permission view = viewer
}`;

function onr(objectType: string, objectId: string, relation: string): ObjectAndRelation {
  return { objectType, objectId, relation };
}

/** The C# `SeedAsync(datastore, params (res, rel, subj)[])`. */
async function seed(
  datastore: IDatastore,
  ...tuples: readonly (readonly [res: string, rel: string, subj: string])[]
): Promise<void> {
  const updates: readonly RelationshipUpdate[] = tuples.map(([res, rel, subj]) => ({
    relationship: createRelationship(onr("document", res, rel), onr("user", subj, ELLIPSIS)),
    operation: "touch",
  }));
  await datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

/** The C# `Collect`. */
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const list: T[] = [];
  for await (const item of stream) list.push(item);
  return list;
}

/**
 * The C# `TakeN`. The `break` is the POINT: stopping the enumeration stops the upstream engine walk
 * (backpressure), and `for await` + `break` calls the iterator's `return()`, which is how that
 * propagates here.
 */
async function takeN<T>(stream: AsyncIterable<T>, n: number): Promise<T[]> {
  const list: T[] = [];
  for await (const item of stream) {
    list.push(item);
    if (list.length >= n) break; // stops the upstream engine walk (backpressure).
  }
  return list;
}

/** `Task.WaitAsync(TimeSpan)`: the same promise, but a missed bound is itself a failure. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Awaits `work` and returns whatever it rejected with; fails the case if it resolves. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail, but it completed");
}

/** The abort family standing in for C#'s single `OperationCanceledException` catch. */
function isCancellation(error: unknown): boolean {
  return (
    error instanceof GrainCallAbortedError ||
    error instanceof GrainTaskCanceledError ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

/** `HashSet<string>` / `SortedSet<string>(StringComparer.Ordinal)` as an ordinal-sorted array. */
function ordinal(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

const MEMBER_UPDATE = (group: string, subject: ObjectAndRelation): RelationshipUpdate => ({
  relationship: createRelationship(onr("group", group, "member"), subject),
  operation: "touch",
});

const VIEWER_UPDATE = (document: string, subject: ObjectAndRelation): RelationshipUpdate => ({
  relationship: createRelationship(onr("document", document, "viewer"), subject),
  operation: "touch",
});

describe("ReverseOpsMeshTests", () => {
  it("ExpandPermissionTree_Union_Returns_SetOp_With_Both_Operands", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA_TEXT);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"], ["readme", "editor", "bob"]);

      const reply = await cluster.reverseOps.expandPermissionTree({
        resourceType: "document",
        resourceId: "readme",
        permission: "view",
        mode: "shallow",
      });

      const root = reply.root;
      expect(root.isLeaf).toBe(false);
      expect(root.operation).toBe("union");
      expect(root.expandedRelation).toBe("view");

      // The union's leaves carry alice (viewer) and bob (editor).
      const subjects = new Set(
        root.children.filter((c) => c.isLeaf).flatMap((c) => c.subjects.map((s) => s.subjectId)),
      );
      expect(subjects).toContain("alice");
      expect(subjects).toContain("bob");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("LookupSubjects_Returns_All_Holders_Of_Permission", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA_TEXT);
    try {
      await seed(cluster.datastore, ["readme", "viewer", "alice"], ["readme", "editor", "bob"]);

      const items = await collect(
        cluster.reverseOps.streamLookupSubjects({
          resourceType: "document",
          resourceId: "readme",
          permission: "view",
          subjectType: "user",
          subjectRelation: ELLIPSIS,
          context: undefined,
          limit: undefined,
          cursor: undefined,
        }),
      );

      expect(ordinal(items.map((s) => s.subject.subjectId))).toEqual(["alice", "bob"]);
      for (const s of items) expect(s.subject.permissionship.isCaveated).toBe(false);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("LookupSubjects_Honors_Limit_And_Resumes_Via_Cursor", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA_TEXT);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "alice"],
        ["readme", "viewer", "bob"],
        ["readme", "viewer", "carol"],
      );

      // Take 2 from a fresh stream, then resume from the 2nd item's cursor on a FRESH grain
      // activation.
      const page1 = await takeN(
        cluster.reverseOps.streamLookupSubjects({
          resourceType: "document",
          resourceId: "readme",
          permission: "view",
          subjectType: "user",
          subjectRelation: ELLIPSIS,
          context: undefined,
          limit: 2,
          cursor: undefined,
        }),
        2,
      );
      expect(page1.length).toBe(2);
      expect(lastOf(page1).resumeCursor).not.toBe("");
      expect(lastOf(page1).resumeCursor).toBeDefined();

      const page2 = await collect(
        cluster.reverseOps.streamLookupSubjects({
          resourceType: "document",
          resourceId: "readme",
          permission: "view",
          subjectType: "user",
          subjectRelation: ELLIPSIS,
          context: undefined,
          limit: 2,
          cursor: lastOf(page1).resumeCursor,
        }),
      );
      expect(page2.length).toBe(1);

      const all = ordinal([...page1, ...page2].map((s) => s.subject.subjectId));
      expect(all).toEqual(["alice", "bob", "carol"]);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("LookupSubjects_Resume_Through_The_SubjectFrontier_Memo_Union_Equals_Unlimited_No_Duplicates", async () => {
    // The consumer cursor contract must be unchanged now that streamLookupSubjects consults the
    // SubjectFrontierGrain memo: a limited first page, resumed via ITS OWN cursor on a fresh
    // enumeration (unrelated to whichever SubjectFrontierGrain activation served either call), must
    // union with no duplicates to the unlimited result, and the resume token itself must still be
    // the SAME opaque encodeSubjectId(lastSubjectId) shape (a plain last-subject-id token,
    // unaffected by which frontier source produced the item).
    const cluster = await MeshTestCluster.create(SCHEMA_TEXT);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "alice"],
        ["readme", "viewer", "bob"],
        ["readme", "viewer", "carol"],
        ["readme", "viewer", "dave"],
        ["readme", "viewer", "erin"],
      );

      const unlimited = await collect(
        cluster.reverseOps.streamLookupSubjects({
          resourceType: "document",
          resourceId: "readme",
          permission: "view",
          subjectType: "user",
          subjectRelation: ELLIPSIS,
          context: undefined,
          limit: undefined,
          cursor: undefined,
        }),
      );
      const unlimitedIds = unlimited.map((s) => s.subject.subjectId);

      const page1 = await takeN(
        cluster.reverseOps.streamLookupSubjects({
          resourceType: "document",
          resourceId: "readme",
          permission: "view",
          subjectType: "user",
          subjectRelation: ELLIPSIS,
          context: undefined,
          limit: 2,
          cursor: undefined,
        }),
        2,
      );
      expect(page1.length).toBe(2);
      const resumeToken = lastOf(page1).resumeCursor;
      expect(resumeToken).not.toBe("");
      expect(resumeToken).toBeDefined();
      // The cursor is still exactly the cursor codec's plain last-subject-id token - unchanged
      // format/constant.
      expect(resumeToken).toBe(encodeSubjectId(lastOf(page1).subject.subjectId));

      const page2 = await collect(
        cluster.reverseOps.streamLookupSubjects({
          resourceType: "document",
          resourceId: "readme",
          permission: "view",
          subjectType: "user",
          subjectRelation: ELLIPSIS,
          context: undefined,
          limit: undefined,
          cursor: resumeToken,
        }),
      );

      const resumedIds = [...page1, ...page2].map((s) => s.subject.subjectId);

      // No duplicates and exact union with the unlimited result (order-independent: both walks
      // share the same underlying engine order, but comparing as sets is the contract that matters
      // here).
      expect(resumedIds.length).toBe(new Set(resumedIds).size);
      expect(ordinal(resumedIds)).toEqual(ordinal(unlimitedIds));
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("LookupResources_Returns_All_Reachable_Resources", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA_TEXT);
    try {
      await seed(
        cluster.datastore,
        ["readme", "viewer", "alice"],
        ["design", "editor", "alice"],
        ["secret", "viewer", "bob"],
      );

      const items = await collect(
        cluster.reverseOps.streamLookupResources({
          resourceType: "document",
          permission: "view",
          subjectType: "user",
          subjectId: "alice",
          subjectRelation: ELLIPSIS,
          context: undefined,
          limit: undefined,
          cursor: undefined,
        }),
      );

      expect(ordinal(items.map((r) => r.resourceId))).toEqual(ordinal(["readme", "design"]));
      for (const r of items) expect(r.permissionship.isCaveated).toBe(false);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("LookupResources_Honors_Limit_And_Resumes_Via_Cursor", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA_TEXT);
    try {
      await seed(
        cluster.datastore,
        ["d1", "viewer", "alice"],
        ["d2", "viewer", "alice"],
        ["d3", "viewer", "alice"],
      );

      // Take 2 from a fresh stream (a limited walk emits a per-item cursor), then resume on a FRESH
      // grain.
      const page1 = await takeN(
        cluster.reverseOps.streamLookupResources({
          resourceType: "document",
          permission: "view",
          subjectType: "user",
          subjectId: "alice",
          subjectRelation: ELLIPSIS,
          context: undefined,
          limit: 2,
          cursor: undefined,
        }),
        2,
      );
      expect(page1.length).toBe(2);
      expect(isNullOrEmpty(lastOf(page1).afterResultCursor)).toBe(false);

      const page2 = await collect(
        cluster.reverseOps.streamLookupResources({
          resourceType: "document",
          permission: "view",
          subjectType: "user",
          subjectId: "alice",
          subjectRelation: ELLIPSIS,
          context: undefined,
          limit: 2,
          cursor: lastOf(page1).afterResultCursor,
        }),
      );

      const all = ordinal([...page1, ...page2].map((r) => r.resourceId));
      expect(all).toEqual(["d1", "d2", "d3"]);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("LookupResources_PagesMultiLevelCursor_Through_Grain_Codec", async () => {
    // alice -> g1#member -> g2#member -> {g3a,g3b}#member -> document#viewer. Paging one result at
    // a time forces the opaque page cursor (a multi-section, keyset-bearing token) to round-trip
    // through the grain's codec on every page. The concatenation must equal the unpaged set with no
    // drops/dupes.
    const cluster = await MeshTestCluster.create(NESTED_SCHEMA_TEXT);
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          MEMBER_UPDATE("g1", onr("user", "alice", ELLIPSIS)),
          MEMBER_UPDATE("g2", onr("group", "g1", "member")),
          MEMBER_UPDATE("g3a", onr("group", "g2", "member")),
          MEMBER_UPDATE("g3b", onr("group", "g2", "member")),
          VIEWER_UPDATE("doc_a", onr("group", "g3a", "member")),
          VIEWER_UPDATE("doc_z", onr("group", "g3a", "member")),
          VIEWER_UPDATE("doc_b", onr("group", "g3b", "member")),
          VIEWER_UPDATE("doc_m", onr("group", "g3b", "member")),
        ]),
      );

      const unpaged = await collect(
        cluster.reverseOps.streamLookupResources({
          resourceType: "document",
          permission: "view",
          subjectType: "user",
          subjectId: "alice",
          subjectRelation: ELLIPSIS,
          context: undefined,
          limit: undefined,
          cursor: undefined,
        }),
      );
      const expected = unpaged.map((r) => r.resourceId).sort();
      expect(expected).toEqual(["doc_a", "doc_b", "doc_m", "doc_z"]);

      // Resume ONE result at a time, each on a FRESH grain activation, through the opaque
      // multi-section cursor codec. The concatenation must equal the unpaged set with no
      // drops/dupes.
      const paged: string[] = [];
      let cursor: string | undefined;
      while (paged.length <= unpaged.length) {
        const page = await takeN(
          cluster.reverseOps.streamLookupResources({
            resourceType: "document",
            permission: "view",
            subjectType: "user",
            subjectId: "alice",
            subjectRelation: ELLIPSIS,
            context: undefined,
            limit: 1,
            cursor,
          }),
          1,
        );
        const first = page[0];
        if (first === undefined) break;
        paged.push(first.resourceId);
        cursor = first.afterResultCursor;
        if (isNullOrEmpty(cursor)) break;
      }

      expect([...paged].sort()).toEqual(expected);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("StreamLookupResources_PreCancelledToken_Throws_Without_Hanging", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA_TEXT);
    try {
      await seed(
        cluster.datastore,
        ["d1", "viewer", "alice"],
        ["d2", "viewer", "alice"],
        ["d3", "viewer", "alice"],
      );

      const cancellation = new AbortController();
      cancellation.abort();

      const drain = async (signal: AbortSignal): Promise<void> => {
        for await (const _ of cluster.reverseOps.streamLookupResources(
          {
            resourceType: "document",
            permission: "view",
            subjectType: "user",
            subjectId: "alice",
            subjectRelation: ELLIPSIS,
            context: undefined,
            limit: undefined,
            cursor: undefined,
          },
          signal,
        )) {
          void _;
        }
      };

      // A pre-cancelled signal must surface as a cancellation promptly (bounded so a regression that
      // ignored the signal would fail the test rather than hang CI).
      const error = await rejection(withTimeout(drain(cancellation.signal), 10_000));
      expect(isCancellation(error), `expected a cancellation, got ${String(error)}`).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("StreamLookupResources_CancelMidStream_StopsWithoutHanging", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA_TEXT);
    try {
      const tuples = Array.from(
        { length: 50 },
        (_unused, i) => [`d${String(i).padStart(3, "0")}`, "viewer", "alice"] as const,
      );
      await seed(cluster.datastore, ...tuples);

      const cancellation = new AbortController();
      let seen = 0;

      const run = async (): Promise<void> => {
        try {
          for await (const _ of cluster.reverseOps.streamLookupResources(
            {
              resourceType: "document",
              permission: "view",
              subjectType: "user",
              subjectId: "alice",
              subjectRelation: ELLIPSIS,
              context: undefined,
              limit: undefined,
              cursor: undefined,
            },
            cancellation.signal,
          )) {
            void _;
            seen++;
            if (seen === 1) cancellation.abort();
          }
        } catch (error) {
          // Expected when the cancellation is observed before the stream naturally drains.
          if (!isCancellation(error)) throw error;
        }
      };

      // Cancelling after the first item must stop the enumeration without hanging (bounded outer
      // wait).
      await withTimeout(run(), 10_000);
      expect(seen).toBeGreaterThanOrEqual(1);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("StreamLookupResources_CrossesSiloBoundary_MatchesEngine", async () => {
    // A genuine multi-silo cluster: the in-process read runs on the primary silo but the Leopard
    // membership-walk accelerator it dispatches to (IMembershipWalkGrain) may activate on any silo,
    // so the enumeration still crosses a real grain boundary. The full streamed set must equal the
    // engine's own (index-off) LookupResources over the same pinned snapshot.
    const cluster = await MeshTestCluster.createMultiSilo(NESTED_SCHEMA_TEXT, 3);
    try {
      expect(cluster.siloCount).toBeGreaterThanOrEqual(2);
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          MEMBER_UPDATE("g1", onr("user", "alice", ELLIPSIS)),
          MEMBER_UPDATE("g2", onr("group", "g1", "member")),
          VIEWER_UPDATE("doc_a", onr("group", "g2", "member")),
          VIEWER_UPDATE("doc_b", onr("group", "g1", "member")),
        ]),
      );

      const streamed = new Set<string>();
      for await (const r of cluster.reverseOps.streamLookupResources({
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "alice",
        subjectRelation: ELLIPSIS,
        context: undefined,
        limit: undefined,
        cursor: undefined,
      })) {
        streamed.add(r.resourceId);
      }

      // Engine baseline over the same snapshot the mesh pinned.
      const schema = cluster.services.schemaProvider.current;
      const rev = await cluster.datastore.optimizedRevision();
      const reader = cluster.datastore.snapshotReader(rev.revision);
      const engine = new LookupResourcesEngine(schema.namespaces, schema.caveats);
      const baseline = new Set<string>();
      // `coveredCandidateIds: null` is the plain (candidate-free) overload here.
      for await (const f of engine.lookupResources(
        reader,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
      )) {
        baseline.add(f.resourceId);
      }

      expect(streamed.size).toBeGreaterThan(0);
      expect(ordinal(streamed)).toEqual(ordinal(baseline));
      expect(streamed).toContain("doc_a");
      expect(streamed).toContain("doc_b");
    } finally {
      await cluster.dispose();
    }
  }, 180_000);
});

/** `list[^1]`, narrowed - the C# indexer throws on an empty list, and so does this. */
function lastOf<T>(list: readonly T[]): T {
  const item = list[list.length - 1];
  if (item === undefined) throw new Error("expected a non-empty page");
  return item;
}

/** `string.IsNullOrEmpty`. */
function isNullOrEmpty(value: string | undefined): boolean {
  return value === undefined || value.length === 0;
}
