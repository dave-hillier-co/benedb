import { ELLIPSIS } from "@spacedb/core/core-constants";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import {
  isPublicWildcard,
  withRelation,
  type ObjectAndRelation,
} from "@spacedb/core/object-and-relation";
import type { Relation } from "@spacedb/core/relation";
import type { Relationship } from "@spacedb/core/relationship";
import type {
  ComputedUserset,
  SetOperation,
  SetOperationChild,
  TupleToUsersetFunction,
} from "@spacedb/core/userset-rewrite";
import type { IGraphReader } from "@spacedb/datastore/i-graph-reader";
import type { RelationshipsFilter } from "@spacedb/datastore/relationships-filter";

import {
  caveatExpressionCombineAnd,
  caveatExpressionFromCaveat,
  type CaveatExpression,
} from "./caveat-expression";
import { systemClockNow } from "./clock";
import {
  createDirectSubject,
  permissionTreeLeaf,
  permissionTreeSetOp,
  type DirectSubject,
  type ExpandMode,
  type PermissionTreeNode,
} from "./permission-tree-node";

/**
 * The default maximum recursion depth.
 *
 * `ExpandEngine` declares its OWN copy of this constant in the C#; it stays a separate constant
 * here rather than being folded into `check-engine.ts`'s.
 */
export const DEFAULT_MAX_DEPTH = 50;

/**
 * Expands a resource ONR into a {@link PermissionTreeNode} tree that mirrors the userset-rewrite
 * structure of the expanded relation.
 *
 * Ported from Spiceport `src/Spiceport.Server/Engine/Expand/ExpandEngine.cs`; port of SpiceDB's
 * `internal/graph/expand.go`. Unlike LookupResources this walks the rewrite structurally and does
 * not consult any reachability graph (matching SpiceDB, where `expand.go` never touches
 * reachability). Caveats are carried verbatim; the tree is the structural expansion and is not
 * collapsed against a request context. Recursion is bounded by a depth limit and a visited-set
 * cycle guard so cyclic schemas terminate.
 *
 * Two DELIBERATE divergences from the Check path, both present in the C# and both preserved:
 *   * {@link ExpandEngine} honours `computedUserset.object === "tupleObject"` (compute on the
 *     RESOURCE) versus `"tupleUsersetObject"` (compute on the traversed subject), whereas
 *     `LocalDispatcher.checkTupleToUserset` ALWAYS computes on the reached subject. The two
 *     engines genuinely differ; `LookupSubjectsEngine` has the same `tupleObject` branch as this
 *     one. The asymmetry is noted at both sites.
 *   * A depth-exhausted or already-visited node returns an EMPTY LEAF; it does NOT throw, where
 *     `LocalDispatcher` raises `MaxDepthExceededException`.
 *
 * Port decisions:
 *   * `ImmutableHashSet<string>` visited is COPY-ON-ADD, so sibling branches each receive the
 *     PARENT's set and never each other's accumulation. Every recursion is handed
 *     `new Set(visited).add(key)`, never one shared mutable Set.
 *   * `evaluationTime` is a `bigint` of epoch NANOSECONDS, as everywhere else in this package,
 *     because `Relationship.optionalExpiration` already is.
 *   * There is no `IAsyncEnumerable` here: the whole engine is `Promise<PermissionTreeNode>`.
 */
export class ExpandEngine {
  readonly #namespaces: ReadonlyMap<string, NamespaceDefinition>;
  readonly #maxDepth: number;

