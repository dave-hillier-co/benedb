import { status } from "@grpc/grpc-js";
import {
  ContextualizedCaveat,
  Relationship,
  RelationshipUpdate,
  RelationshipUpdate_Operation,
} from "@benedb/protos/authzed/api/v1/core";
import {
  Precondition,
  Precondition_Operation,
  WriteRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { Struct } from "@benedb/protos/google/protobuf/struct";
import { describe, expect, it } from "vitest";

import {
  MAX_CAVEAT_CONTEXT_SIZE,
  MAX_PRECONDITIONS_COUNT,
  MAX_RELATIONSHIP_CONTEXT_SIZE,
  MAX_UPDATES_PER_WRITE,
  validateCaveatContextSize,
  validateWriteRelationships,
} from "./request-limits";
import { RpcError } from "./rpc-error";

/**
 * Characterization test for `src/Spiceport.Api/RequestLimits.cs`.
 *
 * The C# has NO direct suite: `AuthzedPermissionsV1ServiceTests.cs` touches only two of its paths
 * (line 487 "too many updates", line 539 "exceeded maximum allowed caveat size"), leaving the
 * precondition count, the duplicate-relationship key and `ValidateCaveatContextSize` untested. So
 * these cases pin the exact message strings and the exact boundaries (size == limit passes,
 * limit + 1 fails) that a client such as `zed` observes on the wire.
 *
 * The sizes are SERIALIZED protobuf byte lengths (C# `CalculateSize()`), never string lengths,
 * so the fixtures below build a message and measure it rather than counting characters.
 */

function relationship(options: {
  resourceType?: string;
  resourceId?: string;
  relation?: string;
  subjectType?: string;
  subjectId?: string;
  subjectRelation?: string;
  caveat?: ContextualizedCaveat;
  expiresAt?: Date;
}): Relationship {
  return Relationship.fromPartial({
    resource: {
      objectType: options.resourceType ?? "document",
      objectId: options.resourceId ?? "firstdoc",
    },
    relation: options.relation ?? "viewer",
    subject: {
      object: {
        objectType: options.subjectType ?? "user",
        objectId: options.subjectId ?? "alice",
      },
      optionalRelation: options.subjectRelation ?? "",
    },
    optionalCaveat: options.caveat,
    optionalExpiresAt: options.expiresAt,
  });
}

function update(
  rel: Relationship,
  operation: RelationshipUpdate_Operation = RelationshipUpdate_Operation.OPERATION_CREATE,
): RelationshipUpdate {
  return RelationshipUpdate.fromPartial({ operation, relationship: rel });
}

function request(
  updates: readonly RelationshipUpdate[],
  preconditions: readonly Precondition[] = [],
): WriteRelationshipsRequest {
  return WriteRelationshipsRequest.fromPartial({
    updates: [...updates],
    optionalPreconditions: [...preconditions],
  });
}

function precondition(): Precondition {
  return Precondition.fromPartial({
    operation: Precondition_Operation.OPERATION_MUST_MATCH,
    filter: { resourceType: "document" },
  });
}

/** Serialized size of a caveat context, exactly as C# `Struct.CalculateSize()` computes it. */
function structSize(context: Record<string, unknown>): number {
  return Struct.encode(Struct.wrap(context)).finish().length;
}

/** Serialized size of a whole caveat message, exactly as C# `ContextualizedCaveat.CalculateSize()`. */
function caveatSize(caveat: ContextualizedCaveat): number {
  return ContextualizedCaveat.encode(caveat).finish().length;
}

/** A context whose serialized size is exactly `target` bytes. */
function contextOfSize(target: number): Record<string, unknown> {
  let padding = target;
  for (let attempt = 0; attempt < 64; attempt++) {
    const context = { k: "x".repeat(padding) };
    const size = structSize(context);
    if (size === target) return context;
    padding += target - size;
    if (padding < 0) break;
  }
  throw new Error(`could not build a context of exactly ${target} serialized bytes`);
}

/** A caveat whose whole serialized size (name field included) is exactly `target` bytes. */
function caveatOfSize(target: number, caveatName = "somecaveat"): ContextualizedCaveat {
  let padding = target;
  for (let attempt = 0; attempt < 64; attempt++) {
    const caveat = ContextualizedCaveat.fromPartial({
      caveatName,
      context: { k: "x".repeat(padding) },
    });
    const size = caveatSize(caveat);
    if (size === target) return caveat;
    padding += target - size;
    if (padding < 0) break;
  }
  throw new Error(`could not build a caveat of exactly ${target} serialized bytes`);
}

function expectRpcError(act: () => unknown): RpcError {
  try {
    act();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(RpcError);
    return thrown as RpcError;
  }
  throw new Error("expected an RpcError to be thrown, but nothing was thrown");
}

describe("RequestLimits constants", () => {
  it("are SpiceDB's defaults", () => {
    expect(MAX_UPDATES_PER_WRITE).toBe(1000);
    expect(MAX_PRECONDITIONS_COUNT).toBe(1000);
    expect(MAX_RELATIONSHIP_CONTEXT_SIZE).toBe(25_000);
    expect(MAX_CAVEAT_CONTEXT_SIZE).toBe(4096);
  });
});

describe("validateWriteRelationships", () => {
  it("accepts an empty request", () => {
    expect(() => validateWriteRelationships(request([]))).not.toThrow();
  });

  it("accepts a request of distinct, uncaveated relationships", () => {
    expect(() =>
      validateWriteRelationships(
        request([
          update(relationship({ resourceId: "firstdoc" })),
          update(relationship({ resourceId: "seconddoc" })),
          update(relationship({ relation: "editor" })),
          update(relationship({ subjectId: "bob" })),
          update(relationship({ subjectType: "serviceaccount" })),
          update(relationship({ resourceType: "folder" })),
          update(relationship({ subjectRelation: "member" })),
        ]),
      ),
    ).not.toThrow();
  });

  describe("update count", () => {
    const distinctUpdates = (count: number): RelationshipUpdate[] =>
      Array.from({ length: count }, (_unused, index) =>
        update(relationship({ resourceId: `doc${index}` })),
      );

    it("accepts exactly the maximum", () => {
      expect(() =>
        validateWriteRelationships(request(distinctUpdates(MAX_UPDATES_PER_WRITE))),
      ).not.toThrow();
    });

    it("rejects one over the maximum with InvalidArgument and SpiceDB's message", () => {
      const error = expectRpcError(() =>
        validateWriteRelationships(request(distinctUpdates(MAX_UPDATES_PER_WRITE + 1))),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe(
        "too many updates (1001) for WriteRelationships call (maximum: 1000); " +
          "consider using ImportBulkRelationships API instead",
      );
    });

    it("reports the actual count, not the limit", () => {
      const error = expectRpcError(() =>
        validateWriteRelationships(request(distinctUpdates(MAX_UPDATES_PER_WRITE + 7))),
      );

      expect(error.details).toContain("too many updates (1007)");
    });
  });

  describe("precondition count", () => {
    const preconditions = (count: number): Precondition[] =>
      Array.from({ length: count }, () => precondition());

    it("accepts exactly the maximum", () => {
      expect(() =>
        validateWriteRelationships(request([], preconditions(MAX_PRECONDITIONS_COUNT))),
      ).not.toThrow();
    });

    it("rejects one over the maximum with InvalidArgument and SpiceDB's message", () => {
      const error = expectRpcError(() =>
        validateWriteRelationships(request([], preconditions(MAX_PRECONDITIONS_COUNT + 1))),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe(
        "precondition count of 1001 is greater than maximum allowed of 1000",
      );
    });

    it("is checked after the update count, so an over-limit request reports the updates first", () => {
      const tooManyUpdates = Array.from({ length: MAX_UPDATES_PER_WRITE + 1 }, (_unused, index) =>
        update(relationship({ resourceId: `doc${index}` })),
      );

      const error = expectRpcError(() =>
        validateWriteRelationships(
          request(tooManyUpdates, preconditions(MAX_PRECONDITIONS_COUNT + 1)),
        ),
      );

      expect(error.details).toContain("too many updates");
    });

    it("is checked before the per-update duplicate scan", () => {
      const duplicates = [update(relationship({})), update(relationship({}))];

      const error = expectRpcError(() =>
        validateWriteRelationships(request(duplicates, preconditions(MAX_PRECONDITIONS_COUNT + 1))),
      );

      expect(error.details).toContain("precondition count of 1001");
    });
  });

  describe("duplicate relationships", () => {
    it("rejects the same relationship twice, echoing the key verbatim", () => {
      const error = expectRpcError(() =>
        validateWriteRelationships(request([update(relationship({})), update(relationship({}))])),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe(
        "found more than one update with relationship `document:firstdoc#viewer@user:alice` " +
          "in this request; a relationship can only be specified in an update once per overall " +
          "WriteRelationships request",
      );
    });

    it("includes a subject relation in the key after a `#`", () => {
      const rel = relationship({
        subjectType: "group",
        subjectId: "eng",
        subjectRelation: "member",
      });

      const error = expectRpcError(() =>
        validateWriteRelationships(request([update(rel), update(rel)])),
      );

      expect(error.details).toContain(
        "relationship `document:firstdoc#viewer@group:eng#member` in this request",
      );
    });

    it("omits the `#` entirely when the subject relation is unset", () => {
      const error = expectRpcError(() =>
        validateWriteRelationships(request([update(relationship({})), update(relationship({}))])),
      );

      expect(error.details).toContain("@user:alice` in this request");
      expect(error.details).not.toContain("@user:alice#");
    });

    it("treats a CREATE and a DELETE of the same tuple as a duplicate", () => {
      const error = expectRpcError(() =>
        validateWriteRelationships(
          request([
            update(relationship({}), RelationshipUpdate_Operation.OPERATION_CREATE),
            update(relationship({}), RelationshipUpdate_Operation.OPERATION_DELETE),
          ]),
        ),
      );

      expect(error.details).toContain("found more than one update with relationship");
    });

    it("ignores the caveat when keying, so two differently-caveated writes collide", () => {
      const error = expectRpcError(() =>
        validateWriteRelationships(
          request([
            update(
              relationship({
                caveat: ContextualizedCaveat.fromPartial({
                  caveatName: "first",
                  context: { a: 1 },
                }),
              }),
            ),
            update(
              relationship({
                caveat: ContextualizedCaveat.fromPartial({ caveatName: "second" }),
              }),
            ),
          ]),
        ),
      );

      expect(error.details).toContain("found more than one update with relationship");
    });

    it("ignores the expiration when keying", () => {
      const error = expectRpcError(() =>
        validateWriteRelationships(
          request([
            update(relationship({ expiresAt: new Date("2030-01-01T00:00:00Z") })),
            update(relationship({ expiresAt: new Date("2031-01-01T00:00:00Z") })),
          ]),
        ),
      );

      expect(error.details).toContain("found more than one update with relationship");
    });

    it("distinguishes on every field the key does include", () => {
      const base = relationship({});
      const variants = [
        relationship({ resourceType: "folder" }),
        relationship({ resourceId: "seconddoc" }),
        relationship({ relation: "editor" }),
        relationship({ subjectType: "serviceaccount" }),
        relationship({ subjectId: "bob" }),
        relationship({ subjectRelation: "member" }),
      ];

      for (const variant of variants) {
        expect(() =>
          validateWriteRelationships(request([update(base), update(variant)])),
        ).not.toThrow();
      }
    });

    it("compares keys ordinally: case differences are distinct relationships", () => {
      expect(() =>
        validateWriteRelationships(
          request([
            update(relationship({ resourceId: "firstdoc" })),
            update(relationship({ resourceId: "FirstDoc" })),
          ]),
        ),
      ).not.toThrow();
    });

    it("compares keys ordinally: Unicode is not normalized", () => {
      expect(() =>
        validateWriteRelationships(
          request([
            update(relationship({ resourceId: "caf\u00e9" })), // e-acute as one code point
            update(relationship({ resourceId: "cafe\u0301" })), // "e" + combining acute
          ]),
        ),
      ).not.toThrow();
    });

    it("reports the duplicate before the oversized caveat on the same update", () => {
      const oversized = relationship({ caveat: caveatOfSize(MAX_RELATIONSHIP_CONTEXT_SIZE + 1) });

      const error = expectRpcError(() =>
        validateWriteRelationships(request([update(relationship({})), update(oversized)])),
      );

      expect(error.details).toContain("found more than one update with relationship");
    });
  });

  describe("per-relationship caveat size", () => {
    it("allows a relationship with no caveat at all (size 0)", () => {
      expect(() => validateWriteRelationships(request([update(relationship({}))]))).not.toThrow();
    });

    it("accepts a caveat of exactly the maximum serialized size", () => {
      const caveat = caveatOfSize(MAX_RELATIONSHIP_CONTEXT_SIZE);
      expect(caveatSize(caveat)).toBe(MAX_RELATIONSHIP_CONTEXT_SIZE);

      expect(() =>
        validateWriteRelationships(request([update(relationship({ caveat }))])),
      ).not.toThrow();
    });

    it("rejects one byte over, with InvalidArgument and the key in the message", () => {
      const caveat = caveatOfSize(MAX_RELATIONSHIP_CONTEXT_SIZE + 1);

      const error = expectRpcError(() =>
        validateWriteRelationships(request([update(relationship({ caveat }))])),
      );

      expect(error.code).toBe(status.INVALID_ARGUMENT);
      expect(error.details).toBe(
        "provided relationship `document:firstdoc#viewer@user:alice` " +
          "exceeded maximum allowed caveat size of 25000",
      );
    });

    it("sizes the WHOLE caveat message, so the caveat name counts toward the limit", () => {
      // A caveat whose CONTEXT alone is comfortably under the limit but whose message — name field
      // included — is over it. C# sizes `OptionalCaveat`, not `OptionalCaveat.Context`; reproduce
      // that rather than "fixing" it to the context alone.
      const caveat = caveatOfSize(MAX_RELATIONSHIP_CONTEXT_SIZE + 1, "a".repeat(500));
      expect(structSize(caveat.context ?? {})).toBeLessThan(MAX_RELATIONSHIP_CONTEXT_SIZE);

      const error = expectRpcError(() =>
        validateWriteRelationships(request([update(relationship({ caveat }))])),
      );

      expect(error.details).toContain("exceeded maximum allowed caveat size of 25000");
    });

    it("checks every update, not only the first", () => {
      const caveat = caveatOfSize(MAX_RELATIONSHIP_CONTEXT_SIZE + 1);

      const error = expectRpcError(() =>
        validateWriteRelationships(
          request([
            update(relationship({ resourceId: "firstdoc" })),
            update(relationship({ resourceId: "seconddoc", caveat })),
          ]),
        ),
      );

      expect(error.details).toContain("`document:seconddoc#viewer@user:alice`");
    });
  });
});

describe("validateCaveatContextSize", () => {
  it("returns undefined for an absent context, without throwing", () => {
    expect(validateCaveatContextSize(undefined)).toBeUndefined();
  });

  it("returns the context unchanged, for fluent use at the call site", () => {
    const context = { answer: 42 };

    expect(validateCaveatContextSize(context)).toBe(context);
  });

  it("accepts an empty context", () => {
    const context = {};

    expect(validateCaveatContextSize(context)).toBe(context);
  });

  it("accepts a context of exactly the maximum serialized size", () => {
    const context = contextOfSize(MAX_CAVEAT_CONTEXT_SIZE);
    expect(structSize(context)).toBe(MAX_CAVEAT_CONTEXT_SIZE);

    expect(validateCaveatContextSize(context)).toBe(context);
  });

  it("rejects one byte over, reporting both the limit and the actual size", () => {
    const context = contextOfSize(MAX_CAVEAT_CONTEXT_SIZE + 1);

    const error = expectRpcError(() => validateCaveatContextSize(context));

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe(
      "request caveat context should have less than 4096 bytes but had 4097",
    );
  });

  it("reports the actual size, not the limit, for a much larger context", () => {
    const context = contextOfSize(MAX_CAVEAT_CONTEXT_SIZE + 100);

    const error = expectRpcError(() => validateCaveatContextSize(context));

    expect(error.details).toBe(
      "request caveat context should have less than 4096 bytes but had 4196",
    );
  });

  it("measures serialized bytes, not characters: a multi-byte value counts its UTF-8 length", () => {
    // Well under the limit as UTF-16 characters, over it once encoded as UTF-8.
    const context = { k: "\u00e9".repeat(2100) };
    expect(JSON.stringify(context).length).toBeLessThan(MAX_CAVEAT_CONTEXT_SIZE);
    expect(structSize(context)).toBeGreaterThan(MAX_CAVEAT_CONTEXT_SIZE);

    const error = expectRpcError(() => validateCaveatContextSize(context));

    expect(error.code).toBe(status.INVALID_ARGUMENT);
  });
});
