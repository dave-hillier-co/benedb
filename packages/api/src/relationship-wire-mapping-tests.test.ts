import type { RelationshipWire } from "@benedb/grains/relationships-dtos";
import { Relationship as V1Relationship } from "@benedb/protos/authzed/api/v1/core";
import { Relationship as V0Relationship } from "@benedb/protos/permissions";
import { describe, expect, it } from "vitest";

import { toWireRelationship as authzedPermissionsToWire } from "./authzed-permissions-v1-service";
import { toWireRelationship as bulkToWire } from "./bulk-grpc-service";
import { toWireRelationship as permissionsToWire } from "./permissions-grpc-service";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/RelationshipWireMappingTests.cs`.
 *
 * Pins the wire mapping for a caveat with an empty name but a non-empty context (issue #42): the
 * name guard and the context guard must agree, so an empty name discards the whole caveat instead
 * of producing a `RelationshipWire` whose context belongs to no caveat. This must be asserted at
 * the mapper, not via a write/read round trip - `WireConvert.toRelationship` discards the orphan
 * context downstream, so a round trip looks identical with or without the fix.
 *
 * The C# makes the mappers `internal` and reaches them via `InternalsVisibleTo`; here they are
 * exported normally and say so at the site, per the ledger's note on that file.
 */

const ORPHAN_CONTEXT = { orphan: "context" };

function v1Relationship(caveatName: string) {
  return V1Relationship.fromPartial({
    resource: { objectType: "document", objectId: "readme" },
    relation: "viewer",
    subject: { object: { objectType: "user", objectId: "alice" } },
    optionalCaveat: { caveatName, context: ORPHAN_CONTEXT },
  });
}

function v0Relationship(caveatName: string) {
  return V0Relationship.fromPartial({
    resource: { objectType: "document", objectId: "readme" },
    resourceRelation: "viewer",
    subject: { object: { objectType: "user", objectId: "alice" } },
    optionalCaveat: { caveatName, context: ORPHAN_CONTEXT },
  });
}

const MAPPERS: ReadonlyArray<[string, (caveatName: string) => RelationshipWire]> = [
  ["AuthzedPermissionsV1Service", (name) => authzedPermissionsToWire(v1Relationship(name))],
  ["BulkGrpcService", (name) => bulkToWire(v0Relationship(name))],
  ["PermissionsGrpcService", (name) => permissionsToWire(v0Relationship(name))],
];

describe("RelationshipWireMappingTests", () => {
  it.each(MAPPERS)("%s: empty caveat name discards the context too", (_mapper, toWire) => {
    const wire = toWire("");

    expect(wire.caveatName).toBeUndefined();
    expect(wire.caveatContext).toBeUndefined();
  });

  it.each(MAPPERS)("%s: named caveat keeps name and context", (_mapper, toWire) => {
    const wire = toWire("only_on_tuesday");

    expect(wire.caveatName).toBe("only_on_tuesday");
    expect(wire.caveatContext).toBeDefined();
    expect(wire.caveatContext?.has("orphan")).toBe(true);
  });
});
