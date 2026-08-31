import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AuthzedPermissionsV1Service } from "@benedb/api/authzed-permissions-v1-service";
import { CollectingStreamWriter } from "@benedb/api/collecting-stream-writer";
import { loadResolvedValidationFile } from "@benedb/conformance/validation-file-loader";
import type { AssertionExpectation, ParsedAssertion } from "@benedb/conformance/validation-model";
import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import type { Relationship as CoreRelationship } from "@benedb/core/relationship";
import type { RelationshipUpdate as CoreRelationshipUpdate } from "@benedb/core/relationship-update";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import {
  RelationshipUpdate_Operation,
  type ObjectReference,
  type Relationship,
  type RelationshipUpdate,
  type SubjectReference,
} from "@benedb/protos/authzed/api/v1/core";
import {
  CheckPermissionRequest,
  DeleteRelationshipsRequest,
  LookupResourcesRequest,
  LookupSubjectsRequest,
  WriteRelationshipsRequest,
  type LookupResourcesResponse,
  type LookupSubjectsResponse,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { WriteSchemaRequest } from "@benedb/protos/authzed/api/v1/schema_service";

import {
  formatIdSet,
  normalizePermissionship,
  ordinalCompare,
  setEquals,
} from "./differential-comparison";
import {
  spiceDbAvailable,
  spiceDbSkipReason,
  useSpiceDbContainer,
} from "./spice-db-container-fixture";
import { SpiceDbGrpcClient } from "./spice-db-grpc-client";

/**
 * Ported from Spiceport `tests/Spiceport.Differential.Tests/CorpusDifferentialTests.cs`.
 *
 * Replays the vendored SpiceDB conformance corpus through the SAME real-SpiceDB-vs-BeneDB
 * differential harness `differential-conformance-tests.test.ts` establishes for the random worlds:
 * one case per corpus file, writing the file's schema+relationships to a real SpiceDB container AND
 * to an in-process grain mesh, then cross-checking CheckPermission / LookupResources /
 * LookupSubjects.
 *
 * THIS FILE ONLY READS THE CORPUS. `packages/conformance/corpus` is the VERBATIM compatibility
 * corpus; it is never copied, regenerated, or written to from here.
 *
 * WHY THIS EXISTS ALONGSIDE `differential-conformance-tests.test.ts`: that suite proves BeneDB
 * agrees with real SpiceDB over RANDOMLY GENERATED worlds built from a small template set. This one
 * replays the CURATED corpus SpiceDB's own maintainers wrote to pin down tricky semantics (caveats,
 * expiration, wildcard exclusion, arrow composition). Running that exact corpus against a real
 * SpiceDB binary catches two things a same-process oracle never can: (1) a shared misunderstanding
 * of the Zanzibar spec baked into `@benedb/engine`, and (2) a vendored fixture whose recorded
 * expected outcome has drifted from what the pinned upstream SpiceDB version returns today (the
 * `expectationNotes` below).
 *
 * RESET STRATEGY, BOTH HALVES: each corpus file declares its own, usually self-contained, schema,
 * and the container is shared across this file's cases, so a later file's `WriteSchema` would
 * otherwise collide with an earlier file's still-live relationships (SpiceDB refuses to drop or
 * narrow a relation that still has data). BEFORE `WriteSchema`, delete this file's own resource
 * types CONCAT the fixed `["group", "folder", "document"]`, distinct and ordinal - the fixed set is
 * there because `DifferentialConformanceTests` shares the collection with no ordering guarantee.
 * AFTER, in a `finally`, delete only THIS file's own types. The BeneDB side needs no reset:
 * `MeshTestCluster.create` stands up a brand-new cluster (and datastore) per file.
 *
 * WILDCARD SUBJECTS: no suite in this repo drives the real V1 `LookupSubjects`/`CheckPermission`
 * RPCs with a subject whose object id IS the wildcard (`*`) - that is never a valid Check/Lookup
 * subject, since `*` only ever appears as a wildcard being MATCHED. This suite defensively excludes
 * any assertion whose subject id is `"*"` from driving a LOOKUP query, but NOT from the Check
 * assertions. The asymmetry is deliberate and the exclusion documents the invariant rather than
 * silently relying on it.
 *
 * PORT DECISIONS.
 *
 *  1. THE CORPUS PATH IS RESOLVED, READ-ONLY, ONCE. The C# links the yaml in as
 *     `CopyToOutputDirectory` content and enumerates `TestData/*.yaml` under
 *     `AppContext.BaseDirectory`. Here the tree already lives at `packages/conformance/corpus`,
 *     which from this package resolves to `../../conformance/corpus` - the same
 *     `fileURLToPath(new URL(...))` form `packages/conformance/src/conformance-tests.test.ts` uses.
 *  2. THE ENUMERATION IS NON-RECURSIVE AND ORDINAL-SORTED, exactly like `ConformanceTests`'
 *     `AllYamlFiles`: `readdirSync(..., { withFileTypes: true })` filtered to FILES, so
 *     `corpus/Quarantine` and `corpus/LoaderSuite` (subdirectories) are never matched - the same
 *     reason the C#'s non-recursive glob never matched `Quarantine/`.
 *  3. THE LOADER IS `loadResolvedValidationFile` (the C#'s `LoadResolved`), NOT
 *     `loadValidationFile`.
 *  4. THE RECORD-AS-DICTIONARY-KEY TRAP. `file.Assertions.GroupBy(a => (ResourceType, Permission,
 *     SubjectType, SubjectRelation))` groups by a C# VALUE TUPLE with STRUCTURAL equality. A JS
 *     `Map` keys by REFERENCE, so an object or array key would give ONE GROUP PER ASSERTION and the
 *     whole Lookup comparison would silently degenerate into nothing. `shapeKey` joins the four
 *     components with a separator that cannot occur in an identifier, and the group carries its
 *     parsed components alongside so nothing is re-split.
 *  5. THREE SEPARATE COLLECTIONS, AND THE SPLIT IS THE WHOLE POINT OF THIS GATE.
 *      - `failures`: BeneDB-vs-real-SpiceDB divergence. FATAL.
 *      - `expectationNotes`: the yaml's OWN recorded expectation disagreeing with what real SpiceDB
 *        returns today. PRINTED, NOT A FAILURE - a vendored expectation asserting something other
 *        than the real thing. Collapsing it into `failures` breaks green; deleting it hides the
 *        finding.
 *      - `skippedQueries`: real SpiceDB rejected the RPC at the wire level (e.g. a non-terminal
 *        subject relation). Informational.
 *     `ITestOutputHelper.WriteLine` -> `console.log`, keeping the header line and the count.
 *     Like xUnit's output helper, that text is only SURFACED by a verbose reporter: vitest's
 *     default run reporter collapses a passing file's stdout, so read these with
 *     `vitest run --project differential --reporter=verbose`.
 *  6. `DictToStruct` / `ObjectToValue` / `JsonElementToValue` COLLAPSE. ts-proto AUTO-UNWRAPS
 *     `Struct`, so the `context` field is a plain object and there is no `Value` tree to build;
 *     `JsonElement` has no analogue at all (the loader yields plain JS scalars and nested `Map`s).
 *     BUT THE TWO NULLABILITY BEHAVIOURS THE TREE ENCODED ARE PRESERVED AND ARE NOT UNIFIED:
 *     (i) `dictToStruct` returns `undefined` for a null-or-empty dict and the CHECK path then OMITS
 *     `context` entirely - an ABSENT Struct is not the same on the wire as an empty one; (ii) the
 *     CAVEAT path uses `dictToStruct(...) ?? {}`, i.e. an EMPTY struct.
 *  7. EXPIRATION IS A REPRESENTATION DEVIATION, forced. Core `Relationship.optionalExpiration` is
 *     NANOSECONDS since the epoch as a `bigint`; the ts-proto `optionalExpiresAt` field is a
 *     JavaScript `Date`, i.e. MILLISECOND resolution, so `Timestamp.FromDateTimeOffset`'s 100ns
 *     ticks have no counterpart on the wire here. Sub-MILLIsecond precision cannot survive the
 *     conversion; sub-SECOND precision does, and every expiration in this corpus is a whole second
 *     (`2023-12-01T00:00:00Z` and friends), so nothing in the compared set is affected. The BeneDB
 *     side is unaffected either way: it takes the `bigint` straight into the datastore.
 *  8. `SkippedFiles` IS PORTED EMPTY, WITH ITS HISTORY COMMENT - see `SKIPPED_FILES`. That comment
 *     is the justification for the v1.49.2 image pin; losing it loses the reason.
 *  9. `[SkippableTheory]` + `[MemberData]` -> `it.for` (the form that passes a `TestContext`);
 *     `[Collection(...)]` -> `useSpiceDbContainer()` + `describe.sequential`. A 75-file sweep
 *     against ONE container is genuinely long - that is expected, and is not a reason to sample,
 *     skip, or parallelise onto multiple containers.
 * 10. `FakeServerCallContext` disappears (trailing optional `AbortSignal`), and
 *     `CollectingStreamWriter<T>` is the shared `@benedb/api` one, not a re-declared private copy.
 */

/**
 * Corpus files this suite cannot run faithfully against real SpiceDB, and the concrete reason
 * observed. Kept EMPTY unless empirical verification turns up a genuine
 * SpiceDB-rejects-what-we-accept (or vice versa) case; a file only lands here with the exact failure
 * recorded, never silently.
 *
 * HISTORY: against v1.44.2 this list carried `arrowsublr.yaml` - a genuine LookupResources
 * divergence (spicedb=[] while its own Check and Spiceport both said Member for the
 * arrow-over-computed-userset shape). Root-caused upstream: SpiceDB's reachability graph skipped
 * entrypoints for a relation reused by an arrow in the same permission; fixed in spicedb 8c2edbe1
 * ("fix entrypoints over relations that are reused for arrows", first released in v1.47.0), the very
 * commit that ADDED `arrowsublr.yaml` as its regression fixture. Bumping the pinned image past the
 * fix emptied this list - and is why the container fixture pins v1.49.2.
 */
const SKIPPED_FILES: ReadonlyMap<string, string> = new Map<string, string>();

/** Port decision 1: resolved once, read-only. Nothing here ever writes to the corpus. */
const corpusDir = fileURLToPath(new URL("../../conformance/corpus", import.meta.url));

/** Port decision 4: a separator that cannot occur in a SpiceDB identifier. */
const SHAPE_SEPARATOR = " ";

/** The fixed set `DifferentialConformanceTests` resets; see the reset strategy above. */
const SHARED_RESET_TYPES: readonly string[] = ["group", "folder", "document"];

const fixture = useSpiceDbContainer();

/** The C#'s `CorpusFiles()` (port decision 2). */
function corpusFiles(): readonly string[] {
  return readdirSync(corpusDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort(ordinalCompare);
}

function service(cluster: MeshTestCluster): AuthzedPermissionsV1Service {
  return new AuthzedPermissionsV1Service(
    cluster.checker,
    cluster.grainFactory,
    cluster.reverseOps,
    cluster.relationshipReads,
    cluster.schemaProvider,
  );
}

function objectRef(objectType: string, objectId: string): ObjectReference {
  return { objectType, objectId };
}

/** `OptionalRelation = relation == Ellipsis ? string.Empty : relation` - empty, never undefined. */
function subjectRef(
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
): SubjectReference {
  return {
    object: objectRef(subjectType, subjectId),
    optionalRelation: subjectRelation === ELLIPSIS ? "" : subjectRelation,
  };
}

/** The C#'s `catch (RpcException)`: a grpc-js failure is an `Error` carrying a numeric `code`. */
function isGrpcError(error: unknown): boolean {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "number";
}

/** The C#'s `ex.Status` interpolated into a skip note. */
function describeGrpcError(error: unknown): string {
  const e = error as { code?: unknown; details?: unknown };
  return `Status(code=${String(e.code)}, detail="${String(e.details)}")`;
}

/**
 * `DictToStruct`: `undefined` (C# `null`) for a null-or-EMPTY dict. Port decision 6 - the CALLER
 * decides whether that means "omit the field" (Check) or "an empty struct" (caveat).
 */
function dictToStruct(
  dict: ReadonlyMap<string, unknown> | undefined,
): { [key: string]: unknown } | undefined {
  if (dict === undefined || dict.size === 0) return undefined;

  // A NULL-PROTOTYPE object, not `{}`: C# writes into `Struct.Fields`, an ordinary dictionary, so a
  // key called `__proto__` is stored like any other. On an object literal that same assignment hits
  // the inherited setter on `Object.prototype` and the key vanishes with no error - silent loss of
  // an input to an authorization decision.
  const s = Object.create(null) as { [key: string]: unknown };
  for (const [k, v] of dict) s[k] = objectToValue(v);
  return s;
}

/**
 * `ObjectToValue`, collapsed onto plain JS (port decision 6). THE ORDER OF THE BRANCHES IS THE
 * BEHAVIOUR: `string` must be tested before the array branch, because a string is itself iterable in
 * JS and would otherwise be exploded into characters, and a `Map` must be tested before it too. A
 * `bigint` has no C# counterpart (`int`/`long`/`double` all collapse to `ForNumber`), so it takes
 * the `o.ToString()` fallback rather than a lossy `Number(...)`.
 */
function objectToValue(o: unknown): unknown {
  if (o === null || o === undefined) return null;
  if (typeof o === "boolean") return o;
  if (typeof o === "string") return o;
  if (typeof o === "number") return o;
  if (o instanceof Map) return dictToStruct(o as ReadonlyMap<string, unknown>) ?? {};
  if (Array.isArray(o)) return o.map(objectToValue);
  return String(o);
}

/** The C#'s `ToUpdate`, preserving caveat AND expiration (port decisions 6 and 7). */
function toUpdate(rel: CoreRelationship): RelationshipUpdate {
  const { resource, subject } = rel.reference;
  const relationship: Relationship = {
    resource: objectRef(resource.objectType, resource.objectId),
    relation: resource.relation,
    subject: subjectRef(subject.objectType, subject.objectId, subject.relation),
    optionalCaveat:
      rel.optionalCaveat === undefined
        ? undefined
        : {
            caveatName: rel.optionalCaveat.caveatName,
            // The CAVEAT path takes an EMPTY struct where the Check path takes ABSENCE.
            context: dictToStruct(rel.optionalCaveat.context) ?? {},
          },
    optionalExpiresAt:
      rel.optionalExpiration === undefined
        ? undefined
        : new Date(Number(rel.optionalExpiration / 1_000_000n)),
  };

  return { operation: RelationshipUpdate_Operation.OPERATION_TOUCH, relationship };
}

async function writeRelationships(
  spiceDbClient: SpiceDbGrpcClient,
  cluster: MeshTestCluster,
  relationships: readonly CoreRelationship[],
): Promise<void> {
  if (relationships.length === 0) return;

  // SpiceDB side: WriteRelationships in bounded batches over the real gRPC wire, preserving caveat
  // context and expiration (see toUpdate).
  const batchSize = 50;
  for (let i = 0; i < relationships.length; i += batchSize) {
    await spiceDbClient.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: relationships.slice(i, i + batchSize).map(toUpdate),
      }),
    );
  }

  // BeneDB side: straight into the datastore transaction (bypassing the gRPC proto round trip
  // entirely), so caveat context and expiration ride through as first-class Core fields with no
  // lossy proto conversion in between.
  const updates: CoreRelationshipUpdate[] = relationships.map((relationship) => ({
    relationship,
    operation: "touch",
  }));
  await cluster.datastore.readWriteTx(async (tx) => {
    await tx.writeRelationships(updates);
  });
}

