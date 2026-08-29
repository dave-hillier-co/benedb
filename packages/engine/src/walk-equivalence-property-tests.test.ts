import { ELLIPSIS } from "@spacedb/core/core-constants";
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
import { buildRandomAuthzWorld, SEEDS } from "./random-authz-worlds";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/WalkEquivalencePropertyTests.cs`, case for
// case and seed for seed.
//
// Gate 1 -- completeness of the Leopard membership-walk accelerator on random graphs (see
// `random-authz-worlds.ts` for the generator). For every seeded world, every covered
// (resourceType, permission/relation) target, and every subject in the alphabet: the accelerator's
// candidate set (`localClosure` + `toCoveredCandidates`, the exact production acquisition rules
// Spiceport's `Spiceport.Grains.ReverseOpsSupport.AcquireCoveredCandidates` uses -- including the
// wildcard-root seed and the reflexive self-membership rule) fed into `LookupResourcesEngine` MUST
// produce the IDENTICAL result set as the live traversal (`coveredCandidateIds: undefined`). A walk
// that silently drops a candidate is a false negative that Check confirmation alone cannot catch --
// since `LookupResourcesEngine` only ever confirms candidates the walk handed it, a missing
// candidate never reaches Check at all. This gate is what catches that failure class. A separate,
// dedicated cyclic-graph test below also asserts the walk terminates within a bounded time on a
// genuine group-membership cycle -- see its remarks for why that is hand-built rather than drawn
// from the generator (whose group/folder nesting is acyclic by construction, precisely so the other
// gates have a well-defined Check verdict to compare against).
//
// STATED LIMITS (see `random-authz-worlds.ts`): no caveats/expiration in the generated worlds;
// small fixed alphabet (5 users / 4 groups / 3 folders / 6 documents) so the query universe below
// is exhaustive, not sampled.
//
// Port decisions:
//   * xUnit's `[Theory]` + `[MemberData(nameof(Seeds))]` becomes `it.each([...SEEDS])`. `SEEDS` is
//     a `readonly number[]` rather than the C#'s `IEnumerable<object[]>` (vitest takes the values
//     directly), so it is spread into a mutable array for `it.each`'s signature.
//   * Every case passes an explicit per-test timeout, which the C# had no analogue for (xUnit does
//     not time-bound a fact by default). It is not there for headroom -- a case runs in
//     milliseconds -- but so the INNER five-second walk race below can actually fire: under
//     vitest's 5s default the suite's own timeout would win first and report "test timed out"
//     instead of naming the subject whose walk failed to terminate.
//   * `Assert.True(a.SetEquals(b), message)` becomes a sorted-array `expect(...).toEqual(...)` on
//     the canonical `id:membership` strings, so a divergence prints the two sets rather than just
//     "expected true". The C#'s hand-built failure message is what that assertion's diff already
//     shows, so it is not reproduced verbatim; the candidate set, which the diff does NOT show, is
//     still spelled out in the assertion's message.

/** The (resourceType, permission) targets walked for every `user` subject in the alphabet. */
interface Target {
  readonly resourceType: string;
  readonly permission: string;
}

const SUBJECT_TARGETS: readonly Target[] = [
  { resourceType: "document", permission: "view" },
  { resourceType: "document", permission: "view_mono" },
  { resourceType: "document", permission: "viewer" },
  { resourceType: "folder", permission: "view" },
  { resourceType: "folder", permission: "viewer" },
  { resourceType: "group", permission: "member" },
];

const GROUP_SUBJECT_TARGETS: readonly Target[] = [
  { resourceType: "group", permission: "member" },
  { resourceType: "document", permission: "view" },
  { resourceType: "folder", permission: "view" },
];

/** Must exceed the inner five-second walk race, so that race is the assertion that reports. */
const CASE_TIMEOUT_MS = 30_000;

describe("WalkEquivalencePropertyTests", () => {
  it.each([...SEEDS])(
    "seed %i: walk candidates equal the live traversal across the world",
    async (seed) => {
      const world = buildRandomAuthzWorld(seed);
      const compiled = compileSchema(world.schemaText);
      const engine = new LookupResourcesEngine(compiled.namespaces, compiled.caveats);
      const coverage = buildMembershipCoverage(compiled.namespaces);

      const reader = await write(world.relationships);

      for (const target of SUBJECT_TARGETS) {
        for (const userId of world.users) {
          await assertWalkEqualsLive(
            engine,
            coverage,
            reader,
            "user",
            userId,
            ELLIPSIS,
            target,
            seed,
          );
        }
      }

      // A group can itself be walked as a subject (it may itself hold group#member on an ancestor
      // group), exercising the nested-group closure directly rather than only through a leaf user.
      for (const groupId of world.groups) {
        for (const target of GROUP_SUBJECT_TARGETS) {
          await assertWalkEqualsLive(
            engine,
            coverage,
            reader,
            "group",
            groupId,
            "member",
            target,
            seed,
          );
        }
      }
    },
    CASE_TIMEOUT_MS,
  );

  /**
   * Dedicated cyclic-graph termination check: the generator keeps group/folder nesting acyclic by
   * construction (see its remarks) so `CheckEngine` -- which has no cycle-cut on the verdict path
   * -- never throws on the worlds the other gates exercise. That leaves the walk's OWN cycle
   * handling untested by this file's main gate, so this test builds a minimal, genuine 2-group
   * membership cycle directly and
   * walks INTO it from one of the cyclic nodes. It queries the base `member` relation only (no
   * intersection/exclusion/arrow), so no Check confirmation is involved anywhere in this test --
   * only `localClosure`'s own visited-set cycle-cut is exercised.
   *
   * The C# remarks claim the cycle is built from ids that vary per seed. They do not: the group
   * alphabet is seed-independent (`range("g", 4)`), so `g0`/`g1` are the same on every row. What
   * genuinely varies is the compiled schema, and so the coverage, since `templateIndex` does --
   * six distinct configurations across the seed set. The seeds are kept, and the claim corrected.
   */
  it.each([...SEEDS])(
    "seed %i: the walk terminates on a genuine group-membership cycle",
    async (seed) => {
      const world = buildRandomAuthzWorld(seed);
      const compiled = compileSchema(world.schemaText);
      const coverage = buildMembershipCoverage(compiled.namespaces);

      const g0 = at(world.groups, 0);
      const g1 = at(world.groups, 1);
      const cycle: readonly Relationship[] = [
        createRelationship(
          { objectType: "group", objectId: g0, relation: "member" },
          { objectType: "group", objectId: g1, relation: "member" },
        ),
        createRelationship(
          { objectType: "group", objectId: g1, relation: "member" },
          { objectType: "group", objectId: g0, relation: "member" },
        ),
      ];

      const reader = await write(cycle);

      // `await`ing the raced walk propagates any exception -- that would itself be a gate failure,
      // exactly as the C#'s trailing `await walkTask` does.
      await withinFiveSeconds(
        localClosure(reader, coverage, { type: "group", id: g0, relation: "member" }),
        `seed=${seed}: membership walk did not terminate within 5s on a genuine cycle between ` +
          `group:${g0}#member and group:${g1}#member`,
      );
    },
    CASE_TIMEOUT_MS,
  );
});

