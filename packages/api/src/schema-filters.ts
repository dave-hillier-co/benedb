import { status } from "@grpc/grpc-js";
import type { ReflectionSchemaFilter } from "@benedb/protos/authzed/api/v1/schema_service";

import { RpcError } from "./rpc-error";

/**
 * The set of `ReflectionSchemaFilter`s applied (OR'd) to a `ReflectSchema` response. Port of
 * Spiceport's `SchemaFilters.cs`, itself a port of SpiceDB's `newSchemaFilters` plus the
 * `HasNamespace`/`HasCaveat`/`HasRelation`/`HasPermission` prefix-match predicates in
 * `reflectionapi.go`.
 *
 * Within a single filter, a definition filter and a caveat filter are mutually exclusive, as are
 * a relation filter and a permission filter; a relation/permission filter requires a definition
 * filter. Violations throw {@link RpcError} with `INVALID_ARGUMENT`, as the C# throws
 * `RpcException`.
 *
 * Port decisions:
 *   * The C# sealed class with a private constructor becomes a factory returning an object with
 *     the four predicates: `schemaFiltersFromRequest` stays the ONLY constructor, and validation
 *     stays in it.
 *   * The filter list is held by reference, as the C# `IReadOnlyList` field is; no defensive copy.
 *   * `StartsWith(..., StringComparison.Ordinal)` is JS `String#startsWith`, which is already
 *     ordinal. Never `===`, never a case-insensitive compare.
 *   * The four predicates are transliterated separately rather than factored into one
 *     parameterized helper: their skip conditions differ, and that asymmetry is the behaviour.
 */
export interface SchemaFilters {
  /** True when no filters are present (everything passes) or some filter admits the definition. */
  matchesDefinition(definitionName: string): boolean;
  /** True when no filters are present, or some caveat-scoped filter admits the caveat. */
  matchesCaveat(caveatName: string): boolean;
  /** True when the relation passes for a definition that already matched. */
  matchesRelation(definitionName: string, relationName: string): boolean;
  /** True when the permission passes for a definition that already matched. */
  matchesPermission(definitionName: string, permissionName: string): boolean;
}

/** Validates and wraps the request's filters. */
export function schemaFiltersFromRequest(
  filters: readonly ReflectionSchemaFilter[],
): SchemaFilters {
  for (const f of filters) {
    const hasDef = !isNullOrEmpty(f.optionalDefinitionNameFilter);
    const hasCaveat = !isNullOrEmpty(f.optionalCaveatNameFilter);
    const hasRelation = !isNullOrEmpty(f.optionalRelationNameFilter);
    const hasPermission = !isNullOrEmpty(f.optionalPermissionNameFilter);

    if (hasDef && hasCaveat) throw invalid("cannot filter by both definition and caveat name");
    if (hasRelation && hasPermission)
      throw invalid("cannot filter by both relation and permission name");
    if ((hasRelation || hasPermission) && !hasDef)
      throw invalid("relation/permission filter requires a definition filter");
    if (hasCaveat && (hasRelation || hasPermission))
      throw invalid("cannot filter by both caveat and relation/permission name");
  }

  return {
    matchesDefinition(definitionName: string): boolean {
      // Caveat-only filters do not admit any definition; if every filter is caveat-only, no
      // definition matches.
      if (filters.length === 0) return true;

      for (const f of filters) {
        // A caveat-only filter (caveat name set, no definition name) never admits a definition.
        if (
          !isNullOrEmpty(f.optionalCaveatNameFilter) &&
          isNullOrEmpty(f.optionalDefinitionNameFilter)
        )
          continue;

        if (definitionMatches(f, definitionName)) return true;
      }

      return false;
    },

    matchesCaveat(caveatName: string): boolean {
      if (filters.length === 0) return true;

      for (const f of filters) {
        // A filter admits caveats only if it is caveat-scoped (or unscoped). Definition/relation/
        // permission-scoped filters never admit caveats.
        const defScoped =
          !isNullOrEmpty(f.optionalDefinitionNameFilter) ||
          !isNullOrEmpty(f.optionalRelationNameFilter) ||
          !isNullOrEmpty(f.optionalPermissionNameFilter);
        if (defScoped) continue;

        if (
          isNullOrEmpty(f.optionalCaveatNameFilter) ||
          caveatName.startsWith(f.optionalCaveatNameFilter)
        )
          return true;
      }

      return false;
    },

    matchesRelation(definitionName: string, relationName: string): boolean {
      if (filters.length === 0) return true;

      for (const f of filters) {
        if (
          !isNullOrEmpty(f.optionalCaveatNameFilter) &&
          isNullOrEmpty(f.optionalDefinitionNameFilter)
        )
          continue;
        // permission-only relation-side: excludes relations.
        if (!isNullOrEmpty(f.optionalPermissionNameFilter)) continue;
        if (!definitionMatches(f, definitionName)) continue;
        if (
          isNullOrEmpty(f.optionalRelationNameFilter) ||
          relationName.startsWith(f.optionalRelationNameFilter)
        )
          return true;
      }

      return false;
    },

    matchesPermission(definitionName: string, permissionName: string): boolean {
      if (filters.length === 0) return true;

      for (const f of filters) {
        if (
          !isNullOrEmpty(f.optionalCaveatNameFilter) &&
          isNullOrEmpty(f.optionalDefinitionNameFilter)
        )
          continue;
        // relation-only: excludes permissions.
        if (!isNullOrEmpty(f.optionalRelationNameFilter)) continue;
        if (!definitionMatches(f, definitionName)) continue;
        if (
          isNullOrEmpty(f.optionalPermissionNameFilter) ||
          permissionName.startsWith(f.optionalPermissionNameFilter)
        )
          return true;
      }

      return false;
    },
  };
}

function definitionMatches(f: ReflectionSchemaFilter, definitionName: string): boolean {
  return (
    isNullOrEmpty(f.optionalDefinitionNameFilter) ||
    definitionName.startsWith(f.optionalDefinitionNameFilter)
  );
}

/** C# `string.IsNullOrEmpty` over a proto string field, which defaults to the empty string. */
function isNullOrEmpty(value: string | undefined): boolean {
  return value === undefined || value.length === 0;
}

function invalid(message: string): RpcError {
  return new RpcError(status.INVALID_ARGUMENT, message);
}
