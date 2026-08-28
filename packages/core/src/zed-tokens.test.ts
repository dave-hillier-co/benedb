import { describe, expect, it } from "vitest";

import { InvalidArgumentError } from "./invalid-argument-error";
import type { IRevisionParser } from "./i-revision-parser";
import { TimestampRevision } from "./timestamp-revision";
import type { ZedToken } from "./zed-token";
import { decodeRevision, zedTokenFromRevision } from "./zed-tokens";

// Characterization of Spiceport `ZedTokens` / `ZedToken` / `DecodedRevision` /
// `ZedTokenStatus` / `IRevisionParser` (no covering C# test).
//
// Port decisions pinned here:
//
// 1. THE WIRE FORMAT IS EXACT. A token is base64 of the UTF-8 of
//        v1\n{datastoreId}\n{revisionString}\n{schemaHash}
//    with the middle two possibly empty, standard padded base64, no line breaks. Tokens are
//    handed to clients and come back later, so the literal base64 vectors below are the format.
//
// 2. THE CRITICAL RUNTIME DIVERGENCE. `Convert.FromBase64String` THROWS on malformed input, and
//    that throw is the ONLY way a token reaches status "unknown" before parsing. Node's
//    `Buffer.from(s, "base64")` never throws: it silently SKIPS characters outside the alphabet
//    and accepts a truncated final group, so a token .NET rejects decodes to something that
//    parses cleanly and is reported valid. The port must validate the encoding itself. .NET's
//    decoder does ignore WHITESPACE, so whitespace is not a rejection - the cases below pin both
//    sides of that line.
//
// 3. The status enum becomes a string-literal union (house style; it is not a proto enum, so
//    unlike `UpdateOperation` there is no wire-number map).
//
// 4. On any failure `Unknown()` returns `new TimestampRevision(0)` as a SENTINEL revision - a
//    real, epoch-valued revision that must never be read. Callers branch on status, never on the
//    revision. Pinned here so the sentinel is not "improved" into undefined.
//
// 5. The `catch (Exception) when (IsParseException())` filter is a quirk: `IsParseException()`
//    always returns true, so it is a plain catch-all around the parser call. Note the schema hash
//    IS carried through that failure path, while the base64 failure path has no hash to carry.

const parser: IRevisionParser = {
  datastoreUniqueId: "ds-1",
  parseRevisionString: (revisionString) => TimestampRevision.parse(revisionString),
};

const token = (value: string): ZedToken => ({ token: value });

