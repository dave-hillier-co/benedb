import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { createFixedSchemaHashSource } from "@spacedb/engine/i-schema-hash-source";
import {
  visitKeyOf,
  visitKeyToCanonicalString,
  type DispatchCheckRequest,
  type ResolverMeta,
} from "@spacedb/engine/i-dispatcher";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainKeyFor } from "@thresh/core/key-kinds";
import { RequestContext } from "@thresh/core/request-context";
import { beforeEach, describe, expect, it } from "vitest";

import { requireDepthRemaining, requireVisited } from "./dispatch-context";
import { grainKeyBuild } from "./grain-key";
import { DispatchMetrics } from "./i-dispatch-metrics";
import { ICheckGrain, type DispatchCheckReply } from "./i-check-grain";
import { OrleansDispatcher } from "./orleans-dispatcher";

// CHARACTERIZATION test for `src/Spiceport.Server/Grains/OrleansDispatcher.cs`.
//
// The C# is covered only from the mesh suites (a TestCluster plus the six grain implementations),
// none of which this slice has, so this file is the whole gate. Every expectation below is read
// off the C# body, which is short and dense - the ORDER of its five steps is as load-bearing as
// their content:
//
//   1. key = GrainKey.Build(resource, subject, meta.Revision.ToString(),
//                           meta.SchemaHash ?? _schemaHash.CurrentSchemaHash)   <- `??`, not `||`
//   2. visit = VisitKey.Of(resource, subject); loopBypass = meta.Visited.Contains(visit)
//   3. if (loopBypass) metrics?.RecordLoopBypass()                              <- call NOT skipped
//   4. grain = grains.GetGrain<ICheckGrain>(key)
//   5. DispatchContext.Set(meta.DepthRemaining, meta.Visited...)                <- immediately before
//   6. reply = await grain.DispatchCheck(ct)                                    <- NO try/catch
//   7. result = new(reply.Member, CaveatWire.FromWire(reply.Caveat), reply.CycleCut,
//                   reply.DepthRequired); return loopBypass ? result with { CycleCut = true } : result;
//
// The C# remark is explicit that there is NO in-process local-recurse shortcut: every sub-problem,
// local or remote, is a grain call.

const AMBIENT_HASH = "ambient-schema-hash";

const DOCUMENT_VIEW: ObjectAndRelation = {
  objectType: "document",
  objectId: "readme",
  relation: "view",
};
const ALICE: ObjectAndRelation = { objectType: "user", objectId: "alice", relation: ELLIPSIS };

/** A revision whose only interesting behaviour is its string form (what reaches the grain key). */
function stubRevision(text: string): IRevision {
  return {
    byteSortable: false,
    toString: () => text,
    compareTo: (other) => (other === undefined ? 1 : 0),
    equals: (other) => other !== undefined && other.toString() === text,
    greaterThan: () => false,
  };
}

const REVISION = stubRevision("1700000000000000000");

interface RecordedCall {
  /** The grain interface the dispatcher resolved through. */
  readonly definition: GrainInterface<unknown>;
  /** The string grain key it addressed. */
  readonly key: string;
  /** The ambient depth budget the grain observed AT CALL TIME. */
  readonly depthRemaining: number;
  /** The ambient visited set the grain observed AT CALL TIME. */
  readonly visited: readonly string[];
  /** The signal the dispatcher passed across the boundary. */
  readonly signal: AbortSignal | undefined;
}

/**
 * A `{ getGrain }` factory (the port's slice of Thresh's `GrainRuntime`, mirroring
 * `SchemaSourceGrainFactory`) whose grains record the ambient dispatch context they observe and
 * then answer with a scripted reply - or throw, to prove the dispatcher adds no try/catch.
 */
class RecordingGrainFactory {
  readonly calls: RecordedCall[] = [];
  respond: (call: number) => Promise<DispatchCheckReply> = async () => ({
    member: false,
    cycleCut: false,
  });

