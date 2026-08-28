import type { ContextualizedCaveat } from "@spacedb/core/contextualized-caveat";
import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import type { IDatastoreReader } from "@spacedb/datastore/i-datastore";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import type { FoundResource } from "./found-resource";
import { LookupResourcesEngine } from "./lookup-resources-engine";
import type { Membership } from "./membership";
import { buildMembershipCoverage, type MembershipCoverage } from "./membership-coverage";
import { localClosure, toCoveredCandidates } from "./membership-walk";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/Stage4MembershipWalkEquivalenceTests.cs`,
// case for case.
//
// THE EQUIVALENCE GATE, and the reason this batch goes last: candidates produced by
// `MembershipWalk.localClosure` plus coverage filtering must produce verdicts IDENTICAL to the live
// traversal for every shape coverage recognises, and coverage must DECLINE the shapes it cannot
// flatten. `MembershipWalk`'s output is defined by exactly what
// `lookupResourcesWithCandidates` accepts, so this file is what stops the two drifting.
//
// A walk that silently DROPS a candidate is a false negative Check confirmation cannot catch: the
// engine only ever confirms candidates the walk handed it, so a missing candidate never reaches
// Check at all. Over-inclusion is safe and only costs Check work; under-inclusion is a wrong
// answer.
//
// Driven directly against a `ReferenceDatastore` - no grains - so the matrix runs fast.

const NESTED_SCHEMA = `
definition user {}

definition group {
    relation member: user | group#member
}

definition document {
    relation viewer: user | group#member
    relation editor: user
    relation banned: user

    permission view = viewer + editor
    permission allowed_view = viewer - banned
    permission edit = editor & viewer
    permission via_arrow = viewer + parent_view
    permission parent_view = editor
}
`;

const CAVEAT_SCHEMA = `
caveat over_age(age int, min_age int) { age >= min_age }

definition user {}

definition group {
    relation member: user | group#member
}

definition document {
    relation viewer: user | group#member with over_age
    permission view = viewer
}
`;

const WILDCARD_SCHEMA = `
definition user {}

definition group {
    relation member: user:* | user | group#member
}

