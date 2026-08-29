import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { parseRelationship } from "@spacedb/core/tuple-strings";
import type { IGraphReader } from "@spacedb/datastore/i-graph-reader";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import type { GrainInterface } from "@thresh/core/grain-interface";
import { describe, expect, it } from "vitest";

import type { IGraphReaderSource } from "./i-graph-reader-source";
import { MutableSchemaProvider } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import { ISubjectFrontierGrain } from "./i-subject-frontier-grain";
import { ReverseOps } from "./reverse-ops";
import { decodeSubjectId, encodeSubjectId } from "./reverse-ops-cursor-codec";
import type {
  ExpandTreeNodeWire,
  LookupResourcesArgs,
  LookupSubjectsArgs,
} from "./reverse-ops-dtos";
import { SchemaResolver } from "./schema-resolver";
import type { SubjectFrontierReply } from "./subject-frontier-dtos";
import { subjectFrontierKeyBuild } from "./subject-frontier-key";
import type { SubjectFrontierMemoOptions } from "./subject-frontier-memo-options";

/**
 * No covering C# test that can RUN yet: `ReverseOpsMeshTests` / `ReverseOpsCorpusMeshTests` all
 * build a `MeshTestCluster`, and the grain implementations behind that cluster are a later slice.
 * This is a CHARACTERIZATION of `Grains/ReverseOps.cs`, derived line by line from the C#.
 *
 * What is easiest to lose, and why each matters:
 *
 *   1. `ExpandPermissionTree` passes `CancellationToken.None` at ALL FOUR call sites - it is the
 *      only op with no token parameter. Threading a signal in would be a redesign.
 *   2. Expand's caveat handling evaluates against a NULL request context and surfaces only the
 *      missing field names. A definitely-FALSE caveat surfaces no fields and the node is NOT
 *      pruned: Expand carries the structure verbatim.
 *   3. Two DIFFERENT default policies in one file: `ToWire(SetOperationType)` falls back to Union
 *      for anything unrecognised, while `ToWire(PermissionTreeNode)` THROWS `NotSupportedException`.
 *   4. `StreamLookupSubjects` chooses memo-vs-live BELOW the pin and the schema resolution, so both
 *      paths feed the identical skip / collapse / yield loop and cannot drift. The skip is ORDINAL
 *      and EXCLUSIVE (`CompareOrdinal(found.SubjectId, a) <= 0`), and `FoundSubject.ExcludedSubjects`
 *      is deliberately DROPPED at the wire edge.
 *   5. `StreamLookupResources` derives `limit = args.Limit is { } l && l > 0 ? l : null`, so a limit
 *      of 0 or negative becomes UNLIMITED - and `hasCursorOrLimit` tests the DERIVED limit, so
 *      `Limit = 0` does NOT block the Leopard path while a non-null Cursor does.
 *   6. `MemoizedFrontier` keys on `schemaHash ?? schemaProvider.Current.SchemaHash` - an ambient
 *      fallback that `PinRevision` itself does NOT do - and replays the reply in the engine's own
 *      order with NO sort.
 */

const SCHEMA_TEXT = `
caveat has_flag(flag bool) {
  flag == true
}

definition user {}

definition group {
  relation member: user
}

definition document {
  relation viewer: user | user:* | group#member
  relation editor: user
  relation banned: user
  permission view = viewer + editor
  permission safe_view = viewer - banned
  permission gated = viewer & editor
}

definition gated_document {
  relation viewer: user with has_flag
  permission view = viewer
}
`;

function rel(tuple: string): Relationship {
  return parseRelationship(tuple);
}

function caveated(tuple: string, caveatName: string): Relationship {
  const base = parseRelationship(tuple);
  return createRelationship(base.reference.resource, base.reference.subject, {
    caveatName,
    context: undefined,
  });
}

async function seed(...rels: readonly Relationship[]): Promise<{
  readonly store: ReferenceDatastore;
  readonly revision: IRevision;
}> {
  const store = new ReferenceDatastore();
  const revision = await store.readWriteTx(async (tx) => {
    const updates: RelationshipUpdate[] = rels.map((r) => ({
      relationship: r,
      operation: "create",
    }));
    await tx.writeRelationships(updates);
  });
  return { store, revision };
}

