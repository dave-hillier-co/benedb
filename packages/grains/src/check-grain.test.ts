import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import type { IGraphReader } from "@spacedb/datastore/i-graph-reader";
import type { Relationship } from "@spacedb/core/relationship";
import type { CaveatExpression } from "@spacedb/engine/caveat-expression";
import type {
  DispatchCheckRequest,
  DispatchCheckResult,
  IDispatcher,
} from "@spacedb/engine/i-dispatcher";
import {
  DISPATCH_CHECK_DEFINITE_MEMBER,
  visitKeyOf,
  visitKeyToCanonicalString,
} from "@spacedb/engine/i-dispatcher";
import { computeSchemaHash } from "@spacedb/engine/schema-hash";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import { TestCluster } from "@thresh/testing/test-cluster";
import { RequestContext } from "@thresh/core/request-context";
import { afterEach, describe, expect, it } from "vitest";

import { CheckGrain } from "./check-grain";
import { setTestDispatchContext } from "./dispatch-context-test-helper";
import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import { GraphLocalityPlacementDirector } from "./graph-locality-placement-director";
import { grainKeyBuild } from "./grain-key";
import { DispatchMetrics } from "./i-dispatch-metrics";
import type { IGraphReaderSource } from "./i-graph-reader-source";
import { ICheckGrain, dispatchCheckReplyDepthRequired } from "./i-check-grain";
import type { ISchemaProvider } from "./i-schema-provider";
import { SchemaSnapshot } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import { SchemaResolver } from "./schema-resolver";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/CheckGrain.cs`.
 *
 * NO COVERING C# TEST: `CheckGrain` is graded in Spiceport by `ConformanceMeshTests`,
 * `FullCorpusMeshVisitedSetTests`, `SameKeyCycleMeshTests` and `CancellationAndImmutabilityTests`,
 * all of which need a `MeshTestCluster` from a later batch. This is a CHARACTERIZATION of the
 * grain's own contract - the memo rules, the ambient-context contract, the one-expansion-step
 * dispatch shape - pinned directly so that when those suites land they are grading a grain that is
 * already known to behave as the C# does, rather than discovering it there.
 *
 * The grain runs REAL - a Thresh {@link TestCluster}, the real `LocalDispatcher` inside it, the
 * real `SchemaResolver` - against a RECORDING onward dispatcher. Faking the onward dispatcher is
 * not a shortcut: it is the seam under test. The C#'s whole claim is that the local dispatcher
 * performs exactly ONE expansion step and every child becomes a further grain call, so what the
 * onward seam is asked, and how often, IS the behaviour.
 *
 * The five rules that are easy to get subtly wrong, and what pins each:
 *
 *  1. THE MEMO IS SERVED ONLY WHEN `enabled && memo && depthRemaining >= cached.depthRequired`.
 *     The depth guard is not an optimisation: a tighter budget must fall through and RECOMPUTE,
 *     because a reply computed under a generous budget may be complete in a way a tight one is not.
 *  2. A FRESH REPLY IS STORED ONLY WHEN `enabled && !cycleCut && (no memo ||
 *     reply.depthRequired < existing.depthRequired)` - STRICT less-than, so the activation keeps
 *     its most-servable entry EVER computed rather than its most recent one.
 *  3. A CYCLE-CUT RESULT IS NEVER MEMOIZED. It is path-dependent on the in-flight visited set,
 *     which is deliberately NOT part of the grain identity, so memoizing it is unsound on another
 *     path.
 *  4. THE MEMO HOLDS THE PRE-CONTEXT BRANCH (membership + caveat wire), never the collapsed
 *     verdict. Collapsing in the grain passes every memo test here and silently breaks every
 *     caveat corpus file, because caveat context is a per-request, caller-side concern.
 *  5. DEPTH AND VISITED SET ARRIVE AMBIENTLY and their absence THROWS. A caller that reached
 *     `dispatchCheck` without going through the dispatcher (or the test seam) is a bug and must
 *     fail loudly; defaulting a lost call-chain context to zero would turn a routing bug into a
 *     wrong answer.
 *
 * REENTRANCY. The C# marks the CLASS `[Reentrant]`, and it is load-bearing: a genuine relation
 * cycle re-addresses the SAME grain key on the way back round (the key excludes the visited set
 * and the depth), so a non-reentrant grain deadlocks against itself until a timeout. Thresh spells
 * a class-level `[Reentrant]` as the `@reentrant()` class decorator rather than a per-method entry
 * in the interface options map (`markReentrant`, `@thresh/core/decorators`) - see the deviation
 * note. The gate here is behavioural and does not care which: a same-key re-entry must COMPLETE.
 */

const SCHEMA_TEXT = `
definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}
`;

const RESOURCE: ObjectAndRelation = { objectType: "document", objectId: "doc1", relation: "view" };
const SUBJECT: ObjectAndRelation = { objectType: "user", objectId: "alice", relation: ELLIPSIS };
const REVISION = 4_200_000_000n;

// --- collaborators ----------------------------------------------------------------------------

/** An empty graph: the sub-problem under test expands through a rewrite, never through a row. */
const EMPTY_READER: IGraphReader = {
  async *queryRelationships(): AsyncIterable<Relationship> {},
  async *reverseQueryRelationships(): AsyncIterable<Relationship> {},
};

class RecordingReaderSource implements IGraphReaderSource {
  readonly revisions: IRevision[] = [];

  graphReaderAt(revision: IRevision): IGraphReader {
    this.revisions.push(revision);
    return EMPTY_READER;
  }
}

/** The onward seam. Every child sub-problem the local expansion produces arrives here. */
class RecordingDispatcher implements IDispatcher {
  readonly requests: DispatchCheckRequest[] = [];
  respond: (request: DispatchCheckRequest) => Promise<DispatchCheckResult> = async () =>
    DISPATCH_CHECK_DEFINITE_MEMBER;

  async dispatchCheck(
    request: DispatchCheckRequest,
    _signal: AbortSignal | undefined,
  ): Promise<DispatchCheckResult> {
    this.requests.push(request);
    return await this.respond(request);
  }
}

class FixedSchemaProvider implements ISchemaProvider {
  constructor(readonly current: SchemaSnapshot) {}

  update(): SchemaSnapshot {
    throw new Error("not used");
  }
}

/** Records every hash-miss hop onto the sequencer's schema-at-revision read. */
class RecordingSchemaSource implements ISchemaSource {
  readonly calls: IRevision[] = [];
  bytes: Uint8Array | undefined = undefined;

  async readSchemaAt(revision: IRevision): Promise<Uint8Array | undefined> {
    this.calls.push(revision);
    return this.bytes;
  }
}

function snapshotOf(text: string): SchemaSnapshot {
  const compiled = compileSchema(text);
  return new SchemaSnapshot(
    compiled,
    computeSchemaHash(compiled.namespaces, compiled.caveats),
    text,
    0,
  );
}

// --- fixture ----------------------------------------------------------------------------------

interface Fixture {
  readonly cluster: TestCluster;
  readonly onward: RecordingDispatcher;
  readonly readerSource: RecordingReaderSource;
  readonly schemaSource: RecordingSchemaSource;
  readonly metrics: DispatchMetrics;
  readonly snapshot: SchemaSnapshot;
  /** The grain key for the sub-problem under test, pinned at `REVISION` and the seeded hash. */
  readonly key: string;
}

let fixture: Fixture | undefined;

interface StartOptions {
  readonly memoEnabled?: boolean;
  readonly snapshot?: SchemaSnapshot;
  /** Set to leave the resolver cold, so the ISchemaSource seam is exercised. */
  readonly seedResolver?: boolean;
}

async function start(options: StartOptions = {}): Promise<Fixture> {
  const snapshot = options.snapshot ?? snapshotOf(SCHEMA_TEXT);
  const onward = new RecordingDispatcher();
  const readerSource = new RecordingReaderSource();
  const schemaSource = new RecordingSchemaSource();
  const metrics = new DispatchMetrics();
  const schemaResolver = new SchemaResolver();
  if (options.seedResolver !== false) schemaResolver.seed(snapshot);

  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: [{ ctor: CheckGrain, interfaces: [ICheckGrain] }],
    configureSilo: (builder) => {
      builder.addPlacementStrategy(
        GRAPH_LOCALITY_PLACEMENT_STRATEGY,
        new GraphLocalityPlacementDirector(),
      );
      builder.useGrainActivator({
        createInstance: (ctor) =>
          ctor === (CheckGrain as unknown as new () => CheckGrain)
            ? new CheckGrain({
                schemaSource,
                schemaProvider: new FixedSchemaProvider(snapshot),
                schemaResolver,
                onward,
                readerSource,
                memoOptions: { enabled: options.memoEnabled ?? true },
                metrics,
              })
            : new ctor(),
      });
    },
  });

  fixture = {
    cluster,
    onward,
    readerSource,
    schemaSource,
    metrics,
    snapshot,
    key: grainKeyBuild(RESOURCE, SUBJECT, REVISION.toString(), snapshot.schemaHash),
  };
  return fixture;
}

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  RequestContext.clear();
  if (current !== undefined) await current.cluster.dispose();
});

/**
 * One direct grain call at the given budget. The dispatch context is set IMMEDIATELY before each
 * call, never once up front: Thresh's `RequestContext.set` mutates the ambient store in place, so
 * a value set for one call is still there for the next unless it is overwritten.
 */
function check(f: Fixture, depthRemaining: number, visited: Iterable<string> = []) {
  setTestDispatchContext(depthRemaining, visited);
  return f.cluster.primary.host.getGrain(ICheckGrain, f.key).dispatchCheck();
}

const caveatLeaf = (name: string): CaveatExpression => ({
  kind: "leaf",
  caveat: { caveatName: name, context: undefined },
});

describe("CheckGrain", () => {
  describe("the ambient dispatch context", () => {
    /**
     * `RequireDepthRemaining()` / `RequireVisited()` THROW when the ambient context is missing. A
     * caller that reached `dispatchCheck` without going through the dispatcher (or this test seam)
     * is a bug; silently defaulting to a budget would turn a routing bug into a wrong verdict that
     * no assertion above this layer could attribute.
     */
    it("throws rather than defaulting when the ambient context is absent", async () => {
      const f = await start();
      RequestContext.clear();

      await expect(
        f.cluster.primary.host.getGrain(ICheckGrain, f.key).dispatchCheck(),
      ).rejects.toThrow(/DispatchContext key/);
    });

    /**
     * The visited set travels the wire as canonical STRINGS and is rehydrated into a value-equality
     * set. A `Set` of `VisitKey` OBJECTS is reference-keyed and would never match, so the
     * `ResolverMeta` the grain hands the engine must carry the canonical strings verbatim - which
     * is observable here on the child request's own meta.
     */
    it("rehydrates the visited set as canonical strings into the resolver meta", async () => {
      const f = await start();
      const inflight = visitKeyToCanonicalString(
        visitKeyOf({ objectType: "document", objectId: "other", relation: "view" }, SUBJECT),
      );

      await check(f, 10, [inflight]);

      const child = f.onward.requests[0]!;
      expect([...child.meta.visited]).toContain(inflight);
      // The local step records its OWN (resource, subject) pair before dispatching the child.
      expect([...child.meta.visited]).toContain(
        visitKeyToCanonicalString(visitKeyOf(RESOURCE, SUBJECT)),
      );
    });

    /** The budget arrives ambiently and is decremented by the ONE local expansion step. */
    it("passes the ambient depth budget into the expansion, decremented once", async () => {
      const f = await start();

      await check(f, 7);

      expect(f.onward.requests[0]!.meta.depthRemaining).toBe(6);
    });
  });

  describe("the expansion step", () => {
    /**
     * The grain decodes its identity from its own string key and evaluates exactly that
     * sub-problem: the resource and subject reach the local dispatcher unchanged, and the pinned
     * revision reaches the reader source.
     */
    it("evaluates the sub-problem its key names, at the key's pinned revision", async () => {
      const f = await start();

      await check(f, 10);

      const child = f.onward.requests[0]!;
      // ONE expansion step: `permission view = viewer` resolves to the viewer relation on the SAME
      // resource, dispatched onward as a child grain call rather than recursed in-process.
      expect(child.resource).toEqual({ ...RESOURCE, relation: "viewer" });
      expect(child.subject).toEqual(SUBJECT);
      expect(child.meta.revision).toBeInstanceOf(TimestampRevision);
      expect(child.meta.revision.toString()).toBe(REVISION.toString());
      expect(f.readerSource.revisions.map((r) => r.toString())).toContain(REVISION.toString());
    });

    /**
     * The dispatch hop consumes one level of depth, so the reply's `depthRequired` is the child's
     * plus one. This number is what the memo's depth guard gates on, so it is pinned explicitly
     * rather than inferred from the memo cases below.
     */
    it("reports one more depth than its child required", async () => {
      const f = await start();
      f.onward.respond = async () => ({ ...DISPATCH_CHECK_DEFINITE_MEMBER, depthRequired: 3 });

      const reply = await check(f, 10);

      expect(dispatchCheckReplyDepthRequired(reply)).toBe(4);
    });

    /**
     * There is NO in-process local-recurse shortcut: every child is a further dispatch through the
     * injected onward seam. An optimisation that recursed locally would hollow out every mesh
     * suite - they would still pass, while measuring nothing.
     */
    it("sends every child through the onward dispatcher", async () => {
      const f = await start();

      await check(f, 10);

      expect(f.onward.requests).toHaveLength(1);
    });
  });

  describe("the activation memo", () => {
    /** A hit serves the cached reply with no re-expansion at all. */
    it("serves a memo hit without re-expanding", async () => {
      const f = await start();

      const first = await check(f, 10);
      const second = await check(f, 10);

      expect(second).toEqual(first);
      expect(f.onward.requests).toHaveLength(1);
      expect(f.metrics.snapshot().memoHit).toBe(1);
      expect(f.metrics.snapshot().memoMiss).toBe(1);
    });

    /**
     * THE DEPTH GUARD. A budget TIGHTER than the memo's `depthRequired` falls through and
     * recomputes; a budget equal to it is servable. Both halves are asserted, because a port that
     * dropped the guard passes the first half and a port that used `>` instead of `>=` passes the
     * second.
     */
    it("falls through and recomputes under a budget tighter than the memo requires", async () => {
      const f = await start();
      f.onward.respond = async () => ({ ...DISPATCH_CHECK_DEFINITE_MEMBER, depthRequired: 1 });

      await check(f, 10); // memo now holds depthRequired 2
      await check(f, 2); // 2 >= 2: served from the memo
      expect(f.onward.requests).toHaveLength(1);

      await check(f, 1); // 1 >= 2 is false: recompute
      expect(f.onward.requests).toHaveLength(2);
      expect(f.metrics.snapshot()).toMatchObject({ memoHit: 1, memoMiss: 2 });
    });

    /**
     * STRICT less-than replacement: the activation keeps the most-servable entry it has EVER
     * computed, not the most recent one. Both directions are pinned, because "always replace" and
     * "never replace" each pass one of them.
     */
    it("replaces the memo only with a strictly lower depth requirement", async () => {
      const f = await start();
      f.onward.respond = async () => ({ ...DISPATCH_CHECK_DEFINITE_MEMBER, depthRequired: 3 });

      await check(f, 10); // memo: depthRequired 4
      f.onward.respond = async () => ({ ...DISPATCH_CHECK_DEFINITE_MEMBER, depthRequired: 1 });
      await check(f, 3); // 3 >= 4 false -> recompute; 2 < 4 -> memo replaced with depthRequired 2
      expect(f.onward.requests).toHaveLength(2);

      await check(f, 3); // 3 >= 2 -> hit, proving the replacement happened
      expect(f.onward.requests).toHaveLength(2);

      // Now force a recompute that yields a WORSE (higher) requirement: it must NOT replace.
      f.onward.respond = async () => ({ ...DISPATCH_CHECK_DEFINITE_MEMBER, depthRequired: 3 });
      await check(f, 1); // 1 >= 2 false -> recompute, reply depthRequired 4, memo untouched
      expect(f.onward.requests).toHaveLength(3);

      await check(f, 2); // still hits the retained depthRequired-2 entry
      expect(f.onward.requests).toHaveLength(3);
    });

    /**
     * A cycle-cut reply is path-dependent on the in-flight visited set, which is NOT part of this
     * grain's identity, so it must never be retained - another caller arriving on a different path
     * would be served a verdict that was only ever valid on the first caller's path.
     */
    it("never memoizes a cycle-cut result", async () => {
      const f = await start();
      f.onward.respond = async () => ({
        ...DISPATCH_CHECK_DEFINITE_MEMBER,
        cycleCut: true,
      });

      const first = await check(f, 10);
      await check(f, 10);

      expect(first.cycleCut).toBe(true);
      expect(f.onward.requests).toHaveLength(2);
      expect(f.metrics.snapshot()).toMatchObject({ memoHit: 0, memoMiss: 2 });
    });

    /**
     * THE MEMO HOLDS THE PRE-CONTEXT BRANCH. The caveat comes back as its serialized wire form on
     * both the computed reply and the memo hit - never collapsed into a boolean verdict here,
     * because the request context that would collapse it is a per-request, caller-side concern.
     */
    it("memoizes the pre-context branch, caveat and all", async () => {
      const f = await start();
      f.onward.respond = async () => ({
        member: true,
        caveat: caveatLeaf("only_on_tuesday"),
        cycleCut: false,
        depthRequired: 1,
      });

      const computed = await check(f, 10);
      const hit = await check(f, 10);

      expect(computed.member).toBe(true);
      expect(computed.caveat).toEqual({
        kind: "leaf",
        caveatName: "only_on_tuesday",
        context: undefined,
      });
      expect(hit).toEqual(computed);
      expect(f.onward.requests).toHaveLength(1);
    });

    /**
     * Disabling the memo reverts the grain to a stateless expansion step: it never consults or
     * populates the memo, AND it records neither counter. `SubjectFrontierMemoMeshTests`' disabled
     * case asserts the same shape for the frontier counters, so a port that recorded a miss
     * unconditionally would fail there instead of here.
     */
    it("neither consults nor counts the memo when it is disabled", async () => {
      const f = await start({ memoEnabled: false });

      await check(f, 10);
      await check(f, 10);

      expect(f.onward.requests).toHaveLength(2);
      expect(f.metrics.snapshot()).toMatchObject({ memoHit: 0, memoMiss: 0 });
    });

    /**
     * NOT a singleflight cache: two concurrent calls must never await one another's in-flight
     * promise. Sharing one is the obvious "optimisation" and it reintroduces exactly the same-key
     * deadlock reentrancy exists to avoid; letting duplicates recompute independently is benign,
     * since both read the same pinned snapshot and schema.
     */
    it("lets concurrent duplicate calls recompute independently", async () => {
      const f = await start();
      let release: (() => void) | undefined;
      const parked = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.onward.respond = async () => {
        await parked;
        return DISPATCH_CHECK_DEFINITE_MEMBER;
      };

      setTestDispatchContext(10, []);
      const grain = f.cluster.primary.host.getGrain(ICheckGrain, f.key);
      const a = grain.dispatchCheck();
      setTestDispatchContext(10, []);
      const b = grain.dispatchCheck();
      release!();
      await Promise.all([a, b]);

      expect(f.onward.requests).toHaveLength(2);
    });
  });

  describe("schema resolution", () => {
    /**
     * The key's schema hash names the schema to evaluate under, resolved through the
     * `ISchemaSource` seam at the key's revision on a per-silo cache miss - never trusted from the
     * local `ISchemaProvider.current`, which may be stale on a silo that never handled the write.
     */
    it("resolves the key's schema hash through the schema source on a cache miss", async () => {
      const f = await start({ seedResolver: false });
      f.schemaSource.bytes = new TextEncoder().encode(SCHEMA_TEXT);

      await check(f, 10);

      expect(f.schemaSource.calls.map((r) => r.toString())).toEqual([REVISION.toString()]);
    });

    /**
     * `schema.Namespaces.ToImmutableDictionary(ns => ns.Name)` THROWS on a duplicate name where a
     * JS `Map` silently last-wins. A duplicate reaching the dispatcher unnoticed would evaluate
     * half a schema and answer confidently; the throw is the behaviour, so it is pinned.
     */
    it("throws on a duplicate namespace name rather than letting the last one win", async () => {
      const compiled = compileSchema(SCHEMA_TEXT);
      const duplicated = {
        ...compiled,
        namespaces: [...compiled.namespaces, compiled.namespaces[1]!],
      };
      const snapshot = new SchemaSnapshot(
        duplicated,
        computeSchemaHash(compiled.namespaces, compiled.caveats),
        SCHEMA_TEXT,
        0,
      );
      const f = await start({ snapshot });

      setTestDispatchContext(10, []);
      await expect(
        f.cluster.primary.host.getGrain(ICheckGrain, f.key).dispatchCheck(),
      ).rejects.toThrow(/same key/i);
    });
  });

  describe("reentrancy", () => {
    /**
     * A genuine relation cycle re-addresses the SAME grain key on the way back round, because the
     * key deliberately excludes the visited set and the depth. The grain must ACCEPT that re-entry:
     * a non-reentrant activation would block on itself until a timeout, and the mesh's own
     * `SameKeyCycleMeshTests` bounds exactly this at 20s. The bound here is deliberately tight for
     * the same reason - a deadlocked grain does not fail this assertion, it hangs, so the timeout
     * IS the assertion.
     */
    it(
      "accepts a same-key re-entry rather than deadlocking against itself",
      { timeout: 20_000 },
      async () => {
        const f = await start();
        let reentered = false;
        f.onward.respond = async () => {
          if (reentered) return DISPATCH_CHECK_DEFINITE_MEMBER;
          reentered = true;
          // Re-address the SAME grain key from inside its own in-flight call - the cycle.
          setTestDispatchContext(5, []);
          await f.cluster.primary.host.getGrain(ICheckGrain, f.key).dispatchCheck();
          return DISPATCH_CHECK_DEFINITE_MEMBER;
        };

        const reply = await check(f, 10);

        expect(reentered).toBe(true);
        expect(reply.member).toBe(true);
      },
    );
  });
});
