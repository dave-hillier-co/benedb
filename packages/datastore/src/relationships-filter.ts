import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import type { Relationship } from "@spacedb/core/relationship";

/**
 * Whether to match relationships based on the presence of a caveat.
 *
 * The C# enum has EXPLICIT proto-mirroring values - None = 0, HasMatchingCaveat = 1,
 * NoCaveat = 2 - so this is a string-literal union plus the explicit bidirectional map below.
 * Declaration order must never carry the wire number.
 */
export type CaveatFilterOption = "none" | "hasMatchingCaveat" | "noCaveat";

const CAVEAT_FILTER_OPTION_TO_WIRE: Readonly<Record<CaveatFilterOption, number>> = {
  none: 0,
  hasMatchingCaveat: 1,
  noCaveat: 2,
};

const CAVEAT_FILTER_OPTION_FROM_WIRE: ReadonlyMap<number, CaveatFilterOption> = new Map<
  number,
  CaveatFilterOption
>([
  [0, "none"],
  [1, "hasMatchingCaveat"],
  [2, "noCaveat"],
]);

/** The proto enum value for a caveat filter option. */
export function caveatFilterOptionToWire(option: CaveatFilterOption): number {
  return CAVEAT_FILTER_OPTION_TO_WIRE[option];
}

/** The caveat filter option for a proto enum value, or `undefined` for an unknown value. */
export function caveatFilterOptionFromWire(wire: number): CaveatFilterOption | undefined {
  return CAVEAT_FILTER_OPTION_FROM_WIRE.get(wire);
}

/**
 * Whether to match relationships based on the presence of an expiration.
 *
 * Explicit proto-mirroring values - None = 0, HasExpiration = 1, NoExpiration = 2.
 */
export type ExpirationFilterOption = "none" | "hasExpiration" | "noExpiration";

const EXPIRATION_FILTER_OPTION_TO_WIRE: Readonly<Record<ExpirationFilterOption, number>> = {
  none: 0,
  hasExpiration: 1,
  noExpiration: 2,
};

const EXPIRATION_FILTER_OPTION_FROM_WIRE: ReadonlyMap<number, ExpirationFilterOption> = new Map<
  number,
  ExpirationFilterOption
>([
  [0, "none"],
  [1, "hasExpiration"],
  [2, "noExpiration"],
]);

/** The proto enum value for an expiration filter option. */
export function expirationFilterOptionToWire(option: ExpirationFilterOption): number {
  return EXPIRATION_FILTER_OPTION_TO_WIRE[option];
}

/** The expiration filter option for a proto enum value, or `undefined` for an unknown value. */
export function expirationFilterOptionFromWire(wire: number): ExpirationFilterOption | undefined {
  return EXPIRATION_FILTER_OPTION_FROM_WIRE.get(wire);
}

/** A filter on a relationship's caveat. */
export interface CaveatNameFilter {
  /** The caveat filtering mode. */
  readonly option: CaveatFilterOption;
  /** Required when `option` is `hasMatchingCaveat`. */
  readonly caveatName?: string | undefined;
}

/** A filter on the relation of a subject. */
export interface SubjectRelationFilter {
  /** When set, matches subjects with exactly this (non-ellipsis) relation. */
  readonly nonEllipsisRelation?: string | undefined;
  /** When true, ellipsis-relation subjects are included. */
  readonly includeEllipsisRelation?: boolean | undefined;
  /** When true, only non-ellipsis subjects match (any non-ellipsis relation). */
  readonly onlyNonEllipsisRelations?: boolean | undefined;
}

/**
 * A filter matching any subject relation.
 *
 * The C# is a static singleton property, so this is a frozen module constant rather than a
 * factory: call sites do `relationFilter ?? SUBJECT_RELATION_FILTER_ANY` and may compare it by
 * reference.
 */