/** Records every reader mint, so "the reader is pinned at the PINNED revision" is assertable. */
interface FakeReaderSource {
  readonly source: IGraphReaderSource;
  readonly revisions: IRevision[];
}

function readerSourceOver(store: ReferenceDatastore): FakeReaderSource {
  const revisions: IRevision[] = [];
  return {
    source: {
      graphReaderAt(revision: IRevision): IGraphReader {
        revisions.push(revision);
        return store.snapshotReader(revision);
      },
    },
    revisions,
  };
}

/** A schema source that never has persisted bytes, so the resolver falls back to the seed. */
const NO_SCHEMA_SOURCE: ISchemaSource = {
  readSchemaAt: () => Promise.resolve(undefined),
};

/** One recorded `ISubjectFrontierGrain.getFrontier` call. */
interface FrontierMesh {
  readonly seam: { getGrain<T>(definition: GrainInterface<T>, key: never): T };
  readonly keys: string[];
  readonly definitions: unknown[];
  readonly calls: { count: number };
}

function frontierMesh(reply: SubjectFrontierReply = { subjects: [] }): FrontierMesh {
  const keys: string[] = [];
  const definitions: unknown[] = [];
  const calls = { count: 0 };
  return {
    seam: {
      getGrain<T>(definition: GrainInterface<T>, key: never): T {
        definitions.push(definition);
        keys.push(key as unknown as string);
        return {
          getFrontier(): Promise<SubjectFrontierReply> {
            calls.count += 1;
            return Promise.resolve(reply);
          },
          getContainingSet: () =>
            Promise.resolve({ nodes: [], cycleCut: false, incomplete: false }),
        } as unknown as T;
      },
    },
    keys,
    definitions,
    calls,
  };
}

interface Harness {
  readonly ops: ReverseOps;
  readonly store: ReferenceDatastore;
  readonly revision: IRevision;
  readonly readers: FakeReaderSource;
  readonly mesh: FrontierMesh;
  readonly provider: MutableSchemaProvider;
}

async function harness(
  rels: readonly Relationship[],
  options: {
    readonly frontier?: SubjectFrontierReply;
    readonly frontierMemo?: SubjectFrontierMemoOptions;
    readonly membershipWalkEnabled?: boolean;
    readonly ambientSchemaText?: string;
  } = {},
): Promise<Harness> {
  const { store, revision } = await seed(...rels);
  const readers = readerSourceOver(store);
  const mesh = frontierMesh(options.frontier);
  const provider = new MutableSchemaProvider(options.ambientSchemaText ?? SCHEMA_TEXT);
  const ops = new ReverseOps(
    store,
    NO_SCHEMA_SOURCE,
    provider,
    new SchemaResolver(),
    mesh.seam,
    { enabled: options.membershipWalkEnabled ?? false },
    readers.source,
    options.frontierMemo,
  );
  return { ops, store, revision, readers, mesh, provider };
}

/**
 * `SubjectFrontierMemoOptions.Enabled` defaults to TRUE in the C# (`MemoGrainOptions.Enabled`), so
 * a harness with no `frontier` reply serves every lookup from an EMPTY memo. The cases below that
 * characterise the ENGINE's own output therefore turn the memo off explicitly; the default
 * (memo-on) behaviour is pinned by its own case further down.
 */
const LIVE_WALK: SubjectFrontierMemoOptions = { enabled: false };

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

function subjectsArgs(overrides: Partial<LookupSubjectsArgs> = {}): LookupSubjectsArgs {
  return {
    resourceType: "document",
    resourceId: "doc1",
    permission: "view",
    subjectType: "user",
    subjectRelation: ELLIPSIS,
    ...overrides,
  };
}

function resourcesArgs(overrides: Partial<LookupResourcesArgs> = {}): LookupResourcesArgs {
  return {
    resourceType: "document",
    permission: "view",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: ELLIPSIS,
    ...overrides,
  };
}

// --- ExpandPermissionTree ---------------------------------------------------------------------

