import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";

import { loadValidationFile } from "@benedb/conformance/validation-file-loader";
import type { ValidationFile } from "@benedb/conformance/validation-model";
import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipReference } from "@benedb/core/relationship-reference";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import type { IGraphReader } from "@benedb/datastore/i-graph-reader";
import type { RelationshipsFilter, SubjectsFilter } from "@benedb/datastore/relationships-filter";
import {
  compareReferencesBySubject,
  type ReverseQueryOptions,
} from "@benedb/datastore/reverse-query-options";
import type { Duration } from "@thresh/core/duration";

import { graphShardGrainKeyBuild } from "./graph-shard-grain-key";
import { graphShardKeyForResource } from "./graph-shard-key";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { IGraphShardGrain } from "./i-graph-shard-grain";
import { MeshTestCluster } from "./mesh-test-cluster";
import { NotSupportedError, ShardedGraphReader } from "./sharded-graph-reader";
import { toRelationship } from "./wire-convert";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ShardedReaderEquivalenceTests.cs`.
 *
 * THE fold-equivalence gate for the sharded read path (`docs/graph-sharded-datastore.md` section 7):
 * every read answered by both the SEQUENCER-SNAPSHOT reader (`GrainBackedDatastore.snapshotReader` -
 * one full-state fetch of the singleton grain's fold, the independent oracle now that the per-silo
 * whole-graph projection is gone) and the `ShardedGraphReader` over the `IGraphShardGrain` mesh must
 * agree EXACTLY. Shards serve data, not candidates, so the applicable instrument is full
 * read-for-read equivalence - not candidates-plus-Check-confirmation. The time-travel and catch-up
 * passes here are also where the per-shard closed-timestamp gate (watermark covers the pinned
 * revision before serving) stays pinned.
 *
 * The oracle side deliberately does not touch the shard mesh: the sequencer-snapshot reader folds
 * the whole state via `MvccSnapshotReader`, while every shard grain hydrates and catches up on
 * demand against the very same datastore grain log. Rows are compared as multisets of canonical
 * strings (the `grain-backed-datastore-fidelity-tests` idiom) because a `Relationship`'s caveat
 * context is a `ReadonlyMap` compared by REFERENCE - structural equality on the objects would report
 * false negatives for equal rows.
 *
 * A DISAGREEMENT BETWEEN THE TWO SIDES IS A REAL DEFECT in `graph-shard-grain.ts` /
 * `sharded-graph-reader.ts`, never a harness quirk to paper over.
 *
 * PORT NOTES.
 *  - `AppContext.BaseDirectory/TestData` is the vendored corpus at `packages/conformance/corpus`,
 *    reached exactly as `sharded-reader-corpus-mesh-tests.test.ts` reaches it, with the same
 *    `File.Exists` anti-vacuous guard. The corpus is the compatibility anchor and is never edited.
 *  - `new ShardedGraphReader(cluster.GrainFactory, Nanos(rev))` uses `cluster.grainFactory` - the
 *    real cluster CLIENT, not a silo container (the distinction is documented on
 *    `mesh-test-cluster.ts` and is load-bearing) - and the nanos, already a `bigint`.
 *  - `Nanos` stays a `TimestampRevision` unwrap that THROWS on any other revision type.
 *  - The synthetic-keyset `first with { Resource = first.Resource with { ... } }` is a NESTED
 *    record-struct copy: it is cloned explicitly here, because mutating the shared reference object
 *    would corrupt `expectedRows[0]`, which the same test then compares against.
 *  - `Canonical` renders caveat context as CANONICAL JSON with object keys sorted at EVERY depth
 *    (`canonicalJson` below, which canonicalizes a `ReadonlyMap` as a sorted-key object). The C#
 *    comment states the reason: a `toString()` shortcut admits exactly the false negative this gate
 *    must not admit.
 *  - Scan-shaped filters are rejected when the stream is DRAINED, not at call time (both reader
 *    methods are generators), so the `drain` helper is kept.
 *  - `[MemberData] NarrowingFilterCases` interpolated a `SubjectsFilter` object into the failure
 *    label; `it.for` with `%s` needs a readable label, so each case carries an explicit one.
 *  - `IDatastoreGrain.Key` is `DATASTORE_GRAIN_KEY`; `RevisionNotFoundException` must cross the
 *    grain boundary as the DOMAIN type (what `revision-not-found-surrogate.ts` exists for), never as
 *    a serialization failure.
 *  - `TimeSpan.Zero` / `TimeSpan.FromMilliseconds(200)` are `Duration` literals; `Task.Delay` is a
 *    real `setTimeout` sleep, kept at `window + 100ms`.
 *  - `await using` -> an explicit `try { ... } finally { await cluster.dispose(); }`.
 */

const requireFromHere = createRequire(import.meta.url);

const CORPUS_DIR = resolvePath(
  dirname(requireFromHere.resolve("@benedb/conformance/validation-file-loader")),
  "..",
  "corpus",
);

/**
 * The representative subset the mesh conformance gate runs, plus `relexpiration.yaml`: its
 * already-expired row is stored live in MVCC and must be skipped at query time by BOTH readers,
 * exercising the sharded reader's caller-side expiry filter.
 */
const EQUIVALENCE_FILES: readonly string[] = [
  "multipleops.yaml", // set-ops (union / intersection / exclusion)
  "teamwitharrow.yaml", // arrow (tuple-to-userset)
  "simplewildcard.yaml", // wildcard ('*' subject ids get their own reverse shard)
  "indirectnestedgroups.yaml", // indirect / nested group
  "simplerecursive.yaml", // recursive
  "basiccaveat.yaml", // caveat (caveat context must round-trip the shard boundary)
  "caveatlr.yaml", // caveat (left/right ordering)
  "caveatip.yaml", // caveat (typed/nested context values round-trip the shard boundary)
  "relexpiration.yaml", // expiration (expired row skipped at query time)
];

/** The C#'s `Path.Combine(BaseDirectory, "TestData", fileName)` plus its existence assertion. */
function loadCorpusFile(fileName: string): ValidationFile {
  const path = join(CORPUS_DIR, fileName);
  expect(existsSync(path), `Linked corpus file missing from output: ${path}`).toBe(true);
  return loadValidationFile(path);
}

/** The C# `Seed`. */
async function seed(datastore: IDatastore, relationships: readonly Relationship[]): Promise<void> {
  const updates: readonly RelationshipUpdate[] = relationships.map((relationship) => ({
    relationship,
    operation: "create",
  }));
  await datastore.readWriteTx((tx) => tx.writeRelationships(updates));
}

/** The C# `Nanos`: a `TimestampRevision` unwrap that throws on any other revision type. */
function nanos(revision: IRevision): bigint {
  if (revision instanceof TimestampRevision) return revision.timestampNanosSinceEpoch;
  throw new Error(`unexpected revision type: ${revision.constructor.name}`);
}

/** `StringComparer.Ordinal` ordering - bare `<`/`>`, never `localeCompare`. */
function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface ObjectKey {
  readonly objectType: string;
  readonly objectId: string;
}

function objectKeyString(key: ObjectKey): string {
  return `${key.objectType.length}:${key.objectType}|${key.objectId}`;
}

/** `.Distinct()` over a `(string, string)` value tuple, first-seen order preserved. */
function distinctObjects(keys: readonly ObjectKey[]): ObjectKey[] {
  const seen = new Set<string>();
  const out: ObjectKey[] = [];
  for (const key of keys) {
    const k = objectKeyString(key);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(key);
  }
  return out;
}

/** The C# `Representatives`: first, middle and last of the distinct subjects, deduplicated. */
function representatives(subjects: readonly ObjectKey[]): ObjectKey[] {
  const ordered = [...subjects].sort(
    (a, b) => ordinal(a.objectType, b.objectType) || ordinal(a.objectId, b.objectId),
  );
  const first = ordered[0];
  const middle = ordered[Math.trunc(ordered.length / 2)];
  const last = ordered[ordered.length - 1];
  if (first === undefined || middle === undefined || last === undefined) {
    throw new Error("gate needs at least one distinct subject");
  }
  return distinctObjects([first, middle, last]);
}

function compareSorted(
  expected: string[],
  actual: string[],
  label: string,
  failures: string[],
): void {
  expected.sort(ordinal);
  actual.sort(ordinal);
  compareOrdered(expected, actual, label, failures);
}

function compareOrdered(
  expected: readonly string[],
  actual: readonly string[],
  label: string,
  failures: string[],
): void {
  if (expected.length !== actual.length || expected.some((v, i) => v !== actual[i])) {
    failures.push(
      `  ${label}:\n    sequencer:  [${expected.join(", ")}]\n    sharded:    [${actual.join(", ")}]`,
    );
  }
}

async function collect(source: AsyncIterable<Relationship>): Promise<string[]> {
  return (await materialize(source)).map(canonical);
}

async function materialize(source: AsyncIterable<Relationship>): Promise<Relationship[]> {
  const rows: Relationship[] = [];
  for await (const rel of source) rows.push(rel);
  return rows;
}

/** The C# `Drain`: the shape guards throw at ENUMERATION, not at the call. */
async function drain(source: AsyncIterable<Relationship>): Promise<void> {
  for await (const _unused of source) {
    // discard
  }
}

/** Awaits a rejection and hands back the thrown value, so its type asserts. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to reject, but it resolved");
}

function sleep(duration: Duration): Promise<void> {
  const ms = (duration.ms ?? 0) + (duration.seconds ?? 0) * 1000;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits until the datastore grain's own wall clock reads STRICTLY PAST `revisionNanos`.
 *
 * PORT DEVIATION, and the only one either GC case needs. `runGc` computes
 * `floor = min(head, now - window)` - transliterated exactly from the C# - and the zero-window case
 * pins `floor == head`, which holds in .NET because `DateTimeOffset.UtcNow` has 100ns resolution and
 * so `now` is past a head minted moments earlier. The port's clock is `Date.now()`, MILLISECONDS: a
 * burst of commits inside one millisecond mints its heads by the `head + 1n` synthetic increment, so
 * `now` sits BELOW head and the floor lands on `now` instead - which can be at or below Rd, and the
 * case's premise fails intermittently for a reason that has nothing to do with the shard grain.
 *
 * Waiting for the coarse clock to catch up restores the C#'s premise instead of weakening the case:
 * every assertion below is the C#'s, `floor > Rd` and `min(head, now) == head` included. The grain is
 * NOT wrong here - `runGc`'s arithmetic matches `DatastoreGrain.RunGc` line for line - only its clock
 * is 10,000x coarser, and that is a property of the platform, not of this test.
 */
async function waitForClockPast(revisionNanos: bigint): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (BigInt(Date.now()) * 1_000_000n <= revisionNanos) {
    if (Date.now() > deadline) throw new Error("wall clock never passed the head revision");
    await sleep({ ms: 1 });
  }
}

// Canonical string forms (caveat context compared via its serialized values, matching the
// grain-backed-datastore-fidelity idiom, since a `ReadonlyMap` compares by reference).

function canonical(rel: Relationship): string {
  const cav = rel.optionalCaveat;
  const caveat = cav !== undefined ? `[${cav.caveatName}:${contextString(cav.context)}]` : "";
  const exp = rel.optionalExpiration !== undefined ? `@exp=${rel.optionalExpiration}` : "";
  return `${identity(rel)}${caveat}${exp}`;
}

function identity(rel: Relationship): string {
  const { resource, subject } = rel.reference;
  return (
    `${resource.objectType}:${resource.objectId}#${resource.relation}` +
    `@${subject.objectType}:${subject.objectId}#${subject.relation}`
  );
}