  getGrain<T>(definition: GrainInterface<T>, key: GrainKeyFor<T>): T {
    const grain: ICheckGrain = {
      dispatchCheck: async (signal?: AbortSignal | undefined) => {
        const index = this.calls.length;
        this.calls.push({
          definition: definition as GrainInterface<unknown>,
          key: key as string,
          // Read through the production accessors: they throw loudly if the dispatcher forgot to
          // set the ambient context before the call.
          depthRemaining: requireDepthRemaining(),
          visited: requireVisited(),
          signal,
        });
        return await this.respond(index);
      },
    };
    return grain as unknown as T;
  }
}

function metaOf(overrides: Partial<ResolverMeta> = {}): ResolverMeta {
  return {
    revision: REVISION,
    depthRemaining: 42,
    visited: new Set<string>(),
    ...overrides,
  };
}

function requestOf(overrides: Partial<DispatchCheckRequest> = {}): DispatchCheckRequest {
  return { resource: DOCUMENT_VIEW, subject: ALICE, meta: metaOf(), ...overrides };
}

function newDispatcher(
  factory: RecordingGrainFactory,
  metrics?: DispatchMetrics,
  hash = AMBIENT_HASH,
): OrleansDispatcher {
  return new OrleansDispatcher(factory, createFixedSchemaHashSource(hash), metrics);
}

beforeEach(() => {
  RequestContext.clear();
});

describe("OrleansDispatcher construction", () => {
  it("rejects a missing grain factory - the C#'s ArgumentNullException.ThrowIfNull(grains)", () => {
    expect(
      () =>
        new OrleansDispatcher(
          undefined as unknown as RecordingGrainFactory,
          createFixedSchemaHashSource(AMBIENT_HASH),
        ),
    ).toThrow(InvalidArgumentError);
  });

  it("rejects a missing schema-hash source", () => {
    expect(
      () =>
        new OrleansDispatcher(
          new RecordingGrainFactory(),
          undefined as unknown as ReturnType<typeof createFixedSchemaHashSource>,
        ),
    ).toThrow(InvalidArgumentError);
  });

  it("accepts an absent metrics sink - it is an OPTIONAL dependency in the C#", async () => {
    const factory = new RecordingGrainFactory();

    await newDispatcher(factory).dispatchCheck(requestOf(), undefined);

    expect(factory.calls).toHaveLength(1);
  });
});

describe("OrleansDispatcher.keyFor", () => {
  it("uses the AMBIENT schema hash unconditionally - a different rule from dispatchCheck's", () => {
    // C# `KeyFor` takes no meta and so has no pinned hash to prefer: it always reads
    // `_schemaHash.CurrentSchemaHash`. The two rules must NOT be unified.
    const dispatcher = newDispatcher(new RecordingGrainFactory());

    expect(dispatcher.keyFor(DOCUMENT_VIEW, ALICE, "rev-9")).toBe(
      grainKeyBuild(DOCUMENT_VIEW, ALICE, "rev-9", AMBIENT_HASH),
    );
  });
});

describe("OrleansDispatcher grain key derivation", () => {
  it("prefers the schema hash PINNED in the request meta over this silo's ambient hash", async () => {
    // The schema is a pure function of the pinned revision, so every silo must derive the SAME
    // key; reading the ambient hash first would split one sub-problem across silos.
    const factory = new RecordingGrainFactory();
    const request = requestOf({ meta: metaOf({ schemaHash: "pinned-hash" }) });

    await newDispatcher(factory).dispatchCheck(request, undefined);

    expect(factory.calls[0]?.key).toBe(
      grainKeyBuild(DOCUMENT_VIEW, ALICE, REVISION.toString(), "pinned-hash"),
    );
  });

  it("falls back to the ambient hash only when the root pinned none (the seed-only window)", async () => {
    const factory = new RecordingGrainFactory();

    await newDispatcher(factory).dispatchCheck(requestOf(), undefined);

    expect(factory.calls[0]?.key).toBe(
      grainKeyBuild(DOCUMENT_VIEW, ALICE, REVISION.toString(), AMBIENT_HASH),
    );
  });

  it("treats an EMPTY pinned hash as a real value - C# `??`, never `||`", async () => {
    // `meta.SchemaHash ?? ambient` keeps the empty string; a JavaScript `||` would silently
    // substitute the ambient hash and re-key the sub-problem.
    const factory = new RecordingGrainFactory();
    const request = requestOf({ meta: metaOf({ schemaHash: "" }) });

    await newDispatcher(factory).dispatchCheck(request, undefined);

    expect(factory.calls[0]?.key).toBe(
      grainKeyBuild(DOCUMENT_VIEW, ALICE, REVISION.toString(), ""),
    );
  });

  it("carries the revision through IRevision.toString(), never a reformatted value", async () => {
    const factory = new RecordingGrainFactory();
    const request = requestOf({ meta: metaOf({ revision: stubRevision("007") }) });

    await newDispatcher(factory).dispatchCheck(request, undefined);

    expect(factory.calls[0]?.key).toBe(grainKeyBuild(DOCUMENT_VIEW, ALICE, "007", AMBIENT_HASH));
  });

  it("addresses the ICheckGrain interface", async () => {
    const factory = new RecordingGrainFactory();

    await newDispatcher(factory).dispatchCheck(requestOf(), undefined);

    expect(factory.calls[0]?.definition).toBe(ICheckGrain);
  });
});