describe("ReverseOps.expandPermissionTree", () => {
  it("maps a set-operation root and its leaves, carrying the resource ONR on every node", async () => {
    const h = await harness([
      rel("document:doc1#viewer@user:alice"),
      rel("document:doc1#editor@user:bob"),
    ]);

    const reply = await h.ops.expandPermissionTree({
      resourceType: "document",
      resourceId: "doc1",
      permission: "view",
      mode: "shallow",
    });

    // `permission view = viewer + editor` -> a Union node over two leaves.
    expect(reply.root.isLeaf).toBe(false);
    expect(reply.root.operation).toBe("union");
    expect(reply.root.expandedType).toBe("document");
    expect(reply.root.expandedId).toBe("doc1");
    expect(reply.root.expandedRelation).toBe("view");
    // `Subjects: []` on a set-op node; `Children: []` on a leaf. The C# fills exactly one.
    expect(reply.root.subjects).toEqual([]);
    expect(reply.root.children).toHaveLength(2);
    for (const child of reply.root.children) {
      expect(child.isLeaf).toBe(true);
      expect(child.children).toEqual([]);
    }
  });

  it("maps intersection and exclusion, not just union", async () => {
    // `ToWire(SetOperationType)` has one arm per operation; only the DEFAULT collapses to Union.
    const h = await harness([rel("document:doc1#viewer@user:alice")]);

    const excl = await h.ops.expandPermissionTree({
      resourceType: "document",
      resourceId: "doc1",
      permission: "safe_view",
      mode: "shallow",
    });
    expect(excl.root.operation).toBe("exclusion");

    const inter = await h.ops.expandPermissionTree({
      resourceType: "document",
      resourceId: "doc1",
      permission: "gated",
      mode: "shallow",
    });
    expect(inter.root.operation).toBe("intersection");
  });

  it("carries the wildcard flag and the subject relation on each expanded subject", async () => {
    const h = await harness([
      rel("document:doc1#viewer@user:*"),
      rel("document:doc1#viewer@group:eng#member"),
    ]);

    const reply = await h.ops.expandPermissionTree({
      resourceType: "document",
      resourceId: "doc1",
      permission: "viewer",
      mode: "shallow",
    });

    const subjects = reply.root.subjects;
    const wildcard = subjects.find((s) => s.subjectId === PUBLIC_WILDCARD);
    expect(wildcard?.isWildcard).toBe(true);
    expect(wildcard?.subjectType).toBe("user");
    const userset = subjects.find((s) => s.subjectType === "group");
    expect(userset?.subjectRelation).toBe("member");
    expect(userset?.isWildcard).toBe(false);
  });

  it("surfaces a caveat's MISSING FIELD NAMES against a null request context", async () => {
    // `MissingOf` evaluates with `requestContext: null`, so `has_flag(flag bool)` with no context
    // is `Caveated` and reports the parameter name.
    const h = await harness([caveated("gated_document:doc1#viewer@user:alice", "has_flag")]);

    const reply = await h.ops.expandPermissionTree({
      resourceType: "gated_document",
      resourceId: "doc1",
      permission: "view",
      mode: "shallow",
    });

    const subject = firstSubject(reply.root);
    expect(subject?.caveatMissingFields).toEqual(["flag"]);
  });

  it("uses an EMPTY list, never a null, for an uncaveated node or subject", async () => {
    // `caveat is null ? [] : ...` - the empty list is the C#'s own, so it must not become absent.
    const h = await harness([rel("document:doc1#viewer@user:alice")]);

    const reply = await h.ops.expandPermissionTree({
      resourceType: "document",
      resourceId: "doc1",
      permission: "viewer",
      mode: "shallow",
    });

    expect(reply.root.caveatMissingFields).toEqual([]);
    expect(firstSubject(reply.root)?.caveatMissingFields).toEqual([]);
  });

  it("does NOT prune a node whose caveat is definitely false", async () => {
    // Expand carries the structure VERBATIM: `MissingOf` returns only missing fields, and a
    // definitely-false caveat has none - so the subject still appears with an empty list. This is
    // the whole reason Expand does not reuse `ReverseOpsSupport.TryCollapse`.
    const h = await harness([
      createRelationship(
        parseRelationship("gated_document:doc1#viewer@user:alice").reference.resource,
        parseRelationship("gated_document:doc1#viewer@user:alice").reference.subject,
        { caveatName: "has_flag", context: new Map([["flag", false]]) },
      ),
    ]);

    const reply = await h.ops.expandPermissionTree({
      resourceType: "gated_document",
      resourceId: "doc1",
      permission: "view",
      mode: "shallow",
    });

    const subject = firstSubject(reply.root);
    expect(subject?.subjectId).toBe("alice");
    expect(subject?.caveatMissingFields).toEqual([]);
  });

  it("mints the read-at token and pins the reader at the resolved revision", async () => {
    const h = await harness([rel("document:doc1#viewer@user:alice")]);

    const reply = await h.ops.expandPermissionTree({
      resourceType: "document",
      resourceId: "doc1",
      permission: "view",
      mode: "shallow",
    });

    expect(reply.expandedAtToken).toBeTruthy();
    expect(h.readers.revisions).toHaveLength(1);
  });

  it("rejects absent args", async () => {
    // `ArgumentNullException.ThrowIfNull(args);` - and this method is a plain async Task, so the
    // rejection arrives on the returned promise.
    const h = await harness([]);
    await expect(
      h.ops.expandPermissionTree(
        undefined as unknown as Parameters<ReverseOps["expandPermissionTree"]>[0],
      ),
    ).rejects.toThrow(InvalidArgumentError);
  });
});

