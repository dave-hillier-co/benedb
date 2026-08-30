import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { FormatError } from "@spacedb/core/format-error";
import { InvalidConsistencyTokenException } from "@spacedb/core/invalid-consistency-token-exception";
import { RevisionNotFoundException } from "@spacedb/datastore/datastore-exceptions";
import type { ConsistencyWire } from "@spacedb/grains/consistency-wire";
import { MINIMIZE_LATENCY_WIRE } from "@spacedb/grains/consistency-wire";
import {
  IRelationshipsGrain,
  RELATIONSHIPS_GRAIN_KEY,
} from "@spacedb/grains/i-relationships-grain";
import type { RelationshipReads } from "@spacedb/grains/relationship-reads";
import type {
  BulkExportRelationshipsArgs,
  BulkImportRelationshipsArgs,
  BulkImportRelationshipsReply,
  RelationshipStreamItem,
  RelationshipWire,
} from "@spacedb/grains/relationships-dtos";
import { SequencerOverloadedException } from "@spacedb/grains/sequencer-overloaded-exception";
import { WriteConflictException } from "@spacedb/grains/write-conflict-exception";
import type {
  ExportBulkRelationshipsResponse,
  ImportBulkRelationshipsRequest,
  Relationship,
} from "@spacedb/protos/permissions";
import { GrainTaskCanceledError } from "@thresh/core/errors";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { describe, expect, it } from "vitest";

import { BulkGrpcService } from "./bulk-grpc-service";
import { RpcError } from "./rpc-error";
import type { ServerStreamWriter } from "./server-stream-writer";

/**
 * Characterization test for `src/Spiceport.Api/BulkGrpcService.cs` - the `spiceport.v0` streaming
 * bulk import / export surface.
 *
 * SCOPE, deliberately. `tests/Spiceport.Grains.Tests/BulkGrpcServiceTests.cs` drives this file over
 * a live `MeshTestCluster` (import across batches, export round-trip, resume from a mid-stream
 * cursor, a pinned snapshot that does not see later writes) and is stage S5b's to port; none of its
 * cases is restated here. What this file pins instead is the TRANSLATION and the STREAM CONTROL
 * FLOW: whole-stream buffering, the empty-stream short circuit, batch flushing and the trailing
 * partial batch, and the per-RPC error mapping - over fakes of the two collaborators the C#
 * constructor takes (`IGrainFactory`, `RelationshipReads`).
 *
 * Reading notes for the C# this pins:
 *   * IMPORT BUFFERS THE WHOLE STREAM AND COMMITS ONCE (lines 37-55). The class doc-comment at
 *     lines 20-24 says the opposite ("calls the grain ONCE PER inbound batch"), as does the proto
 *     comment on `import_bulk_relationships`; the CODE is authoritative and the inline comment at
 *     37-41 explains why (whole-stream atomicity, observed against real spicedb 1.49.2). The code
 *     is what is ported; the stale doc-comment is not.
 *   * AN EMPTY STREAM SHORT-CIRCUITS to `num_loaded = 0` with NO `loaded_at` token, and the grain
 *     is never called. "Empty" means no RELATIONSHIPS, so a stream of empty batches short-circuits
 *     too.
 *   * EXPORT batch size is `limit > 0 ? limit : 1000`, the batch flushes when it REACHES that size,
 *     and a partial final batch is flushed AFTER the try/catch - including after a cancellation
 *     break (lines 122-130). That write-after-cancel is deliberate and observable.
 *   * Each response's `after_cursor` is the LAST item's `resume_cursor`.
 *   * The `limit` handed to `BulkExportRelationships` is the REQUEST's limit (0 included), not the
 *     resolved batch size.
 *   * ERROR MAPPING: `WriteConflictKind.CreateExisting` -> ALREADY_EXISTS and any other kind ->
 *     ABORTED; `SequencerOverloadedException` -> RESOURCE_EXHAUSTED; `InvalidConsistencyToken` /
 *     `RevisionNotFound` / `FormatException` -> INVALID_ARGUMENT. The cancellation catch carries a
 *     `when (context.CancellationToken.IsCancellationRequested)` filter, so a cancellation raised
 *     while the call was NOT cancelled propagates instead of ending the stream quietly.
 *
 * Port decisions this file also pins, because the C# construct has no TypeScript counterpart:
 *   * STREAMING SEAMS. `IServerStreamWriter<T>` becomes the port-local {@link ServerStreamWriter}
 *     (one `write(message): Promise<void>` member) and `IAsyncStreamReader<T>` becomes a plain
 *     `AsyncIterable<T>`; `ServerCallContext` becomes an `AbortSignal`, the only thing the C# reads
 *     off it. `@grpc/grpc-js`'s `ServerWritableStream` / `ServerReadableStream` are adapted onto
 *     those seams in `program.ts`, where Node backpressure is also handled - binding this service
 *     body to them would drag the transport in here and leave the S5b suites unportable.
 *   * `FormatException` has no TypeScript analogue. What a malformed bulk-export cursor throws is
 *     `@spacedb/core`'s {@link FormatError} (`BulkExportCursor.TryDecode`'s throw), and that is
 *     what the INVALID_ARGUMENT arm catches.
 *   * `catch (OperationCanceledException)` becomes Thresh's cancellation family
 *     (`ThreshCancellationError` or a DOM `AbortError`), matched on the TYPE, never on a message.
 *   * `num_loaded` is uint64: a ts-proto STRING out of a `bigint` reply (`String(reply.numLoaded)`),
 *     never through a JS `number`.
 *   * `new List<RelationshipStreamItem>(Math.Min(batchSize, 1024))` is a capacity hint only, so the
 *     port is a plain array and nothing observable depends on it.
 *   * Expiration is epoch NANOS `bigint` on the wire DTOs and unix SECONDS as a ts-proto string on
 *     the proto, so the two conversions are `* 1_000_000_000n` and `/ 1_000_000_000n`.
 */

