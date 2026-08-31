import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { formatRelationship } from "@benedb/core/tuple-strings";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import { compileSchema } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { CheckEngine } from "./check-engine";
import type { Membership } from "./membership";
import {
  buildRandomAuthzWorld,
  randomRelationship,
  SEEDS,
  type RandomAuthzWorld,
} from "./random-authz-worlds";
import { createSeededRandom } from "./seeded-random";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/MetamorphicInvariantTests.cs`, case for case.
//
// Gate 2 -- metamorphic invariants that must hold for ANY world `random-authz-worlds` can
// produce, checked purely against `CheckEngine` (no accelerator involved) so these are
// engine-semantics gates, not accelerator-completeness gates:
//
//   (a) IRRELEVANT-TUPLE INVARIANCE: writing a relationship on a brand-new, otherwise-unreferenced
//       resource id never changes any previously computed Check verdict at the new revision. This
//       holds for EVERY schema shape (union/intersection/exclusion/arrow) because the new row
//       cannot participate in any existing resource's evaluation -- documents never appear as a
//       subject anywhere in the generated schema, so a fresh document-typed row is provably inert.
//   (b) DELETE MONOTONICITY: deleting one relationship never turns a notMember verdict into a
//       member verdict.
//   (c) ADD MONOTONICITY: adding one (possibly already-present) relationship never turns a member
//       verdict into a notMember verdict.
//
// (b) and (c) only hold for permissions built purely from union (and arrows over union-only
// permissions) -- removing or adding evidence for an intersection or exclusion operand can flip a
// verdict in EITHER direction, so those two gates are deliberately checked against
// `document.view_mono` (fixed by `random-authz-worlds` as `viewer + editor + parent->view`, with
// `folder.view = viewer + parent->view`) which is union/arrow-only on EVERY seed, independent of
// which template the seed drew for the (possibly non-monotone) `document.view`. (a) has no such
// restriction and is checked against `document.view` (the seed's varying template) for broader
// shape coverage.
//
// STATED LIMITS (see `random-authz-worlds.ts`): no caveats/expiration, so every verdict is exactly
// `member` or `notMember`; a capped sample of query points per seed keeps the whole file fast.
//
// Port notes for this file:
//   * `[Theory]` + `[MemberData(nameof(Seeds))]` becomes `it.each(SEEDS)` with a `%i` placeholder;
//     the C#'s `object[]` wrapper exists only for xUnit and has no counterpart here.
//   * The derived generators keep the C#'s exact seed arithmetic (`seed * 7919 + 1`,
//     `seed * 104729 + 1`, `seed * 31 + 17`) so each gate still draws INDEPENDENTLY of the world's
//     own generator. The number SEQUENCE differs from .NET's -- see `seeded-random.ts` -- so the
//     specific tuple drawn for a seed differs; what ports is that the draw is derived,
//     deterministic and independent, which is the whole of what the arithmetic bought the C#.
//   * The C# keys `before` by a `(string DocId, string UserId)` VALUE TUPLE, which has structural
//     equality as a dictionary key. TypeScript objects do not, so the sample carries the pair and
//     the map is keyed by the formatted pair string.

/**
 * The number of (document, user) query points sampled per seed. The C#'s `SampleCap` -- a cap, not
 * a target: the full universe is 6 documents x 5 users = 30 points, so 8 is always reachable.
 */
const SAMPLE_CAP = 8;

/** One sampled query point: check `document:docId#<permission>@user:userId`. */
interface QueryPoint {
  readonly docId: string;
  readonly userId: string;
}

