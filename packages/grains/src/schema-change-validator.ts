import { allowedRelationSource } from "@spacedb/core/allowed-relation-identity";
import {
  isAllowedRelationPublicWildcard,
  type AllowedRelation,
} from "@spacedb/core/allowed-relation";
import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { Relationship } from "@spacedb/core/relationship";
import { formatRelationship } from "@spacedb/core/tuple-strings";
import type { IDatastoreReader } from "@spacedb/datastore/i-datastore";
import type {
  CaveatNameFilter,
  RelationshipsFilter,
  SubjectRelationFilter,
} from "@spacedb/datastore/relationships-filter";
import type { CompiledSchema } from "@spacedb/schema/compiled-schema";

import type { ISnapshotScanner } from "./i-snapshot-scanner";
import { computeSchemaDiff } from "./schema-diff";
import { SchemaWriteValidationException } from "./schema-write-validation-exception";

/**
 * Ported from Spiceport `Grains/SchemaChangeValidator.cs`.
 *
 * Validates that swapping the current compiled schema for a new one will not leave existing
 * relationships dangling. It diffs the two schemas for REMOVALS - a removed definition, a removed
 * relation, or a removed allowed subject type - and, for each removal, queries the datastore for
 * any relationship that still references it. If one is found the change is rejected with
 * `SchemaWriteValidationException`.
 *
 * Mirrors SpiceDB's `sanityCheckNamespaceChanges` / `ensureNoRelationshipsExistWithResourceType`.
 * What is intentionally NOT rejected here (always safe, or deferred): adding definitions /
 * relations / allowed subject types; permission-only changes (a permission is computed, never
 * written as a relationship); removing a permission (permissions hold no stored relationships).
 * Caveat parameter removal and parameter type changes ARE rejected unconditionally (no datastore
 * query), mirroring SpiceDB's `sanityCheckCaveatChanges`, since existing relationships may carry
 * context typed by the old parameter.
 *
 * Port decisions:
 *   * The `SchemaChangeCheck` abstract record with two nested records becomes one discriminated
 *     union on a literal `kind`, per the port guide.
 *   * `Func<Relationship, string> Describe` stays a FUNCTION field on the union member - it is
 *     what renders the "(e.g. {rel})" text from the first offending row, and `Relationship`'s C#
 *     `ToString()` is `TupleStrings.FormatRelationship`.
 *   * The three C# entry points overload one name; TypeScript cannot, so they are `validate`,
 *     `evaluateWithReader` and `evaluateWithScanner`. All three still funnel into `evaluateCore`.
 *   * The C# methods return `Task` and throw their argument guards SYNCHRONOUSLY; here they are
 *     `async`, so a guard failure arrives as a rejected promise. `computeChecks` is not async and
 *     still throws synchronously.
 */

/**
 * An unconditional rejection (no datastore query), e.g. a caveat parameter removal/type change.
 * Evaluation throws `SchemaWriteValidationException` with `message` the moment it is reached,
 * preserving the diff-order precedence of the historical inline checks.
 */
export interface UnconditionalCheck {
  readonly kind: "unconditional";
  readonly message: string;
}

/**
 * A data-existence guard: the change is valid only if `filter` matches NO live relationship.
 * `describe` renders the rejection message from the first offending relationship (the historical
 * "(e.g. {rel})" text, byte-identical).
 */
export interface NoOrphansCheck {
  readonly kind: "noOrphans";
  readonly filter: RelationshipsFilter;
  readonly describe: (relationship: Relationship) => string;
}

/**
 * One diff-derived guard a schema change must pass before it may commit. A closed union so the
 * checks can be BOTH evaluated client-side (against a pinned reader, producing the descriptive
 * `SchemaWriteValidationException` messages) AND - for the data-dependent shape - attached to the
 * schema-write `CommitRequest` as MUST_NOT_MATCH preconditions, so the sequencer grain re-proves
 * data-nonexistence atomically at the commit snapshot (closing the window between the client-side
 * validation read and the commit).
 */
export type SchemaChangeCheck = UnconditionalCheck | NoOrphansCheck;

/** The query shape `evaluateCore` is parameterised over - a reader query or a pinned scan. */
type QueryRelationships = (
  filter: RelationshipsFilter,
  signal: AbortSignal | undefined,
) => AsyncIterable<Relationship>;

/**
 * Throws `SchemaWriteValidationException` if applying `next` in place of `current` would orphan any
 * relationship in `reader`.
 */
