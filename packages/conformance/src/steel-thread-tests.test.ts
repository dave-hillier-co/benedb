import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { formatRelationship, parseRelationship } from "@benedb/core/tuple-strings";
import type { IDatastoreReader } from "@benedb/datastore/i-datastore";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import type { RelationshipsFilter } from "@benedb/datastore/relationships-filter";
import { SUBJECT_RELATION_FILTER_ANY } from "@benedb/datastore/relationships-filter";
import { CheckEngine } from "@benedb/engine/check-engine";
import type { FoundResource } from "@benedb/engine/found-resource";
import type { FoundSubject } from "@benedb/engine/found-subject";
import type { LookupResourcesCursor } from "@benedb/engine/lookup-resources-cursor";
import { LookupResourcesEngine } from "@benedb/engine/lookup-resources-engine";
import { LookupSubjectsEngine } from "@benedb/engine/lookup-subjects-engine";
import type { Membership } from "@benedb/engine/membership";
import { SchemaWriteValidationException } from "@benedb/grains/schema-write-validation-exception";
import { validate } from "@benedb/grains/schema-change-validator";
import type { CompiledSchema } from "@benedb/schema/compiled-schema";
import { compileSchema } from "@benedb/schema/schema-compiler";

import { loadValidationFile } from "./validation-file-loader";

/**
 * Differential suite over SpiceDB's steelthreadtesting corpus, ported from Spiceport
 * `tests/Spiceport.Conformance.Tests/SteelThread/SteelThreadTests.cs`. Each case names a datafile
 * and a list of operations; the golden outputs (steelresults/*.yaml) are reproduced through
 * BeneDB's engines and datastore. Cursored lookup-resources is compared UNION-ONLY (dispatch-order
 * page partitions are not byte-stable); everything else is compared exactly.
 *
 * Port decisions:
 *   * The `Op` sealed record hierarchy becomes a discriminated union with a literal `kind` field
 *     and a local `assertNever` in the default arm. The C# `default:` THROWS, so `assertNever`
 *     throwing (rather than returning) is the faithful shape.
 *   * `[Theory]` + `[MemberData(AllOperations)]` becomes `it.each` over flattened rows; the title
 *     interpolates the case AND op name, because op names are only unique within a case.
 *   * `AppContext.BaseDirectory/SteelThread/{TestData,Results}` becomes the vendored
 *     `packages/conformance/steel-thread/{test-data,results}` trees, siblings of `src` exactly as
 *     `packages/conformance/corpus` is. They are GOLDENS: copied verbatim, never regenerated.
 *   * `StringComparer.Ordinal` ordering is the bare `Array.prototype.sort`, which compares UTF-16
 *     code units - the same order over this ASCII corpus.
 *   * `Distinct(StringComparer.Ordinal)` preserves first-seen order, but the result is sorted
 *     immediately afterwards, so a `Set` round-trip is equivalent.
 */

const testDataDir = fileURLToPath(new URL("../steel-thread/test-data", import.meta.url));
const resultsDir = fileURLToPath(new URL("../steel-thread/results", import.meta.url));

// ---- The ported case list (mirror of definitions.go) ----

interface LookupSubjectsOp {
  readonly kind: "lookupSubjects";
  readonly name: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly permission: string;
  readonly subjectType: string;
  readonly goldenFile: string;
}

interface LookupResourcesOp {
  readonly kind: "lookupResources";
  readonly name: string;
  readonly resourceType: string;
  readonly permission: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly goldenFile: string;
}

interface CursoredLookupResourcesOp {
  readonly kind: "cursoredLookupResources";
  readonly name: string;
  readonly resourceType: string;
  readonly permission: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly pageSize: number;
  readonly unionGoldenFile: string;
}

interface CursoredReadByResourceOp {
  readonly kind: "cursoredReadByResource";
  readonly name: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly pageSize: number;
  readonly goldenFile: string;
}

interface CursoredReadBySubjectOp {
  readonly kind: "cursoredReadBySubject";
  readonly name: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly pageSize: number;
  readonly goldenFile: string;
}

interface BulkImportExportOp {
  readonly kind: "bulkImportExport";
  readonly name: string;
  readonly relsFile: string;
  readonly filterResourceType?: string | undefined;
  readonly filterResourceIdPrefix?: string | undefined;
  readonly goldenFile: string;
}

