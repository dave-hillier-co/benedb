import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import type { IRevision } from "@benedb/core/i-revision";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import type { FoundSubject } from "@benedb/engine/found-subject";
import { LookupSubjectsEngine } from "@benedb/engine/lookup-subjects-engine";
import { compileSchema } from "@benedb/schema/schema-compiler";

import { loadResolvedValidationFile } from "./validation-file-loader";
import {
  expectedSubjectSubject,
  isExpectedSubjectCaveated,
  type ExpectedSubject,
} from "./validation-model";

/**
 * Cross-checks every `validation:` block in the main conformance corpus (Quarantine excluded)
 * against {@link LookupSubjectsEngine} over the {@link ReferenceDatastore} oracle. For each
 * `resource#permission` key the parsed expected-subjects set (concrete subjects,
 * subject-with-relation, wildcard and caveated markers, per SpiceDB's
 * `pkg/validationfile/blocks` grammar - see `validation-file-loader.ts`) must equal the actual
 * subject set the engine reports, following the same LookupSubjects usage pattern as the
 * reverse-consistency cross-check.
 *
 * As of the SpiceDB v1.44.2 vendoring, none of the pre-existing corpus files (nor the upstream
 * files considered for addition) carry a POPULATED `validation:` block - the upstream
 * integration-testing corpus at this tag exclusively uses assertTrue/assertFalse/assertCaveated.
 * `arrowsublr.yaml` declares `validation: {}` and `multiplepathssamelookupresult.yaml` declares
 * `validation: null`; both parse to zero entries. This suite is therefore a no-op today (0 files
 * exercised) but exists so that a future re-vendor which reintroduces validation blocks is
 * asserted automatically rather than silently ignored.
 *
 * Ported from Spiceport `tests/Spiceport.Conformance.Tests/ValidationBlockTests.cs`.
 *
 * Port decisions:
 *   * The C# is deliberately ONE `[Fact]` that iterates internally rather than a
 *     `[Theory]`/`[MemberData]` enumeration, because an empty MemberData set is itself an xUnit
 *     failure ("No data found") and would make the suite brittle to the expected, documented
 *     zero-files case. Vitest's `it.each([])` has the same problem (an empty table produces no
 *     test at all, so the suite would silently vanish), so the single-`it` shape is kept verbatim
 *     rather than "improved" into a table.
 *   * `Directory.EnumerateFiles(dir, "*.yaml")` is NON-recursive, which is what excludes the
 *     `Quarantine` and `LoaderSuite` subdirectories; `readdirSync` with `withFileTypes` reproduces
 *     that. `.OrderBy(p => p, StringComparer.Ordinal)` is a bare `.sort()`: JavaScript's default
 *     comparator is UTF-16 code-unit order, i.e. ordinal.
 *   * `ComparableSubject` is a `record struct` in a `HashSet`, so per the port guide it becomes a
 *     `Set` over a canonical, length-prefixed key. `ISet.SetEquals` becomes an explicit
 *     size-plus-membership comparison; there is no built-in.
 *   * `.GroupBy(s => (s.Subject.ObjectType, s.Subject.Relation))` groups on a value tuple. The
 *     guide's `Map.groupBy` substitution is unavailable here - it is ES2024 and this repo's
 *     `lib` is ES2022 - so {@link groupByTypeAndRelation} hand-rolls it over a `Map`, keyed by a
 *     length-prefixed string and carrying the (type, relation) pair in the group value rather
 *     than re-parsing it out of the key. First-seen group order matches LINQ's.
 *   * INHERITED ASYMMETRY, preserved verbatim: `ToComparableSet(IEnumerable<ExpectedSubject>)`
 *     flattens a wildcard term's `Exceptions` INTO the expected set, while
 *     `ToComparableSet(IEnumerable<FoundSubject>)` reads only `SubjectId` and never walks
 *     `FoundSubject.ExcludedSubjects`. So an entry written as
 *     `"[test/user:* - {test/user:somegal}]"` expects `{*, somegal}` but the engine reports the
 *     single wildcard `*` carrying `excludedSubjects: [somegal]`, and the comparison fails even
 *     though both sides describe the same subject set. This is latent in the C# too (it has zero
 *     validation blocks to exercise it) and is NOT re-litigated here: transliterate, do not
 *     redesign. The first re-vendored corpus file with a wildcard exclusion will surface it.
 *   * The failure lines render each `ComparableSubject` as `id` / `id[...]` instead of C#'s
 *     generated `ComparableSubject { ObjectId = ..., IsCaveated = ... }`. The text is diagnostic
 *     only - the assertion is on `failures.length` - and the caveat marker is spelled the way the
 *     corpus grammar spells it.
 */

const dir = fileURLToPath(new URL("../corpus", import.meta.url));

/** A subject/caveated pair normalised for set comparison; `"*"` denotes the wildcard. */
interface ComparableSubject {
  readonly objectId: string;
  readonly isCaveated: boolean;
}

