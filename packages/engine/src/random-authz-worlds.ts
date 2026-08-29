import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";

import { createSeededRandom, type SeededRandom } from "./seeded-random";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/RandomAuthzWorlds.cs`.
//
// Hand-rolled deterministic world generator for the property/metamorphic gates
// (`walk-equivalence-property-tests`, `metamorphic-invariant-tests`, `cross-api-agreement-tests`).
// Given an integer seed, `buildRandomAuthzWorld` deterministically produces a compilable schema
// plus a random relationship set entirely from one seeded generator -- no wall-clock, no ambient
// randomness, no external property-testing package.
//
// The C# is an `internal static class`, so it becomes module-level exported functions with the
// type name folded in where it would otherwise be ambiguous (`RandomAuthzWorlds.Build` ->
// `buildRandomAuthzWorld`). It is NOT a test file: it exports generators, not cases, which is why
// it has no `.test` in its name.
//
// DETERMINISM IS THE POINT, and it is the one thing that does not port mechanically. C# gets it
// from `new Random(seed)`; JavaScript's `Math.random` cannot be seeded at all, so every draw here
// runs through `createSeededRandom` (see `seeded-random.ts`). The NUMBER SEQUENCE differs from
// .NET's -- it cannot be reproduced -- but the SHAPE of the generated worlds does not: the same
// alphabet sizes, the same 6 permission templates, the same 11-way relationship mix, the same
// 30..120 row count, and the same DAG constraint below.
//
// SCHEMA SHAPE: the relation structure (user / group / folder / document, with group nesting via
// `group#member`, a `user:*` wildcard option on document.viewer (directly used only -- real
// SpiceDB rejects wildcards reachable through a userset reference), and a folder/document
// `parent` arrow) is fixed across every seed so the generated worlds are always compilable and
// share one query universe shape. What varies per seed is `document.view`'s permission
// expression, chosen from `DOCUMENT_VIEW_TEMPLATES` -- a set of shapes that between them cover
// union, intersection, exclusion and arrow composition. `document.view_mono` and `folder.view`
// are deliberately union/arrow-only on EVERY seed (never intersection/exclusion) so the
// monotonicity gates in `metamorphic-invariant-tests` always have a permission they can legally
// exercise.
//
// GROUP/FOLDER NESTING IS A DAG BY CONSTRUCTION -- a generator design choice, not a schema
// limitation. A `group#member` or `folder#parent` edge is only ever drawn from a higher-indexed
// alphabet entry to a lower-indexed one, so a world can never contain a genuine reachability
// cycle. This is deliberate: `CheckEngine`/`LocalDispatcher` has NO cycle-cut on the verdict path
// for a real data cycle -- it consumes depth budget until `MaxDepthExceededException`, exactly
// matching SpiceDB. That is correct engine behavior, not a completeness bug, but it means a world
// with a real cycle has no well-defined Check verdict for a metamorphic/cross-API gate to compare
// against. The membership-WALK accelerator, by contrast, DOES cycle-cut cleanly (see
// `localClosure`'s visited set) -- its termination-on-cycles property is exercised by a small,
// dedicated, hand-built cyclic graph in `walk-equivalence-property-tests` instead, which never
// touches `CheckEngine`.
//
// STATED LIMITS: no caveats and no expiration on any generated relationship -- the SpiceDB
// conformance corpus already covers those axes; this generator is scoped to the plain-relation /
// userset / set-operation / arrow / wildcard surface. The alphabet is small (5 users, 4 groups,
// 3 folders, 6 documents) by design: dense enough for nesting to have real depth, small enough
// that a query point enumeration over the full universe (rather than sampling it) stays fast.

/** Seeds 0..SEED_COUNT-1 are the fixed, deterministic seed set every gate's `it.each` runs over. */
export const SEED_COUNT = 24;

/**
 * The seed rows. C# exposes `IEnumerable<object[]>` because xUnit's `[MemberData]` demands the
 * argument-array shape; vitest's `it.each` takes the values directly, so this is a plain
 * `number[]` and each gate spells its own `%i` placeholder in the case title.
 */
