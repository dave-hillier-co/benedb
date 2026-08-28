import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";

import {
  caveatFilterOptionFromWire,
  caveatFilterOptionToWire,
  expirationFilterOptionFromWire,
  expirationFilterOptionToWire,
  relationshipsFilterMatches,
  SUBJECT_RELATION_FILTER_ANY,
  subjectRelationFilterMatches,
  subjectRelationFilterMatchesAny,
  subjectsFilterMatches,
  subjectsSelectorMatches,
  type RelationshipsFilter,
  type SubjectRelationFilter,
  type SubjectsFilter,
  type SubjectsSelector,
} from "./relationships-filter";

// Port of Spiceport `RelationshipsFilter.cs`. Spiceport has no dedicated test file: the filter
// semantics are asserted only sociably, through ReferenceDatastoreTests
// (FilterByResourceId_Matches, FilterByResourceIdPrefix_Matches, FilterByCaveat_Matches,
// ReverseQuery_FiltersBySubject). Those four cases are carried across below as direct unit
// tests, and the parts Spiceport never tested anywhere - SubjectRelationFilter's ellipsis
// logic, OnlyNonEllipsisRelations, multi-selector OR, ExpirationFilterOption,
// CaveatFilterOption.NoCaveat - are characterized from the C# source.
//
// Port decisions pinned here:
//
// 1. `CaveatFilterOption` and `ExpirationFilterOption` have explicit proto-mirroring values
//    0/1/2, so they become string-literal unions plus an explicit bidirectional wire map.
//    Declaration order must never carry the wire number.
//
// 2. `SubjectRelationFilter.Any` is a static SINGLETON property, so it becomes a frozen module
//    constant, not a factory: call sites do `relationFilter ?? SUBJECT_RELATION_FILTER_ANY`.
//
// 3. `MatchesAny` is an instance property that is really a predicate, and every `Matches` is an
//    instance method on a record; all become free functions with the type name folded in.
//
// 4. Absent-vs-empty is load-bearing and ASYMMETRIC, exactly as in the C#:
//    `OptionalResourceIds is { Count: > 0 }` - an EMPTY list places NO constraint;
//    `OptionalResourceType is not null` - an EMPTY STRING type IS a constraint;
//    `!string.IsNullOrEmpty(OptionalResourceIdPrefix)` - an empty prefix places no constraint.
//
// 5. `StartsWith(..., StringComparison.Ordinal)` is plain `String.prototype.startsWith`.
//
// 6. `HasMatchingCaveat` with no caveat name compares the relationship's caveat name against
//    null and so matches NOTHING. That is the C# behaviour; it is pinned, not "fixed".
//
// 7. `rel.Resource` / `rel.Subject` are C# shortcut properties; the ported `Relationship` nests
//    them under `reference`.
//
// 8. `bool` members default to false in C#; under `exactOptionalPropertyTypes` they are
//    `?: boolean | undefined` here, and `undefined` means false. `OptionalExpirationOption`
//    defaults to "none" at the match site.
const alice: ObjectAndRelation = { objectType: "user", objectId: "alice", relation: ELLIPSIS };

function rel(
  resourceType: string,
  resourceId: string,
  resourceRelation: string,
  subjectType: string,
  subjectId: string,
  subjectRelation: string = ELLIPSIS,
): Relationship {
  return createRelationship(
    { objectType: resourceType, objectId: resourceId, relation: resourceRelation },
    { objectType: subjectType, objectId: subjectId, relation: subjectRelation },
  );
}

describe("caveatFilterOption wire mapping", () => {
  it("mirrors the proto numbers exactly", () => {
    expect(caveatFilterOptionToWire("none")).toBe(0);
    expect(caveatFilterOptionToWire("hasMatchingCaveat")).toBe(1);
    expect(caveatFilterOptionToWire("noCaveat")).toBe(2);
  });

  it("round-trips every value", () => {
    for (const option of ["none", "hasMatchingCaveat", "noCaveat"] as const) {
      expect(caveatFilterOptionFromWire(caveatFilterOptionToWire(option))).toBe(option);
    }
  });

  it("returns undefined for an unknown wire value", () => {
    expect(caveatFilterOptionFromWire(3)).toBeUndefined();
    expect(caveatFilterOptionFromWire(-1)).toBeUndefined();
  });
});

