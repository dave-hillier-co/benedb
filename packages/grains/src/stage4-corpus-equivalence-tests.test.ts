import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import { loadValidationFile } from "@benedb/conformance/validation-file-loader";
import { PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import type { FoundResource } from "@benedb/engine/found-resource";
import { LookupResourcesEngine } from "@benedb/engine/lookup-resources-engine";
import type { Membership } from "@benedb/engine/membership";
import { buildMembershipCoverage } from "@benedb/engine/membership-coverage";
import { localClosure, toCoveredCandidates } from "@benedb/engine/membership-walk";
import { compileSchema } from "@benedb/schema/schema-compiler";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/Stage4CorpusEquivalenceTests.cs`.
 *
 * Stage-4 NON-NEGOTIABLE conformance gate: across the ENTIRE SpiceDB conformance corpus, the
 * Leopard membership-walk accelerator (`buildMembershipCoverage` + `localClosure`) must not change
 * a single LookupResources verdict. For every file, every assertion's
 * (subject, resource-type, permission) is run through `LookupResourcesEngine` twice - once with the
 * walked candidate set, once without - and the (resource id, membership) result sets must be
 * identical. Run at the engine level (no grains) so the whole corpus sweeps in seconds. This is the
 * walk-based replacement for the retired flattened-index equivalence gate; VERDICT-level comparison
 * is unchanged (candidate-set comparison would be a weakening - deliberately not done here).
 *
 * PORT NOTES.
 *  - `AppContext.BaseDirectory/TestData` is the vendored corpus at `packages/conformance/corpus`,
 *    resolved through the `@benedb/conformance` package the way the other ported corpus suites do.
 *  - `Directory.EnumerateFiles(dir, "*.yaml")` is non-recursive, hence the `isFile()` filter (the
 *    corpus tree also holds `LoaderSuite/` and `Quarantine/` directories), and
 *    `.OrderBy(p => p, StringComparer.Ordinal)` is JavaScript's DEFAULT `Array.prototype.sort()`
 *    (UTF-16 code units). `localeCompare` is a DIFFERENT order and is deliberately not used.
 *  - `[MemberData]` -> one `it` per file with the file name in the title, so a failure names the
 *    row (vitest does not derive case names from arguments).
 *  - THE TUPLE-DISTINCT TRAP. The C# `shapes` is `.Distinct()` over a `ValueTuple` that includes
 *    `a.CaveatContext`; tuple VALUE equality has no TypeScript counterpart, and `new Set(objects)`
 *    would dedupe nothing. The dedup key here is therefore built explicitly and is
 *    UNCONDITIONALLY INJECTIVE: every string field is length-prefixed and the context is rendered
 *    as canonical JSON with map/object keys sorted at every depth. A `join('/')` key is not
 *    injective over ids that contain the separator.
 *    (The C# compares the DICTIONARY by reference here, so two assertions with equal-but-distinct
 *    context dictionaries stay separate shapes in C# and merge here. Merging only removes a
 *    duplicate run of an identical query - it cannot hide a mismatch - so the stronger,
 *    value-based key is kept.)
 */

const requireFromHere = createRequire(import.meta.url);

/** The vendored corpus directory, resolved relative to the `@benedb/conformance` package. */
const CORPUS_DIR = resolvePath(
  dirname(requireFromHere.resolve("@benedb/conformance/validation-file-loader")),
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

/** Length-prefixed so the concatenation is injective regardless of what the fields contain. */
function part(value: string): string {
  return `${value.length}:${value}`;
}

/** Canonical JSON with keys sorted at EVERY depth, so equal contexts render identically. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (value instanceof Map) {
    const entries = [...value.entries()].map(
      ([k, v]) => [String(k), v] as readonly [string, unknown],
    );
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `{${entries.map(([k, v]) => `${part(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return `{${entries.map(([k, v]) => `${part(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  return `${typeof value}:${JSON.stringify(value)}`;
}

/** One distinct (subject, resourceType, permission, context) shape. */
interface Shape {
  readonly subject: ObjectAndRelation;
  readonly resourceType: string;
  readonly permission: string;
  readonly context: ReadonlyMap<string, unknown> | undefined;
}

function shapeKey(shape: Shape): string {
  return [
    part(shape.subject.objectType),
    part(shape.subject.objectId),
    part(shape.subject.relation),
    part(shape.resourceType),
    part(shape.permission),
    canonicalJson(shape.context),
  ].join("");
}

/** Collapse a result stream to one verdict per resource id (Member dominates Caveated). */
async function collect(e: AsyncIterable<FoundResource>): Promise<Map<string, Membership>> {
  const map = new Map<string, Membership>();
  for await (const f of e) {
    const existing = map.get(f.resourceId);
    if (existing === undefined || (existing === "caveated" && f.membership === "member")) {
      map.set(f.resourceId, f.membership);
    }
  }
  return map;
}

function render(d: ReadonlyMap<string, Membership>): string {
  return [...d.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}:${v}`)
    .join(",");
}

describe("Stage4CorpusEquivalenceTests", () => {
  const files = corpusFiles();

  // Enumerating from disk is only a gate if the enumeration itself found something: an empty corpus
  // directory would otherwise register zero cases and pass vacuously.
  it("enumerates the corpus from disk", () => {
    expect(files.length, `no corpus files enumerated from ${CORPUS_DIR}`).toBeGreaterThan(0);
  });

  for (const fileName of files) {
    it(`WalkOn_EqualsWalkOff_ForEveryAssertionShape(${fileName})`, async () => {
      const path = join(CORPUS_DIR, fileName);
      const file = loadValidationFile(path);

      const compiled = compileSchema(file.schemaText);
      const engine = new LookupResourcesEngine(compiled.namespaces, compiled.caveats);
      const coverage = buildMembershipCoverage(compiled.namespaces);

      const store = new ReferenceDatastore();
      const updates: readonly RelationshipUpdate[] = file.relationships.map((relationship) => ({
        relationship,
        operation: "create",
      }));
      const rev = await store.readWriteTx((tx) => tx.writeRelationships(updates));
      const reader = store.snapshotReader(rev);

      // Distinct (subject, resourceType, permission, context) shapes drawn from the file's
      // assertions.
      const shapes = new Map<string, Shape>();
      for (const assertion of file.assertions) {
        const shape: Shape = {
          subject: assertion.subject,
          resourceType: assertion.resource.objectType,
          permission: assertion.resource.relation,
          context: assertion.caveatContext,
        };
        const key = shapeKey(shape);
        if (!shapes.has(key)) shapes.set(key, shape);
      }

      const mismatches: string[] = [];
      for (const { subject, resourceType, permission, context } of shapes.values()) {
        if (subject.objectId === PUBLIC_WILDCARD) {
          continue; // a wildcard subject is not a concrete LookupResources query
        }

        const live = await collect(
          engine.lookupResourcesWithCandidates(
            reader,
            subject.objectType,
            subject.objectId,
            subject.relation,
            resourceType,
            permission,
            undefined,
            context,
          ),
        );

        let candidates: readonly string[] | undefined;
        const yields = coverage.tryGetYields(resourceType, permission);
        if (yields !== undefined) {
          const nodes = await localClosure(reader, coverage, {
            type: subject.objectType,
            id: subject.objectId,
            relation: subject.relation,
          });
          candidates = toCoveredCandidates(
            nodes,
            yields,
            resourceType,
            subject.objectType,
            subject.objectId,
          );
        }

        const walked = await collect(
          engine.lookupResourcesWithCandidates(
            reader,
            subject.objectType,
            subject.objectId,
            subject.relation,
            resourceType,
            permission,
            candidates,
            context,
          ),
        );

        // Compare the per-resource collapsed verdict. The live engine has NO global dedup (it may
        // emit a resource once per entrypoint); the walked path Checks each id once. A duplicate is
        // not a verdict change, so both are collapsed by id (Member dominates Caveated) before
        // comparing.
        if (
          live.size !== walked.size ||
          [...live.entries()].some(([id, m]) => walked.get(id) !== m)
        ) {
          mismatches.push(
            `  ${subject.objectType}:${subject.objectId}#${subject.relation} -> ${resourceType}#${permission}: ` +
              `live=[${render(live)}] walked=[${render(walked)}]`,
          );
        }
      }

      expect(
        mismatches,
        `${fileName}: the walk-based accelerator changed ${mismatches.length} LookupResources verdict(s):\n${mismatches.join("\n")}`,
      ).toEqual([]);
    }, 60_000);
  }
});