export const SEEDS: readonly number[] = Array.from({ length: SEED_COUNT }, (_, s) => s);

// document.view templates: [0] union, [1] pure exclusion, [2] pure intersection, [3]
// union+exclusion, [4] union+arrow, [5] intersection+arrow. Across the seed set every one of
// these gets exercised (SEED_COUNT is a multiple of the template count), so union / intersection
// / exclusion / arrow shapes are all covered by the walk-equivalence and cross-API gates.
const DOCUMENT_VIEW_TEMPLATES: readonly string[] = [
  "viewer + editor",
  "viewer - banned",
  "viewer & editor",
  "(viewer + editor) - banned",
  "viewer + parent->view",
  "(viewer & editor) + parent->view",
];

/** One generated world: its schema text, its relationships, and the alphabets they were drawn from. */
export interface RandomAuthzWorld {
  readonly schemaText: string;
  readonly relationships: readonly Relationship[];
  readonly users: readonly string[];
  readonly groups: readonly string[];
  readonly folders: readonly string[];
  readonly documents: readonly string[];
  readonly templateIndex: number;
}

/** Deterministically builds the world for `seed`. Same seed, same world, on every run and machine. */
export function buildRandomAuthzWorld(seed: number): RandomAuthzWorld {
  const rng = createSeededRandom(seed);
  const users = range("u", 5);
  const groups = range("g", 4);
  const folders = range("f", 3);
  const documents = range("d", 6);

  const templateIndex = rng.next(DOCUMENT_VIEW_TEMPLATES.length);
  const template = DOCUMENT_VIEW_TEMPLATES[templateIndex];
  // `noUncheckedIndexedAccess`: the index came from `next(length)` so it is always in range, but
  // the compiler cannot see that and the C# had no such read to port.
  if (template === undefined) throw new Error(`no document.view template at ${templateIndex}`);
  const schema = buildSchema(template);

  const rowCount = 30 + rng.next(91); // up to 30..120 relationship rows, deduplicated below.
  const rels: Relationship[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rowCount; i++) {
    const rel = randomRelationship(rng, users, groups, folders, documents);
    // Distinct rows only: duplicates are Touch-no-ops in the reference model, but real SpiceDB
    // rejects a duplicate update within one WriteRelationships request ("a relationship can only
    // be specified in an update once...") -- the differential gate found this, so every gate's
    // worlds are deduplicated at the source.
    const resource = rel.reference.resource;
    const subject = rel.reference.subject;
    const key = `${resource.objectType}:${resource.objectId}#${resource.relation}@${subject.objectType}:${subject.objectId}#${subject.relation}`;
    if (!seen.has(key)) {
      seen.add(key);
      rels.push(rel);
    }
  }

  return {
    schemaText: schema,
    relationships: rels,
    users,
    groups,
    folders,
    documents,
    templateIndex,
  };
}

/**
 * Draws one random, schema-valid relationship over the given alphabet. Exposed (not just used
 * internally by `buildRandomAuthzWorld`) so the metamorphic add-monotonicity gate can draw an
 * additional, independently-random relationship to add to an already-built world.
 */