interface BulkCheckOp {
  readonly kind: "bulkCheck";
  readonly name: string;
  readonly checkRequests: readonly string[];
  readonly goldenFile: string;
}

interface WriteSchemaOp {
  readonly kind: "writeSchema";
  readonly name: string;
  readonly schema: string;
  readonly expectSuccess: boolean;
}

type Op =
  | LookupSubjectsOp
  | LookupResourcesOp
  | CursoredLookupResourcesOp
  | CursoredReadByResourceOp
  | CursoredReadBySubjectOp
  | BulkImportExportOp
  | BulkCheckOp
  | WriteSchemaOp;

interface Case {
  readonly name: string;
  readonly datafile: string;
  readonly operations: readonly Op[];
}

const LS_SOMEDOC = "basic-lookup-subjects-uncursored-lookup-subjects-for-somedoc-results.yaml";
const LS_PUBLICDOC = "basic-lookup-subjects-uncursored-lookup-subjects-for-public-doc-results.yaml";
const LS_INTERSECT =
  "lookup-subjects-intersection-uncursored-lookup-subjects-for-somedoc-results.yaml";
const LS_INTERSECT_ARROW =
  "lookup-subjects-intersection-arrow-uncursored-lookup-subjects-for-somedoc-results.yaml";
const LR_FRED = "basic-lookup-resources-uncursored-lookup-resources-for-fred-results.yaml";
const LR_INTERSECT =
  "lookup-resources-with-intersection-uncursored-indirect-lookup-resources-for-user-fred-results.yaml";
const LR_NESTED = "nested-groups-and-folders-lookup-resources-for-alice-results.yaml";

