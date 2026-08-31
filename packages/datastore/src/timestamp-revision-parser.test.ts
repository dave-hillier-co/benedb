import { describe, expect, it } from "vitest";

import type { IRevisionParser } from "@benedb/core/i-revision-parser";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import type { ZedToken } from "@benedb/core/zed-token";
import { decodeRevision, zedTokenFromRevision } from "@benedb/core/zed-tokens";

import { TimestampRevisionParser } from "./timestamp-revision-parser";

// Port of Spiceport `TimestampRevisionParser.cs`. In Spiceport it has no test of its own: it is
// exercised through `RevisionResolverTests`' TokenRoundTrip cases, which obtain it via
// `ds.GetRevisionParser()` and decode through `ZedTokens`. `ReferenceDatastore` is not ported
// yet, so those two cases are carried across here at the level this batch can reach - the parser
// constructed directly with the id the datastore would have handed it - and re-ported in full
// against the datastore in `revision-resolver-tests.test.ts`.
//
// Port decisions pinned here:
//
// 1. It stays a CLASS with a primary-constructor-style field, not a bare function. It holds
//    state (`datastoreUniqueId`) and is handed across a boundary: in S3 `GrainBackedDatastore`
//    returns it FROM a grain method, so it is a type with behaviour crossing the wire and will
//    need a Thresh surrogate registered at that point. The reference datastore's use is
//    in-process, so no surrogate is registered here - but the shape must not degrade to a plain
//    object literal in the meantime, which is why the instance identity is asserted below.
//
// 2. `ParseRevisionString` delegates straight to `TimestampRevision.parse` and does NOTHING
//    else. In particular it does not catch: core's parse throws `SyntaxError` on a malformed
//    string and `RangeError` outside int64, and `decodeRevision` relies on catching exactly that
//    to report `ZedTokenStatus` "unknown". Swallowing or retyping the throw here makes the
//    unknown path unreachable, so the throw types are pinned.
function parserFor(datastoreUniqueId: string): TimestampRevisionParser {
  return new TimestampRevisionParser(datastoreUniqueId);
}

describe("TimestampRevisionParser", () => {
  it("exposes the datastore unique id it was constructed with", () => {
    const parser = parserFor("ds-1");

    expect(parser.datastoreUniqueId).toBe("ds-1");
  });

  it("carries the empty id verbatim rather than normalising it away", () => {
    // An empty id is the legacy-token case downstream; the parser must not substitute anything.
    expect(parserFor("").datastoreUniqueId).toBe("");
  });

  it("satisfies IRevisionParser", () => {
    const parser: IRevisionParser = parserFor("ds-1");

    expect(typeof parser.parseRevisionString).toBe("function");
  });

  it("is a class instance, not a plain object", () => {
    // Pinned because S3 returns this FROM a grain method: it must remain a nominal type with
    // behaviour so a surrogate can be registered for it there.
    expect(parserFor("ds-1")).toBeInstanceOf(TimestampRevisionParser);
  });

  it("parses the integer-nanos string form into a TimestampRevision", () => {
    const parsed = parserFor("ds-1").parseRevisionString("1700000000000000000");

    expect(parsed).toBeInstanceOf(TimestampRevision);
    expect((parsed as TimestampRevision).timestampNanosSinceEpoch).toBe(1700000000000000000n);
  });

  it("round-trips every revision the datastore mints as its string form", () => {
    const parser = parserFor("ds-1");
    const revisions = [
      new TimestampRevision(0n),
      new TimestampRevision(1n),
      new TimestampRevision(-1n),
      new TimestampRevision(1700000000000000000n),
      // The int64 bounds: a `long` in C#, so both extremes must survive the round trip. A
      // `number` would round both, which is why nanos are a bigint.
      new TimestampRevision(-9223372036854775808n),
      new TimestampRevision(9223372036854775807n),
    ];

    for (const revision of revisions) {
      const parsed = parser.parseRevisionString(revision.toString());

      expect(parsed.equals(revision)).toBe(true);
      expect(parsed.toString()).toBe(revision.toString());
    }
  });

  it("does not depend on the datastore id when parsing", () => {
    const a = parserFor("ds-1").parseRevisionString("42");
    const b = parserFor("ds-2").parseRevisionString("42");

    expect(a.equals(b)).toBe(true);
  });

  it("lets a SyntaxError from a malformed revision string escape", () => {
    const parser = parserFor("ds-1");

    // Every one of these is rejected by `long.Parse(s, NumberStyles.Integer)` but accepted by a
    // bare `BigInt()` or `Number()`, so the throw is what keeps the malformed path reachable.
    for (const malformed of ["", "   ", "abc", "0x2a", "1e9", "1.5", "1_000", "+-1", "12abc"]) {
      expect(() => parser.parseRevisionString(malformed)).toThrow(SyntaxError);
    }
  });

  it("lets a RangeError from an out-of-int64-range revision string escape", () => {
    const parser = parserFor("ds-1");

    for (const outOfRange of ["9223372036854775808", "-9223372036854775809"]) {
      expect(() => parser.parseRevisionString(outOfRange)).toThrow(RangeError);
    }
  });

  it("accepts the leading sign and surrounding whitespace NumberStyles.Integer allows", () => {
    const parser = parserFor("ds-1");

    expect(parser.parseRevisionString("  42  ").toString()).toBe("42");
    expect(parser.parseRevisionString("+42").toString()).toBe("42");
    expect(parser.parseRevisionString("-42").toString()).toBe("-42");
  });
});

