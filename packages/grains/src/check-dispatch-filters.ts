import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { MaxDepthExceededException } from "@spacedb/core/max-depth-exceeded-exception";
import type {
  GrainCallContext,
  IncomingGrainCallFilter,
  OutgoingGrainCallFilter,
} from "@thresh/core/grain-call-filter";

import { requireDepthRemaining } from "./dispatch-context";
import { translateDispatchError } from "./dispatch-error-mapper";
import { ICheckGrain } from "./i-check-grain";
import type { IDispatchMetrics } from "./i-dispatch-metrics";

/**
 * Ported from Spiceport `Grains/CheckDispatchFilters.cs` (the internal `CheckDispatchFilter`
 * matcher plus the outgoing and incoming filters).
 *
 * Port decisions:
 *   * Orleans' `IOutgoingGrainCallFilter` / `IIncomingGrainCallFilter` are CLASSES with an
 *     `Invoke` method; Thresh's are FUNCTION TYPES `(context) => Promise<void>`. Each C# class
 *     therefore becomes a factory returning the filter function, with the constructor dependency
 *     (the optional metrics) becoming the factory's parameter.
 *   * METHOD MATCHING. The C# matches by reflection
 *     (`method.DeclaringType == typeof(ICheckGrain) && method.Name == nameof(DispatchCheck)`);
 *     Thresh's `GrainCallContext` carries `interfaceName` / `methodName` STRINGS instead, and the
 *     TypeScript member is spelled `dispatchCheck` with a LOWERCASE d. Both strings are derived
 *     from the interface rather than hard-coded, because getting the casing wrong makes BOTH
 *     filters silent no-ops on every call in the mesh - no type check catches it, and the only
 *     symptom is a missing depth guard.
 */

/** The method name, derived from `ICheckGrain` so a rename cannot silently un-match the filters. */
const DISPATCH_CHECK_METHOD: keyof ICheckGrain & string = "dispatchCheck";

/** The call identity both filters match on. */
type CallIdentity = Pick<GrainCallContext, "interfaceName" | "methodName">;

/**
 * Whether the intercepted call is `ICheckGrain.dispatchCheck`. The C#'s
 * `CheckDispatchFilter.Matches`.
 *
 * Both filters act ONLY on this method, so every other grain call in the mesh (the datastore
 * grain, the relationships grain, the reverse-ops worker, ...) passes through untouched with zero
 * overhead beyond this one comparison.
 */
export function matchesCheckDispatch(context: CallIdentity): boolean {
  return context.interfaceName === ICheckGrain.name && context.methodName === DISPATCH_CHECK_METHOD;
}

/**
 * Cross-silo exception classification for every `ICheckGrain.dispatchCheck` hop, lifted out of
 * `OrleansDispatcher` so the dispatcher itself carries only genuinely dispatch-semantic logic.
 * Wraps `context.invoke()` in the SAME try/catch that used to sit directly around the grain call:
 * a known domain exception (or an already-classified `DispatchFailedException`) is re-thrown
 * unchanged; everything else is collapsed via {@link translateDispatchError}.
 *
 * `OrleansDispatcher` passes the caller's own signal straight into `dispatchCheck`, so a caller
 * cancellation faults the grain call this filter wraps exactly like any other dispatch failure -
 * there is no separate caller-side race to special-case here.
 */
export function createCheckDispatchOutgoingCallFilter(): OutgoingGrainCallFilter {
  return async (context) => {
    // `ArgumentNullException.ThrowIfNull(context);`
    if (context === undefined || context === null) {
      throw new InvalidArgumentError("context must not be null");
    }

    if (!matchesCheckDispatch(context)) {
      await context.invoke();
      return;
    }

    try {
      await context.invoke();
    } catch (ex) {
      throw translateDispatchError(ex);
    }
  };
}

/**
 * The depth-budget BOUNDARY guard for every `ICheckGrain.dispatchCheck` call, enforced at the silo
 * before the grain body runs at all: a caller offering a depth budget (read from the ambient
 * dispatch context) <= 0 is rejected immediately with a {@link MaxDepthExceededException}, with no
 * activation-memo lookup and no relation-graph expansion.
 *
 * This is a BOUNDARY check, not a substitute for `LocalDispatcher`'s own in-step guard (which still
 * governs recursion WITHIN one grain's expansion step); this filter only rejects whatever arrives
 * already exhausted. It also records every matched call as a real dispatch hop - the one place in
 * the mesh a grain-call boundary crossing is counted independent of the callee's own
 * activation-memo outcome: a REJECTED call is still counted, because a message genuinely did cross
 * into this grain.
 *
 * THE ORDER OF THE FOUR STEPS IS LOAD-BEARING, and the mesh metrics tests assert the counts it
 * produces: (1) match, (2) `metrics?.recordDispatch()`, (3) the depth guard, (4) `invoke()`. Moving
 * (2) after (3) changes the count; moving (3) after (4) defeats the guard entirely, since the grain
 * body would already have run.
 *
 * @param metrics Optional silo-wide dispatch counters.
 */
export function createCheckDispatchIncomingCallFilter(
  metrics?: IDispatchMetrics | undefined,
): IncomingGrainCallFilter {
  return async (context) => {
    // `ArgumentNullException.ThrowIfNull(context);`
    if (context === undefined || context === null) {
      throw new InvalidArgumentError("context must not be null");
    }

    if (!matchesCheckDispatch(context)) {
      await context.invoke();
      return;
    }

    metrics?.recordDispatch();

    // The sender's request context is imported before any incoming call filter runs, so the depth
    // budget the caller set is already visible here. Reading it (rather than a method argument)
    // throws LOUDLY via `requireDepthRemaining` if some caller reached this grain without going
    // through that seam - deliberate, and never softened to a default.
    if (requireDepthRemaining() <= 0) throw new MaxDepthExceededException();

    await context.invoke();
  };
}
