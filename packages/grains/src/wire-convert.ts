import { ELLIPSIS } from "@spacedb/core/core-constants";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import {
  caveatFilterOptionFromWire,
  caveatFilterOptionToWire,
  expirationFilterOptionFromWire,
  expirationFilterOptionToWire,
  type CaveatFilterOption,
  type ExpirationFilterOption,
  type RelationshipsFilter,
  type SubjectsSelector,
} from "@spacedb/datastore/relationships-filter";

import type {
  CaveatNameFilterWire,
  FullRelationshipsFilterWire,
  SubjectsSelectorWire,
} from "./datastore-dtos";
import type { RelationshipUpdateWire, RelationshipWire } from "./relationships-dtos";

// A deliberately MULTI-EXPORT module: `WireConvert.cs` is a `static class` used as a namespace, so
// per the port guide its members become module-level functions with the type name folded away.
// This is the SINGLE copy of the relationship-payload and full-filter conversions shared by the
// relationships grain, the grain-backed datastore and all three folds - do not duplicate it.
//
// Port decisions settled once, here:
//
// - The C#'s `DateTimeOffset? Expiration` <-> nanos step has VANISHED. Both `RelationshipWire`
//   and core's `Relationship` already store the expiration as nanos-since-epoch `bigint`, so this
//   conversion is now the IDENTITY. `ShardFold`'s `NanosSinceEpoch` helper disappears with it.
// - The C#'s `.ToArray()` materialisations existed only because Orleans could not code a
//   collection expression's compiler-synthesized list type. TypeScript needs no such thing, but
//   the copies are KEPT: the C# handed the wire object a private array, and Thresh passes a
//   same-silo argument by reference, so sharing the caller's array here would let a later
//   mutation reach through the wire type.
// - The two option converters switch on an `int` with a TOLERANT default (`None`). They therefore
//   use the core `*FromWire` maps plus an explicit `?? "none"`, never a throwing `assertNever`:
//   an unrecognised value from a newer peer must degrade to "no constraint", not fail a fold.

/** Converts a wire relationship to a core relationship (normalizing the subject relation). */
export function toRelationship(wire: RelationshipWire): Relationship {
  const resource = {
    objectType: wire.resourceType,
    objectId: wire.resourceId,
    relation: wire.resourceRelation,
  };
  // `string.IsNullOrEmpty` - whitespace is NOT empty.
  const subjectRelation =
    wire.subjectRelation === undefined || wire.subjectRelation === ""
      ? ELLIPSIS
      : wire.subjectRelation;
  const subject = {
    objectType: wire.subjectType,
    objectId: wire.subjectId,
    relation: subjectRelation,
  };
  const caveat =
    wire.caveatName !== undefined && wire.caveatName.length > 0
      ? { caveatName: wire.caveatName, context: wire.caveatContext }
      : undefined;
  return createRelationship(resource, subject, caveat, wire.expiration);
}

/**
 * Converts a wire relationship update to a core `RelationshipUpdate`. A log/Watch update only ever
 * carries a Touch (create-or-replace) or a Delete; the single mapping is shared by the log fold and
 * the Watch feed so they can never diverge on the operation or payload conversion.
 */
export function toUpdate(u: RelationshipUpdateWire): RelationshipUpdate {
  return {
    relationship: toRelationship(u.relationship),
    operation: u.operation === "delete" ? "delete" : "touch",
  };
}

/**
 * Converts a wire relationship update to a core `RelationshipUpdate` PRESERVING the Create
 * operation - the write-REQUEST form (used by the grain-side commit execution): a Create must reach
 * `MvccReadWriteTransaction.writeRelationships` as a Create so the create-conflict check
 * (`CreateRelationshipExistsException`) fires. Deliberately distinct from {@link toUpdate}, the
 * log/Watch form, where a committed event only ever carries the RESOLVED Touch or Delete. Two
 * distinctly named functions, never one with a flag.
 */
export function toWriteUpdate(u: RelationshipUpdateWire): RelationshipUpdate {
  return {
    relationship: toRelationship(u.relationship),
    operation: u.operation === "create" ? "create" : u.operation === "delete" ? "delete" : "touch",
  };
}

/**
 * Converts a core relationship to its wire form. NOTE: `optionalIntegrity` is intentionally
 * dropped - the wire type carries no integrity field. This is the same loss the data-plane write
 * path already incurs; integrity is unused by the engine and the conformance corpus.
 */