function firstSubject(
  node: ExpandTreeNodeWire,
): ExpandTreeNodeWire["subjects"][number] | undefined {
  if (node.isLeaf) return node.subjects[0];
  for (const child of node.children) {
    const found = firstSubject(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

// --- StreamLookupSubjects ---------------------------------------------------------------------

describe("ReverseOps.streamLookupSubjects", () => {
  it("streams each subject with its own resume cursor and the shared read-at token", async () => {
    const h = await harness(
      [rel("document:doc1#viewer@user:alice"), rel("document:doc1#editor@user:bob")],
      { frontierMemo: LIVE_WALK },
    );

    const items = await drain(h.ops.streamLookupSubjects(subjectsArgs()));

    expect(new Set(items.map((i) => i.subject.subjectId))).toEqual(new Set(["alice", "bob"]));
    for (const item of items) {
      // `ReverseOpsCursorCodec.EncodeSubjectId(found.SubjectId)` - the cursor is positioned
      // immediately AFTER the item it rides on.
      expect(decodeSubjectId(item.resumeCursor)).toBe(item.subject.subjectId);
      expect(item.lookedUpAtToken).toBeTruthy();
    }
    expect(new Set(items.map((i) => i.lookedUpAtToken)).size).toBe(1);
  });

  it("skips subject ids AT or before the cursor, with ORDINAL comparison", async () => {
    // `if (after is { } a && string.CompareOrdinal(found.SubjectId, a) <= 0) continue;`
    // "Zoe" < "alice" ordinally (U+005A < U+0061); `localeCompare` would order them the other way
    // and re-emit or drop the wrong subject.
    const h = await harness(
      [
        rel("document:doc1#viewer@user:Zoe"),
        rel("document:doc1#viewer@user:alice"),
        rel("document:doc1#viewer@user:bob"),
      ],
      { frontierMemo: LIVE_WALK },
    );

    const items = await drain(
      h.ops.streamLookupSubjects(subjectsArgs({ cursor: encodeSubjectId("alice") })),
    );

    // "Zoe" and "alice" are both at-or-before "alice" under CompareOrdinal.
    expect(items.map((i) => i.subject.subjectId)).toEqual(["bob"]);
  });

  it("treats an absent or whitespace cursor as 'from the start'", async () => {
    // `ReverseOpsCursorCodec.DecodeSubjectId(args.Cursor)` returns null for null/whitespace, and
    // the skip is guarded on `after is { }`.
    const h = await harness([rel("document:doc1#viewer@user:alice")], {
      frontierMemo: LIVE_WALK,
    });

    expect(await drain(h.ops.streamLookupSubjects(subjectsArgs()))).toHaveLength(1);
    expect(await drain(h.ops.streamLookupSubjects(subjectsArgs({ cursor: "   " })))).toHaveLength(
      1,
    );
  });

  it("carries the wildcard flag and DROPS excluded subjects at the wire edge", async () => {
    // The NOTE in the C#: `FoundSubjectWire` has no excluded-subjects field, so exclusions are
    // preserved by the engine and dropped only here. The wire shape must have no such member.
    const h = await harness([rel("document:doc1#viewer@user:*")], {
      frontierMemo: LIVE_WALK,
    });

    const items = await drain(h.ops.streamLookupSubjects(subjectsArgs()));
    const wildcard = items.find((i) => i.subject.subjectId === PUBLIC_WILDCARD);

    expect(wildcard?.subject.isWildcard).toBe(true);
    expect(Object.keys(wildcard?.subject ?? {})).toEqual(
      expect.not.arrayContaining(["excludedSubjects"]),
    );
  });

  it("collapses a caveated subject to a caveated permissionship carrying the missing params", async () => {
    const h = await harness([caveated("gated_document:doc1#viewer@user:alice", "has_flag")], {
      frontierMemo: LIVE_WALK,
    });

    const [item] = await drain(
      h.ops.streamLookupSubjects(
        subjectsArgs({ resourceType: "gated_document", permission: "view" }),
      ),
    );

    expect(item?.subject.permissionship.isCaveated).toBe(true);
    expect([...(item?.subject.permissionship.missingContextParams ?? [])]).toEqual(["flag"]);
  });

  it("SHEARS a subject whose caveat is definitely false against the request context", async () => {
    // `if (!ReverseOpsSupport.TryCollapse(...)) continue;` - unlike Expand, LookupSubjects prunes.
    const h = await harness([caveated("gated_document:doc1#viewer@user:alice", "has_flag")], {
      frontierMemo: LIVE_WALK,
    });

    const items = await drain(
      h.ops.streamLookupSubjects(
        subjectsArgs({
          resourceType: "gated_document",
          permission: "view",
          context: new Map([["flag", false]]),
        }),
      ),
    );

    expect(items).toEqual([]);
  });

  it("collapses to an unconditional member when the context satisfies the caveat", async () => {
    const h = await harness([caveated("gated_document:doc1#viewer@user:alice", "has_flag")], {
      frontierMemo: LIVE_WALK,
    });

    const [item] = await drain(
      h.ops.streamLookupSubjects(
        subjectsArgs({
          resourceType: "gated_document",
          permission: "view",
          context: new Map([["flag", true]]),
        }),
      ),
    );

    expect(item?.subject.permissionship.isCaveated).toBe(false);
  });

  it("runs the LIVE engine walk when the frontier memo is disabled", async () => {
    const h = await harness([rel("document:doc1#viewer@user:alice")], {
      frontierMemo: { enabled: false },
    });

    const items = await drain(h.ops.streamLookupSubjects(subjectsArgs()));

    expect(items.map((i) => i.subject.subjectId)).toEqual(["alice"]);
    expect(h.mesh.calls.count).toBe(0);
    // The live path mints a reader; the memo path does not.
    expect(h.readers.revisions).toHaveLength(1);
  });

  it("uses the SubjectFrontierGrain memo by default and never touches the reader", async () => {
    // `SubjectFrontierMemoOptions` defaults to enabled, and `MemoizedFrontier` reads the grain
    // instead of walking - so no `GraphReaderAt` is minted on this path.
    const h = await harness([rel("document:doc1#viewer@user:alice")], {
      frontier: { subjects: [{ subjectId: "carol", isWildcard: false }] },
    });

    const items = await drain(h.ops.streamLookupSubjects(subjectsArgs()));

    expect(h.mesh.calls.count).toBe(1);
    expect(h.mesh.definitions).toEqual([ISubjectFrontierGrain]);
    // The memo's answer is what surfaces, proving the live engine did not run.
    expect(items.map((i) => i.subject.subjectId)).toEqual(["carol"]);
    expect(h.readers.revisions).toHaveLength(0);
  });

  it("replays the memo in the grain's own order, with NO sort", async () => {
    // `reply.Subjects.Select(FrontierWire.FromWire).ToList()` then `ToAsyncEnumerable` - the
    // engine's walk order is the contract; re-sorting here would change the client's paging.
    const h = await harness([], {
      frontier: {
        subjects: [
          { subjectId: "zeta", isWildcard: false },
          { subjectId: "alpha", isWildcard: false },
          { subjectId: "mid", isWildcard: false },
        ],
      },
    });

    const items = await drain(h.ops.streamLookupSubjects(subjectsArgs()));
    expect(items.map((i) => i.subject.subjectId)).toEqual(["zeta", "alpha", "mid"]);
  });

  it("applies the SAME cursor skip and collapse loop to the memo path", async () => {
    // The memo/live choice sits BELOW the pin and schema resolution precisely so both feed one
    // loop. The skip is still ordinal and exclusive on the memoized results.
    const h = await harness([], {
      frontier: {
        subjects: [
          { subjectId: "alice", isWildcard: false },
          { subjectId: "bob", isWildcard: false },
        ],
      },
    });

    const items = await drain(
      h.ops.streamLookupSubjects(subjectsArgs({ cursor: encodeSubjectId("alice") })),
    );
    expect(items.map((i) => i.subject.subjectId)).toEqual(["bob"]);
  });

  it("keys the frontier grain on the resource ONR, subject shape, revision and schema hash", async () => {
    // `SubjectFrontierKey.Build(resource, args.SubjectType, args.SubjectRelation,
    //  revision.ToString(), schemaHash ?? schemaProvider.Current.SchemaHash)` - note the AMBIENT
    // fallback, which `PinRevision` itself deliberately does NOT apply.
    const h = await harness([rel("document:doc1#viewer@user:alice")]);

    await drain(h.ops.streamLookupSubjects(subjectsArgs()));

    const resource: ObjectAndRelation = {
      objectType: "document",
      objectId: "doc1",
      relation: "view",
    };
    expect(h.mesh.keys).toEqual([
      subjectFrontierKeyBuild(
        resource,
        "user",
        ELLIPSIS,
        h.revision.toString(),
        h.provider.current.schemaHash,
      ),
    ]);
  });

  it("rejects absent args and an already-aborted signal, both deferred to the first move", async () => {
    // `ArgumentNullException.ThrowIfNull(args); cancellationToken.ThrowIfCancellationRequested();`
    // - the first two statements of the iterator, so both surface on the first move.
    const h = await harness([rel("document:doc1#viewer@user:alice")]);

    await expect(
      drain(h.ops.streamLookupSubjects(undefined as unknown as LookupSubjectsArgs)),
    ).rejects.toThrow(InvalidArgumentError);

    const controller = new AbortController();
    controller.abort();
    await expect(
      drain(h.ops.streamLookupSubjects(subjectsArgs(), controller.signal)),
    ).rejects.toThrow();
    expect(h.mesh.calls.count).toBe(0);
  });
});

// --- StreamLookupResources --------------------------------------------------------------------

describe("ReverseOps.streamLookupResources", () => {
  it("streams the reachable resources, each with a resume cursor and the read-at token", async () => {
    const h = await harness([
      rel("document:doc1#viewer@user:alice"),
      rel("document:doc2#editor@user:alice"),
    ]);

    const items = await drain(h.ops.streamLookupResources(resourcesArgs()));

    expect(new Set(items.map((i) => i.resourceId))).toEqual(new Set(["doc1", "doc2"]));
    for (const item of items) {
      expect(item.lookedUpAtToken).toBeTruthy();
    }
  });

  it("maps a caveated engine result to a caveated permissionship, everything else to Member", async () => {
    // `found.Membership == Membership.Caveated ? Permissionship.Caveated(found.MissingContextParams)
    //  : Permissionship.Member` - the else arm is unconditional, not a third case.
    const h = await harness([
      caveated("gated_document:doc1#viewer@user:alice", "has_flag"),
      rel("document:doc2#viewer@user:alice"),
    ]);

    const [gated] = await drain(
      h.ops.streamLookupResources(resourcesArgs({ resourceType: "gated_document" })),
    );
    expect(gated?.permissionship.isCaveated).toBe(true);
    expect([...(gated?.permissionship.missingContextParams ?? [])]).toEqual(["flag"]);

    const [plain] = await drain(h.ops.streamLookupResources(resourcesArgs()));
    expect(plain?.permissionship.isCaveated).toBe(false);
    expect(plain?.permissionship.missingContextParams).toEqual([]);
  });

  it("treats a limit of ZERO as UNLIMITED, not as a zero-result read", async () => {
    // `var limit = args.Limit is { } l && l > 0 ? l : (int?)null;`
    const h = await harness([
      rel("document:doc1#viewer@user:alice"),
      rel("document:doc2#viewer@user:alice"),
      rel("document:doc3#viewer@user:alice"),
    ]);

    expect(await drain(h.ops.streamLookupResources(resourcesArgs({ limit: 0 })))).toHaveLength(3);
    expect(await drain(h.ops.streamLookupResources(resourcesArgs({ limit: -5 })))).toHaveLength(3);
  });

  it("applies a POSITIVE limit", async () => {
    const h = await harness([
      rel("document:doc1#viewer@user:alice"),
      rel("document:doc2#viewer@user:alice"),
      rel("document:doc3#viewer@user:alice"),
    ]);

    const items = await drain(h.ops.streamLookupResources(resourcesArgs({ limit: 2 })));
    expect(items).toHaveLength(2);
  });

  it("does NOT block the Leopard path on Limit = 0, but DOES on a cursor", async () => {
    // `hasCursorOrLimit: args.Cursor is not null || limit is not null` tests the DERIVED limit.
    // With the accelerator on, a walk grain call is the observable signature of the fast path.
    const walkCalls = { count: 0 };
    const { store, revision } = await seed(rel("document:doc1#viewer@user:alice"));
    void revision;
    const readers = readerSourceOver(store);
    const seam = {
      getGrain<T>(_definition: GrainInterface<T>, _key: never): T {
        return {
          getContainingSet(): Promise<{
            nodes: readonly never[];
            cycleCut: boolean;
            incomplete: boolean;
          }> {
            walkCalls.count += 1;
            return Promise.resolve({ nodes: [], cycleCut: false, incomplete: false });
          },
          getFrontier: () => Promise.resolve({ subjects: [] }),
        } as unknown as T;
      },
    };
    const ops = new ReverseOps(
      store,
      NO_SCHEMA_SOURCE,
      new MutableSchemaProvider(SCHEMA_TEXT),
      new SchemaResolver(),
      seam,
      { enabled: true },
      readers.source,
    );

    await drain(ops.streamLookupResources(resourcesArgs({ limit: 0 })));
    // Two root walks (concrete + wildcard) - the accelerator WAS consulted.
    expect(walkCalls.count).toBe(2);

    walkCalls.count = 0;
    await drain(ops.streamLookupResources(resourcesArgs({ cursor: "" })));
    // An EMPTY-STRING cursor is still `not null` in the C# check, so the accelerator declines.
    expect(walkCalls.count).toBe(0);
  });

  it("never consults the accelerator when the membership-walk option is off", async () => {
    const h = await harness([rel("document:doc1#viewer@user:alice")], {
      membershipWalkEnabled: false,
    });
    await drain(h.ops.streamLookupResources(resourcesArgs()));
    // `frontierMesh` doubles as the walk mesh; neither grain was asked for.
    expect(h.mesh.definitions).toEqual([]);
  });

  it("pins the reader at the resolved revision", async () => {
    const h = await harness([rel("document:doc1#viewer@user:alice")]);
    await drain(h.ops.streamLookupResources(resourcesArgs()));

    expect(h.readers.revisions.map((r) => r.toString())).toEqual([h.revision.toString()]);
  });

  it("yields nothing when the subject reaches nothing", async () => {
    const h = await harness([rel("document:doc1#viewer@user:bob")]);
    expect(await drain(h.ops.streamLookupResources(resourcesArgs()))).toEqual([]);
  });

  it("rejects absent args and an already-aborted signal, both deferred to the first move", async () => {
    const h = await harness([rel("document:doc1#viewer@user:alice")]);

    await expect(
      drain(h.ops.streamLookupResources(undefined as unknown as LookupResourcesArgs)),
    ).rejects.toThrow(InvalidArgumentError);

    const controller = new AbortController();
    controller.abort();
    await expect(
      drain(h.ops.streamLookupResources(resourcesArgs(), controller.signal)),
    ).rejects.toThrow();
  });

  it("does not touch the datastore until the stream is first moved", async () => {
    // Both streaming ops are C# iterators: the body runs on the first MoveNext.
    const h = await harness([rel("document:doc1#viewer@user:alice")]);
    const stream = h.ops.streamLookupResources(resourcesArgs());
    expect(h.readers.revisions).toHaveLength(0);

    await drain(stream);
    expect(h.readers.revisions).toHaveLength(1);
  });
});
