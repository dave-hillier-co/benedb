import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import { loadValidationFile } from "@spacedb/conformance/validation-file-loader";
import type { ValidationFile } from "@spacedb/conformance/validation-model";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import { LookupResourcesEngine } from "@spacedb/engine/lookup-resources-engine";
import { LookupSubjectsEngine } from "@spacedb/engine/lookup-subjects-engine";

import { MeshTestCluster } from "./mesh-test-cluster";
import type {
  ExpandTreeNodeWire,
  FoundResourceWire,
  FoundSubjectWire,
  LookupResourcesArgs,
  LookupSubjectsArgs,
} from "./reverse-ops-dtos";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ReverseOpsCorpusMeshTests.cs`.
 *
 * Exercises the three reverse / tree ops (ExpandPermissionTree, LookupSubjects, LookupResources)
 * THROUGH the {@link MeshTestCluster}'s `ReverseOps` in-process read helper (the same instance a
 * silo's gRPC services resolve) against representative SpiceDB corpus schemas (a nested-group /
 * exclusion file and a caveat file), NOT against the in-process engine directly. The helper still
 * dispatches onward to the SubjectFrontierGrain / MembershipWalkGrain / Check mesh, so this remains
 * a distributed exercise, not a purely local one.
 *
 * Each case asserts two things:
 *  1. Agreement with the engine: the mesh result set equals (or, where the grain shears caveats the
 *     engine carries verbatim, is contained in) the engine's own op run directly over the SAME
 *     pinned snapshot. This is the distributed == local proof for the reverse ops.
 *  2. The consistency invariant with Check: every subject / resource the mesh returns is confirmed
 *     Member-or-Caveated by the mesh's own `IPermissionChecker.check` (a returned item is never a
 *     definite non-member), and conversely the corpus's assertTrue subjects all appear.
 *
 * A disagreement between the two sides is a REAL defect, never a harness quirk.
 *
 * PORT NOTES.
 *  - `Path.Combine(AppContext.BaseDirectory, "TestData", fileName)` is the vendored corpus at
 *    `packages/conformance/corpus`, and the C#'s `Assert.True(File.Exists(path))` anti-vacuous-pass
 *    guard is kept as an `existsSync` check: without it a renamed corpus file would turn a loader
 *    failure into a silently-different test.
 *  - THE SET-CONTAINMENT DIRECTION IS THE TRAP. `Assert.Superset(expectedSuperset, actual)` asserts
 *    ACTUAL is a superset of the first argument, and `Assert.Subset(expectedSubset, actual)` asserts
 *    ACTUAL is a subset of it - both read backwards. They are ported as the explicitly-named
 *    {@link expectContains} (a ⊇ b) so the direction is stated rather than inferred.
 *  - `HashSet<string>` comparison becomes ordinal-sorted arrays compared with `toEqual`, sorted by
 *    the BARE `sort()` (UTF-16 code units), never `localeCompare`.
 *  - The C#'s `42L` caveat context value is a plain JavaScript number in the port's
 *    `ReadonlyMap<string, unknown>` context; the CEL binding takes it as an int without a bigint.
 *  - ONE cluster per case (each corpus file declares its own schema and the silo compiles it at
 *    startup), disposed in a `finally`, with an explicit long timeout - the `unit` project's default
 *    is 5s.
 */

const requireFromHere = createRequire(import.meta.url);

/** The vendored corpus directory, resolved relative to the `@spacedb/conformance` package. */
const CORPUS_DIR = resolvePath(
  dirname(requireFromHere.resolve("@spacedb/conformance/validation-file-loader")),
  "..",
  "corpus",
);

/** The C# `LoadCorpus`, with its anti-vacuous-pass file-existence guard. */
function loadCorpus(fileName: string): ValidationFile {
  const path = join(CORPUS_DIR, fileName);
  expect(existsSync(path), `Linked corpus file missing from output: ${path}`).toBe(true);
  return loadValidationFile(path);
}

/** The C# `SeedAsync`. */
async function seed(datastore: IDatastore, file: ValidationFile): Promise<void> {
  if (file.relationships.length === 0) return;

  const updates: readonly RelationshipUpdate[] = file.relationships.map((relationship) => ({
    relationship,
    operation: "create",
  }));
  await datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

function onr(objectType: string, objectId: string, relation: string): ObjectAndRelation {
  return { objectType, objectId, relation };
}

/** `HashSet<string>` as an ordinal-sorted array. */
function ordinal(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}

/**
 * Asserts `superset` ⊇ `subset`. Both xUnit `Assert.Superset` and `Assert.Subset` read backwards
 * (see the port note), so the containment is named here instead of transliterating the argument
 * order.
 */
function expectContains(superset: ReadonlySet<string>, subset: ReadonlySet<string>): void {
  const missing = [...subset].filter((id) => !superset.has(id)).sort();
  expect(missing, `not contained in the expected set: ${missing.join(",")}`).toEqual([]);
}

// The reverse LOOKUP ops stream from the in-process ReverseOps helper; collect the whole stream so
// the corpus assertions read the same shape as before.
async function lookupSubjectsViaMesh(
  cluster: MeshTestCluster,
  args: LookupSubjectsArgs,
): Promise<FoundSubjectWire[]> {
  const list: FoundSubjectWire[] = [];
  for await (const item of cluster.reverseOps.streamLookupSubjects(args)) list.push(item.subject);
  return list;
}

async function lookupResourcesViaMesh(
  cluster: MeshTestCluster,
  args: LookupResourcesArgs,
): Promise<FoundResourceWire[]> {
  const list: FoundResourceWire[] = [];
  for await (const item of cluster.reverseOps.streamLookupResources(args)) list.push(item);
  return list;
}

/**
 * Builds the engine-side LookupSubjects op over the SAME pinned snapshot the grain would use, so
 * the mesh result can be compared against the engine's own answer.
 */
async function engineLookupSubjects(
  cluster: MeshTestCluster,
  resourceType: string,
  resourceId: string,
  permission: string,
  subjectType: string,
): Promise<Set<string>> {
  const schema = cluster.services.schemaProvider.current;
  const datastore = cluster.datastore;
  const rev = await datastore.optimizedRevision();
  const reader = datastore.snapshotReader(rev.revision);
  const engine = new LookupSubjectsEngine(schema.namespaces);

  const found = new Set<string>();
  for await (const s of engine.lookupSubjects(
    reader,
    onr(resourceType, resourceId, permission),
    subjectType,
  )) {
    found.add(s.subjectId);
  }
  return found;
}

async function engineLookupResources(
  cluster: MeshTestCluster,
  resourceType: string,
  permission: string,
  subjectType: string,
  subjectId: string,
): Promise<Set<string>> {
  const schema = cluster.services.schemaProvider.current;
  const datastore = cluster.datastore;
  const rev = await datastore.optimizedRevision();
  const reader = datastore.snapshotReader(rev.revision);
  const engine = new LookupResourcesEngine(schema.namespaces, schema.caveats);

  const found = new Set<string>();
  // The C#'s named-argument overload: `caveatContext: null, evaluationTime: null, cursor: null,
  // limit: null` - every one of them absent here.
  for await (const r of engine.lookupResources(
    reader,
    subjectType,
    subjectId,
    ELLIPSIS,
    resourceType,
    permission,
    undefined,
    undefined,
    undefined,
    undefined,
  )) {
    found.add(r.resourceId);
  }
  return found;
}