function contextString(ctx: ReadonlyMap<string, unknown> | undefined): string {
  if (ctx === undefined || ctx.size === 0) return "";
  return [...ctx.entries()]
    .sort(([a], [b]) => ordinal(a, b))
    .map(([k, v]) => `${k}=${canonicalJson(v)}`)
    .join(",");
}

/**
 * Context VALUES compare structurally: re-serialized as JSON with object keys sorted at every
 * depth. `String(value)` would render nested list/map values by their runtime string form, under
 * which two differently-corrupted nested values could canonicalize equal - the exact false negative
 * this gate must not admit. The port's context carries plain JSON, and a nested `Map` (the shape a
 * decoded wire object can take) canonicalizes as a sorted-key object, exactly like a plain object.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Map) {
    return canonicalEntries([...(value as ReadonlyMap<string, unknown>).entries()]);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return canonicalEntries(Object.entries(value as Record<string, unknown>));
  }
  return JSON.stringify(value) ?? "null";
}

function canonicalEntries(entries: readonly (readonly [string, unknown])[]): string {
  return `{${[...entries]
    .sort(([a], [b]) => ordinal(a, b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

/**
 * Writes one NEW relationship touching an already-read resource shard and an already-read subject
 * shard, asserts both readers at the new head agree and include it, then deletes it and asserts both
 * agree on exclusion (tombstone visibility through the shard grain's fold). The new row reuses the
 * first relationship's resource object and subject under a probe RELATION name: shard keys are
 * (type, id) with no relation segment, so both shards are exactly the ones pass one hydrated, while
 * the six-tuple is guaranteed unwritten in any corpus file.
 */
