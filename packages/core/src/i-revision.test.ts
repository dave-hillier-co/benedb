import { describe, expect, it } from "vitest";

import { defaultGreaterThan, type IRevision } from "./i-revision";
import { TimestampRevision } from "./timestamp-revision";

// Characterization of Spiceport `IRevision` (no covering C# test).
//
// The one real design decision of this batch, made here once.
//
// C# `IRevision` is `IComparable<IRevision> + IEquatable<IRevision>` with a DEFAULT INTERFACE
// METHOD: `bool GreaterThan(IRevision? other) => CompareTo(other) > 0`. TypeScript has neither
// default interface methods nor a way for a plain serialized object to keep behaviour, so the
// port picks:
//
//   * an INTERFACE with explicit `compareTo` / `equals` / `greaterThan` members and a
//     `byteSortable` PROPERTY (it is a property in C#, not a method), plus
//   * a shared `defaultGreaterThan(self, other)` free function standing in for the default
//     implementation, which a totally-ordered revision delegates to.
//
// The rejected alternative was a discriminated union of revision shapes with free functions.
// It serializes for free, but it CLOSES the set of revision types, and the set is open by
// design: `Spiceport.Datastore.TimestampRevisionParser` and `Spiceport.Engine.InProcessRevision`
// each supply their own, and a Postgres datastore later supplies snapshot revisions that are
// only PARTIALLY ordered. `RevisionResolver` calls `opt.Revision.GreaterThan(decoded.Revision)`
// and its comment is explicit: for concurrent (incomparable) snapshots `GreaterThan` must be
// false so the resolver falls through to the caller's token and read-your-writes survives. A
// closed union in core could not host a datastore-defined revision at all.
//
// The price of the interface shape is that a revision crossing a grain boundary is an object the
// receiver calls methods on, so every implementation must register a Thresh surrogate. That is
// pinned per implementation (see timestamp-revision.test.ts), not here.

/**
 * A stand-in for the Postgres snapshot revision this port has not reached: totally ordered by
 * `position` for `compareTo`, but with an explicit set of positions it is CONCURRENT with, for
 * which `greaterThan` must be false. It exists to prove the chosen shape leaves the override
 * possible - if it ever stops compiling, read-your-writes on a partially-ordered datastore is
 * broken before that datastore is written.
 */
class ConcurrentAwareRevision implements IRevision {
  readonly byteSortable = false;

  constructor(
    readonly position: number,
    private readonly concurrentWith: readonly number[] = [],
  ) {}

  toString(): string {
    return `snapshot:${this.position}`;
  }

  compareTo(other: IRevision | undefined): number {
    if (other === undefined) return 1;
    if (other instanceof ConcurrentAwareRevision) {
      return this.position === other.position ? 0 : this.position < other.position ? -1 : 1;
    }
    const mine = this.toString();
    const theirs = other.toString();
    return mine === theirs ? 0 : mine < theirs ? -1 : 1;
  }

  equals(other: IRevision | undefined): boolean {
    return other instanceof ConcurrentAwareRevision && other.position === this.position;
  }

  greaterThan(other: IRevision | undefined): boolean {
    if (other instanceof ConcurrentAwareRevision && this.concurrentWith.includes(other.position)) {
      return false;
    }
    return defaultGreaterThan(this, other);
  }
}

describe("IRevision", () => {
  describe("defaultGreaterThan", () => {
    it("is strictly newer, i.e. compareTo > 0", () => {
      const older = new TimestampRevision(100n);
      const newer = new TimestampRevision(200n);

      expect(defaultGreaterThan(newer, older)).toBe(true);
      expect(defaultGreaterThan(older, newer)).toBe(false);
    });

    it("is false for an equal revision - STRICTLY newer, not at-least-as-new", () => {
      const revision = new TimestampRevision(100n);

      expect(defaultGreaterThan(revision, new TimestampRevision(100n))).toBe(false);
    });

    it("is true against undefined, because compareTo(undefined) is 1", () => {
      expect(defaultGreaterThan(new TimestampRevision(0n), undefined)).toBe(true);
    });
  });

  describe("a partially-ordered implementation", () => {
    it("overrides greaterThan so a concurrent revision is NOT strictly newer", () => {
      const mine = new ConcurrentAwareRevision(5, [4]);
      const concurrent = new ConcurrentAwareRevision(4);

      // compareTo still orders them - it must, IComparable demands a total fallback ...
      expect(mine.compareTo(concurrent)).toBeGreaterThan(0);
      // ... but greaterThan says no, which is what the resolver reads.
      expect(mine.greaterThan(concurrent)).toBe(false);
    });

    it("still reports strictly-newer for a non-concurrent revision", () => {
      const mine = new ConcurrentAwareRevision(5, [4]);

      expect(mine.greaterThan(new ConcurrentAwareRevision(3))).toBe(true);
      expect(mine.greaterThan(new ConcurrentAwareRevision(9))).toBe(false);
    });

    it("exposes byteSortable as a property, and it may be false", () => {
      expect(new ConcurrentAwareRevision(1).byteSortable).toBe(false);
    });
  });

  it("lets a foreign revision be compared against a TimestampRevision from either side", () => {
    const timestamp = new TimestampRevision(42n);
    const foreign = new ConcurrentAwareRevision(1);

    // Neither side knows the other's type, so both fall back to an ordinal compare of the
    // string forms: "42" < "snapshot:1" as UTF-16 code units.
    expect(timestamp.compareTo(foreign)).toBeLessThan(0);
    expect(foreign.compareTo(timestamp)).toBeGreaterThan(0);
    expect(timestamp.equals(foreign)).toBe(false);
    expect(foreign.equals(timestamp)).toBe(false);
  });
});
