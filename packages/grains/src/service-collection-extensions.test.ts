import { normalizeRegistration, type GrainRegistration } from "@thresh/core/grain-registration";
import type { GrainKeyKind } from "@thresh/core/grain-key";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { KeyTypeOf } from "@thresh/core/key-kinds";
import { SiloAddress } from "@thresh/core/silo-address";
import {
  createSilo,
  type GrainFactoryAccess,
  type SiloBuilder,
} from "@thresh/hosting/silo-builder";
import { InProcessNetwork } from "@thresh/messaging/in-process-transport";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { StaticMembershipService } from "@thresh/runtime/static-membership";
import { describe, expect, it } from "vitest";

import { CheckGrain } from "./check-grain";
import { DatastoreGrain } from "./datastore-grain";
import { GraphShardGrain } from "./graph-shard-grain";
import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import { GraphLocalityPlacementDirector } from "./graph-locality-placement-director";
import { ICheckGrain } from "./i-check-grain";
import { DispatchMetrics } from "./i-dispatch-metrics";
import { IDatastoreGrain } from "./i-datastore-grain";
import { IGraphShardGrain } from "./i-graph-shard-grain";
import { IMembershipWalkGrain } from "./i-membership-walk-grain";
import { PermissionChecker } from "./i-permission-checker";
import { IRelationshipsGrain } from "./i-relationships-grain";
import { GrainSchemaSource } from "./i-schema-source";
import { MutableSchemaProvider } from "./i-schema-provider";
import { SequencerMetrics } from "./i-sequencer-metrics";
import { GrainSnapshotScanner } from "./i-snapshot-scanner";
import { ISubjectFrontierGrain } from "./i-subject-frontier-grain";
import { ShardedGraphReaderSource } from "./i-graph-reader-source";
import { LogWatchHub } from "./log-watch-hub";
import { MembershipWalkGrain } from "./membership-walk-grain";
import { OrleansDispatcher } from "./orleans-dispatcher";
import { RelationshipReads } from "./relationship-reads";
import { RelationshipsGrain } from "./relationships-grain";
import { ReverseOps } from "./reverse-ops";
import { addSpiceportGrainServices } from "./service-collection-extensions";
import { addGraphLocalityPlacement } from "./silo-builder-extensions";
import { computeStoredSchemaHash } from "./stored-schema-hash";
import { SubjectFrontierGrain } from "./subject-frontier-grain";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/ServiceCollectionExtensions.cs`.
 *
 * NO COVERING C# TEST: its only gate in Spiceport is that `MeshTestCluster` stands up and the mesh
 * suites pass. It is DI wiring and does NOT transliterate mechanically - Thresh has no service
 * container at all - so this file characterizes what the registration must still ACHIEVE, which is
 * the part that survives translation.
 *
 * THE SHAPE THE PORT TAKES, and why.
 *
 *  * Thresh has no `IServiceCollection`. `AddSpiceportGrainServices` becomes
 *    `addSpiceportGrainServices(builder, options)`: it registers the silo-side things Thresh DOES
 *    have (grain classes, the placement strategy, the two grain-call filters, a startup task, the
 *    grain activator that hands each grain its dependency bag) and RETURNS the singletons the C#
 *    would otherwise have left in the container. The returned record IS the container.
 *  * `IGrainFactory` is not available at wiring time - Thresh hands one to a STARTUP TASK. So the
 *    services that need it (the watch hub, the two grain-backed seams, the dispatcher, the
 *    checker, the reverse-ops and relationship-read helpers) are LAZY, resolved on first access
 *    after the startup task binds the factory. That is not a workaround: it is precisely the
 *    "lazy factory registrations resolved after the host completes its own DI" the C# remarks
 *    describe, and it is what makes consuming the host-owned `IDatastore` legal.
 *  * `IDatastore` is DELIBERATELY NOT CONSTRUCTED HERE. It is supplied as a thunk the host owns
 *    (it must persist writes) and is only ever invoked. Registering it here would change the
 *    ownership model, so a thunk that THROWS must not break wiring - only using it.
 *
 * The eight properties that must hold however the TypeScript is shaped, each pinned below:
 *
 *  1. ONE `MutableSchemaProvider` serves both the schema provider and the schema-hash source, and
 *     CONSTRUCTING IT VALIDATES the seed schema.
 *  2. The `SchemaResolver` is SEEDED with `provider.current`, so the seed window resolves from
 *     cache instead of paying a per-dispatch sequencer hop.
 *  3. `IDispatchMetrics` and `ISequencerMetrics` singletons exist on EVERY silo (only the silo
 *     hosting the datastore-grain activation ever records, so summing all silos gives cluster
 *     totals - `MeshTestCluster.metricsSnapshot` depends on exactly that).
 *  4. The two check-dispatch call filters are registered on the SAME silo the runtime uses, one
 *     outgoing and one incoming.
 *  5. `GraphPlacementOptions` is TRY-ADDED: an EARLIER explicit `addGraphLocalityPlacement` wins.
 *     The C# comment is emphatic about why - an unconditional add would silently revert a
 *     deployment's co-location choice under last-wins, with no error - and `MeshTestCluster`'s
 *     configurators call the opt-in FIRST precisely to pin this ordering contract.
 *  6. The watch hub is started UNCONDITIONALLY at silo boot, not lazily on the first Watch call:
 *     the same hub now carries cross-silo SCHEMA propagation, so a silo nobody watches must still
 *     receive schema pushes or its provider diverges forever. In Thresh that is a startup task -
 *     which is handed the `GrainFactoryAccess` that also exposes `createObjectReference`, exactly
 *     what starting the hub needs.
 *  7. The hub's `applySchema` swaps THIS silo's provider.
 *  8. The three memo options types default ON and are overridden by an explicit value (the C#'s
 *     last-registration-wins), which is what `MeshTestCluster`'s three flags ride on.
 */

// --- fixtures ---------------------------------------------------------------------------------

const SCHEMA = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

const REPLACEMENT_SCHEMA = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

function newBuilder(): SiloBuilder {
  const address = new SiloAddress("test-silo", "uid-0", "test-silo:11111");
  return createSilo({ clusterId: "wiring-test", serviceId: "wiring-test", local: address })
    .useMembership(new StaticMembershipService(address, [address]))
    .useInProcessTransport(new InProcessNetwork());
}

/** Records the silo-side registrations these gates assert on, delegating each to the real builder. */
interface Spy {
  readonly builder: SiloBuilder;
  readonly strategies: Array<{ name: string; strategy: unknown }>;
  readonly incoming: unknown[];
  readonly outgoing: unknown[];
  readonly grains: Array<{ ctor: unknown; interfaces: readonly unknown[] }>;
  readonly startupTasks: Array<(grains: GrainFactoryAccess) => Promise<void>>;
}

function spyOn(builder: SiloBuilder): Spy {
  const spy: Spy = {
    builder,
    strategies: [],
    incoming: [],
    outgoing: [],
    grains: [],
    startupTasks: [],
  };
  const addPlacementStrategy = builder.addPlacementStrategy.bind(builder);
  builder.addPlacementStrategy = (name, strategy) => {
    spy.strategies.push({ name, strategy });
    return addPlacementStrategy(name, strategy);
  };
  const addIncoming = builder.addIncomingCallFilter.bind(builder);
  builder.addIncomingCallFilter = (filter) => {
    spy.incoming.push(filter);
    return addIncoming(filter);
  };
  const addOutgoing = builder.addOutgoingCallFilter.bind(builder);
  builder.addOutgoingCallFilter = (filter) => {
    spy.outgoing.push(filter);
    return addOutgoing(filter);
  };
  // Both overloads now take either a class plus its interfaces or a `defineGrain`
  // definition that carries its own, so the spy collapses them through the same
  // `normalizeRegistration` the builder uses rather than reading `.ctor` off a
  // shape only one of them has.
  const registerGrain = builder.registerGrain.bind(builder);
  builder.registerGrain = ((
    definition: Parameters<typeof registerGrain>[0],
    registration?: GrainRegistration,
  ) => {
    spy.grains.push(normalizeRegistration(definition, registration));
    return registerGrain(definition as never, registration as never);
  }) as typeof builder.registerGrain;
  const registerGrains = builder.registerGrains.bind(builder);
  builder.registerGrains = (registrations) => {
    for (const r of registrations) {
      // A ctor spec carries its interfaces separately; a definition carries its own.
      spy.grains.push(
        "ctor" in r
          ? normalizeRegistration(r.ctor, { interfaces: [...r.interfaces] })
          : normalizeRegistration(r),
      );
    }
    return registerGrains(registrations);
  };
  const addStartupTask = builder.addStartupTask.bind(builder);
  builder.addStartupTask = (fn) => {
    spy.startupTasks.push(fn);
    return addStartupTask(fn);
  };
  return spy;
}

/**
 * The `GrainFactoryAccess` a startup task would receive. `getGrain` hands back an inert stub (these
 * gates never make a grain CALL), and the two observer members are RECORDED - `createObjectReference`
 * is how "the hub actually started" becomes observable without a running cluster.
 */
interface FakeFactory extends GrainFactoryAccess {
  readonly references: object[];
}

function fakeFactory(): FakeFactory {
  const references: object[] = [];
  return {
    references,
    getGrain<T, K extends GrainKeyKind>(_def: GrainInterface<T, K>, _key: KeyTypeOf<K>): T {
      return new Proxy({} as object, {
        get: () => () => Promise.resolve(undefined),
      }) as T;
    },
    createObjectReference<T>(_def: GrainInterface<T>, obj: object): T {
      references.push(obj);
      return obj as T;
    },
    deleteObjectReference(ref: object): void {
      const at = references.indexOf(ref);
      if (at >= 0) references.splice(at, 1);
    },
  };
}

/** An `IDatastore` thunk that fails if it is ever called - the "not registered here" gate. */
function forbiddenDatastore(): () => IDatastore {
  return () => {
    throw new Error("IDatastore is host-owned and must not be resolved during wiring");
  };
}

function stubDatastore(): IDatastore {
  return new Proxy({} as IDatastore, {
    get: () => () => Promise.reject(new Error("not reached")),
  });
}

function wire(builder: SiloBuilder, overrides: Record<string, unknown> = {}) {
  return addSpiceportGrainServices(builder, {
    schemaText: SCHEMA,
    datastore: () => stubDatastore(),
    datastoreStorage: new MemoryGrainStorage(),
    ...overrides,
  } as Parameters<typeof addSpiceportGrainServices>[1]);
}

/** Runs every registered startup task, which is what binds the lazy grain factory. */
async function boot(spy: Spy): Promise<FakeFactory> {
  const factory = fakeFactory();
  for (const task of spy.startupTasks) await task(factory);
  return factory;
}

// --- the gates --------------------------------------------------------------------------------

describe("addSpiceportGrainServices", () => {
  describe("the schema provider", () => {
    it("serves the provider and the hash source from ONE instance", () => {
      const services = wire(newBuilder());

      // The dispatch mesh reads the hash per request through the hash source; two instances would
      // let a swap be visible to one and not the other.
      expect(services.schemaProvider).toBeInstanceOf(MutableSchemaProvider);
      expect(services.schemaHashSource).toBe(services.schemaProvider);
      expect(services.schemaProvider.current.sourceText).toBe(SCHEMA);
    });

    it("VALIDATES the seed schema by constructing the provider", () => {
      expect(() => wire(newBuilder(), { schemaText: "definition user {" })).toThrow();
    });

    it("rejects an absent schema text outright", () => {
      expect(() => wire(newBuilder(), { schemaText: undefined as unknown as string })).toThrow(
        InvalidArgumentError,
      );
    });

    it("SEEDS the schema resolver with the live snapshot", () => {
      const services = wire(newBuilder());

      // Without this the seed window (nothing persisted yet) misses the cache on EVERY dispatch and
      // pays a sequencer `readSchemaAt` hop to learn nothing.
      const seeded = services.schemaResolver.get(services.schemaProvider.current.schemaHash);
      expect(seeded).toBe(services.schemaProvider.current);
    });
  });

  describe("the per-silo singletons", () => {
    it("creates fresh metrics per silo, so a cluster sum is meaningful", () => {
      const a = wire(newBuilder());
      const b = wire(newBuilder());

      expect(a.dispatchMetrics).toBeInstanceOf(DispatchMetrics);
      expect(a.sequencerMetrics).toBeInstanceOf(SequencerMetrics);
      // Distinct instances: `MeshTestCluster.metricsSnapshot()` sums every silo's snapshot, which
      // would double-count a shared instance and read zero for a silo that never got one.
      expect(a.dispatchMetrics).not.toBe(b.dispatchMetrics);
      expect(a.sequencerMetrics).not.toBe(b.sequencerMetrics);
    });

    it("builds the admission gate over the supplied options", () => {
      const services = wire(newBuilder(), { sequencerAdmissionOptions: { maxInFlightCommits: 1 } });

      const first = services.admission.enter();
      expect(() => services.admission.enter()).toThrow();
      first.dispose();
      // Recorded on the SUBMITTING silo's sequencer metrics, which is why the two are wired
      // together here rather than independently.
      expect(services.sequencerMetrics.snapshot().commitShed).toBe(1);
    });

    it("defaults the three memo options to ON", () => {
      const services = wire(newBuilder());

      expect(services.membershipWalkOptions.enabled ?? true).toBe(true);
      expect(services.activationMemoOptions.enabled ?? true).toBe(true);
      expect(services.subjectFrontierMemoOptions.enabled ?? true).toBe(true);
    });

    it("lets an explicit memo option override the default (the last-wins pattern)", () => {
      const services = wire(newBuilder(), {
        membershipWalkOptions: { enabled: false },
        activationMemoOptions: { enabled: false },
        subjectFrontierMemoOptions: { enabled: false, maxMemoSubjects: 7 },
      });

      // These three overrides ARE `MeshTestCluster`'s useMembershipWalk / useActivationMemo /
      // useSubjectFrontierMemo flags.
      expect(services.membershipWalkOptions.enabled).toBe(false);
      expect(services.activationMemoOptions.enabled).toBe(false);
      expect(services.subjectFrontierMemoOptions.enabled).toBe(false);
      expect(services.subjectFrontierMemoOptions.maxMemoSubjects).toBe(7);
    });
  });

  describe("the silo-side registrations", () => {
    it("registers all six grain classes with their interfaces", () => {
      const spy = spyOn(newBuilder());
      wire(spy.builder);

      const registered = new Map(spy.grains.map((g) => [g.ctor, g.interfaces]));
      expect(registered.get(DatastoreGrain)).toContain(IDatastoreGrain);
      expect(registered.get(RelationshipsGrain)).toContain(IRelationshipsGrain);
      expect(registered.get(CheckGrain)).toContain(ICheckGrain);
      expect(registered.get(GraphShardGrain)).toContain(IGraphShardGrain);
      expect(registered.get(MembershipWalkGrain)).toContain(IMembershipWalkGrain);
      expect(registered.get(SubjectFrontierGrain)).toContain(ISubjectFrontierGrain);
    });

    it("registers exactly one outgoing and one incoming check-dispatch filter", () => {
      const spy = spyOn(newBuilder());
      wire(spy.builder);

      // Orleans resolved both from the SAME container the runtime uses; here the equivalent is that
      // both land on the SAME silo builder, so a co-hosted host and a TestCluster silo are wired
      // identically with nothing host-specific left over.
      expect(spy.outgoing).toHaveLength(1);
      expect(spy.incoming).toHaveLength(1);
    });

    it("registers the placement director, since the four graph grains name it unconditionally", () => {
      const spy = spyOn(newBuilder());
      wire(spy.builder);

      // The strategy attaches per grain CLASS and cannot be conditional, so the director must exist
      // wherever those grains can activate; the on/off decision lives in GraphPlacementOptions.
      const registered = spy.strategies.filter((s) => s.name === GRAPH_LOCALITY_PLACEMENT_STRATEGY);
      expect(registered).toHaveLength(1);
      expect(registered[0]!.strategy).toBeInstanceOf(GraphLocalityPlacementDirector);
    });
  });

  describe("the graph placement options TryAdd", () => {
    it("keeps an EARLIER explicit opt-out rather than reverting it", () => {
      const builder = newBuilder();

      // MeshTestCluster's configurators call the deployment opt-in BEFORE this method precisely to
      // pin this. An unconditional add here would silently revert co-location with NO error.
      addGraphLocalityPlacement(builder, { coLocateWithShards: false });
      const services = wire(builder);

      expect(services.graphPlacementOptions.coLocateWithShards).toBe(false);
    });

    it("keeps an earlier opt-out even against an explicit argument to this method", () => {
      const builder = newBuilder();

      addGraphLocalityPlacement(builder, { coLocateWithShards: false });
      const services = wire(builder, { graphPlacementOptions: { coLocateWithShards: true } });

      // TryAdd, not Add: the earlier registration is the deployment's, and it wins.
      expect(services.graphPlacementOptions.coLocateWithShards).toBe(false);
    });

    it("supplies the default when nothing opted in first", () => {
      const services = wire(newBuilder());

      expect(services.graphPlacementOptions.coLocateWithShards ?? true).toBe(true);
    });
  });

  describe("the lazily-resolved services", () => {
    it("does NOT touch the host-owned datastore during wiring", () => {
      const spy = spyOn(newBuilder());

      // Registering IDatastore here would change the ownership model: the host must own it because
      // it must persist writes. Wiring only CONSUMES it.
      expect(() => wire(spy.builder, { datastore: forbiddenDatastore() })).not.toThrow();
    });

    it("resolves the seams over the grain factory the startup task binds", async () => {
      const spy = spyOn(newBuilder());
      const services = wire(spy.builder);

      await boot(spy);

      expect(services.schemaSource).toBeInstanceOf(GrainSchemaSource);
      expect(services.snapshotScanner).toBeInstanceOf(GrainSnapshotScanner);
      expect(services.graphReaderSource).toBeInstanceOf(ShardedGraphReaderSource);
      expect(services.hub).toBeInstanceOf(LogWatchHub);
      expect(services.dispatcher).toBeInstanceOf(OrleansDispatcher);
      expect(services.checker).toBeInstanceOf(PermissionChecker);
      expect(services.reverseOps).toBeInstanceOf(ReverseOps);
      expect(services.relationshipReads).toBeInstanceOf(RelationshipReads);

      await services.hub.dispose();
    });

    it("hands the SAME dispatcher instance to every consumer", async () => {
      const spy = spyOn(newBuilder());
      const services = wire(spy.builder);
      await boot(spy);

      // The single silo-wide root: the API enters through it AND every grain routes its children
      // back through it. Two instances would mean two meshes.
      expect(services.dispatcher).toBe(services.dispatcher);
      expect(services.hub).toBe(services.hub);
      expect(services.checker).toBe(services.checker);

      await services.hub.dispose();
    });
  });

  describe("the watch hub", () => {
    it("starts UNCONDITIONALLY at silo boot", async () => {
      const spy = spyOn(newBuilder());
      const services = wire(spy.builder);

      expect(spy.startupTasks).toHaveLength(1);
      const factory = await boot(spy);

      // `EnsureStarted` mints the hub's own observer reference, so a reference having been created
      // by the time the startup task returned IS the hub having started - with nobody having opened
      // a Watch stream. Laziness here would leave this silo's schema provider stale forever once a
      // WriteSchema landed on another silo.
      expect(factory.references.length).toBeGreaterThan(0);
      expect(factory.references).toContain(services.hub);

      await services.hub.dispose();
    });

    it("applies a pushed schema to THIS silo's provider", async () => {
      const spy = spyOn(newBuilder());
      const services = wire(spy.builder);
      await boot(spy);

      const bytes = new TextEncoder().encode(REPLACEMENT_SCHEMA);
      await services.hub.schemaAdvanced(bytes, computeStoredSchemaHash(bytes));

      // `applySchema: text => provider.Update(text)`. Without this wiring a WriteSchema on any other
      // silo leaves this one evaluating the old schema forever.
      expect(services.schemaProvider.current.sourceText).toBe(REPLACEMENT_SCHEMA);

      await services.hub.dispose();
    });
  });
});
