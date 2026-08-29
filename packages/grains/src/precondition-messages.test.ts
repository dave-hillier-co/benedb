import type { RelationshipsFilter } from "@spacedb/datastore/relationships-filter";
import { describe, expect, it } from "vitest";

import type { PreconditionFailureKind } from "./precondition-failed-exception";
import {
  mustMatchFailedMessage,
  mustNotMatchFailedMessage,
  tryParsePreconditionFailure,
} from "./precondition-messages";

// No covering C# test. `PreconditionMessages.cs` is a BYTE-EXACT MESSAGE CONTRACT, so this is the
// only gate it will have until the API layer lands: `DatastoreGrain.commit` returns the text as
// `CommitFailureWire.detail`, and the relationships grain parses it back into a
// `PreconditionFailedException(kind, index, message)` that must be indistinguishable from the one
// the historical inline evaluation threw. The message a `zed` caller sees is unchanged, so a stray
// space or a reordered field is a compatibility break, not a cosmetic one.
//
// The parse side is the C#'s
// `int.TryParse(..., NumberStyles.None, CultureInfo.InvariantCulture)`: DIGITS ONLY. No sign, no
// whitespace, no group separators, no exponent, and the empty span fails. `Number` and `parseInt`
// accept most of those, so the malformed cases below are the point of this file.

const empty: RelationshipsFilter = {};

const everything: RelationshipsFilter = {
  optionalResourceType: "document",
  optionalResourceIds: ["doc1", "doc2"],
  optionalResourceIdPrefix: "doc",
  optionalResourceRelation: "viewer",
  optionalSubjectsSelectors: [
    { optionalSubjectType: "user", optionalSubjectIds: ["alice", "bob"] },
    { optionalSubjectType: "group", optionalSubjectIds: ["eng"] },
  ],
  optionalCaveatNameFilter: { option: "hasMatchingCaveat", caveatName: "only_on_tuesday" },
  optionalExpirationOption: "hasExpiration",
};

describe("precondition failure messages", () => {
  it("formats a MUST_MATCH failure verbatim", () => {
    const message = mustMatchFailedMessage(0, { optionalResourceType: "document" });

    expect(message).toBe(
      "precondition 0 failed: MUST_MATCH filter [resource_type=document] matched no relationships",
    );
  });

  it("formats a MUST_NOT_MATCH failure verbatim", () => {
    const message = mustNotMatchFailedMessage(0, { optionalResourceType: "document" });

    expect(message).toBe(
      "precondition 0 failed: MUST_NOT_MATCH filter [resource_type=document] matched at least one relationship",
    );
  });

  it("describes an empty filter as an empty bracket pair", () => {
    expect(mustMatchFailedMessage(0, empty)).toBe(
      "precondition 0 failed: MUST_MATCH filter [] matched no relationships",
    );
  });

  it("describes every populated field, in the fixed order, space-separated and right-trimmed", () => {
    // Resource fields first (type, ids, id_prefix, relation), then each subject selector's type and
    // ids. The caveat and expiration options play no part in the data-plane precondition surface
    // and are deliberately NOT described - copying that omission is the point.
    expect(mustMatchFailedMessage(7, everything)).toBe(
      "precondition 7 failed: MUST_MATCH filter [" +
        "resource_type=document " +
        "resource_ids=doc1,doc2 " +
        "resource_id_prefix=doc " +
        "relation=viewer " +
        "subject_type=user " +
        "subject_ids=alice,bob " +
        "subject_type=group " +
        "subject_ids=eng" +
        "] matched no relationships",
    );
  });

  it("joins id lists with a bare comma and no space", () => {
    expect(mustMatchFailedMessage(1, { optionalResourceIds: ["a", "b", "c"] })).toContain(
      "resource_ids=a,b,c",
    );
  });

  it("omits an EMPTY id list, prefix or selector list, which place no constraint", () => {
    const message = mustMatchFailedMessage(1, {
      optionalResourceIds: [],
      optionalResourceIdPrefix: "",
      optionalSubjectsSelectors: [],
    });

    expect(message).toBe("precondition 1 failed: MUST_MATCH filter [] matched no relationships");
  });

  it("INCLUDES an empty resource type, because the C# tests for non-null, not non-empty", () => {
    // `f.OptionalResourceType is { } rt` matches the empty string; `OptionalResourceIdPrefix is
    // { Length: > 0 }` does not. The asymmetry is real and is transliterated rather than tidied.
    expect(mustMatchFailedMessage(1, { optionalResourceType: "" })).toBe(
      "precondition 1 failed: MUST_MATCH filter [resource_type=] matched no relationships",
    );
  });

  it("includes an empty resource relation for the same reason", () => {
    expect(mustMatchFailedMessage(1, { optionalResourceRelation: "" })).toBe(
      "precondition 1 failed: MUST_MATCH filter [relation=] matched no relationships",
    );
  });

  it("skips a selector's absent fields but keeps the ones it has", () => {
    expect(
      mustMatchFailedMessage(1, {
        optionalSubjectsSelectors: [{ optionalSubjectIds: ["alice"] }, { optionalSubjectType: "" }],
      }),
    ).toBe(
      "precondition 1 failed: MUST_MATCH filter [subject_ids=alice subject_type=] matched no relationships",
    );
  });
});