// ---------------------------------------------------------------- fakes

class FakeRelationshipsGrain {
  readonly importArgs: BulkImportRelationshipsArgs[] = [];
  reply: BulkImportRelationshipsReply = { numLoaded: 0n, loadedAtToken: "loaded-token" };
  throws: unknown;

  async bulkImportRelationships(
    args: BulkImportRelationshipsArgs,
  ): Promise<BulkImportRelationshipsReply> {
    this.importArgs.push(args);
    if (this.throws !== undefined) throw this.throws;
    return this.reply;
  }
}

interface GrainLookup {
  readonly definition: GrainInterface<unknown>;
  readonly key: unknown;
}

class FakeGrainFactory implements GrainFactoryAccess {
  readonly lookups: GrainLookup[] = [];

  constructor(private readonly grain: FakeRelationshipsGrain) {}

  getGrain<T>(definition: GrainInterface<T>, key: unknown): T {
    this.lookups.push({ definition: definition as GrainInterface<unknown>, key });
    return this.grain as unknown as T;
  }

  createObjectReference<T>(): T {
    throw new Error("not supported");
  }

  deleteObjectReference(): void {
    throw new Error("not supported");
  }
}

/**
 * One scripted step of the fake export stream. `checkAbort` models the points at which a real
 * `bulkExportRelationships` observes its signal - NOT necessarily between every item, which is what
 * lets the trailing-partial-batch-after-cancel path be exercised.
 */
type ExportStep =
  | { readonly kind: "item"; readonly item: RelationshipStreamItem }
  | { readonly kind: "checkAbort" }
  | { readonly kind: "throw"; readonly error: unknown };

