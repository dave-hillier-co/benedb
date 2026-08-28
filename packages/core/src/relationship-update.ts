import type { Relationship } from "./relationship";

/**
 * The kind of mutation to apply to a relationship.
 *
 * The C# enum has EXPLICIT values mirroring the authzed proto enum - Touch = 0, Create = 1,
 * Delete = 2 - and those numbers are what cross the wire. This port uses a string-literal union
 * (house style) plus the explicit bidirectional map below, so nothing depends on declaration
 * order. Renumbering the map is a wire break.
 */
export type UpdateOperation = "touch" | "create" | "delete";

/** A single relationship mutation. */
export interface RelationshipUpdate {
  /** The relationship being mutated. */
  readonly relationship: Relationship;
  /** The operation to apply. */
  readonly operation: UpdateOperation;
}

const TO_WIRE: Readonly<Record<UpdateOperation, number>> = {
  touch: 0,
  create: 1,
  delete: 2,
};

const FROM_WIRE: ReadonlyMap<number, UpdateOperation> = new Map<number, UpdateOperation>([
  [0, "touch"],
  [1, "create"],
  [2, "delete"],
]);

/** The proto enum value for an operation. */
export function updateOperationToWire(operation: UpdateOperation): number {
  return TO_WIRE[operation];
}

/** The operation for a proto enum value, or `undefined` for an unknown value. */
export function updateOperationFromWire(wire: number): UpdateOperation | undefined {
  return FROM_WIRE.get(wire);
}