describe("expirationFilterOption wire mapping", () => {
  it("mirrors the proto numbers exactly", () => {
    expect(expirationFilterOptionToWire("none")).toBe(0);
    expect(expirationFilterOptionToWire("hasExpiration")).toBe(1);
    expect(expirationFilterOptionToWire("noExpiration")).toBe(2);
  });

  it("round-trips every value", () => {
    for (const option of ["none", "hasExpiration", "noExpiration"] as const) {
      expect(expirationFilterOptionFromWire(expirationFilterOptionToWire(option))).toBe(option);
    }
  });

  it("returns undefined for an unknown wire value", () => {
    expect(expirationFilterOptionFromWire(3)).toBeUndefined();
  });
});

describe("SUBJECT_RELATION_FILTER_ANY", () => {
  it("is the singleton shape from the C# static property", () => {
    expect(SUBJECT_RELATION_FILTER_ANY.nonEllipsisRelation).toBeUndefined();
    expect(SUBJECT_RELATION_FILTER_ANY.includeEllipsisRelation).toBe(true);
    expect(SUBJECT_RELATION_FILTER_ANY.onlyNonEllipsisRelations).toBe(false);
  });

  it("is a frozen constant, not a factory - call sites may compare it by reference", () => {
    expect(Object.isFrozen(SUBJECT_RELATION_FILTER_ANY)).toBe(true);
    expect(SUBJECT_RELATION_FILTER_ANY).toBe(SUBJECT_RELATION_FILTER_ANY);
  });

  it("places no constraint", () => {
    expect(subjectRelationFilterMatchesAny(SUBJECT_RELATION_FILTER_ANY)).toBe(true);
    expect(subjectRelationFilterMatches(SUBJECT_RELATION_FILTER_ANY, ELLIPSIS)).toBe(true);
    expect(subjectRelationFilterMatches(SUBJECT_RELATION_FILTER_ANY, "member")).toBe(true);
  });
});

describe("subjectRelationFilterMatchesAny", () => {
  it("is true only when there is no relation constraint, ellipsis is included and non-ellipsis is not forced", () => {
    expect(subjectRelationFilterMatchesAny({ includeEllipsisRelation: true })).toBe(true);
    expect(subjectRelationFilterMatchesAny({})).toBe(false);
    expect(
      subjectRelationFilterMatchesAny({
        nonEllipsisRelation: "member",
        includeEllipsisRelation: true,
      }),
    ).toBe(false);
    expect(
      subjectRelationFilterMatchesAny({
        includeEllipsisRelation: true,
        onlyNonEllipsisRelations: true,
      }),
    ).toBe(false);
  });
});

