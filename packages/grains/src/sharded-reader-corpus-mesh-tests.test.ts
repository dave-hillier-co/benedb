import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import { loadValidationFile } from "@spacedb/conformance/validation-file-loader";
import type { ValidationFile } from "@spacedb/conformance/validation-model";
import { assertionExpectedMembership } from "@spacedb/conformance/validation-model";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import { IManagementGrain } from "@thresh/core/management-grain";

import { MeshTestCluster } from "./mesh-test-cluster";
import type { ExpandTreeNodeWire } from "./reverse-ops-dtos";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ShardedReaderCorpusMeshTests.cs`.
 *
 * Verdict-level gates that are ADDITIVE to `conformance-mesh-tests.test.ts` now that sharded reads
 * are the only engine path: that suite already replays its representative corpus subset over the
 * sharded read path, so the duplicate per-file corpus loop this class used to run is deliberately
 * gone. What remains is what only this class covered:
 *
 *  1. `relexpiration.yaml`, which the eight-file subset does not carry. Its already-expired row is
 *     stored LIVE in MVCC and must be sheared at QUERY time by the sharded reader's CALLER-side
 *     expiry filter. This is the gate on `GraphShardGrain` deliberately NOT shearing expiration
 *     server-side: a port that "helpfully" filters expiration in its serve path passes nothing
 *     extra here and breaks the caller-clock contract.
 *  2. The `GraphShardGrain` activation POSITIVE CONTROL: the verdicts must actually have been
 *     served by the shard mesh, not by some fallback path. Management statistics only ENUMERATE
 *     existing activations - they never create one - so the control cannot self-satisfy.
 *  3. The multi-silo composition case (shard grain calls crossing silo boundaries while check
 *     dispatch does the same) and the reverse-ops two-cluster agreement gate: two INDEPENDENT
 *     clusters must produce identical reverse-ops results.
 *
 * PORT NOTES.
 *  - The corpus is reached through `@spacedb/conformance` (see `conformance-mesh-tests.test.ts`),
 *    with the same `File.Exists` anti-vacuous-pass guard.
 *  - `management.GetDetailedGrainStatistics()` is Thresh's `IManagementGrain` of the same name,
 *    reached with the integer key `0n`; the grain-type match stays a CASE-INSENSITIVE substring, so
 *    it hits whatever name the ported grain registers under.
 *  - `await using` -> explicit `try/finally`; the two reverse-ops clusters run SEQUENTIALLY, never
 *    concurrently, exactly as the C# says.
 */

const requireFromHere = createRequire(import.meta.url);

const CORPUS_DIR = resolvePath(
  dirname(requireFromHere.resolve("@spacedb/conformance/validation-file-loader")),
  "..",
  "corpus",
);

/**
 * The case-insensitive grain-type substring the shard-activation controls match on.
 *
 * The C# matched `"graphshardgrain"` against Orleans' grain type name. Thresh registers a grain
 * under its class name MINUS the `Grain` suffix, so the live type here reads `GraphShard` and the
 * C#'s literal would never hit - the positive control would pass vacuously, which is the one thing
 * it exists to prevent. The substring is therefore shortened to the part both spellings share.
 */
const SHARD_GRAIN_TYPE_MATCH = "graphshard";

/** The C# `LoadCorpusFile`, guard included. */
function loadCorpusFile(fileName: string): ValidationFile {
  const path = join(CORPUS_DIR, fileName);
  expect(existsSync(path), `Linked corpus file missing from output: ${path}`).toBe(true);
  return loadValidationFile(path);
}

/** The C# `SeedRelationships`. */
async function seedRelationships(
  datastore: IDatastore,
  relationships: readonly Relationship[],
): Promise<void> {
  if (relationships.length === 0) {
    return;
  }

  const updates: readonly RelationshipUpdate[] = relationships.map((relationship) => ({
    relationship,
    operation: "create",
  }));

  await datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

/** The C# `AssertAllVerdictsHold`: accumulate every failure, then assert once. */
async function assertAllVerdictsHold(
  cluster: MeshTestCluster,
  file: ValidationFile,
  label: string,
): Promise<void> {
  const failures: string[] = [];
  for (const assertion of file.assertions) {
    const result = await cluster.checker.check(
      assertion.resource.objectType,
      assertion.resource.objectId,
      assertion.resource.relation,
      assertion.subject,
      assertion.caveatContext,
    );

    const expected = assertionExpectedMembership(assertion);
    if (result.verdict !== expected) {
      failures.push(`  ${assertion.sourceText} => expected ${expected}, got ${result.verdict}`);
    }
  }

  expect(
    failures,
    `${label} (through grain mesh, sharded reads): ${failures.length}/${file.assertions.length} assertion(s) failed:\n${failures.join("\n")}`,
  ).toEqual([]);
}

/**
 * The C# `AssertShardGrainActivated`. Positive control: the verdicts must have been served by the
 * shard mesh, so at least one `GraphShardGrain` activation must exist.
 */
async function assertShardGrainActivated(cluster: MeshTestCluster): Promise<void> {
  const management = cluster.grainFactory.getGrain(IManagementGrain, 0n);
  const stats = await management.getDetailedGrainStatistics();
  expect(
    stats.some((s) => s.grainType.toLowerCase().includes(SHARD_GRAIN_TYPE_MATCH)),
    `no GraphShardGrain activation found among [${stats.map((s) => s.grainType).join(", ")}]`,
  ).toBe(true);
}

/** The C# `ReverseOpsResults` record. */
interface ReverseOpsResults {
  readonly resources: readonly string[];
  readonly subjects: readonly string[];
  readonly expandTree: string;
}

/**
 * Canonical rendering: node structure and child order verbatim (deterministic from the schema
 * expression), leaf subject lists sorted (the one unordered part of the wire shape).
 */
function renderTree(node: ExpandTreeNodeWire): string {
  const subjects = node.subjects
    .map(
      (s) =>
        `${s.subjectType}:${s.subjectId}#${s.subjectRelation}` +
        (s.caveatMissingFields.length > 0 ? `?[${s.caveatMissingFields.join(",")}]` : ""),
    )
    .sort();
  const children = node.children.map(renderTree);
  return (
    `${node.expandedType}:${node.expandedId}#${node.expandedRelation}` +
    `(${node.isLeaf ? "leaf" : node.operation}` +
    `|subjects:[${subjects.join(",")}]|children:[${children.join(",")}])`
  );
}