async function assertWalkEqualsLive(
  engine: LookupResourcesEngine,
  coverage: MembershipCoverage,
  reader: IDatastoreReader,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
  target: Target,
  seed: number,
): Promise<void> {
  const { resourceType, permission } = target;

  const live = await collect(
    engine.lookupResourcesWithCandidates(
      reader,
      subjectType,
      subjectId,
      subjectRelation,
      resourceType,
      permission,
      undefined,
    ),
  );

  let candidates: readonly string[] | undefined;
  const yields = coverage.tryGetYields(resourceType, permission);
  if (yields !== undefined) {
    const nodes = await withinFiveSeconds(
      localClosure(reader, coverage, {
        type: subjectType,
        id: subjectId,
        relation: subjectRelation,
      }),
      `seed=${seed}: membership walk did not terminate within 5s for subject ` +
        `${subjectType}:${subjectId}#${subjectRelation} -> ${resourceType}/${permission}`,
    );
    candidates = toCoveredCandidates(nodes, yields, resourceType, subjectType, subjectId);
  }

  const walked = await collect(
    engine.lookupResourcesWithCandidates(
      reader,
      subjectType,
      subjectId,
      subjectRelation,
      resourceType,
      permission,
      candidates,
    ),
  );

  // Compare as a SET, not a list: the live (uncandidated) traversal deliberately emits one result
  // per REACHABILITY ENTRYPOINT with no global dedup (see LookupResourcesEngine's remarks on why --
  // it is what makes a paged enumeration equal the unpaged one), so a resource reachable via
  // several group memberships can legitimately appear more than once on the live side, while the
  // candidate-driven path confirms each unique candidate id exactly once. Neither multiplicity is
  // wrong; the completeness property this gate checks is over the (resourceId, membership) SET,
  // matching the gate's contract ("identical (resourceId, membership-collapsed) result set").
  const message =
    `seed=${seed}: walk-fed and live lookupResources diverged for subject ` +
    `${subjectType}:${subjectId}#${subjectRelation} -> ${resourceType}/${permission}. ` +
    `candidates=[${candidates === undefined ? "n/a" : candidates.join(",")}]`;
  expect(distinctSorted(walked), message).toEqual(distinctSorted(live));
}

