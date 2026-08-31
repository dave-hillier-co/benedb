/**
 * A serializable mirror of the engine's `CaveatExpression` tree, used to carry a pre-context
 * gating caveat across the grain boundary.
 *
 * The engine's `CaveatExpression` lives in `@benedb/engine`, which this layer deliberately does
 * not reference. This tree is the wire form: a leaf names a caveat (with its
 * relationship-supplied context from `ContextualizedCaveat`, a core type), and composites combine
 * children with OR / AND / NOT. The dispatcher maps between this and the engine's tree.
 *
 * The C# is an abstract record with four nested sealed records. Per the port guide that becomes
 * ONE discriminated union with a literal `kind` DATA field - never a base object plus a nested
 * one - and `kind` has to be a plain own enumerable property, because `CaveatWire` and the
 * frontier reply SPREAD these nodes and a spread copies neither getters nor prototype members.
 *
 * `[GenerateSerializer]` needs no counterpart: Thresh's value codec is name-based, so a plain
 * readonly interface round-trips as it stands (the leaf context is a `Map`, which the codec
 * encodes natively - no surrogate).
 */
export type SerializedCaveat =
  SerializedCaveatLeaf | SerializedCaveatOr | SerializedCaveatAnd | SerializedCaveatNot;

/** A leaf caveat: a named caveat with its relationship-supplied context. */
export interface SerializedCaveatLeaf {
  /** The union discriminant. A plain data property, never a getter: `{ ...leaf }` must keep it. */
  readonly kind: "leaf";
  /** The name of the caveat definition. */
  readonly caveatName: string;
  /**
   * The relationship-supplied context, or absent for none. A `Map`, matching
   * `ContextualizedCaveat.context` exactly, so JSON key order survives; absent and empty stay
   * distinct at the value level, exactly as far as `ContextualizedCaveat` already keeps them.
   */
  readonly context?: ReadonlyMap<string, unknown> | undefined;
}

/** A logical OR over child expressions. */
export interface SerializedCaveatOr {
  /** The union discriminant. */
  readonly kind: "or";
  /** The child expressions. */
  readonly children: readonly SerializedCaveat[];
}

/** A logical AND over child expressions. */
export interface SerializedCaveatAnd {
  /** The union discriminant. */
  readonly kind: "and";
  /** The child expressions. */
  readonly children: readonly SerializedCaveat[];
}

/** A logical NOT of a single child expression. */
export interface SerializedCaveatNot {
  /** The union discriminant. */
  readonly kind: "not";
  /** The negated child expression. */
  readonly child: SerializedCaveat;
}
