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
import { computeSchemaHash } from "@spacedb/engine/schema-hash";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import { TestCluster } from "@thresh/testing/test-cluster";
import { afterEach, describe, expect, it } from "vitest";

import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import { GraphLocalityPlacementDirector } from "./graph-locality-placement-director";
import { DispatchMetrics } from "./i-dispatch-metrics";
import type { IGraphReaderSource } from "./i-graph-reader-source";
import type { ISchemaProvider } from "./i-schema-provider";
import { SchemaSnapshot } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import { ISubjectFrontierGrain } from "./i-subject-frontier-grain";
import { SchemaResolver } from "./schema-resolver";
import { SubjectFrontierGrain } from "./subject-frontier-grain";
import { subjectFrontierKeyBuild } from "./subject-frontier-key";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/SubjectFrontierGrain.cs`.
 *
 * NO COVERING C# TEST: the grain's gate is `SubjectFrontierMemoMeshTests`, which needs a
 * `MeshTestCluster` from a later batch. This is a CHARACTERIZATION of the file, and it exists in
 * this batch for one reason above all: this grain and `CheckGrain` are the two memoizing read-path
 * grains, they memoize DIFFERENTLY, and getting one right and the next wrong is the likely failure
 * mode. Read side by side with `check-grain.test.ts`.
 *
 * The four differences from `CheckGrain` that this file pins:
 *
 *  1. DELIBERATELY NOT REENTRANT. This is the one place in the file set where the ABSENCE of an
 *     option is the design. The grain has no dispatcher seam at all - `LookupSubjectsEngine` walks
 *     the whole sub-graph in-process from this activation - so default turn-based execution gives
 *     single-flight FOR FREE: two concurrent calls to the same activation queue, and the second is
 *     served by the memo the first just populated. Thresh grains are NON-reentrant by default
 *     (`grain-metadata.ts`'s `reentrantRegistry` is opt-in via `@reentrant()`), verified for this
 *     port; do not add a reentrant option here, and do not let one arrive by copying `CheckGrain`.
 *  2. NO DEPTH GUARD, NO CYCLE-CUT ANALOGUE. The walk always runs WHOLE from the key's root; its
 *     depth limit and visited-set guard are internal to `LookupSubjectsEngine`, and the result is a
 *     pure function of the key alone. There is no caller-supplied budget varying completeness, so
 *     there is nothing to guard - importing `CheckGrain`'s `depthRequired` logic by analogy would
 *     be inventing a rule the C# does not have.
 *  3. MEMO ELIGIBILITY IS A SIZE CAP, not a cut/complete test: store only when
 *     `enabled && subjects.length <= maxMemoSubjects`. An over-cap result is SERVED but NOT
 *     RETAINED - the caller always gets the freshly computed reply regardless.
 *  4. THE MEMOIZED VALUE IS THE PRE-CONTEXT FRONTIER (verbatim caveat expressions exactly as the
 *     engine yields them), never a collapsed verdict; context is applied per-request at
 *     `ReverseOps.streamLookupSubjects`. A port that collapses in the grain passes the first memo
 *     test and fails the mesh's
 *     `Memoized_frontier_collapses_differently_under_different_request_contexts_via_the_stream`.
 *
 * Shared with `CheckGrain`: `now` is captured once per COMPUTE (not once per activation), and the
 * hit/miss metrics are recorded ONLY when the memo is enabled.
 */

const SCHEMA_TEXT = `
caveat only_on_tuesday(day string) {
    day == "tuesday"
}

definition user {}

