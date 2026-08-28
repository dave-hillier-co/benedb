/**
 * Caveat definitions and their parameter type references.
 *
 * Ported from Spiceport `CaveatDefinition.cs`. `CaveatTypeReference` stays in this module: it is
 * a helper shape for the definition's parameter map, not a peer entity.
 *
 * Port decisions:
 *   * `ChildTypes` is NULL for a scalar, not an empty list, and the DSL compiler's test asserts
 *     exactly that. `undefined` and `[]` stay distinct, in the data and in equality.
 *   * `byte[] SerializedExpression` becomes `Uint8Array`. As with `RelationshipIntegrity.hash`,
 *     C# record equality over `byte[]` is REFERENCE equality; this port compares content, because
 *     a compiled expression is a value.
 *   * `ParameterTypes` is an `ImmutableDictionary` in C#, enumerated in HASH order. A `Map`
 *     preserves insertion order instead. That divergence is harmless only while nothing
 *     serializes or hashes the parameter list in enumeration order.
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

function expressionEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Content equality over the name, the expression bytes and the parameter map. */
export function caveatDefinitionEquals(a: CaveatDefinition, b: CaveatDefinition): boolean {
  if (a.name !== b.name) return false;
  if (!expressionEquals(a.serializedExpression, b.serializedExpression)) return false;
  if (a.parameterTypes.size !== b.parameterTypes.size) return false;
  for (const [name, type] of a.parameterTypes) {
    const other = b.parameterTypes.get(name);
    if (other === undefined) return false;
    if (!caveatTypeReferenceEquals(type, other)) return false;
  }
  return true;
}
