import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import type { ISchemaHashSource } from "@spacedb/engine/i-schema-hash-source";
import {
  visitKeyOf,
  visitKeyToCanonicalString,
  type DispatchCheckRequest,
  type DispatchCheckResult,
  type IDispatcher,
} from "@spacedb/engine/i-dispatcher";
import type { GrainRuntime } from "@thresh/core/grain-runtime";

import { caveatFromWire } from "./caveat-wire";
import { setDispatchContext } from "./dispatch-context";
import { grainKeyBuild } from "./grain-key";
import { dispatchCheckReplyDepthRequired, ICheckGrain } from "./i-check-grain";
import type { IDispatchMetrics } from "./i-dispatch-metrics";

/**
 * The `{ getGrain }` seam {@link OrleansDispatcher} needs - one slice of Thresh's `GrainRuntime`,
 * standing in for Orleans' `IGrainFactory`, exactly as `SchemaSourceGrainFactory` does. Taking the
 * whole runtime would make every caller build one.
 */
export type DispatcherGrainFactory = Pick<GrainRuntime, "getGrain">;

/**
 * Ported from Spiceport `Grains/OrleansDispatcher.cs`.
 *
 * An {@link IDispatcher} that turns each sub-problem into a grain call: it derives the canonical
 * grain key from the request, resolves the keyed `ICheckGrain` through the grain factory, and
 * invokes `dispatchCheck`.
 *
 * This is how ALL recursion crosses grain boundaries: a grain computing one sub-problem dispatches
 * each of its children through an `OrleansDispatcher`, so every child becomes a call to a
 * (potentially same-process, but always grain-addressed) `ICheckGrain` activation keyed by that
 * child's identity. THERE IS NO IN-PROCESS LOCAL-RECURSE SHORTCUT - every sub-problem, local or
 * remote, is a grain call, and the grain directory is the only router. Adding a shortcut as an
 * optimisation would silently change the mesh's grain-call counts, which the mesh metrics tests
 * assert.
 *
 * `@spacedb/engine`'s `LocalDispatcher` is the in-process counterpart of this class: the two must
 * produce identical verdicts over the same data.
 */
export class OrleansDispatcher implements IDispatcher {
  readonly #grains: DispatcherGrainFactory;
  readonly #schemaHash: ISchemaHashSource;
  readonly #metrics: IDispatchMetrics | undefined;

  /**
   * Creates a dispatcher.
   *
   * @param grains The grain factory used to resolve keyed check grains.
   * @param schemaHash Supplies the live schema hash embedded in every grain key (scopes identity
   * to the current schema).
   * @param metrics Optional silo-wide counters (loop-bypass hits, activation-memo hit/miss).
   */
  constructor(
    grains: DispatcherGrainFactory,
    schemaHash: ISchemaHashSource,
    metrics?: IDispatchMetrics | undefined,
  ) {
    // `ArgumentNullException.ThrowIfNull(grains); ArgumentNullException.ThrowIfNull(schemaHash);`
    if (grains === undefined || grains === null) {
      throw new InvalidArgumentError("grains must not be null");
    }
    if (schemaHash === undefined || schemaHash === null) {
      throw new InvalidArgumentError("schemaHash must not be null");
    }
    this.#grains = grains;
    this.#schemaHash = schemaHash;
    this.#metrics = metrics;
  }

