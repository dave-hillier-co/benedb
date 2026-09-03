import { ELLIPSIS } from "@benedb/core/core-constants";
import type { LookupResourcesCursor } from "@benedb/engine/lookup-resources-cursor";
import { createLookupResourcesCursor } from "@benedb/engine/lookup-resources-cursor";
import { describe, expect, it } from "vitest";

import { InvalidCursorException } from "./invalid-cursor-exception";
import {
  decodeLookupResourcesCursor,
  decodeSubjectId,
  encodeLookupResourcesCursor,
  encodeSubjectId,
  requestShapeHashLookupResources,
  requestShapeHashLookupSubjects,
} from "./reverse-ops-cursor-codec";

/**
 * NO COVERING C# TEST - only `ReverseOpsMeshTests` (a later slice) touches this codec in Spiceport,
 * so these byte-exact characterization tests are its only gate. Characterized from
 * `src/Spiceport.Server/Grains/ReverseOpsCursorCodec.cs`.
 *
 * CONTRADICTION RESOLVED IN FAVOUR OF THE CODE. The C# doc comment claims "URL-safe base64", but
 * `ToToken` calls `Convert.ToBase64String`, which is STANDARD base64 with `+`, `/` and `=`
 * padding. The token is what a client hands back, so the CODE is the contract and the comment is
 * the bug; the exact-token cases below pin the standard alphabet.
 *
 * The rest of the contract, verbatim from the C#:
 *   * Every token is `base64(requestHash + '\n' + payload)`: the request-shape hash prefix binds
 *     the token to the originating request (op kind, resource/permission, subject, caveat context)
 *     plus the schema hash at the pinned revision. A malformed token, a missing separator, or a
 *     mismatched hash is an `InvalidCursorException` - never a silent resume.
 *   * Sections join on `;`, fields on `:`, per-section tags `L` (leaf: last resource id),
 *     `Q` (query: a six-field keyset) and `S` (structural: no payload).
 *   * Segments are `Uri.EscapeDataString`-escaped - NOT `encodeURIComponent`, which leaves `!'()*`
 *     alone - so the port reuses the same hand-rolled escape `GrainKeyCodec` uses.
 *   * The section split uses `RemoveEmptyEntries`, so a doubled or trailing `;` is TOLERATED;
 *     JavaScript's `split` keeps empties, so the port must filter them explicitly.
 *   * Field counts are EXACT: 3 for `L`, 2 for `S`, 8 for `Q`. Anything else is an
 *     `InvalidCursorException` naming the offending section.
 *   * `int.TryParse(fields[0])` uses the DEFAULT number styles here - a leading sign and
 *     surrounding whitespace are accepted - UNLIKE `PreconditionMessages`, which passes
 *     `NumberStyles.None`. The two parses must not be unified.
 *   * The KEYSET FIELD ORDER is asymmetric on purpose: encoded Subject-then-Resource, decoded back
 *     as Resource from `p[3..5]` and Subject from `p[0..2]`. A "tidying" swap here silently resumes
 *     a lookup at the wrong place.
 *   * `string.IsNullOrWhiteSpace` guards the decode, and the .NET and JavaScript whitespace sets
 *     DIFFER - this is the "start from the beginning" vs "decode" decision, so the .NET set is
 *     what the port must implement.
 */
