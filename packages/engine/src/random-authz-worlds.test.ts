import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import { validateRelationship, type Relationship } from "@spacedb/core/relationship";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import {
  buildRandomAuthzWorld,
  randomRelationship,
  SEED_COUNT,
  SEEDS,
} from "./random-authz-worlds";
import { validateSchemaTypes } from "./schema-type-validator";
import { createSeededRandom } from "./seeded-random";

// `RandomAuthzWorlds.cs` is a helper, not a suite, so it has no C# test file and this one has no
// C# counterpart. It exists because the generator's contract is entirely made of properties the
// gates that consume it CANNOT check for themselves:
//
//  - DETERMINISM. C# gets it free from `new Random(seed)`; the port has to supply it. A gate that
//    fails on seed 11 is only actionable if seed 11 means the same world on the next run.
//  - ACYCLICITY. `CheckEngine` has no cycle-cut on the verdict path, so a generated cycle has no
//    well-defined verdict to compare against and the property gates would go flaky rather than
//    red. The C# guarantees this structurally (container index strictly above contained index);
//    this file pins that the port kept the constraint.
//  - LEGALITY. Every generated world must compile and type-validate, or a gate failure reads as
//    an engine bug when it is really a bad world.
//  - TEMPLATE COVERAGE. The C# notes that the seed set exercises all six `document.view` shapes.
//    That claim rides on the draw distribution, which changed with the PRNG, so it is asserted
//    here rather than asserted in a comment.

function key(rel: Relationship): string {
  const r = rel.reference.resource;
  const s = rel.reference.subject;
  return `${r.objectType}:${r.objectId}#${r.relation}@${s.objectType}:${s.objectId}#${s.relation}`;
}

/** The trailing digit of an alphabet id ("g2" -> 2), which is its index in the alphabet. */
function alphabetIndex(objectId: string): number {
  return Number(objectId.slice(1));
}

