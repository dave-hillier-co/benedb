import { ELLIPSIS } from "./core-constants";

/**
 * The subject types permitted for a base relation.
 *
 * Ported from Spiceport `AllowedRelation.cs`, which declares `AllowedRelationKind`,
 * `AllowedCaveat`, `ExpirationTrait`, `AllowedRelation` and `TypeInformation` together.
 *
 * Port decisions:
 *   * `AllowedRelationKind` mirrors the proto enum (Relation = 0, PublicWildcard = 1) via an
 *     explicit wire map, so the numbers do not ride on declaration order.
 *   * The two factories differ ASYMMETRICALLY and `allowed-relation-identity` depends on it:
 *     `direct` defaults the subrelation to the ellipsis, `wildcard` leaves it ABSENT.
 *   * `ExpirationTrait` is an empty C# record mirroring SpiceDB's empty proto message. An empty
 *     TypeScript interface is structurally `any`, so the type is branded and a single frozen
 *     instance is exposed.
 */

/** The kind of subject permitted by an {@link AllowedRelation}. */
export type AllowedRelationKind = "relation" | "publicWildcard";

const ALLOWED_RELATION_KIND_TO_WIRE: Readonly<Record<AllowedRelationKind, number>> = {
  relation: 0,
  publicWildcard: 1,
};

const ALLOWED_RELATION_KIND_FROM_WIRE: ReadonlyMap<number, AllowedRelationKind> = new Map<
  number,
  AllowedRelationKind
>([
  [0, "relation"],
  [1, "publicWildcard"],
]);

/** The proto enum value for an allowed-relation kind. */
export function allowedRelationKindToWire(kind: AllowedRelationKind): number {
  return ALLOWED_RELATION_KIND_TO_WIRE[kind];
}

/** The allowed-relation kind for a proto enum value, or `undefined` for an unknown value. */
export function allowedRelationKindFromWire(wire: number): AllowedRelationKind | undefined {
  return ALLOWED_RELATION_KIND_FROM_WIRE.get(wire);
}

/** References a caveat required on relationships that match an {@link AllowedRelation}. */
export interface AllowedCaveat {
  /** The name of the required caveat. */
  readonly caveatName: string;
}

/**
 * Placeholder trait indicating an allowed relation requires an expiration. Mirrors SpiceDB's
 * currently-empty `ExpirationTrait` proto message.
 *
 * BRANDED: an empty interface is structurally `any` in TypeScript, which would let every value
 * satisfy the type. The brand is a phantom field; use {@link EXPIRATION_TRAIT} as the value.
 */
export interface ExpirationTrait {
  readonly __expirationTrait?: never;
}

/** The single {@link ExpirationTrait} instance. */
export const EXPIRATION_TRAIT: ExpirationTrait = Object.freeze({});

/** Defines one permitted subject type for a base relation. */
export interface AllowedRelation {
  /** The subject namespace (e.g. "user", "org/user"). */
  readonly objectType: string;
  /** Whether this is a specific relation or a public wildcard. */
  readonly kind: AllowedRelationKind;
  /**
   * The subject's subrelation when `kind` is `"relation"`. Use `ELLIPSIS` for direct subjects.
   */
  readonly relationName?: string | undefined;
  /** Optional caveat that must be present on matching relationships. */
  readonly requiredCaveat?: AllowedCaveat | undefined;
  /** Whether matching relationships must carry an expiration. */
  readonly requiresExpiration: boolean;
}

/** True if this allowed relation is a public wildcard. Decided by the kind alone. */
export function isAllowedRelationPublicWildcard(allowed: AllowedRelation): boolean {
  return allowed.kind === "publicWildcard";
}

/** Creates an allowed direct subject type with the given subrelation (default ellipsis). */
export function allowedRelationDirect(
  objectType: string,
  relationName: string = ELLIPSIS,
  requiredCaveat?: AllowedCaveat | undefined,
  requiresExpiration = false,
): AllowedRelation {
  return { objectType, kind: "relation", relationName, requiredCaveat, requiresExpiration };
}

/**
 * Creates a public wildcard allowed relation for the given type.
 *
 * The subrelation is left ABSENT, not defaulted to the ellipsis - the C# passes `null` here, and
 * `allowedRelationSource` depends on the asymmetry.
 */
export function allowedRelationWildcard(
  objectType: string,
  requiredCaveat?: AllowedCaveat | undefined,
  requiresExpiration = false,
): AllowedRelation {
  return {
    objectType,
    kind: "publicWildcard",
    relationName: undefined,
    requiredCaveat,
    requiresExpiration,
  };
}

/** The set of subject types allowed for a base relation. */
export interface TypeInformation {
  /** The allowed subject types. */
  readonly allowedDirectRelations: readonly AllowedRelation[];
}
