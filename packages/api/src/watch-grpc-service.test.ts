import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { IRevisionParser } from "@spacedb/core/i-revision-parser";
import { createRelationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import {
  RevisionNotFoundException,
  WatchDisabledException,
} from "@spacedb/datastore/datastore-exceptions";
import type { IDatastore, RevisionWithSchemaHash } from "@spacedb/datastore/i-datastore";
import { TimestampRevisionParser } from "@spacedb/datastore/timestamp-revision-parser";
import type { RevisionChange, WatchOptions } from "@spacedb/datastore/watch";
import { WatchContent } from "@spacedb/datastore/watch";
import { MutableSchemaProvider } from "@spacedb/grains/i-schema-provider";
import { RelationshipUpdate_Operation, WatchKind } from "@spacedb/protos/permissions";
import type { WatchResponse } from "@spacedb/protos/permissions";
import { GrainTaskCanceledError } from "@thresh/core/errors";
import { describe, expect, it } from "vitest";

import { RpcError } from "./rpc-error";
import type { ServerStreamWriter } from "./server-stream-writer";
import { WatchGrpcService } from "./watch-grpc-service";

/**
 * Characterization test for `src/Spiceport.Api/WatchGrpcService.cs` - the `spiceport.v0`
 * server-streaming changefeed.
 *
 * SCOPE, deliberately. `tests/Spiceport.Grains.Tests/WatchGrpcServiceTests.cs` drives this file
 * over a live `MeshTestCluster` (tail-from-head, resume-from-a-pre-write-token, cancellation, and
 * a cursor below the GC floor) and is stage S5b's to port; none of its cases is restated here.
 * What a live mesh cannot easily produce, and what this file pins instead, is the ORDER OF
 * OPERATIONS the C# fixes, the lazy-iterator catch placement, and the proto translation - over a
 * fake datastore whose changefeed is scripted step by step.
 *
 * Reading notes for the C# this pins:
 *   * ORDER (lines 34-58): resolve content -> decode-or-default the start cursor -> `GetUniqueId`
 *     -> create the enumerator -> loop. The cursor is resolved BEFORE `GetUniqueId`, and an absent
 *     cursor falls back to HEAD, so a watch with no cursor tails only FUTURE writes.
 *   * LAZY ITERATOR (lines 61-88, and the C# comment says so): an async-iterator body does not run
 *     until the first `MoveNextAsync`, so `RevisionNotFoundException` / `WatchDisabledException`
 *     surface from inside the loop, never from `GetAsyncEnumerator`. Both map to
 *     FAILED_PRECONDITION; `OperationCanceledException` breaks the loop and ends the stream
 *     NORMALLY, with no error and nothing further written.
 *   * The loop re-checks cancellation AFTER a successful move and BEFORE writing, so a change
 *     produced by a move that raced the cancel is dropped rather than written.
 *   * `finally { await enumerator.DisposeAsync(); }` runs on every exit path, the mapped throws
 *     included.
 *   * `ResolveContent`: an empty `optional_update_kinds` is Relationships; otherwise the flags are
 *     OR-ed, with INCLUDE_SCHEMA_UPDATES -> Schema and EVERYTHING ELSE (UNSPECIFIED and
 *     INCLUDE_RELATIONSHIP_UPDATES included) -> Relationships.
 *   * The response's `changes_through` is minted from `schemaProvider.Current.SchemaHash` read at
 *     WRITE time, so a schema swap mid-stream changes the token the next response carries.
 *   * `SchemaUpdated` comes from `change.SchemaChanged`. The v0 response has no `is_checkpoint`
 *     field and no object-type filter; both are v1-only.
 *
 * Port decisions this file also pins, because the C# construct has no TypeScript counterpart:
 *   * STREAMING SEAM. The C# `(request, IServerStreamWriter<T>, ServerCallContext)` becomes
 *     `(request, ServerStreamWriter<T>, AbortSignal | undefined)`: a port-local writer with one
 *     `write(message): Promise<void>` member, plus the signal that stands in for
 *     `ServerCallContext.CancellationToken` (the only thing the C# reads off the context).
 *     `@grpc/grpc-js`'s `ServerWritableStream` is adapted onto that seam in `program.ts`, and Node
 *     stream backpressure (awaiting `drain` when `write` returns false) is the ADAPTER's job -
 *     binding this service body to `ServerWritableStream` would drag the transport in here and
 *     leave the covering S5b suites unportable.
 *   * `catch (OperationCanceledException)` becomes Thresh's cancellation family
 *     (`isCancellationError`: `ThreshCancellationError` or a DOM `AbortError`), matched on the
 *     TYPE and never on a message string.
 *   * `GetAsyncEnumerator` / `MoveNextAsync` / `DisposeAsync` becomes a MANUAL
 *     `[Symbol.asyncIterator]()` / `next()` / `return?.()` loop, not `for await`: the loop must
 *     distinguish cancellation from the two FAILED_PRECONDITION exceptions and must re-check the
 *     signal between the move and the write, neither of which `for await` allows.
 *   * `RpcException(new Status(code, detail))` becomes {@link RpcError}.
 *   * Expiration is epoch NANOS `bigint` in core, and `optional_expires_at_unix_seconds` is a
 *     ts-proto STRING (`forceLong=string`), so an absent expiration renders as `"0"` and a present
 *     one through `String(nanos / 1_000_000_000n)` - never a JS `number`.
 */

const DATASTORE_ID = "datastore-under-test";
const SCHEMA = "definition user {}";

// ---------------------------------------------------------------- fakes

/** One scripted step of the fake changefeed, consumed in order by the fake `watch` generator. */
type WatchStep =
  /** Yield a change (the C#'s `MoveNextAsync` returning true). */
  | { readonly kind: "change"; readonly change: RevisionChange }
  /** Throw out of `next()` (the lazy-iterator body running for the first time). */
  | { readonly kind: "throw"; readonly error: unknown }
  /** Run a side effect at this point in the stream (swap the schema, abort the signal). */
  | { readonly kind: "run"; readonly fn: () => void };

interface WatchCall {
  readonly afterRevision: IRevision;
  readonly options: WatchOptions;
  readonly signal: AbortSignal | undefined;
}

class FakeDatastore {
  /** Every collaborator call, in order, so the C#'s ORDER OF OPERATIONS can be asserted. */
  readonly calls: string[] = [];
  readonly watchCalls: WatchCall[] = [];

  head: RevisionWithSchemaHash = { revision: new TimestampRevision(100n), schemaHash: "head-hash" };
  uniqueId = DATASTORE_ID;
  parser: IRevisionParser = new TimestampRevisionParser(DATASTORE_ID);
  steps: readonly WatchStep[] = [];

  /** True once the enumerator's `return()` ran - the `finally { DisposeAsync() }` probe. */
  disposed = false;
  /** True once the generator body actually started - the LAZINESS probe. */
  started = false;

  async headRevision(): Promise<RevisionWithSchemaHash> {
    this.calls.push("headRevision");
    return this.head;
  }

  async getUniqueId(): Promise<string> {
    this.calls.push("getUniqueId");
    return this.uniqueId;
  }

  async getRevisionParser(): Promise<IRevisionParser> {
    this.calls.push("getRevisionParser");
    return this.parser;
  }

  watch(
    afterRevision: IRevision,
    options: WatchOptions,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<RevisionChange> {
    this.calls.push("watch");
    this.watchCalls.push({ afterRevision, options, signal });
    return this.#stream();
  }

  async *#stream(): AsyncGenerator<RevisionChange> {
    this.started = true;
    try {
      for (const step of this.steps) {
        if (step.kind === "throw") throw step.error;
        if (step.kind === "run") {
          step.fn();
          continue;
        }
        yield step.change;
      }
    } finally {
      this.disposed = true;
    }
  }
}

class CollectingWriter implements ServerStreamWriter<WatchResponse> {
  readonly collected: WatchResponse[] = [];

  async write(message: WatchResponse): Promise<void> {
    this.collected.push(message);
  }
}

interface Harness {
  readonly service: WatchGrpcService;
  readonly datastore: FakeDatastore;
  readonly schema: MutableSchemaProvider;
  readonly writer: CollectingWriter;
}

function harness(steps: readonly WatchStep[] = []): Harness {
  const datastore = new FakeDatastore();
  datastore.steps = steps;
  const schema = new MutableSchemaProvider(SCHEMA);
  const service = new WatchGrpcService(datastore as unknown as IDatastore, schema);
  return { service, datastore, schema, writer: new CollectingWriter() };
}

// ---------------------------------------------------------------- fixtures

function touchUpdate(docId: string, userId: string): RelationshipUpdate {
  return {
    operation: "touch",
    relationship: createRelationship(
      { objectType: "document", objectId: docId, relation: "viewer" },
      { objectType: "user", objectId: userId, relation: ELLIPSIS },
    ),
  };
}

function change(overrides: Partial<RevisionChange> = {}): RevisionChange {
  return {
    revision: new TimestampRevision(101n),
    relationshipChanges: [],
    ...overrides,
  };
}

function changeStep(c: RevisionChange): WatchStep {
  return { kind: "change", change: c };
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

// ---------------------------------------------------------------- start cursor

describe("watch start cursor", () => {
  it("falls back to the HEAD revision when no cursor is supplied, so only future writes are tailed", async () => {
    const h = harness();
    const head = new TimestampRevision(4242n);
    h.datastore.head = { revision: head, schemaHash: "head-hash" };

    await h.service.watch({ optionalUpdateKinds: [] }, h.writer);

    expect(h.datastore.watchCalls[0]?.afterRevision).toBe(head);
    // No token to decode, so the parser is never fetched.
    expect(h.datastore.calls).toEqual(["headRevision", "getUniqueId", "watch"]);
  });

  it("treats an EMPTY cursor token as no cursor at all", async () => {
    const h = harness();

    await h.service.watch(
      { optionalUpdateKinds: [], optionalStartCursor: { token: "" } },
      h.writer,
    );

    expect(h.datastore.calls).toEqual(["headRevision", "getUniqueId", "watch"]);
    expect(h.datastore.watchCalls[0]?.afterRevision).toBe(h.datastore.head.revision);
  });

  it("decodes a supplied cursor to its revision, BEFORE fetching the datastore id", async () => {
    const h = harness();
    const cursor = zedTokenFromRevision(new TimestampRevision(77n), "some-hash", DATASTORE_ID);

    await h.service.watch(
      { optionalUpdateKinds: [], optionalStartCursor: { token: cursor.token } },
      h.writer,
    );

    // The ORDER is the contract: the cursor resolves first, and HEAD is never read.
    expect(h.datastore.calls).toEqual(["getRevisionParser", "getUniqueId", "watch"]);
    expect(h.datastore.watchCalls[0]?.afterRevision.toString()).toBe("77");
  });

  it("accepts a legacy token minted with no datastore id", async () => {
    const h = harness();
    const legacy = zedTokenFromRevision(new TimestampRevision(9n), "some-hash", undefined);

    await h.service.watch(
      { optionalUpdateKinds: [], optionalStartCursor: { token: legacy.token } },
      h.writer,
    );

    expect(h.datastore.watchCalls[0]?.afterRevision.toString()).toBe("9");
  });

  it("rejects a cursor minted by a DIFFERENT datastore with INVALID_ARGUMENT", async () => {
    const h = harness();
    const foreign = zedTokenFromRevision(new TimestampRevision(5n), "hash", "some-other-datastore");

    const error = await rpcErrorFrom(
      h.service.watch(
        { optionalUpdateKinds: [], optionalStartCursor: { token: foreign.token } },
        h.writer,
      ),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("start cursor was generated by a different datastore instance");
    // Rejected before the stream was ever opened.
    expect(h.datastore.watchCalls).toHaveLength(0);
  });

  it("rejects an undecodable cursor with INVALID_ARGUMENT", async () => {
    const h = harness();

    const error = await rpcErrorFrom(
      h.service.watch(
        { optionalUpdateKinds: [], optionalStartCursor: { token: "not-a-token!!" } },
        h.writer,
      ),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("invalid start cursor");
    expect(h.datastore.watchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- resolveContent

describe("resolveContent", () => {
  async function contentFor(kinds: readonly WatchKind[]): Promise<number | undefined> {
    const h = harness();
    await h.service.watch({ optionalUpdateKinds: [...kinds] }, h.writer);
    return h.datastore.watchCalls[0]?.options.content;
  }

  it("maps an empty kind list to relationships", async () => {
    expect(await contentFor([])).toBe(WatchContent.relationships);
  });

  it("maps INCLUDE_SCHEMA_UPDATES to schema alone", async () => {
    expect(await contentFor([WatchKind.WATCH_KIND_INCLUDE_SCHEMA_UPDATES])).toBe(
      WatchContent.schema,
    );
  });

  it("maps every other kind - UNSPECIFIED and INCLUDE_RELATIONSHIP_UPDATES alike - to relationships", async () => {
    expect(await contentFor([WatchKind.WATCH_KIND_UNSPECIFIED])).toBe(WatchContent.relationships);
    expect(await contentFor([WatchKind.WATCH_KIND_INCLUDE_RELATIONSHIP_UPDATES])).toBe(
      WatchContent.relationships,
    );
    expect(await contentFor([WatchKind.UNRECOGNIZED])).toBe(WatchContent.relationships);
  });

  it("ORs the flags of a multi-kind request", async () => {
    expect(
      await contentFor([
        WatchKind.WATCH_KIND_INCLUDE_RELATIONSHIP_UPDATES,
        WatchKind.WATCH_KIND_INCLUDE_SCHEMA_UPDATES,
      ]),
    ).toBe(WatchContent.relationships | WatchContent.schema);
  });

  it("never asks for checkpoints - the v0 response has no checkpoint field", async () => {
    const content = await contentFor([
      WatchKind.WATCH_KIND_INCLUDE_RELATIONSHIP_UPDATES,
      WatchKind.WATCH_KIND_INCLUDE_SCHEMA_UPDATES,
    ]);
    expect((content ?? 0) & WatchContent.checkpoints).toBe(0);
  });
});

// ---------------------------------------------------------------- the loop

describe("watch loop", () => {
  it("disposes the enumerator when the feed ends normally", async () => {
    const h = harness([changeStep(change())]);

    await h.service.watch({ optionalUpdateKinds: [] }, h.writer);

    expect(h.datastore.started).toBe(true);
    expect(h.datastore.disposed).toBe(true);
  });

  it("ends the stream NORMALLY on cancellation, with nothing written and no error", async () => {
    const controller = new AbortController();
    const h = harness([
      { kind: "run", fn: () => controller.abort() },
      { kind: "throw", error: new GrainTaskCanceledError() },
      changeStep(change()),
    ]);

    await expect(
      h.service.watch({ optionalUpdateKinds: [] }, h.writer, controller.signal),
    ).resolves.toBeUndefined();

    expect(h.writer.collected).toEqual([]);
    expect(h.datastore.disposed).toBe(true);
  });

  it("ends the stream normally on a DOM AbortError too", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([
      { kind: "throw", error: new DOMException("This operation was aborted", "AbortError") },
    ]);

    await expect(
      h.service.watch({ optionalUpdateKinds: [] }, h.writer, controller.signal),
    ).resolves.toBeUndefined();
    expect(h.writer.collected).toEqual([]);
  });

  it("maps a RevisionNotFoundException raised on the FIRST move to FAILED_PRECONDITION", async () => {
    const h = harness([
      { kind: "throw", error: new RevisionNotFoundException(new TimestampRevision(3n)) },
    ]);

    const error = await rpcErrorFrom(h.service.watch({ optionalUpdateKinds: [] }, h.writer));

    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details).toBe("revision 3 is no longer available");
    // The enumerator was created and then disposed on the way out.
    expect(h.datastore.watchCalls).toHaveLength(1);
    expect(h.datastore.disposed).toBe(true);
  });

  it("maps a WatchDisabledException to FAILED_PRECONDITION", async () => {
    const h = harness([{ kind: "throw", error: new WatchDisabledException("watch is disabled") }]);

    const error = await rpcErrorFrom(h.service.watch({ optionalUpdateKinds: [] }, h.writer));

    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details).toBe("watch is disabled");
  });

  it("lets any other failure propagate unmapped", async () => {
    const boom = new Error("boom");
    const h = harness([{ kind: "throw", error: boom }]);

    await expect(h.service.watch({ optionalUpdateKinds: [] }, h.writer)).rejects.toBe(boom);
    expect(h.datastore.disposed).toBe(true);
  });

  it("keeps the responses already written when a later move fails", async () => {
    const h = harness([
      changeStep(change({ revision: new TimestampRevision(101n) })),
      { kind: "throw", error: new WatchDisabledException("watch is disabled") },
    ]);

    await rpcErrorFrom(h.service.watch({ optionalUpdateKinds: [] }, h.writer));

    expect(h.writer.collected).toHaveLength(1);
  });

  it("drops a change whose move raced the cancel: the signal is re-checked BEFORE the write", async () => {
    const controller = new AbortController();
    const h = harness([
      changeStep(change({ revision: new TimestampRevision(101n) })),
      { kind: "run", fn: () => controller.abort() },
      changeStep(change({ revision: new TimestampRevision(102n) })),
      changeStep(change({ revision: new TimestampRevision(103n) })),
    ]);

    await h.service.watch({ optionalUpdateKinds: [] }, h.writer, controller.signal);

    // 101 written; 102 moved successfully but is never written, and the loop stops there.
    expect(h.writer.collected).toHaveLength(1);
    expect(h.datastore.disposed).toBe(true);
  });

  it("writes one response per change, in order, and stops when the feed ends", async () => {
    const h = harness([
      changeStep(change({ revision: new TimestampRevision(101n) })),
      changeStep(change({ revision: new TimestampRevision(102n) })),
    ]);

    await h.service.watch({ optionalUpdateKinds: [] }, h.writer);

    expect(h.writer.collected).toHaveLength(2);
  });

  it("passes the call's signal straight through to the datastore watch", async () => {
    const controller = new AbortController();
    const h = harness();

    await h.service.watch({ optionalUpdateKinds: [] }, h.writer, controller.signal);

    expect(h.datastore.watchCalls[0]?.signal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------- toResponse

describe("toResponse", () => {
  async function responseFor(c: RevisionChange): Promise<WatchResponse> {
    const h = harness([changeStep(c)]);
    await h.service.watch({ optionalUpdateKinds: [] }, h.writer);
    const response = h.writer.collected[0];
    expect(response).toBeDefined();
    return response as WatchResponse;
  }

  it("mints changes_through from the change's revision, the CURRENT schema hash and the datastore id", async () => {
    const h = harness([changeStep(change({ revision: new TimestampRevision(555n) }))]);

    await h.service.watch({ optionalUpdateKinds: [] }, h.writer);

    expect(h.writer.collected[0]?.changesThrough).toEqual(
      zedTokenFromRevision(new TimestampRevision(555n), h.schema.current.schemaHash, DATASTORE_ID),
    );
  });

  it("re-reads the schema hash per response, so a mid-stream schema swap shows in the next token", async () => {
    const h = harness([]);
    h.datastore.steps = [
      changeStep(change({ revision: new TimestampRevision(1n) })),
      { kind: "run", fn: () => void h.schema.update("definition user {}\ndefinition team {}") },
      changeStep(change({ revision: new TimestampRevision(2n) })),
    ];

    await h.service.watch({ optionalUpdateKinds: [] }, h.writer);

    const [first, second] = h.writer.collected;
    expect(first?.changesThrough?.token).not.toBe(second?.changesThrough?.token);
    expect(second?.changesThrough).toEqual(
      zedTokenFromRevision(new TimestampRevision(2n), h.schema.current.schemaHash, DATASTORE_ID),
    );
  });

  it("carries schema_updated from the change, defaulting an absent flag to false", async () => {
    expect((await responseFor(change({ schemaChanged: true }))).schemaUpdated).toBe(true);
    expect((await responseFor(change({ schemaChanged: false }))).schemaUpdated).toBe(false);
    expect((await responseFor(change())).schemaUpdated).toBe(false);
  });

  it("emits an empty update list for a change carrying no relationship changes", async () => {
    expect((await responseFor(change({ schemaChanged: true }))).updates).toEqual([]);
  });

  it("maps every update operation, defaulting anything that is not create/delete to TOUCH", async () => {
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
    );
    const response = await responseFor(
      change({
        relationshipChanges: [
          { operation: "create", relationship: rel },
          { operation: "delete", relationship: rel },
          { operation: "touch", relationship: rel },
        ],
      }),
    );

    expect(response.updates.map((u) => u.operation)).toEqual([
      RelationshipUpdate_Operation.OPERATION_CREATE,
      RelationshipUpdate_Operation.OPERATION_DELETE,
      RelationshipUpdate_Operation.OPERATION_TOUCH,
    ]);
  });

  it("blanks an ellipsis subject relation and keeps a real one", async () => {
    const response = await responseFor(
      change({
        relationshipChanges: [
          touchUpdate("doc1", "alice"),
          {
            operation: "touch",
            relationship: createRelationship(
              { objectType: "document", objectId: "doc2", relation: "viewer" },
              { objectType: "group", objectId: "eng", relation: "member" },
            ),
          },
        ],
      }),
    );

    expect(response.updates[0]?.relationship?.subject?.optionalRelation).toBe("");
    expect(response.updates[1]?.relationship?.subject?.optionalRelation).toBe("member");
  });

  it("maps the whole relationship shape onto proto", async () => {
    const response = await responseFor(
      change({ relationshipChanges: [touchUpdate("doc1", "alice")] }),
    );

    expect(response.updates[0]?.relationship).toEqual({
      resource: { objectType: "document", objectId: "doc1" },
      resourceRelation: "viewer",
      subject: {
        object: { objectType: "user", objectId: "alice" },
        optionalRelation: "",
      },
      optionalExpiresAtUnixSeconds: "0",
    });
  });

  it("renders an expiration as unix SECONDS in a ts-proto string, never through a JS number", async () => {
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      undefined,
      // 2286-11-20T17:46:39Z in nanos: the seconds value is beyond what a float64 keeps exactly
      // once multiplied back up, and the sub-second remainder must truncate away.
      9_999_999_999_123_456_789n,
    );
    const response = await responseFor(
      change({ relationshipChanges: [{ operation: "touch", relationship: rel }] }),
    );

    expect(response.updates[0]?.relationship?.optionalExpiresAtUnixSeconds).toBe("9999999999");
  });

  it("carries a caveat with its context struct", async () => {
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      {
        caveatName: "only_on_tuesday",
        context: new Map<string, unknown>([
          ["day", "tuesday"],
          ["hour", 9],
          ["enabled", true],
          ["absent", null],
          ["tags", ["a", "b"]],
          ["nested", new Map<string, unknown>([["k", "v"]])],
        ]),
      },
    );

    const response = await responseFor(
      change({ relationshipChanges: [{ operation: "touch", relationship: rel }] }),
    );

    expect(response.updates[0]?.relationship?.optionalCaveat).toEqual({
      caveatName: "only_on_tuesday",
      context: {
        day: "tuesday",
        hour: 9,
        enabled: true,
        absent: null,
        tags: ["a", "b"],
        nested: { k: "v" },
      },
    });
  });

  it("leaves the caveat context UNSET when the context is empty - DictToStruct returns null", async () => {
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      { caveatName: "always_true", context: new Map<string, unknown>() },
    );

    const response = await responseFor(
      change({ relationshipChanges: [{ operation: "touch", relationship: rel }] }),
    );

    expect(response.updates[0]?.relationship?.optionalCaveat?.caveatName).toBe("always_true");
    expect(response.updates[0]?.relationship?.optionalCaveat?.context).toBeUndefined();
  });

  it("stringifies a context value that is neither scalar, list nor map - the C# ToString fallback", async () => {
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      { caveatName: "c", context: new Map<string, unknown>([["big", 12345678901234567890n]]) },
    );

    const response = await responseFor(
      change({ relationshipChanges: [{ operation: "touch", relationship: rel }] }),
    );

    expect(response.updates[0]?.relationship?.optionalCaveat?.context).toEqual({
      big: "12345678901234567890",
    });
  });

  it("keeps a STRING context value a string rather than exploding it into characters", async () => {
    // A string is iterable in TypeScript where C#'s `string` arm precedes `IEnumerable`, so the
    // branch ORDER is the behaviour.
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      { caveatName: "c", context: new Map<string, unknown>([["s", "abc"]]) },
    );

    const response = await responseFor(
      change({ relationshipChanges: [{ operation: "touch", relationship: rel }] }),
    );

    expect(response.updates[0]?.relationship?.optionalCaveat?.context).toEqual({ s: "abc" });
  });
});
