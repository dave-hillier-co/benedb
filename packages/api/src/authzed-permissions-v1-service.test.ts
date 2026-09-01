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
import { FormatError } from "@benedb/core/format-error";
import { InvalidConsistencyTokenException } from "@benedb/core/invalid-consistency-token-exception";
import { MaxDepthExceededException } from "@benedb/core/max-depth-exceeded-exception";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
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
import { SchemaSnapshot, type ISchemaProvider } from "@benedb/grains/i-schema-provider";
import { PreconditionFailedException } from "@benedb/grains/precondition-failed-exception";
import type { RelationshipReads } from "@benedb/grains/relationship-reads";
import type {
  BulkExportRelationshipsArgs,
  BulkImportRelationshipsArgs,
  BulkImportRelationshipsReply,
  DeleteRelationshipsArgs,
  DeleteRelationshipsReply,
  ReadRelationshipsArgs,
  RelationshipStreamItem,
  RelationshipWire,
  WriteRelationshipsArgs,
  WriteRelationshipsReply,
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
import { SequencerOverloadedException } from "@benedb/grains/sequencer-overloaded-exception";
import { WriteConflictException } from "@benedb/grains/write-conflict-exception";
import {
  AlgebraicSubjectSet_Operation,
  RelationshipUpdate_Operation,
  type Relationship as ProtoRelationship,
} from "@benedb/protos/authzed/api/v1/core";
import {
  CheckBulkPermissionsRequest,
  CheckPermissionRequest,
  CheckPermissionResponse_Permissionship,
  DeleteRelationshipsRequest,
  DeleteRelationshipsResponse_DeletionProgress,
  ExpandPermissionTreeRequest,
  ExportBulkRelationshipsRequest,
  type ExportBulkRelationshipsResponse,
  type ImportBulkRelationshipsRequest,
  LookupPermissionship,
  LookupResourcesRequest,
  type LookupResourcesResponse,
  LookupSubjectsRequest,
  type LookupSubjectsResponse,
  Precondition_Operation,
  ReadRelationshipsRequest,
  type ReadRelationshipsResponse,
  WriteRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { GrainTaskCanceledError } from "@thresh/core/errors";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { describe, expect, it } from "vitest";

import { AuthzedPermissionsV1Service } from "./authzed-permissions-v1-service";
import { RpcError } from "./rpc-error";
import type { ServerStreamWriter } from "./server-stream-writer";

/**
 * Characterization test for `src/Spiceport.Api/AuthzedPermissionsV1Service.cs` - the
 * `authzed.api.v1` compatibility surface `zed` actually calls.
 *
 * SCOPE, deliberately. `tests/Spiceport.Grains.Tests/AuthzedPermissionsV1ServiceTests.cs` (1213
 * lines) drives this file over a live `MeshTestCluster` and is stage S5b's to port; so is
 * `SequencerAdmissionTests.cs` line 134, whose shed-write-to-RESOURCE_EXHAUSTED case is already
 * deferred in `packages/grains/src/sequencer-admission-tests.test.ts`. Neither is restated here.
 * What this file pins instead is what a live mesh cannot easily produce: the proto <-> wire
 * TRANSLATION, the ORDER of the up-front guards, the per-RPC limit/cursor arithmetic, the
 * stream control flow, and the full error table - over fakes of the five collaborators the C#
 * constructor takes (`IPermissionChecker`, `IGrainFactory`, `ReverseOps`, `RelationshipReads`,
 * `ISchemaProvider`).
 *
 * Reading notes for the C# this pins:
 *   * GUARD ORDER in `CheckPermission` (lines 55-80): subject-relation defaulting ->
 *     `RejectWildcardSubject` -> `CheckNamespaceAndRelations(resource, subject)` ->
 *     `ValidateCaveatContextSize` -> dispatch. Each has a DIFFERENT status code, so the order is
 *     observable and is not to be rearranged.
 *   * `PartialCaveatInfo` carries a `min_items=1` repeated field: it is attached only when the
 *     verdict is caveated AND at least one field is missing. An empty one is a proto violation.
 *   * `ToLookupPermissionship` (line 693) maps caveated -> CONDITIONAL and EVERYTHING ELSE ->
 *     HAS_PERMISSION. It never emits UNSPECIFIED and never NO_PERMISSION: a non-member is simply
 *     not streamed.
 *   * LOOKUP RESOURCES: `optional_limit == 0` means unlimited, and cursors are emitted ONLY when a
 *     limit was set (`emitCursors = limit is not null`, mirroring SpiceDB disabling cursors
 *     without a limit). The service counts its own emissions and BREAKS at the cap AFTER writing.
 *   * LOOKUP SUBJECTS: `optional_concrete_limit` caps CONCRETE subjects only
 *     (`if (!s.IsWildcard && ++emitted == limit) break;`), so wildcards are emitted but do not
 *     count; and `optional_cursor` is deliberately IGNORED - the C# passes `null` for it.
 *   * EXPORT BULK: `optional_limit` is the per-message BATCH SIZE (default 1000), not a total cap;
 *     the REQUEST's limit (0 included) is what reaches the read; and the trailing partial batch is
 *     written after the try/catch, INCLUDING after a cancellation.
 *   * `CheckBulkPermissions` (488-606): a per-pair validation failure short-circuits into
 *     `pairErrors[i]` and is NEVER dispatched; only valid items reach `BatchCheck`; verdicts and
 *     errors are then re-interleaved into request order behind a separate `verdictPos` cursor.
 *     When EVERY pair failed validation the grain is not called and NO `CheckedAt` is emitted. An
 *     oversized per-item caveat context is the exception: `ValidateCaveatContextSize` THROWS from
 *     inside the loop and fails the WHOLE request with INVALID_ARGUMENT.
 *   * `RelationshipUpdate` and `Precondition` operation mapping REJECT the unspecified case with
 *     INVALID_ARGUMENT here, unlike the v0 `PermissionsGrpcService`, which silently defaults.
 *     ts-proto decodes an absent enum as 0 = UNSPECIFIED, so this fires for any client that omits
 *     the field.
 *   * `DeleteRelationships` DISCARDS `optional_limit` (it passes `null` to the grain) and discards
 *     the deleted count: the v1 response carries only `deleted_at` in this snapshot.
 *   * `RevisionNotFoundException` maps to INVALID_ARGUMENT on every path, deliberately the same as
 *     an invalid consistency token and never NOT_FOUND.
 *
 * SOURCE CONCERN, reproduced rather than fixed. `ToWire(V1::Relationship)` (line 774) comments
 * "v1 core.proto Relationship has no expiration field in this snapshot" and passes `null`;
 * `ToProto(RelationshipWire)` (783-805) never sets it either. The claim is false - the vendored
 * `authzed/api/v1/core.proto` line 48 declares `google.protobuf.Timestamp optional_expires_at = 5`
 * - so expiration is SILENTLY DROPPED in both directions on the compatibility surface. The port
 * transliterates the drop, and the two cases below pin it so the omission stays deliberate: the
 * generated TS bindings DO carry `optionalExpiresAt`.
 *
 * Port decisions this file also pins, because the C# construct has no TypeScript counterpart:
 *   * STREAMING SEAMS, settled in the batch-4 (`bulk-grpc-service`) port and reused verbatim:
 *     `IServerStreamWriter<T>` becomes {@link ServerStreamWriter}, `IAsyncStreamReader<T>` becomes
 *     a plain `AsyncIterable<T>`, and `ServerCallContext` becomes a trailing `signal?: AbortSignal`
 *     - the only member the C# reads off the context is `CancellationToken`. `@grpc/grpc-js`'s
 *     `ServerWritableStream` / `ServerReadableStream` are adapted onto those seams in `program.ts`.
 *   * `catch (OperationCanceledException) when (ct.IsCancellationRequested)` becomes
 *     `isCancellationError(error) && signal?.aborted === true`, matched on the TYPE and paired with
 *     the same guard: a cancellation raised while the call was NOT cancelled still propagates.
 *   * `num_loaded` is uint64: a ts-proto STRING minted from the reply's `bigint`, never a `number`.
 *   * `partial.Clone()` into the deprecated top-level field becomes a STRUCTURAL copy: ts-proto
 *     messages are plain objects, so writing the same reference twice would alias.
 *   * A `Struct` field arrives auto-unwrapped by ts-proto as a plain object while the grains DTOs
 *     take a `ReadonlyMap`, so the conversion is object <-> Map at every level.
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
  readonly writeArgs: WriteRelationshipsArgs[] = [];
  readonly deleteArgs: DeleteRelationshipsArgs[] = [];
  readonly importArgs: BulkImportRelationshipsArgs[] = [];

  writeReply: WriteRelationshipsReply = { writtenAtToken: "write-token" };
  deleteReply: DeleteRelationshipsReply = {
    deletedCount: 5n,
    reachedLimit: true,
    deletedAtToken: "delete-token",
  };
  importReply: BulkImportRelationshipsReply = { numLoaded: 0n, loadedAtToken: "loaded-token" };
  writeThrows: unknown;
  deleteThrows: unknown;
  importThrows: unknown;

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

  async bulkImportRelationships(
    args: BulkImportRelationshipsArgs,
  ): Promise<BulkImportRelationshipsReply> {
    this.importArgs.push(args);
    if (this.importThrows !== undefined) throw this.importThrows;
    return this.importReply;
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

/**
 * One scripted step of a fake in-process stream. `checkAbort` models the points at which a real
 * stream observes its signal - NOT necessarily between every item, which is what lets the
 * trailing-partial-batch-after-cancel path be exercised.
 */
type Step<T> =
  | { readonly kind: "item"; readonly item: T }
  | { readonly kind: "checkAbort" }
  | { readonly kind: "throw"; readonly error: unknown };

async function* replay<T>(
  steps: readonly Step<T>[],
  signal: AbortSignal | undefined,
  onYield: () => void,
): AsyncGenerator<T> {
  for (const step of steps) {
    if (step.kind === "throw") throw step.error;
    if (step.kind === "checkAbort") {
      signal?.throwIfAborted();
      continue;
    }
    onYield();
    yield step.item;
  }
}

class FakeReverseOps {
  readonly expandArgs: ExpandTreeArgs[] = [];
  readonly lookupSubjectsArgs: LookupSubjectsArgs[] = [];
  readonly lookupResourcesArgs: LookupResourcesArgs[] = [];
  readonly lookupSubjectsSignals: (AbortSignal | undefined)[] = [];
  readonly lookupResourcesSignals: (AbortSignal | undefined)[] = [];

  /** How many items each stream actually yielded - the early-break probe. */
  subjectsYielded = 0;
  resourcesYielded = 0;

  expandReply: ExpandTreeReply = { root: leafNode(), expandedAtToken: "expand-token" };
  expandThrows: unknown;
  subjectSteps: readonly Step<FoundSubjectStreamItem>[] = [];
  resourceSteps: readonly Step<FoundResourceWire>[] = [];

  async expandPermissionTree(args: ExpandTreeArgs): Promise<ExpandTreeReply> {
    this.expandArgs.push(args);
    if (this.expandThrows !== undefined) throw this.expandThrows;
    return this.expandReply;
  }

  streamLookupSubjects(
    args: LookupSubjectsArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<FoundSubjectStreamItem> {
    this.lookupSubjectsArgs.push(args);
    this.lookupSubjectsSignals.push(signal);
    return replay(this.subjectSteps, signal, () => {
      this.subjectsYielded += 1;
    });
  }

  streamLookupResources(
    args: LookupResourcesArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<FoundResourceWire> {
    this.lookupResourcesArgs.push(args);
    this.lookupResourcesSignals.push(signal);
    return replay(this.resourceSteps, signal, () => {
      this.resourcesYielded += 1;
    });
  }
}

class FakeRelationshipReads {
  readonly readArgs: ReadRelationshipsArgs[] = [];
  readonly readSignals: (AbortSignal | undefined)[] = [];
  readonly exportArgs: BulkExportRelationshipsArgs[] = [];
  readonly exportSignals: (AbortSignal | undefined)[] = [];
  readSteps: readonly Step<RelationshipStreamItem>[] = [];
  exportSteps: readonly Step<RelationshipStreamItem>[] = [];

  readRelationships(
    args: ReadRelationshipsArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<RelationshipStreamItem> {
    this.readArgs.push(args);
    this.readSignals.push(signal);
    return replay(this.readSteps, signal, () => {});
  }

  bulkExportRelationships(
    args: BulkExportRelationshipsArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<RelationshipStreamItem> {
    this.exportArgs.push(args);
    this.exportSignals.push(signal);
    return replay(this.exportSteps, signal, () => {});
  }
}

class FakeSchemaProvider implements ISchemaProvider {
  current: SchemaSnapshot = snapshotOf(
    namespaceOf("user"),
    namespaceOf("group", "member"),
    namespaceOf("document", "viewer", "editor", "view"),
  );

  update(): SchemaSnapshot {
    throw new Error("not supported");
  }
}

class CollectingWriter<T> implements ServerStreamWriter<T> {
  readonly collected: T[] = [];
  /** Ran after each write - the hook the C# suite's `CancelAfterFirstStreamWriter` provides. */
  onWrite: ((message: T) => void) | undefined;

  async write(message: T): Promise<void> {
    this.collected.push(message);
    this.onWrite?.(message);
  }
}

interface Harness {
  readonly service: AuthzedPermissionsV1Service;
  readonly checker: FakeChecker;
  readonly grain: FakeRelationshipsGrain;
  readonly grains: FakeGrainFactory;
  readonly reverseOps: FakeReverseOps;
  readonly reads: FakeRelationshipReads;
  readonly schema: FakeSchemaProvider;
}

function harness(): Harness {
  const checker = new FakeChecker();
  const grain = new FakeRelationshipsGrain();
  const grains = new FakeGrainFactory(grain);
  const reverseOps = new FakeReverseOps();
  const reads = new FakeRelationshipReads();
  const schema = new FakeSchemaProvider();
  const service = new AuthzedPermissionsV1Service(
    checker,
    grains,
    reverseOps as unknown as ReverseOps,
    reads as unknown as RelationshipReads,
    schema,
  );
  return { service, checker, grain, grains, reverseOps, reads, schema };
}

// ---------------------------------------------------------------- fixtures

function namespaceOf(name: string, ...relations: readonly string[]): NamespaceDefinition {
  return { name, relations: relations.map((relationName) => ({ name: relationName })) };
}

function snapshotOf(...namespaces: readonly NamespaceDefinition[]): SchemaSnapshot {
  return new SchemaSnapshot({ namespaces, caveats: [] }, "testhash", "", 1);
}

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
  readAtToken?: string,
): RelationshipStreamItem {
  return { relationship: relationshipWire({ resourceId }), resumeCursor: cursor, readAtToken };
}

function foundSubject(
  subjectId: string,
  overrides: Partial<FoundSubjectStreamItem["subject"]> = {},
  token = "subjects-token",
): FoundSubjectStreamItem {
  return {
    subject: {
      subjectId,
      isWildcard: false,
      permissionship: { isCaveated: false, missingContextParams: [] },
      ...overrides,
    },
    resumeCursor: `after-${subjectId}`,
    lookedUpAtToken: token,
  };
}

function foundResource(
  resourceId: string,
  overrides: Partial<FoundResourceWire> = {},
): FoundResourceWire {
  return {
    resourceId,
    permissionship: { isCaveated: false, missingContextParams: [] },
    afterResultCursor: `after-${resourceId}`,
    lookedUpAtToken: "resources-token",
    ...overrides,
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

function protoViewer(docId: string, userId = "alice"): ProtoRelationship {
  return {
    resource: { objectType: "document", objectId: docId },
    relation: "viewer",
    subject: { object: { objectType: "user", objectId: userId }, optionalRelation: "" },
  };
}

async function* streamOf(
  ...messages: readonly ImportBulkRelationshipsRequest[]
): AsyncGenerator<ImportBulkRelationshipsRequest> {
  for (const message of messages) yield message;
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

/** A request-caveat context whose serialized `Struct` exceeds the 4096-byte request limit. */
const OVERSIZED_CONTEXT = { blob: "x".repeat(5000) };

// ---------------------------------------------------------------- checkPermission

describe("checkPermission", () => {
  const checkRequest = (overrides: Record<string, unknown> = {}) =>
    CheckPermissionRequest.fromPartial({
      resource: { objectType: "document", objectId: "readme" },
      permission: "view",
      subject: { object: { objectType: "user", objectId: "alice" } },
      ...overrides,
    });

  it("maps a member verdict to HAS_PERMISSION and mints checked_at from the evaluated token", async () => {
    const h = harness();
    h.checker.result = checkResult("member", [], "tok-1");

    const response = await h.service.checkPermission(checkRequest());

    expect(response.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
    );
    expect(response.checkedAt).toEqual({ token: "tok-1" });
    expect(response.partialCaveatInfo).toBeUndefined();
  });

  it("maps a caveated verdict to CONDITIONAL and attaches the missing context fields", async () => {
    const h = harness();
    h.checker.result = checkResult("caveated", ["hour", "region"]);

    const response = await h.service.checkPermission(checkRequest());

    expect(response.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION,
    );
    expect(response.partialCaveatInfo).toEqual({ missingRequiredContext: ["hour", "region"] });
  });

  it("omits partial_caveat_info for a caveated verdict with NO missing fields (min_items=1)", async () => {
    // `PartialCaveatInfo.missing_required_context` is min_items=1, so an empty one would be a
    // proto violation. The C# guards on `MissingFields.Count > 0`, not on the verdict alone.
    const h = harness();
    h.checker.result = checkResult("caveated", []);

    const response = await h.service.checkPermission(checkRequest());

    expect(response.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION,
    );
    expect(response.partialCaveatInfo).toBeUndefined();
  });

  it("maps every other verdict to NO_PERMISSION and never attaches partial_caveat_info", async () => {
    const h = harness();
    h.checker.result = checkResult("notMember", ["ignored"]);

    const response = await h.service.checkPermission(checkRequest());

    expect(response.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
    );
    expect(response.partialCaveatInfo).toBeUndefined();
  });

  it("defaults an empty subject relation to the ellipsis and keeps a set one", async () => {
    const h = harness();

    await h.service.checkPermission(checkRequest());
    await h.service.checkPermission(
      checkRequest({
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

  it("converts the request context into a Map, nested values included", async () => {
    const h = harness();

    await h.service.checkPermission(
      checkRequest({
        context: { limit: 5, ok: true, nested: { deep: "x" }, list: [1, "two", null] },
      }),
    );

    expect(h.checker.checkCalls[0]?.context).toEqual(
      new Map<string, unknown>([
        ["limit", 5],
        ["ok", true],
        ["nested", new Map<string, unknown>([["deep", "x"]])],
        ["list", [1, "two", null]],
      ]),
    );
  });

  it("passes an absent or empty context through as undefined", async () => {
    const h = harness();

    await h.service.checkPermission(checkRequest());
    await h.service.checkPermission(checkRequest({ context: {} }));

    expect(h.checker.checkCalls[0]?.context).toBeUndefined();
    expect(h.checker.checkCalls[1]?.context).toBeUndefined();
  });

  it("converts each consistency requirement before handing it to the checker", async () => {
    const cases: readonly [Record<string, unknown>, ConsistencyRequirement][] = [
      [{ fullyConsistent: true }, FULLY_CONSISTENT],
      [{ atLeastAsFresh: { token: "t1" } }, atLeastAsFresh({ token: "t1" })],
      [{ atExactSnapshot: { token: "t2" } }, atExactSnapshot({ token: "t2" })],
      [{ minimizeLatency: true }, MINIMIZE_LATENCY],
    ];

    for (const [consistency, expected] of cases) {
      const h = harness();
      await h.service.checkPermission(checkRequest({ consistency }));
      expect(h.checker.checkCalls[0]?.consistency).toEqual(expected);
    }
  });

  it("passes the call's signal through to the checker", async () => {
    const h = harness();
    const controller = new AbortController();

    await h.service.checkPermission(checkRequest(), controller.signal);

    expect(h.checker.checkCalls[0]?.signal).toBe(controller.signal);
  });

  it("rejects a wildcard subject with INVALID_ARGUMENT before touching the schema", async () => {
    // Guard order, first rung: `RejectWildcardSubject` runs BEFORE
    // `CheckNamespaceAndRelations`, so a wildcard subject on an UNKNOWN definition is still
    // INVALID_ARGUMENT and not FAILED_PRECONDITION.
    const h = harness();

    const error = await rpcErrorFrom(
      h.service.checkPermission(
        checkRequest({
          resource: { objectType: "nonesuch", objectId: "readme" },
          subject: { object: { objectType: "user", objectId: "*" } },
        }),
      ),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toContain("cannot perform check on wildcard subject");
    expect(h.checker.checkCalls).toHaveLength(0);
  });

  it("rejects an unknown definition or relation with FAILED_PRECONDITION, before the context size check", async () => {
    // Guard order, second rung: the schema check precedes `ValidateCaveatContextSize`, so an
    // oversized context on an unknown definition still reports the SCHEMA failure.
    const h = harness();

    const unknownDefinition = await rpcErrorFrom(
      h.service.checkPermission(
        checkRequest({
          resource: { objectType: "nonesuch", objectId: "readme" },
          context: OVERSIZED_CONTEXT,
        }),
      ),
    );
    const unknownPermission = await rpcErrorFrom(
      h.service.checkPermission(checkRequest({ permission: "no_such_permission" })),
    );
    const unknownSubjectDefinition = await rpcErrorFrom(
      h.service.checkPermission(
        checkRequest({ subject: { object: { objectType: "ghost", objectId: "alice" } } }),
      ),
    );

    expect(unknownDefinition.code).toBe(status.FAILED_PRECONDITION);
    expect(unknownPermission.code).toBe(status.FAILED_PRECONDITION);
    expect(unknownSubjectDefinition.code).toBe(status.FAILED_PRECONDITION);
    expect(h.checker.checkCalls).toHaveLength(0);
  });

  it("accepts an ellipsis subject relation without a schema lookup", async () => {
    // The subject pair is validated with `AllowEllipsis: true`, so `user` needs no `...` relation
    // declared for the default subject relation to validate.
    const h = harness();

    await expect(h.service.checkPermission(checkRequest())).resolves.toBeDefined();
  });

  it("rejects an oversized request caveat context with INVALID_ARGUMENT, before dispatch", async () => {
    const h = harness();

    const error = await rpcErrorFrom(
      h.service.checkPermission(checkRequest({ context: OVERSIZED_CONTEXT })),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toContain("request caveat context should have less than");
    expect(h.checker.checkCalls).toHaveLength(0);
  });

  it("maps an invalid consistency token and a collected revision both to INVALID_ARGUMENT", async () => {
    const invalid = harness();
    invalid.checker.checkThrows = new InvalidConsistencyTokenException("bad token");
    const collected = harness();
    collected.checker.checkThrows = new RevisionNotFoundException(new TimestampRevision(3n));

    const invalidError = await rpcErrorFrom(invalid.service.checkPermission(checkRequest()));
    const collectedError = await rpcErrorFrom(collected.service.checkPermission(checkRequest()));

    expect(invalidError.code).toBe(status.INVALID_ARGUMENT);
    expect(invalidError.details).toBe("bad token");
    // Deliberately INVALID_ARGUMENT, not NOT_FOUND: the same client-facing contract as an invalid
    // consistency token.
    expect(collectedError.code).toBe(status.INVALID_ARGUMENT);
  });

  it("maps an exhausted recursion budget to FAILED_PRECONDITION, not a NO_PERMISSION verdict", async () => {
    const h = harness();
    h.checker.checkThrows = new MaxDepthExceededException("max depth exceeded");

    const error = await rpcErrorFrom(h.service.checkPermission(checkRequest()));

    expect(error.code).toBe(status.FAILED_PRECONDITION);
  });

  it("splits a caveat-evaluation failure by kind", async () => {
    const mismatch = harness();
    mismatch.checker.checkThrows = new CaveatEvaluationException(
      "parameterTypeMismatch",
      "type mismatch",
    );
    const unknown = harness();
    unknown.checker.checkThrows = new CaveatEvaluationException("unknownCaveat", "no such caveat");

    const mismatchError = await rpcErrorFrom(mismatch.service.checkPermission(checkRequest()));
    const unknownError = await rpcErrorFrom(unknown.service.checkPermission(checkRequest()));

    expect(mismatchError.code).toBe(status.INVALID_ARGUMENT);
    expect(unknownError.code).toBe(status.FAILED_PRECONDITION);
  });

  it("maps every cross-silo dispatch failure code to its gRPC status", async () => {
    const cases: readonly [DispatchErrorCode, status][] = [
      ["unavailable", status.UNAVAILABLE],
      ["cancelled", status.CANCELLED],
      ["deadlineExceeded", status.DEADLINE_EXCEEDED],
      ["internal", status.INTERNAL],
    ];

    for (const [code, expected] of cases) {
      const h = harness();
      h.checker.checkThrows = new DispatchFailedException(code, "boom");
      const error = await rpcErrorFrom(h.service.checkPermission(checkRequest()));
      expect(error.code).toBe(expected);
      expect(error.details).toBe("boom");
    }
  });
});

// ---------------------------------------------------------------- writeRelationships

describe("writeRelationships", () => {
  const update = (
    operation: RelationshipUpdate_Operation,
    relationship: Record<string, unknown> = {},
  ) => ({
    operation,
    relationship: {
      resource: { objectType: "document", objectId: "readme" },
      relation: "viewer",
      subject: { object: { objectType: "user", objectId: "alice" } },
      ...relationship,
    },
  });

  it("routes to the singleton relationships grain and returns its written-at token", async () => {
    const h = harness();
    h.grain.writeReply = { writtenAtToken: "tok-w" };

    const response = await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [update(RelationshipUpdate_Operation.OPERATION_TOUCH)],
      }),
    );

    expect(response.writtenAt).toEqual({ token: "tok-w" });
    expect(h.grains.lookups[0]?.definition).toBe(IRelationshipsGrain);
    expect(h.grains.lookups[0]?.key).toBe(RELATIONSHIPS_GRAIN_KEY);
  });

  it("maps each update operation onto its wire operation, in request order", async () => {
    const h = harness();

    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [
          update(RelationshipUpdate_Operation.OPERATION_CREATE, {
            resource: { objectType: "document", objectId: "a" },
          }),
          update(RelationshipUpdate_Operation.OPERATION_TOUCH, {
            resource: { objectType: "document", objectId: "b" },
          }),
          update(RelationshipUpdate_Operation.OPERATION_DELETE, {
            resource: { objectType: "document", objectId: "c" },
          }),
        ],
      }),
    );

    expect(h.grain.writeArgs[0]?.updates.map((u) => u.operation)).toEqual([
      "create",
      "touch",
      "delete",
    ]);
    expect(h.grain.writeArgs[0]?.updates.map((u) => u.relationship.resourceId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("rejects an UNSPECIFIED update operation with INVALID_ARGUMENT (unlike the v0 surface)", async () => {
    // ts-proto decodes an absent enum as 0 = UNSPECIFIED, so this fires for any client that omits
    // the field. `PermissionsGrpcService` silently defaults instead; the v1 surface does not.
    const h = harness();

    const error = await rpcErrorFrom(
      h.service.writeRelationships(
        WriteRelationshipsRequest.fromPartial({
          updates: [update(RelationshipUpdate_Operation.OPERATION_UNSPECIFIED)],
        }),
      ),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("relationship update operation is unspecified");
    expect(h.grain.writeArgs).toHaveLength(0);
  });

  it("defaults an empty subject relation to the ellipsis and carries the caveat across", async () => {
    const h = harness();

    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [
          update(RelationshipUpdate_Operation.OPERATION_TOUCH),
          update(RelationshipUpdate_Operation.OPERATION_TOUCH, {
            resource: { objectType: "document", objectId: "b" },
            subject: {
              object: { objectType: "group", objectId: "eng" },
              optionalRelation: "member",
            },
            optionalCaveat: { caveatName: "over_limit", context: { limit: 10 } },
          }),
        ],
      }),
    );

    const written = h.grain.writeArgs[0]?.updates ?? [];
    expect(written[0]?.relationship.subjectRelation).toBe(ELLIPSIS);
    expect(written[0]?.relationship.caveatName).toBeUndefined();
    expect(written[0]?.relationship.caveatContext).toBeUndefined();
    expect(written[1]?.relationship.subjectRelation).toBe("member");
    expect(written[1]?.relationship.caveatName).toBe("over_limit");
    expect(written[1]?.relationship.caveatContext).toEqual(new Map([["limit", 10]]));
  });

  it("discards the CONTEXT of an empty-named caveat along with its name", async () => {
    // Name and context come off the SAME `caveatName.length > 0` guard: an empty caveat name is
    // not a valid caveat reference, so its context must not survive as an orphan (issue #42).
    const h = harness();

    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [
          update(RelationshipUpdate_Operation.OPERATION_TOUCH, {
            optionalCaveat: { caveatName: "", context: { limit: 10 } },
          }),
        ],
      }),
    );

    const relationship = h.grain.writeArgs[0]?.updates[0]?.relationship;
    expect(relationship?.caveatName).toBeUndefined();
    expect(relationship?.caveatContext).toBeUndefined();
  });

  it("maps optional_expires_at onto the wire expiration (issue #39)", async () => {
    // `optional_expires_at` is core.proto field 5; a client-supplied expiry must reach the wire
    // as epoch nanos instead of silently storing a time-limited grant as permanent.
    const h = harness();

    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [
          update(RelationshipUpdate_Operation.OPERATION_TOUCH, {
            optionalExpiresAt: new Date("2030-01-01T00:00:00Z"),
          }),
        ],
      }),
    );

    expect(h.grain.writeArgs[0]?.updates[0]?.relationship.expiration).toBe(
      1_893_456_000_000_000_000n,
    );
  });

  it("passes no preconditions as undefined and maps the two specified operations", async () => {
    const h = harness();

    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [update(RelationshipUpdate_Operation.OPERATION_TOUCH)],
      }),
    );
    await h.service.writeRelationships(
      WriteRelationshipsRequest.fromPartial({
        updates: [update(RelationshipUpdate_Operation.OPERATION_TOUCH)],
        optionalPreconditions: [
          {
            operation: Precondition_Operation.OPERATION_MUST_MATCH,
            filter: { resourceType: "document", optionalResourceId: "readme" },
          },
          {
            operation: Precondition_Operation.OPERATION_MUST_NOT_MATCH,
            filter: { resourceType: "document", optionalResourceId: "other" },
          },
        ],
      }),
    );

    expect(h.grain.writeArgs[0]?.preconditions).toBeUndefined();
    expect(h.grain.writeArgs[1]?.preconditions).toEqual([
      {
        operation: "mustMatch",
        filter: {
          resourceType: "document",
          resourceIdPrefix: undefined,
          resourceIds: ["readme"],
          resourceRelation: undefined,
          subjectType: undefined,
          subjectIds: undefined,
          subjectRelation: undefined,
        },
      },
      {
        operation: "mustNotMatch",
        filter: {
          resourceType: "document",
          resourceIdPrefix: undefined,
          resourceIds: ["other"],
          resourceRelation: undefined,
          subjectType: undefined,
          subjectIds: undefined,
          subjectRelation: undefined,
        },
      },
    ]);
  });

  it("rejects an UNSPECIFIED precondition operation with INVALID_ARGUMENT", async () => {
    const h = harness();

    const error = await rpcErrorFrom(
      h.service.writeRelationships(
        WriteRelationshipsRequest.fromPartial({
          updates: [update(RelationshipUpdate_Operation.OPERATION_TOUCH)],
          optionalPreconditions: [
            {
              operation: Precondition_Operation.OPERATION_UNSPECIFIED,
              filter: { resourceType: "document" },
            },
          ],
        }),
      ),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("precondition operation is unspecified");
    expect(h.grain.writeArgs).toHaveLength(0);
  });

  it("validates the request SHAPE before mapping any update", async () => {
    // `RequestLimits.ValidateWriteRelationships` runs first, so a request that is BOTH a duplicate
    // and carries an unspecified operation reports the DUPLICATE.
    const h = harness();

    const error = await rpcErrorFrom(
      h.service.writeRelationships(
        WriteRelationshipsRequest.fromPartial({
          updates: [
            update(RelationshipUpdate_Operation.OPERATION_UNSPECIFIED),
            update(RelationshipUpdate_Operation.OPERATION_UNSPECIFIED),
          ],
        }),
      ),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toContain("more than one update with relationship");
  });

  it("maps a failed precondition, both write conflicts and a shed commit", async () => {
    const cases: readonly [unknown, status][] = [
      [
        new PreconditionFailedException("mustMatchFoundNone", 0, "unsatisfied"),
        status.FAILED_PRECONDITION,
      ],
      // CreateExisting is a PERMANENT duplicate-create the client must not retry as transient;
      // a serialization conflict is a genuine write-write race it retries as a whole tx.
      [new WriteConflictException("createExisting", "already existed"), status.ALREADY_EXISTS],
      [new WriteConflictException("serialization", "conflict"), status.ABORTED],
      [new SequencerOverloadedException("shed"), status.RESOURCE_EXHAUSTED],
    ];

    for (const [thrown, expected] of cases) {
      const h = harness();
      h.grain.writeThrows = thrown;
      const error = await rpcErrorFrom(
        h.service.writeRelationships(
          WriteRelationshipsRequest.fromPartial({
            updates: [update(RelationshipUpdate_Operation.OPERATION_TOUCH)],
          }),
        ),
      );
      expect(error.code).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------- readRelationships

describe("readRelationships", () => {
  it("writes one response per item, each carrying its own read-at token", async () => {
    const h = harness();
    h.reads.readSteps = [
      { kind: "item", item: streamItem("doc1", "c1", "read-token") },
      { kind: "item", item: streamItem("doc2", "c2", "read-token") },
    ];
    const writer = new CollectingWriter<ReadRelationshipsResponse>();

    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType: "document" } }),
      writer,
    );

    expect(writer.collected).toHaveLength(2);
    expect(writer.collected.map((r) => r.relationship?.resource?.objectId)).toEqual([
      "doc1",
      "doc2",
    ]);
    expect(writer.collected.map((r) => r.readAt)).toEqual([
      { token: "read-token" },
      { token: "read-token" },
    ]);
    // The C# never sets after_result_cursor on this RPC.
    expect(writer.collected[0]?.afterResultCursor).toBeUndefined();
  });

  it("renders an ellipsis subject relation as the empty string and populates optional_expires_at", async () => {
    // The second half mirrors the write path's issue #39 fix: `toProtoRelationship` populates
    // `optional_expires_at` from a stored expiry, so it is visible to a v1 client.
    const h = harness();
    h.reads.readSteps = [
      {
        kind: "item",
        item: {
          relationship: relationshipWire({
            caveatName: "over_limit",
            caveatContext: new Map([["limit", 10]]),
            expiration: 1_700_000_000_000_000_000n,
          }),
          resumeCursor: "c1",
          readAtToken: "read-token",
        },
      },
    ];
    const writer = new CollectingWriter<ReadRelationshipsResponse>();

    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType: "document" } }),
      writer,
    );

    const relationship = writer.collected[0]?.relationship;
    expect(relationship?.subject).toEqual({
      object: { objectType: "user", objectId: "alice" },
      optionalRelation: "",
    });
    expect(relationship?.optionalCaveat).toEqual({
      caveatName: "over_limit",
      context: { limit: 10 },
    });
    expect(relationship?.optionalExpiresAt).toEqual(new Date("2023-11-14T22:13:20.000Z"));
  });

  /**
   * `DictToStruct` writes into `Struct.Fields`, an ordinary dictionary, so C# stores a key called
   * `__proto__` like any other. Writing into a JavaScript object LITERAL does not: the assignment
   * hits the inherited setter on `Object.prototype` rather than creating an own property, and the
   * key disappears with no error. Caveat context is user-supplied and is an INPUT TO AN
   * AUTHORIZATION DECISION, so a silently dropped key can change how a caveat evaluates.
   */
  it("keeps a caveat-context key that collides with Object.prototype", async () => {
    const h = harness();
    h.reads.readSteps = [
      {
        kind: "item",
        item: {
          relationship: relationshipWire({
            caveatName: "over_limit",
            caveatContext: new Map<string, unknown>([
              ["__proto__", "polluted"],
              ["constructor", "also-inherited"],
              ["limit", 10],
            ]),
          }),
          resumeCursor: "c1",
          readAtToken: "read-token",
        },
      },
    ];
    const writer = new CollectingWriter<ReadRelationshipsResponse>();

    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType: "document" } }),
      writer,
    );

    const context = writer.collected[0]?.relationship?.optionalCaveat?.context as
      Record<string, unknown> | undefined;
    expect(context).toBeDefined();
    expect(Object.keys(context!).sort()).toEqual(["__proto__", "constructor", "limit"]);
    expect(context!["__proto__"]).toBe("polluted");
    expect(context!["constructor"]).toBe("also-inherited");
  });

  it("wraps the single optional_resource_id in a one-element list and flattens the nested subject filter", async () => {
    const h = harness();
    const writer = new CollectingWriter<ReadRelationshipsResponse>();

    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({
        relationshipFilter: {
          resourceType: "document",
          optionalResourceId: "readme",
          optionalResourceIdPrefix: "read",
          optionalRelation: "viewer",
          optionalSubjectFilter: {
            subjectType: "user",
            optionalSubjectId: "alice",
            optionalRelation: { relation: "member" },
          },
        },
      }),
      writer,
    );

    expect(h.reads.readArgs[0]?.filter).toEqual({
      resourceType: "document",
      resourceIdPrefix: "read",
      resourceIds: ["readme"],
      resourceRelation: "viewer",
      subjectType: "user",
      subjectIds: ["alice"],
      subjectRelation: "member",
    });
  });

  it("treats every empty filter field as absent, at both levels of the subject filter", async () => {
    // `sub.OptionalRelation is { } rf ? NullIfEmpty(rf.Relation) : null` is TWO levels of absence:
    // an absent relation MESSAGE and a present message holding an empty string agree.
    const h = harness();
    const writer = new CollectingWriter<ReadRelationshipsResponse>();

    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({
        relationshipFilter: {
          resourceType: "",
          optionalResourceId: "",
          optionalResourceIdPrefix: "",
          optionalRelation: "",
          optionalSubjectFilter: {
            subjectType: "",
            optionalSubjectId: "",
            optionalRelation: { relation: "" },
          },
        },
      }),
      writer,
    );
    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({
        relationshipFilter: { resourceType: "document" },
      }),
      writer,
    );

    const allAbsent = {
      resourceType: undefined,
      resourceIdPrefix: undefined,
      resourceIds: undefined,
      resourceRelation: undefined,
      subjectType: undefined,
      subjectIds: undefined,
      subjectRelation: undefined,
    };
    expect(h.reads.readArgs[0]?.filter).toEqual(allAbsent);
    expect(h.reads.readArgs[1]?.filter).toEqual({ ...allAbsent, resourceType: "document" });
  });

  it("passes NO limit and NO cursor to the read, whatever the request asked for", async () => {
    // `new ReadRelationshipsArgs(filter, null, null, consistency)`: the v1 request's
    // optional_limit and optional_cursor are read from the wire and then discarded.
    const h = harness();
    const writer = new CollectingWriter<ReadRelationshipsResponse>();

    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({
        relationshipFilter: { resourceType: "document" },
        optionalLimit: 5,
        optionalCursor: { token: "resume-here" },
        consistency: { atLeastAsFresh: { token: "zt" } },
      }),
      writer,
    );

    expect(h.reads.readArgs[0]?.limit).toBeUndefined();
    expect(h.reads.readArgs[0]?.cursor).toBeUndefined();
    expect(h.reads.readArgs[0]?.consistency).toEqual({ mode: "atLeastAsFresh", token: "zt" });
  });

  it("passes the call's signal through to the read", async () => {
    const h = harness();
    const controller = new AbortController();
    const writer = new CollectingWriter<ReadRelationshipsResponse>();

    await h.service.readRelationships(
      ReadRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType: "document" } }),
      writer,
      controller.signal,
    );

    expect(h.reads.readSignals[0]).toBe(controller.signal);
  });

  it("maps an invalid consistency token and a collected revision to INVALID_ARGUMENT", async () => {
    for (const thrown of [
      new InvalidConsistencyTokenException("bad token"),
      new RevisionNotFoundException(new TimestampRevision(3n)),
    ]) {
      const h = harness();
      h.reads.readSteps = [{ kind: "throw", error: thrown }];
      const error = await rpcErrorFrom(
        h.service.readRelationships(
          ReadRelationshipsRequest.fromPartial({
            relationshipFilter: { resourceType: "document" },
          }),
          new CollectingWriter<ReadRelationshipsResponse>(),
        ),
      );
      expect(error.code).toBe(status.INVALID_ARGUMENT);
    }
  });

  it("ends the stream quietly when the client disconnects, keeping what was already written", async () => {
    const h = harness();
    const controller = new AbortController();
    const writer = new CollectingWriter<ReadRelationshipsResponse>();
    writer.onWrite = () => controller.abort();
    h.reads.readSteps = [
      { kind: "item", item: streamItem("doc1", "c1", "t") },
      { kind: "checkAbort" },
      { kind: "item", item: streamItem("doc2", "c2", "t") },
    ];

    await expect(
      h.service.readRelationships(
        ReadRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType: "document" } }),
        writer,
        controller.signal,
      ),
    ).resolves.toBeUndefined();

    expect(writer.collected).toHaveLength(1);
  });

  it("lets a cancellation raised while the call was NOT cancelled propagate", async () => {
    // The C# catch carries `when (context.CancellationToken.IsCancellationRequested)`.
    const h = harness();
    const cancelled = new GrainTaskCanceledError();
    h.reads.readSteps = [{ kind: "throw", error: cancelled }];

    await expect(
      h.service.readRelationships(
        ReadRelationshipsRequest.fromPartial({ relationshipFilter: { resourceType: "document" } }),
        new CollectingWriter<ReadRelationshipsResponse>(),
      ),
    ).rejects.toBe(cancelled);
  });
});

