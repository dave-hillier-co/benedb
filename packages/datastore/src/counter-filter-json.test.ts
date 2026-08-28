import { describe, expect, it } from "vitest";

import { deserializeCounterFilter, serializeCounterFilter } from "./counter-filter-json";
import type { RelationshipsFilter } from "./relationships-filter";

// Characterization of Spiceport `CounterFilterJson.cs`. There is NO covering test anywhere in
// Spiceport - grep finds zero references outside the file itself - and this is the only file in
// its batch whose exact BYTES are wire-visible: it is the persisted `core.RelationshipFilter`
// shape SpiceDB stores for a registered counter. So the bytes are pinned here, against the
// output of the real .NET serializer.
//
// Port decisions pinned here:
//
// 1. `SerializeToUtf8Bytes` returns `byte[]`, so the port returns a `Uint8Array`, never a
//    string. Text crosses via TextEncoder/TextDecoder.
//
// 2. `DefaultIgnoreCondition = WhenWritingNull` plus System.Text.Json's DECLARATION-order
//    property emission fixes the key order at rt, rid, rpfx, rrel, st, sid, srel and omits
//    absent members entirely. `JSON.stringify` drops undefined-valued keys and preserves
//    insertion order, so building the object literal in exactly that order reproduces it.
//
// 3. `JavaScriptEncoder.Default` escapes strictly MORE than `JSON.stringify` does: `&`, `'`,
//    `+`, `<`, `>`, backtick, `"` (as ", not \"), DEL, and EVERY non-ASCII character, all
//    as \uXXXX with UPPERCASE hex. Only the backslash and \b \t \n \f \r keep their short
//    forms. Resource-id prefixes are arbitrary user input, so the encoder has to be
//    hand-rolled; the escaping tests below are the gate on that.
//
// 4. The round-trip is deliberately LOSSY and ASYMMETRIC. Serialize keeps only ids[0] and
//    selectors[0] and drops the caveat/expiration/multi-selector residual (a registered counter
//    has none); Deserialize rebuilds single-element lists. Neither direction is "improved" here.
//
// 5. Deserialize builds a selector list only when at least one of st/sid/srel is present, and a
//    relation filter only when srel is present. Absent and empty stay distinct.
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("counter filter json - serialize", () => {
  it("writes every member in declaration order", () => {
    const filter: RelationshipsFilter = {
      optionalResourceType: "document",
      optionalResourceIds: ["doc1"],
      optionalResourceIdPrefix: "doc",
      optionalResourceRelation: "viewer",
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: "user",
          optionalSubjectIds: ["alice"],
          relationFilter: { nonEllipsisRelation: "member" },
        },
      ],
    };

    expect(decode(serializeCounterFilter(filter))).toBe(
      '{"rt":"document","rid":"doc1","rpfx":"doc","rrel":"viewer","st":"user","sid":"alice","srel":"member"}',
    );
  });

  it("returns UTF-8 bytes, not a string", () => {
    const bytes = serializeCounterFilter({ optionalResourceType: "document" });

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toEqual(encode('{"rt":"document"}'));
  });

  it("omits absent members entirely", () => {
    expect(decode(serializeCounterFilter({}))).toBe("{}");
    expect(
      decode(
        serializeCounterFilter({
          optionalResourceRelation: "viewer",
          optionalSubjectsSelectors: [{ optionalSubjectType: "user" }],
        }),
      ),
    ).toBe('{"rrel":"viewer","st":"user"}');
  });

  it("writes an empty string member rather than omitting it", () => {
    // WhenWritingNull omits nulls only; "" is a value.
    expect(decode(serializeCounterFilter({ optionalResourceType: "" }))).toBe('{"rt":""}');
  });

  it("omits the id when the id list is present but empty", () => {
    // The C# guard is `is { Count: > 0 }`, so an empty list is not "an empty id" - it is no id
    // at all.
    expect(decode(serializeCounterFilter({ optionalResourceIds: [] }))).toBe("{}");
    expect(decode(serializeCounterFilter({ optionalSubjectsSelectors: [] }))).toBe("{}");
  });

  it("keeps only the first resource id", () => {
    expect(decode(serializeCounterFilter({ optionalResourceIds: ["doc1", "doc2"] }))).toBe(
      '{"rid":"doc1"}',
    );
  });

  it("keeps only the first subjects selector", () => {
    const filter: RelationshipsFilter = {
      optionalSubjectsSelectors: [
        { optionalSubjectType: "user", optionalSubjectIds: ["alice", "bob"] },
        { optionalSubjectType: "group" },
      ],
    };

    expect(decode(serializeCounterFilter(filter))).toBe('{"st":"user","sid":"alice"}');
  });

  it("writes nothing for a selector that constrains nothing", () => {
    expect(decode(serializeCounterFilter({ optionalSubjectsSelectors: [{}] }))).toBe("{}");
  });

  it("takes the subject relation only from nonEllipsisRelation", () => {
    const filter: RelationshipsFilter = {
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: "user",
          relationFilter: { includeEllipsisRelation: true, onlyNonEllipsisRelations: true },
        },
      ],
    };

    expect(decode(serializeCounterFilter(filter))).toBe('{"st":"user"}');
  });

  it("drops the caveat and expiration residual", () => {
    const filter: RelationshipsFilter = {
      optionalResourceType: "document",
      optionalCaveatNameFilter: { option: "hasMatchingCaveat", caveatName: "some_caveat" },
      optionalExpirationOption: "hasExpiration",
    };

    expect(decode(serializeCounterFilter(filter))).toBe('{"rt":"document"}');
  });

  it("escapes exactly as JavaScriptEncoder.Default does", () => {
    // Pinned against real System.Text.Json output. Plain `JSON.stringify` leaves &, ', +, <, >,
    // backtick and non-ASCII unescaped and writes the quote as \" - every one of those
    // differences is a wire break.
    const filter: RelationshipsFilter = {
      optionalResourceIdPrefix: "a&b'c+d<e>f`gé日\"h\\i\n",
    };

    expect(decode(serializeCounterFilter(filter))).toBe(
      '{"rpfx":"a\\u0026b\\u0027c\\u002Bd\\u003Ce\\u003Ef\\u0060g\\u00E9\\u65E5\\u0022h\\\\i\\n"}',
    );
  });

  it("escapes astral characters as an escaped UTF-16 surrogate pair", () => {
    expect(decode(serializeCounterFilter({ optionalResourceIds: ["x\u{1f600}y"] }))).toBe(
      '{"rid":"x\\uD83D\\uDE00y"}',
    );
  });

  it("keeps the short escapes for the control characters that have them", () => {
    const controls = "\b\t\n\f\r\u0001\u001f\u007f";

    expect(decode(serializeCounterFilter({ optionalResourceType: controls }))).toBe(
      '{"rt":"\\b\\t\\n\\f\\r\\u0001\\u001F\\u007F"}',
    );
  });

  it("leaves the unescaped ASCII punctuation alone", () => {
    const punctuation = " !#$%()*,-./:;=?@[]^_{|}~";

    expect(decode(serializeCounterFilter({ optionalResourceType: punctuation }))).toBe(
      `{"rt":"${punctuation}"}`,
    );
  });
});

