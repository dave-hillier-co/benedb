import { CheckGrain } from "@spacedb/grains/check-grain";
import { getGrainMetadata } from "@thresh/core/grain-metadata";
import { SiloAddress } from "@thresh/core/silo-address";
import { createSilo, type SiloBuilder } from "@thresh/hosting/silo-builder";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CLUSTERING_SILOS_KEY, resolveClustering } from "./clustering-config";
import { DATASTORE_PROVIDER_NAME, createConfiguration } from "./datastore-storage-config";
import { configureSiloHost, main, shutdownSiloHost, type SiloHostWiring } from "./program";
import { SILO_SCHEMA_TEXT } from "./silo-schema";

/**
 * Characterization test for `src/Spiceport.Silo/Program.cs`.
 *
 * NO covering C# suite, and the same never-boot-from-a-test rule as the API host: nothing here
 * builds or starts a silo, and `main()` is never called. `Host.CreateApplicationBuilder(...)` +
 * `builder.UseOrleans(...)` + `host.Run()` is a top-level statement file, so the part with
 * behaviour worth pinning is the SILO CONFIGURATION, which lands in {@link configureSiloHost} - a
 * function taking a `SiloBuilder` that is never built.
 *
 * WHAT THIS FILE IS NOT ALLOWED TO BECOME. The silo host is NEARLY identical to the API host minus
 * everything gRPC, and the temptation is to factor the shared five-call wiring into one helper. The
 * two are independently maintained in the C#, and they differ in exactly the two places that
 * matter: the silo host compiles `SiloSchema.SchemaText` (NOT `SeedData.SchemaText`), and it does
 * NOT seed. A shared helper would make the next divergence a silent one, so the duplication is
 * deliberate and this suite pins the silo host's own copy.
 *
 * WHAT IS PINNED:
 *
 *  1. The schema the host compiles is the SILO constant. (The two constants are byte-identical
 *     today by design, so this is a value pin; what it protects is the constant being wired at all.)
 *  2. The `datastore` grain-storage provider is registered from configuration, taking the durable
 *     branch when a connection string is present - i.e. the host really does route its
 *     configuration through `AddDatastoreGrainStorage` rather than hardcoding in-memory.
 *  3. Reminders are enabled with the IN-MEMORY table. In-memory is deliberate even for a durable
 *     deployment: the singleton re-registers `mvcc-gc` on every activation, so losing a
 *     registration is safe.
 *  4. The event-sourced datastore grain's log-consistency backing is registered (the C#'s
 *     `AddCustomStorageBasedLogConsistencyProvider("CustomStorage")`; Thresh's journaling binder
 *     detects the custom-storage host, so what the C# named a provider is a journaling registration
 *     here).
 *  5. The activation-memo collection age is armed, so a warm `CheckGrain` outlives its reply memo.
 *  6. `main` is EXPORTED and guarded: importing this module must not start a silo as a side effect,
 *     because a manual smoke script imports it.
 *
 * The `IDatastore` singleton is deliberately NOT asserted here: `GrainBackedDatastore` is built
 * from the grain factory, which Thresh binds only once the silo has STARTED, and starting one is
 * exactly what this suite may not do. Its construction is covered by `MeshTestCluster`, which
 * mirrors this wiring.
 */

/** One intercepted `SiloBuilder` call. */
interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

/**
 * A real `SiloBuilder` wrapped in a recording proxy. The two storage registrations are RECORDED
 * AND SUPPRESSED rather than delegated: `addPostgresStorage` constructs a live `pg.Pool`, and this
 * test must not reach for a database that is not there.
 */
function recordingBuilder(
  local: SiloAddress = new SiloAddress("silo-test", "uid-silo-test", "silo-test:11111"),
): { builder: SiloBuilder; calls: Call[] } {
  const target = createSilo({
    clusterId: "spacedb-silo-test",
    local,
  });
  const calls: Call[] = [];
  const suppressed = new Set(["addStorage", "addPostgresStorage", "addRedisStorage"]);

  const proxy: SiloBuilder = new Proxy(target, {
    get(receiver, property, _receiverProxy) {
      const value = Reflect.get(receiver, property);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        calls.push({ name: property, args });
        if (suppressed.has(property)) return proxy;
        const result = (value as (...a: unknown[]) => unknown).apply(receiver, args);
        // Keep the chain inside the proxy, or a fluent call would escape the recording.
        return result === receiver ? proxy : result;
      };
    },
  }) as SiloBuilder;

  return { builder: proxy, calls };
}

function named(calls: readonly Call[], name: string): Call[] {
  return calls.filter((call) => call.name === name);
}