const CASES: readonly Case[] = [
  {
    name: "basic lookup subjects",
    datafile: "basic-document.yaml",
    operations: [
      {
        kind: "lookupSubjects",
        name: "ls somedoc",
        resourceType: "document",
        resourceId: "somedoc",
        permission: "view",
        subjectType: "user",
        goldenFile: LS_SOMEDOC,
      },
      {
        kind: "lookupSubjects",
        name: "ls publicdoc",
        resourceType: "document",
        resourceId: "publicdoc",
        permission: "view",
        subjectType: "user",
        goldenFile: LS_PUBLICDOC,
      },
    ],
  },
  {
    name: "lookup subjects intersection",
    datafile: "document-with-intersect.yaml",
    operations: [
      {
        kind: "lookupSubjects",
        name: "ls intersect somedoc",
        resourceType: "document",
        resourceId: "somedoc",
        permission: "view",
        subjectType: "user",
        goldenFile: LS_INTERSECT,
      },
    ],
  },
  {
    name: "lookup subjects intersection arrow",
    datafile: "document-with-intersect-arrow.yaml",
    operations: [
      {
        kind: "lookupSubjects",
        name: "ls intersect-arrow somedoc",
        resourceType: "document",
        resourceId: "somedoc",
        permission: "view",
        subjectType: "user",
        goldenFile: LS_INTERSECT_ARROW,
      },
    ],
  },
  {
    name: "basic lookup resources",
    datafile: "document-with-many-resources.yaml",
    operations: [
      {
        kind: "lookupResources",
        name: "lr view",
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "fred",
        goldenFile: LR_FRED,
      },
      {
        kind: "cursoredLookupResources",
        name: "clr view p5",
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "fred",
        pageSize: 5,
        unionGoldenFile: LR_FRED,
      },
      {
        kind: "cursoredLookupResources",
        name: "clr view p1",
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "fred",
        pageSize: 1,
        unionGoldenFile: LR_FRED,
      },
      {
        kind: "cursoredLookupResources",
        name: "clr view p16",
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "fred",
        pageSize: 16,
        unionGoldenFile: LR_FRED,
      },
      {
        kind: "cursoredLookupResources",
        name: "clr view p100",
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "fred",
        pageSize: 100,
        unionGoldenFile: LR_FRED,
      },
      {
        kind: "lookupResources",
        name: "lr indirect",
        resourceType: "document",
        permission: "indirect_view",
        subjectType: "user",
        subjectId: "fred",
        goldenFile: LR_FRED,
      },
    ],
  },
  {
    name: "lookup resources with intersection",
    datafile: "document-with-intersect-resources.yaml",
    operations: [
      {
        kind: "lookupResources",
        name: "lr-i view",
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "fred",
        goldenFile: LR_INTERSECT,
      },
      {
        kind: "cursoredLookupResources",
        name: "clr-i view",
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "fred",
        pageSize: 18,
        unionGoldenFile: LR_INTERSECT,
      },
    ],
  },
  // Multi-level reverse-reachability (nested groups + folder parents + a diamond): the cursored
  // resume must keep paged-union == unpaged across nesting levels. Page sizes 1/2/3/5/7 do not
  // divide the 7-document result, so they also exercise the full-page invariant at boundaries.
  {
    name: "lookup resources nested groups and folders",
    datafile: "document-with-nested-groups-and-folders.yaml",
    operations: [
      {
        kind: "lookupResources",
        name: "lr-nested view",
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "alice",
        goldenFile: LR_NESTED,
      },
      ...[1, 2, 3, 5, 7, 100].map((pageSize): CursoredLookupResourcesOp => ({
        kind: "cursoredLookupResources",
        name: `clr-nested view p${pageSize}`,
        resourceType: "document",
        permission: "view",
        subjectType: "user",
        subjectId: "alice",
        pageSize,
        unionGoldenFile: LR_NESTED,
      })),
    ],
  },
  {
    name: "basic import export",
    datafile: "document-with-a-few-relationships.yaml",
    operations: [
      {
        kind: "bulkImportExport",
        name: "no filter",
        relsFile: "basic-import-export-relationships.txt",
        filterResourceType: undefined,
        filterResourceIdPrefix: undefined,
        goldenFile: "basic-import-export-results.yaml",
      },
      {
        kind: "bulkImportExport",
        name: "filter type",
        relsFile: "basic-import-export-relationships.txt",
        filterResourceType: "document",
        filterResourceIdPrefix: undefined,
        goldenFile: "basic-import-export-results.yaml",
      },
      {
        kind: "bulkImportExport",
        name: "filter prefix",
        relsFile: "basic-import-export-relationships.txt",
        filterResourceType: undefined,
        filterResourceIdPrefix: "doc-1",
        goldenFile: "filtered-import-export-results.yaml",
      },
    ],
  },
  {
    name: "basic bulk checks",
    datafile: "document-with-a-few-relationships.yaml",
    operations: [
      {
        kind: "bulkCheck",
        name: "bulk",
        checkRequests: [
          "document:doc-1#view@user:user-0",
          "document:doc-1#view@user:user-1",
          "document:doc-1#view@user:user-2",
          "document:doc-2#view@user:user-0",
          "document:doc-2#view@user:user-1",
          "document:doc-2#view@user:user-2",
          "document:doc-3#view@user:user-0",
          "document:doc-3#view@user:user-1",
          "document:doc-3#view@user:user-2",
        ],
        goldenFile: "basic-bulk-checks-basic-bulk-checks-results.yaml",
      },
    ],
  },
  {
    name: "bulk checks with traits",
    datafile: "document-with-traits.yaml",
    operations: [
      {
        kind: "bulkCheck",
        name: "bulk traits",
        checkRequests: [
          "document:firstdoc#view@user:tom",
          "document:firstdoc#view@user:fred",
          "document:seconddoc#view@user:tom",
          "document:seconddoc#view@user:fred",
          'document:seconddoc#view@user:tom[unused:{"somecondition": 41}]',
          'document:seconddoc#view@user:fred[unused:{"somecondition": 41}]',
          'document:seconddoc#view@user:tom[unused:{"somecondition": 42}]',
          'document:seconddoc#view@user:fred[unused:{"somecondition": 42}]',
          "document:thirddoc#view@user:tom",
          "document:thirddoc#view@user:fred",
          'document:thirddoc#view@user:tom[unused:{"somecondition": 41}]',
          'document:thirddoc#view@user:fred[unused:{"somecondition": 41}]',
          'document:thirddoc#view@user:tom[unused:{"somecondition": 42}]',
          'document:thirddoc#view@user:fred[unused:{"somecondition": 42}]',
        ],
        goldenFile: "bulk-checks-with-traits-bulk-checks-results.yaml",
      },
    ],
  },
  {
    name: "write schema removal (success cases)",
    datafile: "basic-schema-and-data.yaml",
    operations: [
      {
        kind: "writeSchema",
        name: "removes the group relation",
        schema:
          "definition user {}\ndefinition user2 {}\ndefinition group {\nrelation direct_member: user | group#member\nrelation admin: user\npermission member = direct_member + admin\n}\ndefinition document {\nrelation editor: user2:*\nrelation viewer: user | user:*\npermission view = viewer\n}",
        expectSuccess: true,
      },
    ],
  },
  {
    name: "remove relation on real schema",
    datafile: "real-schema-and-data-with-many-relations.yaml",
    operations: [
      {
        kind: "writeSchema",
        name: "real",
        schema:
          "use expiration\ndefinition user {}\ndefinition platform {}\ndefinition resource {\nrelation platform: platform\nrelation viewer: user | user:*\n}",
        expectSuccess: true,
      },
    ],
  },
  {
    name: "read relationships by resource",
    datafile: "read-relationships-sorting.yaml",
    operations: [1, 2, 5, 10, 100].map((pageSize): CursoredReadByResourceOp => ({
      kind: "cursoredReadByResource",
      name: `rr p${pageSize}`,
      resourceType: "document",
      resourceId: "target-doc",
      pageSize,
      goldenFile: `read-relationships-by-resource-cursored-read-by-resource-page-size-${pageSize}-results.yaml`,
    })),
  },
  {
    name: "read relationships by subject",
    datafile: "read-relationships-sorting.yaml",
    operations: [1, 2, 5, 10, 100].map((pageSize): CursoredReadBySubjectOp => ({
      kind: "cursoredReadBySubject",
      name: `rs p${pageSize}`,
      subjectType: "user",
      subjectId: "target-user",
      pageSize,
      goldenFile: `read-relationships-by-subject-cursored-read-by-subject-page-size-${pageSize}-results.yaml`,
    })),
  },
];

