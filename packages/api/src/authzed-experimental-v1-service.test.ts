import { status } from "@grpc/grpc-js";
import {
  IRelationshipsGrain as IRelationshipsGrainDefinition,
  RELATIONSHIPS_GRAIN_KEY,
} from "@benedb/grains/i-relationships-grain";
import { MutableSchemaProvider } from "@benedb/grains/i-schema-provider";
import type {
  CountRelationshipsArgs,
  CountRelationshipsReply,
  RegisterCounterArgs,
  RegisterCounterReply,
  UnregisterCounterArgs,
  UnregisterCounterReply,
} from "@benedb/grains/relationships-dtos";
import {
  CounterOperationException,
  REGISTER_COUNTER_REPLY,
  UNREGISTER_COUNTER_REPLY,
} from "@benedb/grains/relationships-dtos";
import { SequencerOverloadedException } from "@benedb/grains/sequencer-overloaded-exception";
import type { RelationshipFilter } from "@benedb/protos/authzed/api/v1/permission_service";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { describe, expect, it } from "vitest";

import { AuthzedExperimentalV1Service } from "./authzed-experimental-v1-service";
import { RpcError } from "./rpc-error";

/**
 * Characterization test for `src/Spiceport.Api/AuthzedExperimentalV1Service.cs` - the three
 * relationship-counter RPCs of the `authzed.api.v1` ExperimentalService.
 *
 * SCOPE, deliberately. `tests/Spiceport.Grains.Tests/AuthzedExperimentalV1ServiceTests.cs` drives
 * this file over a live `MeshTestCluster` (register-then-count, the count tracking subsequent
 * matching / non-matching writes, unregister-then-count, and re-registering a live name) and is
 * stage S5b's to port; none of its cases is restated here. What a live mesh cannot easily produce,
 * and what this file pins instead, is the proto <-> wire TRANSLATION, the up-front guard, the
 * uint64 rendering, and the full error table - over a fake `IRelationshipsGrain`.
 *
 * Reading notes for the C# this pins:
 *   * `request.RelationshipFilter is null` -> INVALID_ARGUMENT "relationship_filter is required",
 *     on Register ONLY. Unregister and Count have no such guard.
 *   * BOTH counter failures - `alreadyRegistered` AND `notRegistered` - map to FAILED_PRECONDITION,
 *     deliberately matching SpiceDB's `internal/services/shared/errors.go`. The kind discriminator
 *     the ported `CounterOperationException` carries is NOT used to split them.
 *   * ASYMMETRY, reproduced: Register and Unregister catch `SequencerOverloadedException` ->
 *     RESOURCE_EXHAUSTED; `ExperimentalCountRelationships` does NOT (it is a read, never admitted
 *     through the gate), so an overload escapes that RPC unwrapped.
 *   * The response ALWAYS carries the `read_counter_value` arm and NEVER
 *     `counter_still_calculating`: counts are computed on demand.
 *   * `ToWire` here is a LOCAL function that differs from the permissions service's namesake: it
 *     wraps the single `optional_resource_id` into a one-element list and likewise the single
 *     `optional_subject_id`, and reaches `optional_relation` through two levels of nesting. The C#
 *     maintains the two copies separately and so does the port.
 *   * `ISchemaProvider` is injected and STORED BUT NEVER USED (line 24), only to mirror the sibling
 *     constructor pattern. The parameter stays.
 *
 * Port decisions this file also pins, because the C# construct has no TypeScript counterpart:
 *   * `RpcException(new Status(code, detail))` becomes {@link RpcError}.
 *   * `ServerCallContext` becomes a trailing optional `signal`; the C# reads nothing off it here.
 *   * `RelationshipCount` is uint64: the grains DTO carries a `bigint` and ts-proto renders the
 *     field as a STRING (`forceLong=string`), so it is `String(reply.count)` and never a JS
 *     `number`, which would round past 2^53.
 *   * An absent submessage is `undefined`, not `null`, so the Register guard is `=== undefined`.
 */

const SCHEMA = "definition user {}";

// ---------------------------------------------------------------- fakes