describe("configureSiloHost", () => {
  it("compiles the SILO schema constant into the live provider", () => {
    const { builder } = recordingBuilder();

    const services = configureSiloHost(builder, createConfiguration({}));

    expect(services.schemaProvider.current.sourceText).toBe(SILO_SCHEMA_TEXT);
  });

  it("registers the datastore grain-storage provider under its literal name", () => {
    const { builder, calls } = recordingBuilder();

    configureSiloHost(builder, createConfiguration({}));

    const registrations = named(calls, "addStorage").filter(
      (call) => call.args[0] === DATASTORE_PROVIDER_NAME,
    );
    expect(registrations).toHaveLength(1);
  });

  it("routes a configured connection string into the durable storage branch", () => {
    const { builder, calls } = recordingBuilder();

    configureSiloHost(
      builder,
      createConfiguration({ "ConnectionStrings:OrleansStorage": "postgres://localhost/spacedb" }),
    );

    const durable = named(calls, "addPostgresStorage");
    expect(durable).toHaveLength(1);
    expect(durable[0]?.args[0]).toBe(DATASTORE_PROVIDER_NAME);
    expect(durable[0]?.args[1]).toMatchObject({
      connectionString: "postgres://localhost/spacedb",
    });
    expect(named(calls, "addStorage")).toHaveLength(0);
  });

  it("enables reminders with the in-memory table (the mvcc-gc reminder's backing)", () => {
    const { builder, calls } = recordingBuilder();

    configureSiloHost(builder, createConfiguration({}));

    const reminders = named(calls, "useReminders");
    expect(reminders).toHaveLength(1);
    // `UseInMemoryReminderService()`: no persistent table is configured.
    expect(reminders[0]?.args[0]).toBeUndefined();
  });

  it("registers the log-consistency backing for the event-sourced datastore grain", () => {
    const { builder, calls } = recordingBuilder();

    configureSiloHost(builder, createConfiguration({}));

    const journaling = calls.filter((call) => /journal/i.test(call.name));
    expect(journaling.length).toBeGreaterThan(0);
  });

  it("arms the activation-memo collection age", () => {
    const { builder } = recordingBuilder();

    configureSiloHost(builder, createConfiguration({}));

    // `AddActivationMemoCollectionAge` has no per-silo counterpart in Thresh; the ported extension
    // rewrites the grain class's metadata, so the age is observable there.
    expect(getGrainMetadata(CheckGrain)?.options?.collectionAgeSeconds).toBeGreaterThan(0);
  });

  it("wires the in-process transport and a single-address view with no clustering configured", () => {
    const { builder, calls } = recordingBuilder();

    configureSiloHost(builder, createConfiguration({}));

    const membership = named(calls, "useStaticMembership");
    expect(membership).toHaveLength(1);
    expect(membership[0]?.args[0]).toEqual([builder.local]);
    expect(named(calls, "useInProcessTransport")).toHaveLength(1);
    expect(named(calls, "useWebSocketTransport")).toHaveLength(0);
  });

  it("wires the WebSocket transport and the whole configured view when clustered", () => {
    const configuration = createConfiguration({
      "ConnectionStrings:OrleansStorage": "postgres://localhost/spacedb",
      [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111,127.0.0.1:11112",
    });
    const clustering = resolveClustering(configuration);
    const local = clustering.kind === "clustered" ? clustering.local : undefined;
    const { builder, calls } = recordingBuilder(local);

    configureSiloHost(builder, configuration, clustering);

    expect(named(calls, "useWebSocketTransport")).toHaveLength(1);
    expect(named(calls, "useInProcessTransport")).toHaveLength(0);
    expect(named(calls, "useStaticMembership")[0]?.args[0]).toEqual(
      clustering.kind === "clustered" ? clustering.silos : undefined,
    );
  });

  it("declares observer hosting on BOTH paths - LogWatchHub mints a reference at startup", () => {
    const plain = recordingBuilder();
    configureSiloHost(plain.builder, createConfiguration({}));
    expect(named(plain.calls, "requireObserverHosting")).toHaveLength(1);

    const configuration = createConfiguration({
      "ConnectionStrings:OrleansStorage": "postgres://localhost/spacedb",
      [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111",
    });
    const clustering = resolveClustering(configuration);
    const clustered = recordingBuilder(
      clustering.kind === "clustered" ? clustering.local : undefined,
    );
    configureSiloHost(clustered.builder, configuration, clustering);
    expect(named(clustered.calls, "requireObserverHosting")).toHaveLength(1);
  });

  it("guards both arguments, as the C# ThrowIfNull pair does", () => {
    const { builder } = recordingBuilder();

    expect(() =>
      configureSiloHost(undefined as unknown as SiloBuilder, createConfiguration({})),
    ).toThrow();
    expect(() =>
      configureSiloHost(builder, undefined as unknown as ReturnType<typeof createConfiguration>),
    ).toThrow();
  });
});

describe("the silo entry point", () => {
  it("is exported rather than run on import, so importing this module starts nothing", () => {
    // Reaching this line is the assertion: the import at the top did not start a silo. `host.Run()`
    // blocks until shutdown, so a module that ran it on import would hang this suite forever.
    expect(typeof main).toBe("function");
  });
});

describe("shutdownSiloHost", () => {
  function recordingWiring(): { wiring: SiloHostWiring; calls: string[] } {
    const calls: string[] = [];
    const wiring = {
      host: {
        stop: async () => {
          calls.push("host.stop");
        },
      },
      services: {
        hub: {
          dispose: async () => {
            calls.push("hub.dispose");
          },
        },
      },
    } as unknown as SiloHostWiring;
    return { wiring, calls };
  }

  // Same defect as the API host: LogWatchHub's heartbeat is a real timer, and an undisposed hub
  // keeps the Node event loop alive after the silo has stopped, so the process never exits.
  it("disposes the watch hub, so the heartbeat cannot outlive the silo", async () => {
    const { wiring, calls } = recordingWiring();

    await shutdownSiloHost(wiring);

    expect(calls).toContain("hub.dispose");
  });

  it("disposes the hub BEFORE stopping the silo", async () => {
    const { wiring, calls } = recordingWiring();

    await shutdownSiloHost(wiring);

    expect(calls.indexOf("hub.dispose")).toBeLessThan(calls.indexOf("host.stop"));
  });

  it("stops the silo even when disposing the hub fails", async () => {
    const { wiring, calls } = recordingWiring();
    (wiring.services as { hub: { dispose: () => Promise<void> } }).hub = {
      dispose: () => Promise.reject(new Error("hub is already gone")),
    };

    await shutdownSiloHost(wiring);

    expect(calls).toContain("host.stop");
  });
});

describe("the host entry point", () => {
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
});
