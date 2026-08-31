import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { isPublicWildcard } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import { compile } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { CheckEngine } from "./check-engine";
import { ExpandEngine } from "./expand-engine";
import type { PermissionTreeNode } from "./permission-tree-node";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/ExpandEngineTests.cs`, case for case.
//
// ExpandEngine walks the userset-rewrite STRUCTURALLY and never consults the reachability graph,
// matching SpiceDB's `expand.go`. Two behaviours it does NOT share with the Check path, both
// deliberate and both exercised here:
//   * a depth-exhausted or already-visited node returns an EMPTY LEAF; it does not throw, where
//     `LocalDispatcher` raises `MaxDepthExceededException`. `CyclicSchema_Terminates` is the pin.
//   * `ExpandTupleToUserset` honours `computedUserset.object === "tupleObject"` (compute on the
//     RESOURCE) versus "tupleUsersetObject" (compute on the traversed subject), where
//     `LocalDispatcher.checkTupleToUserset` ALWAYS computes on the reached subject. The same
//     asymmetry is noted at `lookup-subjects-engine-tests.test.ts`.
//
// Port decisions for the surface under test:
//   * `ExpandPermissionTree`'s trailing optionals stay POSITIONAL and in the C# order:
//     `mode`, `evaluationTime`, `signal`. `mode` defaults to "shallow".
//   * `evaluationTime` is a `bigint` of epoch NANOSECONDS, as everywhere else in this package,
//     because `Relationship.optionalExpiration` already is.
//   * `ImmutableHashSet<string>` visited is copy-on-add, so sibling branches each receive the
//     PARENT's set rather than each other's accumulation.
//   * The whole engine is `Promise<PermissionTreeNode>`; there is no `IAsyncEnumerable` here.

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

function buildEngine(schemaText: string): ExpandEngine {
  return new ExpandEngine(compile(schemaText));
}

function buildCheckEngine(schemaText: string): CheckEngine {
  return new CheckEngine(compile(schemaText));
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

// `Assert.IsType<PermissionTreeNode.Leaf>` becomes a kind assertion plus a narrowing return; the
// discriminated union has no runtime type to assert against.
function asLeaf(node: PermissionTreeNode): Extract<PermissionTreeNode, { kind: "leaf" }> {
  expect(node.kind).toBe("leaf");
  if (node.kind !== "leaf") {
    throw new Error("expected a leaf node");
  }
  return node;
}

function asSetOp(node: PermissionTreeNode): Extract<PermissionTreeNode, { kind: "setOp" }> {
  expect(node.kind).toBe("setOp");
  if (node.kind !== "setOp") {
    throw new Error("expected a setOp node");
  }
  return node;
}

// Flattens the tree into the set of effective concrete subject ONRs of the given subject type,
// interpreting union/intersection/exclusion and recursing through computed/arrow children.
// Caveats are treated as "present" (unconditional) for set-membership purposes here, matching
// the unconditional corpus used in these tests.
function flatten(
  node: PermissionTreeNode,
  subjectType: string,
  subjectRelation: string,
): Set<string> {
  switch (node.kind) {
    case "leaf": {
      const set = new Set<string>();
      for (const ds of node.subjects) {
        const s = ds.subject;
        if (
          s.objectType === subjectType &&
          s.relation === subjectRelation &&
          !isPublicWildcard(s)
        ) {
          set.add(s.objectId);
        }
      }
      return set;
    }

    case "setOp": {
      const sets = node.children.map((c) => flatten(c, subjectType, subjectRelation));
      if (sets.length === 0) {
        return new Set<string>();
      }

      switch (node.operation) {
        case "union":
          return sets.reduce((a, b) => {
            for (const x of b) {
              a.add(x);
            }
            return a;
          });
        case "intersection":
          return sets.reduce((a, b) => {
            for (const x of [...a]) {
              if (!b.has(x)) {
                a.delete(x);
              }
            }
            return a;
          });
        case "exclusion":
          return exclude(sets);
        default:
          return new Set<string>();
      }
    }

    default:
      return assertNever(node);
  }
}

function exclude(sets: readonly Set<string>[]): Set<string> {
  const result = new Set<string>(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    for (const x of sets[i] ?? []) {
      result.delete(x);
    }
  }
  return result;
}

function assertNever(value: never): never {
  throw new Error(`unexpected permission tree node: ${JSON.stringify(value)}`);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe("ExpandEngine", () => {
  it("returns a leaf with the written subjects for a direct shallow expansion", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const tree = await engine.expandPermissionTree(reader, onr("document", "doc1", "viewer"));

    const leaf = asLeaf(tree);
    expect(leaf.expanded).toEqual(onr("document", "doc1", "viewer"));
    const ids = sorted(leaf.subjects.map((s) => s.subject.objectId));
    expect(ids).toEqual(["alice", "bob"]);
  });

  it("expands a union permission as a union setOp", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "editor", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // view = viewer + editor
    const tree = await engine.expandPermissionTree(reader, onr("document", "doc1", "view"));

    const op = asSetOp(tree);
    expect(op.operation).toBe("union");
    expect(op.children).toHaveLength(2);
    const flat = sorted(flatten(tree, "user", ELLIPSIS));
    expect(flat).toEqual(["alice", "bob"]);
  });

  it("expands an intersection permission as an intersection setOp", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "editor", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "editor", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // edit_only = editor & viewer ; only alice is in both.
    const tree = await engine.expandPermissionTree(reader, onr("document", "doc1", "edit_only"));

    const op = asSetOp(tree);
    expect(op.operation).toBe("intersection");
    const flat = flatten(tree, "user", ELLIPSIS);
    expect(sorted(flat)).toEqual(["alice"]);
  });

  it("expands an exclusion permission as an exclusion setOp", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("user", "bob")),
      tuple("document", "doc1", "banned", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // allowed_view = viewer - banned ; bob is banned.
    const tree = await engine.expandPermissionTree(reader, onr("document", "doc1", "allowed_view"));

    const op = asSetOp(tree);
    expect(op.operation).toBe("exclusion");
    const flat = flatten(tree, "user", ELLIPSIS);
    expect(sorted(flat)).toEqual(["alice"]);
  });

  it("expands through a parent arrow", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "parent", onr("document", "folderDoc")),
      tuple("document", "folderDoc", "viewer", onr("user", "alice")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // inherited_view = viewer + parent->view ; alice reaches doc1 only via the parent arrow.
    const tree = await engine.expandPermissionTree(
      reader,
      onr("document", "doc1", "inherited_view"),
      "recursive",
    );

    const op = asSetOp(tree);
    expect(op.operation).toBe("union");
    const flat = flatten(tree, "user", ELLIPSIS);
    expect(flat.has("alice")).toBe(true);
  });

  it("carries a wildcard verbatim in the leaf", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", PUBLIC_WILDCARD)),
    );
    const engine = buildEngine(WILDCARD_SCHEMA);
    const reader = store.snapshotReader(rev);

    const tree = await engine.expandPermissionTree(reader, onr("document", "doc1", "viewer"));

    const leaf = asLeaf(tree);
    expect(leaf.subjects).toHaveLength(1);
    const [subject] = leaf.subjects;
    if (subject === undefined) {
      throw new Error("expected a single direct subject");
    }
    expect(isPublicWildcard(subject.subject)).toBe(true);
    expect(subject.subject.objectId).toBe(PUBLIC_WILDCARD);
    expect(subject.subject.objectType).toBe("user");
  });

  it("expands a non-terminal userset only in recursive mode", async () => {
    const { store, rev } = await seed(
      tuple("group", "eng", "member", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("group", "eng", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // Shallow keeps the group#member userset verbatim as a leaf subject.
    const shallow = await engine.expandPermissionTree(
      reader,
      onr("document", "doc1", "viewer"),
      "shallow",
    );
    const shallowLeaf = asLeaf(shallow);
    expect(shallowLeaf.subjects).toHaveLength(1);
    expect(shallowLeaf.subjects[0]?.subject.objectType).toBe("group");

    // Recursive expands group:eng#member down to its concrete user members.
    const recursive = await engine.expandPermissionTree(
      reader,
      onr("document", "doc1", "viewer"),
      "recursive",
    );
    const flat = flatten(recursive, "user", ELLIPSIS);
    expect(flat.has("alice")).toBe(true);
  });

  it("terminates on a cyclic schema", async () => {
    const { store, rev } = await seed(
      tuple("group", "a", "member", onr("group", "b", "member")),
      tuple("group", "b", "member", onr("group", "a", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // Must terminate despite the a<->b cycle - by returning an empty leaf at the revisit, NOT by
    // throwing the way the Check path does.
    const tree = await engine.expandPermissionTree(
      reader,
      onr("group", "a", "member"),
      "recursive",
    );
    const flat = flatten(tree, "user", ELLIPSIS);
    expect(flat.size).toBe(0);
  });

  it.each(["view", "edit_only", "allowed_view"])(
    "agrees with Check when the %s tree is flattened",
    async (permission) => {
      const { store, rev } = await seed(
        tuple("document", "doc1", "viewer", onr("user", "alice")),
        tuple("document", "doc1", "viewer", onr("user", "bob")),
        tuple("document", "doc1", "editor", onr("user", "alice")),
        tuple("document", "doc1", "editor", onr("user", "carol")),
        tuple("document", "doc1", "banned", onr("user", "bob")),
      );
      const expand = buildEngine(SCHEMA);
      const check = buildCheckEngine(SCHEMA);
      const reader = store.snapshotReader(rev);

      const tree = await expand.expandPermissionTree(
        reader,
        onr("document", "doc1", permission),
        "recursive",
      );
      const flat = flatten(tree, "user", ELLIPSIS);

      // For the full universe of user ids, the flattened tree membership must equal Check.
      const universe = ["alice", "bob", "carol", "dave"];
      for (const id of universe) {
        const result = await check.check(reader, "document", "doc1", permission, onr("user", id));
        const expectedMember = result.verdict === "member";
        expect(flat.has(id)).toBe(expectedMember);
      }
    },
  );
});
