import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "./core-constants";
import { FormatError } from "./format-error";
import type { ObjectAndRelation } from "./object-and-relation";
import { createRelationship, type Relationship } from "./relationship";
import {
  formatObjectAndRelation,
  formatRelationship,
  isValidResourceId,
  isValidSubjectId,
  parseObjectAndRelation,
  parseRelationship,
  tryParseObjectAndRelation,
  tryParseRelationship,
} from "./tuple-strings";

// Characterization of Spiceport `TupleStrings` (no covering C# test), and with it the
// mutually recursive ONR / RelationshipReference / Relationship string graph: in C# both
// `ObjectAndRelation.ToString` and `Relationship.ToString` delegate here, and this module
// constructs all three types back out of a string. Every expectation below was taken from the
// real Spiceport assembly, not inferred from the source.
//
// Every byte here is wire-visible and the conformance corpus asserts on it. The hazards this
// file exists to pin, and the port decisions taken:
//
//   * .NET `$` in a non-Multiline regex matches at end-of-string OR immediately before a single
//     trailing "\n". JS `$` without /m does not. A naive port would reject
//     "document:doc#viewer\n", which Spiceport accepts. Append "\n?" before "$".
//   * .NET `\d` matches any Unicode Nd; JS `\d` is ASCII-only. This appears in the expiration
//     sub-expression `[\d\-\.:TZ]+`. Spiceport rejects Arabic-Indic digits anyway, because
//     `DateTimeOffset.TryParse` then fails, so ASCII-only `\d` reproduces the observable
//     behaviour; the test below pins the outcome rather than the mechanism.
//   * The namespace, relation and caveat-name sub-expressions have a MINIMUM LENGTH OF 3
//     ([a-z] + {1,62} + [a-z0-9]) and a maximum of 64. Two-character namespaces, relations and
//     caveat names are invalid. Do not "simplify" the quantifiers.
//   * The expiration format is always 7 fractional digits and always "Z", after conversion to
//     UTC - `Date.prototype.toISOString` gives 3, so it must be padded.
//   * The caveat context is serialized the way `System.Text.Json` does with its default
//     JavaScriptEncoder: "<", ">", "&", "+", "'" and '"' become \uXXXX with UPPERCASE hex, as
//     does every non-ASCII character; "\\", "\t" and "\n" keep their short escapes; and keys
//     keep dictionary insertion order.
//   * Expiration is nanoseconds since the Unix epoch as a `bigint` (see relationship.test.ts).
//     `DateTimeOffset` resolution is 100ns, so parsing rounds to the nearest 100ns tick.
//
// Two deliberate divergences from Spiceport, both pinned explicitly below so they cannot drift
// in silently:
//   * JSON number literals are NOT preserved through a parse/format round trip. C# deserializes
//     into `JsonElement`, which re-emits the source literal, so "1.0" survives as "1.0";
//     `JSON.parse` yields the number 1 and re-emits "1".
const onr = (objectType: string, objectId: string, relation: string): ObjectAndRelation => ({
  objectType,
  objectId,
  relation,
});

const doc = onr("document", "doc", "viewer");
const alice = onr("user", "alice", ELLIPSIS);

/** 2023-12-01T00:00:00Z, in nanoseconds since the Unix epoch. */
const dec1 = BigInt(Date.UTC(2023, 11, 1)) * 1_000_000n;

const ctx = (entries: [string, unknown][]): ReadonlyMap<string, unknown> => new Map(entries);

const expectParsed = (value: string): Relationship => {
  const parsed = tryParseRelationship(value);
  expect(parsed, `expected ${JSON.stringify(value)} to parse`).toBeDefined();
  return parsed as Relationship;
};

