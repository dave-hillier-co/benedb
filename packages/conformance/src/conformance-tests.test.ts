import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { IRevision } from "@spacedb/core/i-revision";
import type { Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import { CheckEngine } from "@spacedb/engine/check-engine";
import type { CheckResult } from "@spacedb/engine/membership";
import { compileSchema } from "@spacedb/schema/schema-compiler";

import { loadResolvedValidationFile } from "./validation-file-loader";
import { assertionExpectedMembership, type ParsedAssertion } from "./validation-model";
import type { ValidationFile } from "./validation-model";

/**
 * SpiceDB consistency/validation conformance harness, ported from Spiceport
 * `tests/Spiceport.Conformance.Tests/ConformanceTests.cs`.
 *
 * For every YAML corpus file it compiles the schema (yielding namespace AND caveat
 * definitions), loads the relationships (with caveat context + expiration) into a backend,
 * and runs every assertion through the {@link CheckEngine}, comparing the engine's membership
 * verdict against the file's expected outcome (assertTrue -> member, assertFalse -> notMember,
 * assertCaveated -> caveated).
 *
 * Port notes:
 *   * The C# reads `TestData`; here the same tree is vendored at `corpus`. Only the top-level
 *     `*.yaml` files are the corpus - `Directory.EnumerateFiles` is non-recursive, so
 *     `corpus/LoaderSuite` (which drives `validation-loader-suite.test.ts`) and
 *     `corpus/Quarantine` are outside it here for the same reason.
 *   * `[Theory]` + `[MemberData]` becomes a `for` loop of `it` cases rather than `it.each`, so
 *     that the SkippableFact mechanism below can be applied per file.
 *   * `Xunit.SkippableFact`'s `Skip.If` becomes `it.skipIf`, per the port guide.
 *   * `StringComparer.Ordinal` ordering is JavaScript's default `Array.prototype.sort`, which
 *     compares UTF-16 code units - the same order for this ASCII corpus.
 *   * The C# drives the corpus over the reference datastore only in this class; Spiceport's
 *     second, grain-mesh run lives in its own harness. The body here is written against the
 *     {@link ConformanceBackend} seam so the mesh run is a second entry in {@link BACKENDS}
 *     rather than a copy of the body. Only the reference backend exists until S4 lands
 *     `@spacedb/grains`.
 */

/**
 * Files that cannot be run faithfully and the precise reason. A file is only listed here when
 * its expected outcome depends on a specific evaluation "now" that we cannot derive from the
 * file. The expiration files in this suite all use far-past (<=2024) versus far-future (>=2200)
 * timestamps, so the real wall clock falls unambiguously between them and is a faithful "now";
 * they are therefore NOT skipped.
 */
const SKIP_REASONS: ReadonlyMap<string, string> = new Map<string, string>();

const corpusDir = fileURLToPath(new URL("../corpus", import.meta.url));

/** The C# `AllYamlFiles`: every top-level `*.yaml` in the corpus, ordinal-ordered. */
function allYamlFiles(): readonly string[] {
  return readdirSync(corpusDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * A checker bound to one loaded corpus file: the schema is compiled and the relationships are
 * written, and each assertion is answered against that snapshot.
 */
interface ConformanceChecker {
  check(assertion: ParsedAssertion): Promise<CheckResult>;
}

/**
 * One way of answering a corpus file's assertions. The reference datastore is the only backend
 * until `@spacedb/grains` exists; the grain mesh becomes a second element of {@link BACKENDS}
 * and re-runs this file's body unchanged.
 */
interface ConformanceBackend {
  readonly name: string;
  prepare(file: ValidationFile): Promise<ConformanceChecker>;
}

const referenceBackend: ConformanceBackend = {
  name: "reference",
  async prepare(file: ValidationFile): Promise<ConformanceChecker> {
    const compiled = compileSchema(file.schemaText);
    const engine = new CheckEngine(compiled.namespaces, compiled.caveats);

    const datastore = new ReferenceDatastore();
    const revision = await loadRelationships(datastore, file.relationships);
    const reader = datastore.snapshotReader(revision);

    return {
      check: (assertion) =>
        engine.check(
          reader,
          assertion.resource.objectType,
          assertion.resource.objectId,
          assertion.resource.relation,
          assertion.subject,
          assertion.caveatContext,
        ),
    };
  },
};

/** The C# `LoadRelationships`. */
async function loadRelationships(
  datastore: ReferenceDatastore,
  relationships: readonly Relationship[],
): Promise<IRevision> {
  if (relationships.length === 0) {
    const head = await datastore.headRevision();
    return head.revision;
  }

  const updates: readonly RelationshipUpdate[] = relationships.map((relationship) => ({
    relationship,
    operation: "create",
  }));

  return datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

const BACKENDS: readonly ConformanceBackend[] = [referenceBackend];

for (const backend of BACKENDS) {
  describe(`Conformance (${backend.name})`, () => {
    for (const fileName of allYamlFiles()) {
      it(fileName, async (ctx) => {
        // `Skip.If(..., $"{fileName}: {reason}")`: the reason string is the whole point of
        // SKIP_REASONS, so it must reach the report. `it.skipIf` takes no reason and would
        // silently drop it, leaving a corpus file quarantined for an unrecorded cause.
        const reason = SKIP_REASONS.get(fileName);
        if (reason !== undefined) {
          ctx.skip(true, `${fileName}: ${reason}`);
        }

        const file = loadResolvedValidationFile(join(corpusDir, fileName));
        const checker = await backend.prepare(file);

        const failures: string[] = [];
        for (const assertion of file.assertions) {
          const result = await checker.check(assertion);

          const expected = assertionExpectedMembership(assertion);
          if (result.verdict !== expected) {
            const missing =
              result.missingExprFields.length > 0
                ? ` [missing: ${result.missingExprFields.join(", ")}]`
                : "";
            failures.push(
              `  ${assertion.sourceText} => expected ${expected}, got ${result.verdict}${missing}`,
            );
          }
        }

        expect(
          failures,
          `${fileName}: ${failures.length}/${file.assertions.length} assertion(s) failed:\n${failures.join("\n")}`,
        ).toEqual([]);
      });
    }
  });
}
