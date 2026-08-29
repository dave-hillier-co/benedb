import { durationToMs } from "@thresh/core/duration";
import { describe, expect, it } from "vitest";

import { MINIMUM_REMINDER_PERIOD, resolveDatastoreGcOptions } from "./datastore-gc-options";

/**
 * No covering C# test - a characterization of `DatastoreGcOptions`, the datastore grain's
 * reminder-driven MVCC garbage collection settings.
 *
 * The 24h window mirrors the retention window `ReferenceDatastore` and `DatastoreGrain` already
 * use, so it is not a free choice: shortening it collects history a live ZedToken still names.
 * Clamping the reminder period to the one-minute floor is the GRAIN's job (a later slice) - the
 * resolver must report what was configured, or the clamp becomes untestable.
 */
describe("resolveDatastoreGcOptions", () => {
  it("defaults to a 24h window, a 1h reminder period, and the reminder enabled", () => {
    const resolved = resolveDatastoreGcOptions();

    expect(durationToMs(resolved.window)).toBe(86_400_000);
    expect(durationToMs(resolved.reminderPeriod)).toBe(3_600_000);
    expect(resolved.reminderEnabled).toBe(true);
  });

  it("applies the same defaults to an empty object as to nothing at all", () => {
    expect(resolveDatastoreGcOptions({})).toEqual(resolveDatastoreGcOptions());
  });

  it("keeps an explicit false reminder flag - that is how a cluster opts out of GC", () => {
    expect(resolveDatastoreGcOptions({ reminderEnabled: false }).reminderEnabled).toBe(false);
  });

  it("keeps an explicit zero window rather than falling back to 24h", () => {
    expect(durationToMs(resolveDatastoreGcOptions({ window: { ms: 0 } }).window)).toBe(0);
  });

  it("reports a sub-minimum reminder period unchanged - the grain clamps, not the resolver", () => {
    expect(
      durationToMs(resolveDatastoreGcOptions({ reminderPeriod: { seconds: 5 } }).reminderPeriod),
    ).toBe(5_000);
  });

  it("fills each member independently", () => {
    const resolved = resolveDatastoreGcOptions({ window: { hours: 1 } });

    expect(durationToMs(resolved.window)).toBe(3_600_000);
    expect(durationToMs(resolved.reminderPeriod)).toBe(3_600_000);
    expect(resolved.reminderEnabled).toBe(true);
  });

  it("publishes the reminder-period floor as a frozen module constant", () => {
    expect(durationToMs(MINIMUM_REMINDER_PERIOD)).toBe(60_000);
    expect(Object.isFrozen(MINIMUM_REMINDER_PERIOD)).toBe(true);
  });

  it("does not mutate the object it was given", () => {
    const configured = { reminderEnabled: false };

    resolveDatastoreGcOptions(configured);

    expect(configured).toEqual({ reminderEnabled: false });
  });
});
