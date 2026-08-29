import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import {
  CounterOperationException,
  REGISTER_COUNTER_REPLY,
  relationshipStreamItemReadAtToken,
  UNREGISTER_COUNTER_REPLY,
  type CounterErrorKind,
  type DeleteRelationshipsArgs,
  type DeleteRelationshipsReply,
  type PreconditionOpWire,
  type ReadRelationshipsArgs,
  type RelationshipStreamItem,
  type RelationshipUpdateOpWire,
  type RelationshipWire,
  type RelationshipsFilterWire,
} from "./relationships-dtos";

// `src/Spiceport.Server/Grains.Abstractions/RelationshipsDtos.cs` is covered by
// `DatastoreStateWireRoundTripTests` (ported as `datastore-state-wire-round-trip-tests.test.ts`)
// for `RelationshipWire` and the filters. This file pins what that test does not reach, all of it
// port machinery the C# got for free from Orleans: the two enums, the `ulong` widths, the
// default-parameter resolvers, the empty-reply placeholders, and `CounterOperationException`'s
// surrogate.
describe("the relationship update operation on the wire", () => {
  const ops: readonly RelationshipUpdateOpWire[] = ["touch", "create", "delete"];

  it("has exactly the three operations, in the C#'s declaration order", () => {
    // The C# is `Touch = 0, Create = 1, Delete = 2`. The numbers are Orleans-internal - Thresh's
    // codec is name-based - so the port carries the NAMES, and `WireConvert` (a later batch) maps
    // them to the core `UpdateOperation` BY NAME. Nothing may derive one from the other
    // numerically: the two enums' orderings are not guaranteed to agree, and a numeric derivation
    // would turn a create into a delete without a type error.
    expect(ops).toEqual(["touch", "create", "delete"]);
    expect(new Set(ops).size).toBe(3);
  });

  it.each(["touch", "create", "delete"] as const)("round trips %s by name", (operation) => {
    const update = { operation, relationship: aRelationship() };

    expect(deserializeValue<typeof update>(serializeValue(update)).operation).toBe(operation);
  });
});

describe("the precondition operation on the wire", () => {
  it("has exactly must-match and must-not-match", () => {
    const ops: readonly PreconditionOpWire[] = ["mustMatch", "mustNotMatch"];

    expect(new Set(ops).size).toBe(2);
  });
});

describe("the unsigned counts", () => {
  it("carries DeleteRelationships' optional limit and deleted count as bigints", () => {
    // Every C# `ulong` in this file becomes a `bigint`, decided once here: `OptionalLimit`,
    // `DeletedCount`, `BulkImportRelationshipsReply.NumLoaded` and `CountRelationshipsReply.Count`
    // all exceed 2^53 in principle, and `number` would round them silently.
    const args: DeleteRelationshipsArgs = {
      filter: {},
      optionalLimit: 18446744073709551615n,
    };
    const reply: DeleteRelationshipsReply = {
      deletedCount: 18446744073709551615n,
      reachedLimit: true,
      deletedAtToken: "tok",
    };

    expect(deserializeValue<DeleteRelationshipsArgs>(serializeValue(args)).optionalLimit).toBe(
      18446744073709551615n,
    );
    expect(deserializeValue<DeleteRelationshipsReply>(serializeValue(reply)).deletedCount).toBe(
      18446744073709551615n,
    );
  });

  it("keeps an absent optional limit absent, distinct from zero", () => {
    // `ulong? OptionalLimit`: absent means unbounded, 0 means "delete nothing".
    const unbounded: DeleteRelationshipsArgs = { filter: {} };
    const none: DeleteRelationshipsArgs = { filter: {}, optionalLimit: 0n };

    expect(
      deserializeValue<DeleteRelationshipsArgs>(serializeValue(unbounded)).optionalLimit,
    ).toBeUndefined();
    expect(deserializeValue<DeleteRelationshipsArgs>(serializeValue(none)).optionalLimit).toBe(0n);
  });

  it("keeps the read args' advisory limit a plain number", () => {
    // `int? Limit` stays `number`: it is a page size, not a revision or a count, and it can never
    // approach 2^53. Mixing the two widths in one file is the trap; the rule is per FIELD.
    const args: ReadRelationshipsArgs = { filter: {}, limit: 50 };

    expect(typeof args.limit).toBe("number");
    expect(deserializeValue<ReadRelationshipsArgs>(serializeValue(args)).limit).toBe(50);
    // Absent means "no advisory limit", which is not the same as 0.
    const unlimited: ReadRelationshipsArgs = { filter: {} };
    expect(unlimited.limit).toBeUndefined();
  });
});

