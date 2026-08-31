import { Server, type ServiceDefinition } from "@grpc/grpc-js";
import { CheckGrain } from "@benedb/grains/check-grain";
import type { IPermissionChecker } from "@benedb/grains/i-permission-checker";
import type { ISchemaProvider } from "@benedb/grains/i-schema-provider";
import type { RelationshipReads } from "@benedb/grains/relationship-reads";
import type { ReverseOps } from "@benedb/grains/reverse-ops";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import { ExperimentalServiceService } from "@benedb/protos/authzed/api/v1/experimental_service";
import { PermissionsServiceService as AuthzedPermissionsServiceService } from "@benedb/protos/authzed/api/v1/permission_service";
import { SchemaServiceService } from "@benedb/protos/authzed/api/v1/schema_service";
import { WatchServiceService as AuthzedWatchServiceService } from "@benedb/protos/authzed/api/v1/watch_service";
import {
  BulkServiceService,
  PermissionsServiceService,
  WatchServiceService,
} from "@benedb/protos/permissions";
import { CLUSTERING_SILOS_KEY, resolveClustering } from "@benedb/silo/clustering-config";
import { createConfiguration } from "@benedb/silo/datastore-storage-config";
import { getGrainMetadata } from "@thresh/core/grain-metadata";
import { SiloAddress } from "@thresh/core/silo-address";
import { createSilo, type SiloBuilder } from "@thresh/hosting/silo-builder";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  API_GRPC_PORT_KEY,
  API_HTTP_PORT_KEY,
  API_ROOT_BODY,
  GRPC_LISTEN_ADDRESS,
  HTTP_LISTEN_PORT,
  addServices,
  configureApiSilo,
  createServiceRegistrations,
  main,
  resolveApiListenEndpoints,
  runApiHost,
  shutdownApiHost,
  type ApiHost,
  type ApiHostSteps,
  type ApiServiceDependencies,
} from "./program";
import { SEED_SCHEMA_TEXT } from "./seed-data";

/**
 * Characterization test for `src/Spiceport.Api/Program.cs`.
 *
 * The C# has NO covering suite, AND NONE MAY BE WRITTEN THAT STARTS IT. Nothing in this file boots
 * a host, binds a port, or starts a silo: a backgrounded host orphans and runs forever. What is
 * pinned instead is the PURE WIRING - which services are registered under which proto service
 * definitions, and in what order the startup steps run - which is exactly the part of a top-level
 * statement file that has behaviour worth protecting.
 *
 * WHY THE FILE IS FACTORED THE WAY IT IS. `WebApplication.CreateBuilder` + `builder.Host.UseOrleans`
 * + seven `MapGrpcService<T>()` calls + `MapGet("/")` + `StartAsync`/`SeedAsync`/`WaitForShutdownAsync`
 * has no mechanical counterpart: a Thresh silo comes from `createSilo(...).build()` and the gRPC
 * surface from a `@grpc/grpc-js` `Server`. So the top-level statements split into three functions
 * that are testable WITHOUT a host - {@link configureApiSilo}, {@link createServiceRegistrations},
 * {@link runApiHost} - and a `main()` that composes them and is never called from a test.
 *
 * WHAT IS PINNED:
 *
 *  1. SEVEN SERVICES, IN THE C#'s ORDER: the three `spiceport.v0` services first, then the four
 *     `authzed.api.v1` ones. Both families are served from the SAME grain mesh; the registration
 *     list is the whole translation layer's manifest.
 *  2. NO SERVICE-NAME COLLISION. `spiceport.v0.WatchService` and `authzed.api.v1.WatchService` are
 *     distinct only by proto package, and grpc-js keys handlers by the fully-qualified name, so a
 *     definition paired with the wrong name would silently shadow the other family's Watch. This is
 *     verified rather than assumed.
 *  3. EVERY METHOD OF EVERY DEFINITION HAS A HANDLER. grpc-js does not check this: a missing
 *     handler becomes UNIMPLEMENTED at call time, which no unit suite beneath this layer would see.
 *  4. THE STARTUP ORDER IS LOAD-BEARING: start the host, THEN seed, THEN wait for shutdown. Seeding
 *     needs the cluster running because the datastore lives behind the singleton grain. Seeding
 *     before start, or lazily on the first request, is a different program.
 *  5. THE API HOST COMPILES `SeedData.SchemaText` (not the silo host's constant), and the silo
 *     configuration honours the datastore storage config.
 *
 * DEVIATION PINNED HERE TOO: `app.MapGet("/", () => "Spiceport API up.")` is an HTTP endpoint
 * alongside gRPC, and `@grpc/grpc-js` cannot serve it. The body text is kept as a constant so
 * whatever serves it (a small `node:http` listener) cannot drift; nothing here listens.
 */