class FakeRelationshipsGrain {
  readonly registerArgs: RegisterCounterArgs[] = [];
  readonly unregisterArgs: UnregisterCounterArgs[] = [];
  readonly countArgs: CountRelationshipsArgs[] = [];

  countReply: CountRelationshipsReply = { count: 2n, readAtToken: "count-token" };
  registerThrows: unknown;
  unregisterThrows: unknown;
  countThrows: unknown;

  async registerRelationshipCounter(args: RegisterCounterArgs): Promise<RegisterCounterReply> {
    this.registerArgs.push(args);
    if (this.registerThrows !== undefined) throw this.registerThrows;
    return REGISTER_COUNTER_REPLY;
  }

  async unregisterRelationshipCounter(
    args: UnregisterCounterArgs,
  ): Promise<UnregisterCounterReply> {
    this.unregisterArgs.push(args);
    if (this.unregisterThrows !== undefined) throw this.unregisterThrows;
    return UNREGISTER_COUNTER_REPLY;
  }

  async countRelationships(args: CountRelationshipsArgs): Promise<CountRelationshipsReply> {
    this.countArgs.push(args);
    if (this.countThrows !== undefined) throw this.countThrows;
    return this.countReply;
  }
}

interface GrainLookup {
  readonly definition: GrainInterface<unknown>;
  readonly key: unknown;
}

class FakeGrainFactory implements GrainFactoryAccess {
  readonly lookups: GrainLookup[] = [];

  constructor(private readonly grain: FakeRelationshipsGrain) {}

  getGrain<T>(definition: GrainInterface<T>, key: unknown): T {
    this.lookups.push({ definition: definition as GrainInterface<unknown>, key });
    return this.grain as unknown as T;
  }

  createObjectReference<T>(): T {
    throw new Error("not supported");
  }

  deleteObjectReference(): void {
    throw new Error("not supported");
  }
}

interface Harness {
  readonly service: AuthzedExperimentalV1Service;
  readonly grain: FakeRelationshipsGrain;
  readonly grains: FakeGrainFactory;
  readonly schema: MutableSchemaProvider;
}

function harness(): Harness {
  const grain = new FakeRelationshipsGrain();
  const grains = new FakeGrainFactory(grain);
  const schema = new MutableSchemaProvider(SCHEMA);
  const service = new AuthzedExperimentalV1Service(grains, schema);
  return { service, grain, grains, schema };
}

// ---------------------------------------------------------------- fixtures

function filter(overrides: Partial<RelationshipFilter> = {}): RelationshipFilter {
  return {
    resourceType: "document",
    optionalResourceId: "",
    optionalResourceIdPrefix: "",
    optionalRelation: "viewer",
    ...overrides,
  };
}

async function rpcErrorFrom(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(RpcError);
    return thrown as RpcError;
  }
  throw new Error("expected an RpcError, but the call succeeded");
}

// ---------------------------------------------------------------- register

