import type { CaveatDefinition } from "./caveat-definition";
import { InvalidArgumentError } from "./invalid-argument-error";
import type { NamespaceDefinition } from "./namespace-definition";

/**
 * A complete compiled schema snapshot.
 *
 * Ported from Spiceport `StoredSchema.cs`.
 *
 * Port decisions:
 *   * `uint Version` becomes `number`. C#'s type system makes a negative version
 *     unrepresentable; TypeScript's does not, so {@link createStoredSchema} guards the uint32
 *     range instead.
 *   * The two `ImmutableDictionary` members become `ReadonlyMap` keyed by name.
 *   * `schemaHash` is compared against the hash carried in a `ZedToken`, so whatever computes it
 *     must be byte-stable. THIS FILE ONLY STORES IT: it neither computes nor validates it.
 */
export interface StoredSchema {
  /** Schema version number. Always in the uint32 range. */
  readonly version: number;
  /** The original schema DSL text. */
  readonly schemaText: string;
  /** A stable hash of the schema, used for consistency checks. */
  readonly schemaHash: string;
  /** All object-type definitions, keyed by name. */
  readonly namespaces: ReadonlyMap<string, NamespaceDefinition>;
  /** All caveat definitions, keyed by name. */
  readonly caveats: ReadonlyMap<string, CaveatDefinition>;
}

const MAX_UINT32 = 4294967295;

/**
 * Creates a stored schema, rejecting a version outside the uint32 range.
 *
 * The key of each map is not checked against the definition's own `name`; a disagreement is a
 * caller bug, exactly as it is in the C#.
 */
export function createStoredSchema(
  version: number,
  schemaText: string,
  schemaHash: string,
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  caveats: ReadonlyMap<string, CaveatDefinition>,
): StoredSchema {
  if (!Number.isInteger(version) || version < 0 || version > MAX_UINT32) {
    throw new InvalidArgumentError(`Schema version must be a uint32, but was ${String(version)}.`);
  }
  return { version, schemaText, schemaHash, namespaces, caveats };
}