/** `NormalizeExpectation`: True -> Member, False -> NotMember, Caveated -> Caveated. */
function normalizeExpectation(expectation: AssertionExpectation): string {
  switch (expectation) {
    case "true":
      return "Member";
    case "caveated":
      return "Caveated";
    default:
      return "NotMember";
  }
}

/** Port decision 4: the structural value-tuple key, as a string. */
function shapeKey(assertion: ParsedAssertion): string {
  return [
    assertion.resource.objectType,
    assertion.resource.relation,
    assertion.subject.objectType,
    assertion.subject.relation,
  ].join(SHAPE_SEPARATOR);
}

/** One `GroupBy` group: the value-tuple's four components, plus the assertions that carried it. */
interface AssertionShape {
  readonly resourceType: string;
  readonly permission: string;
  readonly subjectType: string;
  readonly subjectRelation: string;
  readonly assertions: ParsedAssertion[];
}

function groupByShape(assertions: readonly ParsedAssertion[]): readonly AssertionShape[] {
  const groups = new Map<string, AssertionShape>();
  for (const assertion of assertions) {
    const key = shapeKey(assertion);
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        resourceType: assertion.resource.objectType,
        permission: assertion.resource.relation,
        subjectType: assertion.subject.objectType,
        subjectRelation: assertion.subject.relation,
        assertions: [],
      };
      groups.set(key, group);
    }
    group.assertions.push(assertion);
  }
  return [...groups.values()];
}

