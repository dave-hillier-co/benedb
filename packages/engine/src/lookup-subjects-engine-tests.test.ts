import type { ContextualizedCaveat } from "@spacedb/core/contextualized-caveat";
import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import { compile, compileSchema } from "@spacedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { CheckEngine } from "./check-engine";
import type { FoundSubject } from "./found-subject";
import { LookupSubjectsEngine } from "./lookup-subjects-engine";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/LookupSubjectsEngineTests.cs`, case for case.
//
// Like ExpandEngine this walks the userset-rewrite STRUCTURALLY and never consults the
// reachability graph, matching SpiceDB's `lookupsubjects.go`. Most of the C# file is the private
// `SubjectSet` class - a port of SpiceDB's `internal/datasets/basesubjectset.go` wildcard algebra -
// which has no public surface, so the wildcard-algebra cases below are the only cover it gets.
//
// Port decisions for the surface under test:
//   * `LookupSubjects` returns `IAsyncEnumerable<FoundSubject>` -> `AsyncIterable<FoundSubject>`,
//     an `async function*`. Only the OUTER generator streams: set operations need whole child
//     sets, so internal collection stays materialised exactly as the C# has it.
//   * `[EnumeratorCancellation] CancellationToken` -> a trailing `signal?: AbortSignal | undefined`
//     kept in the C#'s positional slot, after `evaluationTime`. `AsyncIterable` has no signal
//     channel, so the producer takes it too.
//   * The trailing optionals stay POSITIONAL and in the C# order: `subjectRelation` (default
//     ELLIPSIS), `evaluationTime` (epoch nanoseconds, as everywhere in this package), `signal`.
//   * `SubjectSet._concrete` is a `Dictionary<string, Concrete>` whose iteration order feeds
//     `ToFoundSubjects` and therefore the yielded order. .NET's is unspecified and disturbed by
//     removals; a JS `Map`'s is stable insertion order. Every multi-subject assertion here sorts
//     (as the C# already does), so no case depends on either order.
//   * `ExpandTupleToUserset`'s "tupleObject" branch (compute on the RESOURCE) exists here too, and
//     differs from `LocalDispatcher.checkTupleToUserset`, which ALWAYS computes on the reached
//     subject. That asymmetry is genuine in the C#; see `expand-engine-tests.test.ts`.

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

// A schema whose intersection / exclusion permissions mix a wildcard operand with concrete
// operands, exercising the wildcard subject-set algebra (BaseSubjectSet port).
const WILDCARD_ALGEBRA_SCHEMA = `
definition user {}

