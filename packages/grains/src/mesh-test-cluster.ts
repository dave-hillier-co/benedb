import type { IDatastore } from "@benedb/datastore/i-datastore";
import { createClient, type ClientNode } from "@thresh/client/client-node";
import type { Duration } from "@thresh/core/duration";
import type { GrainStorage } from "@thresh/core/grain-storage";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { InProcessTransport } from "@thresh/messaging/in-process-transport";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { TestCluster } from "@thresh/testing/test-cluster";

import { GrainBackedDatastore } from "./grain-backed-datastore";
import type { DispatchMetricsSnapshot } from "./i-dispatch-metrics";
import { addDispatchMetricsSnapshots, createDispatchMetricsSnapshot } from "./i-dispatch-metrics";
import type { IPermissionChecker } from "./i-permission-checker";
import type { IRelationshipsGrain } from "./i-relationships-grain";
import {
  IRelationshipsGrain as IRelationshipsGrainDef,
  RELATIONSHIPS_GRAIN_KEY,
} from "./i-relationships-grain";
import type { ISchemaProvider } from "./i-schema-provider";
import type { SequencerMetricsSnapshot } from "./i-sequencer-metrics";
import {
  addSequencerMetricsSnapshots,
  createSequencerMetricsSnapshot,
} from "./i-sequencer-metrics";
import type { RelationshipReads } from "./relationship-reads";
import type { WriteSchemaReply } from "./relationships-dtos";
import type { ReverseOps } from "./reverse-ops";
import type { SpiceportGrainServices } from "./service-collection-extensions";
import {
  addSpiceportGrainServices,
  SPICEPORT_GRAIN_REGISTRATIONS,
} from "./service-collection-extensions";
import {
  addActivationMemoCollectionAge,
  addGraphLocalityPlacement,
} from "./silo-builder-extensions";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/MeshTestCluster.cs`.
 *
 * LEDGER DEVIATION: the ledger row targets `mesh-test-cluster.test.ts`. This file is the HARNESS
 * and declares no cases, and a `*.test.ts` with no suite fails a vitest run outright, so it lands
 * as `mesh-test-cluster.ts` and the ledger row is amended - the same deviation
 * `mesh-cluster-collection.ts` already took.
 *
 * Stands up a Thresh {@link TestCluster} configured EXACTLY like the production silo: the grain DI
 * mesh from {@link addSpiceportGrainServices} plus a {@link GrainBackedDatastore} delegating to the
 * cluster-singleton datastore grain. Checks therefore run THROUGH the real grain mesh - every
 * sub-problem is a grain call, there is no in-process local-recurse shortcut and no caller-side
 * branch cache; the one cache is each `CheckGrain` activation's own reply memo. Engine graph reads
 * are always served by the `IGraphShardGrain` mesh.
 *
 * One cluster is built per schema, because each conformance file declares its own and the silo
 * compiles the schema at startup. Every silo's `IDatastore` delegates to the ONE cluster-singleton
 * datastore grain, so all silos read exactly the data the checker pins a revision against, with
 * zero replica lag and no process-static shared instance.
 *
 * PORT DECISIONS (the C# does not transliterate; each of these is a judgement, recorded here so a
 * reader finds the reasoning at the site rather than in a changelog):
 *
 *  1. THE PROCESS-WIDE STATIC HANDOFF IS GONE. The C# `SchemaHolder` carried the schema text and
 *     nine flags into an `ISiloConfigurator` that Orleans instantiated itself, and was only safe
 *     because `MeshClusterCollection` serialised every cluster-using class. Its own comment flags
 *     the trap: `SchemaHolder.GcWindow = null` had to be reset EXPLICITLY in `CreateMultiSiloAsync`
 *     because statics persist across tests, so every field must be assigned on every Create path or
 *     a previous test's value leaks in. Thresh's `configureSilo` is a CLOSURE, so the whole
 *     configuration is carried by the builder instead - which deletes the hazard rather than paying
 *     for it, and removes the reason `MeshClusterCollection` existed (see that file for the vitest
 *     isolation decision this leans on).
 *  2. THE SILO CONFIGURATION ORDER IS PRESERVED EXACTLY, because the order is a contract:
 *     `addActivationMemoCollectionAge` -> the `datastore` storage registration -> the
 *     custom-storage/journaling binding -> `addGraphLocalityPlacement(options)` ->
 *     `addSpiceportGrainServices` with the datastore/options overrides. The placement opt-in runs
 *     BEFORE the grain services precisely to pin the TryAdd contract that keeps an early explicit
 *     opt-in from being silently reverted. Deviating from production wiring here would mean the
 *     mesh suites grade a configuration nobody ships.
 *  3. `AddDatastoreGrainStorage(new ConfigurationBuilder().Build())` is the S5 production
 *     registration taking its in-memory branch with the BINARY grain-storage serializer forced
 *     (the provider's JSON default silently corrupts boxed-JsonElement caveat context). S5 is not
 *     pulled forward: a Thresh {@link MemoryGrainStorage} is registered under the provider name
 *     `datastore` here. The serializer-forcing has no direct TypeScript analogue beyond "the
 *     persisted-state codec must round-trip `Uint8Array` and JSON caveat context" - the value-codec
 *     bug this port already found and fixed in Thresh. ONE storage instance is shared by every
 *     silo, because the singleton datastore grain's state must survive its activation moving.
 *  4. `AddCustomStorageBasedLogConsistencyProvider("CustomStorage")` has no counterpart: Thresh's
 *     journaling binder DETECTS a custom-storage host and installs the adaptor, so what the C#
 *     named a provider is the grain's own shape here. `TestCluster` already calls
 *     `useMemoryJournaling`, which is what makes the binder run.
 *  5. `((InProcessSiloHandle)_cluster.Primary!).SiloHost.Services` becomes {@link servicesForSilo}
 *     over the per-silo records this harness keeps. A primary-only accessor is NOT sufficient -
 *     several suites (ColdStartTests' cold-path gate among them) resolve services from a
 *     NON-primary silo - so {@link allSiloServices} is part of the surface, not a convenience.
 *  6. `initialSilosCount: (short)siloCount` - the cast is irrelevant in TypeScript, but the small-N
 *     intent it encodes is not, and {@link createMultiSilo} keeps the C#'s `siloCount >= 1` guard.
 *  7. `useRandomPlacement` overrides the cluster's DEFAULT placement strategy, and is needed ONLY
 *     by tests whose ASSERTION is that activations spread across silos. THRESH GAP: Thresh has no
 *     silo-wide default-strategy override - `placement` is per grain class in `@grain()` metadata,
 *     and the runtime default is already a spread-making pick rather than Orleans 10's
 *     load-statistics `ResourceOptimizedPlacement`. The flag is therefore accepted and recorded but
 *     changes nothing today; the four graph grain families are unaffected either way, since their
 *     class-specific director IS a uniform random pick whenever co-location is off.
 *  8. `gcWindow` ALWAYS sets `reminderEnabled: false` alongside the window, so `runGc` only ever
 *     runs when a test invokes it directly. A GC reminder must never fire on its own in a test
 *     cluster.
 *  9. `DisposeAsync` -> {@link dispose}. TypeScript has no `await using` here, so EVERY suite needs
 *     an explicit `try { ... } finally { await cluster.dispose(); }`. A leaked cluster is the
 *     orphaned-host hazard in miniature - and nothing in this file, or any suite using it, may ever
 *     boot a real silo host.
 */
export interface MeshTestClusterOptions {
  /**
   * The bounded fan-out width for `IPermissionChecker.batchCheck`; pass 1 to serialize the fan-out
   * so shared-branch cache behaviour is deterministic (no concurrent-miss races).
   */
  readonly batchConcurrency?: number | undefined;
  /** Leopard membership-walk accelerator toggle. */
  readonly useMembershipWalk?: boolean | undefined;
  /** `CheckGrain`'s per-activation reply memo toggle. */
  readonly useActivationMemo?: boolean | undefined;
  /** `SubjectFrontierGrain`'s per-activation frontier memo toggle. */
  readonly useSubjectFrontierMemo?: boolean | undefined;
  /** Overrides the frontier memo's subject cap. */
  readonly subjectFrontierMaxMemoSubjects?: number | undefined;
  /**
   * When set, overrides the datastore GC window for the cluster (with the GC reminder DISABLED, so
   * `runGc` only runs when a test invokes it). A test needing a GC floor near head (zero, where the
   * floor becomes `min(head, now) == head`) opts in here; absent keeps the 24h production default.
   */
  readonly gcWindow?: Duration | undefined;
  /**
   * Steers the graph grain families' FIRST activations onto their object's shard silo (a pure
   * locality hint; identity and dedup stay with the grain directory).
   */
  readonly coLocateWithShards?: boolean | undefined;
  /**
   * Overrides `GrainBackedDatastore`'s revision-quantization window. Absent keeps the production
   * default (5s) - exactly what the constructor defaults to when nothing is passed.
   */
  readonly quantization?: Duration | undefined;
  /** See port decision 7: accepted, recorded, and inert on Thresh. */
  readonly useRandomPlacement?: boolean | undefined;
}

/** One silo's wiring: the services record plus the `IDatastore` the host owns for that silo. */
interface SiloWiring {
  readonly services: SpiceportGrainServices;
  readonly datastore: () => IDatastore;
}

export class MeshTestCluster {
  readonly #cluster: TestCluster;
  readonly #wirings: readonly SiloWiring[];
  readonly #client: ClientNode;
  readonly #datastoreStorage: GrainStorage;

  private constructor(
    cluster: TestCluster,
    wirings: readonly SiloWiring[],
    client: ClientNode,
    datastoreStorage: GrainStorage,
  ) {
    this.#cluster = cluster;
    this.#wirings = wirings;
    this.#client = client;
    this.#datastoreStorage = datastoreStorage;
  }

  /**
   * The `datastore` grain-storage provider every silo shares - the C#'s
   * `cluster.Services.GetRequiredKeyedService<IGrainStorage>("datastore")`.
   *
   * PORT DECISION 10. Thresh has no keyed DI, so there is nothing to resolve the provider back out
   * of: the harness constructs the ONE `MemoryGrainStorage` (port decision 3) and hands it to the
   * silos through `SpiceportGrainServicesOptions.datastoreStorage`. `ThinSequencerTests` reads the
   * sequencer's RAW storage rows (`head`, `meta/{version}`, `log/{version}`,
   * `shard/{flushVersion}/{dir}/{type}/{id}`, `indexb/...`, `indexd/...`) to prove the flush
   * protocol ran, and plants an orphan log row through it, so the handle has to be reachable. It is
   * exposed rather than faked: a test-owned duplicate store would grade rows nothing wrote.
   */
  get datastoreStorage(): GrainStorage {
    return this.#datastoreStorage;
  }

  get cluster(): TestCluster {
    return this.#cluster;
  }

  /** The number of silos in this cluster. */
  get siloCount(): number {
    return this.#cluster.silos.length;
  }

  /** The PRIMARY silo's services (the C#'s `Services`). */
  get services(): SpiceportGrainServices {
    return this.servicesForSilo(0);
  }

  /** Every silo's services, primary first (the C#'s `AllSiloServices`). */
  get allSiloServices(): readonly SpiceportGrainServices[] {
    return this.#wirings.map((w) => w.services);
  }

  /** The services of one silo by index - see port decision 5. */
  servicesForSilo(index: number): SpiceportGrainServices {
    const wiring = this.#wirings[index];
    if (wiring === undefined) throw new Error(`no silo at index ${index}`);
    return wiring.services;
  }

  /** The grain-backed datastore of the primary silo (delegating to the singleton datastore grain). */
  get datastore(): IDatastore {
    return this.datastoreForSilo(0);
  }

  /** The grain-backed datastore of one silo by index. */
  datastoreForSilo(index: number): IDatastore {
    const wiring = this.#wirings[index];
    if (wiring === undefined) throw new Error(`no silo at index ${index}`);
    return wiring.datastore();
  }

  /** The top-level permission checker (root dispatcher over the grain mesh). */
  get checker(): IPermissionChecker {
    return this.services.checker;
  }

  /**
   * The cluster grain factory, for resolving grains in tests: the C#'s `_cluster.GrainFactory`,
   * which is the TestCluster CLIENT's factory, NOT a silo's.
   *
   * THE DISTINCTION IS LOAD-BEARING, not a detail of which handle was closest. Orleans resolves
   * every outgoing grain-call filter from the container that issues the call, so
   * `AddSpiceportGrainServices`' `CheckDispatchOutgoingCallFilter` wraps calls made BY THE MESH
   * (the dispatcher's own hops) and never a call made by the test's client - which is exactly what
   * `CancellationAndImmutabilityTests` pins: the dispatcher's cancelled hop arrives as a
   * `DispatchFailedException`, while the same cancellation on a direct client call arrives raw.
   * Handing back the primary silo's {@link GrainFactoryAccess} here would put the mesh's own
   * error-classification filter in front of a caller the C# leaves untouched, and the two cases
   * would collapse into one.
   *
   * So this is a real Thresh {@link ClientNode}, joined to the cluster through the primary silo as
   * its gateway, registered with the same grain list the silos host ({@link
   * SPICEPORT_GRAIN_REGISTRATIONS}) so it can address them. It carries a working
   * `createObjectReference` / `deleteObjectReference` - the observer seam a watch suite needs to
   * mint a reference and hand it to `DatastoreGrain.subscribeWatch` - and its calls really do
   * serialize, so a test driving the mesh through it exercises the wire the way a `zed` client
   * would.
   */
  get grainFactory(): GrainFactoryAccess {
    return this.#client;
  }

  /**
   * The reverse-ops in-process read helper, resolved from the PRIMARY silo - the same instance the
   * silo's gRPC services would resolve, so tests exercise it exactly as production wiring does
   * (still dispatching onward to the frontier / membership-walk / check mesh across silos).
   */
  get reverseOps(): ReverseOps {
    return this.services.reverseOps;
  }

  /** The relationship-read in-process helper, resolved from the primary silo. */
  get relationshipReads(): RelationshipReads {
    return this.services.relationshipReads;
  }

  /** The live, mutable schema provider (for asserting the current snapshot after a swap). */
  get schemaProvider(): ISchemaProvider {
    return this.services.schemaProvider;
  }

  /** The data-plane grain, resolved by its constant key (it is a stateless worker: no identity). */
  get relationships(): IRelationshipsGrain {
    return this.#cluster.primary.host.getGrain(IRelationshipsGrainDef, RELATIONSHIPS_GRAIN_KEY);
  }

  /** Compiles and installs a new schema on the running cluster, exercising the dynamic path. */
  writeSchema(schemaText: string): Promise<WriteSchemaReply> {
    return this.relationships.writeSchema({ schemaText });
  }

  /** Resets the hop/cache counters on EVERY silo (to bracket one workload). */
  resetMetrics(): void {
    for (const wiring of this.#wirings) wiring.services.dispatchMetrics.reset();
  }

  /** The cluster-wide sum of every silo's dispatch counters. */
  metricsSnapshot(): DispatchMetricsSnapshot {
    let total = createDispatchMetricsSnapshot(0);
    for (const wiring of this.#wirings) {
      total = addDispatchMetricsSnapshots(total, wiring.services.dispatchMetrics.snapshot());
    }
    return total;
  }

  /**
   * The cluster-wide sum of every silo's sequencer counters. Only the silo hosting the single
   * `DatastoreGrain` activation is ever nonzero, so the sum IS that silo's view - which is exactly
   * what makes summing the right aggregation rather than a convenience.
   */
  sequencerMetricsSnapshot(): SequencerMetricsSnapshot {
    let total = createSequencerMetricsSnapshot(0);
    for (const wiring of this.#wirings) {
      total = addSequencerMetricsSnapshots(total, wiring.services.sequencerMetrics.snapshot());
    }
    return total;
  }

  /** Builds and starts a SINGLE-silo cluster for the given schema DSL text. */
  static create(
    schemaText: string,
    options: MeshTestClusterOptions = {},
  ): Promise<MeshTestCluster> {
    return MeshTestCluster.#start(schemaText, 1, options);
  }

  /**
   * Builds and starts a MULTI-SILO cluster (`siloCount` silos, default 3). `CheckGrain` activates
   * under the cluster's default placement; every sub-problem is still a real grain call, so
   * recursion genuinely crosses silo boundaries as the directory places activations. All silos
   * delegate to the ONE cluster-singleton datastore grain, so a grain on any silo reads the same
   * data the checker pinned a revision against.
   */
  static createMultiSilo(
    schemaText: string,
    siloCount = 3,
    options: MeshTestClusterOptions = {},
  ): Promise<MeshTestCluster> {
    if (siloCount < 1) throw new Error("Need at least one silo.");
    return MeshTestCluster.#start(schemaText, siloCount, options);
  }

  static async #start(
    schemaText: string,
    siloCount: number,
    options: MeshTestClusterOptions,
  ): Promise<MeshTestCluster> {
    // ONE storage instance shared by every silo: the singleton datastore grain's state must survive
    // its activation moving between them (port decision 3).
    const storage = new MemoryGrainStorage();
    const wirings: SiloWiring[] = [];

    const cluster = await TestCluster.start({
      initialSilos: siloCount,
      configureSilo: (builder) => {
        // THE ORDER BELOW IS THE PRODUCTION SILO'S, EXACTLY - see port decision 2.
        addActivationMemoCollectionAge(builder);
        builder.addStorage("datastore", storage);
        addGraphLocalityPlacement(builder, {
          coLocateWithShards: options.coLocateWithShards ?? false,
        });

        let datastore: IDatastore | undefined;
        const services = addSpiceportGrainServices(builder, {
          schemaText,
          ...(options.batchConcurrency !== undefined
            ? { batchConcurrency: options.batchConcurrency }
            : {}),
          datastoreStorage: storage,
          // The `IDatastore` the host owns, resolved lazily (and once) after wiring completes -
          // exactly the C#'s `services.AddSingleton<IDatastore>(sp => new GrainBackedDatastore(...))`
          // over the DI-singleton watch hub the grain services registered.
          datastore: () =>
            (datastore ??= new GrainBackedDatastore(
              services.grainFactory,
              services.hub,
              options.quantization,
            )),
          membershipWalkOptions: { enabled: options.useMembershipWalk ?? true },
          activationMemoOptions: { enabled: options.useActivationMemo ?? true },
          subjectFrontierMemoOptions: {
            enabled: options.useSubjectFrontierMemo ?? true,
            ...(options.subjectFrontierMaxMemoSubjects !== undefined
              ? { maxMemoSubjects: options.subjectFrontierMaxMemoSubjects }
              : {}),
          },
          // Port decision 8: an overridden window ALWAYS disables the reminder.
          ...(options.gcWindow !== undefined
            ? { datastoreGcOptions: { window: options.gcWindow, reminderEnabled: false } }
            : {}),
        });

        wirings.push({ services, datastore: () => services.datastore });
      },
    });

    // The cluster client (the C#'s `TestCluster.GrainFactory`) - see `grainFactory` for why the
    // test's calls must NOT be issued from a silo container.
    const client = createClient({
      clusterId: cluster.clusterId,
      transport: new InProcessTransport(cluster.network, cluster.clusterId),
      gateway: cluster.primary.address,
    }).registerGrains(SPICEPORT_GRAIN_REGISTRATIONS);
    await client.connect();

    return new MeshTestCluster(cluster, wirings, client, storage);
  }

  /**
   * Disposes the cluster. Every suite must call this in a `finally` - see port decision 9.
   */
  async dispose(): Promise<void> {
    await this.#client.close();
    await this.#cluster.dispose();
  }
}