/** The C# `AllOperations`: one row per (datafile, case, op). */
interface OperationRow {
  readonly datafile: string;
  readonly caseName: string;
  readonly opName: string;
  readonly theCase: Case;
  readonly op: Op;
}

function allOperations(): readonly OperationRow[] {
  const rows: OperationRow[] = [];
  for (const theCase of CASES) {
    for (const op of theCase.operations) {
      rows.push({
        datafile: theCase.datafile,
        caseName: theCase.name,
        opName: op.name,
        theCase,
        op,
      });
    }
  }
  return rows;
}

it.each(allOperations())("$caseName / $opName", async ({ datafile, op }) => {
  switch (op.kind) {
    case "lookupSubjects":
      await runLookupSubjects(await loadFixture(datafile), op);
      break;
    case "lookupResources":
      await runLookupResources(await loadFixture(datafile), op);
      break;
    case "cursoredLookupResources":
      await runCursoredLookupResources(await loadFixture(datafile), op);
      break;
    case "cursoredReadByResource":
      await runCursoredRead(
        await loadFixture(datafile),
        readByResource(op.resourceType, op.resourceId),
        op.pageSize,
        op.goldenFile,
      );
      break;
    case "cursoredReadBySubject":
      await runCursoredRead(
        await loadFixture(datafile),
        readBySubject(op.subjectType, op.subjectId),
        op.pageSize,
        op.goldenFile,
      );
      break;
    case "bulkImportExport":
      await runBulkImportExport(datafile, op);
      break;
    case "bulkCheck":
      await runBulkCheck(await loadFixture(datafile), op);
      break;
    case "writeSchema":
      await runWriteSchema(await loadFixture(datafile), op);
      break;
    default:
      // The C# `default:` THROWS `InvalidOperationException($"unhandled op {op.GetType().Name}")`,
      // so the throwing form is the faithful one here.
      assertNever(op);
  }
});

function assertNever(op: never): never {
  throw new Error(`unhandled op ${JSON.stringify(op)}`);
}

// ---- lookupSubjects (exact) ----