describe("subjectRelationFilterMatches", () => {
  it("with a non-ellipsis relation set, matches exactly that relation", () => {
    const filter: SubjectRelationFilter = { nonEllipsisRelation: "member" };

    expect(subjectRelationFilterMatches(filter, "member")).toBe(true);
    expect(subjectRelationFilterMatches(filter, "manager")).toBe(false);
  });

  it("with a non-ellipsis relation set, rejects ellipsis unless ellipsis is included", () => {
    expect(subjectRelationFilterMatches({ nonEllipsisRelation: "member" }, ELLIPSIS)).toBe(false);
    expect(
      subjectRelationFilterMatches(
        { nonEllipsisRelation: "member", includeEllipsisRelation: true },
        ELLIPSIS,
      ),
    ).toBe(true);
  });

  it("treats a nonEllipsisRelation of '...' as unmatchable by the ellipsis branch", () => {
    // The C# guards the equality with `!isEllipsis`, so an ellipsis subject can only be admitted
    // by IncludeEllipsisRelation, never by naming "..." as the non-ellipsis relation.
    expect(subjectRelationFilterMatches({ nonEllipsisRelation: ELLIPSIS }, ELLIPSIS)).toBe(false);
  });

  it("with onlyNonEllipsisRelations, admits any concrete relation and rejects ellipsis", () => {
    const filter: SubjectRelationFilter = { onlyNonEllipsisRelations: true };

    expect(subjectRelationFilterMatches(filter, "member")).toBe(true);
    expect(subjectRelationFilterMatches(filter, "manager")).toBe(true);
    expect(subjectRelationFilterMatches(filter, ELLIPSIS)).toBe(false);
  });

  it("with onlyNonEllipsisRelations, still rejects ellipsis even when ellipsis is included", () => {
    // OnlyNonEllipsisRelations is checked BEFORE the ellipsis branch, so it wins.
    expect(
      subjectRelationFilterMatches(
        { includeEllipsisRelation: true, onlyNonEllipsisRelations: true },
        ELLIPSIS,
      ),
    ).toBe(false);
  });

  it("with no constraints at all, admits concrete relations but not ellipsis", () => {
    const filter: SubjectRelationFilter = {};

    expect(subjectRelationFilterMatches(filter, "member")).toBe(true);
    expect(subjectRelationFilterMatches(filter, ELLIPSIS)).toBe(false);
  });
});

describe("subjectsSelectorMatches", () => {
  it("matches everything when the selector is empty", () => {
    expect(subjectsSelectorMatches({}, alice)).toBe(true);
  });

  it("constrains the subject type when set", () => {
    const selector: SubjectsSelector = { optionalSubjectType: "user" };

    expect(subjectsSelectorMatches(selector, alice)).toBe(true);
    expect(
      subjectsSelectorMatches(selector, { objectType: "group", objectId: "a", relation: ELLIPSIS }),
    ).toBe(false);
  });

  it("treats an empty subject type as a real constraint that nothing normal satisfies", () => {
    expect(subjectsSelectorMatches({ optionalSubjectType: "" }, alice)).toBe(false);
  });

  it("constrains the subject id when the id list is non-empty", () => {
    const selector: SubjectsSelector = { optionalSubjectIds: ["alice", "bob"] };

    expect(subjectsSelectorMatches(selector, alice)).toBe(true);
    expect(
      subjectsSelectorMatches(selector, {
        objectType: "user",
        objectId: "carol",
        relation: ELLIPSIS,
      }),
    ).toBe(false);
  });

  it("treats an EMPTY subject id list as no constraint at all", () => {
    expect(subjectsSelectorMatches({ optionalSubjectIds: [] }, alice)).toBe(true);
  });

  it("defaults a missing relation filter to Any, so an ellipsis subject matches", () => {
    expect(subjectsSelectorMatches({ optionalSubjectType: "user" }, alice)).toBe(true);
  });

  it("applies an explicit relation filter", () => {
    const selector: SubjectsSelector = { relationFilter: { nonEllipsisRelation: "member" } };

    expect(subjectsSelectorMatches(selector, alice)).toBe(false);
    expect(
      subjectsSelectorMatches(selector, { objectType: "group", objectId: "g", relation: "member" }),
    ).toBe(true);
  });
});