describe("OrleansDispatcher ambient dispatch context", () => {
  it("sets the depth budget the request carries, immediately before the grain call", async () => {
    const factory = new RecordingGrainFactory();
    const request = requestOf({ meta: metaOf({ depthRemaining: 17 }) });

    await newDispatcher(factory).dispatchCheck(request, undefined);

    expect(factory.calls[0]?.depthRemaining).toBe(17);
  });

  it("carries an EMPTY visited set as an empty array, not as an absent context", async () => {
    // The encode/decode round-trip is string-only in Thresh (Orleans stored the array directly),
    // which is exactly where the cycle guard could silently vanish.
    const factory = new RecordingGrainFactory();

    await newDispatcher(factory).dispatchCheck(requestOf(), undefined);

    expect(factory.calls[0]?.visited).toEqual([]);
  });

  it("round-trips visit keys containing a quote and a backslash through the JSON encoding", async () => {
    const awkward = visitKeyToCanonicalString(
      visitKeyOf(
        { objectType: "document", objectId: 'he said "hi"', relation: "view" },
        { objectType: "user", objectId: "back\\slash", relation: ELLIPSIS },
      ),
    );
    const factory = new RecordingGrainFactory();
    const request = requestOf({ meta: metaOf({ visited: new Set([awkward]) }) });

    await newDispatcher(factory).dispatchCheck(request, undefined);

    expect(factory.calls[0]?.visited).toEqual([awkward]);
  });

  it("passes the caller's signal straight across the grain boundary", async () => {
    const factory = new RecordingGrainFactory();
    const controller = new AbortController();

    await newDispatcher(factory).dispatchCheck(requestOf(), controller.signal);

    expect(factory.calls[0]?.signal).toBe(controller.signal);
  });

  it("throws on an already-aborted signal before making any grain call", async () => {
    // C# `ct.ThrowIfCancellationRequested()` at the top of DispatchCheck.
    const factory = new RecordingGrainFactory();
    const controller = new AbortController();
    controller.abort();

    await expect(
      newDispatcher(factory).dispatchCheck(requestOf(), controller.signal),
    ).rejects.toThrow();
    expect(factory.calls).toHaveLength(0);
  });

  it("rejects a missing request", async () => {
    await expect(
      newDispatcher(new RecordingGrainFactory()).dispatchCheck(
        undefined as unknown as DispatchCheckRequest,
        undefined,
      ),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it("overwrites a previous sibling's context, so no hop inherits a stale budget", async () => {
    // Thresh's RequestContext.set MUTATES the ambient store where Orleans' was copy-on-write, so
    // sibling isolation holds ONLY because the dispatcher sets both values immediately before each
    // of its own calls.
    const factory = new RecordingGrainFactory();
    const dispatcher = newDispatcher(factory);

    await dispatcher.dispatchCheck(requestOf({ meta: metaOf({ depthRemaining: 9 }) }), undefined);
    await dispatcher.dispatchCheck(requestOf({ meta: metaOf({ depthRemaining: 4 }) }), undefined);

    expect(factory.calls.map((call) => call.depthRemaining)).toEqual([9, 4]);
  });
});

describe("OrleansDispatcher loop bypass", () => {
  const visitedKey = visitKeyToCanonicalString(visitKeyOf(DOCUMENT_VIEW, ALICE));

  it("still makes the grain call when the visited set already holds this sub-problem", async () => {
    // The grain is reentrant: the C# comment is explicit that the call happens NORMALLY and only
    // the RETURNED result is force-tagged.
    const factory = new RecordingGrainFactory();
    const request = requestOf({ meta: metaOf({ visited: new Set([visitedKey]) }) });

    await newDispatcher(factory).dispatchCheck(request, undefined);

    expect(factory.calls).toHaveLength(1);
  });

  it("records exactly one loop-bypass hit", async () => {
    const metrics = new DispatchMetrics();
    const request = requestOf({ meta: metaOf({ visited: new Set([visitedKey]) }) });

    await newDispatcher(new RecordingGrainFactory(), metrics).dispatchCheck(request, undefined);

    expect(metrics.snapshot().loopBypass).toBe(1);
  });

  it("records the loop bypass BEFORE the grain call, so a faulted call is still counted", async () => {
    // Step 3 precedes steps 4-6 in the C#. Recording after the call would lose the hit whenever
    // the hop fails - and the mesh metrics tests assert these counts.
    const metrics = new DispatchMetrics();
    const factory = new RecordingGrainFactory();
    factory.respond = async () => {
      throw new Error("hop failed");
    };
    const request = requestOf({ meta: metaOf({ visited: new Set([visitedKey]) }) });

    await expect(newDispatcher(factory, metrics).dispatchCheck(request, undefined)).rejects.toThrow(
      "hop failed",
    );
    expect(metrics.snapshot().loopBypass).toBe(1);
  });

  it("forces CycleCut on the returned result even when the callee said otherwise", async () => {
    const factory = new RecordingGrainFactory();
    factory.respond = async () => ({ member: true, cycleCut: false, depthRequired: 3 });
    const request = requestOf({ meta: metaOf({ visited: new Set([visitedKey]) }) });

    const result = await newDispatcher(factory).dispatchCheck(request, undefined);

    expect(result.cycleCut).toBe(true);
    // Only CycleCut is overridden; the rest of the callee's answer survives (`with { CycleCut = true }`).
    expect(result.member).toBe(true);
    expect(result.depthRequired).toBe(3);
  });

  it("records nothing and forces nothing when the sub-problem is not in the visited set", async () => {
    const metrics = new DispatchMetrics();
    const factory = new RecordingGrainFactory();
    factory.respond = async () => ({ member: true, cycleCut: false });

    const result = await newDispatcher(factory, metrics).dispatchCheck(requestOf(), undefined);

    expect(metrics.snapshot().loopBypass).toBe(0);
    expect(result.cycleCut).toBe(false);
  });

  it("keeps a callee-reported CycleCut when there was no loop bypass", async () => {
    const factory = new RecordingGrainFactory();
    factory.respond = async () => ({ member: false, cycleCut: true });

    const result = await newDispatcher(factory).dispatchCheck(requestOf(), undefined);

    expect(result.cycleCut).toBe(true);
  });

  it("matches the visited set on the LENGTH-PREFIXED canonical key, not a separator join", async () => {
    // VisitKey identity IS visitKeyToCanonicalString: a naive join collides whenever an object id
    // contains the separator, and a false hit prunes a live sibling branch by force-cutting it.
    const separator = String.fromCharCode(0x1f);
    const naiveJoin = [
      DOCUMENT_VIEW.objectType,
      DOCUMENT_VIEW.objectId,
      DOCUMENT_VIEW.relation,
      ALICE.objectType,
      ALICE.objectId,
      ALICE.relation,
    ].join(separator);
    const metrics = new DispatchMetrics();
    const request = requestOf({ meta: metaOf({ visited: new Set([naiveJoin]) }) });

    const result = await newDispatcher(new RecordingGrainFactory(), metrics).dispatchCheck(
      request,
      undefined,
    );

    expect(metrics.snapshot().loopBypass).toBe(0);
    expect(result.cycleCut).toBe(false);
  });

  it("does not bypass on a DIFFERENT sub-problem's visit key", async () => {
    const other = visitKeyToCanonicalString(
      visitKeyOf({ objectType: "document", objectId: "other", relation: "view" }, ALICE),
    );
    const metrics = new DispatchMetrics();
    const request = requestOf({ meta: metaOf({ visited: new Set([other]) }) });

    await newDispatcher(new RecordingGrainFactory(), metrics).dispatchCheck(request, undefined);

    expect(metrics.snapshot().loopBypass).toBe(0);
  });
});

describe("OrleansDispatcher result mapping", () => {
  it("maps member, cycleCut and depthRequired straight off the reply", async () => {
    const factory = new RecordingGrainFactory();
    factory.respond = async () => ({ member: true, cycleCut: true, depthRequired: 5 });

    const result = await newDispatcher(factory).dispatchCheck(requestOf(), undefined);

    expect(result).toEqual({ member: true, caveat: undefined, cycleCut: true, depthRequired: 5 });
  });

  it("defaults an ABSENT depthRequired to 1 - the C# default parameter", async () => {
    const factory = new RecordingGrainFactory();
    factory.respond = async () => ({ member: false, cycleCut: false });

    const result = await newDispatcher(factory).dispatchCheck(requestOf(), undefined);

    expect(result.depthRequired).toBe(1);
  });

  it("keeps an EXPLICIT zero depthRequired - `??`, never `||`", async () => {
    const factory = new RecordingGrainFactory();
    factory.respond = async () => ({ member: false, cycleCut: false, depthRequired: 0 });

    const result = await newDispatcher(factory).dispatchCheck(requestOf(), undefined);

    expect(result.depthRequired).toBe(0);
  });

  it("converts the wire caveat back into the engine expression tree", async () => {
    const factory = new RecordingGrainFactory();
    factory.respond = async () => ({
      member: true,
      caveat: {
        kind: "and",
        children: [
          { kind: "leaf", caveatName: "over_limit", context: new Map([["v", 3]]) },
          { kind: "not", child: { kind: "leaf", caveatName: "banned", context: undefined } },
        ],
      },
      cycleCut: false,
    });

    const result = await newDispatcher(factory).dispatchCheck(requestOf(), undefined);

    expect(result.caveat).toEqual({
      kind: "and",
      children: [
        { kind: "leaf", caveat: { caveatName: "over_limit", context: new Map([["v", 3]]) } },
        {
          kind: "not",
          child: { kind: "leaf", caveat: { caveatName: "banned", context: undefined } },
        },
      ],
    });
  });

  it("maps an absent wire caveat to an absent expression", async () => {
    const factory = new RecordingGrainFactory();
    factory.respond = async () => ({ member: true, cycleCut: false });

    const result = await newDispatcher(factory).dispatchCheck(requestOf(), undefined);

    expect(result.caveat).toBeUndefined();
  });
});

describe("OrleansDispatcher error handling", () => {
  it("lets a grain-call failure propagate UNCHANGED - classification lives in the outgoing filter", async () => {
    // The try/catch that used to sit here was moved to CheckDispatchOutgoingCallFilter; putting it
    // back would double-wrap every failure.
    const factory = new RecordingGrainFactory();
    const failure = new Error("silo unavailable");
    factory.respond = async () => {
      throw failure;
    };

    await expect(newDispatcher(factory).dispatchCheck(requestOf(), undefined)).rejects.toBe(
      failure,
    );
  });
});

describe("OrleansDispatcher has no in-process shortcut", () => {
  it("makes a grain call for every sub-problem, including a repeat of one just dispatched", async () => {
    // The C# remark: "There is no in-process local-recurse shortcut - every sub-problem, local or
    // remote, is a grain call." Memoizing here would silently change the mesh's grain-call counts.
    const factory = new RecordingGrainFactory();
    const dispatcher = newDispatcher(factory);

    await dispatcher.dispatchCheck(requestOf(), undefined);
    await dispatcher.dispatchCheck(requestOf(), undefined);

    expect(factory.calls).toHaveLength(2);
    expect(factory.calls[0]?.key).toBe(factory.calls[1]?.key);
  });
});
