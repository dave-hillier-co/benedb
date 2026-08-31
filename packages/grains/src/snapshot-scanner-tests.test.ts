import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { CounterNotRegisteredException } from "@benedb/datastore/datastore-exceptions";
import type { RelationshipsFilter } from "@benedb/datastore/relationships-filter";

import type { ISnapshotScanner } from "./i-snapshot-scanner";
import { MeshTestCluster } from "./mesh-test-cluster";
import {
  CounterOperationException,
  type RelationshipStreamItem,
  type RelationshipWire,
} from "./relationships-dtos";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/SnapshotScannerTests.cs`.
 *
 * Gates for the storage-direct scan seam (`ISnapshotScanner`, `docs/graph-sharded-datastore.md`
 * section 3) now that it is the ONLY broad-read path: the ReadRelationships-shaped scan shapes
 * served through the DI scanner must agree exactly with the same filters through the
 * sequencer-snapshot reader (`GrainBackedDatastore.snapshotReader`) at the same pinned revision; the
 * on-demand counter lifecycle driven through the data-plane RPC path must agree with both scanner
 * and reader counts (including MVCC time travel across the unregister tombstone); and a bulk export
 * resumed from a mid-stream cursor must reproduce the uninterrupted run's remainder with
 * byte-identical resume tokens - the reconnect contract a client's cursor depends on.
 *
 * PORT NOTES.
 *  - `cluster.Services.GetRequiredService<ISnapshotScanner>()` is `cluster.services.snapshotScanner`
 *    (the DI record already wires `GrainSnapshotScanner`).
 *  - `scanner.Scan(filter, head, CancellationToken.None)` is `scan(filter, revision)` with NO
 *    signal - the port's third parameter is optional.
 *  - `CountRelationships` returns `Promise<bigint>`, so `3UL` is `3n`. A bigint is never compared
 *    against a number here: `toBe(3n)` and bigint arithmetic throughout.
 *  - TWO DIFFERENT exception types are asserted on two different paths and are NOT collapsed: the
 *    grain wire type `CounterOperationException` (its `kind` is a string union, not an enum) on the
 *    RPC path, and the datastore type `CounterNotRegisteredException` out of the scanner.
 *  - `await using` -> an explicit `try { ... } finally { await cluster.dispose(); }`.
 *  - C# has two `Canonical` OVERLOADS (`Relationship` and `RelationshipWire`); TypeScript has no
 *    overloading, so they become `canonicalRelationship` and `canonicalWire`.
 *  - `$"d{i:D3}"` is `String(i).padStart(3, "0")`.
 *  - `exp:O` renders a .NET `DateTimeOffset`; the port's expiration is epoch NANOS as a `bigint`,
 *    so it renders as the bigint itself (the fixture rows here carry no expiration at all).
 */

const SCHEMA = `definition user {}

definition folder {
  relation viewer: user
}

