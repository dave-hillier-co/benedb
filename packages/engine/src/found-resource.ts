import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";

import type { LookupResourcesCursor } from "./lookup-resources-cursor";
import type { Membership } from "./membership";

/**
 * A resource found by `lookupResources` for a subject and permission.
 *
 * Ported from Spiceport `src/Spiceport.Server/Engine/Lookup/FoundResource.cs`; port of SpiceDB's
 * `v1.LookupResourcesResponse` / `possibleResource`. A `"caveated"` result means the resource is
 * reachable only if the named {@link missingContextParams} satisfy the caveat - identical to
 * `CAVEATED_MEMBER` + `MissingExprFields`. The membership is never `"notMember"`: non-members are
 * simply not yielded.
 *
 * Port decisions:
 *   * The C# has the same absent-vs-empty CONFLATION as `CheckResult` - the primary constructor
 *     takes `IReadOnlyList<string>? = null` and an `init` property re-declares it as `?? []` - so
 *     `missingContextParams` is non-optional and {@link createFoundResource} applies the `?? []`.
 *   * `afterCursor` is set through `found with { AfterCursor = ... }` in two places in the engine
 *     (`Prepend` and the Portion-1 yield). That is an object spread producing a FRESH object: the
 *     engine relies on the original being unchanged as a result bubbles up through nesting levels.
 */
export interface FoundResource {
  /** The reachable resource object id. */
  readonly resourceId: string;
  /** Which input subject ids reached this resource. */
  readonly forSubjectIds: readonly string[];
  /** `"member"` or `"caveated"`; never `"notMember"`. */
  readonly membership: Membership;
  /** When `"caveated"`, the unresolved caveat params; empty otherwise. */
  readonly missingContextParams: readonly string[];
  /** A resume token positioned after this result. */
  readonly afterCursor?: LookupResourcesCursor | undefined;
}

/**
 * Creates a {@link FoundResource}, normalising an absent missing-params list to an empty one and
 * asserting the invariant the C# records only in its doc comment: the membership is never
 * `"notMember"`.
 */
export function createFoundResource(
  resourceId: string,
  forSubjectIds: readonly string[],
  membership: Membership,
  missingContextParams?: readonly string[] | undefined,
  afterCursor?: LookupResourcesCursor | undefined,
): FoundResource {
  if (membership === "notMember") {
    throw new InvalidArgumentError(
      "A FoundResource is never a non-member: non-members are simply not yielded.",
    );
  }

  return {
    resourceId,
    forSubjectIds,
    membership,
    missingContextParams: missingContextParams ?? [],
    afterCursor,
  };
}
