import type { DatastoreGcOptions } from "@benedb/grains/datastore-gc-options";
import { GrainBackedDatastore } from "@benedb/grains/grain-backed-datastore";
import type { SpiceportGrainServices } from "@benedb/grains/service-collection-extensions";
import { addSpiceportGrainServices } from "@benedb/grains/service-collection-extensions";
import { addActivationMemoCollectionAge } from "@benedb/grains/silo-builder-extensions";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { SiloAddress } from "@thresh/core/silo-address";
import { createSilo, type SiloBuilder } from "@thresh/hosting/silo-builder";
import type { StorageBackend } from "@thresh/hosting/storage-backend";
import { storageBackendFromEnvironment } from "@thresh/hosting/storage-backend";
import type { SiloHost } from "@thresh/hosting/silo-host";

import type { ClusteringOptions } from "./clustering-config";
import { applyClustering, resolveClustering } from "./clustering-config";
import type { Configuration } from "./configuration";
import { configurationFromEnvironment } from "./configuration";
import { SILO_SCHEMA_TEXT } from "./silo-schema";

/**
 * Ported from Spiceport `src/Spiceport.Silo/Program.cs`.
 *
 * The silo-only host: an Orleans silo with no web server, so the keyed check grains activate here.
 * NEARLY identical to the API host (`@benedb/api/program`) minus everything gRPC - and the
 * duplication is DELIBERATE. The two files are independently maintained in the C# and differ in
 * exactly the two places that matter: this host compiles {@link SILO_SCHEMA_TEXT} (NOT the API
 * host's `SEED_SCHEMA_TEXT`), and it does NOT seed. Factoring the shared five-call wiring into one
 * helper would make the next divergence a silent one.
 *
 * PORT DECISIONS.
 *
 *  1. TOP-LEVEL STATEMENTS BECOME `main()`. `Host.CreateApplicationBuilder(args)` + `host.Run()` is
 *     a file whose body executes on load. Here {@link main} is EXPORTED and this module has NO
 *     module-scope invocation at all - `start.ts` is the sole entry point. The obvious
 *     `process.argv[1] === fileURLToPath(import.meta.url)` guard is deliberately ABSENT, because it
 *     is wrong in both directions: it never matches under vite-node (the only thing here that can
 *     execute TypeScript), and once bundled it fires during module evaluation, where both sides are
 *     the same inlined file - starting a second host on top of the entry point's own call.
 *     Importing this module therefore starts nothing BY CONSTRUCTION, which is what keeps a test
 *     from booting a silo - and a backgrounded host orphans and runs forever.
 *  2. `UseLocalhostClustering()` BECOMES A CHOICE, not a constant - see {@link applyClustering} and
 *     port decision 6. With nothing configured it is static membership over this one silo plus
 *     Thresh's IN-PROCESS transport, which is exactly what `UseLocalhostClustering`'s no-argument
 *     form is for: a single-process dev silo needing no external dependency. The transport is now
 *     PREFERRED rather than forced - thresh#55 (`createObjectReference` throwing on a
 *     WebSocket-hosted silo) is closed and verified over real sockets, so a networked silo can back
 *     the observer seam `LogWatchHub` needs. {@link SiloBuilder.requireObserverHosting} is declared
 *     unconditionally on BOTH paths, and is load-bearing rather than aspirational now that two
 *     transports can back the seam and others cannot: it is what makes a future third choice fail
 *     at BUILD time rather than on the first Watch call.
 *  3. `AddDatastoreGrainStorage(configuration)` and
 *     `AddStateStorageBasedLogConsistencyProvider("StateStorage")` become ONE call,
 *     `useStorageBackend(storage)`. Where durable state lives is Thresh's decision, not this
 *     host's: the backend (from `THRESH_STORAGE_URL` by default) serves the `datastore`
 *     grain-storage provider the shard and index grains persist through, the journal the datastore
 *     grain is journaled in, and the reminder table. The C#'s connection-string reader and its
 *     "clustered silo needs durable storage" guard live in Thresh with it.
 *  4. `UseInMemoryReminderService()` becomes `useReminders()`, whose table is the storage
 *     backend's: shared across silos on a durable backend, so the `mvcc-gc` reminder fires on the
 *     ring owner wherever the singleton registered it.
 *  5. `AddSingleton<IDatastore>(...)` has no container to live in: `addSpiceportGrainServices`
 *     takes the host-owned datastore as a thunk and exposes it back on the returned record, which
 *     IS the container (see that file's port decisions).
 *  6. MULTI-SILO CLUSTERING IS A DEVIATION WITH NO SPICEPORT SOURCE. Spiceport calls only
 *     `silo.UseLocalhostClustering();` and ships no deployment configuration, so there is nothing
 *     to transliterate; the nearest Orleans counterpart is the OVERLOAD
 *     `UseLocalhostClustering(siloPort, gatewayPort, primarySiloEndpoint)`, which is how Orleans
 *     runs several silos on one machine. `clustering-config.ts` stands in for it, read through the
 *     SAME `Configuration` object the datastore storage config already uses (`Clustering:Silos` and
 *     friends, with .NET's `__`/case-insensitive key rules), and the port ledger carries a row for
 *     it. Three consequences belong at this call site. The presence of a silo list is the only
 *     switch, so the DEFAULT is byte-identically today's host. A clustered silo's IDENTITY is
 *     derived from its endpoint (`SiloAddress.ringKey` is `podName`, so two silos sharing this
 *     host's constant name would be one ring position), which is why {@link SILO_NAME} names only
 *     the single-process silo. And a clustered silo needs DURABLE storage - per-silo in-memory state
 *     would not survive an activation moving - which Thresh's `useStorageBackend` refuses at build
 *     unless the operator opts in.
 */