describe("buildRandomAuthzWorld", () => {
  it.each(SEEDS)("is deterministic for seed %i", (seed) => {
    expect(buildRandomAuthzWorld(seed)).toEqual(buildRandomAuthzWorld(seed));
  });

  it("pins the world for seed 0, so a silent generator change cannot pass", () => {
    const world = buildRandomAuthzWorld(0);
    expect(world.templateIndex).toBe(1);
    expect(world.relationships).toHaveLength(26);
    expect(world.relationships.slice(0, 5).map(key)).toEqual([
      "group:g1#member@group:g0#member",
      "folder:f1#parent@folder:f2#...",
      "folder:f0#parent@folder:f2#...",
      "document:d5#viewer@user:*#...",
      "folder:f2#viewer@group:g2#member",
    ]);
  });

  it("exposes SEED_COUNT seeds, 0..SEED_COUNT-1", () => {
    expect(SEEDS).toHaveLength(SEED_COUNT);
    expect(SEEDS[0]).toBe(0);
    expect(SEEDS[SEED_COUNT - 1]).toBe(SEED_COUNT - 1);
  });

  it("draws every document.view template across the seed set", () => {
    const templates = new Set(SEEDS.map((seed) => buildRandomAuthzWorld(seed).templateIndex));
    expect([...templates].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it.each(SEEDS)("produces a compilable, type-valid schema for seed %i", (seed) => {
    const world = buildRandomAuthzWorld(seed);
    const compiled = compileSchema(world.schemaText);
    validateSchemaTypes(compiled);
    expect(compiled.namespaces.map((ns) => ns.name)).toEqual([
      "user",
      "group",
      "folder",
      "document",
    ]);
    expect(compiled.caveats).toEqual([]);
  });

  it.each(SEEDS)("fixes the alphabet for seed %i", (seed) => {
    const world = buildRandomAuthzWorld(seed);
    expect(world.users).toEqual(["u0", "u1", "u2", "u3", "u4"]);
    expect(world.groups).toEqual(["g0", "g1", "g2", "g3"]);
    expect(world.folders).toEqual(["f0", "f1", "f2"]);
    expect(world.documents).toEqual(["d0", "d1", "d2", "d3", "d4", "d5"]);
  });

  it.each(SEEDS)("emits distinct, valid, uncaveated relationships for seed %i", (seed) => {
    const world = buildRandomAuthzWorld(seed);
    // 30..120 rows are drawn and then deduplicated, so the kept count is at most the upper bound.
    expect(world.relationships.length).toBeGreaterThan(0);
    expect(world.relationships.length).toBeLessThanOrEqual(120);
    expect(new Set(world.relationships.map(key)).size).toBe(world.relationships.length);
    for (const rel of world.relationships) {
      validateRelationship(rel);
      expect(rel.optionalCaveat).toBeUndefined();
      expect(rel.optionalExpiration).toBeUndefined();
      expect(rel.optionalIntegrity).toBeUndefined();
    }
  });

  it.each(SEEDS)("nests groups and folders as a DAG for seed %i", (seed) => {
    assertNestingIsAcyclic(buildRandomAuthzWorld(seed).relationships, seed);
  });

  it("puts the wildcard only on document.viewer, never on a userset-reachable relation", () => {
    for (const seed of SEEDS)
      for (const rel of buildRandomAuthzWorld(seed).relationships)
        if (rel.reference.subject.objectId === PUBLIC_WILDCARD)
          expect(key(rel)).toMatch(/^document:d\d#viewer@user:\*#\.\.\.$/);
  });
});

describe("randomRelationship", () => {
  it("draws only schema-valid shapes over many draws", () => {
    const rng = createSeededRandom(9001);
    const users = ["u0", "u1", "u2", "u3", "u4"];
    const groups = ["g0", "g1", "g2", "g3"];
    const folders = ["f0", "f1", "f2"];
    const documents = ["d0", "d1", "d2", "d3", "d4", "d5"];
    const shapes = new Set<string>();
    const drawn: Relationship[] = [];
    for (let i = 0; i < 3000; i++) {
      const rel = randomRelationship(rng, users, groups, folders, documents);
      validateRelationship(rel);
      drawn.push(rel);
      const r = rel.reference.resource;
      const s = rel.reference.subject;
      shapes.add(`${r.objectType}#${r.relation}@${s.objectType}#${s.relation}`);
    }
    // All eleven categories, collapsed to the nine distinct relation shapes they produce:
    // categories 1 and 6 both write document.viewer@user, and 0 and 2 differ only by subject type.
    expect([...shapes].sort()).toEqual([
      `document#banned@user#${ELLIPSIS}`,
      `document#editor@user#${ELLIPSIS}`,
      `document#parent@folder#${ELLIPSIS}`,
      "document#viewer@group#member",
      `document#viewer@user#${ELLIPSIS}`,
      "folder#parent@folder#...",
      "folder#viewer@group#member",
      `folder#viewer@user#${ELLIPSIS}`,
      "group#member@group#member",
      `group#member@user#${ELLIPSIS}`,
    ]);
    assertNestingIsAcyclic(drawn, 9001);
  });

  it("is deterministic given the same generator seed", () => {
    const alphabet = [
      ["u0", "u1"],
      ["g0", "g1"],
      ["f0", "f1"],
      ["d0", "d1"],
    ] as const;
    const draw = (): string[] => {
      const rng = createSeededRandom(4);
      return Array.from({ length: 20 }, () =>
        key(randomRelationship(rng, alphabet[0], alphabet[1], alphabet[2], alphabet[3])),
      );
    };
    expect(draw()).toEqual(draw());
  });
});

/**
 * The DAG constraint, asserted directly rather than via a reachability search: a `group#member`
 * edge always points from a higher-indexed group to a lower-indexed one, and a `folder.parent`
 * edge from a lower-indexed folder to a higher-indexed one (its resource is the CHILD). Both
 * strictly order container above contained, which is what makes a cycle unconstructible.
 */
function assertNestingIsAcyclic(relationships: readonly Relationship[], seed: number): void {
  for (const rel of relationships) {
    const r = rel.reference.resource;
    const s = rel.reference.subject;
    if (r.objectType === "group" && s.objectType === "group")
      expect(
        alphabetIndex(s.objectId) < alphabetIndex(r.objectId),
        `seed=${seed}: ${key(rel)} nests a group into a lower-or-equal-indexed group`,
      ).toBe(true);
    if (r.objectType === "folder" && r.relation === "parent")
      expect(
        alphabetIndex(r.objectId) < alphabetIndex(s.objectId),
        `seed=${seed}: ${key(rel)} parents a folder to a lower-or-equal-indexed folder`,
      ).toBe(true);
  }
}