/** The seven fully-qualified proto service names, in the order `Program.cs` maps them. */
const EXPECTED = [
  { serviceName: "spiceport.v0.PermissionsService", definition: PermissionsServiceService },
  { serviceName: "spiceport.v0.WatchService", definition: WatchServiceService },
  { serviceName: "spiceport.v0.BulkService", definition: BulkServiceService },
  {
    serviceName: "authzed.api.v1.PermissionsService",
    definition: AuthzedPermissionsServiceService,
  },
  { serviceName: "authzed.api.v1.SchemaService", definition: SchemaServiceService },
  { serviceName: "authzed.api.v1.WatchService", definition: AuthzedWatchServiceService },
  { serviceName: "authzed.api.v1.ExperimentalService", definition: ExperimentalServiceService },
] as const;

/**
 * The service constructors only assign their fields, so a structural stand-in is enough to build
 * the registration manifest - and it is what keeps this test from needing a cluster.
 */
function dependencies(): ApiServiceDependencies {
  return {
    checker: {} as IPermissionChecker,
    grains: {} as ApiServiceDependencies["grains"],
    reverseOps: {} as ReverseOps,
    relationshipReads: {} as RelationshipReads,
    datastore: {} as IDatastore,
    schemaProvider: {} as ISchemaProvider,
  };
}

/** The service name encoded in a generated definition's method paths (`/pkg.Service/Method`). */
function serviceNameOf(definition: ServiceDefinition): string {
  const paths = Object.values(definition).map((method) => method.path);
  const names = new Set(paths.map((path) => path.slice(1, path.lastIndexOf("/"))));
  expect(names.size).toBe(1);
  return [...names][0] as string;
}

describe("createServiceRegistrations", () => {
  it("registers the seven services in the order Program.cs maps them", () => {
    const registrations = createServiceRegistrations(dependencies());

    expect(registrations.map((r) => r.serviceName)).toEqual(EXPECTED.map((e) => e.serviceName));
  });

  it("pairs each service name with the generated definition that actually carries it", () => {
    const registrations = createServiceRegistrations(dependencies());

    for (const [index, expected] of EXPECTED.entries()) {
      const registration = registrations[index];
      expect(registration?.definition).toBe(expected.definition);
      expect(serviceNameOf(expected.definition)).toBe(expected.serviceName);
    }
  });

  it("has no service-name collision between the two proto families", () => {
    const names = createServiceRegistrations(dependencies()).map((r) => r.serviceName);

    expect(new Set(names).size).toBe(names.length);
    // The two Watch services differ ONLY by package - the case the collision check exists for.
    expect(names).toContain("spiceport.v0.WatchService");
    expect(names).toContain("authzed.api.v1.WatchService");
  });

  it("supplies a handler for every method of every definition", () => {
    for (const registration of createServiceRegistrations(dependencies())) {
      for (const method of Object.keys(registration.definition)) {
        expect(
          typeof registration.implementation[method],
          `${registration.serviceName}.${method} has no handler`,
        ).toBe("function");
      }
    }
  });

  it("serves both proto families from the same dependency bag", () => {
    // One `createServiceRegistrations` call, one grain mesh: nothing in this layer may construct an
    // engine, a datastore, or a second set of in-process helpers.
    const deps = dependencies();
    expect(() => createServiceRegistrations(deps)).not.toThrow();
  });
});

