import { status } from "@grpc/grpc-js";
import { CaveatEvaluationException } from "@benedb/core/caveat-evaluation-exception";
import {
  FULLY_CONSISTENT,
  MINIMIZE_LATENCY,
  atExactSnapshot,
  atLeastAsFresh,
  type ConsistencyRequirement,
} from "@benedb/core/consistency-requirement";
import { ELLIPSIS } from "@benedb/core/core-constants";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { InvalidConsistencyTokenException } from "@benedb/core/invalid-consistency-token-exception";
import { MaxDepthExceededException } from "@benedb/core/max-depth-exceeded-exception";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { ConsistencyWire } from "@benedb/grains/consistency-wire";
import {
  DispatchFailedException,
  type DispatchErrorCode,
} from "@benedb/grains/dispatch-failed-exception";
import type {
  BatchCheckItem,
  BatchCheckResult,
  IPermissionChecker,
  PermissionCheckResult,
} from "@benedb/grains/i-permission-checker";
import { IRelationshipsGrain, RELATIONSHIPS_GRAIN_KEY } from "@benedb/grains/i-relationships-grain";
import { PreconditionFailedException } from "@benedb/grains/precondition-failed-exception";
import type { RelationshipReads } from "@benedb/grains/relationship-reads";
import type {
  DeleteRelationshipsArgs,
  DeleteRelationshipsReply,
  ReadRelationshipsArgs,
  ReadSchemaReply,
  RelationshipStreamItem,
  RelationshipWire,
  WriteRelationshipsArgs,
  WriteRelationshipsReply,
  WriteSchemaArgs,
  WriteSchemaReply,
} from "@benedb/grains/relationships-dtos";
import type { ReverseOps } from "@benedb/grains/reverse-ops";
import type {
  ExpandTreeArgs,
  ExpandTreeNodeWire,
  ExpandTreeReply,
  FoundResourceWire,
  FoundSubjectStreamItem,
  LookupResourcesArgs,
  LookupSubjectsArgs,
} from "@benedb/grains/reverse-ops-dtos";
import { SchemaWriteValidationException } from "@benedb/grains/schema-write-validation-exception";
import { SequencerOverloadedException } from "@benedb/grains/sequencer-overloaded-exception";
import {
  CheckPermissionRequest,
  CheckPermissionResponse_Permissionship,
  BatchCheckPermissionRequest,
  DeleteRelationshipsRequest,
  ExpandPermissionTreeRequest,
  ExpandPermissionTreeRequest_ExpandMode,
  LookupResourcesRequest,
  LookupSubjectsRequest,
  PermissionTreeNode_SetOpNode_Operation,
  Permissionship_Kind,
  Precondition_Operation,
  ReadRelationshipsRequest,
  ReadSchemaRequest,
  RelationshipUpdate_Operation,
  WriteRelationshipsRequest,
  WriteSchemaRequest,
} from "@benedb/protos/permissions";
import { SchemaCompileException } from "@benedb/schema/schema-compile-exception";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { describe, expect, it } from "vitest";

import { PermissionsGrpcService } from "./permissions-grpc-service";
import { RpcError } from "./rpc-error";

/**
 * Characterization test for `src/Spiceport.Api/PermissionsGrpcService.cs` - the `spiceport.v0`
 * serving surface.
 *
 * SCOPE, deliberately. Six C# suites drive this file end to end over `MeshTestCluster`
 * (`DataPlaneGrpcServiceTests`, `BatchCheckGrpcServiceTests`, `ReverseOpsGrpcServiceTests`,
 * `WriteSafetyGrpcServiceTests`, `ConsistencyMeshTests`, `SchemaAtRevisionMeshTests`) and all six
 * are stage S5b's to port; none of them is restated here. What they do NOT pin, because a live
 * mesh cannot easily produce it, is the TRANSLATION this file is: the proto <-> wire conversions,
 * the `Drain` paging contract, and the per-RPC error mapping. Those are what this file pins, over
 * fakes of the four collaborators the C# constructor takes
 * (`IPermissionChecker`, `IGrainFactory`, `ReverseOps`, `RelationshipReads`), so that every case
 * fails for its own reason.
 *
 * Reading notes for the C# this pins:
 *   * `Drain<T>` (lines 47-62) checks the limit BEFORE adding, so the cursor is set from the LAST
 *     KEPT item only when a FURTHER item actually arrives. A page that exactly fills the limit
 *     with nothing beyond it returns an EMPTY cursor, and an unlimited drain never sets one.
 *   * `ReadAt` / `LookedUpAt` is `items[0]`'s token when the page is non-empty and
 *     `string.Empty` otherwise - an empty page returns an EMPTY ZedToken, never the head token.
 *   * `RevisionNotFoundException` maps to INVALID_ARGUMENT, deliberately the same as an invalid
 *     consistency token and NOT to NOT_FOUND.
 *   * `BatchCheckPermission` does NOT catch `CaveatEvaluationException` while `CheckPermission`
 *     does. The asymmetry is the C#'s and is reproduced.
 *   * `ReadSchema` (line 234) does NOT raise NOT_FOUND on an empty schema. The v1 service does;
 *     that difference is asserted on the v1 side.
 *   * A precondition operation that is not MUST_NOT_MATCH maps to MUST_MATCH, so UNSPECIFIED
 *     silently means MUST_MATCH here. The v1 service instead rejects UNSPECIFIED.
 *
 * Port decisions this file also pins, because the C# construct has no TypeScript counterpart:
 *   * `ServerCallContext` becomes an optional `AbortSignal`: the C# reads nothing from the context
 *     except `CancellationToken`.
 *   * `int64`/`uint64` arrive as STRINGS (`forceLong=string`), so `deleted_count` renders through
 *     `String(bigint)` and `optional_expires_at_unix_seconds` through `BigInt(...)`, never a
 *     `number`.
 *   * Expiration is NANOS `bigint` in the grains DTOs, so seconds convert with
 *     `* 1_000_000_000n` / `/ 1_000_000_000n`.
 *   * `Struct` arrives auto-unwrapped by ts-proto as a plain object, and the grains DTOs take a
 *     `ReadonlyMap`, so the conversion is object <-> Map at every level.
 */

const REVISION = new TimestampRevision(7n);

// ---------------------------------------------------------------- fakes

interface CheckCall {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly permission: string;
  readonly subject: ObjectAndRelation;
  readonly context: ReadonlyMap<string, unknown> | undefined;
  readonly consistency: ConsistencyRequirement | undefined;
  readonly signal: AbortSignal | undefined;
}

interface BatchCall {
  readonly items: readonly BatchCheckItem[];
  readonly consistency: ConsistencyRequirement | undefined;
  readonly signal: AbortSignal | undefined;
}

function checkResult(
  verdict: PermissionCheckResult["verdict"],
  missingFields: readonly string[] = [],
  token = "check-token",
): PermissionCheckResult {
  return {
    verdict,
    missingFields,
    evaluatedRevision: REVISION,
    schemaHash: "hash",
    evaluatedToken: token,
  };
}

