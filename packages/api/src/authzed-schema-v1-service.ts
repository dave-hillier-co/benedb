import { status } from "@grpc/grpc-js";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { isPermission } from "@benedb/core/relation";
import type { RelationReference } from "@benedb/engine/relation-reference";
import {
  computablePermissions as introspectComputablePermissions,
  dependentRelations as introspectDependentRelations,
} from "@benedb/engine/schema-introspection";
import { SchemaIntrospectionException } from "@benedb/engine/schema-introspection-exception";
import { SchemaTypeException } from "@benedb/engine/schema-type-exception";
import { validateSchemaTypes } from "@benedb/engine/schema-type-validator";
import type { IRelationshipsGrain } from "@benedb/grains/i-relationships-grain";
import {
  IRelationshipsGrain as IRelationshipsGrainDefinition,
  RELATIONSHIPS_GRAIN_KEY,
} from "@benedb/grains/i-relationships-grain";
import type { ISchemaProvider } from "@benedb/grains/i-schema-provider";
import type { SchemaDelta } from "@benedb/grains/schema-diff";
import { computeSchemaDiff } from "@benedb/grains/schema-diff";
import { SchemaWriteValidationException } from "@benedb/grains/schema-write-validation-exception";
import { SequencerOverloadedException } from "@benedb/grains/sequencer-overloaded-exception";
import type {
  ComputablePermissionsRequest,
  ComputablePermissionsResponse,
  DependentRelationsRequest,
  DependentRelationsResponse,
  DiffSchemaRequest,
  DiffSchemaResponse,
  ReadSchemaRequest,
  ReadSchemaResponse,
  ReflectionDefinition,
  ReflectionRelationReference,
  ReflectionSchemaDiff,
  ReflectSchemaRequest,
  ReflectSchemaResponse,
  WriteSchemaRequest,
  WriteSchemaResponse,
} from "@benedb/protos/authzed/api/v1/schema_service";
import type { CompiledSchema } from "@benedb/schema/compiled-schema";
import { SchemaCompileException } from "@benedb/schema/schema-compile-exception";
import { compileSchema } from "@benedb/schema/schema-compiler";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";

import {
  caveatTypeString,
  reflectionCaveat,
  reflectionCaveatParameter,
  reflectionDefinition,
  reflectionPermission,
  reflectionRelation,
  reflectionTypeReference,
} from "./reflection-mapper";
import { RpcError } from "./rpc-error";
import { schemaFiltersFromRequest } from "./schema-filters";

/**
 * Port of Spiceport `src/Spiceport.Api/AuthzedSchemaV1Service.cs`: the gRPC front door for
 * `authzed.api.v1.SchemaService`. ReadSchema/WriteSchema are pure translation over the data-plane
 * `IRelationshipsGrain`. The schema-introspection RPCs (ReflectSchema/DiffSchema/
 * ComputablePermissions/DependentRelations) operate on the in-process compiled schema via
 * `ISchemaProvider.current`, reusing the Core model, the shared `computeSchemaDiff` core, the
 * reachability graph, and `reflection-mapper.ts`. The v1 responses in this snapshot carry no
 * ZedToken (`read_at` is left unset) EXCEPT ReadSchema's, which is load-bearing.
 *
 * Port decisions (the C# constructs with no TypeScript counterpart):
 *   * `RpcException(new Status(code, detail))` becomes {@link RpcError}; `ServerCallContext`
 *     becomes a trailing `signal?: AbortSignal`, the only member the C# would read off it.
 *   * The four introspection RPCs are `Task.FromResult` in C#: SYNCHRONOUS bodies behind a
 *     `Task`-returning signature. They keep an `async` signature here (every sibling method is
 *     `Promise`-returning) but their bodies contain NO `await`, so no interleaving can occur
 *     between reading the snapshot and building the response - which is the behaviour, not a
 *     detail.
 *   * `MapDelta`'s `switch` over a sealed record hierarchy with positional deconstruction becomes
 *     a switch on the ported `SchemaDelta`'s `kind` discriminant. The C# default arm is NOT
 *     exhaustive-checked and THROWS `InvalidOperationException` at runtime, so the port both fails
 *     the type check ({@link assertNeverSchemaDelta} takes `never`) and throws at runtime. That
 *     throw is mapped to no status code and would surface as UNKNOWN/INTERNAL, as in the C#.
 *   * `ToImmutableDictionary(n => n.Name)` THROWS on a duplicate key where a `Map` built by
 *     insertion would silently keep the last; {@link namespacesByName} reproduces the throw, as
 *     `check-grain.ts` and `i-schema-provider.ts` do.
 *   * `catch (ex is SchemaCompileException or ArgumentException)`: the ported `relationships-grain`
 *     rethrows a schema-compile failure as `@benedb/core`'s {@link InvalidArgumentError} so it
 *     survives the Thresh call boundary, so that is what the `ArgumentException` arm catches.
 *     DiffSchema's filter adds `SchemaTypeException`, thrown by the up-front validator.
 *   * `string.IsNullOrWhiteSpace` is `trim() === ""` (JS `trim` and .NET whitespace differ on a
 *     few exotic code points; irrelevant in practice), never a length test alone.
 */