// ---------------------------------------------------------------- deleteRelationships

describe("deleteRelationships", () => {
  it("discards the request limit and the deleted count, returning only deleted_at", async () => {
    // The v1 response carries only `deleted_at` in this snapshot; `optional_limit` is passed to the
    // grain as `null` and `reply.DeletedCount` is dropped on the floor.
    const h = harness();
    h.grain.deleteReply = { deletedCount: 5n, reachedLimit: true, deletedAtToken: "tok-d" };

    const response = await h.service.deleteRelationships(
      DeleteRelationshipsRequest.fromPartial({
        relationshipFilter: { resourceType: "document", optionalResourceId: "readme" },
        optionalLimit: 10,
      }),
    );

    expect(response.deletedAt).toEqual({ token: "tok-d" });
    expect(response.relationshipsDeletedCount).toBe("0");
    expect(response.deletionProgress).toBe(
      DeleteRelationshipsResponse_DeletionProgress.DELETION_PROGRESS_UNSPECIFIED,
    );
    expect(h.grain.deleteArgs[0]?.optionalLimit).toBeUndefined();
    expect(h.grain.deleteArgs[0]?.filter.resourceIds).toEqual(["readme"]);
  });

  it("passes the preconditions through and maps a precondition failure to FAILED_PRECONDITION", async () => {
    const h = harness();
    h.grain.deleteThrows = new PreconditionFailedException("mustNotMatchFoundOne", 0, "matched");

    const error = await rpcErrorFrom(
      h.service.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document" },
          optionalPreconditions: [
            {
              operation: Precondition_Operation.OPERATION_MUST_NOT_MATCH,
              filter: { resourceType: "document", optionalResourceId: "readme" },
            },
          ],
        }),
      ),
    );

    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(h.grain.deleteArgs[0]?.preconditions?.[0]?.operation).toBe("mustNotMatch");
  });

  it("maps a shed delete to RESOURCE_EXHAUSTED", async () => {
    const h = harness();
    h.grain.deleteThrows = new SequencerOverloadedException("shed");

    const error = await rpcErrorFrom(
      h.service.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document" },
        }),
      ),
    );

    expect(error.code).toBe(status.RESOURCE_EXHAUSTED);
  });

  it("does NOT translate a write conflict on the delete path", async () => {
    // `DeleteRelationships` catches only PreconditionFailed and SequencerOverloaded; a
    // `WriteConflictException` escapes untranslated, unlike on the write path. The asymmetry is
    // the C#'s and is reproduced.
    const h = harness();
    const conflict = new WriteConflictException("serialization", "conflict");
    h.grain.deleteThrows = conflict;

    await expect(
      h.service.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType: "document" },
        }),
      ),
    ).rejects.toBe(conflict);
  });
});

