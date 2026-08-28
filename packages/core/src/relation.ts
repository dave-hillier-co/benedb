import type { AllowedRelation, TypeInformation } from "./allowed-relation";
import type { UsersetRewrite } from "./userset-rewrite";

/**
 * A relation or permission within a namespace definition.
 *
 * Ported from Spiceport `Relation.cs`. That file also declares `NamespaceDefinition`, which under
 * the no-barrels, one-primary-export rule gets its own module (`namespace-definition.ts`).
 */
export interface Relation {
  /** The relation/permission name. */
  readonly name: string;
  /**
   * Present for a permission (a computed relation); absent for a base relation (written as
   * tuples).
   */
  readonly usersetRewrite?: UsersetRewrite | undefined;
  /** The allowed subject types for a base relation. Typically absent for permissions. */
  readonly typeInformation?: TypeInformation | undefined;
  /**
   * Optional relation this one is a canonical alias of. Unused by the S1 compiler; carried so
   * later stages can populate it.
   */
  readonly aliasingRelation?: string | undefined;
  /**
   * Optional precomputed canonical cache key. Unused by the S1 compiler; carried so later stages
   * can populate it.
   */
  readonly canonicalCacheKey?: string | undefined;
}

/**
 * True if this is a permission (has a userset rewrite).
 *
 * A permission is EXACTLY a relation with a rewrite; the DSL compiler relies on the equivalence.
 */
export function isPermission(relation: Relation): boolean {
  return relation.usersetRewrite !== undefined;
}

/** Creates a base relation with the given allowed subject types. */
export function baseRelation(name: string, ...allowedTypes: AllowedRelation[]): Relation {
  return { name, typeInformation: { allowedDirectRelations: allowedTypes } };
}

/** Creates a permission with the given userset rewrite. */
export function permission(name: string, rewrite: UsersetRewrite): Relation {
  return { name, usersetRewrite: rewrite };
}
