import type { ContextualizedCaveat } from "@spacedb/core/contextualized-caveat";
import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { CheckEngine } from "./check-engine";
import type { FoundResource } from "./found-resource";
import type { LookupResourcesCursor } from "./lookup-resources-cursor";
import { LookupResourcesEngine } from "./lookup-resources-engine";
import { buildReachabilityGraph } from "./reachability-graph";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/LookupResourcesEngineTests.cs`, case for case.
//
// The reverse-traversal path: entrypoint-pruned reverse queries over the First-mode reachability
// graph, candidates confirmed by the trusted CheckEngine, caveats sheared early against the request
// context, and a cursor that makes a paged enumeration equal the unpaged one.
//
// Port decisions for the surface under test:
//   * The two `LookupResources` OVERLOADS differ by a `coveredCandidateIds` parameter inserted
//     POSITIONALLY IN THE MIDDLE (after `permission`, before `caveatContext`). They become two
//     DISTINCTLY NAMED methods per the guide's overload row: {@link LookupResourcesEngine.
//     lookupResources} (the live traversal) and `lookupResourcesWithCandidates` (the Leopard
//     accelerator's confirm-only path). Folding them back into one optional middle parameter is
//     how the fast path silently receives the caveat context as its candidate list.
//   * STREAMING: `IAsyncEnumerable` here is genuinely SINGLE-PASS (a cursored traversal), so
//     `async function*` is correct - this is NOT the guide's "yield return -> return an array"
//     case. The nested `LookupRec` and `StreamCandidateChunks` are generators too; `for await ...
//     yield` chains through three levels.
//   * `[EnumeratorCancellation] CancellationToken` -> a trailing `signal?: AbortSignal`, checked in
//     the generator's loops and forwarded to the reader.
//   * ORDINAL COMPARISON throughout: `string.CompareOrdinal(id, skip1) <= 0` -> `id <= skip1` on
//     strings, and `OrderBy(x => x, StringComparer.Ordinal)` (four occurrences) -> `[...xs].sort()`.
//     THIS ORDERING IS THE CURSOR: a different collation makes a resumed page skip or repeat.
//   * NO GLOBAL DEDUP, deliberately: a resource reachable via several entrypoints is emitted once
//     per entrypoint, which is exactly what makes a paged enumeration equal the unpaged one - a
//     bounded cursor cannot carry a cross-page "already seen" set. Do not add a seen-set.
//   * The cycle-guard `visitKey` is length-prefixed rather than joined on "|". SpiceDB object ids
//     legally contain "|", so the C#'s `string.Join(",", subjectIds)` inside a "|"-delimited key is
//     not injective - a latent collision the C# carries. Length-prefixing is the sanctioned
//     divergence the port guide prescribes; it is stated at the site in the implementation.
//   * The private `IsExpired` is DEAD CODE in the C# (the datastore filters expiration on the
//     reverse path) and is dropped rather than ported as an unused function.
//   * The three C# constructors collapse to one `(namespaces, caveats?, reachability?, maxDepth?)`.
//     The `(namespaces, maxDepth)` C# overload cannot be told apart positionally from
//     `(namespaces, caveats)` in TypeScript, so it is the one form that does not survive; the
//     production entry point (a pre-built First-mode graph) and the test-ergonomic ones both do.
//   * `evaluationTime` is epoch NANOSECONDS as a `bigint`, as everywhere else in this package.

const SCHEMA = `
definition user {}

definition group {
    relation member: user | group#member
}

definition document {
    relation viewer: user | group#member
    relation editor: user
    relation banned: user
    relation parent: document

    permission view = viewer + editor
    permission edit_only = editor & viewer
    permission allowed_view = viewer - banned
    permission inherited_view = viewer + parent->view
}
`;

const WILDCARD_SCHEMA = `
definition user {}

definition document {
    relation viewer: user | user:*
    permission view = viewer
}
`;

const CAVEAT_SCHEMA = `
caveat over_age(age int, min_age int) {
  age >= min_age
}

definition user {}

definition document {
  relation viewer: user with over_age
  permission view = viewer
}
`;

function buildEngine(schemaText: string): LookupResourcesEngine {
  const compiled = compileSchema(schemaText);
  return new LookupResourcesEngine(compiled.namespaces, compiled.caveats);
}

function buildCheckEngine(schemaText: string): CheckEngine {
  const compiled = compileSchema(schemaText);
  return new CheckEngine(compiled.namespaces, compiled.caveats);
}

