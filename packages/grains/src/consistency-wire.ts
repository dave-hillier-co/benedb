import type { ConsistencyRequirement } from "@spacedb/core/consistency-requirement";
import {
  atExactSnapshot,
  atLeastAsFresh,
  MINIMIZE_LATENCY,
} from "@spacedb/core/consistency-requirement";
import { FULLY_CONSISTENT } from "@spacedb/core/consistency-requirement";
import type { ZedToken } from "@spacedb/core/zed-token";

/**
 * The selected consistency mode on the wire.
 *
 * The C# enum's numbers are Orleans-internal (the API layer owns the proto mapping), so this is a
 * plain string-literal union carrying the names.
 */
export type ConsistencyModeWire =
  /** Read at the optimized revision (default). */
  | "minimizeLatency"
  /** Read at least as fresh as `ConsistencyWire.token`. */
  | "atLeastAsFresh"
  /** Read at head. */
  | "fullyConsistent"
  /** Read exactly at `ConsistencyWire.token`. */
  | "atExactSnapshot";

/**
 * The serializable consistency requirement carried across grain calls. Maps to and from the domain
 * `ConsistencyRequirement`. An absent wire means minimize-latency.
 */
export interface ConsistencyWire {
  /** The selected mode. */
  readonly mode: ConsistencyModeWire;
  /** The token the token-bearing modes require. An EMPTY token is a legal token. */
  readonly token?: string | undefined;
}

/**
 * The minimize-latency requirement (the server default).
 *
 * A `static ... { get; }` singleton in the C#, so a FROZEN module constant rather than a factory:
 * `consistencyWireFromRequirement` hands this very instance back for the minimize case, and a
 * factory would silently break any reference match.
 */
export const MINIMIZE_LATENCY_WIRE: ConsistencyWire = Object.freeze({
  mode: "minimizeLatency" as const,
});

/** The fully-consistent requirement (read at head; reflects all committed writes). A frozen singleton. */
export const FULLY_CONSISTENT_WIRE: ConsistencyWire = Object.freeze({
  mode: "fullyConsistent" as const,
});

/** Thrown when a token-bearing consistency mode carries no token (C# `InvalidOperationException`). */
export class ConsistencyTokenRequiredError extends Error {
  /** Creates the error, naming the mode that requires a token. */
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "ConsistencyTokenRequiredError";
  }
}

/** Converts to the domain `ConsistencyRequirement`. */
export function consistencyWireToRequirement(wire: ConsistencyWire): ConsistencyRequirement {
  switch (wire.mode) {
    case "minimizeLatency":
      return MINIMIZE_LATENCY;
    case "fullyConsistent":
      return FULLY_CONSISTENT;
    case "atLeastAsFresh":
      return atLeastAsFresh(requireToken(wire));
    case "atExactSnapshot":
      return atExactSnapshot(requireToken(wire));
    default:
      return assertNeverMinimizeLatency(wire.mode);
  }
}

/** Builds the wire form from a domain requirement. */
export function consistencyWireFromRequirement(
  requirement: ConsistencyRequirement,
): ConsistencyWire {
  switch (requirement.kind) {
    case "minimizeLatency":
      // The SHARED singleton, where the fully-consistent arm below allocates a fresh object. The
      // asymmetry is the C#'s and is transliterated literally rather than made uniform.
      return MINIMIZE_LATENCY_WIRE;
    case "fullyConsistent":
      return { mode: "fullyConsistent" };
    case "atLeastAsFresh":
      return { mode: "atLeastAsFresh", token: requirement.token.token };
    case "atExactSnapshot":
      return { mode: "atExactSnapshot", token: requirement.token.token };
    default:
      return assertNeverMinimizeLatencyWire(requirement);
  }
}

/**
 * The C#'s `Token ?? throw`: only an ABSENT token trips the guard, so an empty string is a legal
 * token - which matters, because "" is what an unset proto string field arrives as.
 */
function requireToken(wire: ConsistencyWire): ZedToken {
  if (wire.token === undefined) {
    throw new ConsistencyTokenRequiredError(`consistency mode ${wire.mode} requires a token`);
  }
  return { token: wire.token };
}

// Both C# default arms RETURN MinimizeLatency rather than throwing, so these are the RETURNING
// form of the exhaustiveness helper: compile-time coverage is kept while the deliberately tolerant
// default survives. A throwing `assertNever` here would crash on exactly the inputs (an unknown
// mode from a newer peer) the C# was written to tolerate.
function assertNeverMinimizeLatency(mode: never): ConsistencyRequirement {
  void mode;
  return MINIMIZE_LATENCY;
}

function assertNeverMinimizeLatencyWire(requirement: never): ConsistencyWire {
  void requirement;
  return MINIMIZE_LATENCY_WIRE;
}
