import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import { loadValidationFile } from "@spacedb/conformance/validation-file-loader";
import { assertionExpectedMembership } from "@spacedb/conformance/validation-model";
import type { Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import type { IDatastore } from "@spacedb/datastore/i-datastore";

import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ConformanceMeshTests.cs`.
 *
 * Proves the dispatch mesh: a representative subset of the SpiceDB conformance corpus is run
 * through the REAL grain mesh (the silo-wide root dispatcher and the keyed `ICheckGrain`
 * activations) rather than the in-process `CheckEngine`, and every assertion's verdict must match
 * its expected member / notMember / caveated outcome.
 *
 * This is the distributed == local proof: the exact same fixtures the in-process conformance suite
 * asserts are replayed, but each check recurses across grain boundaries. Engine graph reads are
 * served by the `IGraphShardGrain` mesh (the only read path), so this suite is also the sharded-read
 * conformance gate; `sharded-reader-corpus-mesh-tests.test.ts` adds only what this suite does not
 * cover (the expiration file, the shard-activation positive control, the multi-silo composition
 * case).
 *
 * PORT NOTES.
 *  - `[Collection(MeshClusterCollection.Name)]` maps to nothing; see `mesh-cluster-collection.ts`
 *    for why vitest's per-file isolation already supplies what the xunit collection asked for.
 *  - The C# reaches the corpus through a LINKED `TestData` directory under
 *    `AppContext.BaseDirectory`. Here the corpus is vendored in `@spacedb/conformance`, so the
 *    loader is imported from that package and the corpus directory is resolved RELATIVE TO IT
 *    (never relative to this file), which is the same "one copy, wherever it lives" property the
 *    link gave the C#.
 *  - `Assert.True(File.Exists(path), ...)` is kept verbatim in spirit: it is the anti-vacuous-pass
 *    guard, so a broken corpus path fails LOUDLY instead of silently running zero assertions.
 *  - Failures ACCUMULATE across the whole file and are asserted ONCE, with the count and each
 *    assertion's source text. Converting this into fail-fast would lose the aggregate message that
 *    makes a regression diagnosable.
 *  - `result.Verdict != assertion.ExpectedMembership` compares THREE outcomes (member / notMember /
 *    caveated) - `assertionExpectedMembership` is the ported computed property, and a two-valued
 *    boolean comparison would silently pass every caveated case.
 *  - `await using var cluster` -> an explicit `try/finally`; one cluster per FILE, built and torn
 *    down serially, because each corpus file declares its own schema and the silo compiles it at
 *    startup.
 */

const requireFromHere = createRequire(import.meta.url);

/** The vendored corpus directory, resolved relative to the `@spacedb/conformance` package. */
const CORPUS_DIR = resolvePath(
  dirname(requireFromHere.resolve("@spacedb/conformance/validation-file-loader")),
  "..",
  "corpus",
);

/**
 * The C# `MeshFiles`: the representative subset run through the mesh - a set-ops file, an arrow
 * file, a wildcard file, an indirect/nested-group file, a recursive file, and three caveat files.
 */
const MESH_FILES: readonly string[] = [
  "multipleops.yaml", // set-ops (union / intersection / exclusion)
  "teamwitharrow.yaml", // arrow (tuple-to-userset)
  "simplewildcard.yaml", // wildcard
  "indirectnestedgroups.yaml", // indirect / nested group
  "simplerecursive.yaml", // recursive
  "basiccaveat.yaml", // caveat
  "caveatlr.yaml", // caveat (left/right ordering)
  "caveatip.yaml", // caveat (ip / typed params)
];

/** The C# `SeedRelationships`: one ReadWriteTx of Create updates, skipped when there are none. */
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

describe("ConformanceMeshTests", () => {
  for (const fileName of MESH_FILES) {
    it(`Conformance_Through_Grain_Mesh(${fileName})`, async () => {
      const path = join(CORPUS_DIR, fileName);
      expect(existsSync(path), `Linked corpus file missing from output: ${path}`).toBe(true);

      const file = loadValidationFile(path);

      const cluster = await MeshTestCluster.create(file.schemaText);
      try {
        await seedRelationships(cluster.datastore, file.relationships);

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
            failures.push(
              `  ${assertion.sourceText} => expected ${expected}, got ${result.verdict}`,
            );
          }
        }

        expect(
          failures,
          `${fileName} (through grain mesh): ${failures.length}/${file.assertions.length} assertion(s) failed:\n${failures.join("\n")}`,
        ).toEqual([]);
      } finally {
        await cluster.dispose();
      }
    }, 120_000);
  }
});