describe("metamorphic invariants", () => {
  it.each(SEEDS)("seed %i: an irrelevant tuple does not change any verdict", async (seed) => {
    const world = buildRandomAuthzWorld(seed);
    const compiled = compileSchema(world.schemaText);
    const check = new CheckEngine(compiled.namespaces, compiled.caveats);

    const store = new ReferenceDatastore();
    const rev = await store.readWriteTx((tx) =>
      tx.writeRelationships(touchAll(world.relationships)),
    );

    const sample = sampleUniverse(world, seed);
    const readerBefore = store.snapshotReader(rev);
    const before = new Map<string, Membership>();
    for (const point of sample) {
      const result = await check.check(
        readerBefore,
        "document",
        point.docId,
        "view",
        onr("user", point.userId),
      );
      before.set(pointKey(point), result.verdict);
    }

    // A resource id outside the alphabet, on a relation whose object type (document) is never an
    // allowed subject type anywhere in the schema -- so this write cannot participate in any other
    // resource's evaluation, regardless of which document.view template the seed drew.
    const freshDoc = `fresh_${seed}`;
    const freshRel = createRelationship(
      { objectType: "document", objectId: freshDoc, relation: "viewer" },
      onr("user", first(world.users)),
    );
    const rev2 = await store.readWriteTx((tx) =>
      tx.writeRelationships([{ relationship: freshRel, operation: "touch" }]),
    );
    const readerAfter = store.snapshotReader(rev2);

    for (const point of sample) {
      const after = (
        await check.check(readerAfter, "document", point.docId, "view", onr("user", point.userId))
      ).verdict;
      const was = before.get(pointKey(point));
      expect(
        after,
        `seed=${seed}: irrelevant-tuple invariance broken for document:${point.docId}/view, ` +
          `user:${point.userId}: was ${was}, now ${after} after writing unrelated ` +
          `${formatRelationship(freshRel)}`,
      ).toBe(was);
    }
  });

  it.each(SEEDS)(
    "seed %i: deleting a relationship never turns notMember into member",
    async (seed) => {
      const world = buildRandomAuthzWorld(seed);
      if (world.relationships.length === 0) return;

      const compiled = compileSchema(world.schemaText);
      const check = new CheckEngine(compiled.namespaces, compiled.caveats);

      const store = new ReferenceDatastore();
      const rev = await store.readWriteTx((tx) =>
        tx.writeRelationships(touchAll(world.relationships)),
      );

      const rng = createSeededRandom(seed * 7919 + 1);
      const toDelete = at(world.relationships, rng.next(world.relationships.length));

      const sample = sampleUniverse(world, seed);
      const readerBefore = store.snapshotReader(rev);
      const before = new Map<string, Membership>();
      for (const point of sample) {
        const result = await check.check(
          readerBefore,
          "document",
          point.docId,
          "view_mono",
          onr("user", point.userId),
        );
        before.set(pointKey(point), result.verdict);
      }

      const rev2 = await store.readWriteTx((tx) =>
        tx.writeRelationships([{ relationship: toDelete, operation: "delete" }]),
      );
      const readerAfter = store.snapshotReader(rev2);

      for (const point of sample) {
        const after = (
          await check.check(
            readerAfter,
            "document",
            point.docId,
            "view_mono",
            onr("user", point.userId),
          )
        ).verdict;
        const was = before.get(pointKey(point));
        expect(
          was === "notMember" && after === "member",
          `seed=${seed}: delete monotonicity broken -- deleting ${formatRelationship(toDelete)} ` +
            `turned document:${point.docId}/view_mono, user:${point.userId} from notMember into member`,
        ).toBe(false);
      }
    },
  );

  it.each(SEEDS)(
    "seed %i: adding a relationship never turns member into notMember",
    async (seed) => {
      const world = buildRandomAuthzWorld(seed);
      const compiled = compileSchema(world.schemaText);
      const check = new CheckEngine(compiled.namespaces, compiled.caveats);

      const store = new ReferenceDatastore();
      const rev = await store.readWriteTx((tx) =>
        tx.writeRelationships(touchAll(world.relationships)),
      );

      const sample = sampleUniverse(world, seed);
      const readerBefore = store.snapshotReader(rev);
      const before = new Map<string, Membership>();
      for (const point of sample) {
        const result = await check.check(
          readerBefore,
          "document",
          point.docId,
          "view_mono",
          onr("user", point.userId),
        );
        before.set(pointKey(point), result.verdict);
      }

      const rng = createSeededRandom(seed * 104729 + 1);
      const toAdd = randomRelationship(
        rng,
        world.users,
        world.groups,
        world.folders,
        world.documents,
      );

      const rev2 = await store.readWriteTx((tx) =>
        tx.writeRelationships([{ relationship: toAdd, operation: "touch" }]),
      );
      const readerAfter = store.snapshotReader(rev2);

      for (const point of sample) {
        const after = (
          await check.check(
            readerAfter,
            "document",
            point.docId,
            "view_mono",
            onr("user", point.userId),
          )
        ).verdict;
        const was = before.get(pointKey(point));
        expect(
          was === "member" && after === "notMember",
          `seed=${seed}: add monotonicity broken -- adding ${formatRelationship(toAdd)} turned ` +
            `document:${point.docId}/view_mono, user:${point.userId} from member into notMember`,
        ).toBe(false);
      }
    },
  );
});

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

function touchAll(relationships: readonly Relationship[]): RelationshipUpdate[] {
  return relationships.map((relationship) => ({ relationship, operation: "touch" }));
}

/**
 * The C#'s `SampleUniverse`: draws distinct (document, user) pairs until `SAMPLE_CAP` of them are
 * held. A `Set` of formatted pairs stands in for the C#'s `HashSet<(string, string)>`, and the
 * accompanying array preserves the pairs themselves in insertion order.
 */
function sampleUniverse(world: RandomAuthzWorld, seed: number): readonly QueryPoint[] {
  const rng = createSeededRandom(seed * 31 + 17);
  const seen = new Set<string>();
  const pairs: QueryPoint[] = [];
  while (pairs.length < SAMPLE_CAP) {
    const point: QueryPoint = {
      docId: at(world.documents, rng.next(world.documents.length)),
      userId: at(world.users, rng.next(world.users.length)),
    };
    const key = pointKey(point);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(point);
  }
  return pairs;
}

/** The map key for a query point, standing in for the C# value tuple's structural equality. */
function pointKey(point: QueryPoint): string {
  return `document:${point.docId}@user:${point.userId}`;
}

// `noUncheckedIndexedAccess` makes every index yield `T | undefined`, where the C# indexer threw.
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`index ${index} out of range (${items.length})`);
  return item;
}

function first(items: readonly string[]): string {
  return at(items, 0);
}
