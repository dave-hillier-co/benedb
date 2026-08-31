import { ELLIPSIS } from "@benedb/core/core-constants";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import type { RelationshipUpdateWire } from "@benedb/grains/relationships-dtos";
import type {
  ExportBulkRelationshipsRequest,
  ExportBulkRelationshipsResponse,
  ImportBulkRelationshipsRequest,
  Relationship as ProtoRelationship,
} from "@benedb/protos/permissions";
import { describe, expect, it } from "vitest";

import { BulkGrpcService } from "./bulk-grpc-service";
import { CollectingStreamWriter } from "./collecting-stream-writer";
import type { ServerStreamWriter } from "./server-stream-writer";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/BulkGrpcServiceTests.cs`.
 *
 * Drives the streaming {@link BulkGrpcService} IN-PROCESS (no listener, no socket): an async
 * iterable stands in for the fake `IAsyncStreamReader<T>` feeding the client-streaming import, a
 * collecting {@link ServerStreamWriter} drains the server-streaming export, and an `AbortSignal`
 * carries cancellation. Verifies: import across multiple batches returns the total count; export
 * pages back the exact same set (round-trip); export resumes from a mid-stream cursor; an export
 * pinned at a snapshot does not see later writes.
 *
 * PORT NOTES.
 *  - LEDGER DEVIATION: lands in `packages/api/src` rather than `packages/grains/src`, because
 *    `@benedb/grains` does not depend on `@benedb/api` (see `data-plane-grpc-service-tests.test.ts`
 *    for the full note). It is DISTINCT from the S5 characterization file `bulk-grpc-service.test.ts`,
 *    which pins the translation and stream control flow over fakes; neither restates the other.
 *  - STREAMING SEAMS. `IAsyncStreamReader<T>` becomes a plain `AsyncIterable<T>`, so `FakeStreamReader`
 *    is {@link streamOf} - an async generator that observes the signal on every pull, exactly as the
 *    C#'s `MoveNext(cancellationToken)` does. `IServerStreamWriter<T>` becomes
 *    {@link ServerStreamWriter}, and `ServerCallContext` becomes a trailing `AbortSignal`, so
 *    `FakeServerCallContext` disappears entirely.
 *  - `new CancellationTokenSource(TimeSpan.FromSeconds(30))` becomes a plain {@link AbortController}
 *    with NO timer: vitest's own per-case timeout is the backstop, and a stray 30s timer would keep
 *    the event loop alive past the end of the run.
 *  - `CancelAfterFirstStreamWriter` is kept as {@link CancelAfterFirstStreamWriter}: aborting inside
 *    `write` is the "client reads one page then disconnects" shape, and it is what pins the export
 *    loop's exit condition. The trailing partial batch the C# still flushes after the cancellation
 *    break is likewise still flushed here.
 *  - `$"doc{i:D4}"` is `String(i).padStart(4, "0")`. THE WIDTH IS WIRE-VISIBLE: the ids drive the
 *    canonical tuple ordering the export cursor pages by, so a different width would change which
 *    rows land on which page.
 *  - `OrderBy(k, StringComparer.Ordinal)` is an EXPLICIT code-unit comparator, never the
 *    locale-aware default of `Array.prototype.sort` without one.
 *  - `Assert.Equal(300UL, response.NumLoaded)` is `expect(resp.numLoaded).toBe("300")`: `num_loaded`
 *    is a uint64, which ts-proto renders as a STRING. The grains DTO's `numLoaded` is a `bigint`;
 *    the two are never crossed.
 *  - `await using var cluster` becomes an explicit `try { ... } finally { await cluster.dispose(); }`.
 */

const SchemaText = `definition user {}
definition document {
    relation viewer: user
    permission view = viewer
}`;

function service(cluster: MeshTestCluster): BulkGrpcService {
  return new BulkGrpcService(cluster.grainFactory, cluster.relationshipReads);
}

/** `Viewer(doc, user)`. */
function viewer(doc: string, user: string): ProtoRelationship {
  return {
    resource: { objectType: "document", objectId: doc },
    resourceRelation: "viewer",
    subject: {
      object: { objectType: "user", objectId: user },
      optionalRelation: "",
    },
    optionalExpiresAtUnixSeconds: "0",
  };
}

/** `$"doc{i:D4}"`. */
function docId(i: number): string {
  return `doc${String(i).padStart(4, "0")}`;
}

/** `Key(ProtoRelationship)`. */
function key(r: ProtoRelationship): string {
  return `${r.resource?.objectId ?? ""}#${r.subject?.object?.objectId ?? ""}`;
}

