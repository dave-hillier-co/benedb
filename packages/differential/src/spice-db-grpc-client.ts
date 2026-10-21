import { ChannelCredentials, Metadata, type ClientReadableStream } from "@grpc/grpc-js";
import {
  PermissionsServiceClient,
  type CheckPermissionRequest,
  type CheckPermissionResponse,
  type DeleteRelationshipsRequest,
  type DeleteRelationshipsResponse,
  type ImportBulkRelationshipsRequest,
  type ImportBulkRelationshipsResponse,
  type LookupResourcesRequest,
  type LookupResourcesResponse,
  type LookupSubjectsRequest,
  type LookupSubjectsResponse,
  type ReadRelationshipsRequest,
  type ReadRelationshipsResponse,
  type WriteRelationshipsRequest,
  type WriteRelationshipsResponse,
} from "@benedb/protos/authzed/api/v1/permission_service";
import {
  SchemaServiceClient,
  type ReadSchemaRequest,
  type ReadSchemaResponse,
  type WriteSchemaRequest,
  type WriteSchemaResponse,
} from "@benedb/protos/authzed/api/v1/schema_service";
import {
  WatchServiceClient,
  type WatchRequest,
  type WatchResponse,
} from "@benedb/protos/authzed/api/v1/watch_service";

/**
 * Ported from Spiceport `tests/Spiceport.Differential.Tests/SpiceDbGrpcClient.cs`.
 *
 * A minimal `authzed.api.v1` gRPC CLIENT for driving the real SpiceDB container.
 *
 * LEDGER DEVIATION: the ledger row targets `spice-db-grpc-client.test.ts`. Harness, not a suite;
 * amended to `spice-db-grpc-client.ts` (see `spice-db-container-fixture.ts`, port decision text).
 *
 * PORT DECISIONS.
 *
 *  1. THE C#'s ENTIRE RATIONALE EVAPORATES. The C# hand-rolls `Method<TReq,TResp>` descriptors and
 *     reflection-built `Marshaller`s because `src/Spiceport.Protos` compiles the vendored protos
 *     with `GrpcServices="Server"` (no client stubs), and a second client-side proto compile would
 *     produce a SHADOWING duplicate set of message types. BeneDB's protos are generated with
 *     `outputServices=grpc-js`, so `PermissionsServiceClient` and `SchemaServiceClient` ALREADY
 *     EXIST and share their message types with the in-process service. They are used directly.
 *     Reproducing the descriptor machinery has no TypeScript counterpart and would be redesign in
 *     the wrong direction, so this is a deviation of MECHANISM with an identical contract: the same
 *     nine RPCs, the same auth header, the same one-source-of-truth message types on both sides.
 *  2. AUTH: every call carries `authorization: Bearer <key>` (the C#'s `Options()` factory). A
 *     FRESH {@link Metadata} is built per call rather than one instance shared across concurrent
 *     calls.
 *  3. EVERY RPC IS PROMISIFIED, because grpc-js clients are callback-based.
 *      - Unary: reject on the callback's error.
 *      - Server-streaming: the C# drains `MoveNext` in a loop and an RPC failure THROWS out of that
 *        loop, so the `ClientReadableStream` must REJECT on its `error` event, NEVER resolve an
 *        empty array. Load-bearing: `CorpusDifferentialTests` catches exactly that rejection to
 *        record a `skippedQueries` note, and swallowing it would turn real-SpiceDB rejections into
 *        false agreement.
 *      - Client-streaming: write each batch IN ORDER (the C# awaits each `WriteAsync`), then
 *        `end()`, resolving/rejecting from the completion callback.
 *  4. ERROR SHAPE: the real-SpiceDB side yields a grpc-js `ServiceError` with a numeric `.code` and
 *     `.details` - the C#'s `ex.StatusCode` / `ex.Status.Detail`. That is NOT the BeneDB in-process
 *     side's `RpcError`; every assertion must match its own side's shape.
 *  5. `Dispose()` -> {@link close}, closing BOTH clients (schema + permissions).
 *
 * NOTE on `forceLong=string`: every proto int64/uint64 arrives as a STRING (e.g.
 * `ImportBulkRelationshipsResponse.numLoaded`). Any `Number(...)` on one is a silent corruption.
 */
export class SpiceDbGrpcClient {
  readonly #schema: SchemaServiceClient;
  readonly #permissions: PermissionsServiceClient;
  readonly #watch: WatchServiceClient;
  readonly #preSharedKey: string;

