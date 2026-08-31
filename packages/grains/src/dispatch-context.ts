import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { RequestContext } from "@thresh/core/request-context";

/**
 * The ambient-context key carrying the remaining recursion depth budget. Verbatim from the C#: the
 * key literals are the wire contract between silos.
 */
export const DISPATCH_DEPTH_REMAINING_KEY = "spiceport.dispatch.depthRemaining";

/** The ambient-context key carrying the exact visited-set cycle guard. Verbatim from the C#. */
export const DISPATCH_VISITED_KEY = "spiceport.dispatch.visited";

/**
 * Thrown when a dispatch-context key is absent from the ambient `RequestContext`, or present but
 * undecodable. The C# throws `InvalidOperationException`; the port names the invariant instead, per
 * the port guide.
 *
 * A corrupted value is no less lost than a missing one, so both raise this: the C# treats a lost
 * context as a bug that must surface loudly, never a silent default of zero.
 */
export class MissingDispatchContextError extends Error {
  /** The dispatch-context key that was missing or undecodable. */
  readonly key: string;

  /** Creates the error naming the missing key. */
  constructor(key: string) {
    super(
      `DispatchContext key '${key}' is missing from the Orleans RequestContext. Every ` +
        "ICheckGrain.DispatchCheck call must set it beforehand - via " +
        "OrleansDispatcher in production, or the test SetDispatchContext helper in a direct " +
        "grain call - never silently default a lost call-chain context.",
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "MissingDispatchContextError";
    this.key = key;
  }
}

/**
 * The call-chain context threaded ambiently across every `ICheckGrain.dispatchCheck` hop via
 * Thresh's `RequestContext`, rather than as an explicit method argument.
 *
 * WHY THESE FIELDS ARE CONTEXT, NOT IDENTITY. The grain's own string key already pins the canonical
 * sub-problem (resource, subject, quantized revision, schema hash). The remaining recursion budget
 * and the exact visited-set cycle guard are NOT part of that identity: two callers asking the exact
 * same sub-problem on different recursion paths address the same grain but may carry a different
 * depth budget / visited-set state. Since the wire contract for a dispatch call should be exactly
 * the canonical sub-problem, these cross-cutting fields ride in `RequestContext` instead.
 *
 * TWO PORT DEVIATIONS FROM THE C#'s SCOPING REMARKS, both pinned in `dispatch-context.test.ts`:
 *
 * 1. THRESH VALUES ARE STRINGS ONLY. Orleans stored an `int` and a `string[]` directly. Here the
 *    depth is encoded as a decimal string and the visited set as a JSON array, decoded at the get.
 *    A DECODE FAILURE throws the same {@link MissingDispatchContextError} as an absent key.
 * 2. SCOPING SEMANTICS DIVERGE. Orleans' `Set` is copy-on-write (a fresh dictionary each time), so
 *    the C# could promise that a value set before an awaited call "never leaks back UP to the
 *    caller". Thresh's `set` MUTATES the ambient store in place within the current scope, so it
 *    DOES leak up. Sibling isolation - the property the dispatcher actually relies on - still
 *    holds, because every dispatch site calls {@link setDispatchContext} immediately before its own
 *    grain call and so overwrites whatever a previous sibling left behind.
 *
 * A missing key when reading is treated as a bug, not a default: every legitimate call path (the
 * dispatcher, or a test's `setTestDispatchContext` helper) sets both values before the grain call,
 * so an absence means some caller reached `ICheckGrain.dispatchCheck` without going through that
 * seam.
 */
export function setDispatchContext(depthRemaining: number, visited: readonly string[]): void {
  // The C#'s `ArgumentNullException.ThrowIfNull(visited)`.
  if (visited === undefined || visited === null) {
    throw new InvalidArgumentError("visited must not be null or undefined");
  }
  RequestContext.set(DISPATCH_DEPTH_REMAINING_KEY, String(depthRemaining));
  // JSON, not a delimiter join: a canonical VisitKey string is length-prefixed and U+001F
  // unit-separated, so any printable delimiter would corrupt it.
  RequestContext.set(DISPATCH_VISITED_KEY, JSON.stringify(visited));
}

/**
 * Attempts to read the remaining recursion depth budget from the ambient context, returning
 * `undefined` when it is absent or undecodable. The C#'s `TryGetDepthRemaining(out int)`.
 */
export function tryGetDepthRemaining(): number | undefined {
  const raw = RequestContext.get(DISPATCH_DEPTH_REMAINING_KEY);
  if (raw === undefined) return undefined;
  // Digits only (with an optional sign, so the encoding is a faithful int round-trip). `Number` and
  // `parseInt` would accept whitespace, a decimal point, `0x` and an exponent.
  if (!/^-?[0-9]+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Reads the remaining recursion depth budget from the ambient context, throwing if it is absent
 * (a lost context is a bug that must surface loudly, never silently default).
 */
export function requireDepthRemaining(): number {
  const value = tryGetDepthRemaining();
  if (value === undefined) throw new MissingDispatchContextError(DISPATCH_DEPTH_REMAINING_KEY);
  return value;
}

/**
 * Reads the exact visited-set cycle guard (canonical visit-key strings) from the ambient context,
 * throwing if it is absent or does not decode to an array of strings.
 */
export function requireVisited(): readonly string[] {
  const raw = RequestContext.get(DISPATCH_VISITED_KEY);
  if (raw === undefined) throw new MissingDispatchContextError(DISPATCH_VISITED_KEY);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new MissingDispatchContextError(DISPATCH_VISITED_KEY);
  }
  // A well-formed value of the wrong shape - a silo running a different build, or a key collision -
  // must not degrade into a half-populated cycle guard.
  if (!Array.isArray(decoded) || decoded.some((entry) => typeof entry !== "string")) {
    throw new MissingDispatchContextError(DISPATCH_VISITED_KEY);
  }
  return decoded as string[];
}
