import { createServer, type Server as HttpServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import type {
  MethodDefinition,
  Server as GrpcServer,
  ServerUnaryCall,
  ServerReadableStream,
  ServerWritableStream,
  ServiceDefinition,
  UntypedServiceImplementation,
  sendUnaryData,
} from "@grpc/grpc-js";
import { Server, ServerCredentials, status } from "@grpc/grpc-js";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import type { DatastoreGcOptions } from "@spacedb/grains/datastore-gc-options";
import { GrainBackedDatastore } from "@spacedb/grains/grain-backed-datastore";
import type { IPermissionChecker } from "@spacedb/grains/i-permission-checker";
import type { ISchemaProvider } from "@spacedb/grains/i-schema-provider";
import type { RelationshipReads } from "@spacedb/grains/relationship-reads";
import type { ReverseOps } from "@spacedb/grains/reverse-ops";
import type { SpiceportGrainServices } from "@spacedb/grains/service-collection-extensions";
import { addSpiceportGrainServices } from "@spacedb/grains/service-collection-extensions";
import { addActivationMemoCollectionAge } from "@spacedb/grains/silo-builder-extensions";
import { ExperimentalServiceService } from "@spacedb/protos/authzed/api/v1/experimental_service";
import { PermissionsServiceService as AuthzedPermissionsServiceService } from "@spacedb/protos/authzed/api/v1/permission_service";
import { SchemaServiceService } from "@spacedb/protos/authzed/api/v1/schema_service";
import { WatchServiceService as AuthzedWatchServiceService } from "@spacedb/protos/authzed/api/v1/watch_service";
import {
  BulkServiceService,
  PermissionsServiceService,
  WatchServiceService,
} from "@spacedb/protos/permissions";
import type { Configuration } from "@spacedb/silo/datastore-storage-config";
import {
  DATASTORE_PROVIDER_NAME,
  addDatastoreGrainStorage,
  configurationFromEnvironment,
} from "@spacedb/silo/datastore-storage-config";
import { SiloAddress } from "@thresh/core/silo-address";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { createSilo, type SiloBuilder } from "@thresh/hosting/silo-builder";
import type { SiloHost } from "@thresh/hosting/silo-host";
import { InProcessNetwork } from "@thresh/messaging/in-process-transport";

import { AuthzedExperimentalV1Service } from "./authzed-experimental-v1-service";
import { AuthzedPermissionsV1Service } from "./authzed-permissions-v1-service";
import { AuthzedSchemaV1Service } from "./authzed-schema-v1-service";
import { AuthzedWatchV1Service } from "./authzed-watch-v1-service";
import { BulkGrpcService } from "./bulk-grpc-service";
import { PermissionsGrpcService } from "./permissions-grpc-service";
import { SEED_SCHEMA_TEXT, seedAsync } from "./seed-data";
import type { ServerStreamWriter } from "./server-stream-writer";
import { WatchGrpcService } from "./watch-grpc-service";

/**
 * Ported from Spiceport `src/Spiceport.Api/Program.cs`.
 *
 * The serving host: a co-hosted silo plus the gRPC surface `zed` talks to. Seven services over TWO
 * proto families - `spiceport.v0` (Spiceport's own earlier surface) and `authzed.api.v1` (the
 * compatibility target) - both translation layers over the SAME grain mesh.
 *
 * PORT DECISIONS. `WebApplication.CreateBuilder` + `builder.Host.UseOrleans(...)` + seven
 * `MapGrpcService<T>()` calls + `MapGet("/")` + `StartAsync`/`SeedAsync`/`WaitForShutdownAsync` has
 * no mechanical counterpart, so the top-level statements split into functions that are testable
 * WITHOUT a host, and a {@link main} that composes them and is never called from a test.
 *
 *  1. THE SILO WIRING IS THE SILO HOST'S, MINUS NOTHING AND PLUS NOTHING - except that it compiles
 *     {@link SEED_SCHEMA_TEXT} and it seeds. See `@spacedb/silo/program` for why the duplication
 *     between the two hosts is deliberate rather than a missing helper, and for the transport /
 *     journaling / reminder substitutions, which are identical here.
 *  2. `MapGrpcService<T>()` becomes `server.addService(definition, implementation)` on a
 *     `@grpc/grpc-js` `Server`. ASP.NET Core generates a base class per service, so a method the
 *     C# does not override still answers UNIMPLEMENTED; grpc-js does not, and a missing handler
 *     key would answer UNIMPLEMENTED at call time with no registration-time signal. So
 *     {@link createServiceRegistrations} builds one handler for EVERY method of every definition,
 *     synthesizing the UNIMPLEMENTED answer for the methods no ported service implements (the
 *     seven `ExperimentalService` methods Spiceport leaves to its base class).
 *  3. THE CALL SEAM IS ADAPTED HERE, NOT IN THE SERVICES. The ported services take
 *     `(request, [stream], signal?)` - see `server-stream-writer.ts`. This file is the only place
 *     that knows about `ServerWritableStream`/`ServerReadableStream`: it turns the call's
 *     `cancelled` event into an `AbortSignal`, honours Node backpressure by awaiting `drain` when
 *     `write` returns false, and turns a thrown `RpcError` into the `ServiceError` grpc-js puts on
 *     the wire (unary: the callback; streaming: an `error` event, which grpc-js converts to a
 *     status and ends the stream).
 *  4. `app.MapGet("/", () => "Spiceport API up.")` is an HTTP endpoint alongside gRPC, and grpc-js
 *     cannot serve it: ASP.NET Core multiplexes both over ONE Kestrel port, and grpc-js owns its
 *     socket. It becomes a tiny separate `node:http` listener on its own port, with the body kept
 *     verbatim as {@link API_ROOT_BODY}.
 *  5. THE STARTUP ORDER IS LOAD-BEARING and is what {@link runApiHost} exists to hold: START the
 *     host, THEN seed, THEN wait for shutdown. Seeding needs the cluster running because the
 *     datastore lives behind the singleton grain. Not before start, and not lazily on first
 *     request.
 */

/** The body of the plain `GET /` liveness endpoint, verbatim from the C#. */
export const API_ROOT_BODY = "Spiceport API up.";

/** The dev cluster this host joins - `UseLocalhostClustering`'s fixed identity. */
export const API_CLUSTER_ID = "spiceport";

/** This silo's name/address stem within that cluster. */
export const API_SILO_NAME = "spiceport-api";

/** Where the gRPC surface listens. ASP.NET Core's Kestrel binding has no port-level counterpart. */
export const GRPC_LISTEN_ADDRESS = "0.0.0.0:50051";

/** Where the `GET /` endpoint listens - a separate socket, see port decision 4. */
export const HTTP_LISTEN_PORT = 8080;

/**
 * See `@spacedb/silo/program`: the datastore grain and the `GrainBackedDatastore` facade MUST be
 * handed the SAME options, or the facade's nominal GC window drifts from the grain's real floor.
 */
const DATASTORE_GC_OPTIONS: DatastoreGcOptions | undefined = undefined;

/** What the seven services are constructed from - the C#'s DI-resolved constructor arguments. */
export interface ApiServiceDependencies {
  /** The top-level check entry point. */
  readonly checker: IPermissionChecker;
  /** The grain factory the services address the mesh through. */
  readonly grains: GrainFactoryAccess;
  /** The reverse-ops in-process read helper. */
  readonly reverseOps: ReverseOps;
  /** The relationship-read in-process helper. */
  readonly relationshipReads: RelationshipReads;
  /** The host-owned datastore facade (the watch services' changefeed). */
  readonly datastore: IDatastore;
  /** The live schema provider. */
  readonly schemaProvider: ISchemaProvider;
}

/** One `MapGrpcService<T>()`: a proto service definition and the handlers answering it. */
export interface ServiceRegistration {
  /** The fully-qualified proto service name, e.g. `authzed.api.v1.WatchService`. */
  readonly serviceName: string;
  /** The generated definition, whose method paths carry {@link serviceName}. */
  readonly definition: ServiceDefinition;
  /** A handler for EVERY method of {@link definition} - see port decision 2. */
  readonly implementation: UntypedServiceImplementation;
}

/** The service name encoded in a generated definition's method paths (`/pkg.Service/Method`). */
function serviceNameOf(definition: ServiceDefinition): string {
  const paths = Object.values(definition).map(
    (method) => (method as MethodDefinition<unknown, unknown>).path,
  );
  const name = paths[0];
  if (name === undefined) throw new InvalidArgumentError("service definition has no methods");
  return name.slice(1, name.lastIndexOf("/"));
}

/** A grpc-js call, of any of the three shapes this file adapts. */
type AnyCall =
  | ServerUnaryCall<unknown, unknown>
  | ServerReadableStream<unknown, unknown>
  | ServerWritableStream<unknown, unknown>;

/**
 * `ServerCallContext.CancellationToken`. grpc-js signals a client-side cancel (or a broken
 * transport) with a `cancelled` event on the call, so that is what aborts the signal the ported
 * services observe.
 */
function signalFor(call: AnyCall): AbortSignal {
  const controller = new AbortController();
  // The three call classes' `on` overload sets do not unify, so the subscription is made through
  // the one member all three share: an emitter taking a `cancelled` listener.
  (call as { on(event: "cancelled", listener: () => void): unknown }).on("cancelled", () => {
    controller.abort();
  });
  return controller.signal;
}

/**
 * `IServerStreamWriter<T>` over a `ServerWritableStream`. A `write` returning false means the
 * socket's buffer is full: awaiting `drain` is the ADAPTER's job, so a service body only ever
 * awaits `write` (see `server-stream-writer.ts`).
 */
function streamWriterFor<T>(call: ServerWritableStream<unknown, T>): ServerStreamWriter<T> {
  return {
    async write(message: T): Promise<void> {
      if (!call.write(message)) await once(call, "drain");
    },
  };
}

/** The client's messages as an `IAsyncStreamReader<T>` - grpc-js readable streams are async-iterable. */
function requestIterable<T>(call: ServerReadableStream<T, unknown>): AsyncIterable<T> {
  return call as unknown as AsyncIterable<T>;
}

/**
 * The `RpcException` -> `ServiceError` conversion. `RpcError` already carries `code`, `details` and
 * `metadata`, so it crosses unchanged; anything else is an unmapped server fault, which grpc-js
 * turns into UNKNOWN exactly as ASP.NET Core does.
 */
function toServiceError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The method a `handleUnimplemented` answers with, for a definition method nothing implements. */
function unimplemented(path: string): (call: AnyCall, callback?: sendUnaryData<unknown>) => void {
  return (call, callback) => {
    const error = Object.assign(new Error(`The method ${path} is unimplemented.`), {
      code: status.UNIMPLEMENTED,
      details: `The method ${path} is unimplemented.`,
    });
    if (callback !== undefined) {
      callback(error as never);
      return;
    }
    (call as ServerWritableStream<unknown, unknown>).emit("error", error);
  };
}

/** The service method matching a definition key, if the ported service implements one. */
type ServiceMethod = (...args: never[]) => Promise<unknown>;

function methodOf(service: object, name: string): ServiceMethod | undefined {
  const candidate = (service as Record<string, unknown>)[name];
  return typeof candidate === "function" ? (candidate.bind(service) as ServiceMethod) : undefined;
}

/**
 * Builds the handler bag for one service: one entry per method of the definition, adapted to the
 * ported service's `(request, [stream], signal?)` shape - and UNIMPLEMENTED where the C# leaves the
 * method to its generated base class (port decision 2).
 */
function implementationFor(
  definition: ServiceDefinition,
  service: object,
): UntypedServiceImplementation {
  const implementation: Record<string, unknown> = {};
  for (const [name, rawMethod] of Object.entries(definition)) {
    const method = rawMethod as MethodDefinition<unknown, unknown>;
    const ported = methodOf(service, name);
    if (ported === undefined) {
      implementation[name] = unimplemented(method.path);
      continue;
    }

    if (method.requestStream) {
      implementation[name] = (
        call: ServerReadableStream<unknown, unknown>,
        callback: sendUnaryData<unknown>,
      ): void => {
        void (async () => {
          try {
            const reply = await (
              ported as (s: AsyncIterable<unknown>, signal: AbortSignal) => Promise<unknown>
            )(requestIterable(call), signalFor(call));
            callback(null, reply);
          } catch (error) {
            callback(toServiceError(error) as never);
          }
        })();
      };
      continue;
    }

    if (method.responseStream) {
      implementation[name] = (call: ServerWritableStream<unknown, unknown>): void => {
        void (async () => {
          try {
            await (
              ported as (
                request: unknown,
                stream: ServerStreamWriter<unknown>,
                signal: AbortSignal,
              ) => Promise<void>
            )(call.request, streamWriterFor(call), signalFor(call));
            call.end();
          } catch (error) {
            call.emit("error", toServiceError(error));
          }
        })();
      };
      continue;
    }

    implementation[name] = (
      call: ServerUnaryCall<unknown, unknown>,
      callback: sendUnaryData<unknown>,
    ): void => {
      void (async () => {
        try {
          const reply = await (
            ported as (request: unknown, signal: AbortSignal) => Promise<unknown>
          )(call.request, signalFor(call));
          callback(null, reply);
        } catch (error) {
          callback(toServiceError(error) as never);
        }
      })();
    };
  }
  return implementation as UntypedServiceImplementation;
}

/**
 * The seven `MapGrpcService<T>()` calls, IN THE C#'s ORDER: the three `spiceport.v0` services
 * first, then the four `authzed.api.v1` ones. Both families are served from the SAME dependency bag
 * - one grain mesh, one set of in-process helpers - and they coexist because their proto packages
 * differ, so `spiceport.v0.WatchService` and `authzed.api.v1.WatchService` are distinct keys.
 */
export function createServiceRegistrations(
  dependencies: ApiServiceDependencies,
): readonly ServiceRegistration[] {
  const { checker, grains, reverseOps, relationshipReads, datastore, schemaProvider } =
    dependencies;

  const pairs: ReadonlyArray<readonly [ServiceDefinition, object]> = [
    [
      PermissionsServiceService,
      new PermissionsGrpcService(checker, grains, reverseOps, relationshipReads),
    ],
    [WatchServiceService, new WatchGrpcService(datastore, schemaProvider)],
    [BulkServiceService, new BulkGrpcService(grains, relationshipReads)],
    [
      AuthzedPermissionsServiceService,
      new AuthzedPermissionsV1Service(
        checker,
        grains,
        reverseOps,
        relationshipReads,
        schemaProvider,
      ),
    ],
    [SchemaServiceService, new AuthzedSchemaV1Service(grains, schemaProvider)],
    [AuthzedWatchServiceService, new AuthzedWatchV1Service(datastore, schemaProvider)],
    [ExperimentalServiceService, new AuthzedExperimentalV1Service(grains, schemaProvider)],
  ];

  return pairs.map(([definition, service]) => ({
    serviceName: serviceNameOf(definition),
    definition,
    implementation: implementationFor(definition, service),
  }));
}

/** Adds every registration to one grpc-js `Server`. Binds nothing. */
export function addServices(
  server: GrpcServer,
  registrations: readonly ServiceRegistration[],
): GrpcServer {
  for (const registration of registrations) {
    server.addService(registration.definition, registration.implementation);
  }
  return server;
}

/** The silo half of the host - identical to `@spacedb/silo/program` but for the schema constant. */
export function configureApiSilo(
  builder: SiloBuilder,
  configuration: Configuration,
): SpiceportGrainServices {
  if (builder === undefined || builder === null) {
    throw new InvalidArgumentError("builder is required");
  }
  if (configuration === undefined || configuration === null) {
    throw new InvalidArgumentError("configuration is required");
  }

  // `silo.UseLocalhostClustering();`
  builder.useStaticMembership([builder.local]);
  builder.useInProcessTransport(new InProcessNetwork());
  builder.requireObserverHosting();
  // CheckGrain's per-activation reply memo (default ON) needs a matching idle-collection age so a
  // warm activation survives long enough between calls for the memo to pay off.
  addActivationMemoCollectionAge(builder);
  // Durable Postgres when ConnectionStrings:OrleansStorage is configured; otherwise in-memory.
  addDatastoreGrainStorage(builder, configuration);
  // The event-sourced datastore grain's log-consistency backing.
  builder.useMemoryJournaling();
  // Backs the datastore grain's periodic MVCC-GC reminder ("mvcc-gc").
  builder.useReminders();

  // Schema + check-engine singletons (compiled once from the embedded seed schema).
  let datastore: IDatastore | undefined;
  const services: SpiceportGrainServices = addSpiceportGrainServices(builder, {
    schemaText: SEED_SCHEMA_TEXT,
    ...(builder.storageProvider(DATASTORE_PROVIDER_NAME) !== undefined
      ? { datastoreStorage: builder.storageProvider(DATASTORE_PROVIDER_NAME) }
      : {}),
    ...(DATASTORE_GC_OPTIONS !== undefined ? { datastoreGcOptions: DATASTORE_GC_OPTIONS } : {}),
    datastore: () =>
      (datastore ??= new GrainBackedDatastore(
        services.grainFactory,
        services.hub,
        undefined,
        undefined,
        DATASTORE_GC_OPTIONS,
      )),
  });

  return services;
}

/** The three startup steps, in the order `Program.cs` runs them (port decision 5). */
export interface ApiHostSteps {
  /** `await app.StartAsync()` - the silo AND the listening surfaces. */
  start(): Promise<void>;
  /** `await SeedData.SeedAsync(...)` - only reachable once the cluster is running. */
  seed(): Promise<boolean>;
  /** `await app.WaitForShutdownAsync()`. */
  waitForShutdown(): Promise<void>;
}

/** START the host, THEN seed, THEN wait for shutdown. A failure at any step stops the sequence. */
export async function runApiHost(steps: ApiHostSteps): Promise<void> {
  await steps.start();
  await steps.seed();
  await steps.waitForShutdown();
}

/** The built host: the silo, the gRPC server and the plain `GET /` listener, none of them started. */
export interface ApiHost {
  readonly silo: SiloHost;
  readonly services: SpiceportGrainServices;
  readonly server: GrpcServer;
  readonly root: HttpServer;
}

/** `builder.Build()` plus the seven `MapGrpcService` calls: everything but `StartAsync`. */
export function createApiHost(
  configuration: Configuration = configurationFromEnvironment(),
): ApiHost {
  const builder = createSilo({
    clusterId: API_CLUSTER_ID,
    local: new SiloAddress(API_SILO_NAME, `uid-${API_SILO_NAME}`, `${API_SILO_NAME}:11111`),
  });
  const services = configureApiSilo(builder, configuration);
  const silo = builder.build();

  // The `Server` is created here, as the C# maps its services before `StartAsync`, but the seven
  // registrations are made in {@link apiHostSteps}' start step, AFTER the silo starts: a ported
  // service captures its grain factory in its constructor, and the factory is bound by the silo's
  // startup task. The C# has the same ordering by a different route - ASP.NET Core constructs a
  // gRPC service per CALL, so its DI resolution also happens after the host has started - and
  // nothing is listening in between either way.
  const server = new Server();

  // `app.MapGet("/", () => "Spiceport API up.")` - port decision 4.
  const root = createServer((request, response) => {
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(API_ROOT_BODY);
      return;
    }
    response.writeHead(404).end();
  });

  return { silo, services, server, root };
}