async function runLookupSubjects(f: Fixture, o: LookupSubjectsOp): Promise<void> {
  const engine = new LookupSubjectsEngine(f.schema.namespaces);
  const resource: ObjectAndRelation = {
    objectType: o.resourceType,
    objectId: o.resourceId,
    relation: o.permission,
  };
  const found: FoundSubject[] = [];
  // The engine's subject relation is explicit here, matching the C#'s `CoreConstants.Ellipsis`.
  for await (const s of engine.lookupSubjects(f.reader, resource, o.subjectType, ELLIPSIS)) {
    found.push(s);
  }

  const formatted = [...new Set(found.map(formatResolvedSubject))].sort();
  assertFlatGolden(o.goldenFile, formatted);
}

// ---- lookupResources (exact, deduped) ----

async function runLookupResources(f: Fixture, o: LookupResourcesOp): Promise<void> {
  const engine = new LookupResourcesEngine(f.schema.namespaces, f.schema.caveats);
  const byId = new Map<string, FoundResource>();
  for await (const r of engine.lookupResources(
    f.reader,
    o.subjectType,
    o.subjectId,
    ELLIPSIS,
    o.resourceType,
    o.permission,
  )) {
    mergeResource(byId, r);
  }

  const formatted = [...byId.values()].map(formatResolvedResource).sort();
  assertFlatGolden(o.goldenFile, formatted);
}

// ---- cursoredLookupResources (UNION-ONLY + full-page invariant) ----

async function runCursoredLookupResources(f: Fixture, o: CursoredLookupResourcesOp): Promise<void> {
  const engine = new LookupResourcesEngine(f.schema.namespaces, f.schema.caveats);
  let cursor: LookupResourcesCursor | undefined = undefined;
  const pageCounts: number[] = [];
  const unionById = new Map<string, FoundResource>();

  for (;;) {
    const pageById = new Map<string, FoundResource>();
    let count = 0;
    let last: LookupResourcesCursor | undefined = cursor;
    for await (const r of engine.lookupResources(
      f.reader,
      o.subjectType,
      o.subjectId,
      ELLIPSIS,
      o.resourceType,
      o.permission,
      undefined,
      undefined,
      cursor,
      o.pageSize,
    )) {
      mergeResource(pageById, r);
      last = r.afterCursor;
      count++;
    }

    if (count === 0) {
      break;
    }

    pageCounts.push(count);
    for (const v of pageById.values()) {
      mergeResource(unionById, v);
    }

    cursor = last;
  }

  // Invariant: every non-final page is exactly full (port of operations.go:215-223).
  for (let i = 0; i < pageCounts.length - 1; i++) {
    expect(
      pageCounts[i],
      `${o.name}: non-final page #${i} had ${pageCounts[i]} (expected full ${o.pageSize}); pages: [${pageCounts.join(",")}]`,
    ).toBe(o.pageSize);
  }

  // UNION-ONLY: deduped union must equal the uncursored golden (partition is dispatch-order
  // dependent).
  const union = [...unionById.values()].map(formatResolvedResource).sort();
  assertFlatGolden(o.unionGoldenFile, union);
}

// ---- cursoredReadRelationships (exact list-of-lists) ----

async function runCursoredRead(
  f: Fixture,
  filter: RelationshipsFilter,
  pageSize: number,
  goldenFile: string,
): Promise<void> {
  const all: string[] = [];
  for await (const rel of f.reader.queryRelationships(filter)) {
    all.push(formatRelationship(rel));
  }

  all.sort();

  const pages: string[][] = [];
  for (let i = 0; i < all.length; i += pageSize) {
    pages.push(all.slice(i, i + pageSize)); // already ordinal -> each page sorted
  }

  assertNestedGolden(goldenFile, pages);
}

function readByResource(type: string, id: string): RelationshipsFilter {
  return { optionalResourceType: type, optionalResourceIds: [id] };
}

function readBySubject(subjType: string, subjId: string): RelationshipsFilter {
  return {
    optionalSubjectsSelectors: [
      {
        optionalSubjectType: subjType,
        optionalSubjectIds: [subjId],
        relationFilter: SUBJECT_RELATION_FILTER_ANY,
      },
    ],
  };
}

// ---- bulkImportExport (exact) ----
// SpiceDB seeds the datastore from the case's datafile, THEN imports the .txt, then exports the
// union. (Its export OptionalLimit is a stream page-size, not a total cap, so the limit variant
// equals the full export and is not separately modelled here.)