async function assertFreshnessAfterWrite(
  cluster: MeshTestCluster,
  existing: readonly Relationship[],
  fileName: string,
): Promise<void> {
  const head = existing[0];
  expect(head, `${fileName}: gate needs a seeded relationship`).not.toBeUndefined();
  const fresh = createRelationship(
    { ...head!.reference.resource, relation: "shard_gate_probe" },
    head!.reference.subject,
  );
  expect(existing.map(identity)).not.toContain(identity(fresh));

  // Time-travel pinning needs the heads AROUND the probe write: R0 before it, R1 after the write,
  // R2 after the delete.
  const r0 = (await cluster.datastore.headRevision()).revision;

  const r1 = await cluster.datastore.readWriteTx((tx) =>
    tx.writeRelationships([{ relationship: fresh, operation: "create" }]),
  );
  await assertBothReadersAgreeOn(cluster, fresh, true, fileName);

  const r2 = await cluster.datastore.readWriteTx((tx) =>
    tx.writeRelationships([{ relationship: fresh, operation: "delete" }]),
  );
  await assertBothReadersAgreeOn(cluster, fresh, false, fileName);

  // Time travel: the shard watermark now sits at (or past) R2, so a reader pinned at the OLD
  // revisions distinguishes visibleAt(pinned) from live-at-watermark - a shard that served its
  // current live rows would report the probe absent at R1 (already deleted at the watermark) and
  // could not flip presence across R0/R1/R2.
  await assertBothReadersAgreeOn(cluster, fresh, false, fileName, r0);
  await assertBothReadersAgreeOn(cluster, fresh, true, fileName, r1);
  await assertBothReadersAgreeOn(cluster, fresh, false, fileName, r2);
}

async function assertBothReadersAgreeOn(
  cluster: MeshTestCluster,
  rel: Relationship,
  expectPresent: boolean,
  fileName: string,
  pinned?: IRevision | undefined,
): Promise<void> {
  const revision = pinned ?? (await cluster.datastore.headRevision()).revision;
  const sequencer: IGraphReader = cluster.datastore.snapshotReader(revision);
  const sharded: IGraphReader = new ShardedGraphReader(cluster.grainFactory, nanos(revision));

  const forward: RelationshipsFilter = {
    optionalResourceType: rel.reference.resource.objectType,
    optionalResourceIds: [rel.reference.resource.objectId],
    optionalResourceRelation: rel.reference.resource.relation,
  };
  const reverse: SubjectsFilter = {
    subjectType: rel.reference.subject.objectType,
    optionalSubjectIds: [rel.reference.subject.objectId],
  };

  const failures: string[] = [];
  const sequencerForward = await collect(sequencer.queryRelationships(forward));
  compareSorted(
    [...sequencerForward],
    await collect(sharded.queryRelationships(forward)),
    `freshness forward ${identity(rel)}`,
    failures,
  );
  const sequencerReverse = await collect(sequencer.reverseQueryRelationships(reverse));
  compareSorted(
    [...sequencerReverse],
    await collect(sharded.reverseQueryRelationships(reverse)),
    `freshness reverse ${identity(rel)}`,
    failures,
  );
  expect(
    failures,
    `${fileName}: freshness pass (expectPresent=${expectPresent}, pinned=${pinned === undefined ? "head" : nanos(revision).toString()}) diverged:\n${failures.join("\n")}`,
  ).toEqual([]);

  // Both agree - pin what they agree ON against the write just committed.
  expect(sequencerForward.includes(canonical(rel))).toBe(expectPresent);
  expect(sequencerReverse.includes(canonical(rel))).toBe(expectPresent);
}

