import type { ContextualizedCaveat } from "@spacedb/core/contextualized-caveat";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import type { IDatastoreReader } from "@spacedb/datastore/i-datastore";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { CheckEngine } from "./check-engine";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/CaveatCompletenessTests.cs`, case for case.
//
// Locks in the caveat-completeness guarantee that is the in-architecture equivalent of SpiceDB's
// batched `ResultsSetting` / `REQUIRE_ALL_RESULTS` mechanism (issue #3, finding 5).
//
// SpiceDB dispatches a BATCH of resource ids with an "allow single result" optimization that can
// short-circuit across resources; it forces `REQUIRE_ALL_RESULTS` whenever an incoming relationship
// is caveated, so that every caveat is gathered into the final expression
// (`internal/graph/check.go:482-512`). The port instead models one (resource, subject) per dispatch
// and only ever short-circuits a union/arrow on a DEFINITE, UNCAVEATED member - never on a caveated
// one. Because `caveatExpr OR definitely-true` collapses to true, dropping a caveat at that point
// cannot change a verdict, while every UNDETERMINED branch is accumulated.
//
// This is the regression gate on `LocalDispatcher`: every union and arrow accumulation must
// short-circuit only on `acc.member && acc.caveat === undefined`, never on `acc.member`. A port that
// adds an "any member found" early return passes CheckEngineTests and fails here.
//
// Filed under CheckEngine's constructor in the ledger, but it is a LocalDispatcher test: it is in
// this batch because the two files are one unit.

const SCHEMA = `
caveat over_age(age int, min_age int) {
  age >= min_age
}

caveat ip_allowlist(user_ip ipaddress, cidr string) {
  user_ip.in_cidr(cidr)
}

definition user {}

definition group {
  relation member: user with over_age
  relation guest: user with ip_allowlist
  permission access = member + guest
}

definition document {
  relation viewer: user with over_age
  relation ip_viewer: user with ip_allowlist
  relation editor: user
  relation team: group

  // Two caveated branches: a complete check must gather BOTH caveats.
  permission union_caveats = viewer + ip_viewer
  // A caveated branch unioned with a definite (uncaveated) branch: the definite member wins.
  permission caveat_or_definite = viewer + editor
  // Arrow into a nested union of two caveated branches.
  permission via_team = team->access
}
`;

function buildEngine(): CheckEngine {
  const compiled = compileSchema(SCHEMA);
  return new CheckEngine(compiled.namespaces, compiled.caveats);
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

function context(entries: readonly [string, unknown][]): ReadonlyMap<string, unknown> {
  return new Map(entries);
}

function plain(
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
  ctx: ReadonlyMap<string, unknown>,
): Relationship {
  const caveat: ContextualizedCaveat = { caveatName, context: ctx };
  return createRelationship(onr(resType, resId, resRel), subject, caveat);
}

describe("caveat completeness", () => {
  it("gathers every caveat from a union of two caveated branches", async () => {
    // alice is a caveated viewer (over_age) AND a caveated ip_viewer (ip_allowlist). With no request
    // context both caveats are undetermined, so the union must be Caveated and surface BOTH missing
    // fields. A short-circuit that returned after the first caveated branch would drop "user_ip".
    const reader = await seed(
      caveated(
        "document",
        "doc1",
        "viewer",
        onr("user", "alice"),
        "over_age",
        context([["min_age", 18]]),
      ),
      caveated(
        "document",
        "doc1",
        "ip_viewer",
        onr("user", "alice"),
        "ip_allowlist",
        context([["cidr", "10.0.0.0/8"]]),
      ),
    );
    const engine = buildEngine();

    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "union_caveats",
      onr("user", "alice"),
    );

    expect(result.verdict).toBe("caveated");
    expect(result.missingExprFields).toContain("age");
    expect(result.missingExprFields).toContain("user_ip");
  });

  it("collapses a union of two caveated branches to a member when one is satisfied", async () => {
    // Same shape, but request context satisfies the over_age branch (age 21 >= 18). The union is
    // then definitely true regardless of the ip_allowlist branch, so the result is a plain Member:
    // the engine accumulated the caveat, then collapsed it with context.
    const reader = await seed(
      caveated(
        "document",
        "doc1",
        "viewer",
        onr("user", "alice"),
        "over_age",
        context([["min_age", 18]]),
      ),
      caveated(
        "document",
        "doc1",
        "ip_viewer",
        onr("user", "alice"),
        "ip_allowlist",
        context([["cidr", "10.0.0.0/8"]]),
      ),
    );
    const engine = buildEngine();

    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "union_caveats",
      onr("user", "alice"),
      context([["age", 21]]),
    );

    expect(result.verdict).toBe("member");
  });

  it("is a definite member for a caveated branch unioned with a definite branch", async () => {
    // alice is a caveated viewer (over_age, no context) AND a plain editor. The editor branch is a
    // definite member, so the union short-circuits to Member. Dropping the viewer caveat here is
    // sound because `caveatExpr OR definitely-true == true`; the verdict is Member, not Caveated.
    const reader = await seed(
      caveated(
        "document",
        "doc1",
        "viewer",
        onr("user", "alice"),
        "over_age",
        context([["min_age", 18]]),
      ),
      plain("document", "doc1", "editor", onr("user", "alice")),
    );
    const engine = buildEngine();

    // No "age" supplied: were the viewer caveat NOT dropped, this would be Caveated.
    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "caveat_or_definite",
      onr("user", "alice"),
    );

    expect(result.verdict).toBe("member");
    expect(result.missingExprFields).toEqual([]);
  });

  it("gathers caveats from every target of an arrow into a nested union", async () => {
    // alice reaches `document:doc1#via_team` through `team->access`, where access = member + guest
    // on group:g1, and alice holds both a caveated member (over_age) and a caveated guest
    // (ip_allowlist). The arrow sub-dispatch must gather BOTH caveats: an "any member found"
    // short-circuit across the nested union would drop one.
    const reader = await seed(
      plain("document", "doc1", "team", onr("group", "g1")),
      caveated(
        "group",
        "g1",
        "member",
        onr("user", "alice"),
        "over_age",
        context([["min_age", 18]]),
      ),
      caveated(
        "group",
        "g1",
        "guest",
        onr("user", "alice"),
        "ip_allowlist",
        context([["cidr", "10.0.0.0/8"]]),
      ),
    );
    const engine = buildEngine();

    const result = await engine.check(reader, "document", "doc1", "via_team", onr("user", "alice"));

    expect(result.verdict).toBe("caveated");
    expect(result.missingExprFields).toContain("age");
    expect(result.missingExprFields).toContain("user_ip");
  });
});
