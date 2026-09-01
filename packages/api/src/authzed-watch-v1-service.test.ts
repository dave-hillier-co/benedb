import { status } from "@grpc/grpc-js";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import type { IRevisionParser } from "@benedb/core/i-revision-parser";
import { createRelationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { decodeRevision, zedTokenFromRevision } from "@benedb/core/zed-tokens";
import {
  RevisionNotFoundException,
  WatchDisabledException,
} from "@benedb/datastore/datastore-exceptions";
import type { IDatastore, RevisionWithSchemaHash } from "@benedb/datastore/i-datastore";
import { TimestampRevisionParser } from "@benedb/datastore/timestamp-revision-parser";
import type { RevisionChange, WatchOptions } from "@benedb/datastore/watch";
import { WatchContent } from "@benedb/datastore/watch";
import { MutableSchemaProvider } from "@benedb/grains/i-schema-provider";
import { RelationshipUpdate_Operation } from "@benedb/protos/authzed/api/v1/core";
import type { WatchRequest, WatchResponse } from "@benedb/protos/authzed/api/v1/watch_service";
import { WatchKind } from "@benedb/protos/authzed/api/v1/watch_service";
import { GrainTaskCanceledError } from "@thresh/core/errors";
import { describe, expect, it } from "vitest";

import { AuthzedWatchV1Service } from "./authzed-watch-v1-service";
import { RpcError } from "./rpc-error";
import type { ServerStreamWriter } from "./server-stream-writer";

/**
 * Characterization test for `src/Spiceport.Api/AuthzedWatchV1Service.cs` - the `authzed.api.v1`
 * server-streaming changefeed `zed watch` consumes.
 *
 * SCOPE, deliberately. `tests/Spiceport.Grains.Tests/AuthzedWatchV1ServiceTests.cs` drives this
 * file over a live `MeshTestCluster` (tail-from-head, resume-from-a-pre-write-token, cancellation,
 * the object-type filter, and the two checkpoint cases) and is stage S5b's to port; none of its
 * cases is restated here. What a live mesh cannot easily produce, and what this file pins instead,
 * is the ORDER OF OPERATIONS, the lazy-iterator catch placement, the exact FOUR-WAY skip predicate,
 * and the proto translation - over a fake datastore whose changefeed is scripted step by step.
 *
 * The structure is the v0 `watch-grpc-service.test.ts` plus the three v1 deltas
 * (`optional_object_types`, `is_checkpoint`, `WatchKind.INCLUDE_CHECKPOINTS`); the shared cases are
 * re-asserted here rather than shared, because the C# maintains the two services separately.
 *
 * Reading notes for the C# this pins:
 *   * ORDER (lines 30-56): the object-type set is built first, then the cursor is decoded (or HEAD
 *     is read), then `GetUniqueId`, then `ResolveContent`, then the enumerator. A cursor never
 *     reads HEAD, and an absent cursor never fetches the parser.
 *   * THE SKIP PREDICATE (lines 97-101) IS A FOUR-WAY CONJUNCTION, not a tidy "skip empties":
 *     `!change.IsCheckpoint && response.Updates.Count == 0 && !change.SchemaChanged &&
 *     objectTypeFilter is not null`. With NO filter, a content change that yields zero updates IS
 *     still written - an EMPTY response goes on the wire. With a filter, checkpoints and
 *     schema-change signals always flow through.
 *   * `optional_object_types` is a `HashSet<string>` over the request list - ordinal membership. An
 *     EMPTY list means NO filter at all, not an empty set that matches nothing.
 *   * A CHECKPOINT CARRIES NO CONTENT: `ToResponse` returns immediately after setting the token,
 *     `schema_updated` and `is_checkpoint`, so the updates list stays empty even when the change
 *     carries relationship changes.
 *   * The token is minted PER RESPONSE from `schemaProvider.Current.SchemaHash` - the AMBIENT hash
 *     at emit time, not the hash at that revision.
 *   * Start-cursor decoding maps MismatchedDatastoreId and Unknown to two DIFFERENT
 *     INVALID_ARGUMENT messages; RevisionNotFound and WatchDisabled raised from INSIDE the loop are
 *     FAILED_PRECONDITION. The split is deliberate.
 *   * `ResolveContent`: an empty kind list is Relationships; otherwise the flags are OR-ed, with
 *     INCLUDE_SCHEMA_UPDATES -> Schema, INCLUDE_CHECKPOINTS -> Checkpoints, and EVERYTHING ELSE
 *     (UNSPECIFIED and INCLUDE_RELATIONSHIP_UPDATES alike) -> Relationships.
 *
 * SOURCE CONCERN, transliterated rather than fixed (unsure; noted while reading, not chased).
 * `ResolveContent` (lines 145-163) carries a comment saying "If only checkpoints (or only schema)
 * were selected, we still need a content slice or the changefeed would emit nothing to checkpoint
 * over; SpiceDB's content selection is additive" - but the code adds no content slice. A request of
 * `optional_update_kinds = [WATCH_KIND_INCLUDE_CHECKPOINTS]` alone therefore yields
 * `WatchContent.Checkpoints` (4) with the Relationships bit (1) UNSET. Whether the datastore then
 * emits checkpoints over an empty content selection was not traced. The comment and the code
 * disagree; the CODE is what the port reproduces, and the test below pins the code.
 *
 * SOURCE CONCERN, second, already recorded on `authzed-permissions-v1-service.ts`: `ToProto`
 * (lines 178-212) never sets `optional_expires_at`, although the vendored `authzed/api/v1/core.proto`
 * declares it and the generated bindings carry `optionalExpiresAt`. A watched relationship that
 * carries an expiration loses it on this surface too. The omission below is deliberate.
 *
 * Port decisions this file also pins, because the C# construct has no TypeScript counterpart:
 *   * STREAMING SEAM. `(request, IServerStreamWriter<T>, ServerCallContext)` becomes
 *     `(request, ServerStreamWriter<T>, AbortSignal | undefined)`, as settled in
 *     `watch-grpc-service.ts`; Node stream backpressure is the host adapter's job.
 *   * `GetAsyncEnumerator` / `MoveNextAsync` / `DisposeAsync` becomes a MANUAL
 *     `[Symbol.asyncIterator]()` / `next()` / `return?.()` loop, not `for await`.
 *   * `catch (OperationCanceledException)` becomes Thresh's cancellation family
 *     (`isCancellationError`), matched on the TYPE and never on a message string.
 *   * `RpcException(new Status(code, detail))` becomes {@link RpcError}.
 *   * The class doc-comment's claim of "no `schema_updated` field (this snapshot watches
 *     relationships only)" is STALE - `ToResponse` sets it - so the code is ported and the comment
 *     dropped.
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
  readonly service: AuthzedWatchV1Service;
  readonly datastore: FakeDatastore;
  readonly schema: MutableSchemaProvider;
  readonly writer: CollectingWriter;
}

function harness(steps: readonly WatchStep[] = []): Harness {
  const datastore = new FakeDatastore();
  datastore.steps = steps;
  const schema = new MutableSchemaProvider(SCHEMA);
  const service = new AuthzedWatchV1Service(datastore as unknown as IDatastore, schema);
  return { service, datastore, schema, writer: new CollectingWriter() };
}

// ---------------------------------------------------------------- fixtures

/** The proto defaults for the request's four repeated/optional fields. */
function request(overrides: Partial<WatchRequest> = {}): WatchRequest {
  return {
    optionalObjectTypes: [],
    optionalRelationshipFilters: [],
    optionalUpdateKinds: [],
    ...overrides,
  };
}

function touchUpdate(objectType: string, objectId: string, userId: string): RelationshipUpdate {
  return {
    operation: "touch",
    relationship: createRelationship(
      { objectType, objectId, relation: "viewer" },
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

    await h.service.watch(request(), h.writer);

    expect(h.datastore.watchCalls[0]?.afterRevision).toBe(head);
    // No token to decode, so the parser is never fetched.
    expect(h.datastore.calls).toEqual(["headRevision", "getUniqueId", "watch"]);
  });

  it("treats an EMPTY cursor token as no cursor at all", async () => {
    const h = harness();

    await h.service.watch(request({ optionalStartCursor: { token: "" } }), h.writer);

    expect(h.datastore.calls).toEqual(["headRevision", "getUniqueId", "watch"]);
    expect(h.datastore.watchCalls[0]?.afterRevision).toBe(h.datastore.head.revision);
  });

  it("decodes a supplied cursor to its revision, BEFORE fetching the datastore id", async () => {
    const h = harness();
    const cursor = zedTokenFromRevision(new TimestampRevision(77n), "some-hash", DATASTORE_ID);

    await h.service.watch(request({ optionalStartCursor: { token: cursor.token } }), h.writer);

    // The ORDER is the contract: the cursor resolves first, and HEAD is never read.
    expect(h.datastore.calls).toEqual(["getRevisionParser", "getUniqueId", "watch"]);
    expect(h.datastore.watchCalls[0]?.afterRevision.toString()).toBe("77");
  });

  it("rejects a cursor minted by a DIFFERENT datastore with its OWN INVALID_ARGUMENT message", async () => {
    const h = harness();
    const foreign = zedTokenFromRevision(new TimestampRevision(5n), "hash", "some-other-datastore");

    const error = await rpcErrorFrom(
      h.service.watch(request({ optionalStartCursor: { token: foreign.token } }), h.writer),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("start cursor was generated by a different datastore instance");
    // Rejected before the stream was ever opened.
    expect(h.datastore.watchCalls).toHaveLength(0);
  });

  it("rejects an undecodable cursor with the OTHER INVALID_ARGUMENT message", async () => {
    const h = harness();

    const error = await rpcErrorFrom(
      h.service.watch(request({ optionalStartCursor: { token: "not-a-token!!" } }), h.writer),
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
    await h.service.watch(request({ optionalUpdateKinds: [...kinds] }), h.writer);
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

  it("maps INCLUDE_CHECKPOINTS to checkpoints ALONE - the relationships bit stays UNSET", async () => {
    // SOURCE CONCERN, reproduced: the C# comment promises an additive content slice; the code does
    // not add one. `4`, not `4 | 1`.
    expect(await contentFor([WatchKind.WATCH_KIND_INCLUDE_CHECKPOINTS])).toBe(
      WatchContent.checkpoints,
    );
  });

  it("ORs the flags of a multi-kind request", async () => {
    expect(
      await contentFor([
        WatchKind.WATCH_KIND_INCLUDE_RELATIONSHIP_UPDATES,
        WatchKind.WATCH_KIND_INCLUDE_SCHEMA_UPDATES,
        WatchKind.WATCH_KIND_INCLUDE_CHECKPOINTS,
      ]),
    ).toBe(WatchContent.relationships | WatchContent.schema | WatchContent.checkpoints);
  });
});

// ---------------------------------------------------------------- object type filter

describe("optional_object_types", () => {
  it("treats an EMPTY list as NO filter, so every update flows through", async () => {
    const h = harness([
      changeStep(
        change({
          relationshipChanges: [
            touchUpdate("document", "doc1", "alice"),
            touchUpdate("folder", "f1", "bob"),
          ],
        }),
      ),
    ]);

    await h.service.watch(request(), h.writer);

    expect(h.writer.collected[0]?.updates).toHaveLength(2);
  });

  it("emits only updates whose RESOURCE object type is in the set", async () => {
    const h = harness([
      changeStep(
        change({
          relationshipChanges: [
            touchUpdate("folder", "f1", "alice"),
            touchUpdate("document", "doc3", "carol"),
          ],
        }),
      ),
    ]);

    await h.service.watch(request({ optionalObjectTypes: ["document"] }), h.writer);

    const updates = h.writer.collected[0]?.updates ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]?.relationship?.resource?.objectType).toBe("document");
    expect(updates[0]?.relationship?.resource?.objectId).toBe("doc3");
  });

  it("matches ORDINALLY - a case-different object type is NOT in the set", async () => {
    const h = harness([
      changeStep(change({ relationshipChanges: [touchUpdate("Document", "doc1", "alice")] })),
    ]);

    await h.service.watch(request({ optionalObjectTypes: ["document"] }), h.writer);

    // Every update was filtered out, so the four-way predicate skips the whole response.
    expect(h.writer.collected).toEqual([]);
  });

  it("never filters on the SUBJECT object type", async () => {
    const h = harness([
      changeStep(change({ relationshipChanges: [touchUpdate("document", "doc1", "alice")] })),
    ]);

    await h.service.watch(request({ optionalObjectTypes: ["user"] }), h.writer);

    expect(h.writer.collected).toEqual([]);
  });
});

// ------------------------------------------------------- the four-way skip predicate

describe("the skip predicate", () => {
  it("writes an EMPTY response when there is NO filter, even though nothing was emitted", async () => {
    // The conjunction requires `objectTypeFilter is not null`, so with no filter an empty content
    // response still goes on the wire. This is NOT a tidy skip-empties rule.
    const h = harness([changeStep(change({ relationshipChanges: [] }))]);

    await h.service.watch(request(), h.writer);

    expect(h.writer.collected).toHaveLength(1);
    expect(h.writer.collected[0]?.updates).toEqual([]);
    expect(h.writer.collected[0]?.isCheckpoint).toBe(false);
  });

  it("skips a filtered response only when ALL FOUR conditions hold", async () => {
    const h = harness([
      changeStep(change({ relationshipChanges: [touchUpdate("folder", "f1", "alice")] })),
    ]);

    await h.service.watch(request({ optionalObjectTypes: ["document"] }), h.writer);

    expect(h.writer.collected).toEqual([]);
  });

  it("writes a filtered response whose schema CHANGED, even with zero surviving updates", async () => {
    const h = harness([
      changeStep(
        change({
          schemaChanged: true,
          relationshipChanges: [touchUpdate("folder", "f1", "alice")],
        }),
      ),
    ]);

    await h.service.watch(request({ optionalObjectTypes: ["document"] }), h.writer);

    expect(h.writer.collected).toHaveLength(1);
    expect(h.writer.collected[0]?.schemaUpdated).toBe(true);
    expect(h.writer.collected[0]?.updates).toEqual([]);
  });

  it("writes a CHECKPOINT through the filter - liveness for a filtered subset", async () => {
    const h = harness([changeStep(change({ isCheckpoint: true }))]);

    await h.service.watch(request({ optionalObjectTypes: ["document"] }), h.writer);

    expect(h.writer.collected).toHaveLength(1);
    expect(h.writer.collected[0]?.isCheckpoint).toBe(true);
    expect(h.writer.collected[0]?.updates).toEqual([]);
    expect(h.writer.collected[0]?.changesThrough?.token ?? "").not.toBe("");
  });

  it("writes a filtered response that has at least one SURVIVING update", async () => {
    const h = harness([
      changeStep(
        change({
          relationshipChanges: [
            touchUpdate("folder", "f1", "alice"),
            touchUpdate("document", "doc1", "bob"),
          ],
        }),
      ),
    ]);

    await h.service.watch(request({ optionalObjectTypes: ["document"] }), h.writer);

    expect(h.writer.collected).toHaveLength(1);
    expect(h.writer.collected[0]?.updates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- toResponse

describe("toResponse", () => {
  it("mints changes_through from the change's revision and the AMBIENT schema hash", async () => {
    const h = harness([changeStep(change({ revision: new TimestampRevision(555n) }))]);

    await h.service.watch(request(), h.writer);

    const token = h.writer.collected[0]?.changesThrough?.token ?? "";
    const decoded = decodeRevision({ token }, new TimestampRevisionParser(DATASTORE_ID));
    expect(decoded.status).toBe("valid");
    expect(decoded.revision.toString()).toBe("555");
  });

  it("reads the schema hash PER RESPONSE, so a mid-stream schema swap changes the next token", async () => {
    const h = harness([
      changeStep(change({ revision: new TimestampRevision(1n) })),
      { kind: "run", fn: () => h.schema.update("definition user {}\ndefinition doc {}") },
      changeStep(change({ revision: new TimestampRevision(1n) })),
    ]);

    await h.service.watch(request(), h.writer);

    expect(h.writer.collected).toHaveLength(2);
    // Same revision, different ambient hash, so the two tokens differ.
    expect(h.writer.collected[0]?.changesThrough?.token).not.toBe(
      h.writer.collected[1]?.changesThrough?.token,
    );
  });

  it("carries NO CONTENT on a checkpoint, even when the change has relationship changes", async () => {
    const h = harness([
      changeStep(
        change({
          isCheckpoint: true,
          schemaChanged: true,
          relationshipChanges: [touchUpdate("document", "doc1", "alice")],
        }),
      ),
    ]);

    await h.service.watch(request(), h.writer);

    const response = h.writer.collected[0];
    expect(response?.isCheckpoint).toBe(true);
    expect(response?.schemaUpdated).toBe(true);
    // `ToResponse` returns before the update loop: the changes are dropped, not emitted.
    expect(response?.updates).toEqual([]);
  });

  it("renders an absent schemaChanged / isCheckpoint as FALSE, never as undefined", async () => {
    const h = harness([changeStep(change())]);

    await h.service.watch(request(), h.writer);

    expect(h.writer.collected[0]?.schemaUpdated).toBe(false);
    expect(h.writer.collected[0]?.isCheckpoint).toBe(false);
  });
});

// ---------------------------------------------------------------- toProto

describe("toProto", () => {
  it("maps create / delete / touch operations", async () => {
    const rel = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
    );
    const h = harness([
      changeStep(
        change({
          relationshipChanges: [
            { operation: "create", relationship: rel },
            { operation: "delete", relationship: rel },
            { operation: "touch", relationship: rel },
          ],
        }),
      ),
    ]);

    await h.service.watch(request(), h.writer);

    expect(h.writer.collected[0]?.updates.map((u) => u.operation)).toEqual([
      RelationshipUpdate_Operation.OPERATION_CREATE,
      RelationshipUpdate_Operation.OPERATION_DELETE,
      RelationshipUpdate_Operation.OPERATION_TOUCH,
    ]);
  });

  it("blanks an ELLIPSIS subject relation and keeps a named one", async () => {
    const h = harness([
      changeStep(
        change({
          relationshipChanges: [
            touchUpdate("document", "doc1", "alice"),
            {
              operation: "touch",
              relationship: createRelationship(
                { objectType: "document", objectId: "doc1", relation: "viewer" },
                { objectType: "group", objectId: "eng", relation: "member" },
              ),
            },
          ],
        }),
      ),
    ]);

    await h.service.watch(request(), h.writer);

    const updates = h.writer.collected[0]?.updates ?? [];
    expect(updates[0]?.relationship?.subject?.optionalRelation).toBe("");
    expect(updates[1]?.relationship?.subject?.optionalRelation).toBe("member");
    expect(updates[0]?.relationship?.relation).toBe("viewer");
  });

  it("carries a caveat's context through as a struct, and omits an EMPTY context", async () => {
    const withContext = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      { caveatName: "ip_match", context: new Map<string, unknown>([["allowed", "10.0.0.1"]]) },
    );
    const withoutContext = createRelationship(
      { objectType: "document", objectId: "doc2", relation: "viewer" },
      { objectType: "user", objectId: "bob", relation: ELLIPSIS },
      { caveatName: "ip_match", context: new Map<string, unknown>() },
    );
    const h = harness([
      changeStep(
        change({
          relationshipChanges: [
            { operation: "touch", relationship: withContext },
            { operation: "touch", relationship: withoutContext },
          ],
        }),
      ),
    ]);

    await h.service.watch(request(), h.writer);

    const updates = h.writer.collected[0]?.updates ?? [];
    expect(updates[0]?.relationship?.optionalCaveat).toEqual({
      caveatName: "ip_match",
      context: { allowed: "10.0.0.1" },
    });
    // `DictToStruct` returns null for an EMPTY dictionary, so the context field is never set.
    expect(updates[1]?.relationship?.optionalCaveat?.caveatName).toBe("ip_match");
    expect(updates[1]?.relationship?.optionalCaveat?.context).toBeUndefined();
  });

  it("populates optional_expires_at from a relationship's expiration (issue #39)", async () => {
    // A watched relationship's stored expiry must reach the v1 client; the earlier deliberate
    // omission was fixed at the source (Spiceport `ad647b4`).
    const expiring = createRelationship(
      { objectType: "document", objectId: "doc1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      undefined,
      1_700_000_000_000_000_000n,
    );
    const h = harness([
      changeStep(change({ relationshipChanges: [{ operation: "touch", relationship: expiring }] })),
    ]);

    await h.service.watch(request(), h.writer);

    expect(h.writer.collected[0]?.updates[0]?.relationship?.optionalExpiresAt).toEqual(
      new Date("2023-11-14T22:13:20.000Z"),
    );
  });
});

// ---------------------------------------------------------------- the loop

describe("watch loop", () => {
  it("does not start the changefeed body until the first move, and disposes on a normal end", async () => {
    const h = harness([changeStep(change())]);

    await h.service.watch(request(), h.writer);

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

    await expect(h.service.watch(request(), h.writer, controller.signal)).resolves.toBeUndefined();

    expect(h.writer.collected).toEqual([]);
    expect(h.datastore.disposed).toBe(true);
  });

  it("ends the stream normally on a DOM AbortError too", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([
      { kind: "throw", error: new DOMException("This operation was aborted", "AbortError") },
    ]);

    await expect(h.service.watch(request(), h.writer, controller.signal)).resolves.toBeUndefined();
    expect(h.writer.collected).toEqual([]);
  });

  it("maps a RevisionNotFoundException raised on the FIRST move to FAILED_PRECONDITION", async () => {
    const h = harness([
      { kind: "throw", error: new RevisionNotFoundException(new TimestampRevision(3n)) },
    ]);

    const error = await rpcErrorFrom(h.service.watch(request(), h.writer));

    expect(error.code).toBe(status.FAILED_PRECONDITION);
    // NOT the INVALID_ARGUMENT the cursor-decode failures use: the split is deliberate.
    expect(error.details).toBe("revision 3 is no longer available");
    expect(h.datastore.watchCalls).toHaveLength(1);
    expect(h.datastore.disposed).toBe(true);
  });

  it("maps a WatchDisabledException to FAILED_PRECONDITION", async () => {
    const h = harness([{ kind: "throw", error: new WatchDisabledException("watch is disabled") }]);

    const error = await rpcErrorFrom(h.service.watch(request(), h.writer));

    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details).toBe("watch is disabled");
    expect(h.datastore.disposed).toBe(true);
  });

  it("lets any other failure propagate unwrapped, still disposing the enumerator", async () => {
    const boom = new Error("connection reset");
    const h = harness([{ kind: "throw", error: boom }]);

    await expect(h.service.watch(request(), h.writer)).rejects.toBe(boom);
    expect(h.datastore.disposed).toBe(true);
  });

  it("re-checks cancellation AFTER a successful move and BEFORE writing, dropping the raced change", async () => {
    const controller = new AbortController();
    const h = harness([
      { kind: "run", fn: () => controller.abort() },
      changeStep(change({ relationshipChanges: [touchUpdate("document", "doc1", "alice")] })),
    ]);

    await h.service.watch(request(), h.writer, controller.signal);

    expect(h.writer.collected).toEqual([]);
  });

  it("passes the call's signal straight through to the datastore watch", async () => {
    const controller = new AbortController();
    const h = harness();

    await h.service.watch(request(), h.writer, controller.signal);

    expect(h.datastore.watchCalls[0]?.signal).toBe(controller.signal);
  });
});
