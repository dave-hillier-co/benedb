import { status } from "@grpc/grpc-js";
import {
  IRelationshipsGrain as IRelationshipsGrainDefinition,
  RELATIONSHIPS_GRAIN_KEY,
} from "@benedb/grains/i-relationships-grain";
import { MutableSchemaProvider } from "@benedb/grains/i-schema-provider";
import type {
  ReadSchemaReply,
  WriteSchemaArgs,
  WriteSchemaReply,
} from "@benedb/grains/relationships-dtos";
import { SchemaWriteValidationException } from "@benedb/grains/schema-write-validation-exception";
import { SequencerOverloadedException } from "@benedb/grains/sequencer-overloaded-exception";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { SchemaCompileException } from "@benedb/schema/schema-compile-exception";
import type {
  ReflectionSchemaDiff,
  ReflectionSchemaFilter,
} from "@benedb/protos/authzed/api/v1/schema_service";
import type { GrainInterface } from "@thresh/core/grain-interface";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { describe, expect, it } from "vitest";

import { AuthzedSchemaV1Service } from "./authzed-schema-v1-service";
import { RpcError } from "./rpc-error";

/**
 * Characterization test for `src/Spiceport.Api/AuthzedSchemaV1Service.cs` - the `authzed.api.v1`
 * SchemaService: two data-plane RPCs over `IRelationshipsGrain` plus four in-process
 * schema-introspection RPCs over `ISchemaProvider.Current`.
 *
 * SCOPE, deliberately. `tests/Spiceport.Grains.Tests/AuthzedSchemaV1ServiceTests.cs` (542 lines)
 * drives this file over a live `MeshTestCluster` - write-then-read round-trips, the orphaning and
 * caveat-parameter write rejections, the expiration-trait cases, and the reflect/diff/computable/
 * dependent happy paths - and is stage S5b's to port; none of its cases is restated here. What a
 * live mesh cannot easily produce, and what this file pins instead, is the ERROR TABLE of each RPC,
 * the SYNCHRONY of the four introspection RPCs, the exhaustiveness of the delta mapping, and the
 * fields the C# deliberately does or does not set - over a fake `IRelationshipsGrain` and a real
 * `MutableSchemaProvider`.
 *
 * Reading notes for the C# this pins:
 *   * EMPTY SCHEMA IS NOT_FOUND (lines 29-33): `string.IsNullOrWhiteSpace(reply.SchemaText)` ->
 *     NOT_FOUND "No schema has been defined". `IsNullOrWhiteSpace` also catches a WHITESPACE-ONLY
 *     schema. The `spiceport.v0` `ReadSchema` deliberately does NOT do this.
 *   * `ReadAt` MUST be populated on ReadSchema even though this snapshot's other v1 schema
 *     responses carry no token: the C# comment says a null token nil-derefs the `zed` backup
 *     client, which reads the schema and then uses this token as the export's
 *     `at_exact_snapshot`. Not to be tidied away.
 *   * WriteSchema error table: `SchemaCompileException` OR `ArgumentException` ->
 *     INVALID_ARGUMENT; `SchemaWriteValidationException` -> FAILED_PRECONDITION;
 *     `SequencerOverloadedException` -> RESOURCE_EXHAUSTED.
 *   * ReflectSchema does NOT reuse `ReflectionMapper.Definition`: it rebuilds the definition inline
 *     so the per-relation and per-permission filters can apply. The duplication is kept, and its
 *     observable consequence is that a definition survives the definition filter even when every
 *     one of its relations and permissions is filtered away.
 *   * DIFFSCHEMA DIRECTION IS existing -> comparison
 *     (`SchemaDiff.Compute(schema.Current.Schema, comparison)`), so added/removed are relative to
 *     the LIVE schema. Reversing it inverts every delta.
 *   * DiffSchema compiles the comparison AND runs the type validator BEFORE diffing, because the
 *     name-keyed diff core would otherwise throw a raw `ArgumentException` on a duplicate
 *     definition. The catch covers all three of `SchemaCompileException`, `SchemaTypeException` and
 *     `ArgumentException` -> INVALID_ARGUMENT.
 *   * SchemaIntrospection error mapping is a THREE-WAY split: `DefinitionNotFound` -> NOT_FOUND,
 *     `RelationNotFound` -> FAILED_PRECONDITION, `NotAPermission` -> INVALID_ARGUMENT, anything
 *     else -> INTERNAL.
 *   * `RelationReferenceProto` sets `is_permission` by a linear scan of the namespace's relations,
 *     defaulting to FALSE when the namespace or the relation is missing (`?? false`). It never
 *     errors.
 *   * `ReflectSchema`, `DiffSchema`, `ComputablePermissions` and `DependentRelations` are
 *     SYNCHRONOUS in the C# (`Task.FromResult`) and read `schema.Current` in process.
 *
 * Port decisions this file also pins, because the C# construct has no TypeScript counterpart:
 *   * `RpcException(new Status(code, detail))` becomes {@link RpcError}; `ServerCallContext`
 *     becomes a trailing optional `signal`, the only member the C# would read off it.
 *   * The four synchronous RPCs keep an `async` SIGNATURE (every sibling service method is
 *     `Promise`-returning) but must have a synchronous BODY: no `await` may interleave between
 *     reading the snapshot and building the response. Two tests below swap the live schema after
 *     the call but before awaiting it, and require the OLD snapshot in the response.
 *   * `MapDelta`'s `switch` over a sealed record hierarchy becomes a switch on the ported
 *     `SchemaDelta`'s `kind` discriminant with a local `assertNever` default. The C# default arm
 *     THROWS `InvalidOperationException` at RUNTIME - it is not exhaustive-checked - so the TS must
 *     both fail the type check and throw at runtime; that throw is NOT mapped to a status code.
 *   * `snapshot.Namespaces.ToImmutableDictionary(n => n.Name)` THROWS on a duplicate key where a
 *     JS `Map` built by insertion would silently keep the last. The snapshot is already validated
 *     so a duplicate cannot occur, but the throw is reproduced rather than papered over - the
 *     ported `SchemaSnapshot` already does exactly this, so building the map through it is enough.
 *   * `ArgumentException` is `@benedb/core`'s {@link InvalidArgumentError} - which is what the
 *     ported `relationships-grain` actually rethrows a schema-compile failure as across the Thresh
 *     call boundary, so that is the type WriteSchema must catch.
 */

