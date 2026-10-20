import { bytesEqual } from "./structural-equality";

/**
 * Caveat definitions and their parameter type references.
 *
 * Ported from Spiceport `CaveatDefinition.cs`. `CaveatTypeReference` stays in this module: it is
 * a helper shape for the definition's parameter map, not a peer entity.
 *
 * Port decisions:
 *   * `ChildTypes` is NULL for a scalar, not an empty list, and the DSL compiler's test asserts
 *     exactly that. `undefined` and `[]` stay distinct, in the data and in equality.
 *   * `byte[] SerializedExpression` becomes `Uint8Array`. Both records override their equality to
 *     compare by content (child types element-wise, expression bytes and the parameter map by
 *     value), and the two `...Equals` functions here are those overrides.
 *   * `ParameterTypes` is an `ImmutableDictionary` in C#, enumerated in HASH order. A `Map`
 *     preserves insertion order instead. That divergence is harmless only while nothing
 *     serializes or hashes the parameter list in enumeration order.
 *   * The C# `Comments` is an `ImmutableList<string>` init-property defaulting to empty. Here it
 *     is optional, and absent means none: hand-built model objects leave it out, the DSL compiler
 *     always sets it.
 */

/**
 * A type reference for a caveat parameter, supporting nested generic types (e.g. `list<int>`,
 * `map<string, T>`).
 */
export interface CaveatTypeReference {
  /** The base type name (e.g. "string", "int", "list", "map"). */
  readonly typeName: string;
  /** Type arguments for generic types, or `undefined` for scalars. */
  readonly childTypes?: readonly CaveatTypeReference[] | undefined;
}

/** A schema definition for a caveat. */
export interface CaveatDefinition {
  /** The caveat name (may contain "/" path segments). */
  readonly name: string;
  /**
   * The opaque compiled expression (e.g. serialized CEL). Stored as bytes; not interpreted by
   * core.
   */
  readonly serializedExpression: Uint8Array;
  /** The caveat parameters keyed by name. */
  readonly parameterTypes: ReadonlyMap<string, CaveatTypeReference>;
  /**
   * The doc comments that preceded the caveat, each verbatim with its `//` or block-comment markers
   * and every line trimmed (SpiceDB's `DocComment` metadata). Metadata, not semantics: it takes no
   * part in equality. Absent means none.
   */
  readonly comments?: readonly string[] | undefined;
}

/** Deep structural equality over two type references, child list order included. */
export function caveatTypeReferenceEquals(a: CaveatTypeReference, b: CaveatTypeReference): boolean {
  if (a.typeName !== b.typeName) return false;
  const ac = a.childTypes;
  const bc = b.childTypes;
  // An absent child list is not an empty one: a scalar is not a zero-argument generic.
  if (ac === undefined || bc === undefined) return ac === bc;
  if (ac.length !== bc.length) return false;
  for (let i = 0; i < ac.length; i++) {
    const left = ac[i];
    const right = bc[i];
    if (left === undefined || right === undefined) return false;
    if (!caveatTypeReferenceEquals(left, right)) return false;
  }
  return true;
}

/**
 * Value equality, comparing the expression bytes and the parameter map by content rather than by
 * array and map reference. `comments` is metadata and is not compared.
 */
export function caveatDefinitionEquals(a: CaveatDefinition, b: CaveatDefinition): boolean {
  if (a === b) return true;
  if (
    a.name !== b.name ||
    !bytesEqual(a.serializedExpression, b.serializedExpression) ||
    a.parameterTypes.size !== b.parameterTypes.size
  ) {
    return false;
  }
  for (const [name, type] of a.parameterTypes) {
    const other = b.parameterTypes.get(name);
    if (other === undefined) return false;
    if (!caveatTypeReferenceEquals(type, other)) return false;
  }
  return true;
}
