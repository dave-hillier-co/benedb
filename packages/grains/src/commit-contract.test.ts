import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import type {
  CommitFailureKind,
  CommitFailureWire,
  CommitPreconditionWire,
  CommitReply,
  CommitRequest,
  DeleteByFilterWire,
} from "./commit-contract";
import type { FullRelationshipsFilterWire } from "./datastore-dtos";
import type { RelationshipUpdateWire, RelationshipWire } from "./relationships-dtos";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/CommitContract.cs`.
//
// NO COVERING TEST IN THIS SLICE. `CommitContractTests` drives a real grain mesh (MeshTestCluster +
// IDatastoreGrain), so it belongs with `DatastoreGrain` in a later slice; it is deliberately not
// ported here, and no grain is stubbed to make it run. What is left to pin is the contract's own
// shape - and every assertion below is about a distinction the C# nullability makes that a careless
// port would erase.
describe("the CommitRequest CAS discriminant", () => {
  const filter: FullRelationshipsFilterWire = {
    optionalResourceType: "doc",
    optionalExpirationOption: 0,
  };
  const rel: RelationshipWire = {
    resourceType: "doc",
    resourceId: "1",
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: "...",
  };
  const touch: RelationshipUpdateWire = { operation: "touch", relationship: rel };

  const declarative: CommitRequest = {
    preconditions: [],
    updates: [touch],
    counterChanges: [],
  };

  it("means a DECLARATIVE commit when expectedHead is absent", () => {
    // The null-versus-present distinction IS the semantic switch: absent means the sequencer
    // serializes the commit unconditionally (no caller-side retry loop), and each counter delta is
    // a GUARDED intent. It must never be defaulted to a revision.
    const back = deserializeValue<CommitRequest>(serializeValue(declarative));

    expect(back.expectedHead).toBeUndefined();
  });

  it("means the CAS compatibility path when expectedHead is present, zero included", () => {
    // 0 is a legal head (a freshly seeded store), so `expectedHead: 0n` must survive as a CAS and
    // not collapse into "no CAS requested".
    const cas: CommitRequest = { ...declarative, expectedHead: 0n };

    const back = deserializeValue<CommitRequest>(serializeValue(cas));

    expect(back.expectedHead).toBe(0n);
    expect(typeof back.expectedHead).toBe("bigint");
  });

  it("carries schema bytes as an optional Uint8Array, absent meaning 'no schema written'", () => {
    const withSchema: CommitRequest = {
      ...declarative,
      schemaBytes: new TextEncoder().encode("definition doc {}"),
    };

    expect(
      deserializeValue<CommitRequest>(serializeValue(declarative)).schemaBytes,
    ).toBeUndefined();
    expect(withSchema.schemaBytes).toBeInstanceOf(Uint8Array);
  });

  it("conflates an absent and an empty expected schema hash, exactly as the C# does", () => {
    // "A null current hash (the pre-first-schema seed window) matches only a null/empty expected
    // hash." That conflation is the C#'s own deliberate choice, so it is kept rather than
    // corrected by the absent-versus-empty rule the port applies everywhere else.
    const absent: CommitRequest = { ...declarative };
    const empty: CommitRequest = { ...declarative, expectedSchemaHash: "" };

    expect((absent.expectedSchemaHash ?? "") === "").toBe(true);
    expect((empty.expectedSchemaHash ?? "") === "").toBe(true);
    // A real hash is a third, distinct state.
    expect(({ ...declarative, expectedSchemaHash: "h1" }.expectedSchemaHash ?? "") === "").toBe(
      false,
    );
  });

  it("carries an optional bulk delete whose limit is an optional bigint", () => {
    // `ulong? Limit`: absent means unbounded, and the count it reports is a `ulong` too, so both
    // are bigints. `number` would silently round a large deletion count.
    const unbounded: DeleteByFilterWire = { filter };
    const limited: DeleteByFilterWire = { filter, limit: 18446744073709551615n };

    expect(deserializeValue<DeleteByFilterWire>(serializeValue(unbounded)).limit).toBeUndefined();
    expect(deserializeValue<DeleteByFilterWire>(serializeValue(limited)).limit).toBe(
      18446744073709551615n,
    );
  });

  it("carries preconditions in request order, each an existence-only probe", () => {
    const preconditions: readonly CommitPreconditionWire[] = [
      { filter, mustMatch: true },
      { filter, mustMatch: false },
    ];
    const request: CommitRequest = { ...declarative, preconditions };

    const back = deserializeValue<CommitRequest>(serializeValue(request));

    // Order is observable: they are evaluated in request order BEFORE any mutation, and the first
    // failure is the one reported.
    expect(back.preconditions.map((p) => p.mustMatch)).toEqual([true, false]);
  });

  it("round trips a fully populated request", () => {
    const request: CommitRequest = {
      preconditions: [{ filter, mustMatch: true }],
      updates: [touch, { operation: "delete", relationship: rel }],
      deleteByFilter: { filter, limit: 10n },
      schemaBytes: new TextEncoder().encode("definition doc {}"),
      expectedSchemaHash: "h1",
      counterChanges: [{ name: "c1", filter }, { name: "c2" }],
      expectedHead: 99n,
    };

    const back = deserializeValue<CommitRequest>(serializeValue(request));

    expect(back.updates.map((u) => u.operation)).toEqual(["touch", "delete"]);
    expect(back.deleteByFilter?.limit).toBe(10n);
    expect(back.expectedSchemaHash).toBe("h1");
    expect(back.expectedHead).toBe(99n);
    expect(back.counterChanges[1]?.filter).toBeUndefined();
  });
});

// The six failure kinds are load-bearing DOCUMENTATION as well as data: each names the specific
// client-side rethrow the caller performs, and getting one wrong changes the gRPC status a client
// sees. Recorded here so a rename cannot happen silently.
describe("CommitFailureKind", () => {
  const kinds: readonly CommitFailureKind[] = [
    "headMoved",
    "schemaHashMoved",
    "preconditionFailed",
    "createAlreadyExists",
    "counterAlreadyRegistered",
    "counterNotRegistered",
  ];

  it("has exactly the six kinds the client's rethrow table covers", () => {
    expect(new Set(kinds).size).toBe(6);
  });

  it.each(kinds)("round trips %s as reply DATA, never as a serialized exception", (kind) => {
    // Failures cross the boundary as structured reply data so the client rethrows the exact typed
    // exception its write surface already throws, preserving every gRPC status mapping.
    const failure: CommitFailureWire = { kind, detail: "detail" };

    expect(deserializeValue<CommitFailureWire>(serializeValue(failure))).toEqual(failure);
  });

  it("allows an absent detail: not every kind carries one", () => {
    // `headMoved` / `schemaHashMoved` need no detail (the caller retries the CAS); the other four
    // carry the constructor argument of the exception they become.
    const back = deserializeValue<CommitFailureWire>(serializeValue({ kind: "headMoved" }));

    expect(back.detail).toBeUndefined();
  });
});

describe("CommitReply", () => {
  it("reports a minted revision and no failure on success", () => {
    const reply: CommitReply = { revision: 1000n, deletedCount: 0n, reachedLimit: false };

    const back = deserializeValue<CommitReply>(serializeValue(reply));

    expect(back.revision).toBe(1000n);
    expect(back.failure).toBeUndefined();
    expect(back.deletedCount).toBe(0n);
    expect(back.reachedLimit).toBe(false);
  });

  it("reports no revision and a failure on rejection: the whole request is atomic", () => {
    const reply: CommitReply = {
      failure: { kind: "preconditionFailed", detail: "unable to satisfy write precondition" },
      deletedCount: 0n,
      reachedLimit: false,
    };

    const back = deserializeValue<CommitReply>(serializeValue(reply));

    expect(back.revision).toBeUndefined();
    expect(back.failure?.kind).toBe("preconditionFailed");
  });

  it("counts deletions as a bigint, reporting 0/false when no delete-by-filter was requested", () => {
    const reply: CommitReply = {
      revision: 1n,
      deletedCount: 18446744073709551615n,
      reachedLimit: true,
    };

    const back = deserializeValue<CommitReply>(serializeValue(reply));

    expect(back.deletedCount).toBe(18446744073709551615n);
    expect(typeof back.deletedCount).toBe("bigint");
    expect(back.reachedLimit).toBe(true);
  });
});