class FakeChecker implements IPermissionChecker {
  readonly checkCalls: CheckCall[] = [];
  readonly batchCalls: BatchCall[] = [];
  result: PermissionCheckResult = checkResult("member");
  batchResult: BatchCheckResult = {
    items: [],
    evaluatedRevision: REVISION,
    schemaHash: "hash",
    evaluatedToken: "batch-token",
  };
  checkThrows: unknown;
  batchThrows: unknown;

  async check(
    resourceType: string,
    resourceId: string,
    permission: string,
    subject: ObjectAndRelation,
    caveatContext: ReadonlyMap<string, unknown> | undefined,
    consistency?: ConsistencyRequirement | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<PermissionCheckResult> {
    this.checkCalls.push({
      resourceType,
      resourceId,
      permission,
      subject,
      context: caveatContext,
      consistency,
      signal,
    });
    if (this.checkThrows !== undefined) throw this.checkThrows;
    return this.result;
  }

  async batchCheck(
    items: readonly BatchCheckItem[],
    consistency?: ConsistencyRequirement | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<BatchCheckResult> {
    this.batchCalls.push({ items, consistency, signal });
    if (this.batchThrows !== undefined) throw this.batchThrows;
    return this.batchResult;
  }
}

class FakeRelationshipsGrain {
  readonly writeSchemaArgs: WriteSchemaArgs[] = [];
  readonly writeArgs: WriteRelationshipsArgs[] = [];
  readonly deleteArgs: DeleteRelationshipsArgs[] = [];

  writeSchemaReply: WriteSchemaReply = { writtenAtToken: "schema-token" };
  readSchemaReply: ReadSchemaReply = {
    schemaText: "definition user {}",
    readAtToken: "read-token",
  };
  writeReply: WriteRelationshipsReply = { writtenAtToken: "write-token" };
  deleteReply: DeleteRelationshipsReply = {
    deletedCount: 3n,
    reachedLimit: false,
    deletedAtToken: "delete-token",
  };
  writeSchemaThrows: unknown;
  writeThrows: unknown;
  deleteThrows: unknown;

  async writeSchema(args: WriteSchemaArgs): Promise<WriteSchemaReply> {
    this.writeSchemaArgs.push(args);
    if (this.writeSchemaThrows !== undefined) throw this.writeSchemaThrows;
    return this.writeSchemaReply;
  }

  async readSchema(): Promise<ReadSchemaReply> {
    return this.readSchemaReply;
  }

  async writeRelationships(args: WriteRelationshipsArgs): Promise<WriteRelationshipsReply> {
    this.writeArgs.push(args);
    if (this.writeThrows !== undefined) throw this.writeThrows;
    return this.writeReply;
  }

  async deleteRelationships(args: DeleteRelationshipsArgs): Promise<DeleteRelationshipsReply> {
    this.deleteArgs.push(args);
    if (this.deleteThrows !== undefined) throw this.deleteThrows;
    return this.deleteReply;
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

class FakeReverseOps {
  readonly expandArgs: ExpandTreeArgs[] = [];
  readonly lookupSubjectsArgs: LookupSubjectsArgs[] = [];
  readonly lookupResourcesArgs: LookupResourcesArgs[] = [];
  readonly lookupSubjectsSignals: (AbortSignal | undefined)[] = [];
  readonly lookupResourcesSignals: (AbortSignal | undefined)[] = [];

  /** How many items each stream actually yielded - the `Drain` early-break probe. */
  subjectsYielded = 0;
  resourcesYielded = 0;

  expandReply: ExpandTreeReply = { root: leafNode(), expandedAtToken: "expand-token" };
  subjects: readonly FoundSubjectStreamItem[] = [];
  resources: readonly FoundResourceWire[] = [];

  async expandPermissionTree(args: ExpandTreeArgs): Promise<ExpandTreeReply> {
    this.expandArgs.push(args);
    return this.expandReply;
  }

  async *streamLookupSubjects(
    args: LookupSubjectsArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<FoundSubjectStreamItem> {
    this.lookupSubjectsArgs.push(args);
    this.lookupSubjectsSignals.push(signal);
    for (const item of this.subjects) {
      this.subjectsYielded += 1;
      yield item;
    }
  }

  async *streamLookupResources(
    args: LookupResourcesArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<FoundResourceWire> {
    this.lookupResourcesArgs.push(args);
    this.lookupResourcesSignals.push(signal);
    for (const item of this.resources) {
      this.resourcesYielded += 1;
      yield item;
    }
  }
}

class FakeRelationshipReads {
  readonly args: ReadRelationshipsArgs[] = [];
  readonly signals: (AbortSignal | undefined)[] = [];
  items: readonly RelationshipStreamItem[] = [];
  yielded = 0;

  async *readRelationships(
    args: ReadRelationshipsArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<RelationshipStreamItem> {
    this.args.push(args);
    this.signals.push(signal);
    for (const item of this.items) {
      this.yielded += 1;
      yield item;
    }
  }
}

interface Harness {
  readonly service: PermissionsGrpcService;
  readonly checker: FakeChecker;
  readonly grain: FakeRelationshipsGrain;
  readonly grains: FakeGrainFactory;
  readonly reverseOps: FakeReverseOps;
  readonly reads: FakeRelationshipReads;
}

function harness(): Harness {
  const checker = new FakeChecker();
  const grain = new FakeRelationshipsGrain();
  const grains = new FakeGrainFactory(grain);
  const reverseOps = new FakeReverseOps();
  const reads = new FakeRelationshipReads();
  const service = new PermissionsGrpcService(
    checker,
    grains,
    reverseOps as unknown as ReverseOps,
    reads as unknown as RelationshipReads,
  );
  return { service, checker, grain, grains, reverseOps, reads };
}

// ---------------------------------------------------------------- fixtures

function relationshipWire(overrides: Partial<RelationshipWire> = {}): RelationshipWire {
  return {
    resourceType: "document",
    resourceId: "readme",
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId: "alice",
    subjectRelation: ELLIPSIS,
    ...overrides,
  };
}

function streamItem(
  resourceId: string,
  cursor: string,
  readAtToken: string,
): RelationshipStreamItem {
  return {
    relationship: relationshipWire({ resourceId }),
    resumeCursor: cursor,
    readAtToken,
  };
}

function foundSubject(subjectId: string, cursor: string, token: string): FoundSubjectStreamItem {
  return {
    subject: {
      subjectId,
      isWildcard: false,
      permissionship: { isCaveated: false, missingContextParams: [] },
    },
    resumeCursor: cursor,
    lookedUpAtToken: token,
  };
}

function foundResource(resourceId: string, cursor: string, token: string): FoundResourceWire {
  return {
    resourceId,
    permissionship: { isCaveated: false, missingContextParams: [] },
    afterResultCursor: cursor,
    lookedUpAtToken: token,
  };
}

function leafNode(overrides: Partial<ExpandTreeNodeWire> = {}): ExpandTreeNodeWire {
  return {
    expandedType: "document",
    expandedId: "readme",
    expandedRelation: "view",
    caveatMissingFields: [],
    isLeaf: true,
    operation: "union",
    subjects: [],
    children: [],
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

async function thrownFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected a throw, but the call succeeded");
}

// ---------------------------------------------------------------- checkPermission

describe("checkPermission", () => {
  it("maps a member verdict to HAS_PERMISSION and mints checked_at from the evaluated token", async () => {
    const h = harness();
    h.checker.result = checkResult("member", [], "tok-1");

    const response = await h.service.checkPermission(
      CheckPermissionRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
      }),
    );

    expect(response.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
    );
    expect(response.checkedAt).toEqual({ token: "tok-1" });
    expect(response.partialCaveatMissingFields).toEqual([]);
  });

  it("maps a caveated verdict to CONDITIONAL and carries the missing fields", async () => {
    const h = harness();
    h.checker.result = checkResult("caveated", ["hour", "region"]);

    const response = await h.service.checkPermission(
      CheckPermissionRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
      }),
    );

    expect(response.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION,
    );
    expect(response.partialCaveatMissingFields).toEqual(["hour", "region"]);
  });

  it("maps every other verdict to NO_PERMISSION", async () => {
    const h = harness();
    h.checker.result = checkResult("notMember");

    const response = await h.service.checkPermission(
      CheckPermissionRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
      }),
    );

    expect(response.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
    );
  });

  it("defaults an empty subject relation to the ellipsis and keeps a set one", async () => {
    const h = harness();

    await h.service.checkPermission(
      CheckPermissionRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
      }),
    );
    await h.service.checkPermission(
      CheckPermissionRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "group", objectId: "eng" }, optionalRelation: "member" },
      }),
    );

    expect(h.checker.checkCalls[0]?.subject).toEqual({
      objectType: "user",
      objectId: "alice",
      relation: ELLIPSIS,
    });
    expect(h.checker.checkCalls[1]?.subject).toEqual({
      objectType: "group",
      objectId: "eng",
      relation: "member",
    });
  });

  it("converts the request context struct into a Map, recursively, and an empty one to undefined", async () => {
    const h = harness();

    await h.service.checkPermission(
      CheckPermissionRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
        context: {
          text: "abc",
          count: 42,
          flag: true,
          nothing: null,
          list: ["a", 1, false],
          nested: { inner: "x" },
        },
      }),
    );
    await h.service.checkPermission(
      CheckPermissionRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
        context: {},
      }),
    );

    const context = h.checker.checkCalls[0]?.context;
    expect(context).toBeInstanceOf(Map);
    expect(context?.get("text")).toBe("abc");
    expect(context?.get("count")).toBe(42);
    expect(context?.get("flag")).toBe(true);
    expect(context?.get("nothing")).toBeNull();
    // A string is NOT exploded into characters, and a list stays a list.
    expect(context?.get("list")).toEqual(["a", 1, false]);
    // A nested struct becomes a nested Map: that is what the caveat evaluator matches on.
    const nested = context?.get("nested");
    expect(nested).toBeInstanceOf(Map);
    expect((nested as ReadonlyMap<string, unknown>).get("inner")).toBe("x");

    // An EMPTY struct is `null` in the C#, not an empty dictionary.
    expect(h.checker.checkCalls[1]?.context).toBeUndefined();
  });

  it("passes minimize-latency for an absent consistency message", async () => {
    const h = harness();

    await h.service.checkPermission(
      CheckPermissionRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
      }),
    );

    expect(h.checker.checkCalls[0]?.consistency).toEqual(MINIMIZE_LATENCY);
  });

  it("converts each consistency requirement before handing it to the checker", async () => {
    const cases: readonly [
      Parameters<typeof CheckPermissionRequest.fromPartial>[0]["consistency"],
      ConsistencyRequirement,
    ][] = [
      [{ fullyConsistent: true }, FULLY_CONSISTENT],
      [{ atLeastAsFresh: { token: "t1" } }, atLeastAsFresh({ token: "t1" })],
      [{ atExactSnapshot: { token: "t2" } }, atExactSnapshot({ token: "t2" })],
      [{ minimizeLatency: true }, MINIMIZE_LATENCY],
    ];

    for (const [consistency, expected] of cases) {
      const h = harness();
      await h.service.checkPermission(
        CheckPermissionRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
          subject: { object: { objectType: "user", objectId: "alice" } },
          consistency,
        }),
      );
      expect(h.checker.checkCalls[0]?.consistency).toEqual(expected);
    }
  });

  it("treats a SET oneof arm as selected even when its value is false", async () => {
    // C# `RequirementCase` is set by ASSIGNMENT, so `new Consistency { FullyConsistent = false }`
    // selects FULLY_CONSISTENT. A truthiness test in the port would fall through to
    // minimize-latency and silently downgrade the read.
    const h = harness();

    await h.service.checkPermission(
      CheckPermissionRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
        consistency: { fullyConsistent: false },
      }),
    );

    expect(h.checker.checkCalls[0]?.consistency).toEqual(FULLY_CONSISTENT);
  });

  it("forwards the caller's cancellation signal to the checker", async () => {
    const h = harness();
    const controller = new AbortController();

    await h.service.checkPermission(
      CheckPermissionRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
      }),
      controller.signal,
    );

    expect(h.checker.checkCalls[0]?.signal).toBe(controller.signal);
  });

  it("maps each check failure onto its deliberately chosen status", async () => {
    const cases: readonly [unknown, status][] = [
      [new InvalidConsistencyTokenException("bad token"), status.INVALID_ARGUMENT],
      // Deliberately the SAME contract as an invalid token, NOT NOT_FOUND.
      [new RevisionNotFoundException(REVISION), status.INVALID_ARGUMENT],
      [new MaxDepthExceededException("too deep"), status.FAILED_PRECONDITION],
      [
        new CaveatEvaluationException("parameterTypeMismatch", "wrong type"),
        status.INVALID_ARGUMENT,
      ],
      [
        new CaveatEvaluationException("unknownCaveat", "no such caveat"),
        status.FAILED_PRECONDITION,
      ],
    ];

    for (const [thrown, expected] of cases) {
      const h = harness();
      h.checker.checkThrows = thrown;
      const error = await rpcErrorFrom(
        h.service.checkPermission(
          CheckPermissionRequest.fromPartial({
            resource: { objectType: "document", objectId: "readme" },
            permission: "view",
            subject: { object: { objectType: "user", objectId: "alice" } },
          }),
        ),
      );
      expect(error.code).toBe(expected);
      expect(error.details).toBe((thrown as Error).message);
    }
  });

  it("maps a dispatch failure by its code", async () => {
    const cases: readonly [DispatchErrorCode, status][] = [
      ["unavailable", status.UNAVAILABLE],
      ["cancelled", status.CANCELLED],
      ["deadlineExceeded", status.DEADLINE_EXCEEDED],
      ["internal", status.INTERNAL],
    ];

    for (const [code, expected] of cases) {
      const h = harness();
      h.checker.checkThrows = new DispatchFailedException(code, "dispatch " + code);
      const error = await rpcErrorFrom(
        h.service.checkPermission(
          CheckPermissionRequest.fromPartial({
            resource: { objectType: "document", objectId: "readme" },
            permission: "view",
            subject: { object: { objectType: "user", objectId: "alice" } },
          }),
        ),
      );
      expect(error.code).toBe(expected);
      expect(error.details).toBe("dispatch " + code);
    }
  });

  it("lets an unrecognised failure propagate unchanged", async () => {
    const h = harness();
    const boom = new Error("boom");
    h.checker.checkThrows = boom;

    const thrown = await thrownFrom(
      h.service.checkPermission(
        CheckPermissionRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
          subject: { object: { objectType: "user", objectId: "alice" } },
        }),
      ),
    );

    expect(thrown).toBe(boom);
  });
});