export const SUBJECT_RELATION_FILTER_ANY: SubjectRelationFilter = Object.freeze({
  nonEllipsisRelation: undefined,
  includeEllipsisRelation: true,
  onlyNonEllipsisRelations: false,
});

/**
 * True if this filter places no constraint on the subject relation. The C# `MatchesAny` is an
 * instance property that is really a predicate, so it becomes a free function.
 */
export function subjectRelationFilterMatchesAny(filter: SubjectRelationFilter): boolean {
  return (
    filter.nonEllipsisRelation === undefined &&
    filter.includeEllipsisRelation === true &&
    !filter.onlyNonEllipsisRelations
  );
}

/** Returns true if the given subject relation satisfies this filter. */
export function subjectRelationFilterMatches(
  filter: SubjectRelationFilter,
  subjectRelation: string,
): boolean {
  if (subjectRelationFilterMatchesAny(filter)) return true;

  const isEllipsis = subjectRelation === ELLIPSIS;

  if (filter.nonEllipsisRelation !== undefined) {
    if (!isEllipsis && subjectRelation === filter.nonEllipsisRelation) return true;
    if (isEllipsis && filter.includeEllipsisRelation === true) return true;
    return false;
  }

  if (filter.onlyNonEllipsisRelations === true) return !isEllipsis;

  if (isEllipsis) return filter.includeEllipsisRelation === true;

  // No non-ellipsis constraint specified: a concrete relation matches unless restricted.
  return true;
}

/** Selects subjects by type, ids and relation. Used as one alternative within a filter. */
export interface SubjectsSelector {
  /** When set, matches only subjects of this type. */
  readonly optionalSubjectType?: string | undefined;
  /** When set (non-empty), matches only subjects whose id is in this list. */
  readonly optionalSubjectIds?: readonly string[] | undefined;
  /** Constraint on the subject relation. */
  readonly relationFilter?: SubjectRelationFilter | undefined;
}

/** Returns true if the given subject ONR satisfies this selector. */
export function subjectsSelectorMatches(
  selector: SubjectsSelector,
  subject: ObjectAndRelation,
): boolean {
  // Absent-vs-empty is asymmetric and load-bearing: an empty TYPE is a real constraint, while
  // an EMPTY id list places none. Both come straight from the C#.
  if (
    selector.optionalSubjectType !== undefined &&
    subject.objectType !== selector.optionalSubjectType
  )
    return false;
  if (
    selector.optionalSubjectIds !== undefined &&
    selector.optionalSubjectIds.length > 0 &&
    !selector.optionalSubjectIds.includes(subject.objectId)
  )
    return false;
  const relFilter = selector.relationFilter ?? SUBJECT_RELATION_FILTER_ANY;
  return subjectRelationFilterMatches(relFilter, subject.relation);
}

/**
 * A filter over relationships, applied from the resource side. All set fields are ANDed; when a
 * field is absent/empty it places no constraint.
 */
export interface RelationshipsFilter {
  /** When set, only relationships whose resource has this type match. */
  readonly optionalResourceType?: string | undefined;
  /** When set (non-empty), only relationships whose resource id is in this list match. */
  readonly optionalResourceIds?: readonly string[] | undefined;
  /** When set (non-empty), only relationships whose resource id begins with this prefix match. Mutually exclusive with `optionalResourceIds`. */
  readonly optionalResourceIdPrefix?: string | undefined;
  /** When set, only relationships with this resource relation match. */
  readonly optionalResourceRelation?: string | undefined;
  /** When set (non-empty), a relationship matches if its subject satisfies any selector. */
  readonly optionalSubjectsSelectors?: readonly SubjectsSelector[] | undefined;
  /** When set, filters by caveat presence/name. */
  readonly optionalCaveatNameFilter?: CaveatNameFilter | undefined;
  /** Filters by expiration presence; absent means `none`, the C# default. */
  readonly optionalExpirationOption?: ExpirationFilterOption | undefined;
}