describe("the default parameter values", () => {
  it("resolves RelationshipStreamItem's readAtToken to the empty string when absent", () => {
    // `string ReadAtToken = ""` is a DEFAULT PARAMETER, so the port makes the member optional and
    // resolves with `??` at a named resolver, never with a default baked into the type - that way
    // an explicitly supplied "" is indistinguishable from the default, exactly as in C#, and an
    // explicit value always survives.
    const bulkExport: RelationshipStreamItem = {
      relationship: aRelationship(),
      resumeCursor: "cursor",
    };
    const readWithToken: RelationshipStreamItem = {
      relationship: aRelationship(),
      resumeCursor: "cursor",
      readAtToken: "tok",
    };

    expect(relationshipStreamItemReadAtToken(bulkExport)).toBe("");
    expect(relationshipStreamItemReadAtToken(readWithToken)).toBe("tok");
    expect(bulkExport.readAtToken).toBeUndefined();
  });

  it("leaves an absent consistency absent, meaning minimize-latency at the resolver", () => {
    // `ConsistencyWire? Consistency = null` - the default IS null, so there is nothing to fill in
    // here; the read path interprets absence as minimize-latency.
    const args: ReadRelationshipsArgs = { filter: {} };

    expect(args.consistency).toBeUndefined();
  });

  it("leaves absent write preconditions absent, distinct from an empty list", () => {
    // `IReadOnlyList<PreconditionWire>? Preconditions = null`. Both states mean "no precondition
    // to check", but the C# keeps them distinct and so does the port.
    const args: DeleteRelationshipsArgs = { filter: {} };
    const withEmpty: DeleteRelationshipsArgs = { filter: {}, preconditions: [] };

    expect(args.preconditions).toBeUndefined();
    expect(withEmpty.preconditions).toEqual([]);
  });
});

describe("the empty replies", () => {
  it("exposes register/unregister counter replies as distinct frozen placeholders", () => {
    // Empty records used as proto placeholders. A bare empty `interface` is structurally
    // satisfied by EVERY object, so each gets a brand named after its own type - two brands
    // spelled the same would unify with each other, which is the exact mis-wiring the brand
    // exists to catch.
    expect(Object.isFrozen(REGISTER_COUNTER_REPLY)).toBe(true);
    expect(Object.isFrozen(UNREGISTER_COUNTER_REPLY)).toBe(true);
    expect(deserializeValue(serializeValue(REGISTER_COUNTER_REPLY))).toEqual({});
  });
});

describe("CounterOperationException", () => {
  const kinds: readonly CounterErrorKind[] = ["alreadyRegistered", "notRegistered"];

  it("distinguishes the two on-demand counter failures so the front door can pick a status", () => {
    expect(new Set(kinds).size).toBe(2);
  });

  it.each(["alreadyRegistered", "notRegistered"] as const)(
    "carries its kind and message as an Error subclass: %s",
    (kind) => {
      const error = new CounterOperationException(kind, "boom");

      expect(error).toBeInstanceOf(CounterOperationException);
      expect(error).toBeInstanceOf(Error);
      expect(error.kind).toBe(kind);
      expect(error.message).toBe("boom");
      expect(error.name).toBe("CounterOperationException");
    },
  );

  it("survives the grain boundary as itself, not as a plain Error", () => {
    // Orleans got this from `[GenerateSerializer]` on the exception type; Thresh needs an explicit
    // surrogate, or the caller receives a plain `Error`, cannot read `kind`, and the gRPC front
    // door can no longer choose between AlreadyExists and NotFound. The message is carried too:
    // unlike the datastore counter exceptions, it is NOT derivable from the kind.
    const original = new CounterOperationException("notRegistered", "counter `c` not found");

    const back = deserializeValue<CounterOperationException>(serializeValue(original));

    expect(back).toBeInstanceOf(CounterOperationException);
    expect(back.kind).toBe("notRegistered");
    expect(back.message).toBe("counter `c` not found");
  });
});

describe("RelationshipsFilterWire", () => {
  it("places no constraint where a field is absent", () => {
    // "Null/empty fields place no constraint" - so an all-absent filter is the match-everything
    // filter, and it must round-trip as all-absent rather than acquiring empty-string members.
    const everything: RelationshipsFilterWire = {};

    const back = deserializeValue<RelationshipsFilterWire>(serializeValue(everything));

    expect(back).toEqual({});
    expect(back.resourceType).toBeUndefined();
    expect(back.resourceIds).toBeUndefined();
  });

  it("round trips every constraint", () => {
    const filter: RelationshipsFilterWire = {
      resourceType: "doc",
      resourceIdPrefix: "pre",
      resourceIds: ["a", "b"],
      resourceRelation: "viewer",
      subjectType: "user",
      subjectIds: ["alice"],
      subjectRelation: "...",
    };

    expect(deserializeValue<RelationshipsFilterWire>(serializeValue(filter))).toEqual(filter);
  });
});

function aRelationship(): RelationshipWire {
  return {
    resourceType: "doc",
    resourceId: "1",
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: "...",
  };
}