// ---------------------------------------------------------------- batchCheckPermission

describe("batchCheckPermission", () => {
  const request = BatchCheckPermissionRequest.fromPartial({
    items: [
      {
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
        context: { hour: 9 },
      },
      {
        resource: { objectType: "document", objectId: "design" },
        permission: "view",
        subject: { object: { objectType: "group", objectId: "eng" }, optionalRelation: "member" },
      },
    ],
  });

  it("pairs each verdict with the ORIGINAL request item, by index, under one batch token", async () => {
    const h = harness();
    h.checker.batchResult = {
      items: [
        { verdict: "member", missingFields: [] },
        { verdict: "caveated", missingFields: ["hour"] },
      ],
      evaluatedRevision: REVISION,
      schemaHash: "hash",
      evaluatedToken: "batch-tok",
    };

    const response = await h.service.batchCheckPermission(request);

    expect(response.checkedAt).toEqual({ token: "batch-tok" });
    expect(response.pairs).toHaveLength(2);
    // The pair carries the request item itself, so index alignment is observable on the wire.
    expect(response.pairs[0]?.request).toBe(request.items[0]);
    expect(response.pairs[1]?.request).toBe(request.items[1]);
    expect(response.pairs[0]?.item?.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
    );
    expect(response.pairs[1]?.item?.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION,
    );
    expect(response.pairs[1]?.item?.partialCaveatMissingFields).toEqual(["hour"]);
  });

  it("converts every item, defaulting an empty subject relation to the ellipsis", async () => {
    const h = harness();
    h.checker.batchResult = {
      items: [
        { verdict: "member", missingFields: [] },
        { verdict: "notMember", missingFields: [] },
      ],
      evaluatedRevision: REVISION,
      schemaHash: "hash",
      evaluatedToken: "batch-tok",
    };

    await h.service.batchCheckPermission(request);

    const items = h.checker.batchCalls[0]?.items ?? [];
    expect(items[0]?.resourceType).toBe("document");
    expect(items[0]?.resourceId).toBe("readme");
    expect(items[0]?.permission).toBe("view");
    expect(items[0]?.subject).toEqual({
      objectType: "user",
      objectId: "alice",
      relation: ELLIPSIS,
    });
    expect(items[0]?.caveatContext).toBeInstanceOf(Map);
    expect(items[0]?.caveatContext?.get("hour")).toBe(9);
    expect(items[1]?.subject.relation).toBe("member");
    expect(items[1]?.caveatContext).toBeUndefined();
  });

  it("maps a consistency-token or missing-revision failure to INVALID_ARGUMENT", async () => {
    for (const thrown of [
      new InvalidConsistencyTokenException("bad token"),
      new RevisionNotFoundException(REVISION),
    ]) {
      const h = harness();
      h.checker.batchThrows = thrown;
      const error = await rpcErrorFrom(h.service.batchCheckPermission(request));
      expect(error.code).toBe(status.INVALID_ARGUMENT);
    }
  });

  it("maps a dispatch failure by its code", async () => {
    const h = harness();
    h.checker.batchThrows = new DispatchFailedException("unavailable", "silo gone");

    const error = await rpcErrorFrom(h.service.batchCheckPermission(request));

    expect(error.code).toBe(status.UNAVAILABLE);
  });

  it("does NOT catch a caveat-evaluation failure, unlike checkPermission", async () => {
    // The asymmetry is Spiceport's: `BatchCheckPermission` has no CaveatEvaluationException
    // filter, so the exception escapes the RPC instead of becoming INVALID_ARGUMENT.
    const h = harness();
    const caveat = new CaveatEvaluationException("parameterTypeMismatch", "wrong type");
    h.checker.batchThrows = caveat;

    expect(await thrownFrom(h.service.batchCheckPermission(request))).toBe(caveat);
  });
});

