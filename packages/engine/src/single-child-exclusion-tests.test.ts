import { ELLIPSIS } from "@benedb/core/core-constants";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import type { SetOperation } from "@benedb/core/userset-rewrite";
import type { IDatastoreReader } from "@benedb/datastore/i-datastore";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import { compile } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_DEPTH } from "./check-engine";
import { systemClockNow } from "./clock";
import type { DispatchCheckResult } from "./i-dispatcher";
import { LocalDispatcher } from "./local-dispatcher";
import { SingleChildExclusionError } from "./single-child-exclusion-error";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/SingleChildExclusionTests.cs`, case for case.
//
// An exclusion needs a base and at least one subtracted operand. SpiceDB's `difference` treats a
// single-child exclusion as a bug (`MustBugf("difference requires more than a single child")`,
// internal/graph/check.go) rather than evaluating it. The schema parser never produces one, so this
// pins the behaviour for a malformed stored rewrite: it fails loudly instead of granting the base
// operand.
//
// `Assert.ThrowsAsync<InvalidOperationException>` becomes the project error class the port guide
// asks for, `SingleChildExclusionError`, named for the invariant it protects.

const SCHEMA = `
definition user {}

definition document {
    relation viewer: user
    relation banned: user

    permission view = viewer - banned
}
`;

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

async function seed(
  ...rels: readonly Relationship[]
): Promise<{ store: ReferenceDatastore; reader: IDatastoreReader }> {
  const store = new ReferenceDatastore();
  const rev = await store.readWriteTx(async (tx) => {
    const updates: RelationshipUpdate[] = rels.map((r) => ({
      relationship: r,
      operation: "create",
    }));
    await tx.writeRelationships(updates);
  });
  return { store, reader: store.snapshotReader(rev) };
}

function withViewRewrite(
  rewrite: (operation: SetOperation) => SetOperation,
): ReadonlyMap<string, NamespaceDefinition> {
  const namespaces = new Map(compile(SCHEMA).map((ns) => [ns.name, ns]));
  const document = namespaces.get("document");
  if (document === undefined) throw new Error("the schema defines document");
  const view = document.relations.find((r) => r.name === "view");
  if (view?.usersetRewrite === undefined) throw new Error("the schema defines view");
  const replaced = {
    ...view,
    usersetRewrite: { operation: rewrite(view.usersetRewrite.operation) },
  };
  namespaces.set("document", {
    ...document,
    relations: document.relations.map((r) => (r === view ? replaced : r)),
  });
  return namespaces;
}

async function checkView(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  userId = "alice",
  ...rels: readonly Relationship[]
): Promise<DispatchCheckResult> {
  const seeded =
    rels.length === 0
      ? [createRelationship(onr("document", "readme", "viewer"), onr("user", "alice"))]
      : rels;
  const { store, reader } = await seed(...seeded);
  const dispatcher = new LocalDispatcher(namespaces, () => reader, systemClockNow());
  return dispatcher.dispatchCheck(
    {
      resource: onr("document", "readme", "view"),
      subject: onr("user", userId),
      meta: {
        revision: (await store.headRevision()).revision,
        depthRemaining: DEFAULT_MAX_DEPTH,
        visited: new Set<string>(),
        schemaHash: undefined,
      },
    },
    undefined,
  );
}

describe("single-child exclusion", () => {
  it("fails loudly instead of returning its base", async () => {
    const namespaces = withViewRewrite((op) => ({ ...op, children: op.children.slice(0, 1) }));

    const check = checkView(namespaces);

    await expect(check).rejects.toThrow(SingleChildExclusionError);
    await expect(check).rejects.toThrow("more than a single child");
  });

  it("is still no members when empty", async () => {
    const namespaces = withViewRewrite((op) => ({ ...op, children: [] }));

    const result = await checkView(namespaces);

    expect(result.member).toBe(false);
  });

  it("still evaluates a well-formed exclusion", async () => {
    const result = await checkView(withViewRewrite((op) => op));

    expect(result.member).toBe(true);
  });

  it("subtracts a well-formed exclusion's second operand", async () => {
    const rels = [
      createRelationship(onr("document", "readme", "viewer"), onr("user", "alice")),
      createRelationship(onr("document", "readme", "viewer"), onr("user", "bob")),
      createRelationship(onr("document", "readme", "banned"), onr("user", "bob")),
    ];
    const namespaces = withViewRewrite((op) => op);

    expect((await checkView(namespaces, "alice", ...rels)).member).toBe(true);
    expect((await checkView(namespaces, "bob", ...rels)).member).toBe(false);
  });
});
