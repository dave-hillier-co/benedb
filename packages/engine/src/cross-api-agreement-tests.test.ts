import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import type { IDatastoreReader } from "@benedb/datastore/i-datastore";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import { compileSchema } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { CheckEngine } from "./check-engine";
import type { FoundResource } from "./found-resource";
import type { FoundSubject } from "./found-subject";
import { LookupResourcesEngine } from "./lookup-resources-engine";
import { LookupSubjectsEngine } from "./lookup-subjects-engine";
import { buildRandomAuthzWorld, SEEDS, type RandomAuthzWorld } from "./random-authz-worlds";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/CrossApiAgreementTests.cs`, case for case.
//
// Gate 3 -- cross-API agreement. `CheckEngine`, `LookupResourcesEngine` and `LookupSubjectsEngine`
// are three different traversal entry points over the same schema/relationship semantics, so for
// any world they must agree with each other BY DEFINITION of Zanzibar semantics -- no external
// truth is needed, which makes this gate independent of (and complementary to) the SpiceDB
// conformance corpus. That independence is what makes it the gate most likely to catch drift
// between engines ported in separate batches.
//
//   (a) Check <-> LookupResources: for every (subject, resourceType, permission), a resource is in
//       `lookupResources(subject, ...)` iff `check(resource, permission, subject)` is `"member"`.
//   (b) Check <-> LookupSubjects: for every (resource, permission), a concrete user is effectively
//       a member of `lookupSubjects(resource, permission, "user")` iff Check is `"member"`.
//       Wildcards are minded explicitly, not ignored: when a wildcard `FoundSubject` is yielded,
//       every user in the (closed) alphabet is covered by it EXCEPT those named in its
//       `excludedSubjects`, so the concrete-id set is expanded against the alphabet before the iff
//       is checked. This is exact (not an approximation) precisely because the alphabet the
//       generator draws relationships from is the same closed alphabet Check evaluates against.
//
// STATED LIMITS (see `random-authz-worlds.ts`): no caveats/expiration, so every membership in
// these worlds is exactly `"member"` or `"notMember"` -- no caveated collapse ambiguity to
// reconcile.
//
// Port notes:
//   * xUnit's `[Theory]`/`[MemberData(nameof(Seeds))]` becomes `it.each(SEEDS)` with a `%i`
//     placeholder in the title, so a failing row names its seed. `it.for` (the guide's row for
//     `[MemberData]`) is for a COMPUTED, possibly-empty row set that needs a `TestContext`; `SEEDS`
//     is a fixed 24-row constant and neither case body takes a context.
//   * `Assert.True(condition, message)` becomes the local `assertTrue`, per the guide's note that a
//     property-style suite asserting thousands of times inside nested loops must not lose the
//     interpolated message -- it is the only thing that says WHICH tuple failed.
//   * The two `Collect` overloads (C# resolves them by `IAsyncEnumerable<T>` argument type) become
//     two distinctly named functions, `collectResources` and `collectSubjects`.

/** The (resourceType, permission) query points every world is interrogated at. */
const TARGETS: readonly (readonly [resourceType: string, permission: string])[] = [
  ["document", "view"],
  ["document", "view_mono"],
  ["folder", "view"],
  ["group", "member"],
];

describe("cross-API agreement", () => {
  it.each(SEEDS)("Check agrees with LookupResources (seed %i)", async (seed) => {
    const world = buildRandomAuthzWorld(seed);
    const compiled = compileSchema(world.schemaText);
    const check = new CheckEngine(compiled.namespaces, compiled.caveats);
    const lookupResources = new LookupResourcesEngine(compiled.namespaces, compiled.caveats);

    const reader = await load(world);
    const resourceIdsByType = resourceIdsByTypeOf(world);

    for (const [resourceType, permission] of TARGETS) {
      const resourceIds = idsFor(resourceIdsByType, resourceType);
      for (const userId of world.users) {
        const found = await collectResources(
          lookupResources.lookupResources(
            reader,
            "user",
            userId,
            ELLIPSIS,
            resourceType,
            permission,
          ),
        );
        const foundIds = new Set(found.map((f) => f.resourceId));

        for (const resourceId of resourceIds) {
          const { verdict } = await check.check(
            reader,
            resourceType,
            resourceId,
            permission,
            onr("user", userId),
          );
          assertTrue(
            (verdict === "member") === foundIds.has(resourceId),
            `seed=${seed}: Check/LookupResources disagree on ${resourceType}:${resourceId}/${permission} ` +
              `for user:${userId} (Check=${verdict}, inLookupResources=${foundIds.has(resourceId)})`,
          );
        }
      }
    }
  });

  it.each(SEEDS)("Check agrees with LookupSubjects (seed %i)", async (seed) => {
    const world = buildRandomAuthzWorld(seed);
    const compiled = compileSchema(world.schemaText);
    const check = new CheckEngine(compiled.namespaces, compiled.caveats);
    const lookupSubjects = new LookupSubjectsEngine(compiled.namespaces);

    const reader = await load(world);
    const resourceIdsByType = resourceIdsByTypeOf(world);

    for (const [resourceType, permission] of TARGETS) {
      for (const resourceId of idsFor(resourceIdsByType, resourceType)) {
        const found = await collectSubjects(
          lookupSubjects.lookupSubjects(reader, onr(resourceType, resourceId, permission), "user"),
        );

        const concrete = new Set<string>();
        let sawWildcard = false;
        const excluded = new Set<string>();
        for (const f of found) {
          if (!f.isWildcard) {
            concrete.add(f.subjectId);
            continue;
          }
          sawWildcard = true;
          // `f.ExcludedSubjects ?? []`: `FoundSubject` deliberately keeps absent and empty
          // DISTINCT in the port, so the coalesce is still load-bearing here.
          for (const ex of f.excludedSubjects ?? []) excluded.add(ex.subjectId);
        }

        for (const userId of world.users) {
          const inLookup = concrete.has(userId) || (sawWildcard && !excluded.has(userId));
          const { verdict } = await check.check(
            reader,
            resourceType,
            resourceId,
            permission,
            onr("user", userId),
          );
          assertTrue(
            (verdict === "member") === inLookup,
            `seed=${seed}: Check/LookupSubjects disagree on ${resourceType}:${resourceId}/${permission} ` +
              `for user:${userId} (Check=${verdict}, inLookupSubjects=${inLookup}, sawWildcard=${sawWildcard})`,
          );
        }
      }
    }
  });
});

/** `Assert.True(condition, message)`: vitest takes the message as `expect`'s SECOND argument. */
function assertTrue(condition: boolean, message: string): void {
  expect(condition, message).toBe(true);
}

/** Writes the world's relationships and returns a reader pinned to the resulting revision. */
async function load(world: RandomAuthzWorld): Promise<IDatastoreReader> {
  const store = new ReferenceDatastore();
  const rev = await store.readWriteTx(async (tx) => {
    const updates: RelationshipUpdate[] = world.relationships.map((relationship) => ({
      relationship,
      operation: "touch",
    }));
    await tx.writeRelationships(updates);
  });
  return store.snapshotReader(rev);
}

/** The C#'s `ResourceIdsByType`. */
function resourceIdsByTypeOf(world: RandomAuthzWorld): ReadonlyMap<string, readonly string[]> {
  return new Map<string, readonly string[]>([
    ["document", world.documents],
    ["folder", world.folders],
    ["group", world.groups],
  ]);
}

/**
 * `dict[key]`. The C# `Dictionary` indexer THROWS on a missing key where `Map.get` returns
 * `undefined`, so the throw is reproduced rather than letting a typo silently enumerate nothing.
 */
function idsFor(
  resourceIdsByType: ReadonlyMap<string, readonly string[]>,
  resourceType: string,
): readonly string[] {
  const ids = resourceIdsByType.get(resourceType);
  if (ids === undefined) throw new Error(`no alphabet for resource type ${resourceType}`);
  return ids;
}

async function collectResources(
  e: AsyncIterable<FoundResource>,
): Promise<readonly FoundResource[]> {
  const list: FoundResource[] = [];
  for await (const f of e) list.push(f);
  return list;
}

async function collectSubjects(e: AsyncIterable<FoundSubject>): Promise<readonly FoundSubject[]> {
  const list: FoundSubject[] = [];
  for await (const f of e) list.push(f);
  return list;
}

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}