// ---------------------------------------------------------------- schema

describe("writeSchema", () => {
  it("resolves the relationships grain by its constant key and returns the written-at token", async () => {
    const h = harness();
    h.grain.writeSchemaReply = { writtenAtToken: "tok-schema" };

    const response = await h.service.writeSchema(
      WriteSchemaRequest.fromPartial({ schema: "definition user {}" }),
    );

    expect(response.writtenAt).toEqual({ token: "tok-schema" });
    expect(h.grain.writeSchemaArgs).toEqual([{ schemaText: "definition user {}" }]);
    expect(h.grains.lookups[0]?.definition).toBe(IRelationshipsGrain);
    expect(h.grains.lookups[0]?.key).toBe(RELATIONSHIPS_GRAIN_KEY);
  });

  it("maps each write-schema failure onto its status", async () => {
    const cases: readonly [unknown, status][] = [
      [new SchemaCompileException("parse error"), status.INVALID_ARGUMENT],
      // The grain surfaces a compile failure across the grain boundary as an argument error.
      [new InvalidArgumentError("bad schema"), status.INVALID_ARGUMENT],
      [
        new SchemaWriteValidationException("would orphan relationships"),
        status.FAILED_PRECONDITION,
      ],
      [new SequencerOverloadedException("shed"), status.RESOURCE_EXHAUSTED],
    ];

    for (const [thrown, expected] of cases) {
      const h = harness();
      h.grain.writeSchemaThrows = thrown;
      const error = await rpcErrorFrom(
        h.service.writeSchema(WriteSchemaRequest.fromPartial({ schema: "definition user {}" })),
      );
      expect(error.code).toBe(expected);
      expect(error.details).toBe((thrown as Error).message);
    }
  });

  it("lets an unrelated failure propagate unchanged", async () => {
    const h = harness();
    const failure = new PreconditionFailedException("mustMatchFoundNone", 0, "no match");
    h.grain.writeSchemaThrows = failure;

    expect(
      await thrownFrom(
        h.service.writeSchema(WriteSchemaRequest.fromPartial({ schema: "definition user {}" })),
      ),
    ).toBe(failure);
  });
});

describe("readSchema", () => {
  it("returns the schema text and the read-at token", async () => {
    const h = harness();
    h.grain.readSchemaReply = { schemaText: "definition user {}", readAtToken: "tok-read" };

    const response = await h.service.readSchema(ReadSchemaRequest.fromPartial({}));

    expect(response.schemaText).toBe("definition user {}");
    expect(response.readAt).toEqual({ token: "tok-read" });
  });

  it("returns an EMPTY schema rather than raising NOT_FOUND", async () => {
    // Deliberately unlike the authzed v1 service, which does raise NOT_FOUND here.
    const h = harness();
    h.grain.readSchemaReply = { schemaText: "", readAtToken: "" };

    const response = await h.service.readSchema(ReadSchemaRequest.fromPartial({}));

    expect(response.schemaText).toBe("");
    expect(response.readAt).toEqual({ token: "" });
  });
});

