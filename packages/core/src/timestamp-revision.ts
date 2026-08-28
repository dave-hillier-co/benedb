import { registerSurrogate } from "@thresh/core/value-codec";

import { defaultGreaterThan, type IRevision } from "./i-revision";

const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const TICKS_PER_SECOND = 10000000n;
const NANOS_PER_TICK = 100n;

/**
 * A revision based on a nanosecond timestamp since the Unix epoch.
 *
 * `timestampNanosSinceEpoch` is a `bigint`: the C# field is a `long`, and nanoseconds since the
 * epoch are ~1.8e18 today, far beyond 2^53, so `number` would silently round and every revision
 * comparison would degrade.
 */
export class TimestampRevision implements IRevision {
  /** Nanoseconds since 1970-01-01T00:00:00Z. */
  readonly timestampNanosSinceEpoch: bigint;

  constructor(timestampNanosSinceEpoch: bigint) {
    this.timestampNanosSinceEpoch = timestampNanosSinceEpoch;
  }

  /** @inheritdoc */
  readonly byteSortable = true;

  /**
   * This revision as a date-time offset, truncated to 100ns ticks exactly as
   * `DateTimeOffset.UnixEpoch.AddTicks(nanos / 100)` does - BigInt division truncates toward
   * zero, as C# `long` division does. Rendered as an ISO-8601 UTC string with 7 fractional
   * digits, matching .NET tick resolution; epoch millis as a `number` would lose precision the
   * C# keeps.
   */
  get asDateTimeOffset(): string {
    const ticks = this.timestampNanosSinceEpoch / NANOS_PER_TICK;
    let seconds = ticks / TICKS_PER_SECOND;
    let fraction = ticks - seconds * TICKS_PER_SECOND;
    if (fraction < 0n) {
      seconds -= 1n;
      fraction += TICKS_PER_SECOND;
    }
    const instant = new Date(Number(seconds) * 1000);
    const calendar = instant.toISOString().slice(0, 19);
    return `${calendar}.${fraction.toString().padStart(7, "0")}Z`;
  }

  /** @inheritdoc */
  toString(): string {
    return this.timestampNanosSinceEpoch.toString();
  }

  /**
   * Parses a timestamp revision from its string form. `long.Parse` with `NumberStyles.Integer`
   * allows surrounding whitespace and a leading sign and rejects everything else, including the
   * hex, exponent and fractional forms bare `BigInt()` would accept, and any value outside the
   * int64 range. That rejection is what turns a malformed token into `ZedTokenStatus` "unknown".
   */
  static parse(value: string): TimestampRevision {
    if (!/^[ \t\n\r\f\v]*[+-]?[0-9]+[ \t\n\r\f\v]*$/.test(value)) {
      throw new SyntaxError(`not a valid timestamp revision: "${value}"`);
    }
    const parsed = BigInt(value.trim());
    if (parsed < INT64_MIN || parsed > INT64_MAX) {
      throw new RangeError(`timestamp revision out of int64 range: "${value}"`);
    }
    return new TimestampRevision(parsed);
  }

  /**
   * @inheritdoc
   *
   * Numeric against another `TimestampRevision`; otherwise an ORDINAL compare of the string
   * forms, as `string.CompareOrdinal` does. JS `<` on strings is already UTF-16 code-unit
   * ordinal, so it maps directly - `localeCompare` must not be used.
   */
  compareTo(other: IRevision | undefined): number {
    if (other === undefined) return 1;
    if (other instanceof TimestampRevision) {
      if (this.timestampNanosSinceEpoch === other.timestampNanosSinceEpoch) return 0;
      return this.timestampNanosSinceEpoch < other.timestampNanosSinceEpoch ? -1 : 1;
    }
    const mine = this.toString();
    const theirs = other.toString();
    if (mine === theirs) return 0;
    return mine < theirs ? -1 : 1;
  }

  /**
   * @inheritdoc
   *
   * C# has both the record's generated `Equals(TimestampRevision)` and an explicit
   * `Equals(IRevision?)`; both reduce to "is a `TimestampRevision` with the same nanos".
   */
  equals(other: IRevision | undefined): boolean {
    return (
      other instanceof TimestampRevision &&
      other.timestampNanosSinceEpoch === this.timestampNanosSinceEpoch
    );
  }

  /** @inheritdoc */
  greaterThan(other: IRevision | undefined): boolean {
    return defaultGreaterThan(this, other);
  }
}

// A revision crosses the grain boundary inside `DecodedRevision` / `ResolvedRevision` and the
// receiver calls `compareTo` / `greaterThan` on it, so it needs a surrogate to survive as its own
// class rather than a plain object. Importing this module performs the registration.
registerSurrogate<TimestampRevision>({
  tag: "spacedb.timestampRevision",
  test: (value) => value instanceof TimestampRevision,
  encode: (revision) => ({ timestampNanosSinceEpoch: revision.timestampNanosSinceEpoch }),
  decode: (fields) => new TimestampRevision(fields.timestampNanosSinceEpoch as bigint),
});