  /**
   * Creates an expand engine over the given schema definitions.
   *
   * @param namespaces The compiled namespace definitions that make up the schema.
   * @param maxDepth The maximum recursion depth before expansion stops.
   */
  constructor(namespaces: Iterable<NamespaceDefinition>, maxDepth?: number | undefined) {
    if (namespaces === undefined || namespaces === null) {
      throw new InvalidArgumentError("namespaces is required");
    }
    // `ToImmutableDictionary(ns => ns.Name)` THROWS on a duplicate name where `new Map` would
    // silently keep the last one, so the throw is reproduced explicitly.
    const byName = new Map<string, NamespaceDefinition>();
    for (const ns of namespaces) {
      if (byName.has(ns.name)) {
        throw new InvalidArgumentError(
          `An item with the same key has already been added. Key: ${ns.name}`,
        );
      }
      byName.set(ns.name, ns);
    }
    this.#namespaces = byName;
    this.#maxDepth = maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /**
   * Expands `resource` into a permission tree as of the given reader's snapshot.
   *
   * @param reader A graph reader pinned to the revision to evaluate against.
   * @param resource The resource ONR (object type, id and relation/permission) to expand.
   * @param mode Shallow (one level) or Recursive (expand non-terminal usersets).
   * @param evaluationTime Optional pinned "now" (epoch nanoseconds) for expiration filtering;
   * defaults to the system clock.
   * @param signal A cancellation signal.
   */
  expandPermissionTree(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    mode?: ExpandMode | undefined,
    evaluationTime?: bigint | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<PermissionTreeNode> {
    if (reader === undefined || reader === null) {
      throw new InvalidArgumentError("reader is required");
    }
    if (resource === undefined || resource === null) {
      throw new InvalidArgumentError("resource is required");
    }
    const now = evaluationTime ?? systemClockNow();
    return this.#expand(
      reader,
      resource,
      mode ?? "shallow",
      now,
      this.#maxDepth,
      new Set<string>(),
      signal,
    );
  }

  async #expand(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    mode: ExpandMode,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<PermissionTreeNode> {
    signal?.throwIfAborted();

    const key = `${resource.objectType}:${resource.objectId}#${resource.relation}`;
    if (depthRemaining <= 0 || visited.has(key)) {
      return permissionTreeLeaf(resource, []);
    }
    // Copy-on-add: this local rebinding is what keeps sibling branches independent.
    const nextVisited: ReadonlySet<string> = new Set(visited).add(key);

    const relation = this.#lookupRelation(resource.objectType, resource.relation);
    if (relation === undefined) {
      return permissionTreeLeaf(resource, []);
    }

    const rewrite = relation.usersetRewrite;
    return rewrite !== undefined
      ? await this.#expandRewrite(
          reader,
          resource,
          rewrite.operation,
          mode,
          now,
          depthRemaining,
          nextVisited,
          signal,
        )
      : await this.#expandDirect(reader, resource, mode, now, depthRemaining, nextVisited, signal);
  }

  /**
   * Expands a base relation's directly-written tuples (port of `expandDirect`).
   *
   * Reached two ways with DIFFERENT relations: from `#expand` for a rewrite-less relation (the
   * base relation's own name, which is `resource.relation` there) and from `#expandChild`'s
   * `this` case using `resource.relation` (the permission's name). Both read the relation off
   * `resource`, exactly as the C# does.
   */
  async #expandDirect(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    mode: ExpandMode,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<PermissionTreeNode> {
    const filter: RelationshipsFilter = {
      optionalResourceType: resource.objectType,
      optionalResourceIds: [resource.objectId],
      optionalResourceRelation: resource.relation,
    };

    const allSubjects: DirectSubject[] = [];
    const nonTerminal: DirectSubject[] = [];

    for await (const rel of reader.queryRelationships(filter, signal)) {
      if (isExpired(rel, now)) {
        continue;
      }

      const ds = createDirectSubject(rel.reference.subject, caveatOf(rel));
      allSubjects.push(ds);

      // Terminal = ellipsis or wildcard; non-terminal = a subrelation (userset) to recurse into.
      if (rel.reference.subject.relation !== ELLIPSIS && !isPublicWildcard(rel.reference.subject)) {
        nonTerminal.push(ds);
      }
    }

    if (mode === "shallow" || nonTerminal.length === 0) {
      return permissionTreeLeaf(resource, allSubjects);
    }

    // Recursive: expand each non-terminal userset and union with the verbatim leaf, attaching
    // each child's tuple caveat (port of decorateWithCaveatIfNecessary). The verbatim leaf is
    // appended AFTER the recursed children; the child order is observable in the tree.
    const children: PermissionTreeNode[] = [];
    for (const ds of nonTerminal) {
      const child = await this.#expand(
        reader,
        ds.subject,
        mode,
        now,
        depthRemaining - 1,
        visited,
        signal,
      );
      children.push(decorateWithCaveat(child, ds.caveat));
    }
    children.push(permissionTreeLeaf(resource, allSubjects));

    return permissionTreeSetOp(resource, "union", children);
  }

  /** Expands a rewrite set operation (port of `expandUsersetRewrite`/`expandSetOperation`). */
  async #expandRewrite(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    operation: SetOperation,
    mode: ExpandMode,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<PermissionTreeNode> {
    const children: PermissionTreeNode[] = [];
    for (const child of operation.children) {
      children.push(
        await this.#expandChild(
          reader,
          resource,
          child,
          mode,
          now,
          depthRemaining,
          visited,
          signal,
        ),
      );
    }

    return permissionTreeSetOp(resource, operation.type, children);
  }

  /** Expands a single set-operation operand. */
  async #expandChild(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    child: SetOperationChild,
    mode: ExpandMode,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<PermissionTreeNode> {
    switch (child.kind) {
      case "this":
        return await this.#expandDirect(
          reader,
          resource,
          mode,
          now,
          depthRemaining,
          visited,
          signal,
        );

      case "nil":
        return permissionTreeLeaf(resource, []);

      case "self":
        // The resource itself treated as a subject at ellipsis (port of selfExpansion).
        return permissionTreeLeaf(resource, [
          createDirectSubject({
            objectType: resource.objectType,
            objectId: resource.objectId,
            relation: ELLIPSIS,
          }),
        ]);

      case "computedUserset":
        return await this.#expand(
          reader,
          withRelation(resource, child.value.relation),
          mode,
          now,
          depthRemaining - 1,
          visited,
          signal,
        );

      case "tupleToUserset":
        return await this.#expandTupleToUserset(
          reader,
          resource,
          child.value.tuplesetRelation,
          child.value.computedUserset,
          "any",
          mode,
          now,
          depthRemaining,
          visited,
          signal,
        );

      case "functionedTupleToUserset":
        return await this.#expandTupleToUserset(
          reader,
          resource,
          child.value.tuplesetRelation,
          child.value.computedUserset,
          child.value.function,
          mode,
          now,
          depthRemaining,
          visited,
          signal,
        );

      case "nestedRewrite":
        return await this.#expandRewrite(
          reader,
          resource,
          child.value.operation,
          mode,
          now,
          depthRemaining,
          visited,
          signal,
        );

      default:
        // The C# default arm returns an empty leaf rather than throwing; the exhaustiveness check
        // is kept alongside it so a new variant is a compile error, not a silent empty leaf.
        return assertNeverChild(child, resource);
    }
  }

  /**
   * Expands a tuple-to-userset arrow (port of `expandTupleToUserset`): walk the tupleset relation,
   * and for each reached object build a child by computing the userset relation on it, decorating
   * with the tupleset tuple's caveat. `.all()` produces an INTERSECTION over the per-target
   * children; `.any()` a UNION. An empty tupleset yields a SetOp with zero children, NOT an empty
   * Leaf.
   */
  async #expandTupleToUserset(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    tuplesetRelation: string,
    computed: ComputedUserset,
    func: TupleToUsersetFunction,
    mode: ExpandMode,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<PermissionTreeNode> {
    const filter: RelationshipsFilter = {
      optionalResourceType: resource.objectType,
      optionalResourceIds: [resource.objectId],
      optionalResourceRelation: tuplesetRelation,
    };

    const children: PermissionTreeNode[] = [];
    for await (const rel of reader.queryRelationships(filter, signal)) {
      if (isExpired(rel, now)) {
        continue;
      }

      const reached = rel.reference.subject;
      if (isPublicWildcard(reached)) {
        continue;
      }

      // "tupleObject" => compute on the resource; "tupleUsersetObject" => compute on the traversed
      // subject. Arrows traverse, so the common case is on the subject. NOTE the asymmetry with
      // `LocalDispatcher.checkTupleToUserset`, which ALWAYS computes on the reached subject: the
      // two engines genuinely differ in the C# and each is transliterated as written.
      const target: ObjectAndRelation =
        computed.object === "tupleObject"
          ? {
              objectType: resource.objectType,
              objectId: resource.objectId,
              relation: computed.relation,
            }
          : {
              objectType: reached.objectType,
              objectId: reached.objectId,
              relation: computed.relation,
            };

      const child = await this.#expand(
        reader,
        target,
        mode,
        now,
        depthRemaining - 1,
        visited,
        signal,
      );
      children.push(decorateWithCaveat(child, caveatOf(rel)));
    }

    const op = func === "all" ? "intersection" : "union";
    return permissionTreeSetOp(resource, op, children);
  }

  #lookupRelation(objectType: string, relationName: string): Relation | undefined {
    const ns = this.#namespaces.get(objectType);
    if (ns === undefined) {
      return undefined;
    }
    for (const r of ns.relations) {
      if (r.name === relationName) {
        return r;
      }
    }
    return undefined;
  }
}

/**
 * Attaches `caveat` to a node. `{ ...node, caveat }` is the port of C# `node with { Caveat = ... }`
 * on the ABSTRACT record type: it preserves the variant only because `kind` is a data field.
 *
 * The combination is `CombineAnd(tupleCaveat, node.Caveat)` - argument order matters, because it
 * fixes the flattened And's child order.
 */
function decorateWithCaveat(
  node: PermissionTreeNode,
  caveat: CaveatExpression | undefined,
): PermissionTreeNode {
  if (caveat === undefined) {
    return node;
  }
  return { ...node, caveat: caveatExpressionCombineAnd(caveat, node.caveat) };
}

function isExpired(rel: Relationship, now: bigint): boolean {
  const exp = rel.optionalExpiration;
  return exp !== undefined && exp <= now;
}

function caveatOf(rel: Relationship): CaveatExpression | undefined {
  const c = rel.optionalCaveat;
  return c !== undefined ? caveatExpressionFromCaveat(c) : undefined;
}

function assertNeverChild(child: never, resource: ObjectAndRelation): PermissionTreeNode {
  void (child satisfies never);
  return permissionTreeLeaf(resource, []);
}
