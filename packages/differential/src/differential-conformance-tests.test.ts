import { describe, expect, it } from "vitest";
import { AuthzedPermissionsV1Service } from "@benedb/api/authzed-permissions-v1-service";
import { CollectingStreamWriter } from "@benedb/api/collecting-stream-writer";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { Relationship as CoreRelationship } from "@benedb/core/relationship";
import type { RelationshipUpdate as CoreRelationshipUpdate } from "@benedb/core/relationship-update";
import { buildRandomAuthzWorld } from "@benedb/engine/random-authz-worlds";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import {
  RelationshipUpdate_Operation,
  type ObjectReference,
  type RelationshipUpdate,
  type SubjectReference,
} from "@benedb/protos/authzed/api/v1/core";
import {
  CheckPermissionRequest,
  DeleteRelationshipsRequest,
  LookupResourcesRequest,
  LookupSubjectsRequest,
  WriteRelationshipsRequest,
  type LookupResourcesResponse,
  type LookupSubjectsResponse,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { WriteSchemaRequest } from "@benedb/protos/authzed/api/v1/schema_service";

import { formatIdSet, normalizePermissionship, setEquals } from "./differential-comparison";
import {
  spiceDbAvailable,
  spiceDbSkipReason,
  useSpiceDbContainer,
} from "./spice-db-container-fixture";
import { SpiceDbGrpcClient } from "./spice-db-grpc-client";

/**
 * Ported from Spiceport `tests/Spiceport.Differential.Tests/DifferentialConformanceTests.cs`.
 *
 * THE external correctness gate: for each seeded random world from `random-authz-worlds.ts`, writes
 * the SAME schema and relationships to a REAL, independent SpiceDB (over gRPC, in a Testcontainers
 * container) and to BeneDB (in-process, through the real grain mesh - `MeshTestCluster`), then
 * asserts every Check/LookupResources/LookupSubjects verdict over the world's full query universe
 * agrees between the two.
 *
 * WHY THIS SUITE EXISTS: every other "two-way" / "cross-API" / "metamorphic" gate in this repo
 * compares BeneDB's engine against BeneDB's OWN engine over a different code path (the reference
 * datastore oracle vs. the grain mesh, or Check vs. the membership-walk accelerator). Those catch
 * REGRESSIONS and cross-path DISAGREEMENTS, but they share the same understanding of SpiceDB
 * semantics baked into `@benedb/engine` - a bug in THAT shared understanding would pass every one
 * of them. This suite is the only one that can catch that class of bug, because the oracle (a real
 * `authzed/spicedb` binary) shares no code with BeneDB.
 *
 * DIALECT: `random-authz-worlds.ts`' schema DSL (definition/relation/permission, union `+`,
 * intersection `&`, exclusion `-`, arrow `->`, userset `group#member`, wildcard `user:*`) is exactly
 * the SpiceDB zed schema language - no translation step is needed. If a future template addition to
 * that generator turns out NOT to parse on real SpiceDB, that divergence belongs in this file's
 * remarks as a dialect finding, and the fix belongs in a differential-specific template subset HERE,
 * NOT in a weakening of the shared generator (which other gates depend on and which do not need
 * SpiceDB compatibility).
 *
 * PORT DECISIONS.
 *
 *  1. {@link SEED_COUNT_LOCAL} IS LOCAL AND IS *NOT* `SEED_COUNT` FROM `random-authz-worlds.ts`.
 *     The C# declares its own `SeedCount = 10`, deliberately smaller than the shared
 *     `RandomAuthzWorlds.SeedCount` (24) that the in-process gates use, because each seed here pays
 *     for a real network round trip per query point against a real SpiceDB process. Importing the
 *     shared `SEEDS` would silently more than double this suite's wall time against a container, so
 *     the row set is built here exactly as the C# builds it. 10 seeds span every one of the six
 *     `DOCUMENT_VIEW_TEMPLATES` shapes at least once with room to spare.
 *  2. `[SkippableTheory]` + `[MemberData(nameof(Seeds))]` -> `it.for(...)`, the form that passes a
 *     `TestContext` so `Skip.IfNot(...)` can become `ctx.skip(...)`. `%i` in the title so a failing
 *     seed names itself.
 *  3. `[Collection(SpiceDbCollection.Name)]` -> `useSpiceDbContainer()` + `describe.sequential`: one
 *     container for the whole file, seeds strictly in order (they share it).
 *  4. THE ORDER OF OPERATIONS IS EXACT AND NON-OBVIOUS: (1) WriteSchema, (2) DeleteRelationships for
 *     each of `["group", "folder", "document"]`, (3) WriteRelationships. The deletes come AFTER the
 *     schema write, not before. Seeds share one container and one small id alphabet, so a stale row
 *     from the previous seed contaminates this one's verdicts - a superset under a union template,
 *     and FLIPPED verdicts under an exclusion template where a stale `banned` row turns a member
 *     into a non-member. This reset is what makes the suite deterministic. The BeneDB side needs no
 *     reset: `MeshTestCluster.create(world.schemaText)` is a fresh cluster (and datastore) per seed,
 *     constructed WITH the schema, so there is nothing further to write on that side.
 *  5. THE WRITE ASYMMETRY IS DELIBERATE (see {@link writeRelationships}): SpiceDB gets
 *     `WriteRelationships` in batches of 50 over the real wire; BeneDB gets a direct
 *     `datastore.readWriteTx(tx => tx.writeRelationships(updates))`. Routing the BeneDB side
 *     through gRPC would change what is being compared.
 *  6. `FakeServerCallContext` DISAPPEARS: BeneDB's service methods take a trailing OPTIONAL
 *     `AbortSignal` instead of a `ServerCallContext`, so every call site simply omits it.
 *     `CollectingStreamWriter<T>` is the shared `@benedb/api` one, not a re-declared private copy.
 *  7. ACCUMULATE-THEN-ASSERT-ONCE IS KEPT. Every divergence appends a formatted line to `failures`
 *     and ONE `expect(failures.length === 0, ...)` runs at the end. A fail-fast `expect` inside the
 *     loop would report the first divergence and hide the PATTERN, which is exactly what makes a
 *     class of bug diagnosable.
 *  8. `await using cluster` has no counterpart; each seed disposes its cluster in an explicit
 *     `try/finally`, and the gRPC client is closed in the same block.
 *
 * WHEN THIS SUITE DISAGREES: do not reflexively "fix" BeneDB. A divergence here may be a SPICEPORT
 * defect that BeneDB faithfully transliterated - check the open spiceport issues and record the
 * seed, the exact query and both verdicts rather than editing the port.
 */

/** Port decision 1: LOCAL, deliberately smaller than the shared `SEED_COUNT` (24). */
const SEED_COUNT_LOCAL = 10;

/** The C#'s `Seeds` member data, built here rather than imported (port decision 1). */
const SEEDS_LOCAL: readonly number[] = Array.from({ length: SEED_COUNT_LOCAL }, (_, s) => s);

/** The relation-bearing types every generated world uses; reset before each seed's write. */
const RESET_TYPES: readonly string[] = ["group", "folder", "document"];

/** Both `view` (mixed set-op shapes across seeds) and `view_mono` (always union/arrow-only). */
const PERMISSIONS: readonly string[] = ["view", "view_mono"];

const fixture = useSpiceDbContainer();

function service(cluster: MeshTestCluster): AuthzedPermissionsV1Service {
  return new AuthzedPermissionsV1Service(
    cluster.checker,
    cluster.grainFactory,
    cluster.reverseOps,
    cluster.relationshipReads,
    cluster.schemaProvider,
  );
}

function objectRef(objectType: string, objectId: string): ObjectReference {
  return { objectType, objectId };
}

function userSubject(subjectId: string): SubjectReference {
  return { object: objectRef("user", subjectId), optionalRelation: "" };
}

/**
 * The C#'s `ToUpdate`. `OptionalRelation` is the EMPTY STRING for an ellipsis subject, not
 * `undefined`: ts-proto encodes both identically here, but the C# writes `string.Empty` and the
 * comparison must not depend on which one this port happened to pick.
 */
function toUpdate(rel: CoreRelationship): RelationshipUpdate {
  const { resource, subject } = rel.reference;
  return {
    operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
    relationship: {
      resource: objectRef(resource.objectType, resource.objectId),
      relation: resource.relation,
      subject: {
        object: objectRef(subject.objectType, subject.objectId),
        optionalRelation: subject.relation === ELLIPSIS ? "" : subject.relation,
      },
      optionalCaveat: undefined,
      optionalExpiresAt: undefined,
    },
  };
}

async function writeRelationships(
  spiceDbClient: SpiceDbGrpcClient,
  cluster: MeshTestCluster,
  relationships: readonly CoreRelationship[],
): Promise<void> {
  // SpiceDB side: WriteRelationships in bounded batches over the real gRPC wire.
  const batchSize = 50;
  for (let i = 0; i < relationships.length; i += batchSize) {
    await spiceDbClient.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: relationships.slice(i, i + batchSize).map(toUpdate),
      }),
    );
  }

  // BeneDB side: straight to the datastore transaction (the same path WriteRelationships's gRPC
  // handler uses under the hood).
  const updates: CoreRelationshipUpdate[] = relationships.map((relationship) => ({
    relationship,
    operation: "touch",
  }));
  await cluster.datastore.readWriteTx(async (tx) => {
    await tx.writeRelationships(updates);
  });
}