describe("formatObjectAndRelation", () => {
  it("formats namespace:object_id#relation", () => {
    expect(formatObjectAndRelation(doc)).toBe("document:doc#viewer");
  });

  it("elides an ellipsis relation", () => {
    expect(formatObjectAndRelation(alice)).toBe("user:alice");
    expect(formatObjectAndRelation(onr("user", "*", ELLIPSIS))).toBe("user:*");
  });

  it("keeps a non-ellipsis subject relation", () => {
    expect(formatObjectAndRelation(onr("group", "g", "member"))).toBe("group:g#member");
  });

  it("does not validate what it formats", () => {
    expect(formatObjectAndRelation(onr("Doc", "", "Viewer"))).toBe("Doc:#Viewer");
  });
});

describe("formatRelationship", () => {
  it("joins the resource and subject with @", () => {
    expect(formatRelationship(createRelationship(doc, alice))).toBe(
      "document:doc#viewer@user:alice",
    );
  });

  it("keeps a subject subrelation", () => {
    expect(formatRelationship(createRelationship(doc, onr("group", "g", "member")))).toBe(
      "document:doc#viewer@group:g#member",
    );
  });

  it("formats a wildcard subject", () => {
    expect(formatRelationship(createRelationship(doc, onr("user", "*", ELLIPSIS)))).toBe(
      "document:doc#viewer@user:*",
    );
  });

  describe("caveats", () => {
    it("emits a bare caveat when there is no context", () => {
      expect(formatRelationship(createRelationship(doc, alice, { caveatName: "cav" }))).toBe(
        "document:doc#viewer@user:alice[cav]",
      );
    });

    it("treats an empty context exactly like an absent one", () => {
      expect(
        formatRelationship(createRelationship(doc, alice, { caveatName: "cav", context: ctx([]) })),
      ).toBe("document:doc#viewer@user:alice[cav]");
    });

    it("omits the whole caveat when the name is empty", () => {
      expect(
        formatRelationship(
          createRelationship(doc, alice, { caveatName: "", context: ctx([["a", 1]]) }),
        ),
      ).toBe("document:doc#viewer@user:alice");
    });

    it("emits the context as JSON after a colon", () => {
      expect(
        formatRelationship(
          createRelationship(doc, alice, { caveatName: "cav", context: ctx([["a", 1]]) }),
        ),
      ).toBe('document:doc#viewer@user:alice[cav:{"a":1}]');
    });

    it("preserves key insertion order, including integer-like keys", () => {
      // A plain JS object would renumber these to 1, 2, 10. The value type uses a Map for
      // exactly this reason.
      const caveat = {
        caveatName: "cav",
        context: ctx([
          ["2", 1],
          ["10", 2],
          ["1", 3],
          ["b", 4],
          ["a", 5],
        ]),
      };

      expect(formatRelationship(createRelationship(doc, alice, caveat))).toBe(
        'document:doc#viewer@user:alice[cav:{"2":1,"10":2,"1":3,"b":4,"a":5}]',
      );
    });

    it("escapes the way System.Text.Json's default encoder does", () => {
      const caveat = { caveatName: "cav", context: ctx([["html", "a<b>&c+d'e\"f\\g"]]) };

      expect(formatRelationship(createRelationship(doc, alice, caveat))).toBe(
        String.raw`document:doc#viewer@user:alice[cav:{"html":"a\u003Cb\u003E\u0026c\u002Bd\u0027e\u0022f\\g"}]`,
      );
    });

    it("escapes non-ASCII as \\uXXXX with uppercase hex", () => {
      const caveat = { caveatName: "cav", context: ctx([["a", "café 中"]]) };

      expect(formatRelationship(createRelationship(doc, alice, caveat))).toBe(
        String.raw`document:doc#viewer@user:alice[cav:{"a":"caf\u00E9 \u4E2D"}]`,
      );
    });

    it("keeps the short escapes for tab and newline", () => {
      const caveat = { caveatName: "cav", context: ctx([["a", "x\ty\nz"]]) };

      expect(formatRelationship(createRelationship(doc, alice, caveat))).toBe(
        String.raw`document:doc#viewer@user:alice[cav:{"a":"x\ty\nz"}]`,
      );
    });

    it("emits numbers, booleans, null, lists and nested maps", () => {
      const caveat = {
        caveatName: "cav",
        context: ctx([
          ["num", 42],
          ["fl", 1.5],
          ["b", true],
          ["nil", null],
          ["list", [1, "two", null]],
          ["nested", ctx([["x", [1, 2]]])],
        ]),
      };

      expect(formatRelationship(createRelationship(doc, alice, caveat))).toBe(
        "document:doc#viewer@user:alice" +
          '[cav:{"num":42,"fl":1.5,"b":true,"nil":null,"list":[1,"two",null],"nested":{"x":[1,2]}}]',
      );
    });
  });

  describe("expirations", () => {
    it("always emits 7 fractional digits and a Z suffix", () => {
      expect(formatRelationship(createRelationship(doc, alice, undefined, dec1))).toBe(
        "document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00.0000000Z]",
      );
    });

    it("emits sub-millisecond ticks", () => {
      const rel = createRelationship(doc, alice, undefined, dec1 + 123_456_700n);

      expect(formatRelationship(rel)).toBe(
        "document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00.1234567Z]",
      );
    });

    it("emits UTC regardless of the instant's origin", () => {
      // 2023-12-01T05:00:00+02:00 is 03:00:00Z.
      const rel = createRelationship(doc, alice, undefined, dec1 + 3n * 3_600_000_000_000n);

      expect(formatRelationship(rel)).toBe(
        "document:doc#viewer@user:alice[expiration:2023-12-01T03:00:00.0000000Z]",
      );
    });

    it("puts the caveat before the expiration", () => {
      const rel = createRelationship(
        doc,
        alice,
        { caveatName: "cav", context: ctx([["a", 1]]) },
        dec1,
      );

      expect(formatRelationship(rel)).toBe(
        'document:doc#viewer@user:alice[cav:{"a":1}][expiration:2023-12-01T00:00:00.0000000Z]',
      );
    });

    it("does not emit integrity metadata", () => {
      const rel = createRelationship(doc, alice, undefined, undefined, {
        keyId: "k",
        hash: new Uint8Array([1]),
        hashedAt: dec1,
      });

      expect(formatRelationship(rel)).toBe("document:doc#viewer@user:alice");
    });
  });
});

