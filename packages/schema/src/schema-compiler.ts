import {
  allowedRelationDirect,
  allowedRelationWildcard,
  type AllowedCaveat,
  type AllowedRelation,
} from "@benedb/core/allowed-relation";
import type { CaveatDefinition, CaveatTypeReference } from "@benedb/core/caveat-definition";
import { ELLIPSIS } from "@benedb/core/core-constants";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { permission as permissionRelation, type Relation } from "@benedb/core/relation";
import {
  computedUsersetOnResource,
  setOperationUnion,
  type ComputedUserset,
  type SetOperation,
  type SetOperationChild,
  type SetOperationType,
  type TupleToUsersetFunction,
} from "@benedb/core/userset-rewrite";

import type {
  ArrowExpr,
  BinaryExpr,
  CaveatNode,
  CaveatTypeRefNode,
  DefinitionNode,
  ExprNode,
  PermissionNode,
  RelationNode,
  SchemaFileNode,
  SetOp,
  TypeRefNode,
} from "./ast";
import type { CompiledSchema } from "./compiled-schema";
import { parse } from "./parser";
import { SchemaCompileException } from "./schema-compile-exception";

/**
 * Compiles SpiceDB schema DSL text into `NamespaceDefinition` objects from the core schema model.
 *
 * Ported from Spiceport `SchemaCompiler.cs`, a static class; a static class with no state becomes
 * module-level functions. `CompiledSchema`, declared in the same C# file, gets its own module.
 *
 * Supported: definitions, relations (type refs with `#subrelation` and `:*` wildcards), and
 * permissions (union `+`, intersection `&`, exclusion `-`, arrows `->` / `.any()` / `.all()`, and
 * `nil`). Caveat blocks and `with` / `expiration` traits are parsed; caveat names and expiration
 * requirements are attached to allowed relations, but caveat bodies are not modelled (their CEL is
 * ignored by `compile`, and captured verbatim by `compileSchema`).
 *
 * Port decisions:
 *   * BOTH public entry points survive: `compile` returns namespaces only, `compileSchema` returns
 *     namespaces and caveats. Callers of the former must not be silently upgraded.
 *   * The `switch` expressions over sealed hierarchies become `kind` switches whose default branch
 *     calls a helper typed `never`, so exhaustiveness is still checked at compile time AND the C#
 *     default-throw message survives at run time.
 *   * `ArgumentNullException` on a null argument has no TypeScript equivalent under a `string`
 *     parameter type, but the guard is kept for untyped callers and throws `InvalidArgumentError`,
 *     this port's `ArgumentException` stand-in.
 *   * `caveat.Parameters.ToImmutableDictionary(...)` throws a plain `ArgumentException` on a
 *     duplicate parameter name - NOT a `SchemaCompileException`. A `Map` would silently keep the
 *     last one instead, so the throw is reproduced explicitly, with the same (unmapped) error
 *     class rather than being promoted to a schema error.
 *   * `CaveatDefinition.parameterTypes` is a `Map`, whose enumeration order is insertion order
 *     where the C# `ImmutableDictionary` enumerates in hash order. Nothing here may depend on
 *     either.
 */

/**
 * Compiles the given schema DSL text into a list of namespace definitions, in source order.
 *
 * @throws {SchemaCompileException} If the schema cannot be parsed or compiled.
 */
export function compile(schemaText: string): readonly NamespaceDefinition[] {
  if (schemaText === null || schemaText === undefined) {
    throw new InvalidArgumentError("schemaText must not be null");
  }

  const file: SchemaFileNode = parse(schemaText);
  return file.definitions.map(compileDefinition);
}

/**
 * Compiles the given schema DSL text into a {@link CompiledSchema} exposing both namespace
 * definitions and caveat definitions, each in source order.
 *
 * Caveat bodies are captured verbatim as CEL text and stored UTF-8 encoded in
 * `CaveatDefinition.serializedExpression`; they are not type-checked or evaluated here. Parameter
 * types are modelled, including generic `list<T>` / `map<K,V>` forms.
 *
 * @throws {SchemaCompileException} If the schema cannot be parsed or compiled.
 */
export function compileSchema(schemaText: string): CompiledSchema {
  if (schemaText === null || schemaText === undefined) {
    throw new InvalidArgumentError("schemaText must not be null");
  }

  const file: SchemaFileNode = parse(schemaText);
  return {
    namespaces: file.definitions.map(compileDefinition),
    caveats: file.caveats.map(compileCaveat),
  };
}

function compileCaveat(caveat: CaveatNode): CaveatDefinition {
  const parameterTypes = new Map<string, CaveatTypeReference>();
  for (const p of caveat.parameters) {
    // `ToImmutableDictionary` throws on a duplicate key; a Map would overwrite silently.
    if (parameterTypes.has(p.name)) {
      throw new InvalidArgumentError(
        `An item with the same key has already been added. Key: ${p.name}`,
      );
    }

    parameterTypes.set(p.name, compileCaveatType(p.type));
  }

  // The CEL expression is stored verbatim (UTF-8) rather than evaluated here.
  const serialized = new TextEncoder().encode(caveat.expression);

  return { name: caveat.name, serializedExpression: serialized, parameterTypes };
}

