/**
 * Supplies the evaluation "now" used to filter expired relationships during a check.
 *
 * Ported from Spiceport `Engine/Clock.cs` (`IClock` / `SystemClock` / `FixedClock`).
 *
 * THE BINDING REPRESENTATION DECISION FOR THE ENGINE STAGE. The C# `IClock.UtcNow` is a
 * `DateTimeOffset`, and every engine file compares it against `Relationship.OptionalExpiration`.
 * `@benedb/core/relationship` already fixes that member as `bigint` epoch-NANOSECONDS, so the
 * evaluation "now" is `bigint` epoch-nanoseconds too - not a `Date`, not epoch-millis. Anything
 * else makes `expiration <= now` in check-engine / local-dispatcher / expand-engine /
 * lookup-*-engine either a type error or a silent comparison between incompatible
 * representations.
 *
 * `BigInt(Date.now()) * 1_000_000n` loses .NET's 100ns tick resolution. That loss is invisible to
 * the engine, which only ever does a `<=` comparison.
 */
export interface IClock {
  /**
   * The current instant, as epoch nanoseconds.
   *
   * A COMPUTED property in C#, so implementations must expose it as a GETTER, never a field
   * snapshot. TypeScript cannot require getter-ness on an interface; `clock.test.ts` pins it.
   */
  readonly utcNow: bigint;
}

/**
 * An {@link IClock} backed by the system clock.
 *
 * `SystemClock.Instance` is a `static readonly` singleton compared by reference at call sites, so
 * it ports as a frozen module constant, never a factory.
 */
export const SYSTEM_CLOCK: IClock = Object.freeze({
  get utcNow(): bigint {
    return BigInt(Date.now()) * 1_000_000n;
  },
});

/**
 * The system clock's current instant.
 *
 * No engine file injects an `IClock`; they all take an optional `evaluationTime` and fall back to
 * `SystemClock.Instance.UtcNow`. This is the free function those `evaluationTime ?? systemClockNow()`
 * resolvers call, so an explicit `0n` survives.
 */
export function systemClockNow(): bigint {
  return SYSTEM_CLOCK.utcNow;
}

/** Creates an {@link IClock} pinned to a fixed instant, for deterministic tests. */
export function createFixedClock(now: bigint): IClock {
  return {
    get utcNow(): bigint {
      return now;
    },
  };
}