async function runBulkImportExport(datafile: string, o: BulkImportExportOp): Promise<void> {
  const store = new ReferenceDatastore();

  const seedFile = loadValidationFile(join(testDataDir, datafile));
  const seedRels = seedFile.relationships;
  const importRels = readRelsFile(o.relsFile);

  const all: readonly RelationshipUpdate[] = [...seedRels, ...importRels].map((relationship) => ({
    relationship,
    operation: "create" as const,
  }));
  const rev = await store.readWriteTx((tx) => tx.writeRelationships(all));
  const reader = store.snapshotReader(rev);

  const filter: RelationshipsFilter = {
    optionalResourceType: o.filterResourceType,
    optionalResourceIdPrefix: o.filterResourceIdPrefix,
  };

  const exported: string[] = [];
  for await (const rel of reader.queryRelationships(filter)) {
    exported.push(normalizeExpiration(formatRelationship(rel)));
  }

  // Export order is datastore-internal; compare order-insensitively.
  exported.sort();

  // Known internal divergence: BeneDB's `formatRelationship` renders expiration with a fixed
  // 7-digit fractional-second suffix (e.g. ...:15.0000000Z) whereas SpiceDB emits minimal RFC3339
  // (...:15Z). Confirmed still true for the port: `tuple-strings.ts` documents the format as
  // `yyyy-MM-ddTHH:mm:ss.fffffff'Z'` and always emits seven digits, so the normalization is still
  // load-bearing here. It is a BeneDB-internal string format (the gRPC wire carries a proto
  // Timestamp, so it does not affect zed compatibility). Normalize both sides' trailing-zero
  // fraction so the comparison stays meaningful over the exported relationship SET, caveats and
  // filters.
  const golden = loadFlatGolden(o.goldenFile).map(normalizeExpiration);
  golden.sort();
  expect(exported).toEqual(golden);
}

/** Strips a trailing-zero fractional-second suffix before the expiration 'Z' (see above). */
function normalizeExpiration(rel: string): string {
  return rel.replace(/(?<=:\d\d)\.0+Z/g, "Z");
}

// ---- bulkCheckPermissions (exact) ----

async function runBulkCheck(f: Fixture, o: BulkCheckOp): Promise<void> {
  const engine = new CheckEngine(f.schema.namespaces, f.schema.caveats);
  const lines: string[] = [];
  for (const requestString of o.checkRequests) {
    const rel = parseRelationship(requestString);
    const ctx = rel.optionalCaveat?.context;
    const result = await engine.check(
      f.reader,
      rel.reference.resource.objectType,
      rel.reference.resource.objectId,
      rel.reference.resource.relation,
      rel.reference.subject,
      ctx,
    );
    lines.push(`${requestString} -> ${permissionship(result.verdict)}`);
  }

  assertFlatGolden(o.goldenFile, lines, true); // order == request order
}

// ---- writeSchema (success exact; rejection asserted as "rejected") ----

async function runWriteSchema(f: Fixture, o: WriteSchemaOp): Promise<void> {
  const next = compileSchema(o.schema);
  let threw = false;
  try {
    await validate(f.schema, next, f.reader);
  } catch (error) {
    if (!(error instanceof SchemaWriteValidationException)) throw error;
    threw = true;
  }

  if (o.expectSuccess) {
    expect(threw, `${o.name}: expected schema write to succeed but it was rejected`).toBe(false);
  } else {
    expect(
      threw,
      `${o.name}: expected schema write to be rejected (SpiceDB message not byte-asserted)`,
    ).toBe(true);
  }
}

// ---- formatting helpers (ports of operations.go) ----

function formatResolvedResource(r: FoundResource): string {
  return r.membership === "caveated" ? `${r.resourceId} (conditional)` : r.resourceId;
}

function formatResolvedSubject(s: FoundSubject): string {
  let out = s.isWildcard ? PUBLIC_WILDCARD : s.subjectId;

  // Port of SpiceDB formatResolvedSubject: a wildcard renders its excluded subjects as a sorted
  // bracket list, each marked "(conditional)" when conditionally excluded.
  const excluded = s.excludedSubjects;
  if (excluded !== undefined && excluded.length > 0) {
    const parts = excluded
      .map((e) => (e.caveat !== undefined ? `${e.subjectId} (conditional)` : e.subjectId))
      .sort();
    out += ` - [${parts.join(", ")}]`;
  }

  if (s.caveat !== undefined) {
    out += " (conditional)";
  }

  return out;
}