describe("experimentalRegisterRelationshipCounter", () => {
  it("routes to the relationships grain under the fixed key and returns an EMPTY response", async () => {
    const h = harness();

    const response = await h.service.experimentalRegisterRelationshipCounter({
      name: "doc_viewers",
      relationshipFilter: filter(),
    });

    expect(response).toEqual({});
    expect(h.grains.lookups).toEqual([
      { definition: IRelationshipsGrainDefinition, key: RELATIONSHIPS_GRAIN_KEY },
    ]);
    expect(h.grain.registerArgs[0]?.name).toBe("doc_viewers");
  });

  it("rejects an ABSENT relationship_filter with INVALID_ARGUMENT, before touching the grain", async () => {
    const h = harness();

    const error = await rpcErrorFrom(
      h.service.experimentalRegisterRelationshipCounter({ name: "doc_viewers" }),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("relationship_filter is required");
    expect(h.grain.registerArgs).toEqual([]);
  });

  it("translates the v1 filter to the grain wire, wrapping the single resource id in a LIST", async () => {
    const h = harness();

    await h.service.experimentalRegisterRelationshipCounter({
      name: "one_doc",
      relationshipFilter: filter({ optionalResourceId: "readme" }),
    });

    expect(h.grain.registerArgs[0]?.filter).toEqual({
      resourceType: "document",
      resourceIdPrefix: undefined,
      resourceIds: ["readme"],
      resourceRelation: "viewer",
      subjectType: undefined,
      subjectIds: undefined,
      subjectRelation: undefined,
    });
  });

  it("maps every EMPTY proto string to an absent wire constraint, never to an empty string", async () => {
    const h = harness();

    await h.service.experimentalRegisterRelationshipCounter({
      name: "everything",
      relationshipFilter: {
        resourceType: "",
        optionalResourceId: "",
        optionalResourceIdPrefix: "",
        optionalRelation: "",
      },
    });

    expect(h.grain.registerArgs[0]?.filter).toEqual({
      resourceType: undefined,
      resourceIdPrefix: undefined,
      // An empty `optional_resource_id` is NO constraint, not a one-element list of "".
      resourceIds: undefined,
      resourceRelation: undefined,
      subjectType: undefined,
      subjectIds: undefined,
      subjectRelation: undefined,
    });
  });

  it("carries the resource id PREFIX through as its own constraint", async () => {
    const h = harness();

    await h.service.experimentalRegisterRelationshipCounter({
      name: "prefixed",
      relationshipFilter: filter({ optionalResourceIdPrefix: "doc-" }),
    });

    expect(h.grain.registerArgs[0]?.filter.resourceIdPrefix).toBe("doc-");
    expect(h.grain.registerArgs[0]?.filter.resourceIds).toBeUndefined();
  });

  it("reaches the subject relation through TWO levels of nesting, and lists the single subject id", async () => {
    const h = harness();

    await h.service.experimentalRegisterRelationshipCounter({
      name: "subject_scoped",
      relationshipFilter: filter({
        optionalSubjectFilter: {
          subjectType: "group",
          optionalSubjectId: "eng",
          optionalRelation: { relation: "member" },
        },
      }),
    });

    expect(h.grain.registerArgs[0]?.filter.subjectType).toBe("group");
    expect(h.grain.registerArgs[0]?.filter.subjectIds).toEqual(["eng"]);
    expect(h.grain.registerArgs[0]?.filter.subjectRelation).toBe("member");
  });

  it("leaves the subject relation absent when the nested relation filter is absent or empty", async () => {
    const h = harness();

    await h.service.experimentalRegisterRelationshipCounter({
      name: "no_relation",
      relationshipFilter: filter({
        optionalSubjectFilter: { subjectType: "user", optionalSubjectId: "" },
      }),
    });
    await h.service.experimentalRegisterRelationshipCounter({
      name: "empty_relation",
      relationshipFilter: filter({
        optionalSubjectFilter: {
          subjectType: "user",
          optionalSubjectId: "",
          optionalRelation: { relation: "" },
        },
      }),
    });

    expect(h.grain.registerArgs[0]?.filter.subjectRelation).toBeUndefined();
    expect(h.grain.registerArgs[0]?.filter.subjectIds).toBeUndefined();
    expect(h.grain.registerArgs[1]?.filter.subjectRelation).toBeUndefined();
  });

  it("maps an ALREADY-REGISTERED counter to FAILED_PRECONDITION, carrying the message", async () => {
    const h = harness();
    h.grain.registerThrows = new CounterOperationException(
      "alreadyRegistered",
      "counter with name `doc_viewers` already registered",
    );

    const error = await rpcErrorFrom(
      h.service.experimentalRegisterRelationshipCounter({
        name: "doc_viewers",
        relationshipFilter: filter(),
      }),
    );

    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details).toBe("counter with name `doc_viewers` already registered");
  });

  it("maps a sequencer overload to RESOURCE_EXHAUSTED", async () => {
    const h = harness();
    h.grain.registerThrows = new SequencerOverloadedException("sequencer is saturated");

    const error = await rpcErrorFrom(
      h.service.experimentalRegisterRelationshipCounter({
        name: "doc_viewers",
        relationshipFilter: filter(),
      }),
    );

    expect(error.code).toBe(status.RESOURCE_EXHAUSTED);
    expect(error.details).toBe("sequencer is saturated");
  });

  it("lets any other failure propagate unwrapped", async () => {
    const h = harness();
    const boom = new Error("datastore is down");
    h.grain.registerThrows = boom;

    await expect(
      h.service.experimentalRegisterRelationshipCounter({
        name: "doc_viewers",
        relationshipFilter: filter(),
      }),
    ).rejects.toBe(boom);
  });
});

