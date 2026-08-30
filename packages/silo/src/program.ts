import { fileURLToPath } from "node:url";

import type { DatastoreGcOptions } from "@spacedb/grains/datastore-gc-options";
import { GrainBackedDatastore } from "@spacedb/grains/grain-backed-datastore";
import type { SpiceportGrainServices } from "@spacedb/grains/service-collection-extensions";
import { addSpiceportGrainServices } from "@spacedb/grains/service-collection-extensions";
import { addActivationMemoCollectionAge } from "@spacedb/grains/silo-builder-extensions";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { SiloAddress } from "@thresh/core/silo-address";
import { createSilo, type SiloBuilder } from "@thresh/hosting/silo-builder";
import type { SiloHost } from "@thresh/hosting/silo-host";
import { InProcessNetwork } from "@thresh/messaging/in-process-transport";

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
 * NEARLY identical to the API host (`@spacedb/api/program`) minus everything gRPC - and the
 * duplication is DELIBERATE. The two files are independently maintained in the C# and differ in
 * exactly the two places that matter: this host compiles {@link SILO_SCHEMA_TEXT} (NOT the API
 * host's `SEED_SCHEMA_TEXT`), and it does NOT seed. Factoring the shared five-call wiring into one
 * helper would make the next divergence a silent one.
 *
 * PORT DECISIONS.
 *
 *  1. TOP-LEVEL STATEMENTS BECOME `main()`. `Host.CreateApplicationBuilder(args)` + `host.Run()` is
 *     a file whose body executes on load. Here {@link main} is EXPORTED and only invoked when this
 *     module is the process entry point, so importing it (a manual smoke script does) starts
 *     nothing - and nothing may boot a silo from a test or from CI, where a backgrounded host
 *     orphans and runs forever.
 *  2. `UseLocalhostClustering()` becomes static membership over this one silo plus Thresh's
 *     IN-PROCESS transport. The transport choice is forced, not preferred: `LogWatchHub` mints an
 *     observer reference from the silo's startup task, and `createObjectReference` throws on a
 *     WebSocket-hosted silo (thresh#55). {@link SiloBuilder.requireObserverHosting} is declared so
 *     that a later move to a networked transport fails at BUILD time rather than on the first
 *     Watch call. A single-process dev silo is what `UseLocalhostClustering` is for; a multi-silo
 *     deployment needs the networked transport, and so needs thresh#55 fixed first.
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
): SpiceportGrainServices {
  if (builder === undefined || builder === null) {
    throw new InvalidArgumentError("builder is required");
  }
  if (configuration === undefined || configuration === null) {
    throw new InvalidArgumentError("configuration is required");
  }

  // `silo.UseLocalhostClustering();` - see port decision 2.
  builder.useStaticMembership([builder.local]);
  builder.useInProcessTransport(new InProcessNetwork());
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
  const builder = createSilo({
    clusterId: SILO_CLUSTER_ID,
    local: new SiloAddress(SILO_NAME, `uid-${SILO_NAME}`, `${SILO_NAME}:11111`),
  });
  const services = configureSiloHost(builder, configuration);
  return { host: builder.build(), services };
}

/** The dev cluster this host joins - `UseLocalhostClustering`'s fixed identity. */
export const SILO_CLUSTER_ID = "spiceport";

/** This silo's name/address stem within that cluster. */
export const SILO_NAME = "spiceport-silo";

/**
 * `host.Run()`: start the silo and block until shutdown. SIGINT/SIGTERM drain it gracefully, which
 * is what the C# generic host's console lifetime does.
 *
 * NEVER call this from a test or from CI.
 */
export async function main(): Promise<void> {
  const { host } = createSiloHost();
  await host.start();

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void host.stop().then(resolve, resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

// The C#'s top-level statements run on load; this guard keeps an IMPORT inert (port decision 1).
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
