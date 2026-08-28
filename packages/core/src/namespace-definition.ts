import type { Relation } from "./relation";

/**
 * A schema definition for an object type (a SpiceDB "definition").
 *
 * Declared alongside `Relation` in Spiceport's `Relation.cs`; split into its own module here under
 * the no-barrels, one-primary-export rule.
 */
export interface NamespaceDefinition {
  /**
   * The namespace name. May contain "/" path segments (pattern
   * `([a-z][a-z0-9_]{1,62}[a-z0-9]/)*[a-z][a-z0-9_]{1,62}[a-z0-9]`). Not validated here.
   */
  readonly name: string;
  /**
   * The relations and permissions, with names unique within the namespace. Uniqueness is the
   * compiler's responsibility; this type performs no check of its own.
   */
  readonly relations: readonly Relation[];
}

/** Creates a namespace definition from a name and relations. */
export function createNamespaceDefinition(
  name: string,
  ...relations: Relation[]
): NamespaceDefinition {
  return { name, relations };
}
