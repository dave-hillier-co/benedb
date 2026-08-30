import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import { loadValidationFile } from "@spacedb/conformance/validation-file-loader";
import type { ValidationFile } from "@spacedb/conformance/validation-model";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import { CaveatEvaluator } from "@spacedb/engine/caveat-evaluator";
import { LookupSubjectsEngine } from "@spacedb/engine/lookup-subjects-engine";
import type { CompiledSchema } from "@spacedb/schema/compiled-schema";
import { compileSchema } from "@spacedb/schema/schema-compiler";

import { MeshTestCluster } from "./mesh-test-cluster";
import { tryCollapse } from "./reverse-ops-support";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/FrontierCorpusEquivalenceTests.cs`.
 *
 * NON-NEGOTIABLE equivalence gate for the `SubjectFrontierGrain` memo: across the entire SpiceDB
 * conformance corpus, every LookupSubjects-shaped assertion (resource, permission, subject type)
 * must yield the IDENTICAL `streamLookupSubjects` result set whether the memo is consulted or not.
 *
 * Mirrors `stage4-corpus-equivalence-tests.test.ts`' on==off gate shape, adapted to a grain-hosted
 * memo: that test avoids the mesh entirely because its accelerator (the Leopard walk) lives at the
 * engine level, so both sides can run in-process over a `ReferenceDatastore`. This memo instead
 * lives on `SubjectFrontierGrain`, so the "on" side genuinely needs ONE real mesh
 * (`MeshTestCluster`, memo enabled - the production default) driving
 * `ReverseOps.streamLookupSubjects`. The "off" side does not need a SECOND cluster: disabling the
 * memo makes `ReverseOps` fall back to running `LookupSubjectsEngine` directly and collapsing with
 * `CaveatEvaluator` via `reverseOpsSupport.tryCollapse` - exactly what this test computes
 * in-process over a `ReferenceDatastore` seeded with the same relationships, so it is a faithful
 * "off" baseline without paying for a second cluster per file.
 *
 * PORT NOTES.
 *  - ONE real cluster PER CORPUS FILE, because each file declares its own schema and the silo
 *    compiles it at startup. That is deliberate and expensive; each case therefore carries an
 *    explicit long timeout (the `unit` project's default is 5s) and disposes its cluster in a
 *    `finally` - a leaked cluster is worse than a slow one.
 *  - `AppContext.BaseDirectory/TestData` is the vendored corpus at `packages/conformance/corpus`;
 *    `.OrderBy(p => p, StringComparer.Ordinal)` is the BARE `Array.prototype.sort()` (UTF-16 code
 *    units), never `localeCompare`.
 *  - `readonly record struct Found` is used in a `HashSet` and compared with `SetEquals`. A
 *    TypeScript `Set` of objects compares by REFERENCE, so each side is a `Map` from an
 *    UNCONDITIONALLY INJECTIVE canonical string key (the subject id length-prefixed, then the two
 *    flags) to the `Found` itself: the key carries the value equality `SetEquals` needs, and
 *    keeping the `Found` lets `Render` still report the C#'s `id(w=..,c=..)` form ordered
 *    ordinally by subject id.
 *  - `shapes` is `.Distinct()` over a `ValueTuple`, which has no TypeScript counterpart: the dedup
 *    key is built explicitly and length-prefixed, exactly as in the stage-4 corpus suite.
 *  - `if (shapes.Count == 0) return;` stays an in-test RETURN, not a skipped case: it is a
 *    vacuously-passing file, not an unrun one.
 */

const requireFromHere = createRequire(import.meta.url);

/** The vendored corpus directory, resolved relative to the `@spacedb/conformance` package. */
const CORPUS_DIR = resolvePath(
  dirname(requireFromHere.resolve("@spacedb/conformance/validation-file-loader")),
  "..",
  "corpus",
);

/** The C# `CorpusFiles`: every top-level `*.yaml`, ordinal-ordered. */
function corpusFiles(): readonly string[] {
  return readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();
}

/** Length-prefixed so every concatenated key is injective regardless of field contents. */
function part(value: string): string {
  return `${value.length}:${value}`;
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

/** The C# `Found` record struct. */
interface Found {
  readonly subjectId: string;
  readonly isWildcard: boolean;
  readonly isCaveated: boolean;
}

/**
 * The canonical key standing in for `Found`'s VALUE equality inside a `HashSet`: a TypeScript `Set`
 * of objects compares by reference, so both sides are keyed on this instead. Length-prefixing the
 * id keeps the key injective whatever the id contains.
 */
function foundKey(found: Found): string {
  return `${part(found.subjectId)}|${found.isWildcard}|${found.isCaveated}`;
}

/** Both sides as key -> `Found`, so `Render` can still report the C#'s field-wise form. */
type FoundSet = Map<string, Found>;

function addFound(set: FoundSet, found: Found): void {
  set.set(foundKey(found), found);
}

/** The C# `StreamViaMesh`. */
async function streamViaMesh(
  cluster: MeshTestCluster,
  resourceType: string,
  resourceId: string,
  permission: string,
  subjectType: string,
): Promise<FoundSet> {
  const result: FoundSet = new Map();
  for await (const item of cluster.reverseOps.streamLookupSubjects({
    resourceType,
    resourceId,
    permission,
    subjectType,
    subjectRelation: ELLIPSIS,
    context: undefined,
    limit: undefined,
    cursor: undefined,
  })) {
    addFound(result, {
      subjectId: item.subject.subjectId,
      isWildcard: item.subject.isWildcard,
      isCaveated: item.subject.permissionship.isCaveated,
    });
  }
  return result;
}

/**
 * The C# `StreamViaEngineDirectly` - the memo-OFF baseline: the identical computation
 * `ReverseOps.streamLookupSubjects` runs when the frontier memo is disabled (a direct
 * `LookupSubjectsEngine` walk collapsed against a null request context via `tryCollapse`),
 * computed in-process over a `ReferenceDatastore`.
 */
async function streamViaEngineDirectly(
  schema: CompiledSchema,
  datastore: ReferenceDatastore,
  resourceType: string,
  resourceId: string,
  permission: string,
  subjectType: string,
): Promise<FoundSet> {
  const head = await datastore.headRevision();
  const reader = datastore.snapshotReader(head.revision);
  const engine = new LookupSubjectsEngine(schema.namespaces);
  const evaluator = new CaveatEvaluator(schema.caveats);
  const resource: ObjectAndRelation = {
    objectType: resourceType,
    objectId: resourceId,
    relation: permission,
  };

  const result: FoundSet = new Map();
  for await (const found of engine.lookupSubjects(reader, resource, subjectType)) {
    const collapsed = tryCollapse(found.caveat, undefined, evaluator);
    if (!collapsed.included) continue;
    addFound(result, {
      subjectId: found.subjectId,
      isWildcard: found.isWildcard,
      isCaveated: collapsed.permissionship.isCaveated,
    });
  }
  return result;
}

/** One distinct LookupSubjects shape. */
interface Shape {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly permission: string;
  readonly subjectType: string;
}

function shapeKey(shape: Shape): string {
  return (
    part(shape.resourceType) +
    part(shape.resourceId) +
    part(shape.permission) +
    part(shape.subjectType)
  );
}

/** The C# `HashSet<Found>.SetEquals`, over the canonical keys. */
function setsEqual(a: FoundSet, b: FoundSet): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}

/** The C# `Render`: `subjectId(w=..,c=..)`, ordinal-ordered by subject id. */
function render(set: FoundSet): string {
  return [...set.values()]
    .sort((x, y) => (x.subjectId < y.subjectId ? -1 : x.subjectId > y.subjectId ? 1 : 0))
    .map((f) => `${f.subjectId}(w=${f.isWildcard},c=${f.isCaveated})`)
    .join(",");
}

describe("FrontierCorpusEquivalenceTests", () => {
  const files = corpusFiles();

  // Enumerating from disk is only a gate if the enumeration itself found something: an empty corpus
  // directory would otherwise register zero cases and pass vacuously.
  it("enumerates the corpus from disk", () => {
    expect(files.length, `no corpus files enumerated from ${CORPUS_DIR}`).toBeGreaterThan(0);
  });

  for (const fileName of files) {
    it(`MemoOn_EqualsMemoOff_ForEveryLookupSubjectsShape(${fileName})`, async () => {
      const path = join(CORPUS_DIR, fileName);
      const file = loadValidationFile(path);

      // Distinct (resourceType, resourceId, permission, subjectType) shapes drawn from the file's
      // assertions - every assertion names a concrete subject, so its (type) is a LookupSubjects
      // shape worth sweeping (the exact subjectId does not matter: LookupSubjects enumerates ALL
      // holders of that type, so many assertions collapse onto the same shape).
      const shapes = new Map<string, Shape>();
      for (const assertion of file.assertions) {
        const shape: Shape = {
          resourceType: assertion.resource.objectType,
          resourceId: assertion.resource.objectId,
          permission: assertion.resource.relation,
          subjectType: assertion.subject.objectType,
        };
        const key = shapeKey(shape);
        if (!shapes.has(key)) shapes.set(key, shape);
      }

      if (shapes.size === 0) return;

      const cluster = await MeshTestCluster.create(file.schemaText, {
        useSubjectFrontierMemo: true,
      });
      try {
        await seed(cluster.datastore, file);

        const compiled = compileSchema(file.schemaText);
        const reference = new ReferenceDatastore();
        await seed(reference, file);

        const mismatches: string[] = [];
        for (const { resourceType, resourceId, permission, subjectType } of shapes.values()) {
          const withMemo = await streamViaMesh(
            cluster,
            resourceType,
            resourceId,
            permission,
            subjectType,
          );
          const withoutMemo = await streamViaEngineDirectly(
            compiled,
            reference,
            resourceType,
            resourceId,
            permission,
            subjectType,
          );

          if (!setsEqual(withMemo, withoutMemo)) {
            mismatches.push(
              `  ${resourceType}:${resourceId}#${permission} -> ${subjectType}: ` +
                `on=[${render(withMemo)}] off=[${render(withoutMemo)}]`,
            );
          }
        }

        expect(
          mismatches,
          `${fileName}: frontier memo changed ${mismatches.length} LookupSubjects result set(s):\n${mismatches.join("\n")}`,
        ).toEqual([]);
      } finally {
        await cluster.dispose();
      }
    }, 180_000);
  }
});
