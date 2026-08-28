import { isAllowedRelationPublicWildcard, type AllowedRelation } from "./allowed-relation";
import { ELLIPSIS } from "./core-constants";

/**
 * Computes the canonical source-string identity of an {@link AllowedRelation}, mirroring
 * SpiceDB's `schema.SourceForAllowedRelation` (`pkg/schema/definition.go`).
 *
 * The identity folds the object type, the subrelation (ellipsis-normalized), the public-wildcard
 * marker, the required caveat name, and the expiration trait. Two allowed types are "the same"
 * for diff and duplicate-detection purposes iff their identities are equal, so a change of caveat
 * name or of the `with expiration` trait is a genuine difference (as it is in SpiceDB), not a
 * no-op.
 *
 * The EXACT SPACING is load-bearing: `" with "` carries a leading and a trailing space, the
 * conjunction is `" and "`, and the trait word is `"expiration"`.
 */
export function allowedRelationSource(allowed: AllowedRelation): string {
  const hasCaveat = allowed.requiredCaveat !== undefined;
  const hasExpiration = allowed.requiresExpiration;

  let traits = "";
  if (hasCaveat || hasExpiration) {
    traits = " with ";
    if (hasCaveat) traits += allowed.requiredCaveat!.caveatName;
    if (hasCaveat && hasExpiration) traits += " and ";
    if (hasExpiration) traits += "expiration";
  }

  if (isAllowedRelationPublicWildcard(allowed)) return `${allowed.objectType}:*${traits}`;

  const rel = allowed.relationName ?? ELLIPSIS;
  if (rel !== ELLIPSIS) return `${allowed.objectType}#${rel}${traits}`;

  return `${allowed.objectType}${traits}`;
}