definition document {
    relation any: user | user:*
    relation special: user
    relation blocked: user | user:*

    permission special_and_any = special & any
    permission special_minus_blocked = special - blocked
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

function buildEngine(schemaText: string): LookupSubjectsEngine {
  return new LookupSubjectsEngine(compile(schemaText));
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

async function collect(e: AsyncIterable<FoundSubject>): Promise<FoundSubject[]> {
  const list: FoundSubject[] = [];
  for await (const f of e) {
    list.push(f);
  }
  return list;
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

describe("LookupSubjectsEngine", () => {
  it("returns the written subjects of a direct relation", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "viewer"), "user"),
    );

    expect(sorted(found.map((f) => f.subjectId))).toEqual(["alice", "bob"]);
    for (const f of found) {
      expect(f.caveat).toBeUndefined();
    }
  });

  it("merges subjects across union children", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "editor", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // view = viewer + editor
    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "view"), "user"),
    );

    expect(sorted(found.map((f) => f.subjectId))).toEqual(["alice", "bob"]);
  });

  it("keeps only common subjects across an intersection", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "editor", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "editor", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // edit_only = editor & viewer ; only alice is in both.
    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "edit_only"), "user"),
    );

    expect(found.map((f) => f.subjectId)).toEqual(["alice"]);
  });

  it("removes banned subjects across an exclusion", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("user", "bob")),
      tuple("document", "doc1", "banned", onr("user", "bob")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // allowed_view = viewer - banned ; bob is banned.
    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "allowed_view"), "user"),
    );

    expect(found.map((f) => f.subjectId)).toEqual(["alice"]);
  });

  it("reaches subjects through a parent arrow", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "parent", onr("document", "folderDoc")),
      tuple("document", "folderDoc", "viewer", onr("user", "alice")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // inherited_view = viewer + parent->view
    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "inherited_view"), "user"),
    );

    expect(found.some((f) => f.subjectId === "alice")).toBe(true);
  });

  it("reaches concrete subjects through a nested userset", async () => {
    const { store, rev } = await seed(
      tuple("group", "eng", "member", onr("user", "alice")),
      tuple("document", "doc1", "viewer", onr("group", "eng", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "viewer"), "user"),
    );

    expect(found.map((f) => f.subjectId)).toEqual(["alice"]);
  });

  it("returns the userset verbatim when a subject relation is requested", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("group", "eng", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // Requesting subject type group with subrelation member should return the userset verbatim.
    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "viewer"), "group", "member"),
    );

    const only = single(found);
    expect(only.subjectId).toBe("eng");
    expect(only.isWildcard).toBe(false);
  });

  it("returns a wildcard as a wildcard FoundSubject", async () => {
    const { store, rev } = await seed(
      tuple("document", "doc1", "viewer", onr("user", PUBLIC_WILDCARD)),
    );
    const engine = buildEngine(WILDCARD_SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "view"), "user"),
    );

    const only = single(found);
    expect(only.isWildcard).toBe(true);
    expect(only.subjectId).toBe(PUBLIC_WILDCARD);
    expect(only.caveat).toBeUndefined();
  });

  it("intersects a concrete with a wildcard to yield the concrete", async () => {
    // special = {tom}; any = {*}. special & any must yield {tom} (a concrete matches a wildcard),
    // not empty. The old keyed-by-id set produced empty because "*" != "user:tom".
    const { store, rev } = await seed(
      tuple("document", "doc1", "special", onr("user", "tom")),
      tuple("document", "doc1", "any", onr("user", PUBLIC_WILDCARD)),
    );
    const engine = buildEngine(WILDCARD_ALGEBRA_SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "special_and_any"), "user"),
    );

    const only = single(found);
    expect(only.subjectId).toBe("tom");
    expect(only.isWildcard).toBe(false);
    expect(only.caveat).toBeUndefined();
  });

  it("subtracts a wildcard, removing concretes modulo its exclusions", async () => {
    // special = {tom, amy}; blocked = {*}. special - blocked removes everything.
    const { store, rev } = await seed(
      tuple("document", "doc1", "special", onr("user", "tom")),
      tuple("document", "doc1", "special", onr("user", "amy")),
      tuple("document", "doc1", "blocked", onr("user", PUBLIC_WILDCARD)),
    );
    const engine = buildEngine(WILDCARD_ALGEBRA_SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "special_minus_blocked"), "user"),
    );

    expect(found).toEqual([]);
  });

  it("intersects a wildcard with concretes to yield every concrete", async () => {
    // special would need a wildcard too; use any & blocked which are both wildcard-capable.
    const { store, rev } = await seed(
      tuple("document", "doc1", "any", onr("user", PUBLIC_WILDCARD)),
      tuple("document", "doc1", "special", onr("user", "tom")),
      tuple("document", "doc1", "special", onr("user", "amy")),
    );
    const engine = buildEngine(WILDCARD_ALGEBRA_SCHEMA);
    const reader = store.snapshotReader(rev);

    // special & any : both tom and amy are concretes that match the wildcard => {tom, amy}.
    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "special_and_any"), "user"),
    );

    expect(sorted(found.map((f) => f.subjectId))).toEqual(["amy", "tom"]);
    for (const f of found) {
      expect(f.isWildcard).toBe(false);
    }
  });

  it("carries a tuple caveat verbatim onto the found subject", async () => {
    const { store, rev } = await seed(
      caveated(
        "document",
        "doc1",
        "viewer",
        onr("user", "alice"),
        "over_age",
        new Map<string, unknown>([["min_age", 18]]),
      ),
      tuple("document", "doc1", "viewer", onr("user", "bob")),
    );
    const engine = buildEngine(CAVEAT_SCHEMA);
    const checkEngine = buildCheckEngine(CAVEAT_SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(
      engine.lookupSubjects(reader, onr("document", "doc1", "view"), "user"),
    );

    const alice = single(found.filter((f) => f.subjectId === "alice"));
    expect(alice.caveat).toBeDefined(); // the Caveated marker.
    const bob = single(found.filter((f) => f.subjectId === "bob"));
    expect(bob.caveat).toBeUndefined(); // unconditional.

    // The carried caveat must collapse the same way Check does against request context.
    const memberCtx = new Map<string, unknown>([["age", 21]]);
    const notMemberCtx = new Map<string, unknown>([["age", 16]]);
    const asMember = await checkEngine.check(
      reader,
      "document",
      "doc1",
      "view",
      onr("user", "alice"),
      memberCtx,
    );
    expect(asMember.verdict).toBe("member");
    const asNotMember = await checkEngine.check(
      reader,
      "document",
      "doc1",
      "view",
      onr("user", "alice"),
      notMemberCtx,
    );
    expect(asNotMember.verdict).toBe("notMember");
  });

  it("short-circuits on self when the requested type and relation match the resource", async () => {
    const { store, rev } = await seed();
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    // Asking for subjects of (user, ...) on user:alice#... returns alice itself.
    const found = await collect(engine.lookupSubjects(reader, onr("user", "alice"), "user"));

    const only = single(found);
    expect(only.subjectId).toBe("alice");
  });

  it("terminates on a cyclic schema", async () => {
    const { store, rev } = await seed(
      tuple("group", "a", "member", onr("group", "b", "member")),
      tuple("group", "b", "member", onr("group", "a", "member")),
    );
    const engine = buildEngine(SCHEMA);
    const reader = store.snapshotReader(rev);

    const found = await collect(engine.lookupSubjects(reader, onr("group", "a", "member"), "user"));

    expect(found).toEqual([]);
  });

  it.each(["view", "edit_only", "allowed_view", "inherited_view"])(
    "agrees with Check for %s",
    async (permission) => {
      const { store, rev } = await seed(
        tuple("document", "doc1", "parent", onr("document", "folder")),
        tuple("document", "folder", "viewer", onr("user", "dave")),
        tuple("document", "doc1", "viewer", onr("user", "alice")),
        tuple("document", "doc1", "viewer", onr("user", "bob")),
        tuple("document", "doc1", "editor", onr("user", "alice")),
        tuple("document", "doc1", "editor", onr("user", "carol")),
        tuple("document", "doc1", "banned", onr("user", "bob")),
      );
      const engine = buildEngine(SCHEMA);
      const check = buildCheckEngine(SCHEMA);
      const reader = store.snapshotReader(rev);

      const found = await collect(
        engine.lookupSubjects(reader, onr("document", "doc1", permission), "user"),
      );
      const foundIds = new Set(found.map((f) => f.subjectId));

      // Soundness + completeness against Check (the definitional semantics for lookups) across the
      // full universe.
      const universe = ["alice", "bob", "carol", "dave", "erin"];
      for (const id of universe) {
        const result = await check.check(reader, "document", "doc1", permission, onr("user", id));
        expect(foundIds.has(id)).toBe(result.verdict === "member");
      }
    },
  );
});