// ---------------------------------------------------------------- unregister

describe("experimentalUnregisterRelationshipCounter", () => {
  it("passes the name through and returns an EMPTY response", async () => {
    const h = harness();

    const response = await h.service.experimentalUnregisterRelationshipCounter({
      name: "doc_viewers",
    });

    expect(response).toEqual({});
    expect(h.grain.unregisterArgs).toEqual([{ name: "doc_viewers" }]);
  });

  it("maps a NOT-REGISTERED counter to FAILED_PRECONDITION - the SAME code as already-registered", async () => {
    const h = harness();
    h.grain.unregisterThrows = new CounterOperationException(
      "notRegistered",
      "counter with name `nope` not found",
    );

    const error = await rpcErrorFrom(
      h.service.experimentalUnregisterRelationshipCounter({ name: "nope" }),
    );

    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details).toBe("counter with name `nope` not found");
  });

  it("maps a sequencer overload to RESOURCE_EXHAUSTED", async () => {
    const h = harness();
    h.grain.unregisterThrows = new SequencerOverloadedException("shed");

    const error = await rpcErrorFrom(
      h.service.experimentalUnregisterRelationshipCounter({ name: "doc_viewers" }),
    );

    expect(error.code).toBe(status.RESOURCE_EXHAUSTED);
  });
});

// ---------------------------------------------------------------- count

describe("experimentalCountRelationships", () => {
  it("always emits the read_counter_value arm and never counter_still_calculating", async () => {
    const h = harness();
    h.grain.countReply = { count: 7n, readAtToken: "read-at" };

    const response = await h.service.experimentalCountRelationships({ name: "doc_viewers" });

    expect(h.grain.countArgs).toEqual([{ name: "doc_viewers" }]);
    expect(response.counterStillCalculating).toBeUndefined();
    expect(response.readCounterValue).toEqual({
      relationshipCount: "7",
      readAt: { token: "read-at" },
    });
  });

  it("renders the uint64 count as an EXACT string, past the safe-integer range", async () => {
    const h = harness();
    h.grain.countReply = { count: 18446744073709551615n, readAtToken: "read-at" };

    const response = await h.service.experimentalCountRelationships({ name: "huge" });

    expect(response.readCounterValue?.relationshipCount).toBe("18446744073709551615");
  });

  it('emits a zero count as "0", with the read-at token still present', async () => {
    const h = harness();
    h.grain.countReply = { count: 0n, readAtToken: "read-at" };

    const response = await h.service.experimentalCountRelationships({ name: "empty" });

    expect(response.readCounterValue?.relationshipCount).toBe("0");
    expect(response.readCounterValue?.readAt).toEqual({ token: "read-at" });
  });

  it("maps a NOT-REGISTERED counter to FAILED_PRECONDITION", async () => {
    const h = harness();
    h.grain.countThrows = new CounterOperationException(
      "notRegistered",
      "counter with name `nope` not found",
    );

    const error = await rpcErrorFrom(h.service.experimentalCountRelationships({ name: "nope" }));

    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details).toBe("counter with name `nope` not found");
  });

  it("does NOT catch a sequencer overload - the C# omits that catch on the read path", async () => {
    const h = harness();
    const overloaded = new SequencerOverloadedException("shed");
    h.grain.countThrows = overloaded;

    // Reproduced verbatim: Register and Unregister map this to RESOURCE_EXHAUSTED, Count lets it
    // escape unwrapped, so it would surface as UNKNOWN rather than as a retryable overload.
    await expect(h.service.experimentalCountRelationships({ name: "doc_viewers" })).rejects.toBe(
      overloaded,
    );
  });
});