async function seed(
  ...rels: readonly Relationship[]
): Promise<{ store: ReferenceDatastore; rev: IRevision }> {
  const store = new ReferenceDatastore();
  const rev = await store.readWriteTx(async (tx) => {
    const updates: RelationshipUpdate[] = rels.map((r) => ({
      relationship: r,
      operation: "create",
    }));
    await tx.writeRelationships(updates);
  });
  return { store, rev };
}

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

function tuple(
  resType: string,
  resId: string,
  resRel: string,
  subject: ObjectAndRelation,
): Relationship {
  return createRelationship(onr(resType, resId, resRel), subject);
}

function caveated(
  resType: string,
  resId: string,
  resRel: string,
  subject: ObjectAndRelation,
  caveatName: string,
  ctx?: ReadonlyMap<string, unknown> | undefined,
): Relationship {
  const caveat: ContextualizedCaveat = { caveatName, context: ctx };
  return createRelationship(onr(resType, resId, resRel), subject, caveat);
}

function context(entries: readonly [string, unknown][]): ReadonlyMap<string, unknown> {
  return new Map(entries);
}

async function collect(e: AsyncIterable<FoundResource>): Promise<FoundResource[]> {
  const list: FoundResource[] = [];
  for await (const f of e) {
    list.push(f);
  }
  return list;
}