describe("addServices", () => {
  const servers: Server[] = [];

  afterEach(() => {
    // Never bound, so nothing is listening; shut down anyway rather than leak the object.
    for (const server of servers.splice(0)) server.forceShutdown();
  });

  it("adds all seven to one grpc-js Server without binding a port", () => {
    const server = new Server();
    servers.push(server);

    expect(() => addServices(server, createServiceRegistrations(dependencies()))).not.toThrow();
  });
});

describe("runApiHost", () => {
  function recordingSteps(overrides: Partial<ApiHostSteps> = {}): {
    steps: ApiHostSteps;
    calls: string[];
  } {
    const calls: string[] = [];
    const steps: ApiHostSteps = {
      start: async () => {
        calls.push("start");
      },
      seed: async () => {
        calls.push("seed");
        return true;
      },
      waitForShutdown: async () => {
        calls.push("waitForShutdown");
      },
      ...overrides,
    };
    return { steps, calls };
  }

  it("starts the host, THEN seeds, THEN waits for shutdown", async () => {
    const { steps, calls } = recordingSteps();

    await runApiHost(steps);

    expect(calls).toEqual(["start", "seed", "waitForShutdown"]);
  });

  it("propagates a seed failure and never waits for shutdown", async () => {
    const { steps, calls } = recordingSteps({
      seed: async () => {
        calls.push("seed");
        throw new Error("seed failed");
      },
    });

    await expect(runApiHost(steps)).rejects.toThrow("seed failed");
    expect(calls).toEqual(["start", "seed"]);
  });

  it("never seeds when the host fails to start", async () => {
    const { steps, calls } = recordingSteps({
      start: async () => {
        calls.push("start");
        throw new Error("start failed");
      },
    });

    await expect(runApiHost(steps)).rejects.toThrow("start failed");
    expect(calls).toEqual(["start"]);
  });
});

describe("shutdownApiHost", () => {
  /**
   * A host whose four shutdown collaborators only record that they were called. `services` carries
   * the real shape the host uses: `hub` is resolved lazily off a started silo, which is why this
   * test builds the bag rather than a real host.
   */
  function recordingHost(): { host: ApiHost; calls: string[] } {
    const calls: string[] = [];
    const host = {
      root: { close: () => calls.push("root.close") },
      server: { forceShutdown: () => calls.push("server.forceShutdown") },
      silo: {
        stop: async () => {
          calls.push("silo.stop");
        },
      },
      services: {
        hub: {
          dispose: async () => {
            calls.push("hub.dispose");
          },
        },
      },
    } as unknown as ApiHost;
    return { host, calls };
  }

  // The defect this pins: LogWatchHub runs a heartbeat timer, and an undisposed heartbeat keeps
  // the Node event loop alive forever. The host would then serve SIGTERM's handler to completion
  // and STILL not exit, so a container hangs until the orchestrator escalates to SIGKILL. The
  // hub's own doc calls an orphaned heartbeat "the Node analogue of the orphaned-host hazard
  // CLAUDE.md forbids" -- the mechanism was always there; nothing called it.
  it("disposes the watch hub, so the heartbeat cannot outlive the host", async () => {
    const { host, calls } = recordingHost();

    await shutdownApiHost(host);

    expect(calls).toContain("hub.dispose");
  });

  it("disposes the hub BEFORE stopping the silo", async () => {
    const { host, calls } = recordingHost();

    await shutdownApiHost(host);

    // Disposal deletes the hub's object reference, which needs a runtime that has not gone away.
    expect(calls.indexOf("hub.dispose")).toBeLessThan(calls.indexOf("silo.stop"));
  });

  it("stops the silo even when disposing the hub fails", async () => {
    const { host, calls } = recordingHost();
    (host.services as { hub: { dispose: () => Promise<void> } }).hub = {
      dispose: () => Promise.reject(new Error("hub is already gone")),
    };

    await shutdownApiHost(host);

    // A shutdown path that gives up half way leaves exactly the orphan it exists to prevent.
    expect(calls).toContain("silo.stop");
  });
});