describe("reverse ops cursor codec", () => {
  // A stand-in request-shape hash with the real production shape: 12 bytes as lowercase hex.
  const HASH = "0123456789abcdef01234567";

  const cursor: LookupResourcesCursor = createLookupResourcesCursor([
    { entrypointIndex: 0, lastResourceId: "doc:1/x" },
    { entrypointIndex: -1 },
    {
      entrypointIndex: 7,
      afterKeyset: {
        resource: { objectType: "document", objectId: "d 1", relation: "viewer" },
        subject: { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      },
    },
  ]);

  const rawPayload = "0:L:doc%3A1%2Fx;-1:S;7:Q:user:alice:...:document:d%201:viewer";

  const base64Of = (raw: string): string => Buffer.from(raw, "utf8").toString("base64");
  const rawOf = (encoded: string): string => Buffer.from(encoded, "base64").toString("utf8");
  /** `ToToken(raw, HASH)`: the request-shape hash prefix, then `'\n'`, then the payload. */
  const tokenOf = (raw: string): string => base64Of(`${HASH}\n${raw}`);

  const token = tokenOf(rawPayload);

  it("encodes the exact hash-prefixed token, standard base64 alphabet and padding included", () => {
    expect(encodeLookupResourcesCursor(cursor, HASH)).toBe(token);
  });

  it("encodes the keyset SUBJECT first and the RESOURCE second, after the hash prefix", () => {
    const raw = rawOf(token);

    expect(raw).toBe(`${HASH}\n${rawPayload}`);
    expect(raw.split("\n")[1]?.split(";")[2]).toBe("7:Q:user:alice:...:document:d%201:viewer");
  });

  it("decodes the pinned token back to the same cursor, keyset halves the right way round", () => {
    expect(decodeLookupResourcesCursor(token, HASH)).toEqual(cursor);
  });

  it("round-trips ids that need escaping in every section kind", () => {
    const awkward = createLookupResourcesCursor([
      { entrypointIndex: 3, lastResourceId: "a;b:c/d%e" },
      {
        entrypointIndex: 4,
        afterKeyset: {
          resource: { objectType: "doc;s", objectId: "id:1", relation: "view/er" },
          subject: { objectType: "us er", objectId: "café", relation: ELLIPSIS },
        },
      },
    ]);

    const encoded = encodeLookupResourcesCursor(awkward, HASH);
    expect(encoded).toBeDefined();
    expect(decodeLookupResourcesCursor(encoded, HASH)).toEqual(awkward);
  });

  it("escapes with Uri.EscapeDataString, not encodeURIComponent", () => {
    // `encodeURIComponent` leaves `!'()*` unescaped; .NET escapes everything outside the RFC 3986
    // unreserved set. The token is a wire value, so the difference is observable.
    const encoded = encodeLookupResourcesCursor(
      createLookupResourcesCursor([{ entrypointIndex: 0, lastResourceId: "a!'()*b" }]),
      HASH,
    );

    expect(rawOf(encoded ?? "")).toBe(`${HASH}\n0:L:a%21%27%28%29%2Ab`);
  });

  // .NET's `char.IsWhiteSpace` covers NBSP (U+00A0) and NEL (U+0085); JavaScript's own whitespace
  // set covers NBSP but not NEL, so a port that reaches for `trim()` decides U+0085 the wrong way.
  it.each([[undefined], [""], [" "], ["\t"], ["\n"], ["\u00a0"], ["\u0085"]])(
    "treats the whitespace-only token %j as 'from the beginning'",
    (empty) => {
      expect(decodeLookupResourcesCursor(empty, HASH)).toBeUndefined();
      expect(decodeSubjectId(empty, HASH)).toBeUndefined();
    },
  );

  it("does NOT treat U+FEFF as whitespace, because .NET's char.IsWhiteSpace does not", () => {
    // JavaScript's own `trim` DOES strip U+FEFF, so a port written with `token.trim() === ""`
    // would answer "from the beginning" where Spiceport attempts a decode and fails.
    expect(() => decodeLookupResourcesCursor("\ufeff", HASH)).toThrow(InvalidCursorException);
  });

  it("encodes an absent cursor as absent", () => {
    expect(encodeLookupResourcesCursor(undefined, HASH)).toBeUndefined();
  });

  it("encodes a section-less cursor as absent", () => {
    expect(encodeLookupResourcesCursor({ sections: [] }, HASH)).toBeUndefined();
  });

  it("decodes to absent when every section entry is empty", () => {
    expect(decodeLookupResourcesCursor(tokenOf(";;"), HASH)).toBeUndefined();
  });

  it("tolerates doubled and trailing section separators, as RemoveEmptyEntries does", () => {
    const decoded = decodeLookupResourcesCursor(tokenOf("0:S;;1:S;"), HASH);

    expect(decoded?.sections).toEqual([{ entrypointIndex: 0 }, { entrypointIndex: 1 }]);
  });

  it("accepts a signed and whitespace-padded entrypoint index, as the default styles do", () => {
    const decoded = decodeLookupResourcesCursor(tokenOf(" +12 :S"), HASH);

    expect(decoded?.sections[0]?.entrypointIndex).toBe(12);
  });

  // The two whitespace sets in this file are NOT the same set, and the difference is
  // wire-visible. `string.IsNullOrWhiteSpace` (the empty-token guard) uses `char.IsWhiteSpace`,
  // which reports true for every character below; `int.TryParse` under `NumberStyles.Integer`
  // strips only U+0020 and U+0009-U+000D, so it REJECTS all of them. Verified on dotnet 10.0.102.
  // Sharing the wider class between the two accepts a cursor .NET refuses, and the token is
  // client-supplied: the decode would resume at a fabricated entrypoint index rather than throw.
  it.each([
    ["NBSP (U+00A0)", "\u00a0"],
    ["NEL (U+0085)", "\u0085"],
    ["OGHAM SPACE MARK (U+1680)", "\u1680"],
    ["EN QUAD (U+2000)", "\u2000"],
    ["NARROW NO-BREAK SPACE (U+202F)", "\u202f"],
    ["IDEOGRAPHIC SPACE (U+3000)", "\u3000"],
  ])("rejects %s around the entrypoint index, which int.TryParse does not strip", (_case, ws) => {
    expect(() => decodeLookupResourcesCursor(tokenOf(`${ws}3:S`), HASH)).toThrow(
      InvalidCursorException,
    );
    expect(() => decodeLookupResourcesCursor(tokenOf(`3${ws}:S`), HASH)).toThrow(
      InvalidCursorException,
    );
  });

  it.each([
    ["a section with one field", "0"],
    ["a non-numeric entrypoint index", "abc:S"],
    ["a hex entrypoint index the default styles reject", "0x1:S"],
    ["a leaf section with the wrong field count", "0:L"],
    ["a leaf section with too many fields", "0:L:a:b"],
    ["a structural section with a payload", "0:S:a"],
    ["a query section with the wrong field count", "0:Q:a:b:c:d:e"],
    ["an unknown section tag", "0:Z:a"],
  ])("throws an invalid-cursor error naming the section for %s", (_case, raw) => {
    const bad = tokenOf(raw);

    expect(() => decodeLookupResourcesCursor(bad, HASH)).toThrow(InvalidCursorException);
    expect(() => decodeLookupResourcesCursor(bad, HASH)).toThrow(
      `Malformed lookup-resources cursor section: '${raw}'.`,
    );
  });

  it("rejects a token that is not valid base64 rather than truncating it", () => {
    // `Buffer.from(s, "base64")` skips invalid characters and truncates; `Convert.FromBase64String`
    // throws. A silently truncated cursor resumes a lookup at a fabricated position.
    expect(() => decodeLookupResourcesCursor("MDpT!!", HASH)).toThrow(InvalidCursorException);
    expect(() => decodeLookupResourcesCursor("MDpT!!", HASH)).toThrow(
      "invalid cursor: token is malformed",
    );
  });

  it("rejects a well-formed base64 token that carries no hash separator", () => {
    expect(() => decodeLookupResourcesCursor(base64Of("0:S"), HASH)).toThrow(
      "invalid cursor: token is malformed",
    );
  });

  it("rejects a token minted for a different request shape", () => {
    const minted = encodeLookupResourcesCursor(cursor, HASH);
    expect(() => decodeLookupResourcesCursor(minted, "fedcba9876543210fedcba98")).toThrow(
      "cursor does not apply to this request: it was created for a different set of arguments",
    );
  });

  describe("subject id tokens", () => {
    it("encodes the hash prefix, the separator, then the bare id", () => {
      expect(encodeSubjectId("alice", HASH)).toBe(tokenOf("alice"));
    });

    it("round-trips ids with non-ASCII and base64-significant characters", () => {
      for (const id of ["alice", "café", "a+b/c=", "*"]) {
        expect(decodeSubjectId(encodeSubjectId(id, HASH), HASH)).toBe(id);
      }
    });

    it("rejects a subject token minted for a different request shape", () => {
      expect(() =>
        decodeSubjectId(encodeSubjectId("alice", HASH), "fedcba9876543210fedcba98"),
      ).toThrow(InvalidCursorException);
    });
  });

  describe("request shape hashes", () => {
    const subjectsArgs = {
      resourceType: "document",
      resourceId: "readme",
      permission: "view",
      subjectType: "user",
      subjectRelation: ELLIPSIS,
      context: undefined,
      limit: 2,
      cursor: undefined,
    };

    const resourcesArgs = {
      resourceType: "document",
      permission: "view",
      subjectType: "user",
      subjectId: "alice",
      subjectRelation: ELLIPSIS,
      context: undefined,
      limit: 2,
      cursor: undefined,
    };

    const schemaHash = "a".repeat(64);

    it("is 12 bytes of the SHA-256 as lowercase hex", () => {
      expect(requestShapeHashLookupSubjects(subjectsArgs, schemaHash)).toMatch(/^[0-9a-f]{24}$/);
      expect(requestShapeHashLookupResources(resourcesArgs, schemaHash)).toMatch(/^[0-9a-f]{24}$/);
    });

    it("is deterministic for equal shapes and excludes limit and cursor", () => {
      // Limit and consistency are deliberately excluded: a client may change the page size or
      // re-pin between pages of the same logical request.
      const paged = { ...subjectsArgs, limit: 99, cursor: "anything" };
      expect(requestShapeHashLookupSubjects(paged, schemaHash)).toBe(
        requestShapeHashLookupSubjects(subjectsArgs, schemaHash),
      );
    });

    it("changes with the permission, the schema hash, and the caveat context", () => {
      const base = requestShapeHashLookupSubjects(subjectsArgs, schemaHash);
      expect(
        requestShapeHashLookupSubjects({ ...subjectsArgs, permission: "edit" }, schemaHash),
      ).not.toBe(base);
      expect(requestShapeHashLookupSubjects(subjectsArgs, "b".repeat(64))).not.toBe(base);
      expect(
        requestShapeHashLookupSubjects(
          { ...subjectsArgs, context: new Map<string, unknown>([["flag", true]]) },
          schemaHash,
        ),
      ).not.toBe(base);
    });

    it("canonicalizes the context: key insertion order does not change the hash", () => {
      const ab = new Map<string, unknown>([
        ["a", 1],
        ["b", "x"],
      ]);
      const ba = new Map<string, unknown>([
        ["b", "x"],
        ["a", 1],
      ]);
      expect(requestShapeHashLookupSubjects({ ...subjectsArgs, context: ab }, schemaHash)).toBe(
        requestShapeHashLookupSubjects({ ...subjectsArgs, context: ba }, schemaHash),
      );
    });

    it("keeps the two op kinds' hashes distinct even over aligned fields", () => {
      // "LR" vs "LS" is the leading field of the hashed shape, so a LookupSubjects cursor can
      // never resume a LookupResources walk that happens to share every other segment.
      expect(requestShapeHashLookupSubjects(subjectsArgs, schemaHash)).not.toBe(
        requestShapeHashLookupResources(resourcesArgs, schemaHash),
      );
    });
  });
});
