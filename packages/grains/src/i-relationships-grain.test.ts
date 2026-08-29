import type { GrainKeyFor } from "@thresh/core/key-kinds";
import { describe, expect, it } from "vitest";

import { IRelationshipsGrain, RELATIONSHIPS_GRAIN_KEY } from "./i-relationships-grain";
import type {
  BulkImportRelationshipsArgs,
  CountRelationshipsArgs,
  DeleteRelationshipsArgs,
  RegisterCounterArgs,
  UnregisterCounterArgs,
  WriteRelationshipsArgs,
  WriteSchemaArgs,
} from "./relationships-dtos";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/IRelationshipsGrain.cs`,
// which has no covering C# test of its own. NOTHING HERE ACTIVATES A GRAIN: `RelationshipsGrain` -
// and its [StatelessWorker] marking, which is a GRAIN-side option, not an interface one - is a
// later slice.

function unimplemented(): never {
  throw new Error("IRelationshipsGrain has no implementation in this slice");
}

describe("IRelationshipsGrain", () => {
  it("is both a type and a registered GrainInterface VALUE named for the C# interface", () => {
    expect(IRelationshipsGrain.name).toBe("IRelationshipsGrain");
  });

  it("carries NO per-method invocation options at all", () => {
    // No method on the C# interface carries [AlwaysInterleave] or [ReadOnly]. [StatelessWorker]
    // sits on the IMPLEMENTATION class, so it does not belong in this map either.
    expect(IRelationshipsGrain.options).toEqual({});
  });

  it("is integer-keyed, and the fixed key is a bigint zero", () => {
    // `IGrainWithIntegerKey` -> `GrainWithIntegerKey`, whose Thresh key type is bigint. The C#'s
    // `public const long Key = 0` has no counterpart on a TypeScript interface, so it folds to a
    // module constant. The grain is a stateless worker, so this is a routing address, not an
    // identity.
    const key: GrainKeyFor<IRelationshipsGrain> = RELATIONSHIPS_GRAIN_KEY;

    expect(key).toBe(0n);
    expect(typeof RELATIONSHIPS_GRAIN_KEY).toBe("bigint");
  });

  it("declares exactly the eight WRITE-side and on-demand operations, in the C#'s order", () => {
    // The READ ops named in the C# remarks - ReadRelationships / BulkExportRelationships and the
    // reverse ops (ExpandPermissionTree, LookupSubjects, LookupResources) - are deliberately NOT
    // on this interface: they run IN-PROCESS via RelationshipReads / ReverseOps. A later slice
    // must not "complete" the interface by adding them.
    const fake: IRelationshipsGrain = {
      writeSchema: (_args: WriteSchemaArgs) => unimplemented(),
      readSchema: () => unimplemented(),
      writeRelationships: (_args: WriteRelationshipsArgs) => unimplemented(),
      deleteRelationships: (_args: DeleteRelationshipsArgs) => unimplemented(),
      bulkImportRelationships: (_args: BulkImportRelationshipsArgs) => unimplemented(),
      registerRelationshipCounter: (_args: RegisterCounterArgs) => unimplemented(),
      unregisterRelationshipCounter: (_args: UnregisterCounterArgs) => unimplemented(),
      countRelationships: (_args: CountRelationshipsArgs) => unimplemented(),
    };

    expect(Object.keys(fake)).toEqual([
      "writeSchema",
      "readSchema",
      "writeRelationships",
      "deleteRelationships",
      "bulkImportRelationships",
      "registerRelationshipCounter",
      "unregisterRelationshipCounter",
      "countRelationships",
    ]);
  });
});