  constructor(address: string, preSharedKey: string) {
    const credentials = ChannelCredentials.createInsecure();
    this.#schema = new SchemaServiceClient(address, credentials);
    this.#permissions = new PermissionsServiceClient(address, credentials);
    this.#watch = new WatchServiceClient(address, credentials);
    this.#preSharedKey = preSharedKey;
  }

  /** The C#'s `Options()`: a FRESH metadata carrying the pre-shared key, per call. */
  #metadata(): Metadata {
    const metadata = new Metadata();
    metadata.set("authorization", `Bearer ${this.#preSharedKey}`);
    return metadata;
  }

  writeSchema(request: WriteSchemaRequest): Promise<WriteSchemaResponse> {
    return new Promise((resolve, reject) => {
      this.#schema.writeSchema(request, this.#metadata(), (error, response) =>
        error ? reject(error) : resolve(response),
      );
    });
  }

  readSchema(request: ReadSchemaRequest): Promise<ReadSchemaResponse> {
    return new Promise((resolve, reject) => {
      this.#schema.readSchema(request, this.#metadata(), (error, response) =>
        error ? reject(error) : resolve(response),
      );
    });
  }

  writeRelationships(request: WriteRelationshipsRequest): Promise<WriteRelationshipsResponse> {
    return new Promise((resolve, reject) => {
      this.#permissions.writeRelationships(request, this.#metadata(), (error, response) =>
        error ? reject(error) : resolve(response),
      );
    });
  }

  deleteRelationships(request: DeleteRelationshipsRequest): Promise<DeleteRelationshipsResponse> {
    return new Promise((resolve, reject) => {
      this.#permissions.deleteRelationships(request, this.#metadata(), (error, response) =>
        error ? reject(error) : resolve(response),
      );
    });
  }

  checkPermission(request: CheckPermissionRequest): Promise<CheckPermissionResponse> {
    return new Promise((resolve, reject) => {
      this.#permissions.checkPermission(request, this.#metadata(), (error, response) =>
        error ? reject(error) : resolve(response),
      );
    });
  }

  lookupResources(request: LookupResourcesRequest): Promise<LookupResourcesResponse[]> {
    return drain(this.#permissions.lookupResources(request, this.#metadata()));
  }

  readRelationships(request: ReadRelationshipsRequest): Promise<ReadRelationshipsResponse[]> {
    return drain(this.#permissions.readRelationships(request, this.#metadata()));
  }

  lookupSubjects(request: LookupSubjectsRequest): Promise<LookupSubjectsResponse[]> {
    return drain(this.#permissions.lookupSubjects(request, this.#metadata()));
  }

  importBulkRelationships(
    batches: Iterable<ImportBulkRelationshipsRequest>,
  ): Promise<ImportBulkRelationshipsResponse> {
    return new Promise((resolve, reject) => {
      const call = this.#permissions.importBulkRelationships(this.#metadata(), (error, response) =>
        error ? reject(error) : resolve(response),
      );
      // Sequential write order preserved (the C# awaits each `WriteAsync`).
      for (const batch of batches) call.write(batch);
      call.end();
    });
  }

  /**
   * BeneDB-only: opens a Watch and settles on its first event - the first response (the stream is
   * then cancelled) or the error that ends it. A Watch that is accepted streams until cancelled, so
   * the call carries a deadline and an accepted request that sends nothing rejects with
   * DEADLINE_EXCEEDED.
   */
  watchFirst(request: WatchRequest, deadlineMs = 10_000): Promise<WatchResponse> {
    return new Promise((resolve, reject) => {
      const call = this.#watch.watch(request, this.#metadata(), {
        deadline: Date.now() + deadlineMs,
      });
      let settled = false;
      call.on("data", (response: WatchResponse) => {
        if (settled) return;
        settled = true;
        resolve(response);
        call.cancel();
      });
      call.on("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  }

  /** The C#'s `Dispose()`: closes every client, unconditionally. */
  close(): void {
    try {
      this.#schema.close();
    } finally {
      try {
        this.#permissions.close();
      } finally {
        this.#watch.close();
      }
    }
  }
}

/**
 * The C#'s `while (await call.ResponseStream.MoveNext(...))` drain. An RPC failure THROWS out of
 * that loop, so this REJECTS on `error` rather than resolving what arrived first (port decision 3).
 */
function drain<T>(stream: ClientReadableStream<T>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const results: T[] = [];
    stream.on("data", (message: T) => results.push(message));
    stream.on("error", reject);
    stream.on("end", () => resolve(results));
  });
}