/**
 * The process entry point an ATTENDED manual `zed`/grpcurl run uses. NEVER call this from a test or
 * from CI: a backgrounded host orphans and runs forever.
 */
export async function main(): Promise<void> {
  await runApiHost(apiHostSteps(createApiHost()));
}

/** The three startup steps over a built host - see {@link createApiHost} for the ordering note. */
export function apiHostSteps(host: ApiHost): ApiHostSteps {
  return {
    start: async () => {
      await host.silo.start();
      const { services } = host;
      addServices(
        host.server,
        createServiceRegistrations({
          checker: services.checker,
          grains: services.grainFactory,
          reverseOps: services.reverseOps,
          relationshipReads: services.relationshipReads,
          datastore: services.datastore,
          schemaProvider: services.schemaProvider,
        }),
      );
      await new Promise<void>((resolve, reject) => {
        host.server.bindAsync(GRPC_LISTEN_ADDRESS, ServerCredentials.createInsecure(), (error) => {
          if (error !== null) reject(error);
          else resolve();
        });
      });
      await new Promise<void>((resolve) => host.root.listen(HTTP_LISTEN_PORT, resolve));
    },
    // Seed relationships once at startup so CheckPermission returns a real answer.
    seed: () => seedAsync(host.services.datastore),
    waitForShutdown: () =>
      new Promise<void>((resolve) => {
        const stop = (): void => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          host.root.close();
          host.server.forceShutdown();
          void host.silo.stop().then(resolve, resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      }),
  };
}

// The C#'s top-level statements run on load; this guard keeps an IMPORT inert.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