/** Returns true if the given relationship satisfies this filter. */
export function relationshipsFilterMatches(
  filter: RelationshipsFilter,
  rel: Relationship,
): boolean {
  const resource = rel.reference.resource;

  if (
    filter.optionalResourceType !== undefined &&
    resource.objectType !== filter.optionalResourceType
  )
    return false;

  if (
    filter.optionalResourceIds !== undefined &&
    filter.optionalResourceIds.length > 0 &&
    !filter.optionalResourceIds.includes(resource.objectId)
  )
    return false;

  // `StartsWith(..., StringComparison.Ordinal)` is plain `startsWith`, which is already ordinal
  // over code units. `IsNullOrEmpty` means an empty prefix places no constraint.
  if (
    filter.optionalResourceIdPrefix !== undefined &&
    filter.optionalResourceIdPrefix !== "" &&
    !resource.objectId.startsWith(filter.optionalResourceIdPrefix)
  )
    return false;

  if (
    filter.optionalResourceRelation !== undefined &&
    resource.relation !== filter.optionalResourceRelation
  )
    return false;

  const selectors = filter.optionalSubjectsSelectors;
  if (selectors !== undefined && selectors.length > 0) {
    let anyMatch = false;
    for (const selector of selectors) {
      if (subjectsSelectorMatches(selector, rel.reference.subject)) {
        anyMatch = true;
        break;
      }
    }
    if (!anyMatch) return false;
  }

  const caveatFilter = filter.optionalCaveatNameFilter;
  if (caveatFilter !== undefined) {
    switch (caveatFilter.option) {
      case "noCaveat":
        if (rel.optionalCaveat !== undefined) return false;
        break;
      case "hasMatchingCaveat":
        // With no caveat name the C# compares the relationship's caveat name against null and
        // therefore never matches. Pinned as-is; not "fixed" by coercing undefined.
        if (
          rel.optionalCaveat === undefined ||
          rel.optionalCaveat.caveatName !== caveatFilter.caveatName
        )
          return false;
        break;
      case "none":
        break;
    }
  }

  switch (filter.optionalExpirationOption ?? "none") {
    case "hasExpiration":
      if (rel.optionalExpiration === undefined) return false;
      break;
    case "noExpiration":
      if (rel.optionalExpiration !== undefined) return false;
      break;
    case "none":
      break;
  }

  return true;
}

/** A filter over relationships, applied from the subject side (reverse query). */
export interface SubjectsFilter {
  /** The subject type to query. */
  readonly subjectType: string;
  /** When set (non-empty), restricts to subjects with these ids. */
  readonly optionalSubjectIds?: readonly string[] | undefined;
  /** Constraint on the subject relation. */
  readonly relationFilter?: SubjectRelationFilter | undefined;
  /** When set, restricts to resources of this type. */
  readonly optionalResourceType?: string | undefined;
  /** When set, restricts to resources with this relation. */
  readonly optionalResourceRelation?: string | undefined;
}

/** Returns true if the given relationship's subject satisfies this filter. */
export function subjectsFilterMatches(filter: SubjectsFilter, rel: Relationship): boolean {
  const subject = rel.reference.subject;
  if (subject.objectType !== filter.subjectType) return false;
  if (
    filter.optionalSubjectIds !== undefined &&
    filter.optionalSubjectIds.length > 0 &&
    !filter.optionalSubjectIds.includes(subject.objectId)
  )
    return false;
  const relFilter = filter.relationFilter ?? SUBJECT_RELATION_FILTER_ANY;
  if (!subjectRelationFilterMatches(relFilter, subject.relation)) return false;
  if (
    filter.optionalResourceType !== undefined &&
    rel.reference.resource.objectType !== filter.optionalResourceType
  )
    return false;
  if (
    filter.optionalResourceRelation !== undefined &&
    rel.reference.resource.relation !== filter.optionalResourceRelation
  )
    return false;
  return true;
}