export function toWire(rel: Relationship): RelationshipWire {
  return {
    resourceType: rel.reference.resource.objectType,
    resourceId: rel.reference.resource.objectId,
    resourceRelation: rel.reference.resource.relation,
    subjectType: rel.reference.subject.objectType,
    subjectId: rel.reference.subject.objectId,
    subjectRelation: rel.reference.subject.relation,
    caveatName: rel.optionalCaveat?.caveatName,
    caveatContext: rel.optionalCaveat?.context,
    expiration: rel.optionalExpiration,
  };
}

// --- Full filter (lossless, used for counters) ---

/** Converts the lossless full-filter wire form to a core `RelationshipsFilter`. */
export function toCoreFilter(w: FullRelationshipsFilterWire): RelationshipsFilter {
  const selectors = w.optionalSubjectsSelectors?.map(toCoreSelector);
  const wireCaveatFilter = w.optionalCaveatNameFilter;
  const caveatFilter =
    wireCaveatFilter !== undefined
      ? {
          option: toCoreCaveatOption(wireCaveatFilter.option),
          caveatName: wireCaveatFilter.caveatName,
        }
      : undefined;

  return {
    optionalResourceType: w.optionalResourceType,
    optionalResourceIds: w.optionalResourceIds,
    optionalResourceIdPrefix: w.optionalResourceIdPrefix,
    optionalResourceRelation: w.optionalResourceRelation,
    optionalSubjectsSelectors: selectors,
    optionalCaveatNameFilter: caveatFilter,
    optionalExpirationOption: toCoreExpirationOption(w.optionalExpirationOption),
  };
}

/** Converts a core `RelationshipsFilter` to the lossless full-filter wire form. */
export function toFullFilter(f: RelationshipsFilter): FullRelationshipsFilterWire {
  const selectors = f.optionalSubjectsSelectors?.map(toWireSelector);
  const coreCaveatFilter = f.optionalCaveatNameFilter;
  const caveatFilter: CaveatNameFilterWire | undefined =
    coreCaveatFilter !== undefined
      ? {
          option: caveatFilterOptionToWire(coreCaveatFilter.option),
          caveatName: coreCaveatFilter.caveatName,
        }
      : undefined;

  // Id lists are COPIED, matching the C#'s `.ToArray()` (see the module note).
  return {
    optionalResourceType: f.optionalResourceType,
    optionalResourceIds: f.optionalResourceIds?.slice(),
    optionalResourceIdPrefix: f.optionalResourceIdPrefix,
    optionalResourceRelation: f.optionalResourceRelation,
    optionalSubjectsSelectors: selectors,
    optionalCaveatNameFilter: caveatFilter,
    // The core member is a C# DEFAULTED record parameter (`ExpirationFilterOption.None`), which
    // the port spells as an absent optional plus a `??` resolver.
    optionalExpirationOption: expirationFilterOptionToWire(f.optionalExpirationOption ?? "none"),
  };
}

function toCoreSelector(s: SubjectsSelectorWire): SubjectsSelector {
  const rf = s.relationFilter;
  return {
    optionalSubjectType: s.optionalSubjectType,
    optionalSubjectIds: s.optionalSubjectIds,
    relationFilter:
      rf !== undefined
        ? {
            nonEllipsisRelation: rf.nonEllipsisRelation,
            includeEllipsisRelation: rf.includeEllipsisRelation,
            onlyNonEllipsisRelations: rf.onlyNonEllipsisRelations,
          }
        : undefined,
  };
}

function toWireSelector(s: SubjectsSelector): SubjectsSelectorWire {
  const rf = s.relationFilter;
  return {
    optionalSubjectType: s.optionalSubjectType,
    optionalSubjectIds: s.optionalSubjectIds?.slice(), // copied, as in `toFullFilter`
    relationFilter:
      rf !== undefined
        ? {
            nonEllipsisRelation: rf.nonEllipsisRelation,
            // The core booleans are C# defaulted record parameters (both `false`) that the port
            // spells as absent optionals; the wire members are REQUIRED, so the default is
            // resolved here rather than being allowed to travel as `undefined`.
            includeEllipsisRelation: rf.includeEllipsisRelation ?? false,
            onlyNonEllipsisRelations: rf.onlyNonEllipsisRelations ?? false,
          }
        : undefined,
  };
}

function toCoreCaveatOption(option: number): CaveatFilterOption {
  return caveatFilterOptionFromWire(option) ?? "none";
}

function toCoreExpirationOption(option: number): ExpirationFilterOption {
  return expirationFilterOptionFromWire(option) ?? "none";
}