  /**
   * The canonical grain key for a sub-problem, identical to the key used to address its
   * `ICheckGrain`.
   *
   * This helper reads the AMBIENT hash UNCONDITIONALLY - a different rule from
   * {@link dispatchCheck}'s, which prefers the hash pinned in the request meta. It takes no meta,
   * so there is no pinned hash to prefer. The two rules must not be unified.
   */
  keyFor(resource: ObjectAndRelation, subject: ObjectAndRelation, revision: string): string {
    return grainKeyBuild(resource, subject, revision, this.#schemaHash.currentSchemaHash);
  }

  /** @inheritdoc */
  async dispatchCheck(
    request: DispatchCheckRequest,
    signal: AbortSignal | undefined,
  ): Promise<DispatchCheckResult> {
    // `ArgumentNullException.ThrowIfNull(request); ct.ThrowIfCancellationRequested();`
    if (request === undefined || request === null) {
      throw new InvalidArgumentError("request must not be null");
    }
    signal?.throwIfAborted();

    // Key off the schema hash PINNED at the check root for this revision (carried in the request
    // meta), not this silo's ambient current hash: the schema is a pure function of the pinned
    // revision, so every silo derives the same key and evaluates the same schema. Fall back to the
    // ambient hash only when the root pinned none (the seed-only window, before any writeSchema
    // persisted a schema), where the ambient hash is the identical embedded seed on every silo.
    // `??`, never `||`: an empty-string hash is a real value under C#'s `??`.
    const key = grainKeyBuild(
      request.resource,
      request.subject,
      request.meta.revision.toString(),
      request.meta.schemaHash ?? this.#schemaHash.currentSchemaHash,
    );

    // SINGLEFLIGHT-STYLE LOOP BYPASS (SpiceDB singleflight.go:69-81): if the exact visited set
    // already contains this sub-problem's (resource, subject) key, this is a GENUINE loop back to
    // a grain key that is (or would be) busy on the path above us. The grain call still happens
    // NORMALLY - the grain is reentrant, so a genuine same-key re-entry is accepted and terminates
    // deterministically on the depth budget, exactly as a fresh call would. What changes is the
    // RETURNED result: it is force-tagged `cycleCut` so no activation memo up the call chain ever
    // stores this path-dependent branch. A hit here is exact, never a false positive.
    //
    // The membership test is on the LENGTH-PREFIXED canonical string, which IS `VisitKey`'s
    // identity in this port (see `i-dispatcher.ts`): a plain separator join collides whenever an
    // object id contains the separator, and a false hit force-cuts a live sibling branch.
    const visit = visitKeyToCanonicalString(visitKeyOf(request.resource, request.subject));
    const loopBypass = request.meta.visited.has(visit);
    if (loopBypass) this.#metrics?.recordLoopBypass();

    const grain = this.#grains.getGrain(ICheckGrain, key);

    // The depth budget and exact visited-set cycle guard are call-chain context, not sub-problem
    // identity (already pinned by `key` above), so they ride ambiently via the dispatch context
    // rather than as a method argument. Set IMMEDIATELY BEFORE the grain call so it is exactly what
    // flows down into THIS hop (never a stale value from a previous sibling dispatch) - Thresh's
    // `RequestContext.set` mutates the ambient store in place where Orleans' was copy-on-write, so
    // sibling isolation holds only by that discipline. The visited set is already canonical
    // strings here, so the C#'s `.Select(v => v.ToCanonicalString())` is just the spread.
    setDispatchContext(request.meta.depthRemaining, [...request.meta.visited]);

    // NO try/catch. Deliberate cross-silo error mapping happens inside the grain call itself, via
    // the outgoing check-dispatch filter: known typed domain exceptions keep their own semantics
    // and pass through; transport/availability failures become a RETRIABLE unavailable; anything
    // else collapses to internal. Re-adding a catch here would double-wrap every failure.
    const reply = await grain.dispatchCheck(signal);

    const result: DispatchCheckResult = {
      member: reply.member,
      caveat: caveatFromWire(reply.caveat),
      cycleCut: reply.cycleCut,
      // `??`, never `||`: the C#'s `int DepthRequired = 1` default must not swallow an explicit 0.
      depthRequired: dispatchCheckReplyDepthRequired(reply),
    };

    // Force the loop-bypassed subtree cycle-cut so it is never memoized upstream, regardless of
    // what the (correctly computed) callee itself decided about its own memo. `with { CycleCut =
    // true }` is a fresh copy - only that one field is overridden.
    return loopBypass ? { ...result, cycleCut: true } : result;
  }
}