/** `OrderBy(k => k, StringComparer.Ordinal)`. */
function ordinal(keys: readonly string[]): string[] {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** `FakeStreamReader<T>`: the C# checks the token on every `MoveNext`, so the generator does too. */
async function* streamOf<T>(
  messages: readonly T[],
  signal?: AbortSignal | undefined,
): AsyncGenerator<T> {
  for (const message of messages) {
    signal?.throwIfAborted();
    yield message;
  }
}

/** `CancelAfterFirstStreamWriter<T>`: records responses and aborts after the first write. */
class CancelAfterFirstStreamWriter<T> implements ServerStreamWriter<T> {
  readonly collected: T[] = [];

  constructor(private readonly controller: AbortController) {}

  async write(message: T): Promise<void> {
    this.collected.push(message);
    this.controller.abort();
  }
}

/**
 * `FirstPage`: reads exactly one export page. The per-call controller is aborted the moment the
 * first page is written, so the server's "keep paging while a cursor is returned" loop exits after
 * one page - modelling a client that reads a single page then disconnects.
 */
async function firstPage(
  svc: BulkGrpcService,
  request: ExportBulkRelationshipsRequest,
): Promise<ExportBulkRelationshipsResponse> {
  const controller = new AbortController();
  const writer = new CancelAfterFirstStreamWriter<ExportBulkRelationshipsResponse>(controller);
  await svc.exportBulkRelationships(request, writer, controller.signal);
  return writer.collected[0] as ExportBulkRelationshipsResponse;
}

/** An export request with every field the C# leaves at its proto default spelled out. */
function exportRequest(
  fields: Partial<ExportBulkRelationshipsRequest>,
): ExportBulkRelationshipsRequest {
  return { optionalLimit: 0, optionalCursor: "", ...fields };
}

describe("BulkGrpcServiceTests", () => {
  it("Import_across_batches_returns_total_count", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      // 300 relationships fed as three 100-row batches.
      const batches: ImportBulkRelationshipsRequest[] = [];
      for (let b = 0; b < 3; b++) {
        const relationships: ProtoRelationship[] = [];
        for (let i = 0; i < 100; i++) relationships.push(viewer(docId(b * 100 + i), "alice"));
        batches.push({ relationships });
      }

      const controller = new AbortController();
      const response = await svc.importBulkRelationships(
        streamOf(batches, controller.signal),
        controller.signal,
      );

      expect(response.numLoaded).toBe("300");
      expect(response.loadedAt).not.toBeUndefined();
      expect(response.loadedAt?.token ?? "").not.toBe("");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Export_round_trips_the_imported_set", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const imported: ProtoRelationship[] = [];
      for (let i = 0; i < 250; i++) imported.push(viewer(docId(i), "alice"));

      const controller = new AbortController();
      const importResp = await svc.importBulkRelationships(
        streamOf([{ relationships: imported }], controller.signal),
        controller.signal,
      );
      expect(importResp.numLoaded).toBe("250");

      // Export with a small page size so multiple pages are exercised.
      const writer = new CollectingStreamWriter<ExportBulkRelationshipsResponse>();
      await svc.exportBulkRelationships(
        exportRequest({ optionalLimit: 60 }),
        writer,
        controller.signal,
      );

      const exported = writer.collected.flatMap((p) => p.relationships);
      expect(exported.length).toBe(imported.length);
      expect(ordinal(exported.map(key))).toEqual(ordinal(imported.map(key)));

      // More than one page emitted at this page size.
      expect(writer.collected.length > 1).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Export_resumes_from_a_mid_stream_cursor", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const relationships: ProtoRelationship[] = [];
      for (let i = 0; i < 100; i++) relationships.push(viewer(docId(i), "alice"));
      const controller = new AbortController();
      await svc.importBulkRelationships(
        streamOf([{ relationships }], controller.signal),
        controller.signal,
      );

      // First page (size 40): grab its after_cursor. A per-call controller aborts after the first
      // page so the server loop stops, simulating a client that reads one page then disconnects.
      const page = await firstPage(svc, exportRequest({ optionalLimit: 40 }));
      expect(page.relationships.length).toBe(40);
      expect(page.afterCursor).not.toBe("");

      // Resume from that cursor: the remaining 60 must come back, with no overlap.
      const resumeWriter = new CollectingStreamWriter<ExportBulkRelationshipsResponse>();
      await svc.exportBulkRelationships(
        exportRequest({ optionalLimit: 40, optionalCursor: page.afterCursor }),
        resumeWriter,
        controller.signal,
      );

      const firstKeys = new Set(page.relationships.map(key));
      const resumed = resumeWriter.collected.flatMap((p) => p.relationships).map(key);
      expect(resumed.length).toBe(60);
      // strictly after the cursor, no overlap
      expect(resumed.some((k) => firstKeys.has(k))).toBe(false);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Export_pinned_snapshot_does_not_see_later_writes", async () => {
    const cluster = await MeshTestCluster.create(SchemaText);
    try {
      const svc = service(cluster);

      const relationships: ProtoRelationship[] = [];
      for (let i = 0; i < 100; i++) relationships.push(viewer(docId(i), "alice"));
      const controller = new AbortController();
      await svc.importBulkRelationships(
        streamOf([{ relationships }], controller.signal),
        controller.signal,
      );

      // Start the export and read ONLY the first page (pins the snapshot at this revision).
      const pinnedCursor = (await firstPage(svc, exportRequest({ optionalLimit: 40 }))).afterCursor;

      // Write MORE relationships AFTER the snapshot was pinned.
      const update: RelationshipUpdateWire = {
        operation: "touch",
        relationship: {
          resourceType: "document",
          resourceId: "doc9999",
          resourceRelation: "viewer",
          subjectType: "user",
          subjectId: "zzz",
          subjectRelation: ELLIPSIS,
        },
      };
      await cluster.relationships.writeRelationships({ updates: [update] });

      // Resume the pinned export to exhaustion: it must total exactly 100 (40 + 60), never 101.
      const rest = new CollectingStreamWriter<ExportBulkRelationshipsResponse>();
      await svc.exportBulkRelationships(
        exportRequest({ optionalLimit: 40, optionalCursor: pinnedCursor }),
        rest,
        controller.signal,
      );

      const restKeys = rest.collected.flatMap((p) => p.relationships).map(key);
      expect(restKeys.length).toBe(60);
      expect(restKeys).not.toContain("doc9999#zzz");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