export async function validate(
  current: CompiledSchema,
  next: CompiledSchema,
  reader: IDatastoreReader,
  signal?: AbortSignal | undefined,
): Promise<void> {
  if (current === undefined || current === null) {
    throw new InvalidArgumentError("current is required");
  }
  if (next === undefined || next === null) {
    throw new InvalidArgumentError("next is required");
  }
  if (reader === undefined || reader === null) {
    throw new InvalidArgumentError("reader is required");
  }

  return evaluateWithReader(computeChecks(current, next), reader, signal);
}

/**
 * Evaluates the computed checks in order against `reader`: an unconditional check throws
 * immediately; a no-orphans check throws (with the first offending relationship rendered into the
 * message) if its filter matches anything. Iteration order preserves the diff-order precedence the
 * historical inline checks had.
 */
export async function evaluateWithReader(
  checks: readonly SchemaChangeCheck[],
  reader: IDatastoreReader,
  signal?: AbortSignal | undefined,
): Promise<void> {
  if (checks === undefined || checks === null) {
    throw new InvalidArgumentError("checks is required");
  }
  if (reader === undefined || reader === null) {
    throw new InvalidArgumentError("reader is required");
  }

  return evaluateCore(checks, (filter, ct) => reader.queryRelationships(filter, ct), signal);
}

/**
 * Evaluates the computed checks against the storage-direct `ISnapshotScanner` seam at the pinned
 * `revision` - the schema-change data guards are broad existence scans, exactly the workload the
 * scan seam serves. Semantics are identical to the reader-based form (which the reference-model
 * path and tests keep).
 */
export async function evaluateWithScanner(
  checks: readonly SchemaChangeCheck[],
  scanner: ISnapshotScanner,
  revision: IRevision,
  signal?: AbortSignal | undefined,
): Promise<void> {
  if (checks === undefined || checks === null) {
    throw new InvalidArgumentError("checks is required");
  }
  if (scanner === undefined || scanner === null) {
    throw new InvalidArgumentError("scanner is required");
  }
  if (revision === undefined || revision === null) {
    throw new InvalidArgumentError("revision is required");
  }

  return evaluateCore(checks, (filter, ct) => scanner.scan(filter, revision, ct), signal);
}

async function evaluateCore(
  checks: readonly SchemaChangeCheck[],
  query: QueryRelationships,
  signal: AbortSignal | undefined,
): Promise<void> {
  for (const check of checks) {
    switch (check.kind) {
      case "unconditional":
        throw new SchemaWriteValidationException(check.message);

      case "noOrphans":
        // The C# `await foreach (...) throw` never reads a second row, so an eager materialisation
        // of the query would be a behaviour change on a large scan.
        for await (const rel of query(check.filter, signal)) {
          throw new SchemaWriteValidationException(check.describe(rel));
        }
        break;
    }
  }
}

/**
 * Computes the ordered guard list for replacing `current` with `next`: one `SchemaChangeCheck` per
 * removal-delta datastore probe (in `computeSchemaDiff` order, two for a removed relation - resource
 * side then subject side), plus unconditional entries for the caveat-parameter rejections. Pure (no
 * datastore access): the caller decides where the filters are evaluated.
 */
export function computeChecks(
  current: CompiledSchema,
  next: CompiledSchema,
): readonly SchemaChangeCheck[] {
  if (current === undefined || current === null) {
    throw new InvalidArgumentError("current is required");
  }
  if (next === undefined || next === null) {
    throw new InvalidArgumentError("next is required");
  }

  // Reuse the shared diff core, then derive orphan checks only from the removal deltas. Permission
  // removals / additions / allowed-type additions are always safe and carry no datastore check.
  const checks: SchemaChangeCheck[] = [];
  for (const delta of computeSchemaDiff(current, next)) {
    switch (delta.kind) {
      case "definitionRemoved": {
        // Whole definition removed: reject if ANY relationship has it as the resource type.
        const def = delta.definition;
        checks.push({
          kind: "noOrphans",
          filter: { optionalResourceType: def.name },
          describe: (rel) =>
            `cannot remove definition \`${def.name}\`: at least one relationship still references it as a resource type (e.g. ${formatRelationship(rel)})`,
        });
        break;
      }

      case "relationRemoved":
        // Base relation removed (or turned into a permission): reject if any relationship is
        // written under resource-type#relation, or references it as subject-type#relation.
        addRelationRemovedChecks(checks, delta.definitionName, delta.relation.name);
        break;

      case "relationSubjectTypeRemoved":
        // Allowed subject type removed: reject if any relationship still references it.
        checks.push(
          removedAllowedTypeCheck(delta.definitionName, delta.relation.name, delta.subjectType),
        );
        break;

      case "caveatParameterRemoved":
        // SpiceDB's sanityCheckCaveatChanges rejects parameter removal unconditionally (existing
        // relationships may carry context typed by the old parameter).
        checks.push({
          kind: "unconditional",
          message: `cannot remove parameter \`${delta.parameterName}\` on caveat \`${delta.caveatName}\``,
        });
        break;

      case "caveatParameterTypeChanged":
        // Likewise, a parameter type change is rejected unconditionally.
        checks.push({
          kind: "unconditional",
          message: `cannot change the type of parameter \`${delta.parameterName}\` on caveat \`${delta.caveatName}\``,
        });
        break;

      default:
        // Every other delta is silently skipped: the C# switch has no matching arm and produces
        // nothing. Deliberately NOT an `assertNever` - the default arm is reachable by design.
        break;
    }
  }

  return checks;
}