/** `Distinct(StringComparer.Ordinal)`, first-seen order preserved as LINQ's `Distinct` does. */
function distinct(values: Iterable<string>): readonly string[] {
  return [...new Set(values)];
}

async function compareCheck(
  spiceDbClient: SpiceDbGrpcClient,
  permissionsService: AuthzedPermissionsV1Service,
  fileName: string,
  assertion: ParsedAssertion,
  failures: string[],
  expectationNotes: string[],
): Promise<void> {
  const resource = objectRef(assertion.resource.objectType, assertion.resource.objectId);
  const subject = subjectRef(
    assertion.subject.objectType,
    assertion.subject.objectId,
    assertion.subject.relation,
  );
  const contextStruct = dictToStruct(assertion.caveatContext);

  // The C#'s local `BuildRequest()`: a FRESH request per side. `context` is OMITTED, not set to an
  // empty struct, when there is none (port decision 6 (i)).
  const buildRequest = (): CheckPermissionRequest =>
    CheckPermissionRequest.fromPartial({
      resource,
      permission: assertion.resource.relation,
      subject,
      consistency: { fullyConsistent: true },
      ...(contextStruct !== undefined ? { context: contextStruct } : {}),
    });

  const spiceDbResp = await spiceDbClient.checkPermission(buildRequest());
  const benedbResp = await permissionsService.checkPermission(buildRequest());

  const spiceDbVerdict = normalizePermissionship(spiceDbResp.permissionship);
  const benedbVerdict = normalizePermissionship(benedbResp.permissionship);

  if (spiceDbVerdict !== benedbVerdict) {
    failures.push(
      `${fileName}: CheckPermission "${assertion.sourceText}" ` +
        `spicedb=${spiceDbVerdict} benedb=${benedbVerdict}`,
    );
  }

  const expected = normalizeExpectation(assertion.expectation);
  if (spiceDbVerdict !== expected) {
    expectationNotes.push(
      `"${assertion.sourceText}" => yaml expects ${expected}, real SpiceDB returned ${spiceDbVerdict}`,
    );
  }
}