// ---------------------------------------------------------------- schemas

const SIMPLE = `definition user {}
definition document {
    relation viewer: user
    permission view = viewer
}`;

const REFLECT = `definition user {}
caveat ip_match(allowed string, user_ip string) {
    user_ip == allowed
}
definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

const COMPUTABLE = `definition user {}
definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
    permission manage = editor
}`;

// ---------------------------------------------------------------- fakes

class FakeRelationshipsGrain {
  readonly writeArgs: WriteSchemaArgs[] = [];
  readSchemaCalls = 0;

  readReply: ReadSchemaReply = { schemaText: SIMPLE, readAtToken: "read-token" };
  writeReply: WriteSchemaReply = { writtenAtToken: "written-token" };
  readThrows: unknown;
  writeThrows: unknown;

  async readSchema(): Promise<ReadSchemaReply> {
    this.readSchemaCalls += 1;
    if (this.readThrows !== undefined) throw this.readThrows;
    return this.readReply;
  }

  async writeSchema(args: WriteSchemaArgs): Promise<WriteSchemaReply> {
    this.writeArgs.push(args);
    if (this.writeThrows !== undefined) throw this.writeThrows;
    return this.writeReply;
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
  readonly service: AuthzedSchemaV1Service;
  readonly grain: FakeRelationshipsGrain;
  readonly grains: FakeGrainFactory;
  readonly schema: MutableSchemaProvider;
}

function harness(schemaText: string = SIMPLE): Harness {
  const grain = new FakeRelationshipsGrain();
  const grains = new FakeGrainFactory(grain);
  const schema = new MutableSchemaProvider(schemaText);
  const service = new AuthzedSchemaV1Service(grains, schema);
  return { service, grain, grains, schema };
}

// ---------------------------------------------------------------- fixtures

function reflectFilter(overrides: Partial<ReflectionSchemaFilter> = {}): ReflectionSchemaFilter {
  return {
    optionalDefinitionNameFilter: "",
    optionalCaveatNameFilter: "",
    optionalRelationNameFilter: "",
    optionalPermissionNameFilter: "",
    ...overrides,
  };
}

/** The `oneof` arm a mapped delta actually set - the C#'s `ReflectionSchemaDiff.DiffCase`. */
function diffCase(diff: ReflectionSchemaDiff): string {
  const set = Object.entries(diff).filter(([, value]) => value !== undefined);
  expect(set).toHaveLength(1);
  return set[0]?.[0] ?? "";
}

function casesOf(diffs: readonly ReflectionSchemaDiff[]): readonly string[] {
  return diffs.map(diffCase);
}

function only(diffs: readonly ReflectionSchemaDiff[], arm: string): ReflectionSchemaDiff[] {
  return diffs.filter((d) => diffCase(d) === arm);
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

// ---------------------------------------------------------------- readSchema

describe("readSchema", () => {
  it("returns the grain's text and ALWAYS populates read_at, routing through the fixed grain key", async () => {
    const h = harness();
    h.grain.readReply = { schemaText: SIMPLE, readAtToken: "read-token" };

    const response = await h.service.readSchema({});

    expect(response.schemaText).toBe(SIMPLE);
    // `read_at` is load-bearing: `zed backup` nil-derefs on a null token.
    expect(response.readAt).toEqual({ token: "read-token" });
    expect(h.grains.lookups).toEqual([
      { definition: IRelationshipsGrainDefinition, key: RELATIONSHIPS_GRAIN_KEY },
    ]);
  });

  it("still populates read_at when the grain's token is EMPTY, rather than omitting the message", async () => {
    const h = harness();
    h.grain.readReply = { schemaText: SIMPLE, readAtToken: "" };

    const response = await h.service.readSchema({});

    expect(response.readAt).toEqual({ token: "" });
  });

  it("maps an EMPTY schema to NOT_FOUND", async () => {
    const h = harness();
    h.grain.readReply = { schemaText: "", readAtToken: "read-token" };

    const error = await rpcErrorFrom(h.service.readSchema({}));

    expect(error.code).toBe(status.NOT_FOUND);
    expect(error.details).toBe("No schema has been defined");
  });

  it("maps a WHITESPACE-ONLY schema to NOT_FOUND too - IsNullOrWhiteSpace, not IsNullOrEmpty", async () => {
    const h = harness();
    h.grain.readReply = { schemaText: " \t\r\n ", readAtToken: "read-token" };

    const error = await rpcErrorFrom(h.service.readSchema({}));

    expect(error.code).toBe(status.NOT_FOUND);
  });

  it("does NOT wrap a grain failure - ReadSchema has no catch at all", async () => {
    const h = harness();
    const boom = new Error("datastore is down");
    h.grain.readThrows = boom;

    await expect(h.service.readSchema({})).rejects.toBe(boom);
  });
});

// ---------------------------------------------------------------- writeSchema

describe("writeSchema", () => {
  it("passes the request's schema text to the grain and returns written_at", async () => {
    const h = harness();

    const response = await h.service.writeSchema({ schema: SIMPLE });

    expect(h.grain.writeArgs).toEqual([{ schemaText: SIMPLE }]);
    expect(response.writtenAt).toEqual({ token: "written-token" });
  });

  it("maps a SchemaCompileException to INVALID_ARGUMENT, carrying the message", async () => {
    const h = harness();
    const compile = new SchemaCompileException("unexpected token");
    h.grain.writeThrows = compile;

    const error = await rpcErrorFrom(h.service.writeSchema({ schema: "bad {{{" }));

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe(compile.message);
  });

  it("maps the ArgumentException the grain rethrows a compile failure as to INVALID_ARGUMENT", async () => {
    // The ported `relationships-grain` catches `SchemaCompileException` and rethrows
    // `InvalidArgumentError` so the failure survives the Thresh call boundary; that is the type
    // this RPC actually sees, and the C#'s `ArgumentException` arm is what catches it.
    const h = harness();
    h.grain.writeThrows = new InvalidArgumentError("schema is malformed");

    const error = await rpcErrorFrom(h.service.writeSchema({ schema: "bad {{{" }));

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("schema is malformed");
  });

  it("maps a SchemaWriteValidationException to FAILED_PRECONDITION", async () => {
    const h = harness();
    h.grain.writeThrows = new SchemaWriteValidationException(
      "cannot delete relation `document#viewer`, as it is referenced by 1 relationship",
    );

    const error = await rpcErrorFrom(h.service.writeSchema({ schema: SIMPLE }));

    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details).toBe(
      "cannot delete relation `document#viewer`, as it is referenced by 1 relationship",
    );
  });

  it("maps a sequencer overload to RESOURCE_EXHAUSTED - retryable, never an opaque timeout", async () => {
    const h = harness();
    h.grain.writeThrows = new SequencerOverloadedException("sequencer is saturated");

    const error = await rpcErrorFrom(h.service.writeSchema({ schema: SIMPLE }));

    expect(error.code).toBe(status.RESOURCE_EXHAUSTED);
    expect(error.details).toBe("sequencer is saturated");
  });

  it("lets any other failure propagate unwrapped", async () => {
    const h = harness();
    const boom = new Error("datastore is down");
    h.grain.writeThrows = boom;

    await expect(h.service.writeSchema({ schema: SIMPLE })).rejects.toBe(boom);
  });
});

