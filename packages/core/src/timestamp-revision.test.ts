import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import { TimestampRevision } from "./timestamp-revision";

// Characterization of Spiceport `TimestampRevision` (no covering C# test).
//
// Port decisions pinned here:
//
// 1. `long TimestampNanosSinceEpoch` MUST be `bigint`. Nanoseconds since the epoch are ~1.8e18
//    today, far beyond 2^53, so `number` would silently round and every revision comparison
//    would degrade. This is the same currency `RelationshipIntegrity.hashedAt` and
//    `Relationship.optionalExpiration` already use.
//
// 2. `ToString()` is the plain invariant decimal form of the long. It is WIRE-VISIBLE: it is the
//    revision string embedded in a ZedToken and parsed back by `TimestampRevisionParser`.
//
// 3. `CompareTo` special-cases another `TimestampRevision` (numeric compare) and otherwise falls
//    back to `string.CompareOrdinal(ToString(), other.ToString())`. JS `<` on strings is already
//    UTF-16 code-unit ordinal, so it maps directly; `localeCompare` must NOT be used.
//
// 4. C# has both the record's generated `Equals(TimestampRevision)` and an explicit
//    `Equals(IRevision?)`. Both reduce to "is a TimestampRevision with the same nanos", so the
//    port has a single `equals` that type-checks first.
//
// 5. `AsDateTimeOffset` is `UnixEpoch.AddTicks(nanos / 100)` - 100ns TICK precision, not
//    nanosecond, with C# long division truncating toward zero exactly as BigInt division does.
//    The guide says pick one representation per DateTimeOffset field and write it down: this
//    port emits an ISO-8601 UTC string with 7 fractional digits, matching .NET tick resolution.
//    Epoch millis as a `number` was rejected because it loses precision the C# keeps.
//
// 6. A revision crosses a grain boundary inside `DecodedRevision` / `ResolvedRevision`, and the
//    receiver calls `compareTo` / `greaterThan` on it, so the implementation registers a Thresh
//    surrogate. Importing this module performs the registration.
describe("timestamp revision", () => {
  describe("toString", () => {
    it("is the plain invariant decimal form", () => {
      expect(new TimestampRevision(1234567890123456789n).toString()).toBe("1234567890123456789");
      expect(new TimestampRevision(0n).toString()).toBe("0");
      expect(new TimestampRevision(-5n).toString()).toBe("-5");
    });

    it("has no thousands separators, exponent, or sign for positives", () => {
      expect(new TimestampRevision(1000000n).toString()).toBe("1000000");
    });

    it("round-trips the full int64 range", () => {
      const max = new TimestampRevision(9223372036854775807n);
      const min = new TimestampRevision(-9223372036854775808n);

      expect(max.toString()).toBe("9223372036854775807");
      expect(min.toString()).toBe("-9223372036854775808");
      expect(TimestampRevision.parse(max.toString()).timestampNanosSinceEpoch).toBe(
        9223372036854775807n,
      );
      expect(TimestampRevision.parse(min.toString()).timestampNanosSinceEpoch).toBe(
        -9223372036854775808n,
      );
    });
  });

  describe("parse", () => {
    it("round-trips the string form", () => {
      const original = new TimestampRevision(1700000000123456789n);

      expect(TimestampRevision.parse(original.toString()).equals(original)).toBe(true);
    });

    it("accepts a leading sign and surrounding whitespace, as NumberStyles.Integer does", () => {
      expect(TimestampRevision.parse("+42").timestampNanosSinceEpoch).toBe(42n);
      expect(TimestampRevision.parse("-42").timestampNanosSinceEpoch).toBe(-42n);
      expect(TimestampRevision.parse(" 42 ").timestampNanosSinceEpoch).toBe(42n);
    });

    // `long.Parse` throws FormatException/OverflowException on each of these. `BigInt()` would
    // accept "", "0x2a" and the out-of-range value, so the port must reject them explicitly -
    // this is the throw that turns a malformed token into ZedTokenStatus unknown.
    it.each([
      ["empty", ""],
      ["whitespace only", "   "],
      ["non-numeric", "abc"],
      ["fractional", "1.5"],
      ["hex", "0x2a"],
      ["numeric separator", "1_0"],
      ["exponent", "1e3"],
      ["trailing garbage", "42abc"],
      ["above int64 max", "9223372036854775808"],
      ["below int64 min", "-9223372036854775809"],
    ])("throws on %s", (_label, value) => {
      expect(() => TimestampRevision.parse(value)).toThrow();
    });
  });

  describe("byteSortable", () => {
    it("is a property, not a method, and is true for a timestamp revision", () => {
      expect(new TimestampRevision(1n).byteSortable).toBe(true);
    });
  });

  describe("compareTo", () => {
    it("orders numerically against another TimestampRevision", () => {
      const older = new TimestampRevision(9n);
      const newer = new TimestampRevision(10n);

      expect(older.compareTo(newer)).toBeLessThan(0);
      expect(newer.compareTo(older)).toBeGreaterThan(0);
      expect(older.compareTo(new TimestampRevision(9n))).toBe(0);
    });

    it("orders numerically across the 2^53 boundary, where number would collapse the two", () => {
      const a = new TimestampRevision(9007199254740993n);
      const b = new TimestampRevision(9007199254740992n);

      expect(a.compareTo(b)).toBeGreaterThan(0);
      expect(a.equals(b)).toBe(false);
    });

    it("returns 1 for undefined - a revision is newer than nothing", () => {
      expect(new TimestampRevision(0n).compareTo(undefined)).toBe(1);
    });

    it("falls back to an ORDINAL string compare for a foreign revision type", () => {
      const nine = new TimestampRevision(9n);
      const foreign = {
        byteSortable: false,
        toString: () => "10",
        compareTo: () => 0,
        equals: () => false,
        greaterThan: () => false,
      };

      // Ordinal, not numeric: "9" > "10" because '9' > '1' as code units.
      expect(nine.compareTo(foreign)).toBeGreaterThan(0);
    });

    it("sorts a list into revision order", () => {
      const revisions = [
        new TimestampRevision(30n),
        new TimestampRevision(-1n),
        new TimestampRevision(10n),
      ];

      const sorted = [...revisions].sort((a, b) => a.compareTo(b));

      expect(sorted.map((r) => r.toString())).toEqual(["-1", "10", "30"]);
    });
  });

  describe("greaterThan", () => {
    it("is strictly newer, inheriting the default compareTo > 0 behaviour", () => {
      const older = new TimestampRevision(100n);
      const newer = new TimestampRevision(101n);

      expect(newer.greaterThan(older)).toBe(true);
      expect(older.greaterThan(newer)).toBe(false);
      expect(newer.greaterThan(new TimestampRevision(101n))).toBe(false);
      expect(newer.greaterThan(undefined)).toBe(true);
    });
  });

  describe("equals", () => {
    it("is true only for a TimestampRevision with the same nanos", () => {
      const revision = new TimestampRevision(7n);

      expect(revision.equals(new TimestampRevision(7n))).toBe(true);
      expect(revision.equals(new TimestampRevision(8n))).toBe(false);
      expect(revision.equals(undefined)).toBe(false);
    });

    it("is false for a foreign revision even when the string forms match", () => {
      const revision = new TimestampRevision(7n);
      const foreign = {
        byteSortable: true,
        toString: () => "7",
        compareTo: () => 0,
        equals: () => true,
        greaterThan: () => false,
      };

      expect(revision.equals(foreign)).toBe(false);
    });
  });

  describe("asDateTimeOffset", () => {
    it("is the epoch for zero", () => {
      expect(new TimestampRevision(0n).asDateTimeOffset).toBe("1970-01-01T00:00:00.0000000Z");
    });

    it("keeps 100ns tick precision and DROPS the last two nanosecond digits", () => {
      expect(new TimestampRevision(1700000000123456789n).asDateTimeOffset).toBe(
        "2023-11-14T22:13:20.1234567Z",
      );
    });

    it("truncates toward zero for negative nanos, as C# long division does", () => {
      // -150 / 100 == -1 tick (NOT -2), i.e. 100ns before the epoch.
      expect(new TimestampRevision(-150n).asDateTimeOffset).toBe("1969-12-31T23:59:59.9999999Z");
    });
  });

  describe("crossing a grain boundary", () => {
    it("round-trips through Thresh's value codec as its own class", () => {
      const original = new TimestampRevision(1700000000123456789n);

      const revived = deserializeValue<TimestampRevision>(serializeValue(original));

      expect(revived).toBeInstanceOf(TimestampRevision);
      expect(revived.timestampNanosSinceEpoch).toBe(1700000000123456789n);
      expect(revived.toString()).toBe("1700000000123456789");
    });

    it("keeps its behaviour, not just its data - the receiver calls these", () => {
      const revived = deserializeValue<TimestampRevision>(
        serializeValue(new TimestampRevision(200n)),
      );

      expect(revived.byteSortable).toBe(true);
      expect(revived.greaterThan(new TimestampRevision(100n))).toBe(true);
      expect(revived.equals(new TimestampRevision(200n))).toBe(true);
      expect(revived.compareTo(new TimestampRevision(300n))).toBeLessThan(0);
    });

    it("survives nested inside another value", () => {
      const revived = deserializeValue<{ revision: TimestampRevision }>(
        serializeValue({ revision: new TimestampRevision(5n) }),
      );

      expect(revived.revision).toBeInstanceOf(TimestampRevision);
      expect(revived.revision.timestampNanosSinceEpoch).toBe(5n);
    });
  });
});
