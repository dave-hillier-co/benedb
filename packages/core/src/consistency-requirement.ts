import { InvalidArgumentError } from "./invalid-argument-error";
import type { ZedToken } from "./zed-token";

/**
 * The consistency a read request demands, mirroring `authzed.api.v1.Consistency`.
 *
 * The C# is an abstract record with a PRIVATE constructor and four nested sealed variants - a
 * closed hierarchy, which becomes a discriminated union with a literal `kind` plus a local
 * `assertNever` at every match site.
 *
 * The SEMANTICS - max(token, optimized) for at-least-as-fresh, exact pinning for
 * at-exact-snapshot - are implemented by the resolver in a later stage; this file only carries
 * the union.
 */
export type ConsistencyRequirement =
  | MinimizeLatencyRequirement
  | FullyConsistentRequirement
  | AtLeastAsFreshRequirement
  | AtExactSnapshotRequirement;

/** Minimize-latency variant. */
export interface MinimizeLatencyRequirement {
  readonly kind: "minimizeLatency";
}

/** Fully-consistent variant. */
export interface FullyConsistentRequirement {
  readonly kind: "fullyConsistent";
}

/** At-least-as-fresh variant carrying the floor token. */
export interface AtLeastAsFreshRequirement {
  readonly kind: "atLeastAsFresh";
  readonly token: ZedToken;
}

/** At-exact-snapshot variant carrying the exact token. */
export interface AtExactSnapshotRequirement {
  readonly kind: "atExactSnapshot";
  readonly token: ZedToken;
}

/**
 * The default: read at the optimized (quantized, head-pinned) revision for best latency/cache hit
 * rate.
 *
 * A frozen module-level SINGLETON, because the C# is a static singleton property and a caller may
 * legitimately compare by reference; a factory would hand out fresh objects and quietly break
 * that.
 */
export const MINIMIZE_LATENCY: MinimizeLatencyRequirement = Object.freeze({
  kind: "minimizeLatency" as const,
});

/** Read at the freshest committed (head) revision. A frozen singleton, as `MINIMIZE_LATENCY` is. */
export const FULLY_CONSISTENT: FullyConsistentRequirement = Object.freeze({
  kind: "fullyConsistent" as const,
});

/**
 * Read at least as fresh as the supplied token (read-your-writes); picks max(token, optimized).
 * Throws if the token is missing - the C# `ArgumentNullException` guard is kept, since a missing
 * token here otherwise surfaces much later as a corrupt read.
 */
export function atLeastAsFresh(token: ZedToken): AtLeastAsFreshRequirement {
  if (token === undefined || token === null) {
    throw new InvalidArgumentError("token must not be null");
  }
  return { kind: "atLeastAsFresh", token };
}

/** Read exactly at the snapshot encoded by the supplied token. Throws if the token is missing. */
export function atExactSnapshot(token: ZedToken): AtExactSnapshotRequirement {
  if (token === undefined || token === null) {
    throw new InvalidArgumentError("token must not be null");
  }
  return { kind: "atExactSnapshot", token };
}
