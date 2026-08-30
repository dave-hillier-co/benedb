import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import type { Relationship } from "@spacedb/core/relationship";
import { createRelationship } from "@spacedb/core/relationship";
import type { IGraphReader } from "@spacedb/datastore/i-graph-reader";
import type { RelationshipsFilter, SubjectsFilter } from "@spacedb/datastore/relationships-filter";
import {
  relationshipsFilterMatches,
  subjectsFilterMatches,
} from "@spacedb/datastore/relationships-filter";
import { subjectKeyToString } from "@spacedb/engine/membership-walk";
import { computeSchemaHash } from "@spacedb/engine/schema-hash";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import { TestCluster } from "@thresh/testing/test-cluster";
import { constructGrain } from "@thresh/runtime/construct-grain";
import { afterEach, describe, expect, it } from "vitest";

import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import { GraphLocalityPlacementDirector } from "./graph-locality-placement-director";
import type { IGraphReaderSource } from "./i-graph-reader-source";
import type {
  MembershipClosureReply,
  MembershipWalkArgs,
  ResourceNodeWire,
} from "./i-membership-walk-grain";
import { IMembershipWalkGrain } from "./i-membership-walk-grain";
import type { ISchemaProvider } from "./i-schema-provider";
import { SchemaSnapshot } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import { MembershipWalkGrain } from "./membership-walk-grain";
import { membershipWalkKeyBuild } from "./membership-walk-key";
import { SchemaResolver } from "./schema-resolver";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/MembershipWalkGrain.cs`.
 *
 * ITS COVERING C# TEST (`tests/Spiceport.Grains.Tests/MembershipWalkGrainTests.cs`) LANDS IN A
 * LATER BATCH: every one of its cases drives the walk end to end through `MeshTestCluster` and
 * `ReverseOps.streamLookupResources`, neither of which exists yet. This file is therefore a
 * CHARACTERIZATION of the grain's own reply contract, pinned at the level the grain can be reached
 * at today - a real Thresh cluster where the SIBLING dispatch is a real grain call, over an
 * in-memory graph. It deliberately does NOT anticipate the C# suite's end-to-end cases; two of its
 * unit-level ones (`DepthExhaustion_UnitLevel_ReportsIncomplete`,
 * `CyclicMembershipData_CutsOnTheBackEdge_NotOnDepthExhaustion`) name the same behaviour, and when
 * the ported suite lands it is the one that grades this grain.
 *
 * The behaviours that are easy to lose, all of them consequences of ONE fact - this walk must
 * produce a COMPLETE candidate superset, not a cycle-tolerant verdict:
 *
 *  1. AN EXACT PATH LIST, not a bloom. A false-positive skip would silently drop a whole subtree of
 *     candidates, undetectably. `CheckGrain`'s bloom only ever risks a harmless re-expansion; here
 *     it would risk a wrong answer.
 *  2. SKIP-ON-PATH-HIT, not call-anyway. A true back-edge is unconditionally complete, so no
 *     reentrant call is made at all.
 *  3. THE PATH CARRIES CANONICAL SUBJECT KEYS (`type:id#relation`), not grain keys - the revision
 *     and schema hash are constant along one walk, so the subject key is the whole cycle identity.
 *     If that format drifts, the containment test silently never matches and the walk stops cutting
 *     cycles; the case below therefore hands the grain a path built with
 *     `subjectKeyToString` and asserts the cut, rather than building the path from the grain's own
 *     output.
 *  4. A BACK-EDGE PARENT IS STILL A NODE. It genuinely is a direct parent; only the RECURSION is
 *     skipped. Dropping it from `nodes` loses candidates.
 *  5. DUPLICATES ARE INTENTIONAL. There is no dedup anywhere in the accumulation - a mechanical
 *     port that reaches for a `Set` changes the reply shape, and the dedup that does exist lives
 *     one layer up in `toCoveredCandidates`.
 *  6. `incomplete` ON DEPTH EXHAUSTION IS CONDITIONAL on there being parents at all, not
 *     unconditionally true.
 *  7. MEMO ELIGIBILITY MIRRORS `CheckGrain`'s VERBATIM: store only when
 *     `enabled && !cycleCut && !incomplete`. The memo check happens FIRST, before the key is even
 *     parsed, and ignores `args` entirely - sound precisely because only path- and
 *     budget-INDEPENDENT replies are ever stored.
 */

const SCHEMA_TEXT = `
definition user {}

definition group {
    relation member: user | group#member
}

definition document {
    relation viewer: user | group#member
    relation editor: user
    permission view = viewer + editor
}
`;

