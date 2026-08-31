import type { CaveatExpression } from "@benedb/engine/caveat-expression";

import type { SerializedCaveat } from "./serialized-caveat";

/**
 * Maps between the engine's in-process `CaveatExpression` tree and the serializable
 * {@link SerializedCaveat} wire form carried across the grain boundary.
 *
 * In Spiceport the abstractions assembly cannot reference the engine, so the wire form is a
 * structural mirror of the engine tree and this assembly (which references both) owns the round
 * trip. The port keeps that split: `@benedb/grains` is the only package importing both.
 *
 * Both sides are discriminated unions, so each direction is a switch on `kind`. The C#'s default
 * arm THROWS `NotSupportedException` naming the node type, so this is one of the sites where the
 * THROWING form of `assertNever` is correct: a node kind neither side knows is a wire-contract
 * break, never a tolerated default.
 */

function assertNeverCaveatExpression(node: never): never {
  throw new Error(`Unknown caveat expression node: ${(node as { readonly kind: string }).kind}`);
}

function assertNeverSerializedCaveat(node: never): never {
  throw new Error(`Unknown serialized caveat node: ${(node as { readonly kind: string }).kind}`);
}

/** Converts an engine caveat expression to its wire form; absent maps to absent. */
export function caveatToWire(expr: CaveatExpression | undefined): SerializedCaveat | undefined {
  if (expr === undefined) return undefined;
  switch (expr.kind) {
    case "leaf":
      return {
        kind: "leaf",
        caveatName: expr.caveat.caveatName,
        context: expr.caveat.context,
      };
    case "or":
      return { kind: "or", children: expr.children.map(toWireNonNull) };
    case "and":
      return { kind: "and", children: expr.children.map(toWireNonNull) };
    case "not":
      return { kind: "not", child: toWireNonNull(expr.child) };
    default:
      return assertNeverCaveatExpression(expr);
  }
}

/** Converts a wire caveat back to the engine expression; absent maps to absent. */
export function caveatFromWire(wire: SerializedCaveat | undefined): CaveatExpression | undefined {
  if (wire === undefined) return undefined;
  switch (wire.kind) {
    case "leaf":
      return { kind: "leaf", caveat: { caveatName: wire.caveatName, context: wire.context } };
    case "or":
      return { kind: "or", children: wire.children.map(fromWireNonNull) };
    case "and":
      return { kind: "and", children: wire.children.map(fromWireNonNull) };
    case "not":
      return { kind: "not", child: fromWireNonNull(wire.child) };
    default:
      return assertNeverSerializedCaveat(wire);
  }
}

// The two `*NonNull` helpers are the C#'s asymmetry made explicit: `ToWire`/`FromWire` map null to
// null, but a COMPOSITE CHILD may not be null, and the C# throws `InvalidOperationException` if one
// is. TypeScript's types make that unreachable from in-process callers - but children may arrive
// from the wire, where the type is only a claim, so the guard is kept.

function toWireNonNull(expr: CaveatExpression): SerializedCaveat {
  const wire = caveatToWire(expr);
  if (wire === undefined) throw new Error("Composite caveat child must not be null.");
  return wire;
}

function fromWireNonNull(wire: SerializedCaveat): CaveatExpression {
  const expr = caveatFromWire(wire);
  if (expr === undefined) throw new Error("Composite caveat child must not be null.");
  return expr;
}
