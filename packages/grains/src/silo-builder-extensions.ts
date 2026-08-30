import { durationToMs, type Duration } from "@thresh/core/duration";
import {
  getGrainMetadata,
  setGrainOptions,
  type GrainConstructor,
} from "@thresh/core/grain-metadata";
import type { SiloBuilder } from "@thresh/hosting/silo-builder";

import type { ActivationMemoOptions } from "./activation-memo-options";
import { CheckGrain } from "./check-grain";
import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import { GraphLocalityPlacementDirector } from "./graph-locality-placement-director";
import type { GraphPlacementOptions } from "./graph-placement-options";
import type { MemoGrainOptions } from "./memo-grain-options";
import { resolveMemoGrainOptions } from "./memo-grain-options";
import { MembershipWalkGrain } from "./membership-walk-grain";
import type { MembershipWalkOptions } from "./membership-walk-options";
import { SubjectFrontierGrain } from "./subject-frontier-grain";
import type { SubjectFrontierMemoOptions } from "./subject-frontier-memo-options";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/SiloBuilderExtensions.cs`.
 *
 * Silo-builder wiring for the check-grain mesh. With sub-problem recursion crossing every grain
 * boundary (no in-process local-recurse shortcut) and the correctness of a check depending only on
 * grain identity, placement is never load-bearing: the grain directory's single-activation
 * guarantee is the whole router. The four graph grain families name
 * {@link GRAPH_LOCALITY_PLACEMENT_STRATEGY} in their `@grain()` metadata, whose director defaults
 * to the shard co-location hint - {@link addGraphLocalityPlacement} is the deployment-level
 * OVERRIDE, e.g. opting back out to an inert uniform random pick.
 *
 * Orleans' activation rebalancing remains a host-level opt-in a deployment can layer on later;
 * this library does not enable it, so `useActivationRebalancing` must never appear here.
 *
 * WHAT DOES NOT TRANSLATE, and what replaced it (see `silo-builder-extensions.test.ts`, which
 * characterizes each of these):
 *
 *  1. `AddPlacementDirector<TStrategy, TDirector>` has no counterpart - Thresh has no
 *     strategy-vs-director split (a director IS a `PlacementStrategy`), so the pair collapses to a
 *     single `builder.addPlacementStrategy(GRAPH_LOCALITY_PLACEMENT_STRATEGY, director)`, and
 *     "registering the pair twice is intentional and harmless" becomes "registering the strategy
 *     twice is last-wins" - exactly the override semantics the C# relied on.
 *  2. `GrainCollectionOptions.ClassSpecificCollectionAge` has no counterpart either. THRESH GAP: a
 *     grain type's idle-collection age lives in its `@grain()` metadata
 *     (`GrainOptions.collectionAgeSeconds`), read from a process-wide registry, and there is no
 *     per-silo class-specific map to configure. The port therefore applies the ages by rewriting
 *     the three grain classes' metadata, which makes them PROCESS-wide: two silos in one process
 *     cannot hold different memo ages. Every silo in a `MeshTestCluster` shares one configuration,
 *     so the harness is unharmed; a future test needing divergent per-silo ages must fix Thresh.
 *  3. THE LAZINESS SURVIVES, because it is load-bearing. The C# reads the three options types from
 *     DI through a dependent `Configure`, so call order does not matter and `MeshTestCluster`'s
 *     configurators call {@link addActivationMemoCollectionAge} FIRST, before the options are
 *     known. Here that extension only ARMS the wiring and {@link applyMemoCollectionAges} - which
 *     `addSpiceportGrainServices` calls once it has resolved the options - applies it. Arming
 *     without applying is a no-op; applying without arming does nothing either, so a deployment
 *     that never opts in keeps Thresh's default age.
 *  4. The map keyed by `typeof(TGrain).FullName` becomes the grain CLASS itself plus the grain
 *     type name Thresh registered for it - never a bundler-minifiable `class.name`.
 */

/**
 * The deployment placement opt-in recorded per builder. Thresh has no service container, so "an
 * earlier explicit registration exists" is tracked here, which is what makes
 * `addSpiceportGrainServices`' TryAdd possible at all.
 */
const graphPlacementRegistrations = new WeakMap<SiloBuilder, GraphPlacementOptions>();

/** Builders on which {@link addActivationMemoCollectionAge} has been called (the C#'s `Configure`). */
const memoCollectionAgeArmed = new WeakSet<SiloBuilder>();

/**
 * Registers the graph-locality placement strategy/director and sets {@link GraphPlacementOptions}
 * for this silo. `addSpiceportGrainServices` already registers the director with the default
 * (co-location ON), so calling this is only needed to OVERRIDE the default - e.g. opting out of
 * shard co-location (`coLocateWithShards: false`, reverting the director to an inert uniform random
 * pick).
 *
 * Registration is last-wins, matching the options-override pattern of the other grain options
 * types.
 */
export function addGraphLocalityPlacement(
  builder: SiloBuilder,
  options?: GraphPlacementOptions | undefined,
): SiloBuilder {
  // `ArgumentNullException.ThrowIfNull(siloBuilder);`
  if (builder === undefined || builder === null) {
    throw new Error("builder is required");
  }
  const effective = options ?? {};
  builder.addPlacementStrategy(
    GRAPH_LOCALITY_PLACEMENT_STRATEGY,
    new GraphLocalityPlacementDirector(effective),
  );
  graphPlacementRegistrations.set(builder, effective);
  return builder;
}

/**
 * The placement options an EARLIER {@link addGraphLocalityPlacement} recorded on this builder, or
 * absent when nothing opted in. The absent/present distinction is the whole point: an earlier
 * explicit deployment choice must win over the grain-services default, because an unconditional
 * overwrite would silently revert co-location with no error.
 */
export function graphPlacementOptionsFor(builder: SiloBuilder): GraphPlacementOptions | undefined {
  return graphPlacementRegistrations.get(builder);
}

/**
 * Arms the class-specific idle-collection ages for the three memo grains: `ActivationMemoOptions`
 * governs `CheckGrain`, `SubjectFrontierMemoOptions` governs `SubjectFrontierGrain`, and
 * `MembershipWalkOptions` governs `MembershipWalkGrain` - so a warm activation, and hence its
 * per-activation memo, survives at least that long between calls. The activation's idle-collection
 * age IS each memo's eviction policy: there is no separate TTL bookkeeping in any of the three
 * grains, so dropping this wiring makes the memos never expire and staleness unbounded.
 *
 * Only ARMS: {@link applyMemoCollectionAges} applies the values once they are known. See note 3.
 */
export function addActivationMemoCollectionAge(builder: SiloBuilder): SiloBuilder {
  // `ArgumentNullException.ThrowIfNull(siloBuilder);`
  if (builder === undefined || builder === null) {
    throw new Error("builder is required");
  }
  memoCollectionAgeArmed.add(builder);
  return builder;
}

/** The three memo options types plus the silo's collection quantum, as resolved by the caller. */
export interface MemoCollectionAgeOptions {
  /** `CheckGrain`'s reply memo. */
  readonly activationMemo: ActivationMemoOptions;
  /** `SubjectFrontierGrain`'s frontier memo. */
  readonly subjectFrontierMemo: SubjectFrontierMemoOptions;
  /** The Leopard membership-walk accelerator. */
  readonly membershipWalk: MembershipWalkOptions;
  /** The silo's idle-collection quantum; the C#'s `GrainCollectionOptions` default is 1 minute. */
  readonly collectionQuantum?: Duration | undefined;
}

/**
 * Applies the armed class-specific collection ages. A no-op on a builder
 * {@link addActivationMemoCollectionAge} was never called on.
 */
export function applyMemoCollectionAges(
  builder: SiloBuilder,
  options: MemoCollectionAgeOptions,
): void {
  if (!memoCollectionAgeArmed.has(builder)) return;

  applyMemoCollectionAge(options.activationMemo, CheckGrain, options.collectionQuantum);
  applyMemoCollectionAge(
    options.subjectFrontierMemo,
    SubjectFrontierGrain,
    options.collectionQuantum,
  );
  applyMemoCollectionAge(options.membershipWalk, MembershipWalkGrain, options.collectionQuantum);
}

/** The C#'s default `GrainCollectionOptions.CollectionQuantum`. */
const DEFAULT_COLLECTION_QUANTUM: Duration = { minutes: 1 };

/**
 * The one shared clamp/skip rule behind all three registrations: `AddMemoCollectionAge<TOptions,
 * TGrain>`.
 */
function applyMemoCollectionAge(
  memo: MemoGrainOptions,
  ctor: GrainConstructor,
  collectionQuantum: Duration | undefined,
): void {
  const resolved = resolveMemoGrainOptions(memo);
  // `if (!memo.Enabled) return;` - NO age at all, not a zero and not a default, so the class falls
  // back to the silo-wide default collection age.
  if (!resolved.enabled) return;

  // Orleans REJECTS a class-specific age that does not EXCEED the collection quantum at
  // config-validation time, so the C# clamps up rather than letting the silo fail to start.
  // Whether Thresh validates the same way is beside the point: the clamp is kept so behaviour
  // matches.
  const floorMs = durationToMs(collectionQuantum ?? DEFAULT_COLLECTION_QUANTUM) + 1_000;
  const ageMs = durationToMs(resolved.collectionAge);
  const effectiveMs = ageMs < floorMs ? floorMs : ageMs;

  const metadata = getGrainMetadata(ctor);
  if (metadata === undefined) {
    throw new Error("grain class is not decorated with @grain()");
  }
  setGrainOptions(ctor, metadata.grainType, {
    ...metadata.options,
    collectionAgeSeconds: effectiveMs / 1_000,
  });
}