/**
 * The datastore grain's MVCC-GC options. The C# resolves `IOptions<DatastoreGcOptions>` from the
 * container and hands the SAME instance to `GrainBackedDatastore`, so the facade's nominal GC
 * window can never drift from the grain's real floor; this host registers none, so both sides take
 * the default - and they take it from THIS one binding, which is the coupling the C# comment is
 * about.
 */
const DATASTORE_GC_OPTIONS: DatastoreGcOptions | undefined = undefined;

/**
 * Everything `builder.UseOrleans(...)` plus the two `builder.Services` registrations do, on a
 * builder this function never builds. Returns the grain-services record (the C#'s container).
 */
export function configureSiloHost(
  builder: SiloBuilder,
  configuration: Configuration,
  clustering: ClusteringOptions = resolveClustering(configuration),
  storage: StorageBackend = storageBackendFromEnvironment(),
): SpiceportGrainServices {
  if (builder === undefined || builder === null) {
    throw new InvalidArgumentError("builder is required");
  }
  if (configuration === undefined || configuration === null) {
    throw new InvalidArgumentError("configuration is required");
  }

  // `silo.UseLocalhostClustering();` - see port decisions 2 and 6. The resolved options are an
  // OPTIONAL parameter because {@link createSiloHost} must resolve them before `createSilo` (the
  // local address is constructor input) and would otherwise resolve them twice.
  applyClustering(builder, clustering);
  builder.requireObserverHosting();
  // CheckGrain's per-activation reply memo (default ON) needs a matching idle-collection age so a
  // warm activation survives long enough between calls for the memo to pay off.
  addActivationMemoCollectionAge(builder);
  // Where durable state lives - the datastore grain's journal, the shard and index grains'
  // `datastore` provider, the reminder table - is the storage backend's decision (port decision 3).
  builder.useStorageBackend(storage);
  // Backs the datastore grain's periodic MVCC-GC reminder ("mvcc-gc") - see port decision 4.
  builder.useReminders();

  // Schema + dispatch mesh (Caching over the grain mesh) + check-engine singletons.
  let datastore: IDatastore | undefined;
  const services: SpiceportGrainServices = addSpiceportGrainServices(builder, {
    schemaText: SILO_SCHEMA_TEXT,
    ...(DATASTORE_GC_OPTIONS !== undefined ? { datastoreGcOptions: DATASTORE_GC_OPTIONS } : {}),
    // The datastore facade delegates to the cluster-singleton datastore grain (engine graph reads
    // go through the graph-shard mesh, not this facade). The watch hub is the one the grain
    // services own. Pass the SAME DatastoreGcOptions the datastore grain is configured with, so
    // this datastore's nominal GC window never drifts from the grain's real GcFloor policy.
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

/** The built, not-yet-started silo host and the services wired into it. */
export interface SiloHostWiring {
  readonly host: SiloHost;
  readonly services: SpiceportGrainServices;
}

/** `Host.CreateApplicationBuilder(args)` + `builder.Build()`: a host, built but not started. */
export function createSiloHost(
  configuration: Configuration = configurationFromEnvironment(),
): SiloHostWiring {
  // Resolved BEFORE `createSilo`, because a clustered silo's own address is constructor input and
  // is derived from its configured endpoint (port decision 6).
  const clustering = resolveClustering(configuration);
  const builder = createSilo({
    clusterId: SILO_CLUSTER_ID,
    local:
      clustering.kind === "clustered"
        ? clustering.local
        : new SiloAddress(SILO_NAME, `uid-${SILO_NAME}`, `${SILO_NAME}:11111`),
  });
  const services = configureSiloHost(builder, configuration, clustering);
  return { host: builder.build(), services };
}

/** The dev cluster this host joins - `UseLocalhostClustering`'s fixed identity. */
export const SILO_CLUSTER_ID = "spiceport";

/**
 * This silo's name/address stem within that cluster, for the SINGLE-PROCESS host. A clustered silo
 * derives its whole identity from its endpoint instead - see port decision 6.
 */
export const SILO_NAME = "spiceport-silo";

/**
 * `host.Run()`: start the silo and block until shutdown. SIGINT/SIGTERM drain it gracefully, which
 * is what the C# generic host's console lifetime does.
 *
 * NEVER call this from a test or from CI.
 */
export async function main(): Promise<void> {
  const wiring = createSiloHost();
  await wiring.host.start();

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void shutdownSiloHost(wiring).then(resolve, resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

/**
 * Releases everything the silo host holds. The API host has the identical function for the
 * identical reason (`@benedb/api/program`'s `shutdownApiHost`), and the duplication is deliberate
 * for the same reason the two hosts are duplicated: they are independently maintained in the C#.
 *
 * {@link LogWatchHub} runs its heartbeat as a detached loop over a real `setTimeout`, so an
 * undisposed hub keeps the Node event loop alive INDEFINITELY — the signal handler runs, the silo
 * stops, `main()` returns, and the process still never exits. Under an orchestrator that is a
 * container ignoring SIGTERM until it is SIGKILLed at the end of its grace period.
 *
 * The hub is disposed BEFORE the silo, because disposal deletes its object reference and that needs
 * a runtime that has not gone away; and the silo is stopped even if that fails, because a shutdown
 * that gives up half way leaves exactly the orphan it exists to prevent.
 */
export async function shutdownSiloHost(wiring: SiloHostWiring): Promise<void> {
  try {
    await wiring.services.hub.dispose();
  } catch {
    // a hub that never resolved cannot be holding a heartbeat
  }
  await wiring.host.stop();
}
