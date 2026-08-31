import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadValidationFile } from "@benedb/conformance/validation-file-loader";
import { assertionExpectedMembership } from "@benedb/conformance/validation-model";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { IManagementGrain } from "@thresh/core/management-grain";

import { MeshTestCluster } from "./mesh-test-cluster";
import type { RelationshipUpdateWire } from "./relationships-dtos";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ColdStartTests.cs`.
 *
 * The two closing gates for the removal of the per-silo whole-graph projection.
 *
 *  1. A freshly booted cluster must serve a check with NO pre-traffic warmup of ANY kind. There is
 *     no per-silo replica left to bootstrap before the first request, so the first check on a cold
 *     silo exercises exactly the production cold path: shard grains hydrating on demand against the
 *     sequencer log. It resolves the checker from a NON-PRIMARY silo's own wiring, so the harness's
 *     per-silo accessor (`allSiloServices` / `servicesForSilo`, not just `services`) has to work.
 *  2. The HOT-SET property: `GraphShardGrain` activations must stay bounded by the slices traffic
 *     actually TOUCHED - `2 * distinctObjects`, the factor 2 being forward + reverse keys per
 *     object. The point is not the constant: it is that the count is proportional to TOUCHED keys
 *     and nothing else - not revisions, not checks issued, not total graph size. A port that
 *     pre-activates shards, or activates a shard per revision, blows this bound.
 *
 * PORT NOTES.
 *  - The C# ends gate 1 with a REFLECTION TRIPWIRE: no retired projection component type may exist
 *    in the Server assembly, probed against a type that IS in that assembly so it cannot silently
 *    scan the wrong one. TypeScript erases types and has no assembly to reflect over, so the
 *    equivalent is a SOURCE-LEVEL scan of this package's modules for a top-level export by each
 *    retired name, anchored the same way on `GrainBackedDatastore` - which is genuinely exported
 *    here. Recorded as a deviation; dropping the case would let the replica quietly return.
 *  - Activation counting goes through the management grain's detailed grain statistics with a
 *    CASE-INSENSITIVE substring match on the grain type name, as in the C#.
 *  - `.Distinct()` over value-typed `(type, id)` tuples has no TypeScript analogue (object
 *    identity, not value equality), so distinct objects are counted through composite string keys
 *    in a `Set`.
 *  - The positive control (`shardActivations >= 1`) runs FIRST, before the upper bound, so "zero
 *    activations" can never pass as "within budget". That ordering is preserved deliberately.
 *  - `await using` -> an explicit `try/finally`.
 */

const requireFromHere = createRequire(import.meta.url);

const CORPUS_DIR = resolvePath(
  dirname(requireFromHere.resolve("@benedb/conformance/validation-file-loader")),
  "..",
  "corpus",
);

/** This package's source directory - the "assembly" the tripwire scans. */
const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

const SCHEMA = `definition user {}

definition group {
  relation member: user
}

