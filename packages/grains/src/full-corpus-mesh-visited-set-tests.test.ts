import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import { loadValidationFile } from "@benedb/conformance/validation-file-loader";
import { assertionExpectedMembership } from "@benedb/conformance/validation-model";
import type { Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import type { IDatastore } from "@benedb/datastore/i-datastore";

import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/FullCorpusMeshVisitedSetTests.cs`.
 *
 * The MANDATORY exact-visited-set-correctness gate: the ENTIRE SpiceDB conformance corpus (every
 * YAML file, including the recursive schemas) is replayed through the REAL multi-silo grain mesh
 * with the exact visited set as the cycle guard. Every expected member / notMember / caveated
 * verdict must match exactly - proving the exact set never false-cuts the corpus: a spurious
 * cycle-cut that flipped a verdict or starved the memo would surface as a corpus mismatch.
 *
 * This is stronger than `conformance-mesh-tests.test.ts` (a representative 8-file subset on a
 * single silo): here the full corpus runs across a 3-SILO cluster, so sub-problems genuinely cross
 * grain boundaries and the visited set genuinely travels on the wire. If any file regresses there
 * is a real bug in the loop-bypass or memo wiring; it fails loudly rather than silently shrinking
 * corpus coverage.
 *
 * PORT NOTES.
 *  - The file list is ENUMERATED FROM DISK, never hardcoded, so a newly added corpus file is picked
 *    up automatically. `Directory.EnumerateFiles(dir, "*.yaml")` is non-recursive, hence the
 *    `isFile()` filter (the corpus tree also holds `LoaderSuite/` and `Quarantine/` directories).
 *  - `.OrderBy(p => p, StringComparer.Ordinal)` is JavaScript's DEFAULT `Array.prototype.sort()`,
 *    which compares UTF-16 code units. `localeCompare` would NOT be the same order and is
 *    deliberately not used.
 *  - One 3-silo cluster is built PER FILE, because each file declares its own schema and the silo
 *    compiles it at startup. This is by far the most expensive suite in the stage; sharing a cluster
 *    across files, sampling the list, excluding the recursive schemas or dropping to one silo would
 *    each delete the property the suite exists to prove.
 *  - Same accumulate-then-assert-once failure reporting as `ConformanceMeshTests`.
 */

const requireFromHere = createRequire(import.meta.url);

/** The vendored corpus directory, resolved relative to the `@benedb/conformance` package. */
const CORPUS_DIR = resolvePath(
  dirname(requireFromHere.resolve("@benedb/conformance/validation-file-loader")),
  "..",
  "corpus",
);

/** The C# `AllCorpusFiles`: every top-level `*.yaml`, ordinal-ordered. */
function allCorpusFiles(): readonly string[] {
  return readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();
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

describe("FullCorpusMeshVisitedSetTests", () => {
  const files = allCorpusFiles();

  // Enumerating from disk is only a gate if the enumeration itself found something: an empty corpus
  // directory would otherwise register zero cases and pass vacuously.
  it("enumerates the corpus from disk", () => {
    expect(files.length, `no corpus files enumerated from ${CORPUS_DIR}`).toBeGreaterThan(0);
  });

  for (const fileName of files) {
    it(`Full_corpus_through_multisilo_mesh_with_visited_set(${fileName})`, async () => {
      const path = join(CORPUS_DIR, fileName);
      expect(existsSync(path), `Corpus file missing from output: ${path}`).toBe(true);

      const file = loadValidationFile(path);

      // 3 silos + the exact visited set: a check recurses across grains, and the cycle guard
      // crosses every grain boundary as the visited set.
      const cluster = await MeshTestCluster.createMultiSilo(file.schemaText, 3);
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
          `${fileName} (full corpus, 3-silo mesh, visited set): ${failures.length}/${file.assertions.length} assertion(s) failed:\n${failures.join("\n")}`,
        ).toEqual([]);
      } finally {
        await cluster.dispose();
      }
    }, 180_000);
  }
});