definition doc {
  relation viewer: user | user:*
  relation editor: user
}`;

/** The C# `Row`. */
function row(
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
): Relationship {
  return createRelationship(
    { objectType: resourceType, objectId: resourceId, relation },
    { objectType: subjectType, objectId: subjectId, relation: ELLIPSIS },
  );
}

/**
 * Fixed rows exercising each scan shape: two resource types, a shared `plan-` id prefix, a
 * wildcard subject row, and one subject (`alice`) spanning both types.
 */
const ROWS: readonly Relationship[] = [
  row("doc", "plan-a", "viewer", "user", "alice"),
  row("doc", "plan-b", "viewer", "user", "bob"),
  row("doc", "plan-a", "editor", "user", "carol"),
  row("doc", "spec", "viewer", "user", "*"),
  row("doc", "spec", "editor", "user", "alice"),
  row("folder", "root", "viewer", "user", "alice"),
];

function creates(rows: readonly Relationship[]): readonly RelationshipUpdate[] {
  return rows.map((relationship) => ({ relationship, operation: "create" as const }));
}

/** The C# `ClusterWithRows`. */
async function clusterWithRows(): Promise<MeshTestCluster> {
  const cluster = await MeshTestCluster.create(SCHEMA);
  await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(creates(ROWS)));
  return cluster;
}

async function collectCounterNames(
  scanner: ISnapshotScanner,
  revision: IRevision,
): Promise<string[]> {
  const names: string[] = [];
  for await (const counter of scanner.lookupCounters(revision)) names.push(counter.name);
  return names;
}

async function collect(source: AsyncIterable<Relationship>): Promise<string[]> {
  const rows: string[] = [];
  for await (const rel of source) rows.push(canonicalRelationship(rel));
  return rows;
}

async function collectItems(
  source: AsyncIterable<RelationshipStreamItem>,
): Promise<RelationshipStreamItem[]> {
  const items: RelationshipStreamItem[] = [];
  for await (const item of source) items.push(item);
  return items;
}

/** `StringComparer.Ordinal` ordering - bare `<`/`>`, never `localeCompare`. */
function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareSorted(
  expected: string[],
  actual: string[],
  label: string,
  failures: string[],
): void {
  expected.sort(ordinal);
  actual.sort(ordinal);
  if (expected.length !== actual.length || expected.some((v, i) => v !== actual[i])) {
    failures.push(
      `  ${label}:\n    reader:  [${expected.join(", ")}]\n    scanner: [${actual.join(", ")}]`,
    );
  }
}

// Canonical string forms: this file's fixture rows carry no caveat context, so identity plus the
// caveat name and expiration suffices (no nested-context canonicalization needed here - see
// sharded-reader-equivalence-tests.test.ts for the full treatment).

function canonicalRelationship(rel: Relationship): string {
  const { resource, subject } = rel.reference;
  return (
    `${resource.objectType}:${resource.objectId}#${resource.relation}` +
    `@${subject.objectType}:${subject.objectId}#${subject.relation}` +
    (rel.optionalCaveat !== undefined ? `[${rel.optionalCaveat.caveatName}]` : "") +
    (rel.optionalExpiration !== undefined ? `@exp=${rel.optionalExpiration}` : "")
  );
}

function canonicalWire(rel: RelationshipWire): string {
  return (
    `${rel.resourceType}:${rel.resourceId}#${rel.resourceRelation}` +
    `@${rel.subjectType}:${rel.subjectId}#${rel.subjectRelation}` +
    (rel.caveatName !== undefined && rel.caveatName.length > 0 ? `[${rel.caveatName}]` : "") +
    (rel.expiration !== undefined ? `@exp=${rel.expiration}` : "")
  );
}

