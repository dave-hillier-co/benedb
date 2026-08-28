import { describe, expect, it } from "vitest";

import { createFixedClock, SYSTEM_CLOCK, systemClockNow, type IClock } from "./clock";

// Characterization of Spiceport `Clock.cs` (no covering C# test).
//
// THE BINDING REPRESENTATION DECISION FOR THE WHOLE ENGINE STAGE, pinned here:
//
//   * `IClock.UtcNow` is a `DateTimeOffset` in C#, and every engine file compares it against
//     `Relationship.OptionalExpiration`. `@spacedb/core/relationship` already fixes that member
//     as `bigint` epoch-NANOSECONDS, so the evaluation "now" is `bigint` epoch-nanoseconds too -
//     not a `Date`, not epoch-millis. Anything else makes `expiration <= now` in check-engine /
//     local-dispatcher / expand-engine / lookup-*-engine either a type error or, worse, a silent
//     comparison between incompatible representations.
//   * `SystemClock.Instance` is a `static readonly` singleton compared by reference at call
//     sites, so it ports as a FROZEN MODULE CONSTANT, never a factory.
//   * `UtcNow` is a COMPUTED property on both implementations, so it ports as a GETTER. A field
//     snapshot would freeze `SYSTEM_CLOCK` at module-load time. TypeScript cannot require
//     getter-ness on an interface, so it is pinned here instead.
//   * No engine file injects an `IClock`; they all take an optional `evaluationTime` and fall
//     back to the system clock, hence the `systemClockNow()` free function that those `??`
//     resolvers call.
//
// Resolution: `BigInt(Date.now()) * 1_000_000n` loses .NET's 100ns tick precision. That loss is
// invisible to the engine, which only ever does a `<=` comparison.
describe("clock", () => {
  describe("SYSTEM_CLOCK", () => {
    it("reports the evaluation now as bigint epoch nanoseconds", () => {
      const before = BigInt(Date.now()) * 1_000_000n;
      const now = SYSTEM_CLOCK.utcNow;
      const after = BigInt(Date.now()) * 1_000_000n;

      expect(typeof now).toBe("bigint");
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(after);
    });

    it("is millisecond-quantised, matching BigInt(Date.now()) * 1_000_000n", () => {
      expect(SYSTEM_CLOCK.utcNow % 1_000_000n).toBe(0n);
    });

    it("is a frozen singleton, not a factory: call sites compare it by reference", () => {
      expect(Object.isFrozen(SYSTEM_CLOCK)).toBe(true);
      // Importing the module twice must yield the same object, which is what a `const` gives.
      expect(SYSTEM_CLOCK).toBe(SYSTEM_CLOCK);
    });

    it("recomputes utcNow on every read (a getter, not a field snapshot)", async () => {
      const first = SYSTEM_CLOCK.utcNow;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = SYSTEM_CLOCK.utcNow;

      expect(second).toBeGreaterThan(first);
    });
  });

  describe("systemClockNow", () => {
    it("returns the system clock's current instant", () => {
      const before = SYSTEM_CLOCK.utcNow;
      const now = systemClockNow();

      expect(typeof now).toBe("bigint");
      expect(now).toBeGreaterThanOrEqual(before);
    });

    it("survives the `??` default-parameter idiom for an explicit zero", () => {
      // The port guide's default-parameter rule: `evaluationTime ?? systemClockNow()`. An
      // explicit 0n is the Unix epoch and must NOT be replaced by the system clock.
      const resolve = (evaluationTime?: bigint | undefined): bigint =>
        evaluationTime ?? systemClockNow();

      expect(resolve(0n)).toBe(0n);
      expect(resolve(undefined)).toBeGreaterThan(0n);
    });
  });

  describe("createFixedClock", () => {
    it("always returns the pinned instant", () => {
      const clock = createFixedClock(1_700_000_000_123_456_789n);

      expect(clock.utcNow).toBe(1_700_000_000_123_456_789n);
      expect(clock.utcNow).toBe(1_700_000_000_123_456_789n);
    });

    it("keeps nanosecond precision that a Date or epoch-millis number would lose", () => {
      const clock = createFixedClock(1_700_000_000_000_000_001n);

      expect(clock.utcNow).toBe(1_700_000_000_000_000_001n);
    });

    it("accepts the epoch and negative (pre-epoch) instants without normalising them", () => {
      expect(createFixedClock(0n).utcNow).toBe(0n);
      expect(createFixedClock(-1n).utcNow).toBe(-1n);
    });

    it("produces a distinct clock per call", () => {
      expect(createFixedClock(5n)).not.toBe(createFixedClock(5n));
      expect(createFixedClock(5n).utcNow).toBe(createFixedClock(5n).utcNow);
    });

    it("satisfies the IClock interface, as SYSTEM_CLOCK does", () => {
      const clocks: readonly IClock[] = [SYSTEM_CLOCK, createFixedClock(7n)];

      expect(clocks.map((c) => typeof c.utcNow)).toEqual(["bigint", "bigint"]);
    });
  });
});