// ---------------------------------------------------------------- expandPermissionTree

describe("expandPermissionTree", () => {
  const expandRequest = (overrides: Record<string, unknown> = {}) =>
    ExpandPermissionTreeRequest.fromPartial({
      resource: { objectType: "document", objectId: "readme" },
      permission: "view",
      ...overrides,
    });

  it("validates the resource definition and permission BEFORE dispatching", async () => {
    const h = harness();

    const unknownDefinition = await rpcErrorFrom(
      h.service.expandPermissionTree(
        expandRequest({ resource: { objectType: "nonesuch", objectId: "readme" } }),
      ),
    );
    const unknownPermission = await rpcErrorFrom(
      h.service.expandPermissionTree(expandRequest({ permission: "nope" })),
    );

    expect(unknownDefinition.code).toBe(status.FAILED_PRECONDITION);
    expect(unknownPermission.code).toBe(status.FAILED_PRECONDITION);
    expect(h.reverseOps.expandArgs).toHaveLength(0);
  });

  it("always asks for the RECURSIVE walk: v1 has no mode field", async () => {
    const h = harness();

    await h.service.expandPermissionTree(expandRequest({ consistency: { fullyConsistent: true } }));

    expect(h.reverseOps.expandArgs[0]).toEqual({
      resourceType: "document",
      resourceId: "readme",
      permission: "view",
      mode: "recursive",
      consistency: { mode: "fullyConsistent" },
    });
  });

  it("maps a leaf node onto a DirectSubjectSet, rendering the ellipsis as the empty string", async () => {
    const h = harness();
    h.reverseOps.expandReply = {
      root: leafNode({
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
            caveatMissingFields: [],
          },
        ],
      }),
      expandedAtToken: "tok-e",
    };

    const response = await h.service.expandPermissionTree(expandRequest());

    expect(response.expandedAt).toEqual({ token: "tok-e" });
    expect(response.treeRoot?.expandedObject).toEqual({
      objectType: "document",
      objectId: "readme",
    });
    expect(response.treeRoot?.expandedRelation).toBe("view");
    expect(response.treeRoot?.intermediate).toBeUndefined();
    expect(response.treeRoot?.leaf?.subjects).toEqual([
      { object: { objectType: "user", objectId: "alice" }, optionalRelation: "" },
      { object: { objectType: "group", objectId: "eng" }, optionalRelation: "member" },
    ]);
  });

  it("maps an intermediate node onto an AlgebraicSubjectSet and recurses into its children", async () => {
    const h = harness();
    h.reverseOps.expandReply = {
      root: leafNode({
        isLeaf: false,
        operation: "exclusion",
        children: [
          leafNode({ expandedRelation: "viewer" }),
          leafNode({ expandedRelation: "editor" }),
        ],
      }),
      expandedAtToken: "tok-e",
    };

    const response = await h.service.expandPermissionTree(expandRequest());

    expect(response.treeRoot?.leaf).toBeUndefined();
    expect(response.treeRoot?.intermediate?.operation).toBe(
      AlgebraicSubjectSet_Operation.OPERATION_EXCLUSION,
    );
    expect(response.treeRoot?.intermediate?.children.map((c) => c.expandedRelation)).toEqual([
      "viewer",
      "editor",
    ]);
    expect(response.treeRoot?.intermediate?.children[0]?.leaf).toEqual({ subjects: [] });
  });

  it("maps each set operation onto its proto operation", async () => {
    const cases: readonly [ExpandTreeNodeWire["operation"], AlgebraicSubjectSet_Operation][] = [
      ["union", AlgebraicSubjectSet_Operation.OPERATION_UNION],
      ["intersection", AlgebraicSubjectSet_Operation.OPERATION_INTERSECTION],
      ["exclusion", AlgebraicSubjectSet_Operation.OPERATION_EXCLUSION],
    ];

    for (const [operation, expected] of cases) {
      const h = harness();
      h.reverseOps.expandReply = {
        root: leafNode({ isLeaf: false, operation }),
        expandedAtToken: "tok-e",
      };
      const response = await h.service.expandPermissionTree(expandRequest());
      expect(response.treeRoot?.intermediate?.operation).toBe(expected);
    }
  });

  it("maps the consistency, revision and dispatch failures", async () => {
    const cases: readonly [unknown, status][] = [
      [new InvalidConsistencyTokenException("bad token"), status.INVALID_ARGUMENT],
      [new RevisionNotFoundException(new TimestampRevision(3n)), status.INVALID_ARGUMENT],
      [new DispatchFailedException("unavailable", "boom"), status.UNAVAILABLE],
      [new DispatchFailedException("internal", "boom"), status.INTERNAL],
    ];

    for (const [thrown, expected] of cases) {
      const h = harness();
      h.reverseOps.expandThrows = thrown;
      const error = await rpcErrorFrom(h.service.expandPermissionTree(expandRequest()));
      expect(error.code).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------- lookupResources

describe("lookupResources", () => {
  const lookupRequest = (overrides: Record<string, unknown> = {}) =>
    LookupResourcesRequest.fromPartial({
      resourceObjectType: "document",
      permission: "view",
      subject: { object: { objectType: "user", objectId: "alice" } },
      ...overrides,
    });

  const resourceSteps = (...ids: readonly string[]) =>
    ids.map((id) => ({ kind: "item" as const, item: foundResource(id) }));

  it("streams one response per resource, with the looked-up-at token and HAS_PERMISSION", async () => {
    const h = harness();
    h.reverseOps.resourceSteps = resourceSteps("doc1", "doc2");
    const writer = new CollectingWriter<LookupResourcesResponse>();

    await h.service.lookupResources(lookupRequest(), writer);

    expect(writer.collected.map((r) => r.resourceObjectId)).toEqual(["doc1", "doc2"]);
    expect(writer.collected.map((r) => r.permissionship)).toEqual([
      LookupPermissionship.LOOKUP_PERMISSIONSHIP_HAS_PERMISSION,
      LookupPermissionship.LOOKUP_PERMISSIONSHIP_HAS_PERMISSION,
    ]);
    expect(writer.collected[0]?.lookedUpAt).toEqual({ token: "resources-token" });
  });

  it("maps a caveated resource to CONDITIONAL and attaches its missing context", async () => {
    const h = harness();
    h.reverseOps.resourceSteps = [
      {
        kind: "item",
        item: foundResource("doc1", {
          permissionship: { isCaveated: true, missingContextParams: ["hour"] },
        }),
      },
      {
        kind: "item",
        // Caveated with NOTHING missing: partial_caveat_info is min_items=1, so it stays absent
        // while the permissionship is still CONDITIONAL.
        item: foundResource("doc2", {
          permissionship: { isCaveated: true, missingContextParams: [] },
        }),
      },
    ];
    const writer = new CollectingWriter<LookupResourcesResponse>();

    await h.service.lookupResources(lookupRequest(), writer);

    expect(writer.collected[0]?.permissionship).toBe(
      LookupPermissionship.LOOKUP_PERMISSIONSHIP_CONDITIONAL_PERMISSION,
    );
    expect(writer.collected[0]?.partialCaveatInfo).toEqual({ missingRequiredContext: ["hour"] });
    expect(writer.collected[1]?.permissionship).toBe(
      LookupPermissionship.LOOKUP_PERMISSIONSHIP_CONDITIONAL_PERMISSION,
    );
    expect(writer.collected[1]?.partialCaveatInfo).toBeUndefined();
  });

  it("treats optional_limit == 0 as unlimited and emits NO cursors", async () => {
    // SpiceDB disables cursors entirely when no limit is set, so `emitCursors = limit is not null`
    // even though every item carries an after-result cursor.
    const h = harness();
    h.reverseOps.resourceSteps = resourceSteps("doc1", "doc2", "doc3");
    const writer = new CollectingWriter<LookupResourcesResponse>();

    await h.service.lookupResources(lookupRequest({ optionalLimit: 0 }), writer);

    expect(writer.collected).toHaveLength(3);
    expect(writer.collected.every((r) => r.afterResultCursor === undefined)).toBe(true);
    expect(h.reverseOps.lookupResourcesArgs[0]?.limit).toBeUndefined();
  });

  it("emits cursors and STOPS at the cap once a limit is set", async () => {
    const h = harness();
    h.reverseOps.resourceSteps = resourceSteps("doc1", "doc2", "doc3", "doc4");
    const writer = new CollectingWriter<LookupResourcesResponse>();

    await h.service.lookupResources(lookupRequest({ optionalLimit: 2 }), writer);

    expect(writer.collected.map((r) => r.resourceObjectId)).toEqual(["doc1", "doc2"]);
    expect(writer.collected.map((r) => r.afterResultCursor)).toEqual([
      { token: "after-doc1" },
      { token: "after-doc2" },
    ]);
    // The break happens AFTER the write, so exactly `limit` items were ever pulled.
    expect(h.reverseOps.resourcesYielded).toBe(2);
    expect(h.reverseOps.lookupResourcesArgs[0]?.limit).toBe(2);
  });

  it("omits the cursor on an item that has none, even under a limit", async () => {
    const h = harness();
    h.reverseOps.resourceSteps = [
      { kind: "item", item: foundResource("doc1", { afterResultCursor: "" }) },
    ];
    const writer = new CollectingWriter<LookupResourcesResponse>();

    await h.service.lookupResources(lookupRequest({ optionalLimit: 5 }), writer);

    expect(writer.collected[0]?.afterResultCursor).toBeUndefined();
  });

  it("forwards a non-empty request cursor and drops an empty one", async () => {
    const h = harness();
    const writer = new CollectingWriter<LookupResourcesResponse>();

    await h.service.lookupResources(lookupRequest({ optionalCursor: { token: "resume" } }), writer);
    await h.service.lookupResources(lookupRequest({ optionalCursor: { token: "" } }), writer);
    await h.service.lookupResources(lookupRequest(), writer);

    expect(h.reverseOps.lookupResourcesArgs[0]?.cursor).toBe("resume");
    expect(h.reverseOps.lookupResourcesArgs[1]?.cursor).toBeUndefined();
    expect(h.reverseOps.lookupResourcesArgs[2]?.cursor).toBeUndefined();
  });

  it("defaults the subject relation and passes the whole lookup down", async () => {
    const h = harness();
    const writer = new CollectingWriter<LookupResourcesResponse>();

    await h.service.lookupResources(
      lookupRequest({ context: { limit: 3 }, consistency: { fullyConsistent: true } }),
      writer,
    );

    expect(h.reverseOps.lookupResourcesArgs[0]).toEqual({
      resourceType: "document",
      permission: "view",
      subjectType: "user",
      subjectId: "alice",
      subjectRelation: ELLIPSIS,
      context: new Map([["limit", 3]]),
      limit: undefined,
      cursor: undefined,
      consistency: { mode: "fullyConsistent" },
    });
  });

  it("validates both the resource and the subject pair BEFORE streaming anything", async () => {
    const h = harness();
    const writer = new CollectingWriter<LookupResourcesResponse>();
    h.reverseOps.resourceSteps = resourceSteps("doc1");

    const unknownResource = await rpcErrorFrom(
      h.service.lookupResources(lookupRequest({ resourceObjectType: "nonesuch" }), writer),
    );
    const unknownSubject = await rpcErrorFrom(
      h.service.lookupResources(
        lookupRequest({ subject: { object: { objectType: "ghost", objectId: "alice" } } }),
        writer,
      ),
    );

    expect(unknownResource.code).toBe(status.FAILED_PRECONDITION);
    expect(unknownSubject.code).toBe(status.FAILED_PRECONDITION);
    expect(writer.collected).toHaveLength(0);
    expect(h.reverseOps.lookupResourcesArgs).toHaveLength(0);
  });

  it("rejects an oversized request caveat context with INVALID_ARGUMENT, before the schema check", async () => {
    // Unlike CheckPermission, the context size is validated FIRST here: the C# computes
    // `context5` above the `CheckNamespaceAndRelations` call. An unknown definition with an
    // oversized context therefore reports INVALID_ARGUMENT on this RPC.
    const h = harness();
    const writer = new CollectingWriter<LookupResourcesResponse>();

    const error = await rpcErrorFrom(
      h.service.lookupResources(
        lookupRequest({ resourceObjectType: "nonesuch", context: OVERSIZED_CONTEXT }),
        writer,
      ),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toContain("request caveat context should have less than");
  });

  it("maps the consistency, revision, caveat and dispatch failures", async () => {
    const cases: readonly [unknown, status][] = [
      [new InvalidConsistencyTokenException("bad token"), status.INVALID_ARGUMENT],
      [new RevisionNotFoundException(new TimestampRevision(3n)), status.INVALID_ARGUMENT],
      [new CaveatEvaluationException("parameterTypeMismatch", "bad type"), status.INVALID_ARGUMENT],
      [new CaveatEvaluationException("unknownCaveat", "no caveat"), status.FAILED_PRECONDITION],
      [new DispatchFailedException("deadlineExceeded", "slow"), status.DEADLINE_EXCEEDED],
    ];

    for (const [thrown, expected] of cases) {
      const h = harness();
      h.reverseOps.resourceSteps = [{ kind: "throw", error: thrown }];
      const error = await rpcErrorFrom(
        h.service.lookupResources(lookupRequest(), new CollectingWriter<LookupResourcesResponse>()),
      );
      expect(error.code).toBe(expected);
    }
  });

  it("ends the stream quietly on a client disconnect, and propagates any other cancellation", async () => {
    const disconnected = harness();
    const controller = new AbortController();
    const writer = new CollectingWriter<LookupResourcesResponse>();
    writer.onWrite = () => controller.abort();
    disconnected.reverseOps.resourceSteps = [
      { kind: "item", item: foundResource("doc1") },
      { kind: "checkAbort" },
      { kind: "item", item: foundResource("doc2") },
    ];

    await expect(
      disconnected.service.lookupResources(lookupRequest(), writer, controller.signal),
    ).resolves.toBeUndefined();
    expect(writer.collected).toHaveLength(1);

    const spurious = harness();
    const cancelled = new GrainTaskCanceledError();
    spurious.reverseOps.resourceSteps = [{ kind: "throw", error: cancelled }];
    await expect(
      spurious.service.lookupResources(
        lookupRequest(),
        new CollectingWriter<LookupResourcesResponse>(),
      ),
    ).rejects.toBe(cancelled);
  });
});

// ---------------------------------------------------------------- lookupSubjects

describe("lookupSubjects", () => {
  const lookupRequest = (overrides: Record<string, unknown> = {}) =>
    LookupSubjectsRequest.fromPartial({
      resource: { objectType: "document", objectId: "readme" },
      permission: "view",
      subjectObjectType: "user",
      ...overrides,
    });

  it("populates the modern ResolvedSubject AND the deprecated mirror fields", async () => {
    const h = harness();
    h.reverseOps.subjectSteps = [
      { kind: "item", item: foundSubject("alice") },
      { kind: "item", item: foundSubject("bob") },
    ];
    const writer = new CollectingWriter<LookupSubjectsResponse>();

    await h.service.lookupSubjects(lookupRequest(), writer);

    expect(writer.collected.map((r) => r.subject?.subjectObjectId)).toEqual(["alice", "bob"]);
    expect(writer.collected.map((r) => r.subjectObjectId)).toEqual(["alice", "bob"]);
    expect(writer.collected[0]?.subject?.permissionship).toBe(
      LookupPermissionship.LOOKUP_PERMISSIONSHIP_HAS_PERMISSION,
    );
    expect(writer.collected[0]?.permissionship).toBe(
      LookupPermissionship.LOOKUP_PERMISSIONSHIP_HAS_PERMISSION,
    );
    expect(writer.collected[0]?.lookedUpAt).toEqual({ token: "subjects-token" });
    // The C# never sets after_result_cursor on this RPC.
    expect(writer.collected[0]?.afterResultCursor).toBeUndefined();
  });

  it("writes the partial caveat info into BOTH fields as SEPARATE objects", async () => {
    // The C# writes `partial` into `resp.Subject.PartialCaveatInfo` and `partial.Clone()` into the
    // deprecated top-level field. ts-proto messages are plain objects, so the copy must be
    // structural: sharing one reference would let a later mutation alias both.
    const h = harness();
    h.reverseOps.subjectSteps = [
      {
        kind: "item",
        item: foundSubject("alice", {
          permissionship: { isCaveated: true, missingContextParams: ["hour"] },
        }),
      },
    ];
    const writer = new CollectingWriter<LookupSubjectsResponse>();

    await h.service.lookupSubjects(lookupRequest(), writer);

    const response = writer.collected[0];
    expect(response?.subject?.partialCaveatInfo).toEqual({ missingRequiredContext: ["hour"] });
    expect(response?.partialCaveatInfo).toEqual({ missingRequiredContext: ["hour"] });
    expect(response?.partialCaveatInfo).not.toBe(response?.subject?.partialCaveatInfo);
    expect(response?.partialCaveatInfo?.missingRequiredContext).not.toBe(
      response?.subject?.partialCaveatInfo?.missingRequiredContext,
    );
    expect(response?.subject?.permissionship).toBe(
      LookupPermissionship.LOOKUP_PERMISSIONSHIP_CONDITIONAL_PERMISSION,
    );
  });

  it("omits partial caveat info from both fields when nothing is missing", async () => {
    const h = harness();
    h.reverseOps.subjectSteps = [
      {
        kind: "item",
        item: foundSubject("alice", {
          permissionship: { isCaveated: true, missingContextParams: [] },
        }),
      },
    ];
    const writer = new CollectingWriter<LookupSubjectsResponse>();

    await h.service.lookupSubjects(lookupRequest(), writer);

    expect(writer.collected[0]?.subject?.partialCaveatInfo).toBeUndefined();
    expect(writer.collected[0]?.partialCaveatInfo).toBeUndefined();
  });

  it("counts only CONCRETE subjects against optional_concrete_limit", async () => {
    // `if (!s.IsWildcard && ++emitted == limit) break;` - a wildcard is written but does not count,
    // so a limit of 2 over [wildcard, alice, bob, carol] emits three responses.
    const h = harness();
    h.reverseOps.subjectSteps = [
      { kind: "item", item: foundSubject("*", { isWildcard: true }) },
      { kind: "item", item: foundSubject("alice") },
      { kind: "item", item: foundSubject("bob") },
      { kind: "item", item: foundSubject("carol") },
    ];
    const writer = new CollectingWriter<LookupSubjectsResponse>();

    await h.service.lookupSubjects(lookupRequest({ optionalConcreteLimit: 2 }), writer);

    expect(writer.collected.map((r) => r.subject?.subjectObjectId)).toEqual(["*", "alice", "bob"]);
    expect(h.reverseOps.subjectsYielded).toBe(3);
    expect(h.reverseOps.lookupSubjectsArgs[0]?.limit).toBe(2);
  });

  it("never stops early when no concrete limit was set", async () => {
    // The C# comparison is `++emitted == limit` against a `int?`: a null limit never compares
    // equal. In TypeScript `undefined` must not compare equal to a number either.
    const h = harness();
    h.reverseOps.subjectSteps = ["alice", "bob", "carol"].map((id) => ({
      kind: "item" as const,
      item: foundSubject(id),
    }));
    const writer = new CollectingWriter<LookupSubjectsResponse>();

    await h.service.lookupSubjects(lookupRequest({ optionalConcreteLimit: 0 }), writer);

    expect(writer.collected).toHaveLength(3);
    expect(h.reverseOps.lookupSubjectsArgs[0]?.limit).toBeUndefined();
  });

  it("IGNORES optional_cursor: the walk is always started from the beginning", async () => {
    // The v1 proto documents the field as ignored for LookupSubjects and the C# never reads it.
    const h = harness();
    const writer = new CollectingWriter<LookupSubjectsResponse>();

    await h.service.lookupSubjects(
      lookupRequest({ optionalCursor: { token: "resume-here" } }),
      writer,
    );

    expect(h.reverseOps.lookupSubjectsArgs[0]?.cursor).toBeUndefined();
  });

  it("defaults the subject relation and passes the whole lookup down", async () => {
    const h = harness();
    const writer = new CollectingWriter<LookupSubjectsResponse>();

    await h.service.lookupSubjects(
      lookupRequest({
        context: { limit: 3 },
        consistency: { atExactSnapshot: { token: "zt" } },
      }),
      writer,
    );
    await h.service.lookupSubjects(
      lookupRequest({ subjectObjectType: "group", optionalSubjectRelation: "member" }),
      writer,
    );

    expect(h.reverseOps.lookupSubjectsArgs[0]).toEqual({
      resourceType: "document",
      resourceId: "readme",
      permission: "view",
      subjectType: "user",
      subjectRelation: ELLIPSIS,
      context: new Map([["limit", 3]]),
      limit: undefined,
      cursor: undefined,
      consistency: { mode: "atExactSnapshot", token: "zt" },
    });
    expect(h.reverseOps.lookupSubjectsArgs[1]?.subjectRelation).toBe("member");
  });

  it("validates both pairs before streaming, and the context size before either", async () => {
    const h = harness();
    const writer = new CollectingWriter<LookupSubjectsResponse>();

    const unknownResource = await rpcErrorFrom(
      h.service.lookupSubjects(
        lookupRequest({ resource: { objectType: "nonesuch", objectId: "readme" } }),
        writer,
      ),
    );
    const unknownSubject = await rpcErrorFrom(
      h.service.lookupSubjects(lookupRequest({ subjectObjectType: "ghost" }), writer),
    );
    const oversized = await rpcErrorFrom(
      h.service.lookupSubjects(
        lookupRequest({ subjectObjectType: "ghost", context: OVERSIZED_CONTEXT }),
        writer,
      ),
    );

    expect(unknownResource.code).toBe(status.FAILED_PRECONDITION);
    expect(unknownSubject.code).toBe(status.FAILED_PRECONDITION);
    expect(oversized.code).toBe(status.INVALID_ARGUMENT);
    expect(h.reverseOps.lookupSubjectsArgs).toHaveLength(0);
  });

  it("maps the consistency, revision, caveat and dispatch failures", async () => {
    const cases: readonly [unknown, status][] = [
      [new InvalidConsistencyTokenException("bad token"), status.INVALID_ARGUMENT],
      [new RevisionNotFoundException(new TimestampRevision(3n)), status.INVALID_ARGUMENT],
      [new CaveatEvaluationException("parameterTypeMismatch", "bad type"), status.INVALID_ARGUMENT],
      [new CaveatEvaluationException("unknownCaveat", "no caveat"), status.FAILED_PRECONDITION],
      [new DispatchFailedException("cancelled", "gone"), status.CANCELLED],
    ];

    for (const [thrown, expected] of cases) {
      const h = harness();
      h.reverseOps.subjectSteps = [{ kind: "throw", error: thrown }];
      const error = await rpcErrorFrom(
        h.service.lookupSubjects(lookupRequest(), new CollectingWriter<LookupSubjectsResponse>()),
      );
      expect(error.code).toBe(expected);
    }
  });

  it("ends the stream quietly on a client disconnect, and propagates any other cancellation", async () => {
    const disconnected = harness();
    const controller = new AbortController();
    const writer = new CollectingWriter<LookupSubjectsResponse>();
    writer.onWrite = () => controller.abort();
    disconnected.reverseOps.subjectSteps = [
      { kind: "item", item: foundSubject("alice") },
      { kind: "checkAbort" },
      { kind: "item", item: foundSubject("bob") },
    ];

    await expect(
      disconnected.service.lookupSubjects(lookupRequest(), writer, controller.signal),
    ).resolves.toBeUndefined();
    expect(writer.collected).toHaveLength(1);

    const spurious = harness();
    const cancelled = new GrainTaskCanceledError();
    spurious.reverseOps.subjectSteps = [{ kind: "throw", error: cancelled }];
    await expect(
      spurious.service.lookupSubjects(
        lookupRequest(),
        new CollectingWriter<LookupSubjectsResponse>(),
      ),
    ).rejects.toBe(cancelled);
  });
});

// ---------------------------------------------------------------- checkBulkPermissions

describe("checkBulkPermissions", () => {
  const bulkItem = (
    doc: string,
    permission: string,
    user: string,
    extra: Record<string, unknown> = {},
  ) => ({
    resource: { objectType: "document", objectId: doc },
    permission,
    subject: { object: { objectType: "user", objectId: user } },
    ...extra,
  });

  const verdicts = (
    ...items: readonly {
      verdict: PermissionCheckResult["verdict"];
      missingFields?: readonly string[];
    }[]
  ): BatchCheckResult => ({
    items: items.map((i) => ({ verdict: i.verdict, missingFields: i.missingFields ?? [] })),
    evaluatedRevision: REVISION,
    schemaHash: "hash",
    evaluatedToken: "batch-token",
  });

  it("dispatches every valid pair and echoes each request beside its verdict", async () => {
    const h = harness();
    h.checker.batchResult = verdicts(
      { verdict: "member" },
      { verdict: "notMember" },
      { verdict: "caveated", missingFields: ["hour"] },
    );

    const response = await h.service.checkBulkPermissions(
      CheckBulkPermissionsRequest.fromPartial({
        items: [
          bulkItem("readme", "view", "alice"),
          bulkItem("readme", "view", "bob"),
          bulkItem("other", "view", "carol"),
        ],
      }),
    );

    expect(response.checkedAt).toEqual({ token: "batch-token" });
    expect(response.pairs.map((p) => p.request?.subject?.object?.objectId)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
    expect(response.pairs.map((p) => p.item?.permissionship)).toEqual([
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION,
    ]);
    expect(response.pairs[2]?.item?.partialCaveatInfo).toEqual({
      missingRequiredContext: ["hour"],
    });
    expect(response.pairs.every((p) => p.error === undefined)).toBe(true);
  });

  it("omits partial caveat info from a caveated item with no missing fields", async () => {
    const h = harness();
    h.checker.batchResult = verdicts({ verdict: "caveated", missingFields: [] });

    const response = await h.service.checkBulkPermissions(
      CheckBulkPermissionsRequest.fromPartial({ items: [bulkItem("readme", "view", "alice")] }),
    );

    expect(response.pairs[0]?.item?.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_CONDITIONAL_PERMISSION,
    );
    expect(response.pairs[0]?.item?.partialCaveatInfo).toBeUndefined();
  });

  it("short-circuits a bad pair into THAT pair's error and never dispatches it", async () => {
    // SpiceDB reports a wildcard subject / unknown definition / unknown relation as that pair's
    // google.rpc.Status, not by failing the whole RPC. The verdicts are then re-interleaved back
    // into request order behind a separate cursor, so a valid pair after two bad ones still gets
    // the FIRST dispatched verdict.
    const h = harness();
    h.checker.batchResult = verdicts({ verdict: "member" }, { verdict: "notMember" });

    const response = await h.service.checkBulkPermissions(
      CheckBulkPermissionsRequest.fromPartial({
        items: [
          bulkItem("readme", "view", "*"),
          bulkItem("readme", "nonexistent_perm", "alice"),
          bulkItem("readme", "view", "alice"),
          {
            ...bulkItem("x", "view", "alice"),
            resource: { objectType: "missing_type", objectId: "x" },
          },
          bulkItem("readme", "view", "bob"),
        ],
      }),
    );

    expect(h.checker.batchCalls[0]?.items.map((i) => i.subject.objectId)).toEqual(["alice", "bob"]);
    expect(response.pairs[0]?.error?.code).toBe(status.INVALID_ARGUMENT);
    expect(response.pairs[0]?.error?.message).toContain("cannot perform check on wildcard subject");
    expect(response.pairs[1]?.error?.code).toBe(status.FAILED_PRECONDITION);
    expect(response.pairs[1]?.error?.message).toContain("nonexistent_perm");
    expect(response.pairs[3]?.error?.code).toBe(status.FAILED_PRECONDITION);
    expect(response.pairs[3]?.error?.message).toContain("missing_type");
    expect(response.pairs[2]?.item?.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_HAS_PERMISSION,
    );
    expect(response.pairs[4]?.item?.permissionship).toBe(
      CheckPermissionResponse_Permissionship.PERMISSIONSHIP_NO_PERMISSION,
    );
    expect(response.pairs[0]?.item).toBeUndefined();
  });

  it("emits NO checked-at token and calls nothing when every pair failed validation", async () => {
    const h = harness();

    const response = await h.service.checkBulkPermissions(
      CheckBulkPermissionsRequest.fromPartial({
        items: [bulkItem("readme", "nonexistent_perm", "alice")],
      }),
    );

    expect(response.pairs).toHaveLength(1);
    expect(response.pairs[0]?.error?.code).toBe(status.FAILED_PRECONDITION);
    expect(response.checkedAt).toBeUndefined();
    expect(h.checker.batchCalls).toHaveLength(0);
  });

  it("returns an empty response, with no token and no dispatch, for an empty item list", async () => {
    const h = harness();

    const response = await h.service.checkBulkPermissions(
      CheckBulkPermissionsRequest.fromPartial({ items: [] }),
    );

    expect(response.pairs).toEqual([]);
    expect(response.checkedAt).toBeUndefined();
    expect(h.checker.batchCalls).toHaveLength(0);
  });

  it("fails the WHOLE request on an oversized per-item caveat context", async () => {
    // `ValidateCaveatContextSize` is called inside the loop and THROWS, matching SpiceDB's
    // groupItems/GetCaveatContext, which aborts the entire bulk request.
    const h = harness();

    const error = await rpcErrorFrom(
      h.service.checkBulkPermissions(
        CheckBulkPermissionsRequest.fromPartial({
          items: [
            bulkItem("readme", "view", "alice"),
            bulkItem("readme", "view", "bob", { context: OVERSIZED_CONTEXT }),
          ],
        }),
      ),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toContain("request caveat context should have less than");
    expect(h.checker.batchCalls).toHaveLength(0);
  });

  it("reports an INVALID pair carrying an oversized context as that pair's error, not a whole-request failure", async () => {
    // The size check sits inside the `validItems.Add(...)` construction, so it is only reached for
    // a pair that already passed schema validation.
    const h = harness();

    const response = await h.service.checkBulkPermissions(
      CheckBulkPermissionsRequest.fromPartial({
        items: [bulkItem("readme", "nonexistent_perm", "alice", { context: OVERSIZED_CONTEXT })],
      }),
    );

    expect(response.pairs[0]?.error?.code).toBe(status.FAILED_PRECONDITION);
  });

  it("defaults each item's subject relation and carries its context and the batch consistency", async () => {
    const h = harness();
    h.checker.batchResult = verdicts({ verdict: "member" }, { verdict: "member" });
    const controller = new AbortController();

    await h.service.checkBulkPermissions(
      CheckBulkPermissionsRequest.fromPartial({
        consistency: { atLeastAsFresh: { token: "zt" } },
        items: [
          bulkItem("readme", "view", "alice", { context: { limit: 3 } }),
          {
            resource: { objectType: "document", objectId: "readme" },
            permission: "view",
            subject: {
              object: { objectType: "group", objectId: "eng" },
              optionalRelation: "member",
            },
          },
        ],
      }),
      controller.signal,
    );

    expect(h.checker.batchCalls[0]?.items[0]).toEqual({
      resourceType: "document",
      resourceId: "readme",
      permission: "view",
      subject: { objectType: "user", objectId: "alice", relation: ELLIPSIS },
      caveatContext: new Map([["limit", 3]]),
    });
    expect(h.checker.batchCalls[0]?.items[1]?.subject.relation).toBe("member");
    expect(h.checker.batchCalls[0]?.items[1]?.caveatContext).toBeUndefined();
    expect(h.checker.batchCalls[0]?.consistency).toEqual(atLeastAsFresh({ token: "zt" }));
    expect(h.checker.batchCalls[0]?.signal).toBe(controller.signal);
  });

  it("maps the consistency, revision, caveat and dispatch failures", async () => {
    const cases: readonly [unknown, status][] = [
      [new InvalidConsistencyTokenException("bad token"), status.INVALID_ARGUMENT],
      [new RevisionNotFoundException(new TimestampRevision(3n)), status.INVALID_ARGUMENT],
      [new CaveatEvaluationException("parameterTypeMismatch", "bad type"), status.INVALID_ARGUMENT],
      [new CaveatEvaluationException("unknownCaveat", "no caveat"), status.FAILED_PRECONDITION],
      [new DispatchFailedException("unavailable", "boom"), status.UNAVAILABLE],
    ];

    for (const [thrown, expected] of cases) {
      const h = harness();
      h.checker.batchThrows = thrown;
      const error = await rpcErrorFrom(
        h.service.checkBulkPermissions(
          CheckBulkPermissionsRequest.fromPartial({ items: [bulkItem("readme", "view", "alice")] }),
        ),
      );
      expect(error.code).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------- importBulkRelationships

describe("importBulkRelationships", () => {
  it("buffers the WHOLE stream and commits it in ONE grain call, in stream order", async () => {
    // Real SpiceDB's ImportBulkRelationships is atomic across the entire stream (observed
    // v1.49.2), and one commit is the only shape that reproduces that.
    const h = harness();
    h.grain.importReply = { numLoaded: 3n, loadedAtToken: "tok" };

    const response = await h.service.importBulkRelationships(
      streamOf(
        { relationships: [protoViewer("doc1"), protoViewer("doc2", "bob")] },
        { relationships: [] },
        { relationships: [protoViewer("doc3", "carol")] },
      ),
    );

    expect(h.grain.importArgs).toHaveLength(1);
    expect(h.grain.importArgs[0]?.relationships.map((r) => r.resourceId)).toEqual([
      "doc1",
      "doc2",
      "doc3",
    ]);
    // uint64 on the wire: a ts-proto STRING minted from the reply's bigint, never a JS number.
    expect(response.numLoaded).toBe("3");
  });

  it("short-circuits an empty stream to num_loaded = 0 without calling the grain", async () => {
    const h = harness();

    const empty = await h.service.importBulkRelationships(streamOf());
    const emptyBatches = await h.service.importBulkRelationships(
      streamOf({ relationships: [] }, { relationships: [] }),
    );

    expect(empty.numLoaded).toBe("0");
    expect(emptyBatches.numLoaded).toBe("0");
    expect(h.grain.importArgs).toHaveLength(0);
  });

  it("maps each relationship into the wire form, defaulting the subject relation", async () => {
    const h = harness();
    h.grain.importReply = { numLoaded: 1n, loadedAtToken: "tok" };

    await h.service.importBulkRelationships(
      streamOf({
        relationships: [
          {
            resource: { objectType: "document", objectId: "readme" },
            relation: "viewer",
            subject: { object: { objectType: "user", objectId: "alice" }, optionalRelation: "" },
            optionalCaveat: { caveatName: "over_limit", context: { limit: 10 } },
            optionalExpiresAt: new Date("2030-01-01T00:00:00Z"),
          },
        ],
      }),
    );

    expect(h.grain.importArgs[0]?.relationships[0]).toEqual({
      resourceType: "document",
      resourceId: "readme",
      resourceRelation: "viewer",
      subjectType: "user",
      subjectId: "alice",
      subjectRelation: ELLIPSIS,
      caveatName: "over_limit",
      caveatContext: new Map([["limit", 10]]),
      // Bulk import shares the Permissions mapper, so the issue #39 fix carries the expiry here too.
      expiration: 1_893_456_000_000_000_000n,
    });
  });

  it("maps a duplicate row to ALREADY_EXISTS, a serialization conflict to ABORTED and a shed commit to RESOURCE_EXHAUSTED", async () => {
    const cases: readonly [unknown, status][] = [
      [
        new WriteConflictException("createExisting", "could not CREATE relationship"),
        status.ALREADY_EXISTS,
      ],
      [new WriteConflictException("serialization", "conflict"), status.ABORTED],
      [new SequencerOverloadedException("shed"), status.RESOURCE_EXHAUSTED],
    ];

    for (const [thrown, expected] of cases) {
      const h = harness();
      h.grain.importThrows = thrown;
      const error = await rpcErrorFrom(
        h.service.importBulkRelationships(streamOf({ relationships: [protoViewer("doc1")] })),
      );
      expect(error.code).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------- exportBulkRelationships

describe("exportBulkRelationships", () => {
  const exportSteps = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({
      kind: "item" as const,
      item: streamItem(`doc${from + i}`, `cursor-${from + i}`),
    }));

  it("batches up to optional_limit relationships per message, carrying the last item's cursor", async () => {
    const h = harness();
    h.reads.exportSteps = exportSteps(5);
    const writer = new CollectingWriter<ExportBulkRelationshipsResponse>();

    await h.service.exportBulkRelationships(
      ExportBulkRelationshipsRequest.fromPartial({ optionalLimit: 2 }),
      writer,
    );

    expect(writer.collected.map((p) => p.relationships.length)).toEqual([2, 2, 1]);
    expect(writer.collected.map((p) => p.afterResultCursor)).toEqual([
      { token: "cursor-1" },
      { token: "cursor-3" },
      { token: "cursor-4" },
    ]);
    expect(writer.collected[0]?.relationships[0]?.resource?.objectId).toBe("doc0");
  });

  /**
   * `optional_limit` is a proto uint32 and the C# narrows it with `(int)`. C# is unchecked, so a
   * value above int.MaxValue WRAPS NEGATIVE and the read fails fast. Without the same narrowing the
   * port would instead accept a three-billion limit and try to serve it — a divergence that is not
   * the safer one, whatever else it is.
   */
  it("narrows an out-of-int-range optional_limit exactly as the C# cast does", async () => {
    const h = harness();
    h.reads.exportSteps = exportSteps(1);
    const writer = new CollectingWriter<ExportBulkRelationshipsResponse>();

    await h.service.exportBulkRelationships(
      ExportBulkRelationshipsRequest.fromPartial({ optionalLimit: 2_147_483_648 }),
      writer,
    );

    expect(h.reads.exportArgs[0]?.limit).toBe(-2_147_483_648);
  });

  it("defaults the per-message batch size to 1000 while still passing the REQUEST's limit down", async () => {
    // `optional_limit` is the per-message batch size, not a total cap, and the value handed to the
    // read is the request's own limit (0 included), never the resolved batch size.
    const h = harness();
    h.reads.exportSteps = exportSteps(3);
    const writer = new CollectingWriter<ExportBulkRelationshipsResponse>();

    await h.service.exportBulkRelationships(
      ExportBulkRelationshipsRequest.fromPartial({ optionalLimit: 0 }),
      writer,
    );

    expect(writer.collected).toHaveLength(1);
    expect(writer.collected[0]?.relationships).toHaveLength(3);
    expect(h.reads.exportArgs[0]?.limit).toBe(0);
  });

  it("uses an all-absent filter when the request carries none, and converts one when it does", async () => {
    const h = harness();
    const writer = new CollectingWriter<ExportBulkRelationshipsResponse>();

    await h.service.exportBulkRelationships(
      ExportBulkRelationshipsRequest.fromPartial({ optionalLimit: 2 }),
      writer,
    );
    await h.service.exportBulkRelationships(
      ExportBulkRelationshipsRequest.fromPartial({
        optionalLimit: 2,
        optionalRelationshipFilter: {
          resourceType: "document",
          optionalResourceId: "doc1",
          optionalRelation: "viewer",
        },
      }),
      writer,
    );

    expect(h.reads.exportArgs[0]?.filter).toEqual({
      resourceType: undefined,
      resourceIdPrefix: undefined,
      resourceIds: undefined,
      resourceRelation: undefined,
      subjectType: undefined,
      subjectIds: undefined,
      subjectRelation: undefined,
    });
    expect(h.reads.exportArgs[1]?.filter).toEqual({
      resourceType: "document",
      resourceIdPrefix: undefined,
      resourceIds: ["doc1"],
      resourceRelation: "viewer",
      subjectType: undefined,
      subjectIds: undefined,
      subjectRelation: undefined,
    });
  });

  it("forwards a non-empty cursor, drops an empty one, and converts the consistency", async () => {
    const h = harness();
    const writer = new CollectingWriter<ExportBulkRelationshipsResponse>();

    await h.service.exportBulkRelationships(
      ExportBulkRelationshipsRequest.fromPartial({
        optionalLimit: 2,
        optionalCursor: { token: "resume" },
        consistency: { fullyConsistent: true },
      }),
      writer,
    );
    await h.service.exportBulkRelationships(
      ExportBulkRelationshipsRequest.fromPartial({
        optionalLimit: 2,
        optionalCursor: { token: "" },
      }),
      writer,
    );

    expect(h.reads.exportArgs[0]?.cursor).toBe("resume");
    expect(h.reads.exportArgs[0]?.consistency).toEqual({ mode: "fullyConsistent" });
    expect(h.reads.exportArgs[1]?.cursor).toBeUndefined();
  });

  it("writes the trailing partial batch accumulated BEFORE a cancellation was observed", async () => {
    // The trailing flush sits AFTER the try/catch, so it runs even on the cancellation path.
    // Deliberate, and observable.
    const h = harness();
    const controller = new AbortController();
    const writer = new CollectingWriter<ExportBulkRelationshipsResponse>();
    writer.onWrite = () => controller.abort();
    h.reads.exportSteps = [...exportSteps(3), { kind: "checkAbort" }];

    await h.service.exportBulkRelationships(
      ExportBulkRelationshipsRequest.fromPartial({ optionalLimit: 2 }),
      writer,
      controller.signal,
    );

    expect(writer.collected.map((p) => p.relationships.length)).toEqual([2, 1]);
    expect(writer.collected[1]?.afterResultCursor).toEqual({ token: "cursor-2" });
  });

  it("maps an invalid token, a collected revision and a malformed cursor to INVALID_ARGUMENT", async () => {
    const cases: readonly unknown[] = [
      new InvalidConsistencyTokenException("bad token"),
      new RevisionNotFoundException(new TimestampRevision(3n)),
      // `FormatException` on the export path: what a malformed bulk-export cursor throws.
      new FormatError("invalid bulk export cursor"),
    ];

    for (const thrown of cases) {
      const h = harness();
      h.reads.exportSteps = [{ kind: "throw", error: thrown }];
      const error = await rpcErrorFrom(
        h.service.exportBulkRelationships(
          ExportBulkRelationshipsRequest.fromPartial({ optionalLimit: 2 }),
          new CollectingWriter<ExportBulkRelationshipsResponse>(),
        ),
      );
      expect(error.code).toBe(status.INVALID_ARGUMENT);
    }
  });

  it("lets a cancellation raised while the call was NOT cancelled propagate", async () => {
    const h = harness();
    const cancelled = new GrainTaskCanceledError();
    h.reads.exportSteps = [{ kind: "throw", error: cancelled }];

    await expect(
      h.service.exportBulkRelationships(
        ExportBulkRelationshipsRequest.fromPartial({ optionalLimit: 2 }),
        new CollectingWriter<ExportBulkRelationshipsResponse>(),
      ),
    ).rejects.toBe(cancelled);
  });

  it("renders the exported relationships, including the expiration (issue #39)", async () => {
    const h = harness();
    h.reads.exportSteps = [
      {
        kind: "item",
        item: {
          relationship: relationshipWire({ expiration: 1_700_000_000_000_000_000n }),
          resumeCursor: "cursor-0",
        },
      },
    ];
    const writer = new CollectingWriter<ExportBulkRelationshipsResponse>();

    await h.service.exportBulkRelationships(
      ExportBulkRelationshipsRequest.fromPartial({ optionalLimit: 2 }),
      writer,
    );

    expect(writer.collected[0]?.relationships[0]?.optionalExpiresAt).toEqual(
      new Date("2023-11-14T22:13:20.000Z"),
    );
  });
});