const REVISION = 4_200_000_000n;

function onr(objectType: string, objectId: string, relation = ELLIPSIS): ObjectAndRelation {
  return { objectType, objectId, relation };
}

/** `group:{id}#member` names `subject` as a member. */
function member(id: string, subject: ObjectAndRelation): Relationship {
  return createRelationship(onr("group", id, "member"), subject);
}

const USER = (id: string): ObjectAndRelation => onr("user", id);
const GROUP = (id: string): ObjectAndRelation => onr("group", id, "member");

// --- collaborators ----------------------------------------------------------------------------

class FakeReaderSource implements IGraphReaderSource {
  /** One reader per hop, so this counts the reverse-adjacency hops actually performed. */
  hops = 0;

  constructor(private readonly rows: readonly Relationship[]) {}

  graphReaderAt(_revision: IRevision): IGraphReader {
    this.hops += 1;
    const rows = this.rows;
    return {
      async *queryRelationships(filter: RelationshipsFilter): AsyncIterable<Relationship> {
        for (const rel of rows) if (relationshipsFilterMatches(filter, rel)) yield rel;
      },
      async *reverseQueryRelationships(
        subjectsFilter: SubjectsFilter,
      ): AsyncIterable<Relationship> {
        for (const rel of rows) if (subjectsFilterMatches(subjectsFilter, rel)) yield rel;
      },
    };
  }
}

class FixedSchemaProvider implements ISchemaProvider {
  constructor(readonly current: SchemaSnapshot) {}

  update(): SchemaSnapshot {
    throw new Error("not used");
  }
}

const NEVER_READ_SCHEMA: ISchemaSource = {
  async readSchemaAt(): Promise<Uint8Array | undefined> {
    return undefined;
  },
};

// --- fixture ----------------------------------------------------------------------------------

interface Fixture {
  readonly cluster: TestCluster;
  readonly readerSource: FakeReaderSource;
  readonly schemaHash: string;
}

let fixture: Fixture | undefined;

async function start(
  rows: readonly Relationship[],
  options: { readonly memoEnabled?: boolean } = {},
): Promise<Fixture> {
  const compiled = compileSchema(SCHEMA_TEXT);
  const snapshot = new SchemaSnapshot(
    compiled,
    computeSchemaHash(compiled.namespaces, compiled.caveats),
    SCHEMA_TEXT,
    0,
  );
  const readerSource = new FakeReaderSource(rows);
  const schemaResolver = new SchemaResolver();
  schemaResolver.seed(snapshot);

  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: [{ ctor: MembershipWalkGrain, interfaces: [IMembershipWalkGrain] }],
    configureSilo: (builder) => {
      builder.addPlacementStrategy(
        GRAPH_LOCALITY_PLACEMENT_STRATEGY,
        new GraphLocalityPlacementDirector(),
      );
      builder.useGrainActivator({
        createInstance: (ctor) =>
          ctor === MembershipWalkGrain
            ? new MembershipWalkGrain({
                schemaSource: NEVER_READ_SCHEMA,
                schemaProvider: new FixedSchemaProvider(snapshot),
                schemaResolver,
                readerSource,
                options: { enabled: options.memoEnabled ?? true },
              })
            : constructGrain(ctor),
      });
    },
  });

  fixture = { cluster, readerSource, schemaHash: snapshot.schemaHash };
  return fixture;
}

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  if (current !== undefined) await current.cluster.dispose();
});

function walk(
  f: Fixture,
  subject: ObjectAndRelation,
  args: MembershipWalkArgs,
  signal?: AbortSignal,
): Promise<MembershipClosureReply> {
  const key = membershipWalkKeyBuild(
    subject.objectType,
    subject.objectId,
    subject.relation,
    REVISION.toString(),
    f.schemaHash,
  );
  return f.cluster.primary.host.getGrain(IMembershipWalkGrain, key).getContainingSet(args, signal);
}

/** `type:id#relation` per node, deduplicated and SORTED - for the assertions about REACH. */
function nodeSet(reply: MembershipClosureReply): string[] {
  return [...new Set(reply.nodes.map(label))].sort();
}

/** Every node, duplicates and order preserved - for the assertions that DO care. */
function nodeList(reply: MembershipClosureReply): string[] {
  return reply.nodes.map(label);
}

function label(node: ResourceNodeWire): string {
  return `${node.type}:${node.id}#${node.relation}`;
}

const ROOT: MembershipWalkArgs = { path: [], depthRemaining: 50 };

