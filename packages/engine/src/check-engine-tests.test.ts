import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import { MaxDepthExceededException } from "@benedb/core/max-depth-exceeded-exception";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import { compile } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { CheckEngine } from "./check-engine";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/CheckEngineTests.cs`, case for case.
//
// The public Check surface: direct tuples, the three set operations, subject-relation walking,
// arrows, wildcards, and the depth budget - which is the ONLY termination guarantee, so a genuine
// cycle must raise `MaxDepthExceededException` rather than a confident non-member.
//
// Port notes for this file:
//   * The C# has two `Check` OVERLOADS. Per the port guide's overload row they become two named
//     functions; the (type, id, relation) one keeps the name `check`, and the ONR one is `checkOnr`.
//     Every case here uses the string form, exactly as the C# does.
//   * The five trailing optionals stay POSITIONAL and in the C#'s order - `caveatContext`,
//     `evaluationTime`, `atRevision`, `signal`. `atRevision` sits BETWEEN `evaluationTime` and the
//     token; reordering them silently rebinds every existing call site.
//   * The three C# constructors collapse to one: `(namespaces, caveats?, maxDepth?)`. The
//     maxDepth-only C# overload therefore passes `undefined` for caveats.

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

function buildEngine(schemaText: string, maxDepth?: number): CheckEngine {
  return new CheckEngine(compile(schemaText), undefined, maxDepth);
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

describe("CheckEngine", () => {
  it("resolves a direct tuple as a member", async () => {
    const { store, rev } = await seed(tuple("document", "doc1", "viewer", onr("user", "alice")));
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const result = await engine.check(reader, "document", "doc1", "view", onr("user", "alice"));

    expect(result.verdict).toBe("member");
  });

  it("resolves an absent direct tuple as not a member", async () => {
    const { store, rev } = await seed(tuple("document", "doc1", "viewer", onr("user", "alice")));
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const result = await engine.check(reader, "document", "doc1", "view", onr("user", "bob"));

    expect(result.verdict).toBe("notMember");
  });

  it("grants on either union operand", async () => {
    const { store, rev } = await seed(tuple("document", "doc1", "editor", onr("user", "alice")));
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // view = viewer + editor ; alice is only editor.
    const result = await engine.check(reader, "document", "doc1", "view", onr("user", "alice"));

    expect(result.verdict).toBe("member");
  });

  it("requires both operands for an intersection", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "editor", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "editor", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // edit_only = editor & viewer.
    const alice = await engine.check(reader, "document", "doc1", "edit_only", onr("user", "alice"));
    const bob = await engine.check(reader, "document", "doc1", "edit_only", onr("user", "bob"));

    expect(alice.verdict).toBe("member");
    expect(bob.verdict).toBe("notMember");
  });

  it("subtracts the excluded operand", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("user", "bob")),
      tuple("document", "doc1", "banned", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // allowed_view = viewer - banned.
    const alice = await engine.check(
      reader,
      "document",
      "doc1",
      "allowed_view",
      onr("user", "alice"),
    );
    const bob = await engine.check(reader, "document", "doc1", "allowed_view", onr("user", "bob"));

    expect(alice.verdict).toBe("member");
    expect(bob.verdict).toBe("notMember");
  });

  it("walks a subject relation through group membership", async () => {
    const { store, rev } = await seed(
      // alice is a member of group:eng
      tuple("group", "eng", "member", onr("user", "alice")),
      // group:eng#member is a viewer of doc1
      tuple("document", "doc1", "viewer", onr("group", "eng", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const result = await engine.check(reader, "document", "doc1", "view", onr("user", "alice"));

    expect(result.verdict).toBe("member");
  });

  it("walks nested subject relations (group in group)", async () => {
    const { store, rev } = await seed(
      // alice in group:inner
      tuple("group", "inner", "member", onr("user", "alice")),
      // group:inner#member in group:outer
      tuple("group", "outer", "member", onr("group", "inner", "member")),
      // group:outer#member views doc1
      tuple("document", "doc1", "viewer", onr("group", "outer", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const result = await engine.check(reader, "document", "doc1", "view", onr("user", "alice"));

    expect(result.verdict).toBe("member");
  });

  it("inherits view through an arrow on the parent", async () => {
    const { store, rev } = await seed(
      // doc1's parent is folderDoc
      tuple("document", "doc1", "parent", onr("document", "folderDoc")),
      // alice views the parent
      tuple("document", "folderDoc", "viewer", onr("user", "alice")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // inherited_view = viewer + parent->view ; alice is not a direct viewer of doc1.
    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "inherited_view",
      onr("user", "alice"),
    );

    expect(result.verdict).toBe("member");
  });

  it("denies an arrow with no tupleset tuple", async () => {
    const { store, rev } = await seed(
      tuple("document", "folderDoc", "viewer", onr("user", "alice")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "inherited_view",
      onr("user", "alice"),
    );

    expect(result.verdict).toBe("notMember");
  });

  it("grants any user of the type through a public wildcard", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", PUBLIC_WILDCARD)),
    );
    const engine = buildEngine(WILDCARD_SCHEMA);
    const reader = store.snapshotReader(rev);

    const alice = await engine.check(reader, "document", "doc1", "view", onr("user", "alice"));
    const bob = await engine.check(reader, "document", "doc1", "view", onr("user", "bob"));

    expect(alice.verdict).toBe("member");
    expect(bob.verdict).toBe("member");
  });

  it("does not let a wildcard grant another subject type", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", PUBLIC_WILDCARD)),
    );
    const engine = buildEngine(WILDCARD_SCHEMA);
    const reader = store.snapshotReader(rev);

    // A group subject must not be granted by a user:* wildcard.
    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "view",
      onr("group", "eng", "member"),
    );

    expect(result.verdict).toBe("notMember");
  });

  it("raises max-depth on a same-key cycle rather than a confident non-member", async () => {
    // group:a#member -> group:b#member -> group:a#member (a same-key cycle), nobody real inside.
    // Correctness rests SOLELY on the depth budget (SpiceDB's dispatch.CheckDepth): a genuine
    // cycle consumes depth until it errors, rather than the visited set silently cutting to a
    // confident (and wrong) NotMember. This matches SpiceDB, which raises MaxDepthExceededError
    // here. The check must TERMINATE (no infinite loop) and surface an error, never a verdict.
    const { store, rev } = await seed(
      tuple("group", "a", "member", onr("group", "b", "member")),
      tuple("group", "b", "member", onr("group", "a", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    await expect(
      engine.check(reader, "group", "a", "member", onr("user", "alice")),
    ).rejects.toThrow(MaxDepthExceededException);
  });

  it("resolves a deep linear chain within budget without a false termination", async () => {
    // A linear chain of 49 hops (under maxDepth 50) must resolve Member: the visited set is RECORD
    // ONLY on the in-process path (never Contains->Cut), so it must not introduce a false
    // termination on a legitimately deep, acyclic graph.
    const rels: Relationship[] = [];
    for (let i = 0; i < 48; i++) {
      rels.push(tuple("group", `g${i}`, "member", onr("group", `g${i + 1}`, "member")));
    }
    rels.push(tuple("group", "g48", "member", onr("user", "x")));

    const { store, rev } = await seed(...rels);
    const engine = buildEngine(SCHEMA, 50);
    const reader = store.snapshotReader(rev);

    const result = await engine.check(reader, "group", "g0", "member", onr("user", "x"));

    expect(result.verdict).toBe("member");
  });

  it("raises max-depth on a linear chain exceeding the budget", async () => {
    // A chain deeper than maxDepth(50) must error, not silently deny - the deepest
    // production-realistic case a probabilistic cycle guard could have corrupted.
    const rels: Relationship[] = [];
    for (let i = 0; i < 60; i++) {
      rels.push(tuple("group", `g${i}`, "member", onr("group", `g${i + 1}`, "member")));
    }
    rels.push(tuple("group", "g60", "member", onr("user", "x")));

    const { store, rev } = await seed(...rels);
    const engine = buildEngine(SCHEMA, 50);
    const reader = store.snapshotReader(rev);

    await expect(engine.check(reader, "group", "g0", "member", onr("user", "x"))).rejects.toThrow(
      MaxDepthExceededException,
    );
  });

  it("raises max-depth on exhaustion rather than a silent non-member", async () => {
    // A linear chain group:g0#member -> group:g1#member -> ... -> group:g5#member <- user:alice.
    // With a max depth small enough to run out before reaching alice, SpiceDB raises a max-depth
    // error rather than returning a confident "not a member" (which would mask the misconfiguration
    // AND let alice - a genuine member - be reported as denied).
    const rels: Relationship[] = [];
    for (let i = 0; i < 5; i++) {
      rels.push(tuple("group", `g${i}`, "member", onr("group", `g${i + 1}`, "member")));
    }
    rels.push(tuple("group", "g5", "member", onr("user", "alice")));

    const { store, rev } = await seed(...rels);
    const engine = buildEngine(SCHEMA, 3);
    const reader = store.snapshotReader(rev);

    await expect(
      engine.check(reader, "group", "g0", "member", onr("user", "alice")),
    ).rejects.toThrow(MaxDepthExceededException);
  });

  it("resolves the same chain when the depth budget is ample", async () => {
    // The same chain resolves to Member when the depth budget is ample, proving the error above is
    // depth exhaustion and not a structural failure.
    const rels: Relationship[] = [];
    for (let i = 0; i < 5; i++) {
      rels.push(tuple("group", `g${i}`, "member", onr("group", `g${i + 1}`, "member")));
    }
    rels.push(tuple("group", "g5", "member", onr("user", "alice")));

    const { store, rev } = await seed(...rels);
    const engine = buildEngine(SCHEMA, 50);
    const reader = store.snapshotReader(rev);

    const result = await engine.check(reader, "group", "g0", "member", onr("user", "alice"));

    expect(result.verdict).toBe("member");
  });

  it("checks a base relation directly, not only a permission", async () => {
    const { store, rev } = await seed(tuple("group", "eng", "member", onr("user", "alice")));
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const result = await engine.check(reader, "group", "eng", "member", onr("user", "alice"));

    expect(result.verdict).toBe("member");
  });
});