describe("ShardedReaderEquivalenceTests", () => {
  it.each(EQUIVALENCE_FILES)(
    "Sharded_Reader_Agrees_With_Sequencer_Snapshot_Reader(%s)",
    async (fileName) => {
      const file = loadCorpusFile(fileName);
      expect(
        file.relationships.length,
        `${fileName}: gate needs a non-empty relationships block`,
      ).toBeGreaterThan(0);

      const cluster = await MeshTestCluster.create(file.schemaText);
      try {
        await seed(cluster.datastore, file.relationships);

        const head = await cluster.datastore.headRevision();
        const sequencer: IGraphReader = cluster.datastore.snapshotReader(head.revision);
        const sharded: IGraphReader = new ShardedGraphReader(
          cluster.grainFactory,
          nanos(head.revision),
        );

        const failures: string[] = [];

        // (a) Forward: EVERY distinct (resourceType, resourceId), EVERY relation on it, plus the
        // bare type+id filter with no relation constraint.
        const resources = distinctObjects(
          file.relationships.map((r) => ({
            objectType: r.reference.resource.objectType,
            objectId: r.reference.resource.objectId,
          })),
        );
        for (const { objectType: type, objectId: id } of resources) {
          const relations: (string | undefined)[] = [
            ...new Set(
              file.relationships
                .filter(
                  (r) =>
                    r.reference.resource.objectType === type &&
                    r.reference.resource.objectId === id,
                )
                .map((r) => r.reference.resource.relation),
            ),
            undefined,
          ];
          for (const relation of relations) {
            const filter: RelationshipsFilter = {
              optionalResourceType: type,
              optionalResourceIds: [id],
              optionalResourceRelation: relation,
            };
            compareSorted(
              await collect(sequencer.queryRelationships(filter)),
              await collect(sharded.queryRelationships(filter)),
              `forward ${type}:${id}#${relation ?? "<any>"}`,
              failures,
            );
          }
        }

        // (b) Reverse, unsorted: EVERY distinct (subjectType, subjectId) - wildcard '*' ids
        // included.
        const subjects = distinctObjects(
          file.relationships.map((r) => ({
            objectType: r.reference.subject.objectType,
            objectId: r.reference.subject.objectId,
          })),
        );
        for (const { objectType: type, objectId: id } of subjects) {
          const filter: SubjectsFilter = { subjectType: type, optionalSubjectIds: [id] };
          compareSorted(
            await collect(sequencer.reverseQueryRelationships(filter)),
            await collect(sharded.reverseQueryRelationships(filter)),
            `reverse ${type}:${id}`,
            failures,
          );
        }

        // (c) Sorted equivalence + keyset resume for three representative subjects: the BySubject
        // sequences must match IN ORDER, and resuming after the middle element of the sequencer
        // reader's sequence must yield identical remainders (the LookupResources cursor contract).
        for (const { objectType: type, objectId: id } of representatives(subjects)) {
          const filter: SubjectsFilter = { subjectType: type, optionalSubjectIds: [id] };
          const sorted: ReverseQueryOptions = { sort: "bySubject" };

          const expectedRows = await materialize(
            sequencer.reverseQueryRelationships(filter, sorted),
          );
          const actualRows = await materialize(sharded.reverseQueryRelationships(filter, sorted));
          compareOrdered(
            expectedRows.map(canonical),
            actualRows.map(canonical),
            `sorted reverse ${type}:${id}`,
            failures,
          );

          if (expectedRows.length === 0) continue;

          const midRow = expectedRows[Math.trunc(expectedRows.length / 2)];
          const resume: ReverseQueryOptions = {
            sort: "bySubject",
            after: midRow!.reference,
          };
          compareOrdered(
            (await materialize(sequencer.reverseQueryRelationships(filter, resume))).map(canonical),
            (await materialize(sharded.reverseQueryRelationships(filter, resume))).map(canonical),
            `keyset-resumed reverse ${type}:${id}`,
            failures,
          );

          // Synthetic keyset: an After that exists in NO row, constructed lexically strictly between
          // the first two rows. The resource relation is the LAST BySubject tiebreaker and no real
          // relation contains NUL, so appending "\0" yields a key strictly greater than row 0 and
          // strictly less than any strictly-greater row - both readers must resume from row 1.
          if (expectedRows.length >= 2) {
            const first = expectedRows[0]!.reference;
            // The C#'s NESTED record-struct copy: cloned explicitly, because mutating the shared
            // reference object would corrupt expectedRows[0], compared against just below.
            const synthetic: RelationshipReference = {
              resource: { ...first.resource, relation: `${first.resource.relation}\0` },
              subject: first.subject,
            };
            expect(
              compareReferencesBySubject(first, synthetic) < 0 &&
                compareReferencesBySubject(synthetic, expectedRows[1]!.reference) < 0,
              `synthetic keyset for ${type}:${id} is not strictly between the first two rows`,
            ).toBe(true);

            const syntheticResume: ReverseQueryOptions = {
              sort: "bySubject",
              after: synthetic,
            };
            const sequencerRemainder = (
              await materialize(sequencer.reverseQueryRelationships(filter, syntheticResume))
            ).map(canonical);
            compareOrdered(
              sequencerRemainder,
              (await materialize(sharded.reverseQueryRelationships(filter, syntheticResume))).map(
                canonical,
              ),
              `synthetic keyset-resumed reverse ${type}:${id}`,
              failures,
            );
            // Pin what the resume means, not just that the readers agree: everything after row 0.
            compareOrdered(
              expectedRows.slice(1).map(canonical),
              sequencerRemainder,
              `synthetic keyset remainder ${type}:${id}`,
              failures,
            );
          }
        }

        expect(
          failures,
          `${fileName}: ${failures.length} read(s) diverged between the sequencer snapshot and the shard mesh:\n${failures.join("\n")}`,
        ).toEqual([]);

        // (d) Absent keys: a never-written resource and subject activate cold, empty shards - both
        // readers must return nothing (not throw, not invent rows).
        const absentForward: RelationshipsFilter = {
          optionalResourceType: resources[0]!.objectType,
          optionalResourceIds: ["spiceport-never-written"],
        };
        expect(await collect(sequencer.queryRelationships(absentForward))).toEqual([]);
        expect(await collect(sharded.queryRelationships(absentForward))).toEqual([]);

        const absentReverse: SubjectsFilter = {
          subjectType: subjects[0]!.objectType,
          optionalSubjectIds: ["spiceport-never-written"],
        };
        expect(await collect(sequencer.reverseQueryRelationships(absentReverse))).toEqual([]);
        expect(await collect(sharded.reverseQueryRelationships(absentReverse))).toEqual([]);

        // (e) Shape guards: scan-shaped filters must be REJECTED by the sharded reader - silently
        // serving a partial answer for a scan is the failure mode the narrow seam exists to prevent.
        expect(
          await rejection(
            drain(
              sharded.queryRelationships({
                optionalResourceType: resources[0]!.objectType,
                optionalResourceIds: [resources[0]!.objectId],
                optionalResourceIdPrefix: "p",
              }),
            ),
          ),
        ).toBeInstanceOf(NotSupportedError);
        expect(
          await rejection(
            drain(sharded.queryRelationships({ optionalResourceType: resources[0]!.objectType })),
          ),
        ).toBeInstanceOf(NotSupportedError);
        expect(
          await rejection(
            drain(sharded.reverseQueryRelationships({ subjectType: subjects[0]!.objectType })),
          ),
        ).toBeInstanceOf(NotSupportedError);

        // (f) Write-after-hydrate freshness: the shards above are hydrated at the OLD head, so a new
        // commit exercises catch-up-on-demand - the per-shard watermark is the closed-timestamp gate.
        await assertFreshnessAfterWrite(cluster, file.relationships, fileName);
      } finally {
        await cluster.dispose();
      }
    },
    180_000,
  );

  /**
   * The LookupResourcesEngine frontier shape: one reverse query carrying SEVERAL subject ids plus
   * the wildcard - the sharded reader must fan out to one shard per id (the wildcard gets its own
   * reverse shard), merge, and still match the sequencer-snapshot reader both as a multiset
   * (unsorted) and as the BySubject global sort with a keyset resume that crosses a subject
   * boundary.
   */
  it.each([
    {
      fileName: "simplewildcard.yaml",
      subjectType: "test/user",
      subjectIds: ["concreteguy", "anotheruser", "*"],
      expectWildcardRow: true,
    },
    {
      fileName: "teamwitharrow.yaml",
      subjectType: "test/user",
      subjectIds: ["jake", "jimmy", "*"],
      expectWildcardRow: false,
    },
  ])(
    "Multi_Id_With_Wildcard_Reverse_Agrees_And_Resumes_Across_Subject_Boundary($fileName)",
    async ({ fileName, subjectType, subjectIds, expectWildcardRow }) => {
      const file = loadCorpusFile(fileName);

      const cluster = await MeshTestCluster.create(file.schemaText);
      try {
        await seed(cluster.datastore, file.relationships);

        const head = await cluster.datastore.headRevision();
        const sequencer: IGraphReader = cluster.datastore.snapshotReader(head.revision);
        const sharded: IGraphReader = new ShardedGraphReader(
          cluster.grainFactory,
          nanos(head.revision),
        );

        const filter: SubjectsFilter = { subjectType, optionalSubjectIds: subjectIds };
        const failures: string[] = [];

        // Unsorted: multiset equality against the sequencer-snapshot reader.
        compareSorted(
          await collect(sequencer.reverseQueryRelationships(filter)),
          await collect(sharded.reverseQueryRelationships(filter)),
          `multi-id reverse [${subjectIds.join(",")}]`,
          failures,
        );

        // Sorted: the merged cross-shard sequence must BE the global BySubject order.
        const sorted: ReverseQueryOptions = { sort: "bySubject" };
        const expectedRows = await materialize(sequencer.reverseQueryRelationships(filter, sorted));
        const actualRows = await materialize(sharded.reverseQueryRelationships(filter, sorted));
        compareOrdered(
          expectedRows.map(canonical),
          actualRows.map(canonical),
          `multi-id sorted reverse [${subjectIds.join(",")}]`,
          failures,
        );

        if (expectWildcardRow) {
          // The wildcard SHARD must have contributed - a '*' row can only come from it.
          expect(actualRows.some((r) => r.reference.subject.objectId === PUBLIC_WILDCARD)).toBe(
            true,
          );
        }

        // Keyset resume ACROSS a subject boundary: After = the last row of the FIRST subject's block
        // in the sequencer reader's sorted sequence, so the remainder starts inside another shard's
        // rows.
        const firstSubject = expectedRows[0]!.reference.subject;
        const sameSubject = expectedRows.filter(
          (r) =>
            r.reference.subject.objectType === firstSubject.objectType &&
            r.reference.subject.objectId === firstSubject.objectId,
        );
        const boundary = sameSubject[sameSubject.length - 1]!.reference;
        expect(
          expectedRows.some((r) => r.reference.subject.objectId !== firstSubject.objectId),
        ).toBe(true);

        const resume: ReverseQueryOptions = { sort: "bySubject", after: boundary };
        const sequencerRemainder = (
          await materialize(sequencer.reverseQueryRelationships(filter, resume))
        ).map(canonical);
        compareOrdered(
          sequencerRemainder,
          (await materialize(sharded.reverseQueryRelationships(filter, resume))).map(canonical),
          `multi-id boundary-crossing resume [${subjectIds.join(",")}]`,
          failures,
        );
        // The remainder is exactly the later subjects' rows - the resume genuinely crossed the
        // boundary.
        compareOrdered(
          expectedRows
            .filter((r) => r.reference.subject.objectId !== firstSubject.objectId)
            .map(canonical),
          sequencerRemainder,
          `multi-id boundary remainder [${subjectIds.join(",")}]`,
          failures,
        );

        expect(
          failures,
          `${fileName}: multi-id/wildcard pass diverged:\n${failures.join("\n")}`,
        ).toEqual([]);
      } finally {
        await cluster.dispose();
      }
    },
    180_000,
  );

  /**
   * Narrowing-filter passes: the shard holds ALL rows of its subject slice, so a `SubjectsFilter`
   * whose relationFilter / resource constraints EXCLUDE some of those rows makes the caller-side
   * `matches` re-filter load-bearing - a reader that returned the slice unfiltered would show the
   * excluded rows. Each case asserts equality with the sequencer-snapshot reader AND that the filter
   * really excluded something (fewer rows than the unfiltered slice).
   */
  it.each([
    // teamwitharrow: test/team:support_engineers appears as a subject with TWO subject relations
    // (repository maintainer @team#member; team parent @team#...) across TWO resource types.
    {
      label: "teamwitharrow relationFilter=member",
      fileName: "teamwitharrow.yaml",
      filter: {
        subjectType: "test/team",
        optionalSubjectIds: ["support_engineers"],
        relationFilter: { nonEllipsisRelation: "member" },
      } satisfies SubjectsFilter,
      // only the repository maintainer row; the ellipsis parent row is excluded
      expectedCount: 1,
    },
    {
      label: "teamwitharrow resourceType=test/team",
      fileName: "teamwitharrow.yaml",
      filter: {
        subjectType: "test/team",
        optionalSubjectIds: ["support_engineers"],
        optionalResourceType: "test/team",
      } satisfies SubjectsFilter,
      // only the parent row; the repository maintainer row is excluded
      expectedCount: 1,
    },
    {
      label: "teamwitharrow resourceRelation=maintainer",
      fileName: "teamwitharrow.yaml",
      filter: {
        subjectType: "test/team",
        optionalSubjectIds: ["support_engineers"],
        optionalResourceRelation: "maintainer",
      } satisfies SubjectsFilter,
      // only the repository maintainer row
      expectedCount: 1,
    },
    // indirectnestedgroups: user:tom appears under THREE resource relations across two types
    // (document viewer, group direct_member, group intern).
    {
      label: "indirectnestedgroups group#intern",
      fileName: "indirectnestedgroups.yaml",
      filter: {
        subjectType: "user",
        optionalSubjectIds: ["tom"],
        optionalResourceType: "group",
        optionalResourceRelation: "intern",
      } satisfies SubjectsFilter,
      // the two other tom rows are excluded
      expectedCount: 1,
    },
  ])(
    "Narrowing_Reverse_Filters_Exclude_Rows_The_Shard_Holds($label)",
    async ({ label, fileName, filter, expectedCount }) => {
      const file = loadCorpusFile(fileName);

      const cluster = await MeshTestCluster.create(file.schemaText);
      try {
        await seed(cluster.datastore, file.relationships);

        const head = await cluster.datastore.headRevision();
        const sequencer: IGraphReader = cluster.datastore.snapshotReader(head.revision);
        const sharded: IGraphReader = new ShardedGraphReader(
          cluster.grainFactory,
          nanos(head.revision),
        );

        const failures: string[] = [];
        const narrowed = await collect(sequencer.reverseQueryRelationships(filter));
        compareSorted(
          [...narrowed],
          await collect(sharded.reverseQueryRelationships(filter)),
          `narrowed reverse ${label}`,
          failures,
        );
        expect(failures, `${fileName}: narrowing pass diverged:\n${failures.join("\n")}`).toEqual(
          [],
        );

        // The filter is genuinely narrowing: the subject's whole slice holds MORE rows than survive
        // it.
        const unfiltered = await collect(
          sharded.reverseQueryRelationships({
            subjectType: filter.subjectType,
            optionalSubjectIds: filter.optionalSubjectIds,
          }),
        );
        expect(narrowed.length).toBe(expectedCount);
        expect(
          unfiltered.length > narrowed.length,
          `case is not narrowing: slice has ${unfiltered.length} rows, filter kept ${narrowed.length}`,
        ).toBe(true);
      } finally {
        await cluster.dispose();
      }
    },
    180_000,
  );

  /**
   * The direct-check-shaped forward filter (scalability-program 3.2): resource pin PLUS the
   * three-selector subject union `CheckDirect` pushes down - exact subject, type-scoped public
   * wildcard, and every non-terminal subject. With the filter now applied SERVER-SIDE by the shard,
   * the sharded reader must still agree row-for-row with the sequencer-snapshot reader, AND the
   * result must retain the recursion-bearing categories: the pinned assertions prove the superset
   * union does not drop a non-terminal (userset re-dispatch) row nor, where the corpus has one, the
   * wildcard row. A union that dropped either category would pass a bare subject==S equality check
   * and still break Check recursion - this gate exists to make that regression loud.
   */
  it.each([
    {
      fileName: "indirectnestedgroups.yaml",
      resourceType: "document",
      resourceId: "firstdoc",
      resourceRelation: "viewer",
      subjectType: "user",
      subjectId: "tom",
      expectedNonTerminalRow: "document:firstdoc#viewer@group:engineering#non_intern_member",
      expectedWildcardRow: undefined,
    },
    {
      fileName: "simplewildcard.yaml",
      resourceType: "test/resource",
      resourceId: "first",
      resourceRelation: "viewer",
      subjectType: "test/user",
      subjectId: "anotheruser",
      expectedNonTerminalRow: undefined,
      expectedWildcardRow: "test/resource:first#viewer@test/user:*#...",
    },
  ])(
    "Direct_Check_Shaped_Subject_Union_Agrees_And_Keeps_Recursion_Bearing_Rows($fileName)",
    async ({
      fileName,
      resourceType,
      resourceId,
      resourceRelation,
      subjectType,
      subjectId,
      expectedNonTerminalRow,
      expectedWildcardRow,
    }) => {
      const file = loadCorpusFile(fileName);

      const cluster = await MeshTestCluster.create(file.schemaText);
      try {
        await seed(cluster.datastore, file.relationships);

        const head = await cluster.datastore.headRevision();
        const sequencer: IGraphReader = cluster.datastore.snapshotReader(head.revision);
        const sharded: IGraphReader = new ShardedGraphReader(
          cluster.grainFactory,
          nanos(head.revision),
        );

        // The exact union LocalDispatcher.checkDirect builds for an ellipsis check subject.
        const filter: RelationshipsFilter = {
          optionalResourceType: resourceType,
          optionalResourceIds: [resourceId],
          optionalResourceRelation: resourceRelation,
          optionalSubjectsSelectors: [
            {
              optionalSubjectType: subjectType,
              optionalSubjectIds: [subjectId],
              relationFilter: { includeEllipsisRelation: true },
            },
            {
              optionalSubjectType: subjectType,
              optionalSubjectIds: [PUBLIC_WILDCARD],
              relationFilter: { includeEllipsisRelation: true },
            },
            { relationFilter: { onlyNonEllipsisRelations: true } },
          ],
        };

        const expected = await collect(sequencer.queryRelationships(filter));
        const actual = await collect(sharded.queryRelationships(filter));
        const failures: string[] = [];
        compareSorted(
          expected,
          actual,
          `direct-check union ${resourceType}:${resourceId}#${resourceRelation}`,
          failures,
        );
        expect(
          failures,
          `${fileName}: direct-check-shaped pass diverged:\n${failures.join("\n")}`,
        ).toEqual([]);

        // Pin the recursion-bearing categories the union must never drop.
        if (expectedNonTerminalRow !== undefined) {
          expect(actual.some((r) => r.startsWith(expectedNonTerminalRow))).toBe(true);
        }
        if (expectedWildcardRow !== undefined) {
          expect(actual.some((r) => r.startsWith(expectedWildcardRow))).toBe(true);
        }
      } finally {
        await cluster.dispose();
      }
    },
    180_000,
  );

  /**
   * Forces the catch-up loop through a FULL 256-event page (`events.length === batchSize`, loop
   * again) rather than the single short-page drain every other gate happens to exercise: hydrate a
   * shard, advance the log by 300 commits on other resources plus one on this shard's key, then
   * demand the new head.
   */
  it("Shard_Catch_Up_Pages_Through_A_Full_Log_Batch", async () => {
    const schema = `definition user {}

definition doc {
  relation viewer: user
}`;
    const row = (docId: string, userId: string): Relationship =>
      createRelationship(
        { objectType: "doc", objectId: docId, relation: "viewer" },
        { objectType: "user", objectId: userId, relation: ELLIPSIS },
      );
    const write = (ds: IDatastore, rel: Relationship): Promise<IRevision> =>
      ds.readWriteTx((tx) => tx.writeRelationships([{ relationship: rel, operation: "create" }]));

    const cluster = await MeshTestCluster.create(schema);
    try {
      await write(cluster.datastore, row("x", "seed"));

      // Hydrate X's forward shard at the current head via a direct grain call.
      const shard = cluster.grainFactory.getGrain(
        IGraphShardGrain,
        graphShardGrainKeyBuild(graphShardKeyForResource("doc", "x")),
      );
      const headBefore = await cluster.datastore.headRevision();
      const hydrated = await shard.rowsAt(nanos(headBefore.revision), undefined);
      expect(hydrated.rows.length).toBe(1);

      // 300 single-row commits touching OTHER resources: more than one full readFrom page (256),
      // then one more commit on X itself so the catch-up has a matching row to fold at the tail.
      for (let i = 0; i < 300; i++) await write(cluster.datastore, row(`other-${i}`, "carol"));
      await write(cluster.datastore, row("x", "late"));

      const head = await cluster.datastore.headRevision();
      const reply = await shard.rowsAt(nanos(head.revision), undefined);
      const actual = reply.rows.map(toRelationship).map(canonical);

      expect(actual).toContain(canonical(row("x", "late")));

      const expected = await collect(
        cluster.datastore
          .snapshotReader(head.revision)
          .queryRelationships({ optionalResourceType: "doc", optionalResourceIds: ["x"] }),
      );
      const failures: string[] = [];
      compareSorted(expected, actual, "post-paging rows of doc:x", failures);
      expect(failures, `paged catch-up diverged:\n${failures.join("\n")}`).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 180_000);

  /**
   * GC through the grain: with `DatastoreGcOptions.window` = zero the floor a `runGc` computes is
   * `min(head, now) === head`, so it lands ABOVE the captured pre-delete revision Rd. A cold shard
   * must hydrate and serve correctly at head, a below-floor pin must be rejected with
   * `RevisionNotFoundException` ACROSS the grain boundary (the surrogate round-trip), and the
   * sharded reader at head must agree with the sequencer-snapshot reader.
   */
  it("Gc_Floor_Is_Enforced_Through_The_Shard_Grain", async () => {
    const schema = `definition user {}

definition doc {
  relation viewer: user
}`;
    const row = (docId: string, userId: string): Relationship =>
      createRelationship(
        { objectType: "doc", objectId: docId, relation: "viewer" },
        { objectType: "user", objectId: userId, relation: ELLIPSIS },
      );

    const cluster = await MeshTestCluster.create(schema, { gcWindow: { ms: 0 } });
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          { relationship: row("x", "alice"), operation: "create" },
          { relationship: row("cold", "carol"), operation: "create" },
        ]),
      );
      const rd = await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([{ relationship: row("x", "bob"), operation: "create" }]),
      );
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([{ relationship: row("x", "bob"), operation: "delete" }]),
      );

      // The floor is `min(head, now)` with a zero window, so the millisecond clock must first read
      // past the head those four commits minted - see `waitForClockPast`.
      await waitForClockPast(nanos((await cluster.datastore.headRevision()).revision));

      const floor = await cluster.grainFactory
        .getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY)
        .runGc();
      expect(floor).not.toBeUndefined();
      expect(
        floor! > nanos(rd),
        `Window=Zero GC floor ${floor} must land past Rd ${nanos(rd)}`,
      ).toBe(true);

      const head = await cluster.datastore.headRevision();

      // (a) A COLD shard - written before GC, first ever read now - hydrates from the post-GC
      // snapshot and serves correctly at head.
      const coldShard = cluster.grainFactory.getGrain(
        IGraphShardGrain,
        graphShardGrainKeyBuild(graphShardKeyForResource("doc", "cold")),
      );
      const coldRows = await coldShard.rowsAt(nanos(head.revision), undefined);
      expect(coldRows.rows.length).toBe(1);
      expect(coldRows.rows[0]!.subjectId).toBe("carol");

      // (b) A below-floor pin is rejected with the DOMAIN exception type across the grain boundary -
      // the revision-not-found surrogate must round-trip it, not surface a serialization failure.
      const xShard = cluster.grainFactory.getGrain(
        IGraphShardGrain,
        graphShardGrainKeyBuild(graphShardKeyForResource("doc", "x")),
      );
      expect(await rejection(xShard.rowsAt(nanos(rd), undefined))).toBeInstanceOf(
        RevisionNotFoundException,
      );

      // (c) At head, the sharded reader still agrees with the sequencer-snapshot reader.
      const sequencer: IGraphReader = cluster.datastore.snapshotReader(head.revision);
      const sharded: IGraphReader = new ShardedGraphReader(
        cluster.grainFactory,
        nanos(head.revision),
      );
      const failures: string[] = [];
      for (const id of ["x", "cold"]) {
        const filter: RelationshipsFilter = {
          optionalResourceType: "doc",
          optionalResourceIds: [id],
        };
        compareSorted(
          await collect(sequencer.queryRelationships(filter)),
          await collect(sharded.queryRelationships(filter)),
          `post-GC forward doc:${id}`,
          failures,
        );
      }
      for (const subjectId of ["alice", "carol", "bob"]) {
        const filter: SubjectsFilter = {
          subjectType: "user",
          optionalSubjectIds: [subjectId],
        };
        compareSorted(
          await collect(sequencer.reverseQueryRelationships(filter)),
          await collect(sharded.reverseQueryRelationships(filter)),
          `post-GC reverse user:${subjectId}`,
          failures,
        );
      }
      expect(failures, `post-GC head reads diverged:\n${failures.join("\n")}`).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 180_000);

  /**
   * The WARM-shard counterpart of `Gc_Floor_Is_Enforced_Through_The_Shard_Grain`: a shard hydrated
   * BEFORE GC must, without deactivating, (a) serve post-GC-correct rows at the new head by folding
   * the `GcApplied` event through its tail catch-up, and (b) reject a below-floor pin with
   * `RevisionNotFoundException` from that same warm activation. The window is small but NONZERO:
   * with zero the singleton's per-commit tail trim always empties the retained log, so a warm shard
   * could only re-bootstrap - the GC event would never reach it through the catch-up fold this gate
   * exists to pin. The shard hydrates at the post-delete head, so the GC floor
   * (`min(head, now - window)`, after the delay) lands EXACTLY on its watermark: the catch-up then
   * serves the GcApplied event from the retained tail rather than re-hydrating.
   */
  it("Warm_Shard_Folds_GcApplied_And_Rejects_Below_Floor_Without_Reactivation", async () => {
    const schema = `definition user {}

definition doc {
  relation viewer: user
}`;
    const row = (docId: string, userId: string): Relationship =>
      createRelationship(
        { objectType: "doc", objectId: docId, relation: "viewer" },
        { objectType: "user", objectId: userId, relation: ELLIPSIS },
      );

    const gcWindow: Duration = { ms: 200 };
    const cluster = await MeshTestCluster.create(schema, { gcWindow });
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([{ relationship: row("x", "alice"), operation: "create" }]),
      );
      const rd = await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([{ relationship: row("x", "bob"), operation: "create" }]),
      );
      const r2 = await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([{ relationship: row("x", "bob"), operation: "delete" }]),
      );

      // Hydrate the shard WARM at the post-delete head: its state carries bob's full MVCC history
      // and no GC floor yet, and its watermark sits exactly at r2.
      const shard = cluster.grainFactory.getGrain(
        IGraphShardGrain,
        graphShardGrainKeyBuild(graphShardKeyForResource("doc", "x")),
      );
      const preGc = await shard.rowsAt(nanos(r2), undefined);
      expect(preGc.rows.length).toBe(1);
      expect(preGc.rows[0]!.subjectId).toBe("alice");

      // Let wall-clock pass the retention window, then GC: the floor becomes min(head, now - window)
      // = head = r2 - past the delete (rd's row history is collected) and exactly at the warm
      // shard's watermark, which is the premise that forces the catch-up to FOLD the GcApplied event
      // from the retained tail (a floor above the watermark would force a re-bootstrap instead).
      await sleep({ ms: (gcWindow.ms ?? 0) + 100 });
      // Same coarse-clock premise as the zero-window case: `now - window` must read past r2 for the
      // floor to land exactly on the warm shard's watermark. The 300ms sleep above all but
      // guarantees it; this makes it certain rather than probable.
      await waitForClockPast(nanos(r2) + BigInt(gcWindow.ms ?? 0) * 1_000_000n);
      const floor = await cluster.grainFactory
        .getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY)
        .runGc();
      expect(floor).not.toBeUndefined();
      expect(floor! > nanos(rd), `GC floor ${floor} must land past Rd ${nanos(rd)}`).toBe(true);
      expect(floor).toBe(nanos(r2));

      const head = await cluster.datastore.headRevision();

      // (a) WITHOUT deactivating: the warm shard catches up by folding the GcApplied event and
      // serves post-GC-correct rows at the new head, agreeing with the sequencer-snapshot reader.
      const atHead = await shard.rowsAt(nanos(head.revision), undefined);
      expect(atHead.rows.length).toBe(1);
      expect(atHead.rows[0]!.subjectId).toBe("alice");

      const expected = await collect(
        cluster.datastore
          .snapshotReader(head.revision)
          .queryRelationships({ optionalResourceType: "doc", optionalResourceIds: ["x"] }),
      );
      const actual = atHead.rows.map(toRelationship).map(canonical);
      const failures: string[] = [];
      compareSorted(expected, actual, "post-GC warm rows of doc:x", failures);
      expect(failures, `warm post-GC read diverged:\n${failures.join("\n")}`).toEqual([]);

      // (b) The SAME warm activation - its state now carries the folded floor - rejects a
      // below-floor pin with the domain exception across the grain boundary.
      expect(await rejection(shard.rowsAt(nanos(rd), undefined))).toBeInstanceOf(
        RevisionNotFoundException,
      );
    } finally {
      await cluster.dispose();
    }
  }, 180_000);
});