describe("MembershipWalkGrain", () => {
  describe("one reverse-adjacency hop", () => {
    it("returns the subject's direct parents as nodes", async () => {
      const f = await start([member("g1", USER("alice"))]);

      const reply = await walk(f, USER("alice"), ROOT);

      expect(nodeList(reply)).toEqual(["group:g1#member"]);
      expect(reply.cycleCut).toBe(false);
      expect(reply.incomplete).toBe(false);
    });

    /** Every parent is dispatched to the SIBLING grain keyed by that parent, so the walk is real. */
    it("unions every child's nodes with this hop's own parents", async () => {
      const f = await start([
        member("g1", USER("alice")),
        member("g2", GROUP("g1")),
        member("g3", GROUP("g2")),
      ]);

      const reply = await walk(f, USER("alice"), ROOT);

      expect(nodeSet(reply)).toEqual(["group:g1#member", "group:g2#member", "group:g3#member"]);
    });

    /**
     * DUPLICATES ARE INTENTIONAL. Two branches reaching the same parent contribute it twice, and
     * nothing in the accumulation dedups - the dedup lives one layer up. A mechanical port that
     * reached for a `Set` here would change the reply shape without failing anything else.
     */
    it("keeps duplicate nodes contributed by two branches", async () => {
      const f = await start([
        member("g1", USER("alice")),
        member("g2", USER("alice")),
        member("shared", GROUP("g1")),
        member("shared", GROUP("g2")),
      ]);

      const reply = await walk(f, USER("alice"), ROOT);

      expect(nodeList(reply).filter((n) => n === "group:shared#member")).toHaveLength(2);
    });

    /**
     * Sibling branches must not prune one another: the child path is built ONCE from the caller's
     * path plus this grain's own subject key, and REUSED for every child - never accumulated into
     * across the loop. If an earlier sibling's key leaked onto a later sibling's path, the later
     * branch would silently cut and drop its subtree.
     */
    it("does not let one sibling branch prune another", async () => {
      const f = await start([
        member("g1", USER("alice")),
        member("g2", USER("alice")),
        member("above1", GROUP("g1")),
        member("above2", GROUP("g2")),
      ]);

      const reply = await walk(f, USER("alice"), ROOT);

      expect(nodeSet(reply)).toEqual([
        "group:above1#member",
        "group:above2#member",
        "group:g1#member",
        "group:g2#member",
      ]);
      expect(reply.cycleCut).toBe(false);
    });
  });

  describe("cycles", () => {
    /**
     * A genuine data cycle terminates on the BACK EDGE - with plenty of budget left - never by
     * burning the budget down to an `incomplete` reply, which would silently disable the fast path
     * for all cyclic data. Both groups still appear as candidates.
     */
    it("cuts on the back edge, not on depth exhaustion", async () => {
      const f = await start([
        member("a", GROUP("b")),
        member("b", GROUP("a")),
        member("a", USER("alice")),
      ]);

      const reply = await walk(f, USER("alice"), ROOT);

      expect(reply.cycleCut).toBe(true);
      expect(reply.incomplete).toBe(false);
      expect(nodeSet(reply)).toEqual(["group:a#member", "group:b#member"]);
    });

    /**
     * THE PATH FORMAT IS THE CONTRACT. The path is built here with `subjectKeyToString`, exactly as
     * a caller further up the walk builds it, and the grain must recognise it: `g1` is on the path,
     * so it is reported as a node and NOT recursed into - which is observable as `g2` (reachable
     * only THROUGH g1) being absent. If the format ever drifts, the containment test silently never
     * matches, the cut never happens, and this case turns g2 up.
     */
    it("skips recursion into a parent already on the caller's path", async () => {
      const f = await start([member("g1", USER("alice")), member("g2", GROUP("g1"))]);
      const onPath = subjectKeyToString({ type: "group", id: "g1", relation: "member" });

      const reply = await walk(f, USER("alice"), { path: [onPath], depthRemaining: 50 });

      // Still a node - it genuinely IS a direct parent; only the recursion is skipped.
      expect(nodeList(reply)).toEqual(["group:g1#member"]);
      expect(reply.cycleCut).toBe(true);
      expect(reply.incomplete).toBe(false);
      // One hop only: no reentrant call was made at all, which is the skip-on-path-hit divergence
      // from CheckGrain's call-anyway shape.
      expect(f.readerSource.hops).toBe(1);
    });
  });

  describe("depth exhaustion", () => {
    /**
     * Budget exhausted before this hop could recurse: the direct parents are still valid
     * candidates, but nothing beyond them was explored, so the whole reply is partial.
     */
    it("reports incomplete when the budget is spent and there are parents", async () => {
      const f = await start([member("g1", USER("alice")), member("g2", GROUP("g1"))]);

      const reply = await walk(f, USER("alice"), { path: [], depthRemaining: 0 });

      expect(reply.incomplete).toBe(true);
      expect(reply.cycleCut).toBe(false);
      expect(nodeList(reply)).toEqual(["group:g1#member"]);
    });

    /**
     * `incomplete` is CONDITIONAL on there being parents, not unconditionally true: a subject with
     * no direct parents at all has a complete (empty) closure, whatever the budget was.
     */
    it("reports complete when the budget is spent but there were no parents", async () => {
      const f = await start([member("g1", USER("bob"))]);

      const reply = await walk(f, USER("alice"), { path: [], depthRemaining: 0 });

      expect(reply.incomplete).toBe(false);
      expect(reply.nodes).toEqual([]);
    });

    /** A child's `incomplete` ORs upward - it is never replaced by the parent's own state. */
    it("ors a child's incomplete flag into this reply", async () => {
      const f = await start([
        member("g1", USER("alice")),
        member("g2", GROUP("g1")),
        member("g3", GROUP("g2")),
      ]);

      // One hop of budget: alice -> g1 recurses, and g1's own hop is left with none.
      const reply = await walk(f, USER("alice"), { path: [], depthRemaining: 1 });

      expect(reply.incomplete).toBe(true);
      expect(nodeSet(reply)).toEqual(["group:g1#member", "group:g2#member"]);
    });
  });

  describe("the activation memo", () => {
    /**
     * The memo check happens FIRST and IGNORES `args` entirely - which is sound precisely because
     * only path- and budget-INDEPENDENT replies are ever stored. So a second call with a budget of
     * ZERO is still served the complete memoized reply, rather than the depth-exhausted one it
     * would compute.
     */
    it("serves the memo regardless of the args of the second call", async () => {
      const f = await start([member("g1", USER("alice")), member("g2", GROUP("g1"))]);

      const first = await walk(f, USER("alice"), ROOT);
      const hopsAfterFirst = f.readerSource.hops;
      const second = await walk(f, USER("alice"), { path: [], depthRemaining: 0 });

      expect(second).toEqual(first);
      expect(second.incomplete).toBe(false);
      expect(f.readerSource.hops).toBe(hopsAfterFirst);
    });

    /**
     * A CUT reply is path-dependent, so it is never retained: a later caller arriving on a
     * different path would be served a closure that was only complete relative to the first
     * caller's path.
     */
    it("never memoizes a cycle-cut reply", async () => {
      const f = await start([
        member("a", GROUP("b")),
        member("b", GROUP("a")),
        member("a", USER("alice")),
      ]);

      const first = await walk(f, USER("alice"), ROOT);
      const hopsAfterFirst = f.readerSource.hops;
      await walk(f, USER("alice"), ROOT);

      expect(first.cycleCut).toBe(true);
      expect(f.readerSource.hops).toBeGreaterThan(hopsAfterFirst);
    });

    /** An INCOMPLETE reply is budget-dependent, so it is never retained either. */
    it("never memoizes an incomplete reply", async () => {
      const f = await start([member("g1", USER("alice")), member("g2", GROUP("g1"))]);

      await walk(f, USER("alice"), { path: [], depthRemaining: 0 });
      const hopsAfterFirst = f.readerSource.hops;
      const second = await walk(f, USER("alice"), ROOT);

      expect(f.readerSource.hops).toBeGreaterThan(hopsAfterFirst);
      expect(second.incomplete).toBe(false);
      expect(nodeSet(second)).toEqual(["group:g1#member", "group:g2#member"]);
    });

    /** Disabled, the grain neither consults nor populates the memo. */
    it("recomputes every call when the memo is disabled", async () => {
      const f = await start([member("g1", USER("alice"))], { memoEnabled: false });

      await walk(f, USER("alice"), ROOT);
      const hopsAfterFirst = f.readerSource.hops;
      await walk(f, USER("alice"), ROOT);

      expect(f.readerSource.hops).toBeGreaterThan(hopsAfterFirst);
    });
  });

  describe("cancellation", () => {
    /**
     * The caller's own signal drives the walk, checked at the top of each parent iteration and
     * propagated into the sibling grain call directly - Orleans propagates the token natively and
     * Thresh must too.
     */
    it("rejects when the caller's signal is already aborted", async () => {
      const f = await start([member("g1", USER("alice")), member("g2", GROUP("g1"))]);

      await expect(walk(f, USER("alice"), ROOT, AbortSignal.abort())).rejects.toThrow();
    });
  });
});
