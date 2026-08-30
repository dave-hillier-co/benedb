import { durationToMs, type Duration } from "@thresh/core/duration";
import { getGrainMetadata, setGrainOptions } from "@thresh/core/grain-metadata";
import { createSilo, type SiloBuilder } from "@thresh/hosting/silo-builder";
import { InProcessNetwork } from "@thresh/messaging/in-process-transport";
import { SiloAddress } from "@thresh/core/silo-address";
import { StaticMembershipService } from "@thresh/runtime/static-membership";
import { afterEach, describe, expect, it } from "vitest";

import type { ActivationMemoOptions } from "./activation-memo-options";
import { CheckGrain } from "./check-grain";
import { GraphLocalityPlacementDirector } from "./graph-locality-placement-director";
import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import { MembershipWalkGrain } from "./membership-walk-grain";
import type { MembershipWalkOptions } from "./membership-walk-options";
import {
  addActivationMemoCollectionAge,
  addGraphLocalityPlacement,
  applyMemoCollectionAges,
  graphPlacementOptionsFor,
} from "./silo-builder-extensions";
import { SubjectFrontierGrain } from "./subject-frontier-grain";
import type { SubjectFrontierMemoOptions } from "./subject-frontier-memo-options";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/SiloBuilderExtensions.cs`.
 *
 * NO COVERING C# TEST: the file's only gate in Spiceport is that `MeshTestCluster` stands up and
 * the mesh suites pass, and it is silo WIRING, which does not transliterate mechanically (the
 * stage instruction is explicit about this). This file is therefore a CHARACTERIZATION of what the
 * two public methods must still ACHIEVE, whatever shape the TypeScript takes.
 *
 * WHAT DOES NOT TRANSLATE, and what replaced it.
 *
 *  1. `AddPlacementDirector<TStrategy, TDirector>` has no counterpart: Thresh has no
 *     strategy-vs-director split (a director IS a `PlacementStrategy`), so the pair collapses to
 *     one `builder.addPlacementStrategy(GRAPH_LOCALITY_PLACEMENT_STRATEGY, director)` call, and
 *     "registering the pair twice is intentional and harmless" becomes "registering the strategy
 *     twice is last-wins", which is exactly the override semantics the C# relied on.
 *  2. `GrainCollectionOptions.ClassSpecificCollectionAge` has no counterpart either. THRESH GAP:
 *     a grain type's idle-collection age lives in its `@grain()` metadata
 *     (`GrainOptions.collectionAgeSeconds`), read once per activation from a process-wide registry
 *     (`catalog.ts`: `reg.metadata.options.collectionAgeSeconds ?? defaultCollectionAgeSeconds`).
 *     There is NO per-silo class-specific map to configure. So the port applies the ages by
 *     rewriting the three grain classes' metadata, and the consequence is recorded here because it
 *     is real: the ages are PROCESS-WIDE, so two silos in one process cannot hold different memo
 *     ages. Every silo in a `MeshTestCluster` shares one configuration, so the harness is unharmed;
 *     a future test that needs divergent per-silo ages must fix Thresh instead of working around it
 *     here.
 *  3. THE LAZINESS SURVIVES, because it is load-bearing. The C# reads the three options types from
 *     DI through a dependent `Configure`, so call order does not matter and `MeshTestCluster`'s
 *     configurators may (and do) call `addActivationMemoCollectionAge` FIRST, before the options
 *     are registered. Here `addActivationMemoCollectionAge(builder)` only ARMS the wiring, and
 *     `applyMemoCollectionAges(builder, options)` - which the grain-services registration calls
 *     once it knows the resolved options - is what actually applies it. Arming without ever
 *     applying is a no-op; applying without arming does nothing either, so an opt-out deployment
 *     that never calls the extension keeps Thresh's default age.
 *
 * WHAT MUST STILL BE TRUE, and is pinned below: a disabled memo installs NO age at all (not zero,
 * not a default); an age at or below the collection quantum is clamped UP to `quantum + 1s`; each
 * of the three options types governs exactly ONE grain class; and the placement opt-in is
 * last-wins with an inert (uniform random) director when co-location is off.
 *
 * Orleans' activation rebalancing is deliberately NOT enabled here, exactly as in the C# - a
 * host-level opt-in. `useActivationRebalancing` must never appear in this file's implementation.
 */

// --- fixtures ---------------------------------------------------------------------------------

/** A real `SiloBuilder`, never built: these gates observe REGISTRATION, not a running silo. */
function newBuilder(): SiloBuilder {
  const address = new SiloAddress("test-silo", "uid-0", "test-silo:11111");
  return createSilo({ clusterId: "wiring-test", serviceId: "wiring-test", local: address })
    .useMembership(new StaticMembershipService(address, [address]))
    .useInProcessTransport(new InProcessNetwork());
}

/** Records what was registered on a builder, delegating every call to the real implementation. */
interface Spy {
  readonly builder: SiloBuilder;
  readonly strategies: Array<{ name: string; strategy: unknown }>;
}

function spyOn(builder: SiloBuilder): Spy {
  const strategies: Array<{ name: string; strategy: unknown }> = [];
  const original = builder.addPlacementStrategy.bind(builder);
  builder.addPlacementStrategy = (name, strategy) => {
    strategies.push({ name, strategy });
    return original(name, strategy);
  };
  return { builder, strategies };
}

/**
 * The three grain classes' metadata is PROCESS-WIDE state (see note 2), so every case restores it.
 * Without this a case that clamps an age would leak that age into every later suite in the file.
 */
const GRAIN_CLASSES = [CheckGrain, SubjectFrontierGrain, MembershipWalkGrain] as const;

function snapshotMetadata(): Array<() => void> {
  return GRAIN_CLASSES.map((ctor) => {
    const metadata = getGrainMetadata(ctor);
    if (metadata === undefined) throw new Error(`${ctor.name} is not decorated with @grain()`);
    const { grainType, options } = metadata;
    return () => setGrainOptions(ctor, grainType, { ...options });
  });
}

let restore: Array<() => void> = [];

afterEach(() => {
  for (const undo of restore) undo();
  restore = [];
});

function ageSecondsOf(ctor: (typeof GRAIN_CLASSES)[number]): number | undefined {
  return getGrainMetadata(ctor)?.options.collectionAgeSeconds;
}

function seconds(duration: Duration): number {
  return durationToMs(duration) / 1000;
}

interface MemoBundle {
  readonly activationMemo: ActivationMemoOptions;
  readonly subjectFrontierMemo: SubjectFrontierMemoOptions;
  readonly membershipWalk: MembershipWalkOptions;
  readonly collectionQuantum?: Duration | undefined;
}

/** Arms the wiring and applies `options`, the two halves the C# `Configure<TOptions>` fused. */
function applyAges(builder: SiloBuilder, options: MemoBundle): void {
  restore = snapshotMetadata();
  addActivationMemoCollectionAge(builder);
  applyMemoCollectionAges(builder, options);
}

const ENABLED: MemoBundle = {
  activationMemo: { enabled: true, collectionAge: { minutes: 5 } },
  subjectFrontierMemo: { enabled: true, collectionAge: { minutes: 7 } },
  membershipWalk: { enabled: true, collectionAge: { minutes: 9 } },
};

// --- the gates --------------------------------------------------------------------------------

describe("addGraphLocalityPlacement", () => {
  it("registers the graph-locality director under the strategy name", () => {
    const spy = spyOn(newBuilder());

    addGraphLocalityPlacement(spy.builder);

    expect(spy.strategies).toHaveLength(1);
    expect(spy.strategies[0]!.name).toBe(GRAPH_LOCALITY_PLACEMENT_STRATEGY);
    expect(spy.strategies[0]!.strategy).toBeInstanceOf(GraphLocalityPlacementDirector);
  });

  it("records the default options when none are given (co-location ON)", () => {
    const builder = newBuilder();

    addGraphLocalityPlacement(builder);

    // The default comes from `resolveGraphPlacementOptions`, which the real-network A/B settled to
    // ON; the extension exists to OVERRIDE it, not to supply it.
    expect(graphPlacementOptionsFor(builder)?.coLocateWithShards ?? true).toBe(true);
  });

  it("records an explicit opt-OUT, the interesting deployment case", () => {
    const builder = newBuilder();

    addGraphLocalityPlacement(builder, { coLocateWithShards: false });

    expect(graphPlacementOptionsFor(builder)?.coLocateWithShards).toBe(false);
  });

  it("is last-wins, like every other options override in this layer", () => {
    const builder = newBuilder();

    addGraphLocalityPlacement(builder, { coLocateWithShards: true });
    addGraphLocalityPlacement(builder, { coLocateWithShards: false });

    expect(graphPlacementOptionsFor(builder)?.coLocateWithShards).toBe(false);
  });

  it("reports nothing registered on a builder that never opted in", () => {
    // The absent/present distinction is what makes the grain-services registration's TryAdd
    // possible: an EARLIER explicit opt-in must win over the later default.
    expect(graphPlacementOptionsFor(newBuilder())).toBeUndefined();
  });

  it("returns the builder, so it composes in a fluent chain", () => {
    const builder = newBuilder();
    expect(addGraphLocalityPlacement(builder)).toBe(builder);
  });
});

describe("addActivationMemoCollectionAge", () => {
  it("applies one options type per grain class", () => {
    const builder = newBuilder();

    applyAges(builder, ENABLED);

    // ActivationMemoOptions -> CheckGrain, SubjectFrontierMemoOptions -> SubjectFrontierGrain,
    // MembershipWalkOptions -> MembershipWalkGrain. Crossing two of these wires is silent: the
    // memos still work, they just expire on the wrong schedule.
    expect(ageSecondsOf(CheckGrain)).toBe(seconds({ minutes: 5 }));
    expect(ageSecondsOf(SubjectFrontierGrain)).toBe(seconds({ minutes: 7 }));
    expect(ageSecondsOf(MembershipWalkGrain)).toBe(seconds({ minutes: 9 }));
  });

  it("installs NO age at all for a DISABLED memo", () => {
    const builder = newBuilder();
    restore = snapshotMetadata();
    // Start from a known state so "absent" is observable rather than inherited.
    for (const ctor of GRAIN_CLASSES) {
      const metadata = getGrainMetadata(ctor)!;
      const { collectionAgeSeconds: _drop, ...rest } = metadata.options;
      setGrainOptions(ctor, metadata.grainType, rest);
    }

    addActivationMemoCollectionAge(builder);
    applyMemoCollectionAges(builder, {
      activationMemo: { enabled: false, collectionAge: { minutes: 5 } },
      subjectFrontierMemo: ENABLED.subjectFrontierMemo,
      membershipWalk: ENABLED.membershipWalk,
    });

    // `if (!memo.Enabled) return;` - not a zero, not a default: NOTHING, so the class falls back to
    // the silo-wide default collection age.
    expect(ageSecondsOf(CheckGrain)).toBeUndefined();
    expect(ageSecondsOf(SubjectFrontierGrain)).toBe(seconds({ minutes: 7 }));
  });

  it("clamps an age at or below the collection quantum UP to quantum + 1s", () => {
    const builder = newBuilder();

    applyAges(builder, {
      ...ENABLED,
      activationMemo: { enabled: true, collectionAge: { seconds: 5 } },
      collectionQuantum: { seconds: 30 },
    });

    // Orleans REJECTS a class-specific age that does not exceed the quantum at config-validation
    // time, so the C# clamps up rather than letting the silo fail to start. Whether Thresh
    // validates the same way is beside the point: the clamp is kept so behaviour MATCHES.
    expect(ageSecondsOf(CheckGrain)).toBe(31);
  });

  it("clamps an age EXACTLY equal to the quantum (the boundary is strict)", () => {
    const builder = newBuilder();

    applyAges(builder, {
      ...ENABLED,
      activationMemo: { enabled: true, collectionAge: { seconds: 30 } },
      collectionQuantum: { seconds: 30 },
    });

    // `memo.CollectionAge < floor` where `floor = quantum + 1s`: an age equal to the quantum is
    // below the floor, so it clamps. "Does not EXCEED" is the rule, not "is below".
    expect(ageSecondsOf(CheckGrain)).toBe(31);
  });

  it("leaves an age above the floor untouched", () => {
    const builder = newBuilder();

    applyAges(builder, {
      ...ENABLED,
      activationMemo: { enabled: true, collectionAge: { seconds: 90 } },
      collectionQuantum: { seconds: 30 },
    });

    expect(ageSecondsOf(CheckGrain)).toBe(90);
  });

  it("uses the default one-minute quantum when none is supplied", () => {
    const builder = newBuilder();

    applyAges(builder, {
      ...ENABLED,
      activationMemo: { enabled: true, collectionAge: { seconds: 10 } },
    });

    // The C#'s `CollectionQuantum` default is 1 minute, so the floor is 61s.
    expect(ageSecondsOf(CheckGrain)).toBe(61);
  });

  it("does not care whether it is armed before or after the options are known", () => {
    // THE LAZINESS GATE. MeshTestCluster's configurators call this FIRST, before the grain-services
    // registration produces the resolved options; resolving eagerly would reintroduce exactly the
    // ordering dependency the C#'s dependent-Configure removed.
    const builder = newBuilder();
    restore = snapshotMetadata();

    addActivationMemoCollectionAge(builder);
    applyMemoCollectionAges(builder, {
      ...ENABLED,
      activationMemo: { enabled: true, collectionAge: { minutes: 11 } },
    });

    expect(ageSecondsOf(CheckGrain)).toBe(seconds({ minutes: 11 }));
  });

  it("does nothing at all when the extension was never called", () => {
    const builder = newBuilder();
    restore = snapshotMetadata();
    const before = ageSecondsOf(CheckGrain);

    // Not armed: a deployment that opts out of the memo wiring keeps Thresh's default age.
    applyMemoCollectionAges(builder, ENABLED);

    expect(ageSecondsOf(CheckGrain)).toBe(before);
  });

  it("returns the builder, so it composes in a fluent chain", () => {
    const builder = newBuilder();
    restore = snapshotMetadata();
    expect(addActivationMemoCollectionAge(builder)).toBe(builder);
  });
});
