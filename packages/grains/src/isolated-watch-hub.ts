import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { Duration } from "@thresh/core/duration";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import { LogWatchHub } from "./log-watch-hub";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/IsolatedWatchHub.cs`.
 *
 * Test-only factory for a PRIVATE {@link LogWatchHub}, distinct from the per-silo hub the
 * production wiring shares. This seam exists for tests that need a GENUINELY ISOLATED hub - e.g.
 * proving PUSH-driven Watch is real (grain-observer-driven), not a shared in-process shortcut, by
 * committing through one `GrainBackedDatastore`'s hub while asserting on another's (see
 * `Stage3WatchPushMeshTests`) - or a custom heartbeat cadence via `heartbeatInterval`.
 *
 * Port decisions:
 *   * LEDGER DEVIATION: the ledger row targeted `isolated-watch-hub.test.ts`, but this file is a
 *     test-only FACTORY containing no cases, and under vitest a `*.test.ts` with no suite fails
 *     the run outright. It lands as `isolated-watch-hub.ts`; the ledger row is amended.
 *   * `internal static class` + `Create` -> a module-level function, per the port guide's
 *     static-class rule.
 *   * `IGrainFactory` -> Thresh's `GrainFactoryAccess` (`getGrain` plus the observer-hosting
 *     surface), which `ClientNode` also satisfies structurally - so a test may hand in either the
 *     cluster client or the factory a startup task was given.
 *   * `TimeSpan?` -> `Duration | undefined`.
 *   * The returned hub is the CALLER's to dispose. C#'s `await using` has no counterpart under
 *     this repo's ES2022 lib, so callers must wrap in `try { ... } finally { await hub.dispose(); }`.
 *     A leaked hub leaves a live heartbeat loop running past the end of the test.
 */
export function createIsolatedWatchHub(
  grainFactory: GrainFactoryAccess,
  heartbeatInterval?: Duration | undefined,
): LogWatchHub {
  // `ArgumentNullException.ThrowIfNull`, kept even though the type is non-optional: the caller may
  // be untyped.
  if (grainFactory === undefined || grainFactory === null)
    throw new InvalidArgumentError("grainFactory must not be null");

  return new LogWatchHub(
    grainFactory.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY),
    grainFactory,
    heartbeatInterval,
  );
}
