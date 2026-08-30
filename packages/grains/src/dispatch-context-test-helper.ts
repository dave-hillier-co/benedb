import { setDispatchContext } from "./dispatch-context";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/DispatchContextTestHelper.cs`.
 *
 * Test-only convenience wrapper over {@link setDispatchContext}. Production callers only ever reach
 * `ICheckGrain.dispatchCheck` through the dispatcher, which sets the ambient depth budget and exact
 * visited-set cycle guard immediately before each grain call. Tests that resolve an `ICheckGrain`
 * DIRECTLY (bypassing the dispatcher, to isolate the grain's own behaviour) must do the same - this
 * is the honest cost of moving those fields out of the method signature and into ambient context.
 *
 * Set it immediately before each direct grain call, never once up front for several calls: Thresh's
 * `RequestContext.set` mutates the ambient store in place rather than copying it (unlike Orleans),
 * so a value set for one call is still there for the next unless it is overwritten. See
 * `dispatch-context.test.ts`.
 *
 * The C# takes an `ImmutableHashSet<VisitKey>` and canonicalises each key. In the port that
 * conversion has already happened one layer down - `ResolverMeta.visited` is a
 * `ReadonlySet<string>` of canonical strings, because TypeScript has no value-equality set - so
 * this takes the canonical strings directly. `visited` defaults to the empty set (no in-flight
 * visit keys), matching the C#'s optional parameter.
 *
 * LEDGER DEVIATION: the ledger row targets `dispatch-context-test-helper.test.ts`, and the helper
 * originally lived there alongside its own characterization cases. `CancellationAndImmutabilityTests`
 * imports it (`using static ...DispatchContextTestHelper`), and importing a `*.test.ts` module from
 * another suite re-registers that module's `describe` blocks inside the importing file - the same
 * harness-naming problem `mesh-test-cluster.ts` and `mesh-cluster-collection.ts` already took the
 * deviation for. The helper therefore lands here and its cases stay in
 * `dispatch-context-test-helper.test.ts`, which now imports it.
 *
 * It is still TEST-ONLY: nothing in the shipped grains package may import it.
 */
export function setTestDispatchContext(
  depthRemaining: number,
  visited: Iterable<string> = [],
): void {
  setDispatchContext(depthRemaining, [...visited]);
}