// ---------------------------------------------------------------- writeRelationships

describe("writeRelationships", () => {
  it("maps each update operation, treating UNSPECIFIED as TOUCH", async () => {
    const h = harness();

    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [
          { operation: RelationshipUpdate_Operation.OPERATION_CREATE, relationship: {} },
          { operation: RelationshipUpdate_Operation.OPERATION_DELETE, relationship: {} },
          { operation: RelationshipUpdate_Operation.OPERATION_TOUCH, relationship: {} },
          { operation: RelationshipUpdate_Operation.OPERATION_UNSPECIFIED, relationship: {} },
        ],
      }),
    );

    expect(h.grain.writeArgs[0]?.updates.map((u) => u.operation)).toEqual([
      "create",
      "delete",
      "touch",
      "touch",
    ]);
  });

  it("converts a relationship: ellipsis default, caveat and expiration nanos", async () => {
    const h = harness();

    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: {
              resource: { objectType: "document", objectId: "readme" },
              resourceRelation: "viewer",
              subject: { object: { objectType: "user", objectId: "alice" } },
              optionalCaveat: { caveatName: "only_bizday", context: { hour: 9 } },
              optionalExpiresAtUnixSeconds: "1700000000",
            },
          },
        ],
      }),
    );

    const written = h.grain.writeArgs[0]?.updates[0]?.relationship;
    expect(written?.resourceType).toBe("document");
    expect(written?.resourceId).toBe("readme");
    expect(written?.resourceRelation).toBe("viewer");
    expect(written?.subjectRelation).toBe(ELLIPSIS);
    expect(written?.caveatName).toBe("only_bizday");
    expect(written?.caveatContext).toBeInstanceOf(Map);
    expect(written?.caveatContext?.get("hour")).toBe(9);
    // Seconds on the wire, NANOS in the grains DTO - through BigInt, never a JS number.
    expect(written?.expiration).toBe(1_700_000_000_000_000_000n);
  });

  it("treats a zero expiration as absent", async () => {
    const h = harness();

    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: { optionalExpiresAtUnixSeconds: "0" },
          },
        ],
      }),
    );

    expect(h.grain.writeArgs[0]?.updates[0]?.relationship.expiration).toBeUndefined();
  });

  it("rejects an expiration outside the range DateTimeOffset accepts", async () => {
    // `DateTimeOffset.FromUnixTimeSeconds` throws outside [-62135596800, 253402300799], and the
    // conversion runs BEFORE the try block, so the C# never turns this into a mapped status. The
    // port keeps the guard (an epoch-nanos bigint would otherwise accept any magnitude) and lets
    // the error escape the same way.
    const h = harness();

    const thrown = await thrownFrom(
      h.service.writeRelationships(
        WriteRelationshipsRequest.fromPartial({
          updates: [
            {
              operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
              relationship: { optionalExpiresAtUnixSeconds: "253402300800" },
            },
          ],
        }),
      ),
    );

    expect(thrown).toBeInstanceOf(InvalidArgumentError);
    expect(h.grain.writeArgs).toHaveLength(0);
  });

  it("drops a caveat's context together with an EMPTY caveat name", async () => {
    // Name and context come off the SAME `caveatName.length > 0` guard: an empty caveat name is
    // not a valid caveat reference, so its context must not survive as an orphan (issue #42).
    const h = harness();

    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [
          {
            operation: RelationshipUpdate_Operation.OPERATION_TOUCH,
            relationship: { optionalCaveat: { caveatName: "", context: { hour: 9 } } },
          },
        ],
      }),
    );

    const written = h.grain.writeArgs[0]?.updates[0]?.relationship;
    expect(written?.caveatName).toBeUndefined();
    expect(written?.caveatContext).toBeUndefined();
  });

  it("passes undefined preconditions for an empty list, and maps the operations", async () => {
    const h = harness();

    await h.service.writeRelationships(WriteRelationshipsRequest.fromPartial({ updates: [] }));
    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [],
        optionalPreconditions: [
          { operation: Precondition_Operation.OPERATION_MUST_NOT_MATCH, filter: {} },
          { operation: Precondition_Operation.OPERATION_MUST_MATCH, filter: {} },
          // UNSPECIFIED silently means MUST_MATCH on this surface (the v1 service rejects it).
          { operation: Precondition_Operation.OPERATION_UNSPECIFIED, filter: {} },
        ],
      }),
    );

    expect(h.grain.writeArgs[0]?.preconditions).toBeUndefined();
    expect(h.grain.writeArgs[1]?.preconditions?.map((p) => p.operation)).toEqual([
      "mustNotMatch",
      "mustMatch",
      "mustMatch",
    ]);
  });

  it("converts a relationship filter, dropping empty fields", async () => {
    const h = harness();

    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [],
        optionalPreconditions: [
          {
            operation: Precondition_Operation.OPERATION_MUST_MATCH,
            filter: {
              resourceType: "document",
              optionalResourceIdPrefix: "",
              optionalResourceIds: ["readme"],
              optionalResourceRelation: "viewer",
              optionalSubjectType: "",
              optionalSubjectIds: [],
              optionalSubjectRelation: "",
            },
          },
        ],
      }),
    );

    expect(h.grain.writeArgs[0]?.preconditions?.[0]?.filter).toEqual({
      resourceType: "document",
      resourceIdPrefix: undefined,
      resourceIds: ["readme"],
      resourceRelation: "viewer",
      subjectType: undefined,
      subjectIds: undefined,
      subjectRelation: undefined,
    });
  });

  it("returns the written-at token", async () => {
    const h = harness();
    h.grain.writeReply = { writtenAtToken: "tok-write" };

    const response = await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({ updates: [] }),
    );

    expect(response.writtenAt).toEqual({ token: "tok-write" });
  });

  it("maps a failed precondition and a shed sequencer commit", async () => {
    const cases: readonly [unknown, status][] = [
      [
        new PreconditionFailedException("mustMatchFoundNone", 0, "precondition failed"),
        status.FAILED_PRECONDITION,
      ],
      [new SequencerOverloadedException("shed"), status.RESOURCE_EXHAUSTED],
    ];

    for (const [thrown, expected] of cases) {
      const h = harness();
      h.grain.writeThrows = thrown;
      const error = await rpcErrorFrom(
        h.service.writeRelationships(WriteRelationshipsRequest.fromPartial({ updates: [] })),
      );
      expect(error.code).toBe(expected);
      expect(error.details).toBe((thrown as Error).message);
    }
  });
});

// ---------------------------------------------------------------- readRelationships (Drain)