/** Awaits a rejection and hands back the thrown value, so BOTH its type and its fields assert. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to reject, but it resolved");
}

describe("SnapshotScannerTests", () => {
  /**
   * The three ReadRelationships scan shapes - broad (type only), resource-id prefix, and
   * subject-selector (no resource constraint at all) - through the DI `ISnapshotScanner` must return
   * exactly the rows the sequencer-snapshot reader returns for the same filter at the same revision
   * (multiset compare on canonical strings). Each shape's expected count is pinned so a filter that
   * silently matched nothing (or everything) cannot pass vacuously.
   */
  it("Scanner_Agrees_With_The_Sequencer_Snapshot_Reader_Across_Scan_Shapes", async () => {
    const cluster = await clusterWithRows();
    try {
      const scanner = cluster.services.snapshotScanner;
      const head = (await cluster.datastore.headRevision()).revision;
      const reader = cluster.datastore.snapshotReader(head);

      const shapes: readonly {
        readonly label: string;
        readonly filter: RelationshipsFilter;
        readonly expectedCount: number;
      }[] = [
        { label: "broad type-only", filter: { optionalResourceType: "doc" }, expectedCount: 5 },
        {
          label: "resource-id prefix",
          filter: { optionalResourceType: "doc", optionalResourceIdPrefix: "plan-" },
          expectedCount: 3,
        },
        {
          label: "subject-selector",
          filter: {
            optionalSubjectsSelectors: [
              { optionalSubjectType: "user", optionalSubjectIds: ["alice"] },
            ],
          },
          expectedCount: 3,
        },
      ];

      const failures: string[] = [];
      for (const { label, filter, expectedCount } of shapes) {
        const viaReader = await collect(reader.queryRelationships(filter));
        const viaScanner = await collect(scanner.scan(filter, head));
        expect(viaReader.length).toBe(expectedCount);
        compareSorted(viaReader, viaScanner, label, failures);
      }

      expect(
        failures,
        `${failures.length} scan shape(s) diverged between the scanner and the snapshot reader:\n${failures.join("\n")}`,
      ).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  /**
   * A scan whose filter carries a subject selector WITH a relation filter that EXCLUDES rows present
   * in the state: `group:eng` appears as a subject both with the non-ellipsis relation `member` (the
   * doc viewer row) and with the ellipsis relation (the folder owner row), so a scanner that ignored
   * the selector's relation constraint would return both. Counts are pinned (1 narrowed, 2
   * unfiltered), not just reader agreement, so a filter that silently matched nothing or everything
   * cannot pass vacuously.
   */
  it("Scan_With_Subject_Relation_Filter_Excludes_Rows_The_State_Holds", async () => {
    const groupSchema = `definition user {}

definition group {
  relation member: user
}

definition folder {
  relation owner: group
}

definition doc {
  relation viewer: user | group#member
}`;
    const rows: readonly Relationship[] = [
      createRelationship(
        { objectType: "doc", objectId: "plan", relation: "viewer" },
        { objectType: "group", objectId: "eng", relation: "member" },
      ),
      createRelationship(
        { objectType: "folder", objectId: "root", relation: "owner" },
        { objectType: "group", objectId: "eng", relation: ELLIPSIS },
      ),
      createRelationship(
        { objectType: "group", objectId: "eng", relation: "member" },
        { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      ),
    ];

    const cluster = await MeshTestCluster.create(groupSchema);
    try {
      await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(creates(rows)));
      const scanner = cluster.services.snapshotScanner;
      const head = (await cluster.datastore.headRevision()).revision;
      const reader = cluster.datastore.snapshotReader(head);

      const narrowed: RelationshipsFilter = {
        optionalSubjectsSelectors: [
          {
            optionalSubjectType: "group",
            optionalSubjectIds: ["eng"],
            relationFilter: { nonEllipsisRelation: "member" },
          },
        ],
      };

      const viaReader = await collect(reader.queryRelationships(narrowed));
      const viaScanner = await collect(scanner.scan(narrowed, head));
      const failures: string[] = [];
      compareSorted(viaReader, viaScanner, "subject selector with relation filter", failures);
      expect(failures, `narrowed scan diverged:\n${failures.join("\n")}`).toEqual([]);
      expect(viaScanner).toEqual(["doc:plan#viewer@group:eng#member"]);

      // The relation filter genuinely narrowed: the same selector WITHOUT it also matches the
      // ellipsis-relation folder row the state holds.
      const unfiltered = await collect(
        scanner.scan(
          {
            optionalSubjectsSelectors: [
              { optionalSubjectType: "group", optionalSubjectIds: ["eng"] },
            ],
          },
          head,
        ),
      );
      expect(unfiltered.length).toBe(2);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  /**
   * The on-demand counter lifecycle through the data-plane RPC path (register, count, unregister on
   * `IRelationshipsGrain`) must agree with the same counter read through the scanner and the
   * snapshot reader at the same revisions: identical counts before and after a matching write; after
   * unregister, the RPC count fails NotRegistered, the scanner rejects the counter at the new head -
   * and still serves it at the pre-unregister head (the MVCC tombstone is revision-visible, not
   * destructive).
   */
  it("Counter_Lifecycle_Through_The_Rpc_Path_Agrees_With_Scanner_And_Reader", async () => {
    const cluster = await clusterWithRows();
    try {
      const scanner = cluster.services.snapshotScanner;

      await cluster.relationships.registerRelationshipCounter({
        name: "doc_viewers",
        filter: { resourceType: "doc", resourceRelation: "viewer" },
      });

      const first = await cluster.relationships.countRelationships({ name: "doc_viewers" });
      expect(first.count).toBe(3n); // plan-a, plan-b and the wildcard spec viewer rows

      const head1 = (await cluster.datastore.headRevision()).revision;
      expect(await scanner.countRelationships("doc_viewers", head1)).toBe(first.count);
      expect(await cluster.datastore.snapshotReader(head1).countRelationships("doc_viewers")).toBe(
        first.count,
      );
      expect(await scanner.readCounterFilter("doc_viewers", head1)).not.toBeUndefined();
      expect(await collectCounterNames(scanner, head1)).toContain("doc_viewers");

      // A write matching the counter filter moves the RPC, scanner and reader counts identically.
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships(creates([row("doc", "plan-c", "viewer", "user", "dave")])),
      );
      const second = await cluster.relationships.countRelationships({ name: "doc_viewers" });
      expect(second.count).toBe(first.count + 1n);

      const head2 = (await cluster.datastore.headRevision()).revision;
      expect(await scanner.countRelationships("doc_viewers", head2)).toBe(second.count);
      expect(await cluster.datastore.snapshotReader(head2).countRelationships("doc_viewers")).toBe(
        second.count,
      );

      // Unregister through the RPC path: the RPC count now fails with the typed NotRegistered error
      // across the grain boundary, and the scanner agrees at the new head.
      await cluster.relationships.unregisterRelationshipCounter({ name: "doc_viewers" });
      const rpcError = await rejection(
        cluster.relationships.countRelationships({ name: "doc_viewers" }),
      );
      expect(rpcError).toBeInstanceOf(CounterOperationException);
      expect((rpcError as CounterOperationException).kind).toBe("notRegistered");

      const head3 = (await cluster.datastore.headRevision()).revision;
      const scannerError = await rejection(scanner.countRelationships("doc_viewers", head3));
      expect(scannerError).toBeInstanceOf(CounterNotRegisteredException);
      expect(await scanner.readCounterFilter("doc_viewers", head3)).toBeUndefined();
      expect(await collectCounterNames(scanner, head3)).not.toContain("doc_viewers");

      // Time travel: at the pre-unregister head the counter still counts - the tombstone is a
      // revision-visible MVCC fact, not a destructive delete.
      expect(await scanner.countRelationships("doc_viewers", head2)).toBe(second.count);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  /**
   * Bulk-export reconnect contract at the `RelationshipReads` level: resuming from the cursor of a
   * mid-stream item must yield exactly the uninterrupted run's remainder - the same rows in the same
   * order AND byte-identical resume tokens for every remaining item (the cursor encodes the pinned
   * revision plus the last tuple, so both runs mint identical tokens). A row committed AFTER the
   * export pinned its snapshot must not leak into the resumed remainder.
   */
  it("Bulk_Export_Resumed_Mid_Stream_Yields_Byte_Identical_Remainder_Tokens", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships(
          creates(
            Array.from({ length: 30 }, (_unused, i) =>
              row("doc", `d${String(i).padStart(3, "0")}`, "viewer", "user", "alice"),
            ),
          ),
        ),
      );

      const args = {
        filter: { resourceType: "doc" },
        limit: 1000,
        cursor: undefined,
      } as const;

      const full = await collectItems(cluster.relationshipReads.bulkExportRelationships(args));
      expect(full.length).toBe(30);

      // A later matching write must be invisible to the resumed run (its cursor pins the revision).
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships(creates([row("doc", "d999", "viewer", "user", "zzz")])),
      );

      const mid = Math.trunc(full.length / 2);
      const midItem = full[mid];
      expect(midItem).not.toBeUndefined();
      const resumed = await collectItems(
        cluster.relationshipReads.bulkExportRelationships({
          ...args,
          cursor: midItem!.resumeCursor,
        }),
      );

      const expectedTail = full.slice(mid + 1);
      expect(resumed.length).toBe(expectedTail.length);
      expect(resumed.map((i) => canonicalWire(i.relationship))).toEqual(
        expectedTail.map((i) => canonicalWire(i.relationship)),
      );
      expect(resumed.map((i) => i.resumeCursor)).toEqual(expectedTail.map((i) => i.resumeCursor));
      expect(resumed.some((i) => i.relationship.resourceId === "d999")).toBe(false);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
