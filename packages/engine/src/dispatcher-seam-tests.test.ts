import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { formatObjectAndRelation } from "@spacedb/core/tuple-strings";
import type { IDatastoreReader } from "@spacedb/datastore/i-datastore";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import { compile } from "@spacedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_DEPTH } from "./check-engine";
import { systemClockNow } from "./clock";
import type { DispatchCheckRequest, DispatchCheckResult, IDispatcher } from "./i-dispatcher";
import { LocalDispatcher } from "./local-dispatcher";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/DispatcherSeamTests.cs`, case for case.
//
// Proves the dispatch seam: a counting `IDispatcher` decorator wraps the local dispatcher and
// confirms every sub-problem of a multi-relation check flows through it.
//
// This is why `LocalDispatcher` stays a CLASS rather than a closure over a frozen self-reference:
// `local.dispatcher = counting` reassigns genuine mutable state on a live object, and the recursion
// the local dispatcher generates must route through the decorator afterwards.
//
// `formatObjectAndRelation` stands in for `ObjectAndRelation.ToString()`, which elides an ellipsis
// relation - hence the expected "user:alice", not "user:alice#...".

const SCHEMA = `
definition user {}

definition group {
    relation member: user | group#member
}

definition document {
    relation parent: document
    relation viewer: user | group#member

    permission view = viewer + parent->view
}
`;

/** An `IDispatcher` decorator that counts and records every dispatched sub-problem. */
class CountingDispatcher implements IDispatcher {
  count = 0;
  readonly calls: [resource: string, subject: string][] = [];

  constructor(private readonly inner: IDispatcher) {}

  dispatchCheck(
    request: DispatchCheckRequest,
    signal: AbortSignal | undefined,
  ): Promise<DispatchCheckResult> {
    this.count++;
    this.calls.push([
      formatObjectAndRelation(request.resource),
      formatObjectAndRelation(request.subject),
    ]);
    return this.inner.dispatchCheck(request, signal);
  }
}

async function seed(...rels: readonly Relationship[]): Promise<IDatastoreReader> {
  const store = new ReferenceDatastore();
  const rev = await store.readWriteTx(async (tx) => {
    const updates: RelationshipUpdate[] = rels.map((r) => ({
      relationship: r,
      operation: "create",
    }));
    await tx.writeRelationships(updates);
  });
  return store.snapshotReader(rev);
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

function namespacesOf(schemaText: string): ReadonlyMap<string, NamespaceDefinition> {
  return new Map(compile(schemaText).map((ns) => [ns.name, ns]));
}

// The engine's in-process revision sentinel is not what this test is about; the reader resolver
// ignores the revision, so any `IRevision` works for driving the dispatcher directly. The C# takes
// a real, comparable identity from `HeadRevision`, so this does too.
async function revisionForTest(): Promise<IRevision> {
  const store = new ReferenceDatastore();
  return (await store.headRevision()).revision;
}

describe("dispatch seam", () => {
  it("routes every sub-problem through the decorator and leaves the verdict unchanged", async () => {
    // doc:readme view -> parent->view -> doc:root viewer -> group:eng#member -> user:alice
    const reader = await seed(
      tuple("document", "readme", "parent", onr("document", "root")),
      tuple("document", "root", "viewer", onr("group", "eng", "member")),
      tuple("group", "eng", "member", onr("user", "alice")),
    );

    const local = new LocalDispatcher(namespacesOf(SCHEMA), () => reader, systemClockNow());

    const counting = new CountingDispatcher(local);
    // Route every sub-problem the local dispatcher generates back through the decorator.
    local.dispatcher = counting;

    const request: DispatchCheckRequest = {
      resource: onr("document", "readme", "view"),
      subject: onr("user", "alice"),
      meta: {
        revision: await revisionForTest(),
        depthRemaining: DEFAULT_MAX_DEPTH,
        visited: new Set<string>(),
        schemaHash: undefined,
      },
    };

    const result = await counting.dispatchCheck(request, undefined);

    expect(result.member).toBe(true);
    expect(result.caveat).toBeUndefined();
    expect(result.cycleCut).toBe(false);

    // The top-level call plus every recursive sub-problem went through the decorator. The walk
    // visits more than just the root, proving recursion is delegated rather than self-called - this
    // is the seam property this test pins: the local dispatcher never recurses into itself directly,
    // every sub-problem flows out through the injected dispatcher (here, the counting decorator).
    expect(counting.count).toBeGreaterThanOrEqual(4);

    // Some specific sub-problems we expect to see routed through the seam.
    expect(counting.calls).toContainEqual(["document:readme#view", "user:alice"]);
    expect(counting.calls).toContainEqual(["document:root#viewer", "user:alice"]);
    expect(counting.calls).toContainEqual(["group:eng#member", "user:alice"]);
  });
});