describe("readRelationships", () => {
  it("passes an unlimited read for limit 0 and never sets a cursor", async () => {
    const h = harness();
    h.reads.items = [
      streamItem("a", "cur-a", "tok"),
      streamItem("b", "cur-b", "tok"),
      streamItem("c", "cur-c", "tok"),
    ];

    const response = await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ filter: { resourceType: "document" } }),
    );

    expect(h.reads.args[0]?.limit).toBeUndefined();
    expect(response.relationships).toHaveLength(3);
    expect(response.afterResultCursor).toBe("");
  });

  it("returns an EMPTY cursor when the page exactly fills the limit", async () => {
    const h = harness();
    h.reads.items = [streamItem("a", "cur-a", "tok"), streamItem("b", "cur-b", "tok")];

    const response = await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({
        filter: { resourceType: "document" },
        optionalLimit: 2,
      }),
    );

    expect(h.reads.args[0]?.limit).toBe(2);
    expect(response.relationships).toHaveLength(2);
    expect(response.afterResultCursor).toBe("");
  });

  it("sets the cursor from the LAST KEPT item once a further item arrives, and stops there", async () => {
    const h = harness();
    h.reads.items = [
      streamItem("a", "cur-a", "tok"),
      streamItem("b", "cur-b", "tok"),
      streamItem("c", "cur-c", "tok"),
      streamItem("d", "cur-d", "tok"),
    ];

    const response = await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({
        filter: { resourceType: "document" },
        optionalLimit: 2,
      }),
    );

    expect(response.relationships.map((r) => r.resource?.objectId)).toEqual(["a", "b"]);
    // The cursor is item b's, NOT the extra item c's.
    expect(response.afterResultCursor).toBe("cur-b");
    // Exactly one item beyond the limit is drawn from the stream; the drain then breaks.
    expect(h.reads.yielded).toBe(3);
  });

  it("takes read_at from the FIRST item, and returns an empty token for an empty page", async () => {
    const withItems = harness();
    withItems.reads.items = [
      streamItem("a", "cur-a", "tok-first"),
      streamItem("b", "cur-b", "tok-second"),
    ];
    const populated = await withItems.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ filter: {} }),
    );
    expect(populated.readAt).toEqual({ token: "tok-first" });

    const empty = harness();
    const emptyPage = await empty.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ filter: {} }),
    );
    // An empty page carries an EMPTY ZedToken, not the head token: ConsistencyMeshTests chains on it.
    expect(emptyPage.readAt).toEqual({ token: "" });
    expect(emptyPage.afterResultCursor).toBe("");
  });

  it("passes the filter, the cursor and the consistency wire through", async () => {
    const h = harness();

    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({
        filter: { resourceType: "document", optionalResourceRelation: "viewer" },
        optionalCursor: "resume-here",
        consistency: { atLeastAsFresh: { token: "zt" } },
      }),
    );

    expect(h.reads.args[0]?.filter.resourceType).toBe("document");
    expect(h.reads.args[0]?.filter.resourceRelation).toBe("viewer");
    expect(h.reads.args[0]?.cursor).toBe("resume-here");
    const consistency: ConsistencyWire | undefined = h.reads.args[0]?.consistency;
    expect(consistency).toEqual({ mode: "atLeastAsFresh", token: "zt" });
  });

  it("passes undefined for an empty cursor", async () => {
    const h = harness();

    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ filter: {}, optionalCursor: "" }),
    );

    expect(h.reads.args[0]?.cursor).toBeUndefined();
  });

  it("maps a relationship back to proto, blanking the ellipsis subrelation", async () => {
    const h = harness();
    h.reads.items = [
      {
        relationship: relationshipWire({
          caveatName: "only_bizday",
          caveatContext: new Map<string, unknown>([
            ["hour", 9],
            ["text", "abc"],
            ["nested", new Map<string, unknown>([["inner", true]])],
            ["list", [1, "two"]],
            ["nothing", undefined],
          ]),
          expiration: 1_700_000_000_000_000_000n,
        }),
        resumeCursor: "cur",
        readAtToken: "tok",
      },
    ];

    const response = await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ filter: {} }),
    );

    const relationship = response.relationships[0];
    expect(relationship?.resource).toEqual({ objectType: "document", objectId: "readme" });
    expect(relationship?.resourceRelation).toBe("viewer");
    expect(relationship?.subject?.object).toEqual({ objectType: "user", objectId: "alice" });
    // The ellipsis is the wire's ABSENT subrelation.
    expect(relationship?.subject?.optionalRelation).toBe("");
    expect(relationship?.optionalExpiresAtUnixSeconds).toBe("1700000000");
    expect(relationship?.optionalCaveat?.caveatName).toBe("only_bizday");
    // A Map becomes a struct; a string is NOT exploded; a nested Map nests.
    expect(relationship?.optionalCaveat?.context).toEqual({
      hour: 9,
      text: "abc",
      nested: { inner: true },
      list: [1, "two"],
      nothing: null,
    });
  });

  it("keeps a non-ellipsis subrelation and omits an absent caveat", async () => {
    const h = harness();
    h.reads.items = [
      {
        relationship: relationshipWire({
          subjectType: "group",
          subjectId: "eng",
          subjectRelation: "member",
        }),
        resumeCursor: "cur",
        readAtToken: "tok",
      },
    ];

    const response = await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ filter: {} }),
    );

    expect(response.relationships[0]?.subject?.optionalRelation).toBe("member");
    expect(response.relationships[0]?.optionalCaveat).toBeUndefined();
    expect(response.relationships[0]?.optionalExpiresAtUnixSeconds).toBe("0");
  });

  it("renders a pre-1970 expiration by truncating toward zero", async () => {
    // BigInt division truncates toward ZERO where `DateTimeOffset.ToUnixTimeSeconds` FLOORS, so
    // -1.5s renders as -1 here and -2 in the C#. Recorded as a deviation; no other path differs.
    const h = harness();
    h.reads.items = [
      {
        relationship: relationshipWire({ expiration: -1_500_000_000n }),
        resumeCursor: "cur",
        readAtToken: "tok",
      },
    ];

    const response = await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ filter: {} }),
    );

    expect(response.relationships[0]?.optionalExpiresAtUnixSeconds).toBe("-1");
  });

  it("renders a context value with no proto counterpart through its string form", async () => {
    // C# `ObjectToValue` falls through to `o.ToString()`; a bigint has no C# counterpart at all,
    // so it takes that same fallback rather than becoming a number (which would lose precision).
    const h = harness();
    h.reads.items = [
      {
        relationship: relationshipWire({
          caveatName: "c",
          caveatContext: new Map<string, unknown>([["big", 9_007_199_254_740_993n]]),
        }),
        resumeCursor: "cur",
        readAtToken: "tok",
      },
    ];

    const response = await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ filter: {} }),
    );

    expect(response.relationships[0]?.optionalCaveat?.context).toEqual({
      big: "9007199254740993",
    });
  });

  it("omits the caveat context entirely when the caveat carries none", async () => {
    const h = harness();
    h.reads.items = [
      {
        relationship: relationshipWire({ caveatName: "c", caveatContext: new Map() }),
        resumeCursor: "cur",
        readAtToken: "tok",
      },
    ];

    const response = await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ filter: {} }),
    );

    expect(response.relationships[0]?.optionalCaveat?.caveatName).toBe("c");
    expect(response.relationships[0]?.optionalCaveat?.context).toBeUndefined();
  });

  it("forwards the caller's cancellation signal to the read stream", async () => {
    const h = harness();
    const controller = new AbortController();

    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ filter: {} }),
      controller.signal,
    );

    expect(h.reads.signals[0]).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------- deleteRelationships