describe("relationshipsFilterMatches", () => {
  it("matches everything when the filter is empty", () => {
    expect(relationshipsFilterMatches({}, rel("document", "doc1", "viewer", "user", "alice"))).toBe(
      true,
    );
  });

  it("filters by resource type and id list (ReferenceDatastoreTests.FilterByResourceId_Matches)", () => {
    const filter: RelationshipsFilter = {
      optionalResourceType: "document",
      optionalResourceIds: ["doc2"],
    };

    expect(
      relationshipsFilterMatches(filter, rel("document", "doc1", "viewer", "user", "alice")),
    ).toBe(false);
    expect(
      relationshipsFilterMatches(filter, rel("document", "doc2", "viewer", "user", "bob")),
    ).toBe(true);
  });

  it("filters by resource id prefix (ReferenceDatastoreTests.FilterByResourceIdPrefix_Matches)", () => {
    const filter: RelationshipsFilter = {
      optionalResourceType: "document",
      optionalResourceIdPrefix: "report-",
    };

    expect(
      relationshipsFilterMatches(filter, rel("document", "report-1", "viewer", "user", "alice")),
    ).toBe(true);
    expect(
      relationshipsFilterMatches(filter, rel("document", "report-2", "viewer", "user", "bob")),
    ).toBe(true);
    expect(
      relationshipsFilterMatches(filter, rel("document", "memo-1", "viewer", "user", "carol")),
    ).toBe(false);
  });

  it("compares the prefix ordinally, by code unit", () => {
    const filter: RelationshipsFilter = { optionalResourceIdPrefix: "Report" };

    expect(
      relationshipsFilterMatches(filter, rel("document", "Report-1", "viewer", "user", "a")),
    ).toBe(true);
    // Not case-insensitive, and not locale-aware.
    expect(
      relationshipsFilterMatches(filter, rel("document", "report-1", "viewer", "user", "a")),
    ).toBe(false);
  });

  it("treats an EMPTY resource id prefix as no constraint", () => {
    expect(
      relationshipsFilterMatches(
        { optionalResourceIdPrefix: "" },
        rel("document", "doc1", "viewer", "user", "alice"),
      ),
    ).toBe(true);
  });

  it("treats an EMPTY resource id list as no constraint", () => {
    expect(
      relationshipsFilterMatches(
        { optionalResourceIds: [] },
        rel("document", "doc1", "viewer", "user", "alice"),
      ),
    ).toBe(true);
  });

  it("treats an EMPTY resource type as a real constraint", () => {
    expect(
      relationshipsFilterMatches(
        { optionalResourceType: "" },
        rel("document", "doc1", "viewer", "user", "alice"),
      ),
    ).toBe(false);
  });

  it("filters by resource relation, empty string included", () => {
    expect(
      relationshipsFilterMatches(
        { optionalResourceRelation: "viewer" },
        rel("document", "doc1", "viewer", "user", "alice"),
      ),
    ).toBe(true);
    expect(
      relationshipsFilterMatches(
        { optionalResourceRelation: "editor" },
        rel("document", "doc1", "viewer", "user", "alice"),
      ),
    ).toBe(false);
    expect(
      relationshipsFilterMatches(
        { optionalResourceRelation: "" },
        rel("document", "doc1", "viewer", "user", "alice"),
      ),
    ).toBe(false);
  });

  it("ANDs every set resource-side field", () => {
    const filter: RelationshipsFilter = {
      optionalResourceType: "document",
      optionalResourceIds: ["doc1"],
      optionalResourceRelation: "viewer",
    };

    expect(
      relationshipsFilterMatches(filter, rel("document", "doc1", "viewer", "user", "alice")),
    ).toBe(true);
    expect(
      relationshipsFilterMatches(filter, rel("document", "doc1", "editor", "user", "alice")),
    ).toBe(false);
    expect(
      relationshipsFilterMatches(filter, rel("folder", "doc1", "viewer", "user", "alice")),
    ).toBe(false);
  });

  it("ORs the subject selectors: any one matching is enough", () => {
    const filter: RelationshipsFilter = {
      optionalSubjectsSelectors: [
        { optionalSubjectType: "group", relationFilter: { nonEllipsisRelation: "member" } },
        { optionalSubjectType: "user", optionalSubjectIds: ["bob"] },
      ],
    };

    expect(
      relationshipsFilterMatches(filter, rel("document", "d", "viewer", "group", "g", "member")),
    ).toBe(true);
    expect(relationshipsFilterMatches(filter, rel("document", "d", "viewer", "user", "bob"))).toBe(
      true,
    );
    expect(
      relationshipsFilterMatches(filter, rel("document", "d", "viewer", "user", "alice")),
    ).toBe(false);
  });

  it("treats an EMPTY selector list as no subject constraint", () => {
    expect(
      relationshipsFilterMatches(
        { optionalSubjectsSelectors: [] },
        rel("document", "doc1", "viewer", "user", "alice"),
      ),
    ).toBe(true);
  });

  it("filters by caveat (ReferenceDatastoreTests.FilterByCaveat_Matches)", () => {
    const plain = rel("document", "doc1", "viewer", "user", "alice");
    const caveated = {
      ...rel("document", "doc2", "viewer", "user", "bob"),
      optionalCaveat: { caveatName: "biz_hours" },
    };

    const hasCaveat: RelationshipsFilter = {
      optionalCaveatNameFilter: { option: "hasMatchingCaveat", caveatName: "biz_hours" },
    };
    const noCaveat: RelationshipsFilter = { optionalCaveatNameFilter: { option: "noCaveat" } };

    expect(relationshipsFilterMatches(hasCaveat, caveated)).toBe(true);
    expect(relationshipsFilterMatches(hasCaveat, plain)).toBe(false);
    expect(relationshipsFilterMatches(noCaveat, plain)).toBe(true);
    expect(relationshipsFilterMatches(noCaveat, caveated)).toBe(false);
  });

  it("requires the caveat NAME to match, not merely a caveat to be present", () => {
    const caveated = {
      ...rel("document", "doc2", "viewer", "user", "bob"),
      optionalCaveat: { caveatName: "other" },
    };

    expect(
      relationshipsFilterMatches(
        { optionalCaveatNameFilter: { option: "hasMatchingCaveat", caveatName: "biz_hours" } },
        caveated,
      ),
    ).toBe(false);
  });

  it("matches NOTHING when hasMatchingCaveat carries no caveat name", () => {
    // C# compares `rel.OptionalCaveat.CaveatName != caveatFilter.CaveatName` against null, so a
    // caveated relationship fails the name check and an uncaveated one fails the null check.
    // Pinned as-is; do not "fix" it by coercing undefined.
    const filter: RelationshipsFilter = {
      optionalCaveatNameFilter: { option: "hasMatchingCaveat" },
    };
    const caveated = {
      ...rel("document", "doc2", "viewer", "user", "bob"),
      optionalCaveat: { caveatName: "biz_hours" },
    };

    expect(relationshipsFilterMatches(filter, caveated)).toBe(false);
    expect(
      relationshipsFilterMatches(filter, rel("document", "doc1", "viewer", "user", "alice")),
    ).toBe(false);
  });

  it("places no caveat constraint when the option is none, even with a caveat name set", () => {
    const filter: RelationshipsFilter = {
      optionalCaveatNameFilter: { option: "none", caveatName: "biz_hours" },
    };
    const caveated = {
      ...rel("document", "doc2", "viewer", "user", "bob"),
      optionalCaveat: { caveatName: "other" },
    };

    expect(relationshipsFilterMatches(filter, caveated)).toBe(true);
    expect(
      relationshipsFilterMatches(filter, rel("document", "doc1", "viewer", "user", "alice")),
    ).toBe(true);
  });

  it("filters by expiration presence", () => {
    const expiring = {
      ...rel("document", "doc1", "viewer", "user", "alice"),
      optionalExpiration: 1_700_000_000_000_000_000n,
    };
    const plain = rel("document", "doc2", "viewer", "user", "bob");

    expect(
      relationshipsFilterMatches({ optionalExpirationOption: "hasExpiration" }, expiring),
    ).toBe(true);
    expect(relationshipsFilterMatches({ optionalExpirationOption: "hasExpiration" }, plain)).toBe(
      false,
    );
    expect(relationshipsFilterMatches({ optionalExpirationOption: "noExpiration" }, expiring)).toBe(
      false,
    );
    expect(relationshipsFilterMatches({ optionalExpirationOption: "noExpiration" }, plain)).toBe(
      true,
    );
  });

  it("defaults the expiration option to none when absent", () => {
    const expiring = {
      ...rel("document", "doc1", "viewer", "user", "alice"),
      optionalExpiration: 1_700_000_000_000_000_000n,
    };

    expect(relationshipsFilterMatches({}, expiring)).toBe(true);
    expect(relationshipsFilterMatches({ optionalExpirationOption: "none" }, expiring)).toBe(true);
  });
});