describe("tryParseObjectAndRelation", () => {
  it.each([
    ["document:doc#viewer", ["document", "doc", "viewer"]],
    ["abc:1#viewer", ["abc", "1", "viewer"]],
    ["org/team:1#member", ["org/team", "1", "member"]],
    ["document:a-b_c|d=e+f/g#viewer", ["document", "a-b_c|d=e+f/g", "viewer"]],
    ["document:doc#view_er", ["document", "doc", "view_er"]],
  ])("parses %s", (value, expected) => {
    expect(tryParseObjectAndRelation(value)).toEqual(
      onr(expected[0] as string, expected[1] as string, expected[2] as string),
    );
  });

  it("accepts a single trailing newline, as .NET's non-multiline $ does", () => {
    expect(tryParseObjectAndRelation("document:doc#viewer\n")).toEqual(doc);
  });

  it("rejects anything more than one trailing newline", () => {
    expect(tryParseObjectAndRelation("document:doc#viewer\n\n")).toBeUndefined();
    expect(tryParseObjectAndRelation("document:doc#viewer\r\n")).toBeUndefined();
  });

  it.each([
    ["a bare object with no relation", "document:doc"],
    ["an ellipsis relation", "document:doc#..."],
    ["a two-character relation", "doc:1#vi"],
    ["a two-character namespace", "do:1#viewer"],
    ["a namespace one short of the minimum", "ab:1#viewer"],
    ["a second relation separator", "document:doc#viewer#x"],
    ["an uppercase namespace", "Document:doc#viewer"],
    ["an uppercase relation", "document:doc#Viewer"],
    ["a wildcard resource id", "document:*#viewer"],
    ["a relation ending in an underscore", "document:doc#viewer_"],
    ["a relation starting with an underscore", "document:doc#_viewer"],
    ["a Cyrillic homoglyph in the relation", "document:doc#viеwer"],
    ["Arabic-Indic digits in the object id", "document:١٢٣#viewer"],
    ["a leading space", " document:doc#viewer"],
    ["an empty string", ""],
  ])("rejects %s", (_name, value) => {
    expect(tryParseObjectAndRelation(value)).toBeUndefined();
  });

  it("bounds the namespace and relation at 64 characters", () => {
    const a64 = "a".repeat(64);
    const a65 = "a".repeat(65);

    expect(tryParseObjectAndRelation(`${a64}:x#viewer`)).toBeDefined();
    expect(tryParseObjectAndRelation(`${a65}:x#viewer`)).toBeUndefined();
    expect(tryParseObjectAndRelation(`document:x#${a64}`)).toBeDefined();
    expect(tryParseObjectAndRelation(`document:x#${a65}`)).toBeUndefined();
  });

  it("does not bound the object id, unlike isValidResourceId", () => {
    expect(tryParseObjectAndRelation(`document:${"a".repeat(2000)}#viewer`)).toBeDefined();
  });
});