describe("configureApiSilo", () => {
  function builder(): SiloBuilder {
    return createSilo({
      clusterId: "benedb-api-test",
      local: new SiloAddress("api-test", "uid-api-test", "api-test:11111"),
    });
  }

  /**
   * A real `SiloBuilder` behind a recording proxy - the silo host's suite has the identical helper
   * for the identical reason, and the duplication follows the two hosts' own. Nothing is built.
   */
  function recordingBuilder(local?: SiloAddress): {
    builder: SiloBuilder;
    calls: { name: string; args: readonly unknown[] }[];
  } {
    const target = createSilo({
      clusterId: "benedb-api-test",
      local: local ?? new SiloAddress("api-test", "uid-api-test", "api-test:11111"),
    });
    const calls: { name: string; args: readonly unknown[] }[] = [];
    const suppressed = new Set(["addStorage", "addPostgresStorage", "addRedisStorage"]);
    const proxy: SiloBuilder = new Proxy(target, {
      get(receiver, property) {
        const value = Reflect.get(receiver, property);
        if (typeof value !== "function" || typeof property !== "string") return value;
        return (...args: unknown[]) => {
          calls.push({ name: property, args });
          if (suppressed.has(property)) return proxy;
          const result = (value as (...a: unknown[]) => unknown).apply(receiver, args);
          return result === receiver ? proxy : result;
        };
      },
    }) as SiloBuilder;
    return { builder: proxy, calls };
  }

  function named(
    calls: readonly { name: string; args: readonly unknown[] }[],
    name: string,
  ): { name: string; args: readonly unknown[] }[] {
    return calls.filter((call) => call.name === name);
  }

  /** A clustered configuration and the options both the host and this suite resolve from it. */
  function clusteredConfiguration(silos: string) {
    const configuration = createConfiguration({
      "ConnectionStrings:OrleansStorage": "postgres://localhost/benedb",
      [CLUSTERING_SILOS_KEY]: silos,
    });
    const clustering = resolveClustering(configuration);
    if (clustering.kind !== "clustered") throw new Error("expected a clustered configuration");
    return { configuration, clustering };
  }

  it("wires the in-process transport and a single-address view with no clustering configured", () => {
    const { builder: recording, calls } = recordingBuilder();

    configureApiSilo(recording, createConfiguration({}));

    const membership = named(calls, "useStaticMembership");
    expect(membership).toHaveLength(1);
    expect(membership[0]?.args[0]).toEqual([recording.local]);
    expect(named(calls, "useInProcessTransport")).toHaveLength(1);
    expect(named(calls, "useWebSocketTransport")).toHaveLength(0);
  });

  it("wires the WebSocket transport and the whole configured view when clustered", () => {
    const { configuration, clustering } = clusteredConfiguration("127.0.0.1:11111,127.0.0.1:11112");
    const { builder: recording, calls } = recordingBuilder(clustering.local);

    configureApiSilo(recording, configuration, clustering);

    expect(named(calls, "useWebSocketTransport")).toHaveLength(1);
    expect(named(calls, "useInProcessTransport")).toHaveLength(0);
    expect(named(calls, "useStaticMembership")[0]?.args[0]).toEqual(clustering.silos);
  });

  it("declares observer hosting on BOTH paths - LogWatchHub mints a reference at startup", () => {
    const plain = recordingBuilder();
    configureApiSilo(plain.builder, createConfiguration({}));
    expect(named(plain.calls, "requireObserverHosting")).toHaveLength(1);

    const { configuration, clustering } = clusteredConfiguration("127.0.0.1:11111");
    const clustered = recordingBuilder(clustering.local);
    configureApiSilo(clustered.builder, configuration, clustering);
    expect(named(clustered.calls, "requireObserverHosting")).toHaveLength(1);
  });

  it("compiles the API host's own schema constant into the live provider", () => {
    const services = configureApiSilo(builder(), createConfiguration({}));

    expect(services.schemaProvider.current.sourceText).toBe(SEED_SCHEMA_TEXT);
  });

  it("arms the activation-memo collection age (a warm CheckGrain must outlive its memo)", () => {
    configureApiSilo(builder(), createConfiguration({}));

    // `AddActivationMemoCollectionAge` has no per-silo counterpart in Thresh; the ported extension
    // rewrites the grain class's metadata, so the age is observable there.
    const metadata = getGrainMetadata(CheckGrain);
    expect(metadata?.options?.collectionAgeSeconds).toBeGreaterThan(0);
  });
});