definition document {
    relation viewer: group#member
    permission view = viewer
}
`;

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

function rel(rt: string, rid: string, relation: string, subject: ObjectAndRelation): Relationship {
  return createRelationship(onr(rt, rid, relation), subject);
}

function caveatedRel(
  rt: string,
  rid: string,
  relation: string,
  subject: ObjectAndRelation,
  caveatName: string,
  ctx?: ReadonlyMap<string, unknown> | undefined,
): Relationship {
  const caveat: ContextualizedCaveat = { caveatName, context: ctx };
  return createRelationship(onr(rt, rid, relation), subject, caveat);
}

function context(entries: readonly [string, unknown][]): ReadonlyMap<string, unknown> {
  return new Map(entries);
}

interface Fixture {
  readonly engine: LookupResourcesEngine;
  readonly coverage: MembershipCoverage;
  readonly reader: IDatastoreReader;
}

async function setup(schemaText: string, ...rels: readonly Relationship[]): Promise<Fixture> {
  const compiled = compileSchema(schemaText);
  const engine = new LookupResourcesEngine(compiled.namespaces, compiled.caveats);
  const coverage = buildMembershipCoverage(compiled.namespaces);

  const store = new ReferenceDatastore();
  const rev = await store.readWriteTx(async (tx) => {
    const updates: RelationshipUpdate[] = rels.map((r) => ({
      relationship: r,
      operation: "create",
    }));
    await tx.writeRelationships(updates);
  });

  return { engine, coverage, reader: store.snapshotReader(rev) };
}

interface Outcome {
  readonly id: string;
  readonly membership: Membership;
}

async function collect(e: AsyncIterable<FoundResource>): Promise<Outcome[]> {
  const list: Outcome[] = [];
  for await (const f of e) {
    list.push({ id: f.resourceId, membership: f.membership });
  }
  // `list.Sort((a, b) => string.CompareOrdinal(...))`. `.NET List<T>.Sort` is an UNSTABLE introsort
  // while `Array.prototype.sort` is stable, so the two disagree wherever the comparator ties - and
  // ids here DO tie (the live path emits one result per entrypoint with no global dedup). Ties are
  // only ever between entries with the same id, and the assertions compare membership alongside it,
  // so no case can observe the difference.
  return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Walks the local closure from the subject and filters it through coverage exactly as the
 * production grain-mesh acquisition path does, returning the covered candidate ids - or `undefined`
 * if the shape is not covered.
 */
async function walkCandidates(
  reader: IDatastoreReader,
  coverage: MembershipCoverage,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  resourceType: string,
  permission: string,
): Promise<readonly string[] | undefined> {
  if (subjectId === PUBLIC_WILDCARD) return undefined;
  const yields = coverage.tryGetYields(resourceType, permission);
  if (yields === undefined) return undefined;

  const nodes = await localClosure(reader, coverage, {
    type: subjectType,
    id: subjectId,
    relation: subjectRelation,
  });
  return toCoveredCandidates(nodes, yields, resourceType, subjectType, subjectId);
}

/** The core gate: walk-derived candidate verdicts == live verdicts. */
async function assertEquivalent(
  fixture: Fixture,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  resourceType: string,
  permission: string,
  caveatContext?: ReadonlyMap<string, unknown> | undefined,
): Promise<void> {
  const { engine, coverage, reader } = fixture;

  const live = await collect(
    engine.lookupResourcesWithCandidates(
      reader,
      subjectType,
      subjectId,
      subjectRelation,
      resourceType,
      permission,
      undefined,
      caveatContext,
    ),
  );

  const candidates = await walkCandidates(
    reader,
    coverage,
    subjectType,
    subjectId,
    subjectRelation,
    resourceType,
    permission,
  );
  const walked = await collect(
    engine.lookupResourcesWithCandidates(
      reader,
      subjectType,
      subjectId,
      subjectRelation,
      resourceType,
      permission,
      candidates,
      caveatContext,
    ),
  );

  expect(walked).toEqual(live);
}

describe("membership walk equivalence", () => {
  it("matches the live traversal for deep nested group membership", async () => {
    // user:alice -> g1 -> g2 -> g3 (a 3-level chain); bob only in g3.
    const fixture = await setup(
      NESTED_SCHEMA,
      rel("group", "g1", "member", onr("user", "alice")),
      rel("group", "g2", "member", onr("group", "g1", "member")),
      rel("group", "g3", "member", onr("group", "g2", "member")),
      rel("group", "g3", "member", onr("user", "bob")),
      rel("document", "d1", "viewer", onr("group", "g3", "member")),
      rel("document", "d2", "viewer", onr("group", "g1", "member")),
      rel("document", "d3", "editor", onr("user", "alice")),
    );

    // Groups a subject belongs to (the self-referential relation, queried directly).
    await assertEquivalent(fixture, "user", "alice", ELLIPSIS, "group", "member");
    await assertEquivalent(fixture, "user", "bob", ELLIPSIS, "group", "member");
    // A group as a subject (which groups contain g1).
    await assertEquivalent(fixture, "group", "g1", "member", "group", "member");
    // Documents reachable via nested group membership + the union permission `view = viewer + editor`.
    await assertEquivalent(fixture, "user", "alice", ELLIPSIS, "document", "view");
    await assertEquivalent(fixture, "user", "bob", ELLIPSIS, "document", "view");
    await assertEquivalent(fixture, "user", "alice", ELLIPSIS, "document", "viewer");
    // Nobody (a subject with no memberships) yields nothing on either path.
    await assertEquivalent(fixture, "user", "nobody", ELLIPSIS, "document", "view");
  });

  it("matches the live traversal for exclusion and intersection permissions", async () => {
    const fixture = await setup(
      NESTED_SCHEMA,
      rel("document", "d1", "viewer", onr("user", "alice")),
      // excluded from allowed_view
      rel("document", "d1", "banned", onr("user", "alice")),
      rel("document", "d2", "viewer", onr("user", "alice")),
      // edit = editor & viewer
      rel("document", "d2", "editor", onr("user", "alice")),
    );

    await assertEquivalent(fixture, "user", "alice", ELLIPSIS, "document", "allowed_view");
    await assertEquivalent(fixture, "user", "alice", ELLIPSIS, "document", "edit");
  });

  it("matches the live traversal for caveated membership", async () => {
    const fixture = await setup(
      CAVEAT_SCHEMA,
      rel("group", "g1", "member", onr("user", "alice")),
      caveatedRel(
        "document",
        "d1",
        "viewer",
        onr("group", "g1", "member"),
        "over_age",
        context([["min_age", 18]]),
      ),
    );

    // Without context the caveat is unresolved -> Caveated; with satisfying context -> Member. The
    // walk seeds the candidate either way; Check produces the exact membership.
    await assertEquivalent(fixture, "user", "alice", ELLIPSIS, "document", "view");
    await assertEquivalent(
      fixture,
      "user",
      "alice",
      ELLIPSIS,
      "document",
      "view",
      context([["age", 21]]),
    );
    await assertEquivalent(
      fixture,
      "user",
      "alice",
      ELLIPSIS,
      "document",
      "view",
      context([["age", 12]]),
    );
  });

  it("matches the live traversal for wildcard userset membership", async () => {
    const fixture = await setup(
      WILDCARD_SCHEMA,
      rel("group", "everyone", "member", onr("user", PUBLIC_WILDCARD)),
      rel("document", "d1", "viewer", onr("group", "everyone", "member")),
    );

    // Every user is a member of `everyone` via the wildcard edge; the walk follows the `user:*`
    // userset.
    await assertEquivalent(fixture, "user", "alice", ELLIPSIS, "document", "view");
    await assertEquivalent(fixture, "user", "alice", ELLIPSIS, "group", "member");
  });

  it("declines a shape coverage cannot flatten, falling back to the live traversal", async () => {
    const fixture = await setup(NESTED_SCHEMA);

    expect(fixture.coverage.tryGetYields("document", "nonexistent")).toBeUndefined();
  });

  it("declines an unknown target and a wildcard subject", async () => {
    const fixture = await setup(NESTED_SCHEMA, rel("group", "g1", "member", onr("user", "alice")));
    const { coverage, reader } = fixture;

    // Unknown target relation -> not covered.
    await expect(
      walkCandidates(reader, coverage, "user", "alice", ELLIPSIS, "group", "no_such"),
    ).resolves.toBeUndefined();
    // Wildcard subject -> declined (left to the live engine).
    await expect(
      walkCandidates(reader, coverage, "user", PUBLIC_WILDCARD, ELLIPSIS, "group", "member"),
    ).resolves.toBeUndefined();
    // Covered shape returns the ancestor group.
    await expect(
      walkCandidates(reader, coverage, "user", "alice", ELLIPSIS, "group", "member"),
    ).resolves.toEqual(["g1"]);
  });
});
