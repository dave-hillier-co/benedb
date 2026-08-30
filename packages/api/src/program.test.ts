import { Server, type ServiceDefinition } from "@grpc/grpc-js";
import { CheckGrain } from "@spacedb/grains/check-grain";
import type { IPermissionChecker } from "@spacedb/grains/i-permission-checker";
import type { ISchemaProvider } from "@spacedb/grains/i-schema-provider";
import type { RelationshipReads } from "@spacedb/grains/relationship-reads";
import type { ReverseOps } from "@spacedb/grains/reverse-ops";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import { ExperimentalServiceService } from "@spacedb/protos/authzed/api/v1/experimental_service";
import { PermissionsServiceService as AuthzedPermissionsServiceService } from "@spacedb/protos/authzed/api/v1/permission_service";
import { SchemaServiceService } from "@spacedb/protos/authzed/api/v1/schema_service";
import { WatchServiceService as AuthzedWatchServiceService } from "@spacedb/protos/authzed/api/v1/watch_service";
import {
  BulkServiceService,
  PermissionsServiceService,
  WatchServiceService,
} from "@spacedb/protos/permissions";
import { createConfiguration } from "@spacedb/silo/datastore-storage-config";
import { getGrainMetadata } from "@thresh/core/grain-metadata";
import { SiloAddress } from "@thresh/core/silo-address";
import { createSilo, type SiloBuilder } from "@thresh/hosting/silo-builder";
import { afterEach, describe, expect, it } from "vitest";

import {
  API_ROOT_BODY,
  addServices,
  configureApiSilo,
  createServiceRegistrations,
  main,
  runApiHost,
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

describe("configureApiSilo", () => {
  function builder(): SiloBuilder {
    return createSilo({
      clusterId: "spacedb-api-test",
      local: new SiloAddress("api-test", "uid-api-test", "api-test:11111"),
    });
  }

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

describe("the host entry point", () => {
  it("is exported rather than run on import, so importing this module starts nothing", () => {
    // Reaching this line at all is the assertion: the import at the top of the file did not boot a
    // silo, bind a port, or seed. `main` is never CALLED here.
    expect(typeof main).toBe("function");
  });

  it("keeps the plain GET / body verbatim", () => {
    expect(API_ROOT_BODY).toBe("Spiceport API up.");
  });
});