async function compareLookupResources(
  spiceDbClient: SpiceDbGrpcClient,
  permissionsService: AuthzedPermissionsV1Service,
  fileName: string,
  resourceType: string,
  permission: string,
  subjectType: string,
  subjectRelation: string,
  subjectId: string,
  failures: string[],
  skippedQueries: string[],
): Promise<void> {
  const subject = subjectRef(subjectType, subjectId, subjectRelation);

  let spiceDbResults: LookupResourcesResponse[];
  try {
    spiceDbResults = await spiceDbClient.lookupResources(
      LookupResourcesRequest.fromPartial({
        resourceObjectType: resourceType,
        permission,
        subject,
        consistency: { fullyConsistent: true },
      }),
    );
  } catch (error) {
    if (!isGrpcError(error)) throw error;
    // Real SpiceDB rejects some subject shapes (e.g. a non-terminal subject relation) that this
    // harness still enumerates from the assertion set; not a BeneDB defect to chase, so it is
    // surfaced as a skipped comparison rather than a hard failure.
    skippedQueries.push(
      `LookupResources ${resourceType}#${permission}@${subjectType}:${subjectId} ` +
        `-- real SpiceDB rejected the request: ${describeGrpcError(error)}`,
    );
    return;
  }

  const spiceDbIds = new Set(spiceDbResults.map((r) => r.resourceObjectId));

  const writer = new CollectingStreamWriter<LookupResourcesResponse>();
  await permissionsService.lookupResources(
    LookupResourcesRequest.fromPartial({
      resourceObjectType: resourceType,
      permission,
      subject,
      consistency: { fullyConsistent: true },
    }),
    writer,
  );
  const benedbIds = new Set(writer.collected.map((r) => r.resourceObjectId));

  if (!setEquals(spiceDbIds, benedbIds)) {
    failures.push(
      `${fileName}: LookupResources ${resourceType}#${permission}@${subjectType}:${subjectId} ` +
        `spicedb=[${formatIdSet(spiceDbIds)}] benedb=[${formatIdSet(benedbIds)}]`,
    );
  }
}