function ids(found: readonly FoundResource[]): string[] {
  return found.map((f) => f.resourceId);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

function single<T>(values: readonly T[]): T {
  expect(values).toHaveLength(1);
  const [first] = values;
  if (first === undefined) {
    throw new Error("expected exactly one element");
  }
  return first;
}

describe("LookupResourcesEngine", () => {
  it("finds the resources where the subject is a viewer", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc2", "viewer", onr("user", "alice")),
      tuple("document", "doc3", "viewer", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view"),
    );

    expect(sorted(ids(found))).toEqual(["doc1", "doc2"]);
    for (const f of found) {
      expect(f.membership).toBe("member");
      expect(f.forSubjectIds).toContain("alice");
    }
  });

  it("self-matches the subject when it is itself a resource of the target (Portion 1)", async () => {
    // resourceType == subjectType and permission == subjectRelation.
    const { store, rev } = await seed();
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "user", ELLIPSIS),
    );

    const only = single(found);
    expect(only.resourceId).toBe("alice");
    expect(only.membership).toBe("member");
  });

  it("finds resources through a parent arrow", async () => {
    const { store, rev } = await seed(
      tuple("document", "folder", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "parent", onr("document", "folder")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // inherited_view = viewer + parent->view ; alice views folder, doc1.parent = folder.
    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "inherited_view"),
    );

    const all = sorted(ids(found));
    expect(all).toContain("folder"); // direct viewer
    expect(all).toContain("doc1"); // via parent->view
  });

  it("finds resources through nested group membership", async () => {
    const { store, rev } = await seed(
      tuple("group", "eng", "member", onr("user", "alice")),
      tuple("group", "all", "member", onr("group", "eng", "member")),
      tuple("document", "doc1", "viewer", onr("group", "all", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // alice -> eng#member -> all#member -> doc1 viewer -> view.
    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view"),
    );

    expect(ids(found)).toEqual(["doc1"]);
    expect(single(found).membership).toBe("member");
  });

  it("finds resources reachable only through a public wildcard subject", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", PUBLIC_WILDCARD)),
      tuple("document", "doc2", "viewer", onr("user", "bob")),
    );
    const engine = buildEngine(WILDCARD_SCHEMA);
    const reader = store.snapshotReader(rev);

    // alice is not directly a viewer of doc1, but user:* makes everyone a viewer.
    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view"),
    );

    expect(ids(found)).toEqual(["doc1"]);
  });

  it("removes banned resources from an exclusion permission", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc2", "viewer", onr("user", "alice")),
      tuple("document", "doc2", "banned", onr("user", "alice")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // allowed_view = viewer - banned ; alice is banned on doc2.
    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "allowed_view"),
    );

    expect(ids(found)).toEqual(["doc1"]);
  });

  it("keeps only the resources where the subject satisfies both intersection operands", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "editor", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc2", "editor", onr("user", "alice")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // edit_only = editor & viewer ; alice is both only on doc1.
    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "edit_only"),
    );

    expect(ids(found)).toEqual(["doc1"]);
  });

  it("carries membership and missing params on a caveated result, agreeing with Check", async () => {
    const { store, rev } = await seed(
      caveated(
        "document",
        "doc1",
        "viewer",
        onr("user", "alice"),
        "over_age",
        context([["min_age", 18]]),
      ),
    );
    const engine = buildEngine(CAVEAT_SCHEMA);
    const check = buildCheckEngine(CAVEAT_SCHEMA);
    const reader = store.snapshotReader(rev);

    // No context for `age`: the result is Caveated with `age` missing.
    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view"),
    );
    const only = single(found);
    expect(only.resourceId).toBe("doc1");
    expect(only.membership).toBe("caveated");
    expect(only.missingContextParams).toContain("age");

    // With satisfying context -> the resource is found as a member (matching Check).
    const memberCtx = context([["age", 21]]);
    const memberFound = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view", memberCtx),
    );
    expect(single(memberFound).membership).toBe("member");
    expect(
      (await check.check(reader, "document", "doc1", "view", onr("user", "alice"), memberCtx))
        .verdict,
    ).toBe("member");

    // With failing context -> the resource is not found (matching Check).
    const failCtx = context([["age", 16]]);
    const failFound = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view", failCtx),
    );
    expect(failFound).toEqual([]);
    expect(
      (await check.check(reader, "document", "doc1", "view", onr("user", "alice"), failCtx))
        .verdict,
    ).toBe("notMember");
  });

  it("returns nothing when no path reaches the subject", async () => {
    const { store, rev } = await seed(tuple("document", "doc1", "viewer", onr("user", "bob")));
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view"),
    );

    expect(found).toEqual([]);
  });

  it("stops enumerating at the limit", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc2", "viewer", onr("user", "alice")),
      tuple("document", "doc3", "viewer", onr("user", "alice")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupResources(
        reader,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
        undefined,
        undefined,
        undefined,
        2,
      ),
    );

    expect(found).toHaveLength(2);
  });

  it("resumes after a cursor token without repeating or dropping results", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc2", "viewer", onr("user", "alice")),
      tuple("document", "doc3", "viewer", onr("user", "alice")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const first = await collect(
      engine.lookupResources(
        reader,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
        undefined,
        undefined,
        undefined,
        1,
      ),
    );
    const firstResource = single(first);
    expect(firstResource.afterCursor).toBeDefined();

    const rest = await collect(
      engine.lookupResources(
        reader,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
        undefined,
        undefined,
        firstResource.afterCursor,
      ),
    );

    // The first result is not repeated; together they cover the full set.
    expect(ids(rest)).not.toContain(firstResource.resourceId);
    expect(sorted([...ids(first), ...ids(rest)])).toEqual(["doc1", "doc2", "doc3"]);
  });

  it("reproduces the unpaged set when paged one result at a time through a multi-level cursor", async () => {
    // A deep chain alice -> g1#member -> g2#member -> {g3a,g3b}#member -> document#viewer -> view.
    // Two sibling groups at the deepest level mean the viewer reverse-query yields docs in
    // BySubject order (by group, then doc id): doc_a, doc_z (g3a) then doc_b, doc_m (g3b) - which
    // is NOT sorted by doc id. Resuming by a resource-id comparison would drop doc_b/doc_m (they
    // sort before doc_z, already yielded); resuming by the datastore keyset, carried per nesting
    // level, does not.
    const { store, rev } = await seed(
      tuple("group", "g1", "member", onr("user", "alice")),
      tuple("group", "g2", "member", onr("group", "g1", "member")),
      tuple("group", "g3a", "member", onr("group", "g2", "member")),
      tuple("group", "g3b", "member", onr("group", "g2", "member")),
      tuple("document", "doc_a", "viewer", onr("group", "g3a", "member")),
      tuple("document", "doc_z", "viewer", onr("group", "g3a", "member")),
      tuple("document", "doc_b", "viewer", onr("group", "g3b", "member")),
      tuple("document", "doc_m", "viewer", onr("group", "g3b", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const unpaged = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view"),
    );
    const expected = sorted(ids(unpaged));
    expect(expected).toEqual(["doc_a", "doc_b", "doc_m", "doc_z"]);

    // The walk is deep enough that at least one result carries a multi-section cursor.
    expect(unpaged.some((r) => (r.afterCursor?.sections.length ?? 0) > 1)).toBe(true);

    const paged: string[] = [];
    let cursor: LookupResourcesCursor | undefined;
    // Bounded so a resume regression cannot loop forever.
    while (paged.length <= unpaged.length) {
      const page = await collect(
        engine.lookupResources(
          reader,
          "user",
          "alice",
          ELLIPSIS,
          "document",
          "view",
          undefined,
          undefined,
          cursor,
          1,
        ),
      );
      const head = page[0];
      if (head === undefined) break;
      paged.push(head.resourceId);
      cursor = head.afterCursor;
    }

    // No drops and no cross-page duplicates: the paged multiset equals the unpaged one.
    expect(sorted(paged)).toEqual(expected);
  });

  it("decorates a Portion-1 self-match with a resume cursor", async () => {
    // A recursive relation (group.member admits group#member) makes a matched group both a
    // resource AND a subject of further resources. When the subject IS a group#member, Portion #1
    // self-matches the group(s) directly; each such result must carry a resume cursor so a limited
    // page resumes rather than silently truncating.
    const { store, rev } = await seed(
      tuple("group", "ga", "member", onr("group", "subgrp", "member")),
      tuple("group", "gb", "member", onr("group", "subgrp", "member")),
      tuple("group", "gc", "member", onr("group", "subgrp", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // subgrp#member is a member of ga, gb, gc (Portion #2) and also self-matches (Portion #1).
    const first = await collect(
      engine.lookupResources(
        reader,
        "group",
        "subgrp",
        "member",
        "group",
        "member",
        undefined,
        undefined,
        undefined,
        1,
      ),
    );
    const firstResource = single(first);
    expect(firstResource.afterCursor).toBeDefined();

    const rest = await collect(
      engine.lookupResources(
        reader,
        "group",
        "subgrp",
        "member",
        "group",
        "member",
        undefined,
        undefined,
        firstResource.afterCursor,
      ),
    );

    expect(ids(rest)).not.toContain(firstResource.resourceId);
    expect(sorted(new Set([...ids(first), ...ids(rest)]))).toEqual(["ga", "gb", "gc", "subgrp"]);
  });

  it("terminates on cyclic data", async () => {
    const { store, rev } = await seed(
      tuple("group", "a", "member", onr("group", "b", "member")),
      tuple("group", "b", "member", onr("group", "a", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // No user reaches anything; must terminate.
    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view"),
    );

    expect(found).toEqual([]);
  });

  it.each(["view", "edit_only", "allowed_view", "inherited_view"])(
    "agrees with Check across the resource universe for %s",
    async (permission) => {
      const { store, rev } = await seed(
        tuple("document", "doc1", "parent", onr("document", "folder")),
        tuple("document", "folder", "viewer", onr("user", "alice")),
        tuple("document", "doc1", "viewer", onr("user", "alice")),
        tuple("document", "doc1", "viewer", onr("user", "bob")),
        tuple("document", "doc1", "editor", onr("user", "alice")),
        tuple("document", "doc2", "editor", onr("user", "alice")),
        tuple("document", "doc2", "viewer", onr("user", "alice")),
        tuple("document", "doc1", "banned", onr("user", "alice")),
      );
      const engine = buildEngine(SCHEMA);
      const check = buildCheckEngine(SCHEMA);
      const reader = store.snapshotReader(rev);

      const found = await collect(
        engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", permission),
      );
      const foundIds = new Set(ids(found));

      // Soundness + completeness against Check (the definitional semantics for lookups).
      const universe = ["doc1", "doc2", "folder", "doc3"];
      for (const resourceId of universe) {
        const verdict = (
          await check.check(reader, "document", resourceId, permission, onr("user", "alice"))
        ).verdict;
        expect(foundIds.has(resourceId)).toBe(verdict === "member");
      }
    },
  );
});

describe("LookupResourcesEngine port decisions", () => {
  it("accepts a pre-built First-mode reachability graph and agrees with the self-built one", async () => {
    // The production caller passes the schema snapshot's First-mode graph so it is built once per
    // schema rather than once per request. All three C# constructors are kept as entry points; this
    // gate pins the argument ORDER of the collapsed TypeScript constructor, which is otherwise only
    // exercised from the grain layer.
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc2", "editor", onr("user", "alice")),
    );
    const compiled = compileSchema(SCHEMA);
    const byName = new Map<string, NamespaceDefinition>(
      compiled.namespaces.map((ns) => [ns.name, ns]),
    );
    const reachability = buildReachabilityGraph(byName, "first");
    const engine = new LookupResourcesEngine(compiled.namespaces, compiled.caveats, reachability);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view"),
    );

    expect(sorted(ids(found))).toEqual(["doc1", "doc2"]);
  });

  it("rejects empty required arguments, lazily, on first iteration", async () => {
    // `ArgumentException.ThrowIfNullOrEmpty` on four parameters becomes explicit
    // `InvalidArgumentError` guards, kept even though the TypeScript types are non-optional,
    // because the grain-layer caller is untyped. The method is an ASYNC ITERATOR in both languages,
    // so the guard runs on the first `MoveNext`/`next()`, not at the call - constructing the
    // iterable must not throw.
    const { store, rev } = await seed();
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const iterable = engine.lookupResources(reader, "", "alice", ELLIPSIS, "document", "view");
    await expect(collect(iterable)).rejects.toThrow(InvalidArgumentError);

    await expect(
      collect(engine.lookupResources(reader, "user", "", ELLIPSIS, "document", "view")),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      collect(engine.lookupResources(reader, "user", "alice", ELLIPSIS, "", "view")),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      collect(engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "")),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it("confirms a supplied covered-candidate set with Check instead of traversing", async () => {
    // The covered-candidate overload takes its candidate list POSITIONALLY BEFORE the caveat
    // context. This case pins that order: passing a caveat context in the candidate slot (or vice
    // versa) would still type-check under a laxer signature and silently change the result.
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc2", "viewer", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // An over-broad candidate set is safe: Check rejects doc2 and the nonexistent doc9.
    const found = await collect(
      engine.lookupResourcesWithCandidates(reader, "user", "alice", ELLIPSIS, "document", "view", [
        "doc1",
        "doc2",
        "doc9",
      ]),
    );

    expect(ids(found)).toEqual(["doc1"]);
    expect(single(found).membership).toBe("member");
    expect(single(found).forSubjectIds).toEqual(["alice"]);
  });

  it("falls back to the live traversal when no candidate set is supplied", async () => {
    // `coveredCandidateIds: null` in the C# takes the live path through the SAME overload, so the
    // TypeScript parameter accepts `undefined` and behaves identically to `lookupResources`.
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc2", "editor", onr("user", "alice")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const withUndefined = await collect(
      engine.lookupResourcesWithCandidates(
        reader,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
        undefined,
      ),
    );
    const live = await collect(
      engine.lookupResources(reader, "user", "alice", ELLIPSIS, "document", "view"),
    );

    expect(sorted(ids(withUndefined))).toEqual(sorted(ids(live)));
  });

  it("yields an EMPTY result set for an empty candidate list, not the live traversal", async () => {
    // An empty list is a COMPLETE candidate set that happens to be empty - absent-vs-empty matters
    // here, because `null` means "no accelerator ran" while `[]` means "the accelerator found
    // nothing". Collapsing the two would make an accelerated miss silently re-traverse.
    const { store, rev } = await seed(tuple("document", "doc1", "viewer", onr("user", "alice")));
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupResourcesWithCandidates(
        reader,
        "user",
        "alice",
        ELLIPSIS,
        "document",
        "view",
        [],
      ),
    );

    expect(found).toEqual([]);
  });

  it("reports a caveated candidate's missing params on the confirm-only path", async () => {
    const { store, rev } = await seed(
      caveated(
        "document",
        "doc1",
        "viewer",
        onr("user", "alice"),
        "over_age",
        context([["min_age", 18]]),
      ),
    );
    const engine = buildEngine(CAVEAT_SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupResourcesWithCandidates(reader, "user", "alice", ELLIPSIS, "document", "view", [
        "doc1",
      ]),
    );

    const only = single(found);
    expect(only.membership).toBe("caveated");
    expect(only.missingContextParams).toContain("age");
  });
});

// Not from the C# suite. `namespaces.ToImmutableDictionary(ns => ns.Name)` throws on a duplicate
// key; a bare `Map.set` would analyse a schema the C# refuses outright.
describe("LookupResourcesEngine duplicate namespaces", () => {
  it("throws rather than letting the last definition silently win", () => {
    const compiled = compileSchema("definition document {}");
    const [doc] = compiled.namespaces;

    expect(() => new LookupResourcesEngine([doc!, doc!], compiled.caveats)).toThrow(
      InvalidArgumentError,
    );
  });
});