describe("parseObjectAndRelation", () => {
  it("returns the ONR when valid", () => {
    expect(parseObjectAndRelation("document:doc#viewer")).toEqual(doc);
  });

  it("throws a FormatError carrying the offending value", () => {
    expect(() => parseObjectAndRelation("nope")).toThrow(FormatError);
    expect(() => parseObjectAndRelation("nope")).toThrow(
      "invalid object and relation string: 'nope'",
    );
  });
});

describe("tryParseRelationship", () => {
  it("parses a bare relationship, defaulting the subject relation to the ellipsis", () => {
    const rel = expectParsed("document:doc#viewer@user:alice");

    expect(rel.reference).toEqual({ resource: doc, subject: alice });
    expect(rel.optionalCaveat).toBeUndefined();
    expect(rel.optionalExpiration).toBeUndefined();
  });

  it("accepts an explicit ellipsis subject relation and normalizes it away on format", () => {
    const rel = expectParsed("document:doc#viewer@user:alice#...");

    expect(rel.reference.subject.relation).toBe(ELLIPSIS);
    expect(formatRelationship(rel)).toBe("document:doc#viewer@user:alice");
  });

  it("parses a subject subrelation", () => {
    expect(expectParsed("document:doc#viewer@group:g#member").reference.subject).toEqual(
      onr("group", "g", "member"),
    );
  });

  it.each([
    ["a wildcard subject", "document:doc#viewer@user:*", ["user", "*", ELLIPSIS]],
    [
      "a wildcard subject with an explicit ellipsis",
      "document:doc#viewer@user:*#...",
      ["user", "*", ELLIPSIS],
    ],
    [
      "a wildcard subject with a subrelation",
      "document:doc#viewer@user:*#member",
      ["user", "*", "member"],
    ],
    [
      "a namespaced subject type",
      "document:doc#viewer@org/team:1#member",
      ["org/team", "1", "member"],
    ],
  ])("parses %s", (_name, value, expected) => {
    expect(expectParsed(value).reference.subject).toEqual(
      onr(expected[0] as string, expected[1] as string, expected[2] as string),
    );
  });

  it("accepts a single trailing newline", () => {
    expect(expectParsed("document:doc#viewer@user:alice\n").reference.subject).toEqual(alice);
    expect(expectParsed('document:doc#viewer@user:alice[cav:{"a":1}]\n').optionalCaveat).toEqual({
      caveatName: "cav",
      context: ctx([["a", 1]]),
    });
  });

  it.each([
    ["a wildcard resource", "document:*#viewer@user:alice"],
    ["a missing subject", "document:doc#viewer[somecaveat]"],
    ["a two-character subject relation", "document:doc#viewer@user:alice#.."],
    ["trailing content", 'document:doc#viewer@user:alice[cav:{"a":1}]extra'],
    ["a leading space", " document:doc#viewer@user:alice"],
    ["a trailing space", "document:doc#viewer@user:alice "],
    [
      "the expiration before the caveat",
      "document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00Z][cav]",
    ],
  ])("rejects %s", (_name, value) => {
    expect(tryParseRelationship(value)).toBeUndefined();
  });

  describe("caveats", () => {
    it("parses a bare caveat with no context", () => {
      const rel = expectParsed("document:doc#viewer@user:alice[cav]");

      expect(rel.optionalCaveat).toEqual({ caveatName: "cav" });
      expect(rel.optionalCaveat?.context).toBeUndefined();
    });

    it("parses a context object", () => {
      const rel = expectParsed('document:doc#viewer@user:alice[cav:{"a":1,"b":"x"}]');

      expect(rel.optionalCaveat?.caveatName).toBe("cav");
      expect([...(rel.optionalCaveat?.context ?? [])]).toEqual([
        ["a", 1],
        ["b", "x"],
      ]);
    });

    it("parses a nested context", () => {
      const rel = expectParsed('document:doc#viewer@user:alice[cav:{"a":{"b":[1,2]}}]');

      expect(formatRelationship(rel)).toBe('document:doc#viewer@user:alice[cav:{"a":{"b":[1,2]}}]');
    });

    it("parses a namespaced caveat name", () => {
      expect(
        expectParsed('document:doc#viewer@user:alice[org/cav:{"a":1}]').optionalCaveat?.caveatName,
      ).toBe("org/cav");
    });

    it("allows brackets inside a context string value", () => {
      const rel = expectParsed('document:doc#viewer@user:alice[cav:{"a":"[x]"}]');

      expect(rel.optionalCaveat?.context?.get("a")).toBe("[x]");
    });

    it("accepts a whitespace-only context object as an empty context", () => {
      // `\{(.+)\}` needs at least one character between the braces, so "{ }" matches where "{}"
      // does not; the deserialized context is then empty and formatting drops it entirely.
      const rel = expectParsed("document:doc#viewer@user:alice[cav:{ }]");

      expect(rel.optionalCaveat?.context?.size).toBe(0);
      expect(formatRelationship(rel)).toBe("document:doc#viewer@user:alice[cav]");
    });

    it.each([
      ["an empty context object", "document:doc#viewer@user:alice[cav:{}]"],
      ["a two-character caveat name", "document:doc#viewer@user:alice[ca]"],
      ["an uppercase caveat name", "document:doc#viewer@user:alice[Cav]"],
      ["a non-object context", "document:doc#viewer@user:alice[cav:[1]]"],
      ["malformed JSON", "document:doc#viewer@user:alice[cav:{not json}]"],
      ["a space before the closing bracket", 'document:doc#viewer@user:alice[cav:{"a":1} ]'],
    ])("rejects %s", (_name, value) => {
      expect(tryParseRelationship(value)).toBeUndefined();
    });
  });

  describe("expirations", () => {
    it("parses an RFC3339 instant into epoch nanoseconds", () => {
      const rel = expectParsed("document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00Z]");

      expect(rel.optionalExpiration).toBe(dec1);
    });

    it("parses sub-millisecond ticks", () => {
      const rel = expectParsed(
        "document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00.1234567Z]",
      );

      expect(rel.optionalExpiration).toBe(dec1 + 123_456_700n);
    });

    it("rounds beyond 100ns resolution, as DateTimeOffset does", () => {
      const rel = expectParsed(
        "document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00.1234567890Z]",
      );

      expect(rel.optionalExpiration).toBe(dec1 + 123_456_800n);
      expect(formatRelationship(rel)).toBe(
        "document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00.1234568Z]",
      );
    });

    it("accepts a date with no time, assuming midnight UTC", () => {
      expect(
        expectParsed("document:doc#viewer@user:alice[expiration:2023-12-01]").optionalExpiration,
      ).toBe(dec1);
    });

    it("accepts a local-looking instant with no zone, assuming UTC", () => {
      // DateTimeStyles.AssumeUniversal: an unzoned value is UTC, not machine-local.
      expect(
        expectParsed("document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00]")
          .optionalExpiration,
      ).toBe(dec1);
    });

    // DateTimeStyles.AdjustToUniversal: a negative numeric offset is honoured and normalized
    // to UTC. This is wire-visible — SpiceDB parses expirations with `time.RFC3339Nano`, whose
    // `Z07:00` layout element accepts a numeric offset as well as "Z" — even though neither
    // implementation ever emits the offset form itself.
    it.each([
      ["an extended negative offset", "2023-11-30T19:00:00-05:00"],
      ["a compact negative offset", "2023-11-30T19:00:00-0500"],
      ["an offset with minutes", "2023-11-30T20:30:00-0330"],
      ["a negative offset with a fraction", "2023-11-30T19:00:00.0000000-05:00"],
    ])("honours %s, normalizing to UTC", (_name, instant) => {
      expect(
        expectParsed(`document:doc#viewer@user:alice[expiration:${instant}]`).optionalExpiration,
      ).toBe(dec1);
    });

    it.each([
      ["an out-of-range year", "document:doc#viewer@user:alice[expiration:99999-12-01T00:00:00Z]"],
      ["an impossible month", "document:doc#viewer@user:alice[expiration:2023-13-01T00:00:00Z]"],
      [
        // Rejected by the tuple expression, not the instant parser: "+" is absent from the
        // expiration character class `[\d\-\.:TZ]+`, so a positive offset never reaches it.
        // Negative offsets do, and are honoured — see the acceptance cases above.
        "a positive zone offset, which the expiration character class excludes",
        "document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00+02:00]",
      ],
      ["punctuation only", "document:doc#viewer@user:alice[expiration:....]"],
      ["a bare T", "document:doc#viewer@user:alice[expiration:T]"],
      ["an empty expiration", "document:doc#viewer@user:alice[expiration:]"],
      ["Arabic-Indic digits", "document:doc#viewer@user:alice[expiration:٢٠٢٣-12-01T00:00:00Z]"],
    ])("rejects %s", (_name, value) => {
      expect(tryParseRelationship(value)).toBeUndefined();
    });

    it("parses a caveat and an expiration together", () => {
      const rel = expectParsed(
        'document:doc#viewer@user:alice[cav:{"a":1}][expiration:2023-12-01T00:00:00Z]',
      );

      expect(rel.optionalCaveat?.caveatName).toBe("cav");
      expect(rel.optionalExpiration).toBe(dec1);
    });
  });

  it("never populates integrity metadata", () => {
    expect(expectParsed("document:doc#viewer@user:alice").optionalIntegrity).toBeUndefined();
  });
});