function permissionship(m: Membership): string {
  switch (m) {
    case "member":
      return "PERMISSIONSHIP_HAS_PERMISSION";
    case "caveated":
      return "PERMISSIONSHIP_CONDITIONAL_PERMISSION";
    default:
      return "PERMISSIONSHIP_NO_PERMISSION";
  }
}

function mergeResource(into: Map<string, FoundResource>, r: FoundResource): void {
  // Member dominates Caveated when the same id arrives via several entrypoints (within a page).
  const existing = into.get(r.resourceId);
  if (existing !== undefined && existing.membership === "member") {
    return;
  }

  into.set(r.resourceId, r);
}

// ---- golden loading / assertions ----

function resultsPath(file: string): string {
  return join(resultsDir, file);
}

/** `File.ReadAllLines`: splits on the platform's line breaks and drops a trailing empty line. */
function readAllLines(path: string): readonly string[] {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r\n|\n|\r/u);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function loadFlatGolden(file: string): string[] {
  // Goldens are YAML lists of single-quoted scalars: parse leading "- '...'".
  const items: string[] = [];
  for (const raw of readAllLines(resultsPath(file))) {
    const line = raw.trimStart();
    if (!line.startsWith("- ")) {
      continue;
    }

    items.push(unquote(line.slice(2).trim()));
  }

  return items;
}

function loadNestedGolden(file: string): string[][] {
  // List-of-lists: "- - 'a'" opens a page, "  - 'b'" continues it.
  // BRANCH ORDER IS LOAD-BEARING: after `trimStart()` a continuation line `  - 'b'` also starts
  // with "- ", so it only reaches the continuation branch because "- - " is tested first.
  const pages: string[][] = [];
  let current: string[] | undefined = undefined;
  for (const raw of readAllLines(resultsPath(file))) {
    if (raw.trimStart().startsWith("- - ")) {
      current = [unquote(raw.trimStart().slice(4).trim())];
      pages.push(current);
    } else if (raw.trimStart().startsWith("- ") && current !== undefined) {
      current.push(unquote(raw.trimStart().slice(2).trim()));
    }
  }

  return pages;
}

function unquote(s: string): string {
  return s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'"
    ? s.slice(1, -1).replaceAll("''", "'")
    : s;
}

function assertFlatGolden(
  file: string,
  actual: readonly string[],
  requireSameOrderAsGolden = false,
): void {
  const golden = loadFlatGolden(file);
  if (!requireSameOrderAsGolden) {
    golden.sort();
  }

  expect(actual).toEqual(golden);
}

function assertNestedGolden(file: string, actual: readonly (readonly string[])[]): void {
  const golden = loadNestedGolden(file);
  expect(actual.length).toBe(golden.length);
  for (let i = 0; i < golden.length; i++) {
    expect(actual[i]).toEqual(golden[i]);
  }
}

function readRelsFile(relsFile: string): readonly Relationship[] {
  const rels: Relationship[] = [];
  for (const line of readAllLines(join(testDataDir, relsFile))) {
    if (line.length > 0) {
      rels.push(parseRelationship(line));
    }
  }

  return rels;
}

// ---- shared fixture (compiled schema + loaded datastore at a snapshot) ----

interface Fixture {
  readonly schema: CompiledSchema;
  readonly reader: IDatastoreReader;
}

async function loadFixture(datafile: string): Promise<Fixture> {
  const file = loadValidationFile(join(testDataDir, datafile));
  const compiled = compileSchema(file.schemaText);

  const store = new ReferenceDatastore();
  let rev: IRevision;
  if (file.relationships.length === 0) {
    rev = (await store.headRevision()).revision;
  } else {
    const updates: readonly RelationshipUpdate[] = file.relationships.map((relationship) => ({
      relationship,
      operation: "create" as const,
    }));
    rev = await store.readWriteTx((tx) => tx.writeRelationships(updates));
  }

  return { schema: compiled, reader: store.snapshotReader(rev) };
}