describe("zed tokens", () => {
  describe("zedTokenFromRevision", () => {
    it("mints base64 of `v1\\n{datastoreId}\\n{revision}\\n{schemaHash}`", () => {
      const minted = zedTokenFromRevision(new TimestampRevision(42n), "sha-abc", "ds-1");

      expect(minted.token).toBe("djEKZHMtMQo0MgpzaGEtYWJj");
      expect(Buffer.from(minted.token, "base64").toString("utf8")).toBe("v1\nds-1\n42\nsha-abc");
    });

    it("leaves the datastore id and schema hash EMPTY, not absent, when omitted", () => {
      const minted = zedTokenFromRevision(new TimestampRevision(1234567890123456789n));

      expect(minted.token).toBe("djEKCjEyMzQ1Njc4OTAxMjM0NTY3ODkK");
      expect(Buffer.from(minted.token, "base64").toString("utf8")).toBe(
        "v1\n\n1234567890123456789\n",
      );
    });

    it("emits an empty trailing field for a missing schema hash", () => {
      const minted = zedTokenFromRevision(new TimestampRevision(42n), undefined, "ds-1");

      expect(minted.token).toBe("djEKZHMtMQo0Mgo=");
    });

    it("emits standard padded base64 with no line breaks", () => {
      const minted = zedTokenFromRevision(new TimestampRevision(42n), undefined, "ds");

      expect(minted.token).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(minted.token.length % 4).toBe(0);
    });

    it("uses the revision's own string form, so a foreign revision type mints too", () => {
      const foreign = {
        byteSortable: false,
        toString: () => "in-process",
        compareTo: () => 0,
        equals: () => false,
        greaterThan: () => false,
      };

      const minted = zedTokenFromRevision(foreign, undefined, "ds");

      expect(Buffer.from(minted.token, "base64").toString("utf8")).toBe("v1\nds\nin-process\n");
    });

    it("rejects a missing revision", () => {
      expect(() => zedTokenFromRevision(undefined as unknown as TimestampRevision)).toThrow(
        InvalidArgumentError,
      );
    });
  });

  describe("decodeRevision", () => {
    it("round-trips a minted token", () => {
      const minted = zedTokenFromRevision(
        new TimestampRevision(1700000000123456789n),
        "sha",
        "ds-1",
      );

      const decoded = decodeRevision(minted, parser);

      expect(decoded.status).toBe("valid");
      expect(decoded.schemaHash).toBe("sha");
      expect(decoded.revision.equals(new TimestampRevision(1700000000123456789n))).toBe(true);
    });

    it("reports legacyEmptyDatastoreId when the token carries no datastore id", () => {
      const decoded = decodeRevision(token("djEKCjQyCg=="), parser);

      expect(decoded.status).toBe("legacyEmptyDatastoreId");
      expect(decoded.revision.toString()).toBe("42");
      expect(decoded.schemaHash).toBeUndefined();
    });

    it("reports mismatchedDatastoreId for another datastore's token", () => {
      const decoded = decodeRevision(token("djEKb3RoZXItZHMKNDIKc2hh"), parser);

      expect(decoded.status).toBe("mismatchedDatastoreId");
      expect(decoded.revision.toString()).toBe("42");
      expect(decoded.schemaHash).toBe("sha");
    });

    it("decodes an empty schema hash to undefined, not an empty string", () => {
      const decoded = decodeRevision(token("djEKZHMtMQo0Mgo="), parser);

      expect(decoded.status).toBe("valid");
      expect(decoded.schemaHash).toBeUndefined();
    });

    it("compares the datastore id verbatim - it is case- and whitespace-sensitive", () => {
      const minted = zedTokenFromRevision(new TimestampRevision(42n), undefined, "DS-1");

      expect(decodeRevision(minted, parser).status).toBe("mismatchedDatastoreId");
    });
  });

  describe("decodeRevision, malformed input", () => {
    const expectUnknown = (value: string) => {
      const decoded = decodeRevision(token(value), parser);
      expect(decoded.status).toBe("unknown");
      return decoded;
    };

    it("returns a TimestampRevision(0) SENTINEL, never a missing revision", () => {
      const decoded = expectUnknown("not a token!!");

      expect(decoded.revision).toBeInstanceOf(TimestampRevision);
      expect(decoded.revision.toString()).toBe("0");
      expect(decoded.schemaHash).toBeUndefined();
    });

    it("rejects a character outside the base64 alphabet that Node would silently SKIP", () => {
      // Node decodes this to the byte-identical valid payload "v1\nds-1\n42\nsha-abc" by
      // dropping the '!'. .NET throws FormatException. Without an explicit validator this case
      // reports "valid" and the unknown path is unreachable.
      expect(Buffer.from("djEKZ!HMtMQo0MgpzaGEtYWJj", "base64").toString("utf8")).toBe(
        "v1\nds-1\n42\nsha-abc",
      );

      expectUnknown("djEKZ!HMtMQo0MgpzaGEtYWJj");
    });

    it("rejects a base64url character, which Node accepts as a different alphabet", () => {
      expectUnknown("djEK-HMtMQo0MgpzaGEtYWJj");
    });

    it("rejects a length that is not a multiple of 4, which Node truncates instead", () => {
      // Node yields "v1\nds-1\n42\nsha-ab" - a plausible token with a corrupted schema hash.
      expect(Buffer.from("djEKZHMtMQo0MgpzaGEtYWJ", "base64").toString("utf8")).toBe(
        "v1\nds-1\n42\nsha-ab",
      );

      expectUnknown("djEKZHMtMQo0MgpzaGEtYWJ");
    });

    it("rejects data after the padding", () => {
      expectUnknown("djEKZHMtMQo0Mgo=A");
    });

    it("treats an empty token as unknown, because the empty payload has one field", () => {
      expectUnknown("");
    });

    it("ACCEPTS embedded whitespace, because .NET's base64 decoder ignores it", () => {
      const decoded = decodeRevision(token("djEK\nZHMtMQo0MgpzaGEtYWJj"), parser);

      expect(decoded.status).toBe("valid");
      expect(decoded.revision.toString()).toBe("42");
    });

    it("rejects an unrecognised version marker", () => {
      expectUnknown("djIKZHMKNDIK");
    });

    it("rejects a payload with too few fields", () => {
      expectUnknown("djEKZHMKNDI=");
    });

    it("rejects a payload with too many fields - the format has no escaping", () => {
      const minted = zedTokenFromRevision(new TimestampRevision(42n), "sha\nextra", "ds-1");

      expectUnknown(minted.token);
    });

    it("rejects bytes that are not valid UTF-8, via the replacement characters they decode to", () => {
      expectUnknown(Buffer.from([0xff, 0xfe, 0xfd, 0xfc]).toString("base64"));
    });
  });

  describe("decodeRevision, parser failure", () => {
    it("is unknown when the revision string does not parse, but KEEPS the schema hash", () => {
      const decoded = decodeRevision(token("djEKZHMtMQpub3QtYS1udW1iZXIKc2hh"), parser);

      expect(decoded.status).toBe("unknown");
      expect(decoded.schemaHash).toBe("sha");
      expect(decoded.revision.toString()).toBe("0");
    });

    it("swallows ANY parser exception, not just a parse-shaped one", () => {
      const hostile: IRevisionParser = {
        datastoreUniqueId: "ds-1",
        parseRevisionString: () => {
          throw new TypeError("boom");
        },
      };

      expect(decodeRevision(token("djEKZHMtMQo0MgpzaGEtYWJj"), hostile).status).toBe("unknown");
    });

    it("does not consult the parser's datastore id when the revision fails to parse", () => {
      const decoded = decodeRevision(token("djEKb3RoZXItZHMKbm90LWEtbnVtYmVyCnNoYQ=="), parser);

      expect(decoded.status).toBe("unknown");
    });
  });
});