definition document {
    relation viewer: user with only_on_tuesday | user
    permission view = viewer
}
`;

const RESOURCE: ObjectAndRelation = { objectType: "document", objectId: "doc1", relation: "view" };
const REVISION = 4_200_000_000n;

function onr(objectType: string, objectId: string, relation = ELLIPSIS): ObjectAndRelation {
  return { objectType, objectId, relation };
}

// --- collaborators ----------------------------------------------------------------------------

/**
 * An in-memory graph over a fixed relationship list, filtered with the SAME predicates the real
 * readers use, so the engine walking it behaves exactly as it does over a datastore snapshot. A
 * gate lets a compute be parked mid-walk, which is what makes the single-flight case observable.
 */
class FakeReaderSource implements IGraphReaderSource {
  /** How many readers were handed out - one per COMPUTE, so this counts computes. */
  computes = 0;
  /** When set, the first query of each walk awaits it before yielding anything. */
  park: Promise<void> | undefined;

  constructor(private readonly rows: readonly Relationship[]) {}

  graphReaderAt(_revision: IRevision): IGraphReader {
    this.computes += 1;
    const rows = this.rows;
    // The generators below are object-literal methods, so their own `this` is that literal, not
    // the reader source - the alias is what keeps the mutable `park` gate readable at call time.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const source = this;
    return {
      async *queryRelationships(
        filter: RelationshipsFilter,
        _signal?: AbortSignal | undefined,
      ): AsyncIterable<Relationship> {
        if (source.park !== undefined) await source.park;
        for (const rel of rows) if (relationshipsFilterMatches(filter, rel)) yield rel;
      },
      async *reverseQueryRelationships(
        subjectsFilter: SubjectsFilter,
        _options?: unknown,
        _signal?: AbortSignal | undefined,
      ): AsyncIterable<Relationship> {
        if (source.park !== undefined) await source.park;
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
  readonly readerSource: FakeReaderSource;
  readonly metrics: DispatchMetrics;
  readonly key: string;
}

let fixture: Fixture | undefined;

interface StartOptions {
  readonly rows: readonly Relationship[];
  readonly memoEnabled?: boolean;
  readonly maxMemoSubjects?: number;
}

async function start(options: StartOptions): Promise<Fixture> {
  const snapshot = snapshotOf(SCHEMA_TEXT);
  const readerSource = new FakeReaderSource(options.rows);
  const metrics = new DispatchMetrics();
  const schemaResolver = new SchemaResolver();
  schemaResolver.seed(snapshot);

  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: [{ ctor: SubjectFrontierGrain, interfaces: [ISubjectFrontierGrain] }],
    configureSilo: (builder) => {
      builder.addPlacementStrategy(
        GRAPH_LOCALITY_PLACEMENT_STRATEGY,
        new GraphLocalityPlacementDirector(),
      );
      builder.useGrainActivator({
        createInstance: (ctor) =>
          ctor === (SubjectFrontierGrain as unknown as new () => SubjectFrontierGrain)
            ? new SubjectFrontierGrain({
                schemaSource: NEVER_READ_SCHEMA,
                schemaProvider: new FixedSchemaProvider(snapshot),
                schemaResolver,
                readerSource,
                memoOptions: {
                  enabled: options.memoEnabled ?? true,
                  maxMemoSubjects: options.maxMemoSubjects,
                },
                metrics,
              })
            : new ctor(),
      });
    },
  });

  fixture = {
    cluster,
    readerSource,
    metrics,
    key: subjectFrontierKeyBuild(
      RESOURCE,
      "user",
      ELLIPSIS,
      REVISION.toString(),
      snapshot.schemaHash,
    ),
  };
  return fixture;
}

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  if (current !== undefined) await current.cluster.dispose();
});

function frontier(f: Fixture) {
  return f.cluster.primary.host.getGrain(ISubjectFrontierGrain, f.key).getFrontier();
}

const VIEWER = (id: string, caveatName?: string): Relationship =>
  createRelationship(
    onr("document", "doc1", "viewer"),
    onr("user", id),
    caveatName === undefined ? undefined : { caveatName, context: undefined },
  );

describe("SubjectFrontierGrain", () => {
  describe("the walk", () => {
    /** The whole frontier for the key's root, computed in-process behind ONE grain call. */
    it("computes the frontier its key names", async () => {
      const f = await start({ rows: [VIEWER("alice"), VIEWER("bob")] });

      const reply = await frontier(f);

      expect(reply.subjects.map((s) => s.subjectId).sort()).toEqual(["alice", "bob"]);
      // ONE reader for ONE compute: there is no dispatcher seam, so the walk never leaves this
      // activation. A port that grew a per-sub-problem grain call would show up as several.
      expect(f.readerSource.computes).toBe(1);
    });

    /**
     * THE PRE-CONTEXT CONTRACT. The caveat comes back as its verbatim serialized expression, not
     * as a verdict collapsed against a request context - there is no context here to collapse
     * against, and there never will be at this layer. A grain that collapsed early would return an
     * unconditional subject (or none) and the caveat corpus would fail far from this file.
     */
    it("yields verbatim caveat expressions, never a collapsed verdict", async () => {
      const f = await start({ rows: [VIEWER("alice", "only_on_tuesday")] });

      const reply = await frontier(f);

      expect(reply.subjects).toHaveLength(1);
      expect(reply.subjects[0]!.subjectId).toBe("alice");
      expect(reply.subjects[0]!.caveat).toEqual({
        kind: "leaf",
        caveatName: "only_on_tuesday",
        context: undefined,
      });
      expect(reply.subjects[0]!.isWildcard).toBe(false);
    });
  });

  describe("the activation memo", () => {
    it("serves the second call from the memo without recomputing", async () => {
      const f = await start({ rows: [VIEWER("alice")] });

      const first = await frontier(f);
      const second = await frontier(f);

      expect(second).toEqual(first);
      expect(f.readerSource.computes).toBe(1);
      expect(f.metrics.snapshot()).toMatchObject({ frontierMemoHit: 1, frontierMemoMiss: 1 });
    });

    /**
     * OVER-CAP IS SERVED BUT NOT RETAINED: the caller gets the freshly computed reply
     * unconditionally, and only the RETENTION is capped. Both halves are asserted, because a port
     * that skipped the serve (returning an empty or partial reply over cap) and a port that
     * retained it anyway each pass only one.
     */
    it("serves an over-cap frontier but does not retain it", async () => {
      const f = await start({
        rows: [VIEWER("alice"), VIEWER("bob")],
        maxMemoSubjects: 1,
      });

      const first = await frontier(f);
      const second = await frontier(f);

      expect(first.subjects.map((s) => s.subjectId).sort()).toEqual(["alice", "bob"]);
      expect(second.subjects.map((s) => s.subjectId).sort()).toEqual(["alice", "bob"]);
      expect(f.readerSource.computes).toBe(2);
      expect(f.metrics.snapshot()).toMatchObject({ frontierMemoHit: 0, frontierMemoMiss: 2 });
    });

    /** A frontier exactly AT the cap is retained: the comparison is `<=`, not `<`. */
    it("retains a frontier exactly at the cap", async () => {
      const f = await start({
        rows: [VIEWER("alice"), VIEWER("bob")],
        maxMemoSubjects: 2,
      });

      await frontier(f);
      await frontier(f);

      expect(f.readerSource.computes).toBe(1);
    });

    /**
     * With the memo disabled the grain never consults or populates it AND records neither counter -
     * the mesh's `Disabled_memo_never_hits_or_misses` asserts both stay at zero.
     */
    it("neither consults nor counts the memo when it is disabled", async () => {
      const f = await start({ rows: [VIEWER("alice")], memoEnabled: false });

      await frontier(f);
      await frontier(f);

      expect(f.readerSource.computes).toBe(2);
      expect(f.metrics.snapshot()).toMatchObject({ frontierMemoHit: 0, frontierMemoMiss: 0 });
    });

    /**
     * THE FREE SINGLE-FLIGHT. Two concurrent calls to the SAME activation must produce exactly ONE
     * compute: the second queues behind the first on the non-reentrant activation and is then
     * served by the memo the first just populated. This is the whole reason the C# does NOT mark
     * this grain reentrant, and it is the assertion that fails if a port copies `CheckGrain`'s
     * reentrancy across by analogy - the memo-hit gate would degrade into a flaky race instead of
     * failing honestly.
     */
    it("single-flights concurrent calls to one activation", async () => {
      const f = await start({ rows: [VIEWER("alice")] });
      let release: (() => void) | undefined;
      f.readerSource.park = new Promise<void>((resolve) => {
        release = resolve;
      });

      const grain = f.cluster.primary.host.getGrain(ISubjectFrontierGrain, f.key);
      const a = grain.getFrontier();
      const b = grain.getFrontier();
      release!();
      const [first, second] = await Promise.all([a, b]);

      expect(second).toEqual(first);
      expect(f.readerSource.computes).toBe(1);
      expect(f.metrics.snapshot()).toMatchObject({ frontierMemoHit: 1, frontierMemoMiss: 1 });
    });
  });
});