/** The C# `CollectDirectUserSubjects`: a recursive walk over the wire tree. */
function collectDirectUserSubjects(node: ExpandTreeNodeWire): string[] {
  const ids: string[] = [];
  const walk = (n: ExpandTreeNodeWire): void => {
    for (const s of n.subjects) {
      if (s.subjectType === "user" && !s.isWildcard) ids.push(s.subjectId);
    }
    for (const child of n.children) walk(child);
  };
  walk(node);
  return ids;
}

describe("ReverseOpsCorpusMeshTests", () => {
  // ---- Nested-group / exclusion corpus: indirectnestedgroups.yaml ----------------------------
  //
  // document:firstdoc#view = viewer; viewer: user | group#non_intern_member, where
  // non_intern_member = direct_member - (intern - allowed). Members (assertTrue): tom, sarah, fred,
  // tim. Non-members (assertFalse): james, jim, frank.

  it("NestedGroups_LookupSubjects_Through_Mesh_Agrees_With_Engine_And_Check", async () => {
    const file = loadCorpus("indirectnestedgroups.yaml");
    const cluster = await MeshTestCluster.create(file.schemaText);
    try {
      await seed(cluster.datastore, file);

      const subjects = await lookupSubjectsViaMesh(cluster, {
        resourceType: "document",
        resourceId: "firstdoc",
        permission: "view",
        subjectType: "user",
        subjectRelation: ELLIPSIS,
        context: undefined,
        limit: undefined,
        cursor: undefined,
      });

      const meshIds = new Set(subjects.map((s) => s.subjectId));

      // (1) Mesh grain agrees with the engine's own LookupSubjects over the same snapshot.
      const engineIds = await engineLookupSubjects(cluster, "document", "firstdoc", "view", "user");
      expect(ordinal(meshIds)).toEqual(ordinal(engineIds));

      // The corpus's known members are all enumerated; known non-members are absent.
      expect(meshIds).toContain("tom");
      expect(meshIds).toContain("sarah");
      expect(meshIds).toContain("fred");
      expect(meshIds).toContain("tim");
      expect(meshIds).not.toContain("james");
      expect(meshIds).not.toContain("jim");
      expect(meshIds).not.toContain("frank");

      // (2) Consistency invariant: every returned subject is Member-or-Caveated under mesh Check.
      for (const s of subjects) {
        const check = await cluster.checker.check(
          "document",
          "firstdoc",
          "view",
          onr("user", s.subjectId, ELLIPSIS),
          undefined,
        );
        expect(
          check.verdict === "member" || check.verdict === "caveated",
          `LookupSubjects returned user:${s.subjectId} but Check says ${check.verdict}`,
        ).toBe(true);
      }
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("NestedGroups_LookupResources_Through_Mesh_Agrees_With_Engine_And_Check", async () => {
    const file = loadCorpus("indirectnestedgroups.yaml");
    const cluster = await MeshTestCluster.create(file.schemaText);
    try {
      await seed(cluster.datastore, file);

      // tom is a direct viewer AND a non-intern member of engineering, so reachable on firstdoc.
      const resources = await lookupResourcesViaMesh(cluster, {
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "tom",
        subjectRelation: ELLIPSIS,
        context: undefined,
        limit: undefined,
        cursor: undefined,
      });

      const meshIds = new Set(resources.map((r) => r.resourceId));

      // (1) Mesh grain agrees with the engine's own LookupResources over the same snapshot.
      const engineIds = await engineLookupResources(cluster, "document", "view", "user", "tom");
      expect(ordinal(meshIds)).toEqual(ordinal(engineIds));
      expect(meshIds).toContain("firstdoc");

      // (2) Consistency invariant: every returned resource is Member-or-Caveated under mesh Check.
      for (const r of resources) {
        const check = await cluster.checker.check(
          "document",
          r.resourceId,
          "view",
          onr("user", "tom", ELLIPSIS),
          undefined,
        );
        expect(
          check.verdict === "member" || check.verdict === "caveated",
          `LookupResources returned document:${r.resourceId} but Check says ${check.verdict}`,
        ).toBe(true);
      }
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("NestedGroups_ExpandPermissionTree_Through_Mesh_Yields_Viewer_Structure", async () => {
    const file = loadCorpus("indirectnestedgroups.yaml");
    const cluster = await MeshTestCluster.create(file.schemaText);
    try {
      await seed(cluster.datastore, file);

      const reply = await cluster.reverseOps.expandPermissionTree({
        resourceType: "document",
        resourceId: "firstdoc",
        permission: "view",
        mode: "shallow",
      });

      // view = viewer, so the tree root expands the "view" permission over the document.
      expect(reply.root.expandedType).toBe("document");
      expect(reply.root.expandedId).toBe("firstdoc");
      expect(reply.root.expandedRelation).toBe("view");

      // The expanded direct subjects under the tree are a subset of the actual members (no phantom
      // subjects), confirmed via mesh Check.
      const directUsers = collectDirectUserSubjects(reply.root);
      for (const id of directUsers) {
        const check = await cluster.checker.check(
          "document",
          "firstdoc",
          "view",
          onr("user", id, ELLIPSIS),
          undefined,
        );
        expect(
          check.verdict === "member" || check.verdict === "caveated",
          `Expand surfaced user:${id} as a direct subject but Check says ${check.verdict}`,
        ).toBe(true);
      }
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // ---- Caveat corpus: basiccaveat.yaml -------------------------------------------------------
  //
  // viewer: user with some_caveat(somecondition int) | user. Seeded: tom[somecondition:42] (true),
  // fred[somecondition:41] (false), sarah[some_caveat] (caveated, needs context), tracy
  // (unconditional).

  it("Caveat_LookupSubjects_Through_Mesh_Agrees_With_Engine_And_Surfaces_Caveated", async () => {
    const file = loadCorpus("basiccaveat.yaml");
    const cluster = await MeshTestCluster.create(file.schemaText);
    try {
      await seed(cluster.datastore, file);

      // No request context: tracy is unconditional, sarah is caveated (missing somecondition),
      // tom's written context (42) satisfies the caveat, fred's written context (41) fails it.
      const subjects = await lookupSubjectsViaMesh(cluster, {
        resourceType: "document",
        resourceId: "firstdoc",
        permission: "view",
        subjectType: "user",
        subjectRelation: ELLIPSIS,
        context: undefined,
        limit: undefined,
        cursor: undefined,
      });

      const byId = new Map(subjects.map((s) => [s.subjectId, s.permissionship] as const));

      // (1) Mesh grain agrees with the engine's own pre-collapse subject set over the same
      // snapshot. The engine yields the structural members (tracy, tom, sarah, fred carry caveats
      // verbatim); the grain collapses against an empty context, shearing the definitely-false
      // fred. So every collapsed (mesh) subject came from the engine's pre-collapse set:
      // meshKeys ⊆ engineIds.
      const engineIds = await engineLookupSubjects(cluster, "document", "firstdoc", "view", "user");
      expectContains(engineIds, new Set(byId.keys()));

      // tracy: unconditional member.
      expect(byId.has("tracy")).toBe(true);
      expect(byId.get("tracy")?.isCaveated).toBe(false);

      // sarah: caveated, surfaces the missing parameter name.
      expect(byId.has("sarah")).toBe(true);
      expect(byId.get("sarah")?.isCaveated).toBe(true);
      expect(byId.get("sarah")?.missingContextParams).toContain("somecondition");

      // fred: written context fails the caveat -> definitely false -> sheared off entirely.
      expect(byId.has("fred")).toBe(false);

      // (2) Consistency invariant: every returned subject is Member-or-Caveated under mesh Check
      // (using the same absent request context).
      for (const s of subjects) {
        const check = await cluster.checker.check(
          "document",
          "firstdoc",
          "view",
          onr("user", s.subjectId, ELLIPSIS),
          undefined,
        );
        expect(
          check.verdict === "member" || check.verdict === "caveated",
          `Caveat LookupSubjects returned user:${s.subjectId} but Check says ${check.verdict}`,
        ).toBe(true);
        // The grain's collapsed permissionship matches Check's verdict.
        expect(s.permissionship.isCaveated).toBe(check.verdict === "caveated");
      }
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Caveat_LookupResources_Through_Mesh_Agrees_With_Engine_And_Check", async () => {
    const file = loadCorpus("basiccaveat.yaml");
    const cluster = await MeshTestCluster.create(file.schemaText);
    try {
      await seed(cluster.datastore, file);

      // Provide somecondition=42 so the caveated subjects resolve to definite members. The C#'s
      // `42L` is a plain number here.
      const context: ReadonlyMap<string, unknown> = new Map<string, unknown>([
        ["somecondition", 42],
      ]);

      const resources = await lookupResourcesViaMesh(cluster, {
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "sarah",
        subjectRelation: ELLIPSIS,
        context,
        limit: undefined,
        cursor: undefined,
      });

      const meshIds = new Set(resources.map((r) => r.resourceId));

      // (1) Mesh grain (with satisfying context) reaches firstdoc for sarah; engine (no caveat
      // shear, candidate set) also includes firstdoc. The mesh result is within the engine's
      // reachable candidate set: meshIds ⊆ engineIds.
      const engineIds = await engineLookupResources(cluster, "document", "view", "user", "sarah");
      expect(meshIds).toContain("firstdoc");
      expectContains(engineIds, meshIds);

      // (2) Consistency invariant: every returned resource is Member-or-Caveated under mesh Check
      // with the same context.
      for (const r of resources) {
        const check = await cluster.checker.check(
          "document",
          r.resourceId,
          "view",
          onr("user", "sarah", ELLIPSIS),
          context,
        );
        expect(
          check.verdict === "member" || check.verdict === "caveated",
          `Caveat LookupResources returned document:${r.resourceId} but Check says ${check.verdict}`,
        ).toBe(true);
      }
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