class FakeRelationshipReads {
  readonly args: BulkExportRelationshipsArgs[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  steps: readonly ExportStep[] = [];

  async *bulkExportRelationships(
    args: BulkExportRelationshipsArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<RelationshipStreamItem> {
    this.args.push(args);
    this.signals.push(signal);
    for (const step of this.steps) {
      if (step.kind === "throw") throw step.error;
      if (step.kind === "checkAbort") {
        signal?.throwIfAborted();
        continue;
      }
      yield step.item;
    }
  }
}

class CollectingWriter implements ServerStreamWriter<ExportBulkRelationshipsResponse> {
  readonly collected: ExportBulkRelationshipsResponse[] = [];
  /** Ran after each write - the hook the C# suite's `CancelAfterFirstStreamWriter` provides. */
  onWrite: ((message: ExportBulkRelationshipsResponse) => void) | undefined;

  async write(message: ExportBulkRelationshipsResponse): Promise<void> {
    this.collected.push(message);
    this.onWrite?.(message);
  }
}

interface Harness {
  readonly service: BulkGrpcService;
  readonly grain: FakeRelationshipsGrain;
  readonly grains: FakeGrainFactory;
  readonly reads: FakeRelationshipReads;
  readonly writer: CollectingWriter;
}

function harness(): Harness {
  const grain = new FakeRelationshipsGrain();
  const grains = new FakeGrainFactory(grain);
  const reads = new FakeRelationshipReads();
  const service = new BulkGrpcService(grains, reads as unknown as RelationshipReads);
  return { service, grain, grains, reads, writer: new CollectingWriter() };
}

// ---------------------------------------------------------------- fixtures

function protoViewer(docId: string, userId = "alice"): Relationship {
  return {
    resource: { objectType: "document", objectId: docId },
    resourceRelation: "viewer",
    subject: { object: { objectType: "user", objectId: userId }, optionalRelation: "" },
    optionalExpiresAtUnixSeconds: "0",
  };
}

function batch(...relationships: readonly Relationship[]): ImportBulkRelationshipsRequest {
  return { relationships: [...relationships] };
}

async function* streamOf(
  ...messages: readonly ImportBulkRelationshipsRequest[]
): AsyncGenerator<ImportBulkRelationshipsRequest> {
  for (const message of messages) yield message;
}

function wireViewer(docId: string, userId = "alice"): RelationshipWire {
  return {
    resourceType: "document",
    resourceId: docId,
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: userId,
    subjectRelation: ELLIPSIS,
  };
}

function item(docId: string, cursor: string): ExportStep {
  return {
    kind: "item",
    item: { relationship: wireViewer(docId), resumeCursor: cursor },
  };
}

function items(count: number): ExportStep[] {
  return Array.from({ length: count }, (_, i) => item(`doc${i}`, `cursor-${i}`));
}

async function rpcErrorFrom(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(RpcError);
    return thrown as RpcError;
  }
  throw new Error("expected an RpcError, but the call succeeded");
}

// ---------------------------------------------------------------- importBulkRelationships

describe("importBulkRelationships", () => {
  it("buffers the WHOLE stream and commits it in ONE grain call, in stream order", async () => {
    const h = harness();
    h.grain.reply = { numLoaded: 4n, loadedAtToken: "tok" };

    const response = await h.service.importBulkRelationships(
      streamOf(
        batch(protoViewer("doc0"), protoViewer("doc1")),
        batch(protoViewer("doc2")),
        batch(protoViewer("doc3")),
      ),
    );

    expect(h.grain.importArgs).toHaveLength(1);
    expect(h.grain.importArgs[0]?.relationships.map((r) => r.resourceId)).toEqual([
      "doc0",
      "doc1",
      "doc2",
      "doc3",
    ]);
    expect(response.numLoaded).toBe("4");
    expect(response.loadedAt).toEqual({ token: "tok" });
  });

  it("resolves the relationships grain by its singleton key", async () => {
    const h = harness();

    await h.service.importBulkRelationships(streamOf(batch(protoViewer("doc0"))));

    expect(h.grains.lookups).toHaveLength(1);
    expect(h.grains.lookups[0]?.definition).toBe(IRelationshipsGrain);
    expect(h.grains.lookups[0]?.key).toBe(RELATIONSHIPS_GRAIN_KEY);
  });

  it("short-circuits an EMPTY stream to zero loaded with NO token, never calling the grain", async () => {
    const h = harness();

    const response = await h.service.importBulkRelationships(streamOf());

    expect(response.numLoaded).toBe("0");
    expect(response.loadedAt).toBeUndefined();
    expect(h.grain.importArgs).toEqual([]);
    expect(h.grains.lookups).toEqual([]);
  });

  it("short-circuits a stream of EMPTY batches the same way", async () => {
    const h = harness();

    const response = await h.service.importBulkRelationships(streamOf(batch(), batch()));

    expect(response.numLoaded).toBe("0");
    expect(response.loadedAt).toBeUndefined();
    expect(h.grain.importArgs).toEqual([]);
  });

  it("renders num_loaded through the bigint, keeping full 64-bit precision", async () => {
    const h = harness();
    h.grain.reply = { numLoaded: 9_007_199_254_740_993n, loadedAtToken: "tok" };

    const response = await h.service.importBulkRelationships(streamOf(batch(protoViewer("doc0"))));

    expect(response.numLoaded).toBe("9007199254740993");
  });

  it("defaults an empty subject relation to the ellipsis and keeps a real one", async () => {
    const h = harness();

    await h.service.importBulkRelationships(
      streamOf(
        batch(protoViewer("doc0"), {
          resource: { objectType: "document", objectId: "doc1" },
          resourceRelation: "viewer",
          subject: {
            object: { objectType: "group", objectId: "eng" },
            optionalRelation: "member",
          },
          optionalExpiresAtUnixSeconds: "0",
        }),
      ),
    );

    const wired = h.grain.importArgs[0]?.relationships;
    expect(wired?.[0]?.subjectRelation).toBe(ELLIPSIS);
    expect(wired?.[1]?.subjectRelation).toBe("member");
  });

  it("treats an expiration of 0 as absent and converts a real one to epoch nanos", async () => {
    const h = harness();

    await h.service.importBulkRelationships(
      streamOf(
        batch(protoViewer("doc0"), {
          ...protoViewer("doc1"),
          optionalExpiresAtUnixSeconds: "9999999999",
        }),
      ),
    );

    const wired = h.grain.importArgs[0]?.relationships;
    expect(wired?.[0]?.expiration).toBeUndefined();
    expect(wired?.[1]?.expiration).toBe(9_999_999_999_000_000_000n);
  });

  it("carries a caveat name and its context, converting the struct to a Map", async () => {
    const h = harness();

    await h.service.importBulkRelationships(
      streamOf(
        batch({
          ...protoViewer("doc0"),
          optionalCaveat: {
            caveatName: "only_on_tuesday",
            context: { day: "tuesday", hour: 9, nested: { k: "v" }, list: [1, "two"] },
          },
        }),
      ),
    );

    const wired = h.grain.importArgs[0]?.relationships[0];
    expect(wired?.caveatName).toBe("only_on_tuesday");
    expect(wired?.caveatContext).toEqual(
      new Map<string, unknown>([
        ["day", "tuesday"],
        ["hour", 9],
        ["nested", new Map<string, unknown>([["k", "v"]])],
        ["list", [1, "two"]],
      ]),
    );
  });

  it("drops an EMPTY caveat name but still takes the caveat's context - the C# asymmetry", async () => {
    const h = harness();

    await h.service.importBulkRelationships(
      streamOf(
        batch({
          ...protoViewer("doc0"),
          optionalCaveat: { caveatName: "", context: { day: "tuesday" } },
        }),
      ),
    );

    const wired = h.grain.importArgs[0]?.relationships[0];
    expect(wired?.caveatName).toBeUndefined();
    expect(wired?.caveatContext).toEqual(new Map<string, unknown>([["day", "tuesday"]]));
  });

  it("leaves the caveat context absent when the struct is empty", async () => {
    const h = harness();

    await h.service.importBulkRelationships(
      streamOf(batch({ ...protoViewer("doc0"), optionalCaveat: { caveatName: "c", context: {} } })),
    );

    expect(h.grain.importArgs[0]?.relationships[0]?.caveatContext).toBeUndefined();
  });

  it("maps a CREATE-existing write conflict to ALREADY_EXISTS", async () => {
    const h = harness();
    h.grain.throws = new WriteConflictException("createExisting", "relationship already exists");

    const error = await rpcErrorFrom(
      h.service.importBulkRelationships(streamOf(batch(protoViewer("doc0")))),
    );

    expect(error.code).toBe(status.ALREADY_EXISTS);
    expect(error.details).toBe("relationship already exists");
  });

  it("maps any other write conflict to ABORTED", async () => {
    const h = harness();
    h.grain.throws = new WriteConflictException("serialization", "serialization failure");

    const error = await rpcErrorFrom(
      h.service.importBulkRelationships(streamOf(batch(protoViewer("doc0")))),
    );

    expect(error.code).toBe(status.ABORTED);
    expect(error.details).toBe("serialization failure");
  });

  it("maps a shed commit to RESOURCE_EXHAUSTED", async () => {
    const h = harness();
    h.grain.throws = new SequencerOverloadedException("sequencer is saturated");

    const error = await rpcErrorFrom(
      h.service.importBulkRelationships(streamOf(batch(protoViewer("doc0")))),
    );

    expect(error.code).toBe(status.RESOURCE_EXHAUSTED);
    expect(error.details).toBe("sequencer is saturated");
  });

  it("lets any other grain failure propagate unmapped", async () => {
    const h = harness();
    const boom = new Error("boom");
    h.grain.throws = boom;

    await expect(
      h.service.importBulkRelationships(streamOf(batch(protoViewer("doc0")))),
    ).rejects.toBe(boom);
  });

  it("does not commit when the call is already cancelled", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();

    await expect(
      h.service.importBulkRelationships(streamOf(batch(protoViewer("doc0"))), controller.signal),
    ).rejects.toThrow();
    expect(h.grain.importArgs).toEqual([]);
  });
});