describe("parsing a precondition failure back", () => {
  const kinds: ReadonlyArray<
    readonly [PreconditionFailureKind, (index: number, filter: RelationshipsFilter) => string]
  > = [
    ["mustMatchFoundNone", mustMatchFailedMessage],
    ["mustNotMatchFoundOne", mustNotMatchFailedMessage],
  ];

  it.each(kinds)("round-trips a %s message at index 0", (kind, factory) => {
    const parsed = tryParsePreconditionFailure(factory(0, { optionalResourceType: "document" }));

    expect(parsed).toEqual({ kind, index: 0 });
  });

  it.each(kinds)("round-trips a %s message at a multi-digit index", (kind, factory) => {
    // The parse splits on the first space after the index, so a two-digit index must not be
    // truncated to one.
    const parsed = tryParsePreconditionFailure(factory(12, { optionalResourceType: "document" }));

    expect(parsed).toEqual({ kind, index: 12 });
  });

  it.each(kinds)("round-trips a %s message for a fully populated filter", (kind, factory) => {
    const parsed = tryParsePreconditionFailure(factory(3, everything));

    expect(parsed).toEqual({ kind, index: 3 });
  });

  it.each(kinds)("round-trips a %s message for an empty filter", (kind, factory) => {
    const parsed = tryParsePreconditionFailure(factory(3, empty));

    expect(parsed).toEqual({ kind, index: 3 });
  });

  it("distinguishes MUST_NOT_MATCH from MUST_MATCH, which is checked second", () => {
    // Deliberate ordering in the C#: MUST_NOT_MATCH is tested before MUST_MATCH. Neither literal is
    // a prefix of the other, so the order is not load-bearing for correctness - but it is copied,
    // and this case is what would catch a reversal that also lost the underscore boundary.
    expect(tryParsePreconditionFailure(mustNotMatchFailedMessage(0, empty))?.kind).toBe(
      "mustNotMatchFoundOne",
    );
    expect(tryParsePreconditionFailure(mustMatchFailedMessage(0, empty))?.kind).toBe(
      "mustMatchFoundNone",
    );
  });

  it("parses leading zeroes in the index, as int.TryParse does", () => {
    expect(
      tryParsePreconditionFailure("precondition 007 failed: MUST_MATCH filter [] matched none"),
    ).toEqual({ kind: "mustMatchFoundNone", index: 7 });
  });

  it.each([
    ["", "the empty string"],
    ["precondition", "the bare prefix word with nothing after it"],
    ["Precondition 0 failed: MUST_MATCH filter [", "a differently-cased prefix (ordinal)"],
    ["some other failure entirely", "unrelated text"],
    ["precondition  failed: MUST_MATCH filter [", "an empty index span"],
    ["precondition -1 failed: MUST_MATCH filter [", "a negative index (NumberStyles.None)"],
    ["precondition +1 failed: MUST_MATCH filter [", "a signed index"],
    ["precondition 1,000 failed: MUST_MATCH filter [", "a group separator"],
    ["precondition 1_000 failed: MUST_MATCH filter [", "an underscore separator"],
    ["precondition 1.5 failed: MUST_MATCH filter [", "a decimal index"],
    ["precondition 0x1f failed: MUST_MATCH filter [", "a hex index"],
    ["precondition 1e3 failed: MUST_MATCH filter [", "an exponent"],
    ["precondition ١٢ failed: MUST_MATCH filter [", "non-ASCII digits"],
    ["precondition 99999999999 failed: MUST_MATCH filter [", "an index past int32 range"],
    ["precondition 0 failed: MUST_MATCH filter", "the message truncated before the bracket"],
    ["precondition 0 failed: MAYBE_MATCH filter [", "an unrecognised match mode"],
    ["precondition 0 failed: MUST_MATCH  filter [", "a doubled space before `filter`"],
    ["precondition 0failed: MUST_MATCH filter [", "no space after the index"],
  ])("returns no guess for %j (%s)", (message) => {
    expect(tryParsePreconditionFailure(message)).toBeUndefined();
  });

  it("parses on the prefix alone, without validating the described filter or the suffix", () => {
    // Characterizing what the C# actually does, not what it aspires to: everything after the
    // opening bracket is unexamined. The kind and index are the only state the reconstruction
    // needs; the message itself is carried across verbatim.
    expect(
      tryParsePreconditionFailure("precondition 4 failed: MUST_MATCH filter [anything at all"),
    ).toEqual({ kind: "mustMatchFoundNone", index: 4 });
  });
});
