import { contextualizedCaveatEquals, type ContextualizedCaveat } from "./contextualized-caveat";
import { InvalidArgumentError } from "./invalid-argument-error";
import { isPublicWildcard, type ObjectAndRelation } from "./object-and-relation";
import { relationshipIntegrityEquals, type RelationshipIntegrity } from "./relationship-integrity";
import { relationshipReferenceEquals, type RelationshipReference } from "./relationship-reference";

/**
 * A complete relationship (tuple): a resource and subject, plus optional caveat, expiration,
 * and integrity metadata.
 *
 * `optionalExpiration` is NANOSECONDS SINCE THE UNIX EPOCH as a `bigint`. The representation is
 * decided once, here at the value type, and reused by `RelationshipIntegrity.hashedAt`: the
 * tuple-string format emits 7 fractional digits (100ns ticks), which a millisecond `number` (or
 * a `Date`) cannot round-trip, and nanosecond values exceed 2^53.
 *
 * Formatting lives in `tuple-strings.ts`, which this module deliberately does not import, so
 * the C# cycle between `Relationship.ToString` and `TupleStrings` cannot bite at module-init.
 */
export interface Relationship {
  /** The identifying resource + subject pair. */
  readonly reference: RelationshipReference;
  /** Optional contextualized caveat. */
  readonly optionalCaveat?: ContextualizedCaveat | undefined;
  /** Optional expiration, in nanoseconds since the Unix epoch. */
  readonly optionalExpiration?: bigint | undefined;
  /** Optional cryptographic integrity metadata. */
  readonly optionalIntegrity?: RelationshipIntegrity | undefined;
}

/** Creates a relationship from a resource and subject ONR. */
export function createRelationship(
  resource: ObjectAndRelation,
  subject: ObjectAndRelation,
  caveat?: ContextualizedCaveat | undefined,
  expiration?: bigint | undefined,
  integrity?: RelationshipIntegrity | undefined,
): Relationship {
  return {
    reference: { resource, subject },
    optionalCaveat: caveat,
    optionalExpiration: expiration,
    optionalIntegrity: integrity,
  };
}

/** Returns a copy without integrity metadata. */
export function withoutIntegrity(relationship: Relationship): Relationship {
  return { ...relationship, optionalIntegrity: undefined };
}

/** Returns a copy with a different (or no) caveat. */
export function withCaveat(
  relationship: Relationship,
  caveat: ContextualizedCaveat | undefined,
): Relationship {
  return { ...relationship, optionalCaveat: caveat };
}

/**
 * Validates the relationship. Throws `InvalidArgumentError` (the port's `ArgumentException`) if
 * any field is empty or if the resource object id is a wildcard - resources may never be
 * wildcards, subjects may. The check order and the messages are wire-visible; keep both.
 *
 * `string.IsNullOrEmpty` is `=== undefined || === ""`; whitespace is NOT empty.
 */
export function validateRelationship(relationship: Relationship): void {
  const resource = relationship.reference.resource;
  const subject = relationship.reference.subject;

  if (
    isNullOrEmpty(resource.objectType) ||
    isNullOrEmpty(resource.objectId) ||
    isNullOrEmpty(resource.relation)
  )
    throw new InvalidArgumentError("relationship resource must be fully specified");
  if (
    isNullOrEmpty(subject.objectType) ||
    isNullOrEmpty(subject.objectId) ||
    isNullOrEmpty(subject.relation)
  )
    throw new InvalidArgumentError("relationship subject must be fully specified");
  if (isPublicWildcard(resource))
    throw new InvalidArgumentError("relationship resource object id may not be a wildcard '*'");
}

function isNullOrEmpty(value: string | undefined): boolean {
  return value === undefined || value === "";
}

/** Structural equality over the reference, caveat, expiration and integrity. */
export function relationshipEquals(a: Relationship, b: Relationship): boolean {
  return (
    relationshipReferenceEquals(a.reference, b.reference) &&
    contextualizedCaveatEquals(a.optionalCaveat, b.optionalCaveat) &&
    a.optionalExpiration === b.optionalExpiration &&
    relationshipIntegrityEquals(a.optionalIntegrity, b.optionalIntegrity)
  );
}