async function compareLookupSubjects(
  spiceDbClient: SpiceDbGrpcClient,
  permissionsService: AuthzedPermissionsV1Service,
  fileName: string,
  resourceType: string,
  resourceId: string,
  permission: string,
  subjectType: string,
  failures: string[],
  skippedQueries: string[],
): Promise<void> {
  const resource = objectRef(resourceType, resourceId);

  let spiceDbResults: LookupSubjectsResponse[];
  try {
    spiceDbResults = await spiceDbClient.lookupSubjects(
      LookupSubjectsRequest.fromPartial({
        resource,
        permission,
        subjectObjectType: subjectType,
        consistency: { fullyConsistent: true },
      }),
    );
  } catch (error) {
    if (!isGrpcError(error)) throw error;
    // See the wildcard-subject note above: no established in-repo precedent covers real SpiceDB's
    // behaviour here for every corpus shape, so a genuine RPC-level rejection is a documented skip
    // for this one (resource, permission, subjectType) query rather than a hard failure.
    skippedQueries.push(
      `LookupSubjects ${resourceType}:${resourceId}#${permission}@${subjectType} ` +
        `-- real SpiceDB rejected the request: ${describeGrpcError(error)}`,
    );
    return;
  }

  const spiceDbIds = new Set(spiceDbResults.map((r) => r.subject?.subjectObjectId ?? ""));

  const writer = new CollectingStreamWriter<LookupSubjectsResponse>();
  await permissionsService.lookupSubjects(
    LookupSubjectsRequest.fromPartial({
      resource,
      permission,
      subjectObjectType: subjectType,
      consistency: { fullyConsistent: true },
    }),
    writer,
  );
  const benedbIds = new Set(writer.collected.map((r) => r.subject?.subjectObjectId ?? ""));

  if (!setEquals(spiceDbIds, benedbIds)) {
    failures.push(
      `${fileName}: LookupSubjects ${resourceType}:${resourceId}#${permission}@${subjectType} ` +
        `spicedb=[${formatIdSet(spiceDbIds)}] benedb=[${formatIdSet(benedbIds)}]`,
    );
  }
}