definition doc {
  relation viewer: user | group#member
  permission view = viewer
}`;

/** The C#'s `Touch(...)` helper: one Touch update on the production write wire. */
function touch(
  resourceType: string,
  resourceId: string,
  relation: string,
  subjectType: string,
  subjectId: string,
  subjectRelation: string,
): RelationshipUpdateWire {
  return {
    operation: "touch",
    relationship: {
      resourceType,
      resourceId,
      resourceRelation: relation,
      subjectType,
      subjectId,
      subjectRelation,
      caveatName: undefined,
      caveatContext: undefined,
      expiration: undefined,
    },
  };
}

/** The C#'s `User(id)` helper. */
function user(id: string): ObjectAndRelation {
  return { objectType: "user", objectId: id, relation: ELLIPSIS };
}

/** Every top-level exported name declared by this package's non-test modules. */
function declaredExportNames(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    const text = readFileSync(join(SRC_DIR, entry.name), "utf8");
    for (const match of text.matchAll(
      /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|const|function|enum)\s+([A-Za-z0-9_$]+)/gm,
    )) {
      names.add(match[1]!);
    }
  }
  return names;
}

/**
 * The case-insensitive grain-type substring the shard-activation controls match on.
 *
 * The C# matched `"graphshardgrain"` against Orleans' grain type name. Thresh registers a grain
 * under its class name MINUS the `Grain` suffix, so the live type here reads `GraphShard` and the
 * C#'s literal would never hit - the positive control would pass vacuously, which is the one thing
 * it exists to prevent. The substring is therefore shortened to the part both spellings share.
 */
const SHARD_GRAIN_TYPE_MATCH = "graphshard";

/** The number of live `GraphShardGrain` activations across the cluster. */
async function shardActivationCount(cluster: MeshTestCluster): Promise<number> {
  const management = cluster.grainFactory.getGrain(IManagementGrain, 0n);
  const stats = await management.getDetailedGrainStatistics();
  return stats.filter((s) => s.grainType.toLowerCase().includes(SHARD_GRAIN_TYPE_MATCH)).length;
}

describe("ColdStartTests", () => {
  it("Fresh_Cluster_Serves_A_Check_From_A_Non_Primary_Silo_With_No_Warmup", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(SCHEMA, 3);
    try {
      // Load data through the production write wire; the schema was compiled into every silo at
      // boot.
      await cluster.relationships.writeRelationships({
        updates: [
          touch("group", "eng", "member", "user", "alice", ELLIPSIS),
          touch("doc", "spec", "viewer", "group", "eng", "member"),
        ],
      });

      // Immediately check from a NON-PRIMARY silo's checker - the same `IPermissionChecker` its
      // gRPC front door would resolve - with no warmup call of any kind in between.
      expect(
        cluster.allSiloServices.length,
        "gate needs a non-primary silo to check from",
      ).toBeGreaterThanOrEqual(2);
      const checker = cluster.servicesForSilo(1).checker;

      const member = await checker.check("doc", "spec", "view", user("alice"), undefined);
      expect(member.verdict).toBe("member");

      const stranger = await checker.check("doc", "spec", "view", user("mallory"), undefined);
      expect(stranger.verdict).toBe("notMember");

      // Tripwire: no retired projection component may exist in this package. The probe anchors on
      // a name that IS declared here, so it cannot silently scan the wrong tree.
      const declared = declaredExportNames();
      expect(
        declared.has("GrainBackedDatastore"),
        `the tripwire scanned ${SRC_DIR} and did not find its anchor type`,
      ).toBe(true);

      const retired = [
        "SiloProjection",
        "DatastoreProjectionHost",
        "IDatastoreProjectionHost",
        "DatastoreProjectionService",
        "IDatastoreProjectionGrainService",
        "ProjectionGraphReaderSource",
        "GraphReaderOptions",
      ];
      const survivors = retired.filter((name) => declared.has(name));
      expect(
        survivors,
        `retired projection type(s) resurfaced in @benedb/grains: ${survivors.join(", ")}`,
      ).toEqual([]);
    } finally {
      await cluster.dispose();
    }
  }, 180_000);

  it("Shard_Activations_Are_Bounded_By_The_Touched_Slices", async () => {
    const path = join(CORPUS_DIR, "indirectnestedgroups.yaml");
    expect(existsSync(path), `Linked corpus file missing from output: ${path}`).toBe(true);
    const file = loadValidationFile(path);
    expect(
      file.relationships.length > 0 && file.assertions.length > 0,
      "gate needs a corpus file with relationships and assertions",
    ).toBe(true);

    const cluster = await MeshTestCluster.create(file.schemaText);
    try {
      const updates: readonly RelationshipUpdate[] = file.relationships.map((relationship) => ({
        relationship,
        operation: "create",
      }));
      await cluster.datastore.readWriteTx((tx) => tx.writeRelationships(updates));

      for (const assertion of file.assertions) {
        const result = await cluster.checker.check(
          assertion.resource.objectType,
          assertion.resource.objectId,
          assertion.resource.relation,
          assertion.subject,
          assertion.caveatContext,
        );
        expect(result.verdict).toBe(assertionExpectedMembership(assertion));
      }

      // `.Distinct()` over value tuples -> composite string keys in a Set.
      const objects = new Set<string>();
      const add = (onr: ObjectAndRelation): void => {
        objects.add(`${onr.objectType}:${onr.objectId}`);
      };
      for (const relationship of file.relationships) {
        add(relationship.reference.resource);
        add(relationship.reference.subject);
      }
      for (const assertion of file.assertions) {
        add(assertion.resource);
        add(assertion.subject);
      }
      const distinctObjects = objects.size;
      const bound = 2 * distinctObjects;

      const shardActivations = await shardActivationCount(cluster);

      // Positive control FIRST: the verdicts above must actually have been served by the shard
      // mesh.
      expect(
        shardActivations,
        "positive control failed: no GraphShardGrain activation exists",
      ).toBeGreaterThanOrEqual(1);
      expect(
        shardActivations <= bound,
        `hot-set property violated: ${shardActivations} GraphShardGrain activation(s) exceed the ` +
          `touched-slice bound of ${bound} (2 x ${distinctObjects} distinct objects)`,
      ).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);
});