describe("parseRelationship", () => {
  it("returns the relationship when valid", () => {
    expect(parseRelationship("document:doc#viewer@user:alice").reference).toEqual({
      resource: doc,
      subject: alice,
    });
  });

  it("throws a FormatError carrying the offending value", () => {
    expect(() => parseRelationship("nope")).toThrow(FormatError);
    expect(() => parseRelationship("nope")).toThrow("invalid relationship string: 'nope'");
  });
});

describe("round trips", () => {
  it.each([
    "document:doc#viewer@user:alice",
    "document:doc#viewer@user:*",
    "document:doc#viewer@group:g#member",
    "document:firstdoc#viewer@user:tracy",
    "document:doc#viewer@user:alice[cav]",
    'document:doc#viewer@user:alice[cav:{"a":1}]',
    'document:doc#viewer@user:alice[somecaveat:{"somecondition":42}]',
    'document:doc#viewer@user:alice[cav:{"a":{"b":[1,2]}}]',
    "org/team:1#member@org/user:2#...",
  ])("re-emits %s unchanged", (value) => {
    // "org/team:1#member@org/user:2#..." formats back without the explicit ellipsis, so it is
    // compared against its own re-parse rather than the input.
    const once = formatRelationship(parseRelationship(value));

    expect(formatRelationship(parseRelationship(once))).toBe(once);
    if (!value.includes("#...")) expect(once).toBe(value);
  });

  it("normalizes an expiration to 7 fractional digits", () => {
    expect(
      formatRelationship(
        parseRelationship("document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00Z]"),
      ),
    ).toBe("document:doc#viewer@user:alice[expiration:2023-12-01T00:00:00.0000000Z]");
  });

  it("does NOT preserve JSON number literals - a deliberate divergence from Spiceport", () => {
    // C# deserializes context values into JsonElement, which re-emits the source literal, so
    // Spiceport round-trips '{"a":1.0,"b":1e3,"c":0.50}' byte for byte. JSON.parse yields plain
    // numbers, so the port re-emits their canonical forms. Pinned here so the divergence is a
    // decision on the record rather than a surprise in the differential suite.
    expect(
      formatRelationship(
        parseRelationship('document:doc#viewer@user:alice[cav:{"a":1.0,"b":1e3,"c":0.50}]'),
      ),
    ).toBe('document:doc#viewer@user:alice[cav:{"a":1,"b":1000,"c":0.5}]');
  });

  it("re-escapes a unicode escape in the source with uppercase hex", () => {
    expect(
      formatRelationship(
        parseRelationship('document:doc#viewer@user:alice[cav:{"a":"caf\\u00e9"}]'),
      ),
    ).toBe(String.raw`document:doc#viewer@user:alice[cav:{"a":"caf\u00E9"}]`);
  });
});