describe("deleteRelationships", () => {
  it("renders the deleted count as a string, exactly, and returns the deleted-at token", async () => {
    const h = harness();
    // Past 2^53: a JS number would round this, so the count must never pass through one.
    h.grain.deleteReply = {
      deletedCount: 9_007_199_254_740_993n,
      reachedLimit: true,
      deletedAtToken: "tok-delete",
    };

    const response = await h.service.deleteRelationships(
      DeleteRelationshipsRequest.fromPartial({ filter: { resourceType: "document" } }),
    );

    expect(response.deletedCount).toBe("9007199254740993");
    expect(response.reachedLimit).toBe(true);
    expect(response.deletedAt).toEqual({ token: "tok-delete" });
  });

  it("treats limit 0 as unbounded and any other limit as a bigint bound", async () => {
    const h = harness();

    await h.service.deleteRelationships(
      DeleteRelationshipsRequest.fromPartial({ filter: {}, optionalLimit: 0 }),
    );
    await h.service.deleteRelationships(
      DeleteRelationshipsRequest.fromPartial({ filter: {}, optionalLimit: 25 }),
    );

    expect(h.grain.deleteArgs[0]?.optionalLimit).toBeUndefined();
    expect(h.grain.deleteArgs[1]?.optionalLimit).toBe(25n);
  });

  it("passes undefined preconditions for an empty list", async () => {
    const h = harness();

    await h.service.deleteRelationships(DeleteRelationshipsRequest.fromPartial({ filter: {} }));

    expect(h.grain.deleteArgs[0]?.preconditions).toBeUndefined();
  });

  it("maps a failed precondition and a shed sequencer commit", async () => {
    const cases: readonly [unknown, status][] = [
      [
        new PreconditionFailedException("mustNotMatchFoundOne", 0, "precondition failed"),
        status.FAILED_PRECONDITION,
      ],
      [new SequencerOverloadedException("shed"), status.RESOURCE_EXHAUSTED],
    ];

    for (const [thrown, expected] of cases) {
      const h = harness();
      h.grain.deleteThrows = thrown;
      const error = await rpcErrorFrom(
        h.service.deleteRelationships(DeleteRelationshipsRequest.fromPartial({ filter: {} })),
      );
      expect(error.code).toBe(expected);
      expect(error.details).toBe((thrown as Error).message);
    }
  });
});

// ---------------------------------------------------------------- expandPermissionTree

