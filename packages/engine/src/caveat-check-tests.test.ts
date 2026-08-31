import type { ContextualizedCaveat } from "@benedb/core/contextualized-caveat";
import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import type { IDatastoreReader } from "@benedb/datastore/i-datastore";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import { compileSchema } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { CheckEngine } from "./check-engine";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/CaveatCheckTests.cs`, case for case.
//
// CheckEngineTests alone does not reach the caveat paths, so this file and
// `caveat-completeness-tests.test.ts` are part of the same batch: they are the only cover on
// `CheckEngine.collapse` and on the caveat threading through `LocalDispatcher`'s branch algebra.
//
// Two representation decisions from the layers beneath show up here:
//   * `evaluationTime` is a `bigint` of epoch NANOSECONDS (`clock.ts`), because
//     `Relationship.optionalExpiration` already is. A `Date` or epoch-millis would compare against
//     an incompatible representation.
//   * the caveat context is a `ReadonlyMap`, not a plain object, matching
//     `ContextualizedCaveat.context` and `CaveatEvaluator`'s request-context parameter.

const CAVEAT_SCHEMA = `
caveat over_age(age int, min_age int) {
  age >= min_age
}

caveat ip_allowlist(user_ip ipaddress, cidr string) {
  user_ip.in_cidr(cidr)
}

definition user {}

definition document {
  relation viewer: user with over_age
  relation ip_viewer: user with ip_allowlist
  permission view = viewer
  permission ip_view = ip_viewer
}
`;

const EXPIRATION_SCHEMA = `
use expiration

definition user {}