export class AuthzedSchemaV1Service {
  readonly #grains: GrainFactoryAccess;
  readonly #schema: ISchemaProvider;

  constructor(grains: GrainFactoryAccess, schema: ISchemaProvider) {
    this.#grains = grains;
    this.#schema = schema;
  }

  /** `private IRelationshipsGrain Relationships => grains.GetGrain<...>(Key)` - a getter, as the C# is. */
  get #relationships(): IRelationshipsGrain {
    return this.#grains.getGrain(IRelationshipsGrainDefinition, RELATIONSHIPS_GRAIN_KEY);
  }

  /** Reads the live schema text; an empty (or whitespace-only) schema is NOT_FOUND. */
  async readSchema(
    _request: ReadSchemaRequest,
    _signal?: AbortSignal | undefined,
  ): Promise<ReadSchemaResponse> {
    const reply = await this.#relationships.readSchema();
    if (isNullOrWhiteSpace(reply.schemaText)) {
      // SpiceDB's schema handler returns NOT_FOUND (ErrNoSchema) when nothing has been written.
      throw new RpcError(status.NOT_FOUND, "No schema has been defined");
    }

    return {
      schemaText: reply.schemaText,
      // read_at must be populated: zed backup reads the schema, then uses this token for the
      // export's at_exact_snapshot consistency. A null token nil-derefs the zed client.
      readAt: { token: reply.readAtToken },
    };
  }

  /** Upserts the schema through the data-plane grain. */
  async writeSchema(
    request: WriteSchemaRequest,
    _signal?: AbortSignal | undefined,
  ): Promise<WriteSchemaResponse> {
    try {
      const reply = await this.#relationships.writeSchema({ schemaText: request.schema });
      return { writtenAt: { token: reply.writtenAtToken } };
    } catch (error) {
      if (error instanceof SchemaCompileException || error instanceof InvalidArgumentError) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      if (error instanceof SchemaWriteValidationException) {
        throw new RpcError(status.FAILED_PRECONDITION, error.message);
      }
      if (error instanceof SequencerOverloadedException) {
        // The per-silo admission gate shed this commit - the sequencer is saturated. A deliberate,
        // retryable overload signal (back off and retry), never an opaque timeout.
        throw new RpcError(status.RESOURCE_EXHAUSTED, error.message);
      }
      throw error;
    }
  }

  /**
   * Dumps the live schema as reflection protos, filtered.
   *
   * Does NOT reuse {@link reflectionDefinition}: the definition is rebuilt inline so the
   * per-relation and per-permission filters can apply. The duplication is the C#'s and is kept.
   */
  async reflectSchema(
    request: ReflectSchemaRequest,
    _signal?: AbortSignal | undefined,
  ): Promise<ReflectSchemaResponse> {
    const snapshot = this.#schema.current;
    const filters = schemaFiltersFromRequest(request.optionalFilters);

    const response: ReflectSchemaResponse = { definitions: [], caveats: [] };

    for (const def of snapshot.namespaces) {
      if (!filters.matchesDefinition(def.name)) continue;

      const reflected: ReflectionDefinition = {
        name: def.name,
        comment: "",
        relations: [],
        permissions: [],
      };
      for (const rel of def.relations) {
        if (isPermission(rel)) {
          if (filters.matchesPermission(def.name, rel.name))
            reflected.permissions.push(reflectionPermission(def.name, rel));
        } else {
          if (filters.matchesRelation(def.name, rel.name))
            reflected.relations.push(reflectionRelation(def.name, rel));
        }
      }

      response.definitions.push(reflected);
    }

    for (const caveat of snapshot.caveats) {
      if (filters.matchesCaveat(caveat.name)) response.caveats.push(reflectionCaveat(caveat));
    }

    return response;
  }

  /** Diffs the LIVE schema against a supplied comparison schema. */
  async diffSchema(
    request: DiffSchemaRequest,
    _signal?: AbortSignal | undefined,
  ): Promise<DiffSchemaResponse> {
    let comparison: CompiledSchema;
    try {
      comparison = compileSchema(request.comparisonSchema);
      // Reject duplicate/reused names (and other type errors) up front: the diff core keys by name
      // and would otherwise throw a raw ArgumentException on a duplicate definition/caveat.
      validateSchemaTypes(comparison);
    } catch (error) {
      if (
        error instanceof SchemaCompileException ||
        error instanceof SchemaTypeException ||
        error instanceof InvalidArgumentError
      ) {
        throw new RpcError(status.INVALID_ARGUMENT, error.message);
      }
      throw error;
    }

    // Diff existing -> comparison so added/removed are relative to the live schema as the base.
    const deltas = computeSchemaDiff(this.#schema.current.schema, comparison);

    const response: DiffSchemaResponse = { diffs: [] };
    for (const delta of deltas) response.diffs.push(mapDelta(delta));

    return response;
  }

  /** The permissions computable from a relation, per the reachability graph. */
  async computablePermissions(
    request: ComputablePermissionsRequest,
    _signal?: AbortSignal | undefined,
  ): Promise<ComputablePermissionsResponse> {
    const snapshot = this.#schema.current;
    const namespaces = namespacesByName(snapshot.namespaces);

    let reachable: readonly RelationReference[];
    try {
      reachable = introspectComputablePermissions(
        namespaces,
        snapshot.reachabilityFull,
        request.definitionName,
        request.relationName,
        isNullOrEmpty(request.optionalDefinitionNameFilter)
          ? undefined
          : request.optionalDefinitionNameFilter,
      );
    } catch (error) {
      if (error instanceof SchemaIntrospectionException) throw toRpc(error);
      throw error;
    }

    const response: ComputablePermissionsResponse = { permissions: [] };
    for (const r of reachable) response.permissions.push(relationReferenceProto(namespaces, r));

    return response;
  }

  /** The relations a permission depends on. */
  async dependentRelations(
    request: DependentRelationsRequest,
    _signal?: AbortSignal | undefined,
  ): Promise<DependentRelationsResponse> {
    const namespaces = namespacesByName(this.#schema.current.namespaces);

    let dependents: readonly RelationReference[];
    try {
      dependents = introspectDependentRelations(
        namespaces,
        request.definitionName,
        request.permissionName,
      );
    } catch (error) {
      if (error instanceof SchemaIntrospectionException) throw toRpc(error);
      throw error;
    }

    const response: DependentRelationsResponse = { relations: [] };
    for (const r of dependents) response.relations.push(relationReferenceProto(namespaces, r));

    return response;
  }
}

/**
 * `RelationReferenceProto`: `is_permission` comes from a LINEAR scan of the namespace's relations,
 * defaulting to FALSE when the namespace or the relation is missing (`?? false`). It never errors.
 */
function relationReferenceProto(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  reference: RelationReference,
): ReflectionRelationReference {
  let permission = false;
  const ns = namespaces.get(reference.namespace);
  if (ns !== undefined) {
    const relation = ns.relations.find((r) => r.name === reference.relation);
    permission = relation !== undefined ? isPermission(relation) : false;
  }

  return {
    definitionName: reference.namespace,
    relationName: reference.relation,
    isPermission: permission,
  };
}

/** The THREE-WAY split, each arm of which the covering suite asserts. */
function toRpc(ex: SchemaIntrospectionException): RpcError {
  switch (ex.kind) {
    case "definitionNotFound":
      return new RpcError(status.NOT_FOUND, ex.message);
    case "relationNotFound":
      return new RpcError(status.FAILED_PRECONDITION, ex.message);
    case "notAPermission":
      return new RpcError(status.INVALID_ARGUMENT, ex.message);
    default:
      return new RpcError(status.INTERNAL, ex.message);
  }
}

/**
 * The C#'s `_ => throw new InvalidOperationException($"unhandled schema delta ...")`: the default
 * arm is a RUNTIME throw, not an exhaustiveness check, and it is not mapped to a status code.
 */
function assertNeverSchemaDelta(delta: never): never {
  throw new Error(`unhandled schema delta \`${(delta as { readonly kind: string }).kind}\``);
}

/** `MapDelta`: one `ReflectionSchemaDiff` oneof arm per delta. */
function mapDelta(delta: SchemaDelta): ReflectionSchemaDiff {
  switch (delta.kind) {
    case "definitionAdded":
      return { definitionAdded: reflectionDefinition(delta.definition) };
    case "definitionRemoved":
      return { definitionRemoved: reflectionDefinition(delta.definition) };
    case "relationAdded":
      return { relationAdded: reflectionRelation(delta.definitionName, delta.relation) };
    case "relationRemoved":
      return { relationRemoved: reflectionRelation(delta.definitionName, delta.relation) };
    case "relationSubjectTypeAdded":
      return {
        relationSubjectTypeAdded: {
          relation: reflectionRelation(delta.definitionName, delta.relation),
          changedSubjectType: reflectionTypeReference(delta.subjectType),
        },
      };
    case "relationSubjectTypeRemoved":
      return {
        relationSubjectTypeRemoved: {
          relation: reflectionRelation(delta.definitionName, delta.relation),
          changedSubjectType: reflectionTypeReference(delta.subjectType),
        },
      };
    case "permissionAdded":
      return { permissionAdded: reflectionPermission(delta.definitionName, delta.permission) };
    case "permissionRemoved":
      return { permissionRemoved: reflectionPermission(delta.definitionName, delta.permission) };
    case "permissionExprChanged":
      return {
        permissionExprChanged: reflectionPermission(delta.definitionName, delta.permission),
      };
    case "caveatAdded":
      return { caveatAdded: reflectionCaveat(delta.caveat) };
    case "caveatRemoved":
      return { caveatRemoved: reflectionCaveat(delta.caveat) };
    case "caveatExprChanged":
      return { caveatExprChanged: reflectionCaveat(delta.caveat) };
    case "caveatParameterAdded":
      return {
        caveatParameterAdded: reflectionCaveatParameter(
          delta.caveatName,
          delta.parameterName,
          delta.type,
        ),
      };
    case "caveatParameterRemoved":
      return {
        caveatParameterRemoved: reflectionCaveatParameter(
          delta.caveatName,
          delta.parameterName,
          delta.type,
        ),
      };
    case "caveatParameterTypeChanged":
      return {
        caveatParameterTypeChanged: {
          parameter: reflectionCaveatParameter(delta.caveatName, delta.parameterName, delta.type),
          previousType: caveatTypeString(delta.previousType),
        },
      };
    default:
      return assertNeverSchemaDelta(delta);
  }
}

/**
 * `snapshot.Namespaces.ToImmutableDictionary(n => n.Name)`, which THROWS on a duplicate name where
 * `new Map` would silently let the last one win. A private copy, as `check-grain.ts` keeps one.
 */
function namespacesByName(
  namespaces: readonly NamespaceDefinition[],
): ReadonlyMap<string, NamespaceDefinition> {
  const byName = new Map<string, NamespaceDefinition>();
  for (const ns of namespaces) {
    if (byName.has(ns.name)) {
      throw new InvalidArgumentError(
        `An item with the same key has already been added. Key: ${ns.name}`,
      );
    }
    byName.set(ns.name, ns);
  }
  return byName;
}

/** C# `string.IsNullOrWhiteSpace`. */
function isNullOrWhiteSpace(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/** C# `string.IsNullOrEmpty` over a proto string field, which defaults to the empty string. */
function isNullOrEmpty(value: string | undefined): boolean {
  return value === undefined || value.length === 0;
}
