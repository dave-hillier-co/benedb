import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import type { IDispatcher } from "@spacedb/engine/i-dispatcher";
import type { ISchemaHashSource } from "@spacedb/engine/i-schema-hash-source";
import type { Duration } from "@thresh/core/duration";
import type { Grain } from "@thresh/core/grain";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainStorage } from "@thresh/core/grain-storage";
import type { Logger } from "@thresh/core/logger";
import type { GrainFactoryAccess, SiloBuilder } from "@thresh/hosting/silo-builder";

import type { ActivationMemoOptions } from "./activation-memo-options";
import { CheckGrain } from "./check-grain";
import {
  createCheckDispatchIncomingCallFilter,
  createCheckDispatchOutgoingCallFilter,
} from "./check-dispatch-filters";
import type { DatastoreGcOptions } from "./datastore-gc-options";
import { DatastoreGrain } from "./datastore-grain";
import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import { GraphLocalityPlacementDirector } from "./graph-locality-placement-director";
import type { GraphPlacementOptions } from "./graph-placement-options";
import { GraphShardGrain } from "./graph-shard-grain";
import { ICheckGrain } from "./i-check-grain";
import { IDatastoreGrain, DATASTORE_GRAIN_KEY } from "./i-datastore-grain";
import type { IDispatchMetrics } from "./i-dispatch-metrics";
import { DispatchMetrics } from "./i-dispatch-metrics";
import type { IGraphReaderSource } from "./i-graph-reader-source";
import { ShardedGraphReaderSource } from "./i-graph-reader-source";
import { IGraphShardGrain } from "./i-graph-shard-grain";
import { IMembershipWalkGrain } from "./i-membership-walk-grain";
import type { IPermissionChecker } from "./i-permission-checker";
import { PermissionChecker } from "./i-permission-checker";
import { IRelationshipsGrain } from "./i-relationships-grain";
import type { ISchemaProvider } from "./i-schema-provider";
import { MutableSchemaProvider } from "./i-schema-provider";