// The two TokenRoundTrip cases from Spiceport's RevisionResolverTests, at the level this batch
// reaches: the parser is the piece that makes a minted token decode back to the committed
// revision, and its `datastoreUniqueId` is the piece that decides valid vs mismatched.
describe("TimestampRevisionParser through ZedTokens", () => {
  const uniqueId = "ds-1";

  it("decodes a token minted by this datastore back to the committed revision (TokenRoundTrip_MintedTokenDecodesToCommittedRevision)", () => {
    const committed = new TimestampRevision(1700000000000000000n);
    const token = zedTokenFromRevision(committed, undefined, uniqueId);

    const decoded = decodeRevision(token, parserFor(uniqueId));

    expect(decoded.status).toBe("valid");
    expect(decoded.revision.equals(committed)).toBe(true);
  });

  it("reports a token minted by a different datastore as mismatched (TokenRoundTrip_DifferentDatastoreId_DecodesAsMismatched)", () => {
    const committed = new TimestampRevision(1700000000000000000n);
    const foreign = zedTokenFromRevision(committed, undefined, "some-other-id");

    const decoded = decodeRevision(foreign, parserFor(uniqueId));

    expect(decoded.status).toBe("mismatchedDatastoreId");
    // The revision still parses: only the id decides the status.
    expect(decoded.revision.equals(committed)).toBe(true);
  });

  it("reports a token carrying an unparseable revision string as unknown", () => {
    // Hand-mint the payload `ZedTokens` produces, with a revision string the parser rejects.
    const token: ZedToken = {
      token: Buffer.from(["v1", uniqueId, "not-a-number", ""].join("\n"), "utf8").toString(
        "base64",
      ),
    };

    const decoded = decodeRevision(token, parserFor(uniqueId));

    // Reachable ONLY because `parseRevisionString` throws rather than returning a sentinel.
    expect(decoded.status).toBe("unknown");
  });

  it("reports a token carrying an out-of-int64-range revision string as unknown", () => {
    const token: ZedToken = {
      token: Buffer.from(["v1", uniqueId, "9223372036854775808", ""].join("\n"), "utf8").toString(
        "base64",
      ),
    };

    expect(decodeRevision(token, parserFor(uniqueId)).status).toBe("unknown");
  });
});
