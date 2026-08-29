import type { Duration } from "@thresh/core/duration";

/**
 * Configuration for the datastore grain's reminder-driven MVCC garbage collection
 * (`DatastoreGrain.RunGc`). A host that never configures it gets these defaults.
 */
export interface DatastoreGcOptions {
  /**
   * How far back MVCC history is retained. A GC run collects everything strictly below
   * `min(head, now - window)`. Default 24h, mirroring the existing `ReferenceDatastore` /
   * `DatastoreGrain` retention window.
   */
  readonly window?: Duration | undefined;

  /**
   * How often the grain's own reminder fires `RunGc`. Reminders reject a period under one
   * minute, so the GRAIN clamps this to `MINIMUM_REMINDER_PERIOD` - the resolver reports what
   * was configured, or the clamp becomes untestable. Default 1h.
   */
  readonly reminderPeriod?: Duration | undefined;

  /**
   * Whether the grain registers its GC reminder on activation. Default true. A host with no
   * reminder service still activates the grain (registration failure is logged, not fatal) -
   * this flag is for deliberately opting a cluster out.
   */
  readonly reminderEnabled?: boolean | undefined;
}

/** `DatastoreGcOptions` with every default applied. */
export interface ResolvedDatastoreGcOptions {
  readonly window: Duration;
  readonly reminderPeriod: Duration;
  readonly reminderEnabled: boolean;
}

/** The minimum reminder period the runtime accepts. */
export const MINIMUM_REMINDER_PERIOD: Duration = Object.freeze({ minutes: 1 });

export function resolveDatastoreGcOptions(
  options?: DatastoreGcOptions,
): ResolvedDatastoreGcOptions {
  return {
    window: options?.window ?? { hours: 24 },
    reminderPeriod: options?.reminderPeriod ?? { hours: 1 },
    reminderEnabled: options?.reminderEnabled ?? true,
  };
}
