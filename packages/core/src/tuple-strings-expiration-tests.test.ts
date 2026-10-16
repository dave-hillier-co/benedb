import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "./core-constants";
import { FormatError } from "./format-error";
import { createRelationship } from "./relationship";
import { formatRelationship, parseRelationship, tryParseRelationship } from "./tuple-strings";

// Port of Spiceport `TupleStringsExpirationTests`.
//
// The tuple-string expiration suffix accepts what upstream SpiceDB's parser does
// (`time.Parse(time.RFC3339Nano, ...)` under Go 1.25.7, including its fallback to the general
// layout parser), so a tuple string means the same relationship whenever it is parsed.
//
// Expirations are nanoseconds since the Unix epoch (see relationship.ts); a C# tick is 100ns.

const PREFIX = "doc:1#viewer@user:alice";

const NS_PER_TICK = 100n;

/** Nanoseconds since the Unix epoch of a whole-second UTC instant. */
const utc = (iso: string): bigint => BigInt(Date.parse(iso)) * 1_000_000n;

describe("TupleStringsExpirationTests", () => {
  it.each([
    "01:02:03",
    "2025-1-2",
    "2025.01.02",
    "2025-01-02",
    "2025-01-02T03:04:05",
    "2025-01-02T03:04Z",
    // Go's layout parser reads the hour as one or two digits, but minutes, seconds and the
    // offset fields are fixed-width.
    "2025-01-02T3:4:5Z",
    "2025-01-02T03:04:5Z",
    "2025-01-02T003:04:05Z",
    "2025-01-02T03:04:05-1:00",
    "2025-01-02T03:04:05.Z",
  ])("Non_rfc3339_expiration_is_rejected (%s)", (expiration) => {
    const tuple = `${PREFIX}[expiration:${expiration}]`;

    expect(tryParseRelationship(tuple)).toBeUndefined();
    expect(() => parseRelationship(tuple)).toThrow(FormatError);
  });

  it.each([
    ["2025-01-02T03:04:05Z", 0n],
    ["2025-01-02T03:04:05.123Z", 1_230_000n],
    ["2025-01-02T03:04:05.123456789Z", 1_234_567n],
  ])("Rfc3339_utc_expiration_is_accepted (%s)", (expiration, extraTicks) => {
    const rel = parseRelationship(`${PREFIX}[expiration:${expiration}]`);

    const expected = utc("2025-01-02T03:04:05Z") + extraTicks * NS_PER_TICK;
    expect(rel.optionalExpiration).toBe(expected);
  });

  it("Rfc3339_offset_expiration_is_converted_to_utc", () => {
    const rel = parseRelationship(`${PREFIX}[expiration:2025-01-02T03:04:05-01:00]`);

    expect(rel.optionalExpiration).toBe(utc("2025-01-02T04:04:05Z"));
  });

  it.each([
    ["2025-01-02T03:04:05-15:00", "2025-01-02T18:04:05Z"],
    ["2025-01-02T03:04:05-23:59", "2025-01-03T03:03:05Z"],
  ])("Offset_beyond_fourteen_hours_is_accepted_as_go_does (%s)", (expiration, expectedUtc) => {
    // Go's offset bound is wider than .NET's +/-14:00.
    const rel = parseRelationship(`${PREFIX}[expiration:${expiration}]`);

    expect(rel.optionalExpiration).toBe(utc(expectedUtc));
  });

  it.each([
    ["2025-01-02T3:04:05Z", "2025-01-02T03:04:05Z"],
    ["2025-01-02T3:04:05.5Z", "2025-01-02T03:04:05.5Z"],
    ["2025-01-02T03:04:05-24:00", "2025-01-03T03:04:05Z"],
    ["2025-01-02T03:04:05-01:60", "2025-01-02T05:04:05Z"],
    ["2025-01-02T03:04:05-24:60", "2025-01-03T04:04:05Z"],
  ])("Go_fallback_parser_forms_are_accepted (%s)", (expiration, expectedUtc) => {
    // When Go's strict RFC3339 fast path fails, time.Parse falls back to the general layout
    // parser, which reads the hour with one or two digits and bounds a numeric offset at
    // 24:60 rather than 23:59.
    const rel = parseRelationship(`${PREFIX}[expiration:${expiration}]`);

    expect(rel.optionalExpiration).toBe(utc(expectedUtc));
  });

  it.each([
    "2025-01-02T03:04:05-25:00",
    "2025-01-02T03:04:05-24:61",
    "2025-01-02T03:04:05-00:99",
    "2025-13-02T03:04:05Z",
    "2025-02-29T03:04:05Z",
    "2025-01-02T24:04:05Z",
    "2025-02-30T3:04:05Z",
    // Valid to Go, but not representable as a DateTimeOffset: year 0, and a UTC instant past 9999.
    "0000-01-01T00:00:00Z",
    "9999-12-31T23:30:00-01:00",
  ])("Out_of_range_expiration_is_rejected_without_throwing (%s)", (expiration) => {
    expect(tryParseRelationship(`${PREFIX}[expiration:${expiration}]`)).toBeUndefined();
  });

  it("Formatted_expiration_round_trips", () => {
    const original = createRelationship(
      { objectType: "doc", objectId: "1", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      undefined,
      utc("2025-01-02T03:04:05Z") + 1_234_567n * NS_PER_TICK,
    );

    const formatted = formatRelationship(original);
    const reparsed = parseRelationship(formatted);

    expect(reparsed).toEqual(original);
  });
});