/** The world's relationships written as one Touch transaction, read back at that revision. */
async function write(relationships: readonly Relationship[]): Promise<IDatastoreReader> {
  const store = new ReferenceDatastore();
  const rev = await store.readWriteTx(async (tx) => {
    const updates: RelationshipUpdate[] = relationships.map((relationship) => ({
      relationship,
      operation: "touch",
    }));
    await tx.writeRelationships(updates);
  });
  return store.snapshotReader(rev);
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
  // `list.Sort((a, b) => string.CompareOrdinal(...))`. `Array.prototype.sort`'s default comparator
  // is UTF-16 ordinal, matching `CompareOrdinal`; `localeCompare` would not.
  return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The C#'s `ToHashSet()` on `(string Id, Membership M)` value tuples, whose structural equality is
 * what makes `SetEquals` meaningful. A JS `Set` of objects is keyed by reference, so the pair is
 * collapsed to one canonical string and the result re-sorted for a stable, diffable comparison.
 */
function distinctSorted(outcomes: readonly Outcome[]): readonly string[] {
  return [...new Set(outcomes.map((o) => `${o.id}:${o.membership}`))].sort();
}

/**
 * Races a walk against a timer, standing in for the C#'s `Task.WhenAny(task, Task.Delay(5s))` +
 * `Assert.True(completed == walkTask, message)`. A walk that loops forever must FAIL the assertion
 * rather than hang the suite until vitest's own timeout.
 *
 * LIMIT, stated because it is not the C#'s: a runaway walk over the in-memory reference datastore
 * spins on the MICROtask queue, which starves the timer this races against, so this catches a slow
 * walk rather than a truly non-yielding one. The per-case timeout above is the backstop for that.
 */
async function withinFiveSeconds<T>(work: Promise<T>, message: string): Promise<T> {
  const timeout = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = new Promise<typeof timeout>((resolve) => {
    timer = setTimeout(() => resolve(timeout), 5000);
  });
  try {
    const winner = await Promise.race([work, delay]);
    expect(winner, message).not.toBe(timeout);
    return (await work) as T;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `noUncheckedIndexedAccess` makes every index yield `T | undefined`, where the C# indexer threw. */
function at(items: readonly string[], index: number): string {
  const item = items[index];
  if (item === undefined) throw new Error(`alphabet index ${index} out of range (${items.length})`);
  return item;
}