/** The C# `RunReverseOps`: one whole cluster lifecycle, driven and torn down. */
async function runReverseOps(file: ValidationFile): Promise<ReverseOpsResults> {
  const cluster = await MeshTestCluster.create(file.schemaText);
  try {
    await seedRelationships(cluster.datastore, file.relationships);

    // ian reaches test/repository:authzed_go#read only via the team#member userset plus the
    // organization arrow schema - the shapes the sharded reader must serve for reverse ops.
    const resources: string[] = [];
    for await (const item of cluster.reverseOps.streamLookupResources({
      resourceType: "test/repository",
      permission: "read",
      subjectType: "test/user",
      subjectId: "ian",
      subjectRelation: ELLIPSIS,
      context: undefined,
      limit: undefined,
      cursor: undefined,
    })) {
      resources.push(
        `${item.resourceId}|${item.permissionship.isCaveated ? "caveated" : "member"}`,
      );
    }
    resources.sort();

    const subjects: string[] = [];
    for await (const item of cluster.reverseOps.streamLookupSubjects({
      resourceType: "test/repository",
      resourceId: "authzed_go",
      permission: "read",
      subjectType: "test/user",
      subjectRelation: ELLIPSIS,
      context: undefined,
      limit: undefined,
      cursor: undefined,
    })) {
      subjects.push(
        `${item.subject.subjectId}|${item.subject.permissionship.isCaveated ? "caveated" : "member"}`,
      );
    }
    subjects.sort();

    const expand = await cluster.reverseOps.expandPermissionTree({
      resourceType: "test/repository",
      resourceId: "authzed_go",
      permission: "read",
      mode: "shallow",
    });

    return { resources, subjects, expandTree: renderTree(expand.root) };
  } finally {
    await cluster.dispose();
  }
}

describe("ShardedReaderCorpusMeshTests", () => {
  it("Relexpiration_Conformance_Through_Grain_Mesh", async () => {
    const fileName = "relexpiration.yaml";
    const file = loadCorpusFile(fileName);
    expect(
      file.assertions.length,
      `${fileName}: the gate needs assertions to drive reads`,
    ).toBeGreaterThan(0);

    const cluster = await MeshTestCluster.create(file.schemaText);
    try {
      await seedRelationships(cluster.datastore, file.relationships);
      await assertAllVerdictsHold(cluster, file, fileName);
      await assertShardGrainActivated(cluster);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Conformance_Across_Silos_With_Sharded_Reads", async () => {
    const fileName = "indirectnestedgroups.yaml";
    const file = loadCorpusFile(fileName);

    const cluster = await MeshTestCluster.createMultiSilo(file.schemaText, 3);
    try {
      await seedRelationships(cluster.datastore, file.relationships);
      await assertAllVerdictsHold(cluster, file, `${fileName} (3 silos)`);
      await assertShardGrainActivated(cluster);
    } finally {
      await cluster.dispose();
    }
  }, 180_000);

  it("ReverseOps_Agree_Between_Two_Independent_Clusters", async () => {
    const file = loadCorpusFile("teamwitharrow.yaml");

    const first = await runReverseOps(file);
    const second = await runReverseOps(file);

    expect(second.resources).toEqual(first.resources);
    expect(second.subjects).toEqual(first.subjects);
    expect(second.expandTree).toEqual(first.expandTree);

    // Guard against a vacuous pass: the arrow path must actually surface results.
    expect(first.resources).toContain("authzed_go|member");
    expect(first.subjects).toContain("ian|member");
  }, 180_000);
});