function addRelationRemovedChecks(
  checks: SchemaChangeCheck[],
  definition: string,
  relation: string,
): void {
  // Left side: written under resource-type#relation.
  checks.push({
    kind: "noOrphans",
    filter: {
      optionalResourceType: definition,
      optionalResourceRelation: relation,
    },
    describe: (rel) =>
      `cannot remove relation \`${relation}\` in definition \`${definition}\`: at least one relationship still references it (e.g. ${formatRelationship(rel)})`,
  });

  // Right side: referenced as a subject of this type with this subrelation. Historically this was a
  // reverse scan (SubjectsFilter(subjectType: definition, relationFilter: nonEllipsisRelation)); it
  // is expressed here as a subject-only forward filter so it can also ride the schema-write commit
  // as a MUST_NOT_MATCH precondition. EQUIVALENCE: both queryRelationships and
  // reverseQueryRelationships (options absent) enumerate the SAME set - every non-expired row live
  // at the revision - and keep a row purely by their filter's match. A subjects filter with no
  // subject ids and no resource constraints reduces to
  // (rel.subject.objectType === D && F matches rel.subject.relation); the subjects-selector form
  // here has no resource/caveat/expiration constraints set, so it reduces to the identical
  // predicate with the identical relation filter F, hence the identical existence answer (and, both
  // scans running in the same storage order, the identical first offending example row).
  checks.push({
    kind: "noOrphans",
    filter: {
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: definition,
          relationFilter: { nonEllipsisRelation: relation },
        },
      ],
    },
    describe: (rel) =>
      `cannot remove relation \`${relation}\` in definition \`${definition}\`: at least one relationship references it as part of a subject (e.g. ${formatRelationship(rel)})`,
  });
}

function removedAllowedTypeCheck(
  definition: string,
  relationName: string,
  allowed: AllowedRelation,
): SchemaChangeCheck {
  // This allowed subject type was removed: reject if any relationship under definition#relation has
  // a subject matching it. A direct subject (ellipsis subrelation) and a subrelation subject (e.g.
  // group#member) need different relation filters.
  const subjectRelation = allowed.relationName ?? ELLIPSIS;
  const relationFilter: SubjectRelationFilter =
    subjectRelation === ELLIPSIS
      ? { includeEllipsisRelation: true }
      : { nonEllipsisRelation: subjectRelation };
  // NULL, not an empty list: an empty list would match nothing.
  const subjectIds: readonly string[] | undefined = isAllowedRelationPublicWildcard(allowed)
    ? [PUBLIC_WILDCARD]
    : undefined;

  // Mirror SpiceDB's RelationAllowedTypeRemoved orphan check: the removed allowed type's identity
  // includes its required caveat and expiration trait, so the orphan query must filter on them too.
  // Removing `user with cav1` only orphans relationships that actually carry cav1 (not
  // cav2/no-caveat); removing `user with expiration` only orphans rows that carry an expiration.
  const caveat = allowed.requiredCaveat;
  const caveatFilter: CaveatNameFilter =
    caveat !== undefined && caveat.caveatName.length > 0
      ? { option: "hasMatchingCaveat", caveatName: caveat.caveatName }
      : { option: "noCaveat" };
  const expirationOption = allowed.requiresExpiration ? "hasExpiration" : "noExpiration";

  const filter: RelationshipsFilter = {
    optionalResourceType: definition,
    optionalResourceRelation: relationName,
    optionalSubjectsSelectors: [
      {
        optionalSubjectType: allowed.objectType,
        optionalSubjectIds: subjectIds,
        relationFilter,
      },
    ],
    optionalCaveatNameFilter: caveatFilter,
    optionalExpirationOption: expirationOption,
  };

  return {
    kind: "noOrphans",
    filter,
    describe: (rel) =>
      `cannot remove allowed subject type \`${allowedRelationSource(allowed)}\` from \`${definition}#${relationName}\`: at least one relationship still references it (e.g. ${formatRelationship(rel)})`,
  };
}