it("ValidationBlock subjects match LookupSubjects", async () => {
  const failures: string[] = [];
  let filesChecked = 0;
  let entriesChecked = 0;

  for (const fileName of yamlFileNames(dir)) {
    const path = join(dir, fileName);
    const file = loadResolvedValidationFile(path);
    if (file.validations.length === 0) {
      continue;
    }

    filesChecked++;
    const compiled = compileSchema(file.schemaText);
    const lookupSubjects = new LookupSubjectsEngine(compiled.namespaces);

    const datastore = new ReferenceDatastore();
    const revision = await loadRelationships(datastore, file.relationships);
    const reader = datastore.snapshotReader(revision);

    for (const entry of file.validations) {
      entriesChecked++;

      // Group expected subjects by (type, relation): LookupSubjects is queried per subject
      // type/relation pair, mirroring how each is independently reported.
      const byTypeAndRelation = groupByTypeAndRelation(entry.expectedSubjects);

      for (const [subjectType, subjectRelation, group] of byTypeAndRelation) {
        const found = await collect(
          lookupSubjects.lookupSubjects(
            reader,
            entry.objectAndRelation,
            subjectType,
            subjectRelation,
          ),
        );

        const actual = foundToComparableSet(found);
        const expected = expectedToComparableSet(group);

        if (!setEquals(actual, expected)) {
          const onr = entry.objectAndRelation;
          const key = `${onr.objectType}:${onr.objectId}#${onr.relation}`;
          failures.push(
            `  ${fileName}: ${key} (${subjectType}#${subjectRelation}): expected [${render(expected)}], ` +
              `got [${render(actual)}]`,
          );
        }
      }
    }
  }

  expect(
    failures.length,
    `${filesChecked} file(s) / ${entriesChecked} entries checked; ${failures.length} mismatch(es):\n${failures.join("\n")}`,
  ).toBe(0);
});

/** The `*.yaml` files directly in `dir`, in ordinal order. Subdirectories are not descended. */
function yamlFileNames(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".yaml"))
    .map((e) => e.name)
    .sort();
}

/**
 * `.GroupBy(s => (s.Subject.ObjectType, s.Subject.Relation))`, preserving first-seen group order
 * as LINQ does. The key is length-prefixed for injectivity, and the (type, relation) pair is
 * carried in the group rather than re-parsed out of the key.
 */
function groupByTypeAndRelation(
  subjects: readonly ExpectedSubject[],
): readonly (readonly [string, string, readonly ExpectedSubject[]])[] {
  const groups = new Map<string, [string, string, ExpectedSubject[]]>();
  for (const subject of subjects) {
    const onr: ObjectAndRelation = expectedSubjectSubject(subject);
    const key = `${onr.objectType.length}:${onr.objectType}:${onr.relation.length}:${onr.relation}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = [onr.objectType, onr.relation, []];
      groups.set(key, group);
    }
    group[2].push(subject);
  }

  return [...groups.values()];
}

/** The canonical `Set` key for a {@link ComparableSubject}, replacing C# record-struct equality. */
function comparableKey(subject: ComparableSubject): string {
  return `${subject.objectId.length}:${subject.objectId}:${String(subject.isCaveated)}`;
}

function foundToComparableSet(
  found: readonly FoundSubject[],
): ReadonlyMap<string, ComparableSubject> {
  const set = new Map<string, ComparableSubject>();
  for (const f of found) {
    add(set, { objectId: f.subjectId, isCaveated: f.caveat !== undefined });
  }

  return set;
}

function expectedToComparableSet(
  expected: readonly ExpectedSubject[],
): ReadonlyMap<string, ComparableSubject> {
  const set = new Map<string, ComparableSubject>();
  for (const subject of expected) {
    add(set, {
      objectId: expectedSubjectSubject(subject).objectId,
      isCaveated: isExpectedSubjectCaveated(subject),
    });
    for (const exception of subject.exceptions) {
      add(set, { objectId: exception.subject.objectId, isCaveated: exception.isCaveated });
    }
  }

  return set;
}

function add(set: Map<string, ComparableSubject>, subject: ComparableSubject): void {
  set.set(comparableKey(subject), subject);
}

function setEquals(
  a: ReadonlyMap<string, ComparableSubject>,
  b: ReadonlyMap<string, ComparableSubject>,
): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) {
    if (!b.has(key)) return false;
  }

  return true;
}

function render(set: ReadonlyMap<string, ComparableSubject>): string {
  return [...set.values()].map((s) => `${s.objectId}${s.isCaveated ? "[...]" : ""}`).join(", ");
}

async function collect(source: AsyncIterable<FoundSubject>): Promise<FoundSubject[]> {
  const list: FoundSubject[] = [];
  for await (const item of source) {
    list.push(item);
  }

  return list;
}

async function loadRelationships(
  datastore: ReferenceDatastore,
  relationships: readonly Relationship[],
): Promise<IRevision> {
  if (relationships.length === 0) {
    const head = await datastore.headRevision();
    return head.revision;
  }

  const updates: readonly RelationshipUpdate[] = relationships.map((r) => ({
    relationship: r,
    operation: "create",
  }));

  return await datastore.readWriteTx(async (tx) => {
    await tx.writeRelationships(updates);
  });
}