/**
 * The full (resource, subject) query universe for this world's documents x users - small by
 * construction (6 documents x 5 users), so enumeration rather than sampling stays fast.
 */
function* enumerateCheckQueries(
  documents: readonly string[],
  users: readonly string[],
): Iterable<readonly [string, string]> {
  for (const doc of documents) {
    for (const user of users) {
      yield [doc, user];
    }
  }
}

describe.sequential("DifferentialConformanceTests", () => {
  it.for(SEEDS_LOCAL)(
    "Check_LookupResources_LookupSubjects_agree_with_real_SpiceDB (seed %i)",
    async (seed, ctx) => {
      ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

      const world = buildRandomAuthzWorld(seed);

      const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
      const cluster = await MeshTestCluster.create(world.schemaText);
      try {
        // --- Write the SAME schema + relationships to both systems. ---
        await spiceDbClient.writeSchema(
          WriteSchemaRequest.fromPartial({ schema: world.schemaText }),
        );
        // BeneDB's cluster is already compiled with this schema at startup, so there is nothing
        // further to write on that side - it starts from the same schema text.

        // Port decision 4: the reset comes AFTER the schema write.
        for (const resourceType of RESET_TYPES) {
          await spiceDbClient.deleteRelationships(
            DeleteRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType } }),
          );
        }

        await writeRelationships(spiceDbClient, cluster, world.relationships);

        const permissionsService = service(cluster);

        const failures: string[] = [];

        // --- CheckPermission over the full query universe. ---
        for (const permission of PERMISSIONS) {
          for (const [resourceId, subjectId] of enumerateCheckQueries(
            world.documents,
            world.users,
          )) {
            const resource = objectRef("document", resourceId);
            const subject = userSubject(subjectId);

            const spiceDbResp = await spiceDbClient.checkPermission(
              CheckPermissionRequest.fromPartial({
                resource,
                permission,
                subject,
                consistency: { fullyConsistent: true },
              }),
            );

            const benedbResp = await permissionsService.checkPermission(
              CheckPermissionRequest.fromPartial({
                resource,
                permission,
                subject,
                consistency: { fullyConsistent: true },
              }),
            );

            if (
              normalizePermissionship(spiceDbResp.permissionship) !==
              normalizePermissionship(benedbResp.permissionship)
            ) {
              failures.push(
                `seed=${seed} CheckPermission document:${resourceId}#${permission}@user:${subjectId} ` +
                  `spicedb=${spiceDbResp.permissionship} benedb=${benedbResp.permissionship}`,
              );
            }
          }
        }

        // --- LookupResources: the accessible-resource SET must match, per subject, per permission.
        for (const permission of PERMISSIONS) {
          for (const subjectId of world.users) {
            const subject = userSubject(subjectId);

            const spiceDbIds = new Set(
              (
                await spiceDbClient.lookupResources(
                  LookupResourcesRequest.fromPartial({
                    resourceObjectType: "document",
                    permission,
                    subject,
                    consistency: { fullyConsistent: true },
                  }),
                )
              ).map((r) => r.resourceObjectId),
            );

            const writer = new CollectingStreamWriter<LookupResourcesResponse>();
            await permissionsService.lookupResources(
              LookupResourcesRequest.fromPartial({
                resourceObjectType: "document",
                permission,
                subject,
                consistency: { fullyConsistent: true },
              }),
              writer,
            );
            const benedbIds = new Set(writer.collected.map((r) => r.resourceObjectId));

            if (!setEquals(spiceDbIds, benedbIds)) {
              failures.push(
                `seed=${seed} LookupResources document#${permission}@user:${subjectId} ` +
                  `spicedb=[${formatIdSet(spiceDbIds)}] benedb=[${formatIdSet(benedbIds)}]`,
              );
            }
          }
        }

        // --- LookupSubjects: the resolved-subject SET must match, per resource, per permission. ---
        for (const permission of PERMISSIONS) {
          for (const resourceId of world.documents) {
            const resource = objectRef("document", resourceId);

            const spiceDbIds = new Set(
              (
                await spiceDbClient.lookupSubjects(
                  LookupSubjectsRequest.fromPartial({
                    resource,
                    permission,
                    subjectObjectType: "user",
                    consistency: { fullyConsistent: true },
                  }),
                )
              ).map((r) => r.subject?.subjectObjectId ?? ""),
            );

            const writer = new CollectingStreamWriter<LookupSubjectsResponse>();
            await permissionsService.lookupSubjects(
              LookupSubjectsRequest.fromPartial({
                resource,
                permission,
                subjectObjectType: "user",
                consistency: { fullyConsistent: true },
              }),
              writer,
            );
            const benedbIds = new Set(
              writer.collected.map((r) => r.subject?.subjectObjectId ?? ""),
            );

            if (!setEquals(spiceDbIds, benedbIds)) {
              failures.push(
                `seed=${seed} LookupSubjects document:${resourceId}#${permission} ` +
                  `spicedb=[${formatIdSet(spiceDbIds)}] benedb=[${formatIdSet(benedbIds)}]`,
              );
            }
          }
        }

        expect(
          failures.length === 0,
          `Divergence(s) between real SpiceDB and BeneDB:\n${failures.join("\n")}`,
        ).toBe(true);
      } finally {
        spiceDbClient.close();
        await cluster.dispose();
      }
    },
  );
});
