import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import type { IDatastoreReader } from "@benedb/datastore/i-datastore";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import { compile } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { buildMembershipCoverage, type MembershipCoverage } from "./membership-coverage";
import {
  directParents,
  localClosure,
  subjectKeyToString,
  toCoveredCandidates,
  type ResourceNode,
  type SubjectKey,
} from "./membership-walk";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/MembershipWalkTests.cs`, case for case.
//
// Unit gates for the Leopard walk's one-step primitive (`DirectParents`) and its in-process driver
// (`LocalClosure`): scan-set / subject filtering, wildcard seeding, the reflexive rule, and -
// critically - completeness and TERMINATION over a genuine DATA cycle (group a member of b, b
// member of a). The cycle case is this file's real gate.
//
// Port decisions for the surface under test:
//   * `public static class MembershipWalk` is a namespace, not a value: it becomes module-level
//     exported functions with no namespace object and no barrel.
//   * The two nested `readonly record struct`s become plain interfaces. `SubjectKey` OVERRIDES
//     `ToString()` to `type:id#relation` and THAT STRING IS the visited-set key in `LocalClosure`,
//     so it is exported as the named {@link subjectKeyToString} rather than being left to
//     TypeScript's default stringification.
//   * `subject with { Id = PublicWildcard }` seeds the second walk root -> an object spread.
//   * `DirectParents` returns a list that DELIBERATELY CONTAINS DUPLICATES; dedup happens only in
//     `toCoveredCandidates`.
//   * `SortedSet<string>(StringComparer.Ordinal)` in `ToCoveredCandidates` -> a `Set` plus
//     `[...set].sort()`. The default `Array.prototype.sort` comparator is UTF-16 ordinal, which
//     matches `StringComparer.Ordinal` exactly; `localeCompare` would reorder the ids the caller
//     pages through and must never appear.
//   * The reflexive rule adds `subjectId` whenever `subjectType === resourceType`, UNCONDITIONALLY.
//     That is deliberate over-inclusion which Check resolves - do not guard it.
//   * `DirectParents` re-checks `rel.Subject.Relation != subject.Relation` EXACTLY, because
//     `SubjectRelationFilter`'s ellipsis branch does not itself exclude non-ellipsis rows. The
//     datastore filter alone is not sufficient; the belt-and-braces check stays.
//   * Caveats are IGNORED entirely here (a candidate is confirmed by Check, which resolves the
//     caveat) and expiration is filtered by the datastore reader, so neither needs handling.
//   * `CancellationToken cancellationToken = default` -> a trailing `signal?: AbortSignal`, kept in
//     the C#'s positional slot and forwarded to the reader.

const NESTED_SCHEMA = `
definition user {}

definition group {
    relation member: user | group#member
}

definition document {
    relation viewer: user | group#member
    relation editor: user
    permission view = viewer + editor
}
`;

const WILDCARD_SCHEMA = `
definition user {}

definition group {
    relation member: user:* | user | group#member
}
`;

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

function rel(rt: string, rid: string, relation: string, subject: ObjectAndRelation): Relationship {
  return createRelationship(onr(rt, rid, relation), subject);
}

function subjectKey(type: string, id: string, relation: string): SubjectKey {
  return { type, id, relation };
}

async function setup(
  schemaText: string,
  ...rels: readonly Relationship[]
): Promise<{ coverage: MembershipCoverage; reader: IDatastoreReader }> {
  const coverage = buildMembershipCoverage(compile(schemaText));

  const store = new ReferenceDatastore();
  const rev = await store.readWriteTx(async (tx) => {
    const updates: RelationshipUpdate[] = rels.map((r) => ({
      relationship: r,
      operation: "create",
    }));
    await tx.writeRelationships(updates);
  });
  const reader = store.snapshotReader(rev);

  return { coverage, reader };
}

/**
 * Races a walk against a timer, standing in for the C#'s
 * `Task.WhenAny(task, Task.Delay(5s))` + `Assert.Same(task, completed)`. A walk that loops forever
 * must FAIL the assertion rather than hang the suite until vitest's own timeout.
 */