function compileCaveatType(type: CaveatTypeRefNode): CaveatTypeReference {
  const children: readonly CaveatTypeReference[] | undefined =
    type.childTypes.length === 0 ? undefined : type.childTypes.map(compileCaveatType);

  return { typeName: type.name, childTypes: children };
}

function compileDefinition(def: DefinitionNode): NamespaceDefinition {
  const relations: Relation[] = [];

  for (const rel of def.relations) {
    relations.push(compileRelation(rel));
  }

  for (const perm of def.permissions) {
    relations.push(compilePermission(perm));
  }

  return { name: def.name, relations };
}

function compileRelation(rel: RelationNode): Relation {
  const allowed = rel.allowedTypes.map(compileTypeRef);
  return { name: rel.name, typeInformation: { allowedDirectRelations: allowed } };
}

function compileTypeRef(t: TypeRefNode): AllowedRelation {
  const caveat: AllowedCaveat | undefined =
    t.caveatName === undefined ? undefined : { caveatName: t.caveatName };

  if (t.isWildcard) {
    return allowedRelationWildcard(t.typeName, caveat, t.requiresExpiration);
  }

  const subrelation = t.subrelation ?? ELLIPSIS;
  return allowedRelationDirect(t.typeName, subrelation, caveat, t.requiresExpiration);
}

function compilePermission(perm: PermissionNode): Relation {
  const child: SetOperationChild = compileExpr(perm.expression);

  // The top-level rewrite is always a single SetOperation. When the expression
  // itself is a set operation we lift it; otherwise wrap the operand in a union.
  const operation: SetOperation =
    child.kind === "nestedRewrite" ? child.value.operation : setOperationUnion(child);

  return permissionRelation(perm.name, { operation });
}

function compileExpr(expr: ExprNode): SetOperationChild {
  switch (expr.kind) {
    case "nil":
      return { kind: "nil" };
    case "self":
      return { kind: "self" };
    case "reference":
      return { kind: "computedUserset", value: computedUsersetOnResource(expr.name) };
    case "arrow":
      return compileArrow(expr);
    case "binary":
      return compileBinary(expr);
    default:
      return unsupportedExpression(expr);
  }
}

function unsupportedExpression(expr: never): never {
  throw new SchemaCompileException(`unsupported expression node '${(expr as ExprNode).kind}'`);
}

function compileArrow(a: ArrowExpr): SetOperationChild {
  const computed: ComputedUserset = { object: "tupleUsersetObject", relation: a.computed };

  if (a.functionName === undefined) {
    return {
      kind: "tupleToUserset",
      value: { tuplesetRelation: a.tupleset, computedUserset: computed },
    };
  }

  let fn: TupleToUsersetFunction;
  switch (a.functionName) {
    case "any":
      fn = "any";
      break;
    case "all":
      fn = "all";
      break;
    default:
      throw new SchemaCompileException(`unsupported arrow function '${a.functionName}'`);
  }

  return {
    kind: "functionedTupleToUserset",
    value: { function: fn, tuplesetRelation: a.tupleset, computedUserset: computed },
  };
}

function compileBinary(b: BinaryExpr): SetOperationChild {
  let type: SetOperationType;
  switch (b.op) {
    case "union":
      type = "union";
      break;
    case "intersection":
      type = "intersection";
      break;
    case "exclusion":
      type = "exclusion";
      break;
    default:
      return unsupportedOperator(b.op);
  }

  // Flatten associative operators (union/intersection) into a single n-ary
  // SetOperation; exclusion is left-nested because order is significant.
  const children: SetOperationChild[] = [];
  flattenOperand(b.left, type, children);
  flattenOperand(b.right, type, children);

  const op: SetOperation = { type, children };
  return { kind: "nestedRewrite", value: { operation: op } };
}

function unsupportedOperator(op: never): never {
  throw new SchemaCompileException(`unsupported operator '${String(op)}'`);
}

function flattenOperand(
  node: ExprNode,
  parentType: SetOperationType,
  children: SetOperationChild[],
): void {
  if (
    parentType !== "exclusion" &&
    node.kind === "binary" &&
    operatorType(node.op) === parentType
  ) {
    flattenOperand(node.left, parentType, children);
    flattenOperand(node.right, parentType, children);
    return;
  }

  children.push(compileExpr(node));
}

function operatorType(op: SetOp): SetOperationType {
  switch (op) {
    case "union":
      return "union";
    case "intersection":
      return "intersection";
    default:
      return "exclusion";
  }
}