export function randomRelationship(
  rng: SeededRandom,
  users: readonly string[],
  groups: readonly string[],
  folders: readonly string[],
  documents: readonly string[],
): Relationship {
  const category = rng.next(11);
  switch (category) {
    case 0:
      return rel("group", pick(rng, groups), "member", onr("user", pick(rng, users)));
    // The wildcard lives on document.viewer (a DIRECTLY-used relation), never on group.member:
    // real SpiceDB rejects a schema where a wildcard is reachable through a userset reference
    // ("wildcard relations cannot be transitively included") -- the differential gate found the
    // original group.member placement was a world SpiceDB would refuse to accept at WriteSchema.
    case 1:
      return rel("document", pick(rng, documents), "viewer", onr("user", PUBLIC_WILDCARD));
    // Acyclic by construction: the child (subject) group always has a strictly lower alphabet
    // index than the parent (resource) group -- see the DAG remarks at the head of this module.
    case 2:
      return acyclicNestedEdge(rng, groups, "group", "member", "member", true);
    case 3:
      return rel("folder", pick(rng, folders), "viewer", onr("user", pick(rng, users)));
    case 4:
      return rel("folder", pick(rng, folders), "viewer", onr("group", pick(rng, groups), "member"));
    // folder.parent's RESOURCE is the child folder and its SUBJECT is the parent folder, so the
    // higher alphabet index is the subject here (opposite of group.member's resource-is-container
    // shape) -- both directions strictly increase index from child to container, so both are
    // acyclic; only which side (resource/subject) plays "container" differs.
    case 5:
      return acyclicNestedEdge(rng, folders, "folder", "parent", ELLIPSIS, false);
    case 6:
      return rel("document", pick(rng, documents), "viewer", onr("user", pick(rng, users)));
    case 7:
      return rel(
        "document",
        pick(rng, documents),
        "viewer",
        onr("group", pick(rng, groups), "member"),
      );
    case 8:
      return rel("document", pick(rng, documents), "editor", onr("user", pick(rng, users)));
    case 9:
      return rel("document", pick(rng, documents), "banned", onr("user", pick(rng, users)));
    // The C#'s discard arm: category 10, and any value a widened bound would produce. Not an
    // exhaustiveness site (the scrutinee is a number, not a closed union), so no `assertNever`.
    default:
      return rel("document", pick(rng, documents), "parent", onr("folder", pick(rng, folders)));
  }
}

// Draws a self-referential edge that can never participate in a cycle: one alphabet index is
// drawn from [1, count-1] (the "container" side, e.g. the containing group or the parent folder)
// and the other from [0, containerIndex-1] (the "contained" side), so every edge strictly orders
// container above contained. `resourceIsHigherIndex` picks which side (resource or subject) is
// the container -- group.member's resource is the container; folder.parent's resource is the
// CHILD, so its subject is the container instead. `subjectRelation` is `resRel` for a userset
// (group#member) or the ellipsis for a plain-typed relation (folder.parent's subject is just
// `folder`).
function acyclicNestedEdge(
  rng: SeededRandom,
  alphabet: readonly string[],
  resType: string,
  resRel: string,
  subjectRelation: string,
  resourceIsHigherIndex: boolean,
): Relationship {
  const containerIdx = 1 + rng.next(alphabet.length - 1);
  const containedIdx = rng.next(containerIdx);
  const resIdx = resourceIsHigherIndex ? containerIdx : containedIdx;
  const subIdx = resourceIsHigherIndex ? containedIdx : containerIdx;
  return rel(
    resType,
    at(alphabet, resIdx),
    resRel,
    onr(resType, at(alphabet, subIdx), subjectRelation),
  );
}

function buildSchema(documentViewExpr: string): string {
  return `definition user {}

definition group {
    relation member: user | group#member
}

definition folder {
    relation viewer: user | group#member
    relation parent: folder

    permission view = viewer + parent->view
}

definition document {
    relation viewer: user | user:* | group#member
    relation editor: user
    relation banned: user
    relation parent: folder

    permission view = ${documentViewExpr}
    permission view_mono = viewer + editor + parent->view
}`;
}

function range(prefix: string, count: number): readonly string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

function pick(rng: SeededRandom, items: readonly string[]): string {
  return at(items, rng.next(items.length));
}

// `noUncheckedIndexedAccess` makes every index yield `string | undefined`, where the C# indexer
// threw. One helper keeps the guard from cluttering each draw site.
function at(items: readonly string[], index: number): string {
  const item = items[index];
  if (item === undefined) throw new Error(`alphabet index ${index} out of range (${items.length})`);
  return item;
}

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

function rel(
  resType: string,
  resId: string,
  resRel: string,
  subject: ObjectAndRelation,
): Relationship {
  return createRelationship({ objectType: resType, objectId: resId, relation: resRel }, subject);
}