describe("counter filter json - deserialize", () => {
  it("rebuilds every member, with single-element lists", () => {
    const filter = deserializeCounterFilter(
      encode(
        '{"rt":"document","rid":"doc1","rpfx":"doc","rrel":"viewer","st":"user","sid":"alice","srel":"member"}',
      ),
    );

    expect(filter).toEqual({
      optionalResourceType: "document",
      optionalResourceIds: ["doc1"],
      optionalResourceIdPrefix: "doc",
      optionalResourceRelation: "viewer",
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: "user",
          optionalSubjectIds: ["alice"],
          relationFilter: { nonEllipsisRelation: "member" },
        },
      ],
    });
  });

  it("round-trips a single-id, single-selector filter unchanged", () => {
    const filter: RelationshipsFilter = {
      optionalResourceType: "document",
      optionalResourceIds: ["doc1"],
      optionalResourceRelation: "viewer",
      optionalSubjectsSelectors: [{ optionalSubjectType: "user", optionalSubjectIds: ["alice"] }],
    };

    expect(deserializeCounterFilter(serializeCounterFilter(filter))).toEqual(filter);
  });

  it("round-trips lossily for a multi-id, multi-selector filter", () => {
    const filter: RelationshipsFilter = {
      optionalResourceIds: ["doc1", "doc2"],
      optionalSubjectsSelectors: [
        { optionalSubjectType: "user", optionalSubjectIds: ["alice", "bob"] },
        { optionalSubjectType: "group" },
      ],
    };

    expect(deserializeCounterFilter(serializeCounterFilter(filter))).toEqual({
      optionalResourceType: undefined,
      optionalResourceIds: ["doc1"],
      optionalResourceIdPrefix: undefined,
      optionalResourceRelation: undefined,
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: "user",
          optionalSubjectIds: ["alice"],
          relationFilter: undefined,
        },
      ],
    });
  });

  it("builds no selector list when no subject member is present", () => {
    const filter = deserializeCounterFilter(encode('{"rt":"document"}'));

    expect(filter.optionalSubjectsSelectors).toBeUndefined();
  });

  it("builds a selector when only the subject id is present", () => {
    const filter = deserializeCounterFilter(encode('{"sid":"alice"}'));

    expect(filter.optionalSubjectsSelectors).toEqual([
      {
        optionalSubjectType: undefined,
        optionalSubjectIds: ["alice"],
        relationFilter: undefined,
      },
    ]);
  });

  it("builds a selector when only the subject relation is present", () => {
    const filter = deserializeCounterFilter(encode('{"srel":"member"}'));

    expect(filter.optionalSubjectsSelectors).toEqual([
      {
        optionalSubjectType: undefined,
        optionalSubjectIds: undefined,
        relationFilter: { nonEllipsisRelation: "member" },
      },
    ]);
  });

  it("builds no relation filter when the subject relation is absent", () => {
    const filter = deserializeCounterFilter(encode('{"st":"user"}'));

    expect(filter.optionalSubjectsSelectors?.[0]?.relationFilter).toBeUndefined();
  });

  it("treats an empty-string subject member as present", () => {
    // `poco.SubjectType is not null` - "" is not null, so a selector IS built.
    const filter = deserializeCounterFilter(encode('{"st":""}'));

    expect(filter.optionalSubjectsSelectors).toEqual([
      {
        optionalSubjectType: "",
        optionalSubjectIds: undefined,
        relationFilter: undefined,
      },
    ]);
  });

  it("yields an all-absent filter for an empty object", () => {
    expect(deserializeCounterFilter(encode("{}"))).toEqual({
      optionalResourceType: undefined,
      optionalResourceIds: undefined,
      optionalResourceIdPrefix: undefined,
      optionalResourceRelation: undefined,
      optionalSubjectsSelectors: undefined,
    });
  });

  it("falls back to an all-absent filter for the JSON null literal", () => {
    // `JsonSerializer.Deserialize<CounterFilterJson>` returns null for `null` and the C# falls
    // back to `new CounterFilterJson()`. `JSON.parse("null")` yields null, so the port must keep
    // that fallback rather than dereferencing it.
    expect(deserializeCounterFilter(encode("null"))).toEqual({
      optionalResourceType: undefined,
      optionalResourceIds: undefined,
      optionalResourceIdPrefix: undefined,
      optionalResourceRelation: undefined,
      optionalSubjectsSelectors: undefined,
    });
  });

  it("treats an explicit JSON null the same as an absent member", () => {
    const filter = deserializeCounterFilter(encode('{"rt":null,"sid":"alice"}'));

    expect(filter.optionalResourceType).toBeUndefined();
    expect(filter.optionalSubjectsSelectors?.[0]?.optionalSubjectIds).toEqual(["alice"]);
  });

  it("ignores unknown properties and is case-sensitive on known ones", () => {
    // System.Text.Json's defaults: unmatched members are skipped, and matching is
    // case-sensitive, so "RID" does NOT populate ResourceId.
    const filter = deserializeCounterFilter(encode('{"rt":"document","zz":1,"RID":"x"}'));

    expect(filter.optionalResourceType).toBe("document");
    expect(filter.optionalResourceIds).toBeUndefined();
  });

  it("decodes the escapes the serializer wrote", () => {
    const prefix = "a&b'c+d<e>f`gé日\"h\\i\n\u{1f600}";

    expect(
      deserializeCounterFilter(serializeCounterFilter({ optionalResourceIdPrefix: prefix }))
        .optionalResourceIdPrefix,
    ).toBe(prefix);
  });

  it("throws on a member of the wrong JSON type", () => {
    // Verified against System.Text.Json 10: a non-string, non-null value for a `string?` member
    // throws JsonException. Coercing it to "absent" instead would be silently dangerous, not
    // merely lax - an all-absent RelationshipsFilter matches EVERY relationship, so a corrupt
    // persisted counter filter would count the whole store rather than fail.
    expect(() => deserializeCounterFilter(encode('{"rt":5}'))).toThrow();
    expect(() => deserializeCounterFilter(encode('{"sid":true}'))).toThrow();
    expect(() => deserializeCounterFilter(encode('{"srel":["member"]}'))).toThrow();
  });

  it("throws on a non-object root that is not the null literal", () => {
    // Verified against System.Text.Json 10: `5`, `true` and `[]` all throw JsonException, while
    // `null` alone returns null and takes the empty-POCO fallback above.
    expect(() => deserializeCounterFilter(encode("5"))).toThrow();
    expect(() => deserializeCounterFilter(encode("true"))).toThrow();
    expect(() => deserializeCounterFilter(encode('"doc"'))).toThrow();
    expect(() => deserializeCounterFilter(encode("[]"))).toThrow();
  });

  it("throws on malformed JSON", () => {
    // `JsonSerializer.Deserialize` throws JsonException on truncated or empty input; the port
    // must not silently yield an empty filter there.
    expect(() => deserializeCounterFilter(encode("{"))).toThrow();
    expect(() => deserializeCounterFilter(encode(""))).toThrow();
  });
});