/** Best-effort `DeleteRelationships`: a type not defined under the ACTIVE schema is not an error. */
async function deleteResourceTypes(
  spiceDbClient: SpiceDbGrpcClient,
  resourceTypes: Iterable<string>,
): Promise<void> {
  for (const resourceType of resourceTypes) {
    try {
      await spiceDbClient.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType } }),
      );
    } catch (error) {
      // Not currently defined under whatever schema is active; nothing to reset.
      if (!isGrpcError(error)) throw error;
    }
  }
}

describe.sequential("CorpusDifferentialTests", () => {
  it.for(corpusFiles())("Corpus_file_agrees_with_real_SpiceDB: %s", async (fileName, ctx) => {
    ctx.skip(!spiceDbAvailable, spiceDbSkipReason);
    const skipReason = SKIPPED_FILES.get(fileName);
    ctx.skip(skipReason !== undefined, `${fileName}: ${skipReason}`);

    const file = loadResolvedValidationFile(join(corpusDir, fileName));

    const resourceTypesToReset = distinct(
      file.relationships.map((r) => r.reference.resource.objectType),
    );

    const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
    const cluster = await MeshTestCluster.create(file.schemaText);

    try {
      // Defensive PRE-write reset: this file's own types plus the fixed set
      // `DifferentialConformanceTests` uses, so a leftover relationship under a type this file's
      // schema no longer defines can never block the schema transition.
      await deleteResourceTypes(
        spiceDbClient,
        distinct([...resourceTypesToReset, ...SHARED_RESET_TYPES]),
      );

      await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema: file.schemaText }));
      await writeRelationships(spiceDbClient, cluster, file.relationships);

      const permissionsService = service(cluster);

      const failures: string[] = [];
      const expectationNotes: string[] = [];
      const skippedQueries: string[] = [];

      // --- Check comparisons: every assertion (assertTrue/assertFalse/assertCaveated). ---
      for (const assertion of file.assertions) {
        await compareCheck(
          spiceDbClient,
          permissionsService,
          fileName,
          assertion,
          failures,
          expectationNotes,
        );
      }

      // --- Lookup comparisons: every distinct (resourceType, permission, subjectType,
      // subjectRelation) shape appearing among the file's assertions, driven by the CONCRETE ids
      // that shape's assertions actually reference (the corpus is small by construction). ---
      for (const shape of groupByShape(file.assertions)) {
        const subjectIds = distinct(
          shape.assertions
            .map((a) => a.subject.objectId)
            // Never a valid Lookup/Check subject id - see the wildcard note above. NOT excluded
            // from the Check assertions; the asymmetry is deliberate.
            .filter((id) => id !== PUBLIC_WILDCARD),
        );
        const resourceIds = distinct(shape.assertions.map((a) => a.resource.objectId));

        for (const subjectId of subjectIds) {
          await compareLookupResources(
            spiceDbClient,
            permissionsService,
            fileName,
            shape.resourceType,
            shape.permission,
            shape.subjectType,
            shape.subjectRelation,
            subjectId,
            failures,
            skippedQueries,
          );
        }

        for (const resourceId of resourceIds) {
          await compareLookupSubjects(
            spiceDbClient,
            permissionsService,
            fileName,
            shape.resourceType,
            resourceId,
            shape.permission,
            shape.subjectType,
            failures,
            skippedQueries,
          );
        }
      }

      if (skippedQueries.length > 0) {
        console.log(
          `${fileName}: ${skippedQueries.length} Lookup query/queries could not be compared ` +
            "(real SpiceDB rejected the request at the RPC level -- not counted as a failure):",
        );
        for (const note of skippedQueries) console.log(`  ${note}`);
      }

      if (expectationNotes.length > 0) {
        console.log(
          `${fileName}: ${expectationNotes.length} yaml-expectation-vs-real-SpiceDB disagreement(s) ` +
            "(not a test failure -- the vendored fixture's expectation appears stale relative to " +
            "the pinned upstream SpiceDB version):",
        );
        for (const note of expectationNotes) console.log(`  ${note}`);
      }

      expect(
        failures.length === 0,
        `Divergence(s) between real SpiceDB and BeneDB in ${fileName}:\n${failures.join("\n")}`,
      ).toBe(true);
    } finally {
      // Best-effort cleanup: if this file's own WriteSchema/WriteRelationships never completed (e.g.
      // it threw), the types below may not exist in whatever schema is still active on the shared
      // container. Swallow THAT case only, so a cleanup-time failure cannot mask the real failure
      // that got the test here in the first place.
      try {
        await deleteResourceTypes(spiceDbClient, resourceTypesToReset);
      } finally {
        spiceDbClient.close();
        await cluster.dispose();
      }
    }
  });
});