import type { ISchemaSource } from "./i-schema-source";
import { GrainSchemaSource } from "./i-schema-source";
import type { ISequencerMetrics } from "./i-sequencer-metrics";
import { SequencerMetrics } from "./i-sequencer-metrics";
import type { ISnapshotScanner } from "./i-snapshot-scanner";
import { GrainSnapshotScanner } from "./i-snapshot-scanner";
import { ISubjectFrontierGrain } from "./i-subject-frontier-grain";
import { LogWatchHub } from "./log-watch-hub";
import { MembershipWalkGrain } from "./membership-walk-grain";
import type { MembershipWalkOptions } from "./membership-walk-options";
import { OrleansDispatcher } from "./orleans-dispatcher";
import { RelationshipReads } from "./relationship-reads";
import { RelationshipsGrain } from "./relationships-grain";
import { ReverseOps } from "./reverse-ops";
import { SchemaResolver } from "./schema-resolver";
import { SequencerAdmission } from "./sequencer-admission";
import type { SequencerAdmissionOptions } from "./sequencer-admission-options";
import { applyMemoCollectionAges, graphPlacementOptionsFor } from "./silo-builder-extensions";
import { SubjectFrontierGrain } from "./subject-frontier-grain";
import type { SubjectFrontierMemoOptions } from "./subject-frontier-memo-options";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/ServiceCollectionExtensions.cs`.
 *
 * DI registration for the check grain's supporting services and the silo-wide dispatch mesh.
 *
 * THIS FILE DOES NOT TRANSLITERATE. Thresh has no service container at all, so
 * `AddSpiceportGrainServices` becomes {@link addSpiceportGrainServices}: it registers the silo-side
 * things Thresh DOES have (grain classes, the placement strategy, the two grain-call filters, a
 * startup task, the grain activator that hands each grain its dependency bag) and RETURNS the
 * singletons the C# would otherwise have left in the container. The returned
 * {@link SpiceportGrainServices} record IS the container.
 *
 * PORT DECISIONS.
 *
 *  1. `IGrainFactory` is not available at wiring time - Thresh hands one to a STARTUP TASK. So
 *     every service that needs it (the watch hub, the two grain-backed seams, the graph reader
 *     source, the dispatcher, the checker, and the two in-process read helpers) is LAZY, built on
 *     first access after the startup task binds the factory. That is not a workaround: it is
 *     exactly the "lazy factory registrations resolved after the host completes its own DI" the C#
 *     remarks describe, and it is what makes consuming the host-owned `IDatastore` legal.
 *  2. `IDatastore` is DELIBERATELY NOT CONSTRUCTED HERE. The host owns it (it must persist writes)
 *     and this function only CONSUMES it, so it arrives as a thunk that is only ever invoked -
 *     never during wiring. Registering it here would change the ownership model.
 *  3. `TryAddSingleton<GraphPlacementOptions>` is TRY-add, and stays one: a deployment override
 *     (`addGraphLocalityPlacement`) may legitimately run BEFORE this function, and an
 *     unconditional overwrite would supersede it under last-wins, silently reverting co-location
 *     with no error. `MeshTestCluster`'s configurators call the opt-in FIRST precisely to pin that
 *     ordering contract. The DIRECTOR itself is registered unconditionally, because the strategy
 *     name is unconditional in the four graph grain classes' `@grain()` metadata and the on/off
 *     decision lives in the options.
 *  4. `AddHostedService<LogWatchHubStarter>` becomes a STARTUP TASK, which is where Thresh hands
 *     over the `GrainFactoryAccess` that also exposes `createObjectReference` - exactly what
 *     `LogWatchHub.ensureStarted` needs. The hub starts UNCONDITIONALLY at silo boot, never lazily
 *     on the first Watch call: the same hub now carries cross-silo SCHEMA propagation, so a silo
 *     nobody watches must still receive schema pushes or its `ISchemaProvider` diverges forever.
 *  5. The three memo options types default ON and are overridden by an explicit value (the C#'s
 *     last-registration-wins), which is what `MeshTestCluster`'s three flags ride on.
 *  6. Orleans resolved both grain-call filters from the SAME container the silo runtime uses; here
 *     the equivalent is that both land on the SAME silo builder, so a co-hosted host and a
 *     `TestCluster` silo are wired identically with nothing host-specific left over.
 */
export interface SpiceportGrainServicesOptions {
  /** The schema DSL text to seed the provider with at startup. Compiled (and so VALIDATED) here. */
  readonly schemaText: string;
  /** The check engine's maximum recursion depth; absent keeps `PermissionChecker`'s default. */
  readonly maxDepth?: number | undefined;
  /** The bounded fan-out width for `IPermissionChecker.batchCheck`; absent keeps the default. */
  readonly batchConcurrency?: number | undefined;
  /**
   * The HOST-OWNED datastore, as a thunk resolved after the host completes its own wiring. Never
   * invoked during registration - see port decision 2.
   */
  readonly datastore: () => IDatastore;
  /** The grain-storage provider the singleton `DatastoreGrain` persists its log through. */
  readonly datastoreStorage?: GrainStorage | undefined;
  /** The datastore grain's MVCC-GC options (window, reminder enablement). */
  readonly datastoreGcOptions?: DatastoreGcOptions | undefined;
  /** The graph co-placement toggle. TRY-added: an earlier explicit opt-in wins. */
  readonly graphPlacementOptions?: GraphPlacementOptions | undefined;
  /** The per-silo sequencer write admission gate's bound. */
  readonly sequencerAdmissionOptions?: SequencerAdmissionOptions | undefined;
  /** Leopard membership-walk accelerator toggle (default ON). */
  readonly membershipWalkOptions?: MembershipWalkOptions | undefined;
  /** `CheckGrain`'s per-activation reply memo toggle (default ON). */
  readonly activationMemoOptions?: ActivationMemoOptions | undefined;
  /** `SubjectFrontierGrain`'s per-activation frontier memo toggle (default ON). */
  readonly subjectFrontierMemoOptions?: SubjectFrontierMemoOptions | undefined;
  /** The silo's idle-collection quantum, for the memo collection-age clamp. */
  readonly collectionQuantum?: Duration | undefined;
  /** Optional logger, handed to the watch hub. */
  readonly logger?: Logger | undefined;
}

/** The singletons the C# left in the container. See {@link addSpiceportGrainServices}. */
export interface SpiceportGrainServices {
  /** The live, mutable schema provider - ONE instance, also serving {@link schemaHashSource}. */
  readonly schemaProvider: ISchemaProvider;
  /** The same instance as {@link schemaProvider}, read per request by the dispatch mesh. */
  readonly schemaHashSource: ISchemaHashSource;
  /** The per-silo compile-and-cache of the schema NAMED by each dispatch, seeded with the seed schema. */
  readonly schemaResolver: SchemaResolver;
  /** The silo-wide loop-bypass / activation-memo / dispatch counters. */
  readonly dispatchMetrics: IDispatchMetrics;
  /** The sequencer-side inbound-call counters. */
  readonly sequencerMetrics: ISequencerMetrics;
  /** The per-silo sequencer write admission gate. */
  readonly admission: SequencerAdmission;
  /** The EFFECTIVE graph placement options after the TryAdd. */
  readonly graphPlacementOptions: GraphPlacementOptions;
  /** The effective membership-walk options. */
  readonly membershipWalkOptions: MembershipWalkOptions;
  /** The effective activation-memo options. */
  readonly activationMemoOptions: ActivationMemoOptions;
  /** The effective subject-frontier memo options. */
  readonly subjectFrontierMemoOptions: SubjectFrontierMemoOptions;
  /** The grain factory the startup task bound. Throws before the silo has started. */
  readonly grainFactory: GrainFactoryAccess;
  /** The host-owned datastore, resolved through the caller's thunk. */
  readonly datastore: IDatastore;
  /** The schema-at-revision seam over the cluster-singleton sequencer. */
  readonly schemaSource: ISchemaSource;
  /** The broad/admin scan seam over the cluster-singleton sequencer. */
  readonly snapshotScanner: ISnapshotScanner;
  /** The engines' graph-read seam: always the `IGraphShardGrain` mesh. */
  readonly graphReaderSource: IGraphReaderSource;
  /** This silo's Watch notifier and cross-silo schema propagation channel. */
  readonly hub: LogWatchHub;
  /** The single silo-wide dispatch root. */
  readonly dispatcher: IDispatcher;
  /** The top-level entry point used by the API. */
  readonly checker: IPermissionChecker;
  /** The reverse-ops in-process read helper. */
  readonly reverseOps: ReverseOps;
  /** The relationship-read in-process helper. */
  readonly relationshipReads: RelationshipReads;
}

/**
 * Registers the dynamic schema provider and the silo-wide dispatch mesh (the grain-call dispatcher)
 * that the check grain and the API entry point depend on, and returns the resulting singletons.
 */

/**
 * Every grain class this library hosts, with the interfaces that address it. Exported because the
 * SAME list is what a cluster CLIENT must be told about to address these grains: a client hosts no
 * activations, but `getGrain` still has to map an erased TypeScript interface onto a grain type.
 */
export const SPICEPORT_GRAIN_REGISTRATIONS: readonly {
  readonly ctor: new () => Grain;
  readonly interfaces: GrainInterface<unknown>[];
}[] = [
  { ctor: DatastoreGrain as unknown as new () => Grain, interfaces: [IDatastoreGrain] },
  { ctor: RelationshipsGrain as unknown as new () => Grain, interfaces: [IRelationshipsGrain] },
  { ctor: CheckGrain as unknown as new () => Grain, interfaces: [ICheckGrain] },
  { ctor: GraphShardGrain as unknown as new () => Grain, interfaces: [IGraphShardGrain] },
  { ctor: MembershipWalkGrain as unknown as new () => Grain, interfaces: [IMembershipWalkGrain] },
  {
    ctor: SubjectFrontierGrain as unknown as new () => Grain,
    interfaces: [ISubjectFrontierGrain],
  },
];

export function addSpiceportGrainServices(
  builder: SiloBuilder,
  options: SpiceportGrainServicesOptions,
): SpiceportGrainServices {
  // `ArgumentNullException.ThrowIfNull(services); ArgumentNullException.ThrowIfNull(schemaText);`
  if (builder === undefined || builder === null) {
    throw new InvalidArgumentError("builder is required");
  }
  if (options === undefined || options === null) {
    throw new InvalidArgumentError("options is required");
  }
  if (options.schemaText === undefined || options.schemaText === null) {
    throw new InvalidArgumentError("schemaText is required");
  }

  // The mutable, versioned schema provider. It is the single source of truth for evaluation and the
  // live schema hash; CONSTRUCTING IT VALIDATES the seed schema (a compile).
  const provider = new MutableSchemaProvider(options.schemaText);

  // Per-silo compile-and-cache of the schema NAMED by each dispatch (its hash). Seeded with the
  // embedded startup schema so the seed window (no writeSchema persisted yet) resolves from the
  // cache instead of paying a per-dispatch sequencer readSchemaAt hop.
  const schemaResolver = new SchemaResolver();
  schemaResolver.seed(provider.current);

  const dispatchMetrics = new DispatchMetrics();
  const sequencerMetrics = new SequencerMetrics();
  const admission = new SequencerAdmission(
    options.sequencerAdmissionOptions ?? {},
    sequencerMetrics,
  );

  // Port decision 3: TRY-add. An EARLIER explicit `addGraphLocalityPlacement` on this builder wins
  // over both the argument and the default.
  const graphPlacementOptions =
    graphPlacementOptionsFor(builder) ?? options.graphPlacementOptions ?? {};

  const membershipWalkOptions = options.membershipWalkOptions ?? {};
  const activationMemoOptions = options.activationMemoOptions ?? {};
  const subjectFrontierMemoOptions = options.subjectFrontierMemoOptions ?? {};

  // The three memo options types are what the (possibly earlier) `addActivationMemoCollectionAge`
  // was armed to apply; this is the point at which they are finally known.
  applyMemoCollectionAges(builder, {
    activationMemo: activationMemoOptions,
    subjectFrontierMemo: subjectFrontierMemoOptions,
    membershipWalk: membershipWalkOptions,
    ...(options.collectionQuantum !== undefined
      ? { collectionQuantum: options.collectionQuantum }
      : {}),
  });

  // --- the lazily-resolved half (port decision 1) ---

  let grainFactory: GrainFactoryAccess | undefined;
  const requireGrainFactory = (): GrainFactoryAccess => {
    if (grainFactory === undefined) {
      throw new InvalidArgumentError(
        "the grain factory is bound by this silo's startup task; resolve this service after the silo has started",
      );
    }
    return grainFactory;
  };

  const once = <T>(build: () => T): (() => T) => {
    let value: T | undefined;
    let built = false;
    return () => {
      if (!built) {
        value = build();
        built = true;
      }
      return value as T;
    };
  };

  const datastore = once(() => options.datastore());
  const schemaSource = once(() => new GrainSchemaSource(requireGrainFactory()));
  const snapshotScanner = once(() => new GrainSnapshotScanner(requireGrainFactory()));
  const graphReaderSource = once(() => new ShardedGraphReaderSource(requireGrainFactory()));

  // The per-silo Watch notifier. Also the cross-silo SCHEMA propagation channel: `applySchema`
  // swaps THIS silo's provider whenever the hub receives a pushed or heartbeat-repaired schema
  // change - a writeSchema on any other silo would otherwise leave this one's live schema stale
  // forever.
  const hub = once(() => {
    const factory = requireGrainFactory();
    return new LogWatchHub(
      factory.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY),
      factory,
      undefined,
      (text) => {
        provider.update(text);
      },
      options.logger,
    );
  });

  // The dispatcher turns each sub-problem into a grain call. This SINGLE instance is the silo-wide
  // root: the API enters through it AND each grain routes its child sub-problems back through it,
  // so ALL recursion crosses grain boundaries.
  const dispatcher = once(
    () => new OrleansDispatcher(requireGrainFactory(), provider, dispatchMetrics),
  );

  const checker = once(
    () =>
      new PermissionChecker(
        datastore(),
        schemaSource(),
        dispatcher(),
        provider,
        schemaResolver,
        options.maxDepth,
        options.batchConcurrency,
      ),
  );

  const reverseOps = once(
    () =>
      new ReverseOps(
        datastore(),
        schemaSource(),
        provider,
        schemaResolver,
        requireGrainFactory(),
        membershipWalkOptions,
        graphReaderSource(),
        subjectFrontierMemoOptions,
      ),
  );

  const relationshipReads = once(
    () => new RelationshipReads(datastore(), provider, snapshotScanner()),
  );

  // --- the silo-side registrations ---

  // The graph co-placement director. The strategy name is UNCONDITIONAL in the four graph grain
  // classes' metadata, so the director must exist wherever those grains can activate; the on/off
  // decision lives in the options it is constructed with.
  builder.addPlacementStrategy(
    GRAPH_LOCALITY_PLACEMENT_STRATEGY,
    new GraphLocalityPlacementDirector(graphPlacementOptions),
  );

  // Both filters match ONLY `ICheckGrain.dispatchCheck`; every other grain call passes untouched.
  builder.addOutgoingCallFilter(createCheckDispatchOutgoingCallFilter());
  builder.addIncomingCallFilter(createCheckDispatchIncomingCallFilter(dispatchMetrics));

  builder.registerGrains([...SPICEPORT_GRAIN_REGISTRATIONS]);

  // Thresh has no constructor DI: the activator is the seam that hands each grain its bag. Every
  // other grain type on the silo (the management grain among them) falls through to `new ctor()`.
  builder.useGrainActivator({
    createInstance: (ctor: new () => Grain): Grain => {
      switch (ctor as unknown) {
        case DatastoreGrain:
          return new DatastoreGrain({
            ...(options.datastoreStorage !== undefined
              ? { storage: options.datastoreStorage }
              : {}),
            ...(options.datastoreGcOptions !== undefined
              ? { gcOptions: options.datastoreGcOptions }
              : {}),
            metrics: sequencerMetrics,
            ...(options.logger !== undefined ? { logger: options.logger } : {}),
          }) as unknown as Grain;
        case RelationshipsGrain:
          return new RelationshipsGrain({
            datastore: datastore(),
            schemaProvider: provider,
            schemaSource: schemaSource(),
            scanner: snapshotScanner(),
            hub: hub(),
            admission,
          }) as unknown as Grain;
        case CheckGrain:
          return new CheckGrain({
            schemaSource: schemaSource(),
            schemaProvider: provider,
            schemaResolver,
            onward: dispatcher(),
            readerSource: graphReaderSource(),
            memoOptions: activationMemoOptions,
            metrics: dispatchMetrics,
          }) as unknown as Grain;
        case MembershipWalkGrain:
          return new MembershipWalkGrain({
            schemaSource: schemaSource(),
            schemaProvider: provider,
            schemaResolver,
            readerSource: graphReaderSource(),
            options: membershipWalkOptions,
          }) as unknown as Grain;
        case SubjectFrontierGrain:
          return new SubjectFrontierGrain({
            schemaSource: schemaSource(),
            schemaProvider: provider,
            schemaResolver,
            readerSource: graphReaderSource(),
            memoOptions: subjectFrontierMemoOptions,
            metrics: dispatchMetrics,
          }) as unknown as Grain;
        default:
          return new ctor();
      }
    },
  });

  // Port decision 4: the hub starts UNCONDITIONALLY at silo boot, and this is also where the grain
  // factory - the one that can mint observer references - becomes available at all.
  builder.addStartupTask((grains) => {
    grainFactory = grains;
    hub().ensureStarted();
    return Promise.resolve();
  });

  return {
    schemaProvider: provider,
    schemaHashSource: provider,
    schemaResolver,
    dispatchMetrics,
    sequencerMetrics,
    admission,
    graphPlacementOptions,
    membershipWalkOptions,
    activationMemoOptions,
    subjectFrontierMemoOptions,
    get grainFactory(): GrainFactoryAccess {
      return requireGrainFactory();
    },
    get datastore(): IDatastore {
      return datastore();
    },
    get schemaSource(): ISchemaSource {
      return schemaSource();
    },
    get snapshotScanner(): ISnapshotScanner {
      return snapshotScanner();
    },
    get graphReaderSource(): IGraphReaderSource {
      return graphReaderSource();
    },
    get hub(): LogWatchHub {
      return hub();
    },
    get dispatcher(): IDispatcher {
      return dispatcher();
    },
    get checker(): IPermissionChecker {
      return checker();
    },
    get reverseOps(): ReverseOps {
      return reverseOps();
    },
    get relationshipReads(): RelationshipReads {
      return relationshipReads();
    },
  };
}