describe("expandPermissionTree", () => {
  it("maps RECURSIVE to recursive and every other mode to shallow", async () => {
    const modes: readonly [ExpandPermissionTreeRequest_ExpandMode, string][] = [
      [ExpandPermissionTreeRequest_ExpandMode.EXPAND_MODE_RECURSIVE, "recursive"],
      [ExpandPermissionTreeRequest_ExpandMode.EXPAND_MODE_SHALLOW, "shallow"],
      [ExpandPermissionTreeRequest_ExpandMode.EXPAND_MODE_UNSPECIFIED, "shallow"],
    ];

    for (const [mode, expected] of modes) {
      const h = harness();
      await h.service.expandPermissionTree(
        ExpandPermissionTreeRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
          mode,
        }),
      );
      expect(h.reverseOps.expandArgs[0]?.mode).toBe(expected);
    }
  });

  it("passes the resource, permission and consistency wire, and returns the expanded-at token", async () => {
    const h = harness();
    h.reverseOps.expandReply = { root: leafNode(), expandedAtToken: "tok-expand" };

    const response = await h.service.expandPermissionTree(
      ExpandPermissionTreeRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        consistency: { fullyConsistent: true },
      }),
    );

    expect(h.reverseOps.expandArgs[0]?.resourceType).toBe("document");
    expect(h.reverseOps.expandArgs[0]?.resourceId).toBe("readme");
    expect(h.reverseOps.expandArgs[0]?.permission).toBe("view");
    expect(h.reverseOps.expandArgs[0]?.consistency).toEqual({ mode: "fullyConsistent" });
    expect(response.expandedAt).toEqual({ token: "tok-expand" });
  });

  it("maps a leaf node to the leaf arm, blanking each subject's ellipsis relation", async () => {
    const h = harness();
    h.reverseOps.expandReply = {
      root: leafNode({
        caveatMissingFields: ["hour"],
        subjects: [
          {
            subjectType: "user",
            subjectId: "alice",
            subjectRelation: ELLIPSIS,
            isWildcard: false,
            caveatMissingFields: [],
          },
          {
            subjectType: "group",
            subjectId: "eng",
            subjectRelation: "member",
            isWildcard: false,
            caveatMissingFields: ["region"],
          },
        ],
      }),
      expandedAtToken: "tok",
    };

    const response = await h.service.expandPermissionTree(
      ExpandPermissionTreeRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
      }),
    );

    const root = response.treeRoot;
    expect(root?.expandedObject).toEqual({ objectType: "document", objectId: "readme" });
    expect(root?.expandedRelation).toBe("view");
    expect(root?.caveatMissingFields).toEqual(["hour"]);
    expect(root?.setOp).toBeUndefined();
    expect(root?.leaf?.subjects[0]?.subject?.optionalRelation).toBe("");
    expect(root?.leaf?.subjects[1]?.subject?.optionalRelation).toBe("member");
    expect(root?.leaf?.subjects[1]?.caveatMissingFields).toEqual(["region"]);
  });

  it("maps a set-operation node to the set-op arm, recursively, and maps the operation", async () => {
    const operations: readonly [string, PermissionTreeNode_SetOpNode_Operation][] = [
      ["union", PermissionTreeNode_SetOpNode_Operation.OPERATION_UNION],
      ["intersection", PermissionTreeNode_SetOpNode_Operation.OPERATION_INTERSECTION],
      ["exclusion", PermissionTreeNode_SetOpNode_Operation.OPERATION_EXCLUSION],
    ];

    for (const [wire, expected] of operations) {
      const h = harness();
      h.reverseOps.expandReply = {
        root: leafNode({
          isLeaf: false,
          operation: wire as ExpandTreeNodeWire["operation"],
          children: [leafNode({ expandedId: "child" })],
        }),
        expandedAtToken: "tok",
      };

      const response = await h.service.expandPermissionTree(
        ExpandPermissionTreeRequest.fromPartial({
          resource: { objectType: "document", objectId: "readme" },
          permission: "view",
        }),
      );

      expect(response.treeRoot?.leaf).toBeUndefined();
      expect(response.treeRoot?.setOp?.operation).toBe(expected);
      expect(response.treeRoot?.setOp?.children[0]?.expandedObject?.objectId).toBe("child");
      expect(response.treeRoot?.setOp?.children[0]?.leaf).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------- lookupSubjects

describe("lookupSubjects", () => {
  const request = LookupSubjectsRequest.fromPartial({
    resource: { objectType: "document", objectId: "readme" },
    permission: "view",
    subjectObjectType: "user",
  });

  it("defaults an empty subject relation to the ellipsis and keeps a set one", async () => {
    const h = harness();

    await h.service.lookupSubjects(request);
    await h.service.lookupSubjects(
      LookupSubjectsRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subjectObjectType: "group",
        optionalSubjectRelation: "member",
      }),
    );

    expect(h.reverseOps.lookupSubjectsArgs[0]?.subjectRelation).toBe(ELLIPSIS);
    expect(h.reverseOps.lookupSubjectsArgs[1]?.subjectRelation).toBe("member");
  });

  it("applies the Drain paging contract", async () => {
    const exact = harness();
    exact.reverseOps.subjects = [
      foundSubject("a", "cur-a", "tok"),
      foundSubject("b", "cur-b", "tok"),
    ];
    const exactPage = await exact.service.lookupSubjects(
      LookupSubjectsRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subjectObjectType: "user",
        optionalLimit: 2,
      }),
    );
    expect(exactPage.subjects).toHaveLength(2);
    expect(exactPage.afterResultCursor).toBe("");

    const more = harness();
    more.reverseOps.subjects = [
      foundSubject("a", "cur-a", "tok"),
      foundSubject("b", "cur-b", "tok"),
      foundSubject("c", "cur-c", "tok"),
    ];
    const page = await more.service.lookupSubjects(
      LookupSubjectsRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subjectObjectType: "user",
        optionalLimit: 2,
      }),
    );
    expect(page.subjects.map((s) => s.subjectObjectId)).toEqual(["a", "b"]);
    expect(page.afterResultCursor).toBe("cur-b");
    expect(more.reverseOps.subjectsYielded).toBe(3);
  });

  it("takes looked_up_at from the FIRST item and returns an empty token for an empty page", async () => {
    const h = harness();
    h.reverseOps.subjects = [
      foundSubject("a", "cur-a", "tok-first"),
      foundSubject("b", "cur-b", "tok-second"),
    ];
    expect((await h.service.lookupSubjects(request)).lookedUpAt).toEqual({ token: "tok-first" });

    const empty = harness();
    const emptyPage = await empty.service.lookupSubjects(request);
    expect(emptyPage.lookedUpAt).toEqual({ token: "" });
    expect(emptyPage.subjects).toEqual([]);
  });

  it("maps a found subject, including a caveated one and a wildcard", async () => {
    const h = harness();
    h.reverseOps.subjects = [
      {
        subject: {
          subjectId: "*",
          isWildcard: true,
          permissionship: { isCaveated: false, missingContextParams: [] },
        },
        resumeCursor: "cur-1",
        lookedUpAtToken: "tok",
      },
      {
        subject: {
          subjectId: "alice",
          isWildcard: false,
          permissionship: { isCaveated: true, missingContextParams: ["hour"] },
        },
        resumeCursor: "cur-2",
        lookedUpAtToken: "tok",
      },
    ];

    const response = await h.service.lookupSubjects(request);

    expect(response.subjects[0]?.subjectObjectId).toBe("*");
    expect(response.subjects[0]?.isWildcard).toBe(true);
    expect(response.subjects[0]?.permissionship?.kind).toBe(
      Permissionship_Kind.KIND_HAS_PERMISSION,
    );
    expect(response.subjects[1]?.permissionship?.kind).toBe(
      Permissionship_Kind.KIND_CONDITIONAL_PERMISSION,
    );
    expect(response.subjects[1]?.permissionship?.partialCaveatMissingFields).toEqual(["hour"]);
  });

  it("passes the context, the cursor, the limit, the consistency wire and the signal", async () => {
    const h = harness();
    const controller = new AbortController();

    await h.service.lookupSubjects(
      LookupSubjectsRequest.fromPartial({
        resource: { objectType: "document", objectId: "readme" },
        permission: "view",
        subjectObjectType: "user",
        context: { hour: 9 },
        optionalLimit: 5,
        optionalCursor: "resume",
        consistency: { atExactSnapshot: { token: "zt" } },
      }),
      controller.signal,
    );

    const args = h.reverseOps.lookupSubjectsArgs[0];
    expect(args?.context?.get("hour")).toBe(9);
    expect(args?.limit).toBe(5);
    expect(args?.cursor).toBe("resume");
    expect(args?.consistency).toEqual({ mode: "atExactSnapshot", token: "zt" });
    expect(h.reverseOps.lookupSubjectsSignals[0]).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------- lookupResources

describe("lookupResources", () => {
  const request = LookupResourcesRequest.fromPartial({
    resourceObjectType: "document",
    permission: "view",
    subject: { object: { objectType: "user", objectId: "alice" } },
  });

  it("defaults an empty subject relation to the ellipsis and passes the subject apart", async () => {
    const h = harness();

    await h.service.lookupResources(request);

    const args = h.reverseOps.lookupResourcesArgs[0];
    expect(args?.resourceType).toBe("document");
    expect(args?.permission).toBe("view");
    expect(args?.subjectType).toBe("user");
    expect(args?.subjectId).toBe("alice");
    expect(args?.subjectRelation).toBe(ELLIPSIS);
  });

  it("applies the Drain paging contract, cursoring from after_result_cursor", async () => {
    const h = harness();
    h.reverseOps.resources = [
      foundResource("a", "cur-a", "tok"),
      foundResource("b", "cur-b", "tok"),
      foundResource("c", "cur-c", "tok"),
    ];

    const response = await h.service.lookupResources(
      LookupResourcesRequest.fromPartial({
        resourceObjectType: "document",
        permission: "view",
        subject: { object: { objectType: "user", objectId: "alice" } },
        optionalLimit: 2,
      }),
    );

    expect(response.resources.map((r) => r.resourceObjectId)).toEqual(["a", "b"]);
    expect(response.afterResultCursor).toBe("cur-b");
    expect(h.reverseOps.resourcesYielded).toBe(3);
  });

  it("takes looked_up_at from the FIRST item and returns an empty token for an empty page", async () => {
    const h = harness();
    h.reverseOps.resources = [foundResource("a", "cur-a", "tok-first")];
    expect((await h.service.lookupResources(request)).lookedUpAt).toEqual({ token: "tok-first" });

    const empty = harness();
    expect((await empty.service.lookupResources(request)).lookedUpAt).toEqual({ token: "" });
  });

  it("maps a found resource and its permissionship", async () => {
    const h = harness();
    h.reverseOps.resources = [
      {
        resourceId: "readme",
        permissionship: { isCaveated: true, missingContextParams: ["hour"] },
        afterResultCursor: "cur",
        lookedUpAtToken: "tok",
      },
    ];

    const response = await h.service.lookupResources(request);

    expect(response.resources[0]?.resourceObjectId).toBe("readme");
    expect(response.resources[0]?.permissionship?.kind).toBe(
      Permissionship_Kind.KIND_CONDITIONAL_PERMISSION,
    );
    expect(response.resources[0]?.permissionship?.partialCaveatMissingFields).toEqual(["hour"]);
  });
});
