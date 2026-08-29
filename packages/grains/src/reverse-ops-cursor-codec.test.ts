import { ELLIPSIS } from "@spacedb/core/core-constants";
import { FormatError } from "@spacedb/core/format-error";
import type { LookupResourcesCursor } from "@spacedb/engine/lookup-resources-cursor";
import { createLookupResourcesCursor } from "@spacedb/engine/lookup-resources-cursor";
import { describe, expect, it } from "vitest";

import {
  decodeLookupResourcesCursor,
  decodeSubjectId,
  encodeLookupResourcesCursor,
  encodeSubjectId,
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
 *   * Sections join on `;`, fields on `:`, per-section tags `L` (leaf: last resource id),
 *     `Q` (query: a six-field keyset) and `S` (structural: no payload).
 *   * Segments are `Uri.EscapeDataString`-escaped - NOT `encodeURIComponent`, which leaves `!'()*`
 *     alone - so the port reuses the same hand-rolled escape `GrainKeyCodec` uses.
 *   * The section split uses `RemoveEmptyEntries`, so a doubled or trailing `;` is TOLERATED;
 *     JavaScript's `split` keeps empties, so the port must filter them explicitly.
 *   * Field counts are EXACT: 3 for `L`, 2 for `S`, 8 for `Q`. Anything else is a `FormatException`
 *     naming the offending section.
 *   * `int.TryParse(fields[0])` uses the DEFAULT number styles here - a leading sign and
 *     surrounding whitespace are accepted - UNLIKE `PreconditionMessages`, which passes
 *     `NumberStyles.None`. The two parses must not be unified.
 *   * The KEYSET FIELD ORDER is asymmetric on purpose: encoded Subject-then-Resource, decoded back
 *     as Resource from `p[3..5]` and Subject from `p[0..2]`. A "tidying" swap here silently resumes
 *     a lookup at the wrong place.
 *   * `EncodeSubjectId`/`DecodeSubjectId` are a bare base64 of the id with NO version tag.
 *   * `string.IsNullOrWhiteSpace` guards the decode, and the .NET and JavaScript whitespace sets
 *     DIFFER - this is the "start from the beginning" vs "decode" decision, so the .NET set is
 *     what the port must implement.
 */
describe("reverse ops cursor codec", () => {
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

  // base64("0:L:doc%3A1%2Fx;-1:S;7:Q:user:alice:...:document:d%201:viewer")
  const token =
    "MDpMOmRvYyUzQTElMkZ4Oy0xOlM7NzpROnVzZXI6YWxpY2U6Li4uOmRvY3VtZW50OmQlMjAxOnZpZXdlcg==";

  const base64Of = (raw: string): string => Buffer.from(raw, "utf8").toString("base64");
  const rawOf = (encoded: string): string => Buffer.from(encoded, "base64").toString("utf8");

  it("encodes the exact token, standard base64 alphabet and padding included", () => {
    expect(encodeLookupResourcesCursor(cursor)).toBe(token);
  });

  it("encodes the keyset SUBJECT first and the RESOURCE second", () => {
    const raw = rawOf(token);

    expect(raw).toBe("0:L:doc%3A1%2Fx;-1:S;7:Q:user:alice:...:document:d%201:viewer");
    expect(raw.split(";")[2]).toBe("7:Q:user:alice:...:document:d%201:viewer");
  });

  it("decodes the pinned token back to the same cursor, keyset halves the right way round", () => {
    expect(decodeLookupResourcesCursor(token)).toEqual(cursor);
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

    const encoded = encodeLookupResourcesCursor(awkward);
    expect(encoded).toBeDefined();
    expect(decodeLookupResourcesCursor(encoded)).toEqual(awkward);
  });

  it("escapes with Uri.EscapeDataString, not encodeURIComponent", () => {
    // `encodeURIComponent` leaves `!'()*` unescaped; .NET escapes everything outside the RFC 3986
    // unreserved set. The token is a wire value, so the difference is observable.
    const encoded = encodeLookupResourcesCursor(
      createLookupResourcesCursor([{ entrypointIndex: 0, lastResourceId: "a!'()*b" }]),
    );

    expect(rawOf(encoded ?? "")).toBe("0:L:a%21%27%28%29%2Ab");
  });

  // .NET's `char.IsWhiteSpace` covers NBSP (U+00A0) and NEL (U+0085); JavaScript's own whitespace
  // set covers NBSP but not NEL, so a port that reaches for `trim()` decides U+0085 the wrong way.
  it.each([[undefined], [""], [" "], ["\t"], ["\n"], ["\u00a0"], ["\u0085"]])(
    "treats the whitespace-only token %j as 'from the beginning'",
    (empty) => {
      expect(decodeLookupResourcesCursor(empty)).toBeUndefined();
      expect(decodeSubjectId(empty)).toBeUndefined();
    },
  );

  it("does NOT treat U+FEFF as whitespace, because .NET's char.IsWhiteSpace does not", () => {
    // JavaScript's own `trim` DOES strip U+FEFF, so a port written with `token.trim() === ""`
    // would answer "from the beginning" where Spiceport attempts a decode and fails.
    expect(() => decodeLookupResourcesCursor("\ufeff")).toThrow(FormatError);
  });

  it("encodes an absent cursor as absent", () => {
    expect(encodeLookupResourcesCursor(undefined)).toBeUndefined();
  });

  it("encodes a section-less cursor as absent", () => {
    expect(encodeLookupResourcesCursor({ sections: [] })).toBeUndefined();
  });

  it("decodes to absent when every section entry is empty", () => {
    expect(decodeLookupResourcesCursor(base64Of(";;"))).toBeUndefined();
  });

  it("tolerates doubled and trailing section separators, as RemoveEmptyEntries does", () => {
    const decoded = decodeLookupResourcesCursor(base64Of("0:S;;1:S;"));

    expect(decoded?.sections).toEqual([{ entrypointIndex: 0 }, { entrypointIndex: 1 }]);
  });

  it("accepts a signed and whitespace-padded entrypoint index, as the default styles do", () => {
    const decoded = decodeLookupResourcesCursor(base64Of(" +12 :S"));

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
    expect(() => decodeLookupResourcesCursor(base64Of(`${ws}3:S`))).toThrow(FormatError);
    expect(() => decodeLookupResourcesCursor(base64Of(`3${ws}:S`))).toThrow(FormatError);
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
  ])("throws a format error naming the section for %s", (_case, raw) => {
    const bad = base64Of(raw);

    expect(() => decodeLookupResourcesCursor(bad)).toThrow(FormatError);
    expect(() => decodeLookupResourcesCursor(bad)).toThrow(
      `Malformed lookup-resources cursor section: '${raw}'.`,
    );
  });

  it("rejects a token that is not valid base64 rather than truncating it", () => {
    // `Buffer.from(s, "base64")` skips invalid characters and truncates; `Convert.FromBase64String`
    // throws. A silently truncated cursor resumes a lookup at a fabricated position.
    expect(() => decodeLookupResourcesCursor("MDpT!!")).toThrow(FormatError);
  });

  describe("subject id tokens", () => {
    it("encodes a bare base64 of the id, with no version tag", () => {
      expect(encodeSubjectId("alice")).toBe("YWxpY2U=");
    });

    it("round-trips ids with non-ASCII and base64-significant characters", () => {
      for (const id of ["alice", "café", "a+b/c=", "*"]) {
        expect(decodeSubjectId(encodeSubjectId(id))).toBe(id);
      }
    });
  });
});
