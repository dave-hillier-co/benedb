import type { DatastoreGcOptions } from "@benedb/grains/datastore-gc-options";
import { GrainBackedDatastore } from "@benedb/grains/grain-backed-datastore";
import type { SpiceportGrainServices } from "@benedb/grains/service-collection-extensions";
import { addSpiceportGrainServices } from "@benedb/grains/service-collection-extensions";
import { addActivationMemoCollectionAge } from "@benedb/grains/silo-builder-extensions";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { SiloAddress } from "@thresh/core/silo-address";
import { createSilo, type SiloBuilder } from "@thresh/hosting/silo-builder";
import type { SiloHost } from "@thresh/hosting/silo-host";

import type { ClusteringOptions } from "./clustering-config";
import { applyClustering, resolveClustering } from "./clustering-config";
import type { Configuration } from "./datastore-storage-config";
import {
  DATASTORE_PROVIDER_NAME,
  addDatastoreGrainStorage,
  configurationFromEnvironment,
} from "./datastore-storage-config";
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
 *  3. `AddCustomStorageBasedLogConsistencyProvider("CustomStorage")` has no counterpart: Thresh's
 *     journaling binder DETECTS a custom-storage host and installs the adaptor, so what the C#
 *     named a provider is `useMemoryJournaling()` here - the call that makes the binder run. The
 *     datastore grain's own durability still goes through the `datastore` GRAIN-STORAGE provider,
 *     exactly as in the C#, so this registration carries no state of its own.
 *  4. `UseInMemoryReminderService()` becomes `useReminders()` with its default in-memory table.
 *     In-memory is deliberate even for a durable deployment: the singleton grain re-registers
 *     `mvcc-gc` on every activation, so losing a registration is safe.
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
 *     the single-process silo. And a clustered silo needs DURABLE grain storage - the datastore
 *     grain is a cluster singleton whose default in-memory provider is constructed per silo, so its
 *     state would not survive the activation moving - which `resolveClustering` refuses at
 *     configure time unless the operator opts in.
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
  // Storage for the singleton datastore grain (the single source of truth). Durable Postgres when
  // ConnectionStrings:OrleansStorage is configured; otherwise in-memory (default localhost dev = no
  // Postgres).
  addDatastoreGrainStorage(builder, configuration);
  // The event-sourced datastore grain owns its persistence via the custom-storage seam over the
  // "datastore" grain-storage provider above - see port decision 3.
  builder.useMemoryJournaling();
  // Backs the datastore grain's periodic MVCC-GC reminder ("mvcc-gc") - see port decision 4.
  //
  // KNOWN LIMITATION IN A CLUSTER. The default table is PER SILO, and `LocalReminderService` fires
  // only the reminders whose grain hashes into the ranges THIS silo owns on the ring. Registration
  // lands on the silo the singleton activated on; firing is decided by the ring owner. Those are
  // the same silo only by coincidence, so with N silos `mvcc-gc` can silently stop running and MVCC
  // history is never collected. Re-registering on every activation does NOT close the gap, because
  // registering and firing are keyed on different silos. The fix is a SHARED table
  // (`usePostgresReminders`), which is not wired yet - single-process hosts are unaffected.
  builder.useReminders();

  // Schema + dispatch mesh (Caching over the grain mesh) + check-engine singletons.
  let datastore: IDatastore | undefined;
  const services: SpiceportGrainServices = addSpiceportGrainServices(builder, {
    schemaText: SILO_SCHEMA_TEXT,
    ...(builder.storageProvider(DATASTORE_PROVIDER_NAME) !== undefined
      ? { datastoreStorage: builder.storageProvider(DATASTORE_PROVIDER_NAME) }
      : {}),
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