describe("subjectsFilterMatches", () => {
  it("requires the subject type to match exactly", () => {
    const filter: SubjectsFilter = { subjectType: "user" };

    expect(subjectsFilterMatches(filter, rel("document", "doc1", "viewer", "user", "alice"))).toBe(
      true,
    );
    expect(subjectsFilterMatches(filter, rel("document", "doc1", "viewer", "group", "g"))).toBe(
      false,
    );
  });

  it("restricts to the given subject ids (ReferenceDatastoreTests.ReverseQuery_FiltersBySubject)", () => {
    const filter: SubjectsFilter = { subjectType: "user", optionalSubjectIds: ["alice"] };

    expect(subjectsFilterMatches(filter, rel("document", "doc1", "viewer", "user", "alice"))).toBe(
      true,
    );
    expect(subjectsFilterMatches(filter, rel("folder", "f1", "viewer", "user", "alice"))).toBe(
      true,
    );
    expect(subjectsFilterMatches(filter, rel("document", "doc2", "viewer", "user", "bob"))).toBe(
      false,
    );
  });

  it("treats an EMPTY subject id list as no constraint", () => {
    expect(
      subjectsFilterMatches(
        { subjectType: "user", optionalSubjectIds: [] },
        rel("document", "doc1", "viewer", "user", "alice"),
      ),
    ).toBe(true);
  });

  it("defaults a missing relation filter to Any", () => {
    expect(
      subjectsFilterMatches(
        { subjectType: "user" },
        rel("document", "d", "viewer", "user", "alice"),
      ),
    ).toBe(true);
    expect(
      subjectsFilterMatches(
        { subjectType: "group" },
        rel("document", "d", "viewer", "group", "g", "member"),
      ),
    ).toBe(true);
  });

  it("applies an explicit relation filter to the subject relation", () => {
    const filter: SubjectsFilter = {
      subjectType: "group",
      relationFilter: { nonEllipsisRelation: "member" },
    };

    expect(
      subjectsFilterMatches(filter, rel("document", "d", "viewer", "group", "g", "member")),
    ).toBe(true);
    expect(
      subjectsFilterMatches(filter, rel("document", "d", "viewer", "group", "g", "manager")),
    ).toBe(false);
    expect(subjectsFilterMatches(filter, rel("document", "d", "viewer", "group", "g"))).toBe(false);
  });

  it("restricts the resource side by type and relation when set", () => {
    const filter: SubjectsFilter = {
      subjectType: "user",
      optionalResourceType: "document",
      optionalResourceRelation: "viewer",
    };

    expect(subjectsFilterMatches(filter, rel("document", "d", "viewer", "user", "alice"))).toBe(
      true,
    );
    expect(subjectsFilterMatches(filter, rel("folder", "f", "viewer", "user", "alice"))).toBe(
      false,
    );
    expect(subjectsFilterMatches(filter, rel("document", "d", "editor", "user", "alice"))).toBe(
      false,
    );
  });

  it("treats an EMPTY resource type or relation as a real constraint", () => {
    expect(
      subjectsFilterMatches(
        { subjectType: "user", optionalResourceType: "" },
        rel("document", "d", "viewer", "user", "alice"),
      ),
    ).toBe(false);
    expect(
      subjectsFilterMatches(
        { subjectType: "user", optionalResourceRelation: "" },
        rel("document", "d", "viewer", "user", "alice"),
      ),
    ).toBe(false);
  });
});