async function withinFiveSeconds<T>(work: Promise<T>): Promise<T> {
  const timeout = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = new Promise<typeof timeout>((resolve) => {
    timer = setTimeout(() => resolve(timeout), 5000);
  });
  try {
    const winner = await Promise.race([work, delay]);
    expect(winner).not.toBe(timeout);
    return (await work) as T;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe("subjectKeyToString", () => {
  it("is the canonical type:id#relation form used as the visited-set key", () => {
    // The visited set is keyed by this exact string, so its shape is load-bearing rather than
    // cosmetic: a change here changes which walks terminate.
    expect(subjectKeyToString(subjectKey("user", "alice", ELLIPSIS))).toBe("user:alice#...");
    expect(subjectKeyToString(subjectKey("group", "g1", "member"))).toBe("group:g1#member");
    expect(subjectKeyToString(subjectKey("user", PUBLIC_WILDCARD, ELLIPSIS))).toBe("user:*#...");
  });
});

describe("MembershipWalk.directParents", () => {
  it("returns only scan-set relations", async () => {
    const { coverage, reader } = await setup(
      NESTED_SCHEMA,
      rel("group", "g1", "member", onr("user", "alice")),
      // "editor" is a scanned relation too (it is one of `view`'s yields).
      rel("document", "d1", "editor", onr("user", "alice")),
    );

    const parents = await directParents(reader, coverage, subjectKey("user", "alice", ELLIPSIS));

    expect(parents).toContainEqual({ type: "group", id: "g1", relation: "member" });
    expect(parents).toContainEqual({ type: "document", id: "d1", relation: "editor" });
  });

  it("filters by subject relation on an exact match", async () => {
    // alice is both a direct user AND (via a different row) a userset subject id coincidentally
    // shaped like a group's own relation - directParents must key strictly on (type, id, relation).
    const { coverage, reader } = await setup(
      NESTED_SCHEMA,
      rel("group", "g1", "member", onr("user", "alice", ELLIPSIS)),
      rel("group", "g2", "member", onr("group", "alice", "member")),
    );

    const asUser = await directParents(reader, coverage, subjectKey("user", "alice", ELLIPSIS));
    expect(asUser).toHaveLength(1);
    expect(asUser[0]?.id).toBe("g1");

    const asGroupMember = await directParents(
      reader,
      coverage,
      subjectKey("group", "alice", "member"),
    );
    expect(asGroupMember).toHaveLength(1);
    expect(asGroupMember[0]?.id).toBe("g2");
  });
});

describe("MembershipWalk.localClosure", () => {
  it("follows a wildcard userset edge", async () => {
    const { coverage, reader } = await setup(
      WILDCARD_SCHEMA,
      rel("group", "everyone", "member", onr("user", PUBLIC_WILDCARD)),
    );

    const nodes = await localClosure(reader, coverage, subjectKey("user", "alice", ELLIPSIS));

    expect(nodes).toContainEqual({ type: "group", id: "everyone", relation: "member" });
  });

  it("leaves the reflexive self-membership rule to the caller", async () => {
    // localClosure itself walks edges only; the reflexive self-membership candidate is added by
    // toCoveredCandidates (mirrored by the grain-mesh acquisition path), not by the walk itself.
    // Assert the composed contract here.
    const { coverage, reader } = await setup(NESTED_SCHEMA);
    const yields = coverage.tryGetYields("group", "member");
    expect(yields).toBeDefined();

    const nodes = await localClosure(reader, coverage, subjectKey("group", "g1", "member"));
    const candidates = toCoveredCandidates(nodes, yields ?? new Set(), "group", "group", "g1");

    // Reflexive: a group#member userset is a member of itself.
    expect(candidates).toContain("g1");
  });

  it("terminates and stays complete over a data cycle", async () => {
    // group a member of b, b member of a: a genuine cycle in the stored data.
    const { coverage, reader } = await setup(
      NESTED_SCHEMA,
      rel("group", "a", "member", onr("group", "b", "member")),
      rel("group", "b", "member", onr("group", "a", "member")),
      rel("document", "d1", "viewer", onr("group", "a", "member")),
    );

    // Terminates rather than looping forever.
    const nodes = await withinFiveSeconds(
      localClosure(reader, coverage, subjectKey("group", "a", "member")),
    );

    // Complete: both directions of the cycle are captured, and the reachable document is found too.
    expect(nodes).toContainEqual({ type: "group", id: "a", relation: "member" });
    expect(nodes).toContainEqual({ type: "group", id: "b", relation: "member" });
    expect(nodes).toContainEqual({ type: "document", id: "d1", relation: "viewer" });
  });

  it("returns empty when the subject has no parents", async () => {
    const { coverage, reader } = await setup(NESTED_SCHEMA);

    const nodes = await localClosure(reader, coverage, subjectKey("user", "nobody", ELLIPSIS));

    expect(nodes).toEqual([]);
  });
});

describe("MembershipWalk.toCoveredCandidates", () => {
  it("filters by type and yield relation, returning sorted distinct ids", () => {
    const nodes: readonly ResourceNode[] = [
      { type: "document", id: "d2", relation: "viewer" },
      { type: "document", id: "d1", relation: "viewer" },
      // duplicate
      { type: "document", id: "d1", relation: "viewer" },
      // not a yield relation
      { type: "document", id: "d3", relation: "editor" },
      // wrong type
      { type: "group", id: "g1", relation: "member" },
    ];
    const yields: ReadonlySet<string> = new Set(["viewer"]);

    const result = toCoveredCandidates(nodes, yields, "document", "user", "alice");

    expect(result).toEqual(["d1", "d2"]);
  });

  it("sorts ordinally, not by locale", () => {
    // `SortedSet<string>(StringComparer.Ordinal)`. Uppercase sorts BEFORE lowercase in UTF-16
    // ordinal order and AFTER it under most locales; this ordering is what the caller pages
    // through, so a locale-aware comparator would silently corrupt resumption.
    const nodes: readonly ResourceNode[] = [
      { type: "document", id: "b", relation: "viewer" },
      { type: "document", id: "B", relation: "viewer" },
      { type: "document", id: "a", relation: "viewer" },
      { type: "document", id: "A", relation: "viewer" },
    ];

    const result = toCoveredCandidates(nodes, new Set(["viewer"]), "document", "user", "alice");

    expect(result).toEqual(["A", "B", "a", "b"]);
  });

  it("adds the reflexive candidate unconditionally when the subject and resource types match", () => {
    // Deliberate over-inclusion: the subject id is added even with no walked node backing it.
    // Check resolves it, and a guard here would turn safe over-inclusion into a false negative.
    const result = toCoveredCandidates([], new Set(["member"]), "group", "group", "g1");

    expect(result).toEqual(["g1"]);
  });

  it("returns empty when nothing matches and the types differ", () => {
    const nodes: readonly ResourceNode[] = [{ type: "group", id: "g1", relation: "member" }];

    const result = toCoveredCandidates(nodes, new Set(["viewer"]), "document", "user", "alice");

    expect(result).toEqual([]);
  });

  // Not from the C# case list: pins the two `ArgumentNullException.ThrowIfNull` guards the port
  // keeps even though the TypeScript types are non-optional, because the grain-layer caller is
  // untyped.
  it("rejects an absent node list or yield-relation set", () => {
    expect(() =>
      toCoveredCandidates(
        undefined as unknown as Iterable<ResourceNode>,
        new Set(["member"]),
        "group",
        "user",
        "alice",
      ),
    ).toThrow(InvalidArgumentError);
    expect(() =>
      toCoveredCandidates(
        [],
        undefined as unknown as ReadonlySet<string>,
        "group",
        "user",
        "alice",
      ),
    ).toThrow(InvalidArgumentError);
  });
});