definition document {
  relation viewer: user with expiration
  permission view = viewer
}
`;

function buildEngine(schemaText: string): CheckEngine {
  const compiled = compileSchema(schemaText);
  return new CheckEngine(compiled.namespaces, compiled.caveats);
}

async function seed(...rels: readonly Relationship[]): Promise<IDatastoreReader> {
  const store = new ReferenceDatastore();
  const rev = await store.readWriteTx(async (tx) => {
    const updates: RelationshipUpdate[] = rels.map((r) => ({
      relationship: r,
      operation: "create",
    }));
    await tx.writeRelationships(updates);
  });
  return store.snapshotReader(rev);
}

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

function context(entries: readonly [string, unknown][]): ReadonlyMap<string, unknown> {
  return new Map(entries);
}

function caveated(
  resType: string,
  resId: string,
  resRel: string,
  subject: ObjectAndRelation,
  caveatName: string,
  ctx?: ReadonlyMap<string, unknown> | undefined,
  expiration?: bigint | undefined,
): Relationship {
  const caveat: ContextualizedCaveat = { caveatName, context: ctx };
  return createRelationship(onr(resType, resId, resRel), subject, caveat, expiration);
}

describe("CheckEngine caveats", () => {
  it("is a member when the caveat is true under the request context", async () => {
    const reader = await seed(
      caveated(
        "document",
        "doc1",
        "viewer",
        onr("user", "alice"),
        "over_age",
        context([["min_age", 18]]),
      ),
    );
    const engine = buildEngine(CAVEAT_SCHEMA);

    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "view",
      onr("user", "alice"),
      context([["age", 21]]),
    );

    expect(result.verdict).toBe("member");
  });

  it("is not a member when the caveat is false under the request context", async () => {
    const reader = await seed(
      caveated(
        "document",
        "doc1",
        "viewer",
        onr("user", "alice"),
        "over_age",
        context([["min_age", 18]]),
      ),
    );
    const engine = buildEngine(CAVEAT_SCHEMA);

    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "view",
      onr("user", "alice"),
      context([["age", 16]]),
    );

    expect(result.verdict).toBe("notMember");
  });

  it("is caveated with the missing field when context is absent", async () => {
    const reader = await seed(
      caveated(
        "document",
        "doc1",
        "viewer",
        onr("user", "alice"),
        "over_age",
        context([["min_age", 18]]),
      ),
    );
    const engine = buildEngine(CAVEAT_SCHEMA);

    // No "age" supplied at request time and none on the tuple.
    const result = await engine.check(reader, "document", "doc1", "view", onr("user", "alice"));

    expect(result.verdict).toBe("caveated");
    expect(result.missingExprFields).toContain("age");
  });

  it("lets relationship context override request context", async () => {
    // SpiceDB precedence: context written on the relationship takes priority over context
    // supplied at check time. Relationship pins min_age=99; the request's min_age=18 is
    // ignored, so age=21 >= 99 is false -> not a member.
    const reader = await seed(
      caveated(
        "document",
        "doc1",
        "viewer",
        onr("user", "alice"),
        "over_age",
        context([["min_age", 99]]),
      ),
    );
    const engine = buildEngine(CAVEAT_SCHEMA);

    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "view",
      onr("user", "alice"),
      context([
        ["age", 21],
        ["min_age", 18],
      ]),
    );

    expect(result.verdict).toBe("notMember");
  });

  it("is a member for an in_cidr caveat inside the network", async () => {
    const reader = await seed(
      caveated(
        "document",
        "doc1",
        "ip_viewer",
        onr("user", "alice"),
        "ip_allowlist",
        context([["cidr", "10.0.0.0/8"]]),
      ),
    );
    const engine = buildEngine(CAVEAT_SCHEMA);

    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "ip_view",
      onr("user", "alice"),
      context([["user_ip", "10.1.2.3"]]),
    );

    expect(result.verdict).toBe("member");
  });

  it("is not a member for an in_cidr caveat outside the network", async () => {
    const reader = await seed(
      caveated(
        "document",
        "doc1",
        "ip_viewer",
        onr("user", "alice"),
        "ip_allowlist",
        context([["cidr", "10.0.0.0/8"]]),
      ),
    );
    const engine = buildEngine(CAVEAT_SCHEMA);

    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "ip_view",
      onr("user", "alice"),
      context([["user_ip", "192.168.1.1"]]),
    );

    expect(result.verdict).toBe("notMember");
  });
});

// The snapshot reader pre-filters expiry against the real current time. To exercise the ENGINE's
// own pinned-clock filtering (rather than the datastore's), these tests use an expiry far in the
// future so the datastore keeps the tuple, then pin the engine clock on either side of it.
const FAR_FUTURE_EXPIRY_NANOS = BigInt(Date.UTC(2099, 0, 1)) * 1_000_000n;

function epochNanos(year: number, monthIndex: number, day: number): bigint {
  return BigInt(Date.UTC(year, monthIndex, day)) * 1_000_000n;
}

describe("CheckEngine expiration", () => {
  it("is a member when the pinned clock is before the expiry", async () => {
    const reader = await seed(
      createRelationship(
        onr("document", "doc1", "viewer"),
        onr("user", "alice"),
        undefined,
        FAR_FUTURE_EXPIRY_NANOS,
      ),
    );
    const engine = buildEngine(EXPIRATION_SCHEMA);

    // now is before expiry -> relationship is live.
    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "view",
      onr("user", "alice"),
      undefined,
      epochNanos(2030, 5, 1),
    );

    expect(result.verdict).toBe("member");
  });

  it("is not a member when the pinned clock is after the expiry", async () => {
    const reader = await seed(
      createRelationship(
        onr("document", "doc1", "viewer"),
        onr("user", "alice"),
        undefined,
        FAR_FUTURE_EXPIRY_NANOS,
      ),
    );
    const engine = buildEngine(EXPIRATION_SCHEMA);

    // now is after expiry -> relationship is filtered (absent) by the engine clock.
    const result = await engine.check(
      reader,
      "document",
      "doc1",
      "view",
      onr("user", "alice"),
      undefined,
      epochNanos(2100, 5, 1),
    );

    expect(result.verdict).toBe("notMember");
  });
});