describe("resolveApiListenEndpoints", () => {
  // Two API hosts on one machine collide on 50051/8080 long before they collide on a silo port,
  // and two API hosts is exactly the topology the concurrent-seed case is about.
  it("defaults to the hardcoded listen values with nothing configured", () => {
    expect(resolveApiListenEndpoints(createConfiguration({}))).toEqual({
      grpcListenAddress: GRPC_LISTEN_ADDRESS,
      httpListenPort: HTTP_LISTEN_PORT,
    });
  });

  it("moves both listeners when the ports are configured, keeping the gRPC bind host", () => {
    expect(
      resolveApiListenEndpoints(
        createConfiguration({ [API_GRPC_PORT_KEY]: "50052", [API_HTTP_PORT_KEY]: "8081" }),
      ),
    ).toEqual({ grpcListenAddress: "0.0.0.0:50052", httpListenPort: 8081 });
  });

  it("reads the `__` environment spelling, as every other key does", () => {
    expect(resolveApiListenEndpoints(createConfiguration({ Api__HttpPort: "8082" }))).toEqual({
      grpcListenAddress: GRPC_LISTEN_ADDRESS,
      httpListenPort: 8082,
    });
  });

  it("rejects a port that is not one, naming the key", () => {
    expect(() =>
      resolveApiListenEndpoints(createConfiguration({ [API_GRPC_PORT_KEY]: "https" })),
    ).toThrow(/Api:GrpcPort/);
  });
});

describe("the host entry point", () => {
  it("is exported rather than run on import, so importing this module starts nothing", () => {
    // Reaching this line at all is the assertion: the import at the top of the file did not boot a
    // silo, bind a port, or seed. `main` is never CALLED here.
    expect(typeof main).toBe("function");
  });

  // The defect this pins. `process.argv[1] === fileURLToPath(import.meta.url)` is the standard
  // "am I the entry point" idiom, and it is WRONG under a bundler: everything is inlined into one
  // file, so `import.meta.url` and `argv[1]` are both that file and the guard fires during module
  // evaluation. `main()` then runs at import time, and `start.ts`'s own call runs a SECOND host
  // once the first returns -- observed as a bundled artifact that shuts down on SIGTERM and comes
  // straight back up, serving, needing a second signal to die. `start.ts` is the only entry point,
  // so the module must have NO top-level invocation at all: inert by construction, not by a
  // heuristic that a bundler defeats.
  it("has no module-scope invocation of main(), which a bundler would fire at import time", () => {
    const source = readFileSync(new URL("./program.ts", import.meta.url), "utf8");

    // Matches the guard STATEMENT, not the prose: the comment above `main` explains why the
    // guard is absent, and naming it there must not fail this.
    expect(source).not.toMatch(/^\s*if \(process\.argv\[1\]/m);
    expect(source).not.toMatch(/^\s*(await )?main\(\)/m);
  });

  it("keeps the plain GET / body verbatim", () => {
    expect(API_ROOT_BODY).toBe("Spiceport API up.");
  });
});