// ---------------------------------------------------------------- exportBulkRelationships

describe("exportBulkRelationships", () => {
  it("flushes a full batch at the request limit and the partial remainder at the end", async () => {
    const h = harness();
    h.reads.steps = items(5);

    await h.service.exportBulkRelationships({ optionalLimit: 2, optionalCursor: "" }, h.writer);

    expect(h.writer.collected.map((p) => p.relationships.length)).toEqual([2, 2, 1]);
    expect(h.writer.collected.map((p) => p.afterCursor)).toEqual([
      "cursor-1",
      "cursor-3",
      "cursor-4",
    ]);
  });

  it("writes nothing at all for an empty export", async () => {
    const h = harness();
    h.reads.steps = [];

    await h.service.exportBulkRelationships({ optionalLimit: 2, optionalCursor: "" }, h.writer);

    expect(h.writer.collected).toEqual([]);
  });

  it("emits exactly one page when the item count equals the limit - no trailing empty page", async () => {
    const h = harness();
    h.reads.steps = items(2);

    await h.service.exportBulkRelationships({ optionalLimit: 2, optionalCursor: "" }, h.writer);

    expect(h.writer.collected).toHaveLength(1);
    expect(h.writer.collected[0]?.relationships).toHaveLength(2);
  });

  it("falls back to a batch size of 1000 when the limit is 0", async () => {
    const h = harness();
    h.reads.steps = items(1001);

    await h.service.exportBulkRelationships({ optionalLimit: 0, optionalCursor: "" }, h.writer);

    expect(h.writer.collected.map((p) => p.relationships.length)).toEqual([1000, 1]);
  });

  it("passes the REQUEST's limit through to the read, not the resolved batch size", async () => {
    const h = harness();

    await h.service.exportBulkRelationships({ optionalLimit: 0, optionalCursor: "" }, h.writer);

    expect(h.reads.args[0]?.limit).toBe(0);
  });

  it("maps an absent filter to the all-fields-empty filter", async () => {
    const h = harness();

    await h.service.exportBulkRelationships({ optionalLimit: 10, optionalCursor: "" }, h.writer);

    expect(h.reads.args[0]?.filter).toEqual({
      resourceType: undefined,
      resourceIdPrefix: undefined,
      resourceIds: undefined,
      resourceRelation: undefined,
      subjectType: undefined,
      subjectIds: undefined,
      subjectRelation: undefined,
    });
  });

  it("maps a supplied filter, dropping every empty field", async () => {
    const h = harness();

    await h.service.exportBulkRelationships(
      {
        optionalLimit: 10,
        optionalCursor: "",
        optionalFilter: {
          resourceType: "document",
          optionalResourceIdPrefix: "",
          optionalResourceIds: ["doc1", "doc2"],
          optionalResourceRelation: "viewer",
          optionalSubjectType: "",
          optionalSubjectIds: [],
          optionalSubjectRelation: "member",
        },
      },
      h.writer,
    );

    expect(h.reads.args[0]?.filter).toEqual({
      resourceType: "document",
      resourceIdPrefix: undefined,
      resourceIds: ["doc1", "doc2"],
      resourceRelation: "viewer",
      subjectType: undefined,
      subjectIds: undefined,
      subjectRelation: "member",
    });
  });

  it("treats an EMPTY cursor string as no cursor and passes a set one through", async () => {
    const h = harness();

    await h.service.exportBulkRelationships({ optionalLimit: 10, optionalCursor: "" }, h.writer);
    await h.service.exportBulkRelationships(
      { optionalLimit: 10, optionalCursor: "resume-here" },
      h.writer,
    );

    expect(h.reads.args[0]?.cursor).toBeUndefined();
    expect(h.reads.args[1]?.cursor).toBe("resume-here");
  });

  it("maps every consistency requirement, defaulting an absent one to minimize-latency", async () => {
    const h = harness();
    const request = { optionalLimit: 10, optionalCursor: "" };

    await h.service.exportBulkRelationships(request, h.writer);
    await h.service.exportBulkRelationships(
      { ...request, consistency: { minimizeLatency: true } },
      h.writer,
    );
    await h.service.exportBulkRelationships(
      { ...request, consistency: { atLeastAsFresh: { token: "tok-fresh" } } },
      h.writer,
    );
    await h.service.exportBulkRelationships(
      { ...request, consistency: { fullyConsistent: true } },
      h.writer,
    );
    await h.service.exportBulkRelationships(
      { ...request, consistency: { atExactSnapshot: { token: "tok-exact" } } },
      h.writer,
    );

    const modes = h.reads.args.map((a) => a.consistency);
    expect(modes[0]).toBe(MINIMIZE_LATENCY_WIRE);
    expect(modes[1]).toBe(MINIMIZE_LATENCY_WIRE);
    expect(modes[2]).toEqual({
      mode: "atLeastAsFresh",
      token: "tok-fresh",
    } satisfies ConsistencyWire);
    expect(modes[3]).toEqual({ mode: "fullyConsistent" } satisfies ConsistencyWire);
    expect(modes[4]).toEqual({
      mode: "atExactSnapshot",
      token: "tok-exact",
    } satisfies ConsistencyWire);
  });

  it("passes the call's signal through to the read", async () => {
    const h = harness();
    const controller = new AbortController();

    await h.service.exportBulkRelationships(
      { optionalLimit: 10, optionalCursor: "" },
      h.writer,
      controller.signal,
    );

    expect(h.reads.signals[0]).toBe(controller.signal);
  });

  it("stops after the batch that cancelled the call, writing nothing more", async () => {
    // The C# suite's `CancelAfterFirstStreamWriter`: the client reads one page and disconnects.
    const h = harness();
    const controller = new AbortController();
    h.writer.onWrite = () => controller.abort();
    h.reads.steps = [...items(2), { kind: "checkAbort" }, ...items(2)];

    await expect(
      h.service.exportBulkRelationships(
        { optionalLimit: 2, optionalCursor: "" },
        h.writer,
        controller.signal,
      ),
    ).resolves.toBeUndefined();

    expect(h.writer.collected).toHaveLength(1);
  });

  it("still writes the trailing partial batch accumulated BEFORE the cancellation was observed", async () => {
    // Lines 122-130: the cancellation is swallowed and the trailing partial batch is written
    // anyway. Deliberate, and observable.
    const h = harness();
    const controller = new AbortController();
    h.writer.onWrite = () => controller.abort();
    h.reads.steps = [...items(3), { kind: "checkAbort" }];

    await h.service.exportBulkRelationships(
      { optionalLimit: 2, optionalCursor: "" },
      h.writer,
      controller.signal,
    );

    // Page one filled and cancelled the call; item three was already buffered and is flushed
    // AFTER the cancellation.
    expect(h.writer.collected.map((p) => p.relationships.length)).toEqual([2, 1]);
    expect(h.writer.collected[1]?.afterCursor).toBe("cursor-2");
  });

  it("lets a cancellation raised while the call was NOT cancelled propagate", async () => {
    // The C# catch carries `when (context.CancellationToken.IsCancellationRequested)`.
    const h = harness();
    const cancelled = new GrainTaskCanceledError();
    h.reads.steps = [{ kind: "throw", error: cancelled }];

    await expect(
      h.service.exportBulkRelationships({ optionalLimit: 2, optionalCursor: "" }, h.writer),
    ).rejects.toBe(cancelled);
  });

  it("maps an invalid consistency token to INVALID_ARGUMENT", async () => {
    const h = harness();
    h.reads.steps = [{ kind: "throw", error: new InvalidConsistencyTokenException("bad token") }];

    const error = await rpcErrorFrom(
      h.service.exportBulkRelationships({ optionalLimit: 2, optionalCursor: "" }, h.writer),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("bad token");
  });

  it("maps a collected revision to INVALID_ARGUMENT, not NOT_FOUND", async () => {
    const h = harness();
    h.reads.steps = [
      { kind: "throw", error: new RevisionNotFoundException(new TimestampRevision(3n)) },
    ];

    const error = await rpcErrorFrom(
      h.service.exportBulkRelationships({ optionalLimit: 2, optionalCursor: "" }, h.writer),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("revision 3 is no longer available");
  });

  it("maps a malformed cursor to INVALID_ARGUMENT", async () => {
    const h = harness();
    h.reads.steps = [{ kind: "throw", error: new FormatError("invalid bulk export cursor") }];

    const error = await rpcErrorFrom(
      h.service.exportBulkRelationships({ optionalLimit: 2, optionalCursor: "garbage" }, h.writer),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("invalid bulk export cursor");
  });

  it("does NOT flush the trailing partial batch when the stream faults", async () => {
    const h = harness();
    h.reads.steps = [
      ...items(3),
      { kind: "throw", error: new RevisionNotFoundException(new TimestampRevision(3n)) },
    ];

    await rpcErrorFrom(
      h.service.exportBulkRelationships({ optionalLimit: 2, optionalCursor: "" }, h.writer),
    );

    // The first full page stands; the buffered third item is lost with the throw.
    expect(h.writer.collected.map((p) => p.relationships.length)).toEqual([2]);
  });

  it("lets any other read failure propagate unmapped", async () => {
    const h = harness();
    const boom = new Error("boom");
    h.reads.steps = [{ kind: "throw", error: boom }];

    await expect(
      h.service.exportBulkRelationships({ optionalLimit: 2, optionalCursor: "" }, h.writer),
    ).rejects.toBe(boom);
  });

  it("maps an exported relationship back to proto, blanking an ellipsis subrelation", async () => {
    const h = harness();
    h.reads.steps = [
      {
        kind: "item",
        item: { relationship: wireViewer("doc0"), resumeCursor: "cursor-0" },
      },
    ];

    await h.service.exportBulkRelationships({ optionalLimit: 1, optionalCursor: "" }, h.writer);

    expect(h.writer.collected[0]?.relationships[0]).toEqual({
      resource: { objectType: "document", objectId: "doc0" },
      resourceRelation: "viewer",
      subject: { object: { objectType: "user", objectId: "alice" }, optionalRelation: "" },
      optionalExpiresAtUnixSeconds: "0",
    });
  });

  it("renders an exported expiration as unix seconds in a ts-proto string", async () => {
    const h = harness();
    h.reads.steps = [
      {
        kind: "item",
        item: {
          relationship: { ...wireViewer("doc0"), expiration: 9_999_999_999_123_456_789n },
          resumeCursor: "cursor-0",
        },
      },
    ];

    await h.service.exportBulkRelationships({ optionalLimit: 1, optionalCursor: "" }, h.writer);

    expect(h.writer.collected[0]?.relationships[0]?.optionalExpiresAtUnixSeconds).toBe(
      "9999999999",
    );
  });

  it("carries an exported caveat and its context back as a struct", async () => {
    const h = harness();
    h.reads.steps = [
      {
        kind: "item",
        item: {
          relationship: {
            ...wireViewer("doc0"),
            caveatName: "only_on_tuesday",
            caveatContext: new Map<string, unknown>([
              ["day", "tuesday"],
              ["nested", new Map<string, unknown>([["k", "v"]])],
              ["list", ["a", 1]],
            ]),
          },
          resumeCursor: "cursor-0",
        },
      },
    ];

    await h.service.exportBulkRelationships({ optionalLimit: 1, optionalCursor: "" }, h.writer);

    expect(h.writer.collected[0]?.relationships[0]?.optionalCaveat).toEqual({
      caveatName: "only_on_tuesday",
      context: { day: "tuesday", nested: { k: "v" }, list: ["a", 1] },
    });
  });

  it("emits no caveat at all when the wire relationship has no caveat name", async () => {
    const h = harness();
    h.reads.steps = [
      {
        kind: "item",
        item: {
          relationship: { ...wireViewer("doc0"), caveatName: "" },
          resumeCursor: "cursor-0",
        },
      },
    ];

    await h.service.exportBulkRelationships({ optionalLimit: 1, optionalCursor: "" }, h.writer);

    expect(h.writer.collected[0]?.relationships[0]?.optionalCaveat).toBeUndefined();
  });

  it("leaves an exported caveat's context unset when it is empty", async () => {
    const h = harness();
    h.reads.steps = [
      {
        kind: "item",
        item: {
          relationship: {
            ...wireViewer("doc0"),
            caveatName: "c",
            caveatContext: new Map<string, unknown>(),
          },
          resumeCursor: "cursor-0",
        },
      },
    ];

    await h.service.exportBulkRelationships({ optionalLimit: 1, optionalCursor: "" }, h.writer);

    expect(h.writer.collected[0]?.relationships[0]?.optionalCaveat).toEqual({
      caveatName: "c",
      context: undefined,
    });
  });
});