// ---------------------------------------------------------------- reflectSchema

describe("reflectSchema", () => {
  function reflectRequest(filters: readonly ReflectionSchemaFilter[] = []) {
    return { optionalFilters: [...filters] };
  }

  it("dumps every definition, split into relations and permissions, plus the caveats", async () => {
    const h = harness(REFLECT);

    const response = await h.service.reflectSchema(reflectRequest());

    expect(response.definitions.map((d) => d.name)).toEqual(["user", "document"]);
    const doc = response.definitions.find((d) => d.name === "document");
    expect(doc?.relations.map((r) => r.name)).toEqual(["viewer", "editor"]);
    expect(doc?.permissions.map((p) => p.name)).toEqual(["view"]);
    expect(doc?.comment).toBe("");

    const viewer = doc?.relations.find((r) => r.name === "viewer");
    expect(viewer?.parentDefinitionName).toBe("document");
    expect(viewer?.subjectTypes).toHaveLength(1);
    expect(viewer?.subjectTypes[0]?.subjectDefinitionName).toBe("user");
    expect(viewer?.subjectTypes[0]?.isTerminalSubject).toBe(true);

    expect(response.caveats.map((c) => c.name)).toEqual(["ip_match"]);
    expect(response.caveats[0]?.parameters.map((p) => `${p.name}:${p.type}`)).toEqual([
      "allowed:string",
      "user_ip:string",
    ]);
    expect(response.caveats[0]?.expression).toContain("user_ip == allowed");
  });

  it("leaves read_at UNSET - unlike ReadSchema, the reflection responses carry no token", async () => {
    const h = harness(REFLECT);

    const response = await h.service.reflectSchema(reflectRequest());

    expect(response.readAt).toBeUndefined();
  });

  it("applies a definition-name PREFIX filter, and a definition filter admits no caveats", async () => {
    const h = harness(REFLECT);

    const response = await h.service.reflectSchema(
      reflectRequest([reflectFilter({ optionalDefinitionNameFilter: "doc" })]),
    );

    expect(response.definitions.map((d) => d.name)).toEqual(["document"]);
    expect(response.caveats).toEqual([]);
  });

  it("still emits a matched definition whose relations and permissions were ALL filtered away", async () => {
    // This is why ReflectSchema rebuilds the definition inline instead of reusing
    // `ReflectionMapper.Definition`: the per-member filters run inside the definition loop, and the
    // definition is added regardless of what survived them.
    const h = harness(REFLECT);

    const response = await h.service.reflectSchema(
      reflectRequest([
        reflectFilter({
          optionalDefinitionNameFilter: "document",
          optionalRelationNameFilter: "nonexistent",
        }),
      ]),
    );

    const doc = response.definitions.find((d) => d.name === "document");
    expect(doc).toBeDefined();
    expect(doc?.relations).toEqual([]);
    // A relation-scoped filter excludes permissions outright.
    expect(doc?.permissions).toEqual([]);
  });

  it("filters relations and permissions independently within a matched definition", async () => {
    const h = harness(REFLECT);

    const relationOnly = await h.service.reflectSchema(
      reflectRequest([
        reflectFilter({
          optionalDefinitionNameFilter: "document",
          optionalRelationNameFilter: "view",
        }),
      ]),
    );
    const permissionOnly = await h.service.reflectSchema(
      reflectRequest([
        reflectFilter({
          optionalDefinitionNameFilter: "document",
          optionalPermissionNameFilter: "view",
        }),
      ]),
    );

    expect(relationOnly.definitions[0]?.relations.map((r) => r.name)).toEqual(["viewer"]);
    expect(relationOnly.definitions[0]?.permissions).toEqual([]);
    expect(permissionOnly.definitions[0]?.relations).toEqual([]);
    expect(permissionOnly.definitions[0]?.permissions.map((p) => p.name)).toEqual(["view"]);
  });

  it("applies a caveat-name filter, which admits no definitions", async () => {
    const h = harness(REFLECT);

    const response = await h.service.reflectSchema(
      reflectRequest([reflectFilter({ optionalCaveatNameFilter: "ip" })]),
    );

    expect(response.definitions).toEqual([]);
    expect(response.caveats.map((c) => c.name)).toEqual(["ip_match"]);
  });

  it("rejects a mutually exclusive filter with INVALID_ARGUMENT before touching the snapshot", async () => {
    const h = harness(REFLECT);

    const error = await rpcErrorFrom(
      h.service.reflectSchema(
        reflectRequest([
          reflectFilter({
            optionalDefinitionNameFilter: "document",
            optionalCaveatNameFilter: "ip",
          }),
        ]),
      ),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
  });

  it("reads the snapshot SYNCHRONOUSLY - a schema swap before the await cannot be observed", async () => {
    const h = harness(REFLECT);

    const pending = h.service.reflectSchema(reflectRequest());
    h.schema.update("definition somethingelse {}");
    const response = await pending;

    expect(response.definitions.map((d) => d.name)).toEqual(["user", "document"]);
  });
});

// ---------------------------------------------------------------- diffSchema

describe("diffSchema", () => {
  it("yields NO diffs for an identical comparison schema", async () => {
    const h = harness(REFLECT);

    const response = await h.service.diffSchema({ comparisonSchema: REFLECT });

    expect(response.diffs).toEqual([]);
    expect(response.readAt).toBeUndefined();
  });

  it("diffs existing -> comparison, so added/removed are relative to the LIVE schema", async () => {
    const existing = `definition user {}
definition legacydef {}
definition document {
    relation viewer: user
}`;
    const comparison = `definition user {}
definition folder {}
definition document {
    relation viewer: user
}`;
    const h = harness(existing);

    const response = await h.service.diffSchema({ comparisonSchema: comparison });

    // `folder` exists only in the COMPARISON, so it is ADDED; `legacydef` only in the live schema,
    // so it is REMOVED. Reversing the direction would invert both.
    expect(only(response.diffs, "definitionAdded")[0]?.definitionAdded?.name).toBe("folder");
    expect(only(response.diffs, "definitionRemoved")[0]?.definitionRemoved?.name).toBe("legacydef");
  });

  it("maps the definition / relation / permission delta arms", async () => {
    const existing = `definition user {}
definition group {
    relation member: user
}
definition document {
    relation viewer: user
    relation editor: user | group#member
    relation legacy: user
    permission view = viewer
    permission manage = editor
}`;
    const comparison = `definition user {}
definition group {
    relation member: user
}
definition document {
    relation viewer: user | group#member
    relation editor: user
    relation owner: user
    permission view = viewer + editor
    permission admin = owner
}`;
    const h = harness(existing);

    const response = await h.service.diffSchema({ comparisonSchema: comparison });
    const cases = casesOf(response.diffs);

    expect(cases).toContain("relationAdded");
    expect(only(response.diffs, "relationAdded")[0]?.relationAdded?.name).toBe("owner");
    expect(only(response.diffs, "relationAdded")[0]?.relationAdded?.parentDefinitionName).toBe(
      "document",
    );

    expect(only(response.diffs, "relationRemoved")[0]?.relationRemoved?.name).toBe("legacy");
    expect(only(response.diffs, "permissionAdded")[0]?.permissionAdded?.name).toBe("admin");
    expect(only(response.diffs, "permissionRemoved")[0]?.permissionRemoved?.name).toBe("manage");
    expect(only(response.diffs, "permissionExprChanged")[0]?.permissionExprChanged?.name).toBe(
      "view",
    );

    const added = only(response.diffs, "relationSubjectTypeAdded")[0]?.relationSubjectTypeAdded;
    expect(added?.relation?.name).toBe("viewer");
    expect(added?.changedSubjectType?.subjectDefinitionName).toBe("group");
    expect(added?.changedSubjectType?.optionalRelationName).toBe("member");

    const removed = only(response.diffs, "relationSubjectTypeRemoved")[0]
      ?.relationSubjectTypeRemoved;
    expect(removed?.relation?.name).toBe("editor");
    expect(removed?.changedSubjectType?.subjectDefinitionName).toBe("group");
  });

  it("maps the caveat delta arms, including the parameter type change's previous type", async () => {
    const existing = `definition user {}
caveat gone(a int) { a > 0 }
caveat grew(a int) { a > 0 }
caveat shrank(a int, b int) { a > 0 && b > 0 }
caveat retyped(a int) { a > 0 }`;
    const comparison = `definition user {}
caveat added(x int) { x > 0 }
caveat grew(a int, b int) { a > 0 && b > 0 }
caveat shrank(a int) { a > 0 }
caveat retyped(a string) { a == "yes" }`;
    const h = harness(existing);

    const response = await h.service.diffSchema({ comparisonSchema: comparison });

    expect(only(response.diffs, "caveatAdded")[0]?.caveatAdded?.name).toBe("added");
    expect(only(response.diffs, "caveatRemoved")[0]?.caveatRemoved?.name).toBe("gone");

    const paramAdded = only(response.diffs, "caveatParameterAdded")[0]?.caveatParameterAdded;
    expect(paramAdded?.name).toBe("b");
    expect(paramAdded?.parentCaveatName).toBe("grew");
    expect(paramAdded?.type).toBe("int");

    const paramRemoved = only(response.diffs, "caveatParameterRemoved")[0]?.caveatParameterRemoved;
    expect(paramRemoved?.name).toBe("b");
    expect(paramRemoved?.parentCaveatName).toBe("shrank");

    const retyped = only(response.diffs, "caveatParameterTypeChanged")[0]
      ?.caveatParameterTypeChanged;
    expect(retyped?.parameter?.name).toBe("a");
    expect(retyped?.parameter?.type).toBe("string");
    // The previous type is rendered through `ReflectionMapper.TypeString`, not a proto message.
    expect(retyped?.previousType).toBe("int");

    expect(casesOf(response.diffs)).toContain("caveatExprChanged");
  });

  it("sets exactly ONE oneof arm on every emitted diff", async () => {
    const h = harness(COMPUTABLE);

    const response = await h.service.diffSchema({
      comparisonSchema: `definition user {}
definition folder {}
definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer
}`,
    });

    expect(response.diffs.length).toBeGreaterThan(0);
    // `diffCase` itself asserts single-arm-ness on each diff.
    for (const diff of response.diffs) expect(diffCase(diff)).not.toBe("");
  });

  it("maps an uncompilable comparison schema to INVALID_ARGUMENT", async () => {
    const h = harness(REFLECT);

    const error = await rpcErrorFrom(
      h.service.diffSchema({ comparisonSchema: "definition {{{ bad" }),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
  });

  it("maps a TYPE-INVALID comparison schema to INVALID_ARGUMENT, before the diff core runs", async () => {
    // The validator runs up front so the name-keyed diff core never sees a schema it cannot key.
    const h = harness(REFLECT);

    const error = await rpcErrorFrom(
      h.service.diffSchema({
        comparisonSchema: `definition user {}
definition document {
    permission view = nonexistent
}`,
      }),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
  });

  it("maps a DUPLICATE definition in the comparison schema to INVALID_ARGUMENT, never a raw throw", async () => {
    const h = harness(REFLECT);

    const error = await rpcErrorFrom(
      h.service.diffSchema({
        comparisonSchema: `definition user {}
definition user {}`,
      }),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
  });

  it("reads the LIVE snapshot SYNCHRONOUSLY - a schema swap before the await cannot be observed", async () => {
    const h = harness(SIMPLE);

    const pending = h.service.diffSchema({ comparisonSchema: SIMPLE });
    h.schema.update("definition user {}");
    const response = await pending;

    // Diffed against the snapshot as it was at call time, so identical means no deltas.
    expect(response.diffs).toEqual([]);
  });
});

// ---------------------------------------------------------------- computablePermissions

describe("computablePermissions", () => {
  function computableRequest(definitionName: string, relationName: string, filter = "") {
    return { definitionName, relationName, optionalDefinitionNameFilter: filter };
  }

  it("returns the permissions reachable from a relation, each flagged is_permission", async () => {
    const h = harness(COMPUTABLE);

    const viewer = await h.service.computablePermissions(computableRequest("document", "viewer"));
    const editor = await h.service.computablePermissions(computableRequest("document", "editor"));

    expect(viewer.permissions.map((p) => p.relationName)).toEqual(["view"]);
    expect(viewer.permissions.every((p) => p.isPermission)).toBe(true);
    expect(viewer.permissions[0]?.definitionName).toBe("document");
    expect(editor.permissions.map((p) => p.relationName)).toEqual(["manage", "view"]);
    expect(viewer.readAt).toBeUndefined();
  });

  it("treats an EMPTY optional_definition_name_filter as NO filter", async () => {
    const h = harness(COMPUTABLE);

    const unfiltered = await h.service.computablePermissions(
      computableRequest("document", "viewer", ""),
    );
    const filteredOut = await h.service.computablePermissions(
      computableRequest("document", "viewer", "nomatch"),
    );

    expect(unfiltered.permissions).toHaveLength(1);
    expect(filteredOut.permissions).toEqual([]);
  });

  it("maps an unknown DEFINITION to NOT_FOUND", async () => {
    const h = harness(COMPUTABLE);

    const error = await rpcErrorFrom(
      h.service.computablePermissions(computableRequest("missing", "viewer")),
    );

    expect(error.code).toBe(status.NOT_FOUND);
    expect(error.details).toBe("object definition `missing` not found");
  });

  it("maps an unknown RELATION to FAILED_PRECONDITION - a different arm from the definition case", async () => {
    const h = harness(COMPUTABLE);

    const error = await rpcErrorFrom(
      h.service.computablePermissions(computableRequest("document", "nope")),
    );

    expect(error.code).toBe(status.FAILED_PRECONDITION);
  });

  it("reads the snapshot SYNCHRONOUSLY - a schema swap before the await cannot be observed", async () => {
    const h = harness(COMPUTABLE);

    const pending = h.service.computablePermissions(computableRequest("document", "viewer"));
    h.schema.update("definition user {}");
    const response = await pending;

    expect(response.permissions.map((p) => p.relationName)).toEqual(["view"]);
  });
});

// ---------------------------------------------------------------- dependentRelations

describe("dependentRelations", () => {
  it("returns the relations a permission depends on, flagged is_permission FALSE", async () => {
    const h = harness(COMPUTABLE);

    const response = await h.service.dependentRelations({
      definitionName: "document",
      permissionName: "view",
    });

    expect([...response.relations].map((r) => r.relationName).sort()).toEqual(["editor", "viewer"]);
    expect(response.relations.every((r) => !r.isPermission)).toBe(true);
    expect(response.readAt).toBeUndefined();
  });

  it("flags is_permission per reference by scanning the referenced namespace's relations", async () => {
    const arrows = `definition user {}
definition folder {
    relation viewer: user
    permission view = viewer
}
definition document {
    relation viewer: user
    relation parent: folder
    permission view = viewer + parent->view
}`;
    const h = harness(arrows);

    const response = await h.service.dependentRelations({
      definitionName: "document",
      permissionName: "view",
    });

    const byKey = new Map(
      response.relations.map((r) => [`${r.definitionName}#${r.relationName}`, r.isPermission]),
    );
    expect(byKey.get("document#parent")).toBe(false);
    expect(byKey.get("folder#viewer")).toBe(false);
    // A reference that IS a permission in its own namespace comes back flagged.
    expect(byKey.get("folder#view")).toBe(true);
  });

  it("maps a BASE RELATION target to INVALID_ARGUMENT - the third arm of the split", async () => {
    const h = harness(COMPUTABLE);

    const error = await rpcErrorFrom(
      h.service.dependentRelations({ definitionName: "document", permissionName: "viewer" }),
    );

    expect(error.code).toBe(status.INVALID_ARGUMENT);
  });

  it("maps an unknown DEFINITION to NOT_FOUND", async () => {
    const h = harness(COMPUTABLE);

    const error = await rpcErrorFrom(
      h.service.dependentRelations({ definitionName: "missing", permissionName: "view" }),
    );

    expect(error.code).toBe(status.NOT_FOUND);
  });

  it("maps an unknown PERMISSION to FAILED_PRECONDITION", async () => {
    const h = harness(COMPUTABLE);

    const error = await rpcErrorFrom(
      h.service.dependentRelations({ definitionName: "document", permissionName: "nope" }),
    );

    expect(error.code).toBe(status.FAILED_PRECONDITION);
  });

  it("reads the snapshot SYNCHRONOUSLY - a schema swap before the await cannot be observed", async () => {
    const h = harness(COMPUTABLE);

    const pending = h.service.dependentRelations({
      definitionName: "document",
      permissionName: "view",
    });
    h.schema.update("definition user {}");
    const response = await pending;

    expect(response.relations).toHaveLength(2);
  });
});