describe("isValidResourceId", () => {
  it.each([
    ["a", true],
    ["A", true],
    ["1", true],
    ["a/b", true],
    ["a|b", true],
    ["a-b", true],
    ["a=b", true],
    ["a+b", true],
    ["a_b", true],
    ["*", false],
    ["**", false],
    ["a*", false],
    ["a b", false],
    ["a.b", false],
    ["", false],
    ["ünïcode", false],
  ])("%s -> %s", (value, expected) => {
    expect(isValidResourceId(value)).toBe(expected);
  });

  it("accepts a single trailing newline, as .NET's non-multiline $ does", () => {
    expect(isValidResourceId("a\n")).toBe(true);
    expect(isValidResourceId("a\nb")).toBe(false);
  });

  it("bounds the length at 1024 UTF-16 code units", () => {
    expect(isValidResourceId("a".repeat(1024))).toBe(true);
    expect(isValidResourceId("a".repeat(1025))).toBe(false);
  });
});

describe("isValidSubjectId", () => {
  it.each([
    ["a", true],
    ["*", true],
    ["a/b", true],
    ["a|b", true],
    ["a-b", true],
    ["a=b", true],
    ["a+b", true],
    ["**", false],
    ["a*", false],
    ["a b", false],
    ["a.b", false],
    ["", false],
    ["ünïcode", false],
  ])("%s -> %s", (value, expected) => {
    expect(isValidSubjectId(value)).toBe(expected);
  });

  it("accepts a single trailing newline after a wildcard", () => {
    expect(isValidSubjectId("*\n")).toBe(true);
    expect(isValidSubjectId("a\n")).toBe(true);
  });

  it("bounds the length at 1024 UTF-16 code units", () => {
    expect(isValidSubjectId("a".repeat(1024))).toBe(true);
    expect(isValidSubjectId("a".repeat(1025))).toBe(false);
  });
});
