import {
  isAllowedRelationPublicWildcard,
  type TypeInformation,
} from "@spacedb/core/allowed-relation";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import type { Relation } from "@spacedb/core/relation";
import type { SetOperation, SetOperationChild } from "@spacedb/core/userset-rewrite";

import {
  createReachabilityEntrypoint,
  type EntrypointResultStatus,
  type ReachabilityEntrypoint,
} from "./reachability-entrypoint";
import { relationReferenceKey, type RelationReference } from "./relation-reference";

/**
 * The structural precompute that lets `LookupResources` follow only productive edges from a
 * subject type to a resource relation. Ported from Spiceport
 * `Engine/Reachability/ReachabilityGraph.cs` (itself a port of SpiceDB's
 * `pkg/schema/reachabilitygraphbuilder.go` + `reachabilitygraph.go`).
 *
 * Built eagerly and immutably once per compiled schema; it is a pure function of the namespace
 * definitions (no datastore, no revision). Callers build it once per schema snapshot and reuse the
 * instance for that snapshot's lifetime.
 *
 * Port decisions:
 *   * The C# `Dictionary<RelationReference, ...>` uses a RECORD key, which a JS `Map` would
 *     compare by reference and so miss on every lookup. Every such index is keyed by the canonical
 *     string from `relation-reference.ts`, with the reference value kept alongside so `targets`
 *     can hand back the objects rather than the keys.
 *   * `Targets => _byTarget.Keys` is enumerated by schema introspection. .NET's dictionary order
 *     is unspecified while a JS `Map` is insertion-ordered; that difference is benign only because
 *     the introspection layer's `project` sorts the final result ordinally. Never remove that sort.
 *   * `ReachabilityMode` is not wire-visible, so it is a string union with no wire map.
 *   * `Build()` runs inside a private constructor behind a static `Build` entry point, which is
 *     the guide's "private ctor + static entry point" row: a module-private class plus the one
 *     exported {@link buildReachabilityGraph} factory.
 */

/** How an intersection/exclusion contributes entrypoints when building a reachability graph. */
export type ReachabilityMode =
  /** Every operand of an intersection/exclusion contributes entrypoints (full dependent set). */
  | "full"
  /**
   * Only the first operand of an intersection/exclusion contributes entrypoints; the rest are
   * validated by Check. Port of SpiceDB's optimized `reachabilityFirst`, used by LookupResources.
   */
  | "first";

/** The public surface of a built reachability graph. */
export interface ReachabilityGraph {
  /**
   * The set of resource `(namespace, relation)` targets the graph holds entrypoints for. Used by
   * schema introspection to enumerate candidate resources rather than re-deriving them from the
   * namespace definitions.
   */
  readonly targets: readonly RelationReference[];

  /**
   * Returns the productive entrypoints by which a subject of `subject` can reach `resource`. Port
   * of `AllEntrypointsForSubjectToResource` / `collectEntrypoints`: collects direct entrypoints for
   * the subject ref and recurses through any non-ellipsis subject-relation chains (e.g.
   * `group#member` reached via `team#member`).
   *
   * @param optimizedFirstOnly When true, stop collecting after the first matching entrypoint (port
   * of the `entrypointLookupFindOne` existence check). Independent of the build-time
   * {@link ReachabilityMode}.
   */
  entrypointsForSubjectToResource(
    subject: RelationReference,
    resource: RelationReference,
    optimizedFirstOnly?: boolean,
  ): readonly ReachabilityEntrypoint[];
}

/** One by-subject-relation bucket: the subject reference plus the entrypoints keyed under it. */
interface SubjectRelationBucket {
  readonly subject: RelationReference;
  readonly entrypoints: ReachabilityEntrypoint[];
}

/** Per-target entrypoint indices. Port of the private `TargetGraph` / `core.ReachabilityGraph`. */
class TargetGraph {
  /** Subject namespace -> entrypoints (the wildcard / public links). */
  readonly bySubjectType = new Map<string, ReachabilityEntrypoint[]>();
  /** Canonical subject `(type, relation)` key -> bucket (the concrete links). */
  readonly bySubjectRelation = new Map<string, SubjectRelationBucket>();

  addBySubjectType(subjectType: string, entrypoint: ReachabilityEntrypoint): void {
    let list = this.bySubjectType.get(subjectType);
    if (list === undefined) {
      list = [];
      this.bySubjectType.set(subjectType, list);
    }
    list.push(entrypoint);
  }

  addBySubjectRelation(subject: RelationReference, entrypoint: ReachabilityEntrypoint): void {
    const key = relationReferenceKey(subject);
    let bucket = this.bySubjectRelation.get(key);
    if (bucket === undefined) {
      bucket = { subject, entrypoints: [] };
      this.bySubjectRelation.set(key, bucket);
    }
    bucket.entrypoints.push(entrypoint);
  }
}

/** One entry of the by-target index: the target reference plus its per-target indices. */
interface TargetEntry {
  readonly target: RelationReference;
  readonly graph: TargetGraph;
}

class ReachabilityGraphImpl implements ReachabilityGraph {
  private readonly namespaces: ReadonlyMap<string, NamespaceDefinition>;
  private readonly mode: ReachabilityMode;
  /** Canonical `(resourceNs, resourceRel)` key -> per-target reachability indices. */
  private readonly byTarget = new Map<string, TargetEntry>();

  constructor(namespaces: ReadonlyMap<string, NamespaceDefinition>, mode: ReachabilityMode) {
    this.namespaces = namespaces;
    this.mode = mode;
    this.build();
  }

  get targets(): readonly RelationReference[] {
    return [...this.byTarget.values()].map((entry) => entry.target);
  }

  entrypointsForSubjectToResource(
    subject: RelationReference,
    resource: RelationReference,
    optimizedFirstOnly = false,
  ): readonly ReachabilityEntrypoint[] {
    if (subject === undefined || subject === null) {
      throw new InvalidArgumentError("subject is required");
    }
    if (resource === undefined || resource === null) {
      throw new InvalidArgumentError("resource is required");
    }

    const collected: ReachabilityEntrypoint[] = [];
    const seenKeys = new Set<string>();
    const visited = new Set<string>();
    this.collect(resource, subject, collected, seenKeys, visited, optimizedFirstOnly);
    return collected;
  }

  private collect(
    resource: RelationReference,
    subject: RelationReference,
    collected: ReachabilityEntrypoint[],
    seenKeys: Set<string>,
    visited: Set<string>,
    firstOnly: boolean,
  ): void {
    const resourceKey = relationReferenceKey(resource);
    if (visited.has(resourceKey)) return;
    visited.add(resourceKey);

    const entry = this.byTarget.get(resourceKey);
    if (entry === undefined) return;
    const target = entry.graph;

    // Direct entrypoints for the subject type (wildcards) and (type, relation) (concrete).
    const byType = target.bySubjectType.get(subject.namespace);
    if (byType !== undefined) addAll(byType, collected, seenKeys);

    if (firstOnly && collected.length > 0) return;

    const byRel = target.bySubjectRelation.get(relationReferenceKey(subject));
    if (byRel !== undefined) addAll(byRel.entrypoints, collected, seenKeys);

    if (firstOnly && collected.length > 0) return;

    // Recurse through non-ellipsis subject-relation chains, in a stable order. The sort exists
    // because the C# dictionary order was unstable; a JS Map is already insertion-ordered, but the
    // order is observable (it decides which entrypoint `optimizedFirstOnly` returns), so the
    // explicit ordinal sort is kept verbatim.
    const chained = [...target.bySubjectRelation.values()]
      .map((bucket) => bucket.subject)
      .filter((s) => s.relation !== ELLIPSIS)
      .sort(compareRelationReferenceOrdinal);

    for (const subjectRel of chained) {
      this.collect(subjectRel, subject, collected, seenKeys, visited, firstOnly);
      if (firstOnly && collected.length > 0) return;
    }
  }

  // ---- Build ----------------------------------------------------------

  private build(): void {
    for (const ns of this.namespaces.values()) {
      for (const relation of ns.relations) {
        const target: RelationReference = { namespace: ns.name, relation: relation.name };
        const graph = this.getOrCreate(target);

        const rewrite = relation.usersetRewrite;
        const typeInfo = relation.typeInformation;
        if (rewrite !== undefined) {
          this.walkRewrite(graph, ns.name, target, rewrite.operation, "directResult");
        } else if (typeInfo !== undefined) {
          addSubjectLinks(graph, target, typeInfo);
        }
      }
    }
  }

  /** Port of `computeRewriteReachability`/`computeRewriteOpReachability`. */
  private walkRewrite(
    graph: TargetGraph,
    thisNs: string,
    target: RelationReference,
    operation: SetOperation,
    status: EntrypointResultStatus,
  ): void {
    // Intersection/exclusion children are reachable only conditionally.
    const isUnion = operation.type === "union";
    const childStatus: EntrypointResultStatus = isUnion ? status : "conditionalResult";

    // In First mode, an intersection/exclusion contributes entrypoints from only its first operand
    // (a necessary condition for the whole expression); the remaining operands are validated by
    // Check. Mirrors SpiceDB's reachabilityFirst (Child[0:1]). Unions always contribute every
    // operand.
    let children: readonly SetOperationChild[] = operation.children;
    if (!isUnion && this.mode === "first" && operation.children.length > 0) {
      const first = operation.children[0];
      // `noUncheckedIndexedAccess`: the length guard above already rules this out.
      children = first === undefined ? [] : [first];
    }

    for (const child of children) {
      this.walkChild(graph, thisNs, target, child, childStatus);
    }
  }

  private walkChild(
    graph: TargetGraph,
    thisNs: string,
    target: RelationReference,
    child: SetOperationChild,
    status: EntrypointResultStatus,
  ): void {
    switch (child.kind) {
      case "computedUserset": {
        const cu = child.value;
        const ep = createReachabilityEntrypoint({
          kind: "computedUserset",
          targetRelation: target,
          containingRelation: target,
          computedUsersetRelation: cu.relation,
          resultStatus: status,
        });
        graph.addBySubjectRelation({ namespace: thisNs, relation: cu.relation }, ep);
        break;
      }

      case "tupleToUserset": {
        const ttu = child.value;
        this.addTtu(
          graph,
          thisNs,
          target,
          ttu.tuplesetRelation,
          ttu.computedUserset.relation,
          status,
        );
        break;
      }

      case "functionedTupleToUserset": {
        const fttu = child.value;
        const ttuStatus: EntrypointResultStatus =
          fttu.function === "all" ? "conditionalResult" : status;
        this.addTtu(
          graph,
          thisNs,
          target,
          fttu.tuplesetRelation,
          fttu.computedUserset.relation,
          ttuStatus,
        );
        break;
      }

      case "nestedRewrite":
        this.walkRewrite(graph, thisNs, target, child.value.operation, status);
        break;

      case "self": {
        const ep = createReachabilityEntrypoint({
          kind: "self",
          targetRelation: target,
          containingRelation: target,
          resultStatus: status,
        });
        graph.addBySubjectRelation({ namespace: thisNs, relation: ELLIPSIS }, ep);
        break;
      }

      // Nil / This produce no entrypoints (This is not valid in a compiled rewrite). The C# has a
      // do-nothing default branch, so this is NOT an `assertNever` site: `this` is a live union
      // member that must fall through silently.
      default:
        break;
    }
  }

  /**
   * Port of `computeTTUReachability`: for each allowed type on the tupleset relation that actually
   * has the computed relation, emit a TupleToUserset entrypoint keyed by
   * `(allowedType, computedRelation)`.
   */
  private addTtu(
    graph: TargetGraph,
    thisNs: string,
    target: RelationReference,
    tuplesetRelation: string,
    computedRelation: string,
    status: EntrypointResultStatus,
  ): void {
    const tuplesetRel = this.lookupRelation(thisNs, tuplesetRelation);
    const typeInfo = tuplesetRel?.typeInformation;
    if (typeInfo === undefined) return;

    for (const allowed of typeInfo.allowedDirectRelations) {
      if (isAllowedRelationPublicWildcard(allowed)) continue; // arrows over a wildcard tupleset are not productive here.

      // Guard: the allowed type must actually have the computed relation (HasRelation).
      if (!this.hasRelation(allowed.objectType, computedRelation)) continue;

      const ep = createReachabilityEntrypoint({
        kind: "tupleToUserset",
        targetRelation: target,
        containingRelation: target,
        computedUsersetRelation: computedRelation,
        tuplesetRelation,
        resultStatus: status,
      });

      graph.addBySubjectRelation({ namespace: allowed.objectType, relation: computedRelation }, ep);
    }
  }

  private getOrCreate(target: RelationReference): TargetGraph {
    const key = relationReferenceKey(target);
    let entry = this.byTarget.get(key);
    if (entry === undefined) {
      entry = { target, graph: new TargetGraph() };
      this.byTarget.set(key, entry);
    }
    return entry.graph;
  }

  private lookupRelation(objectType: string, relationName: string): Relation | undefined {
    const ns = this.namespaces.get(objectType);
    if (ns === undefined) return undefined;
    for (const r of ns.relations) {
      if (r.name === relationName) return r;
    }
    return undefined;
  }

  private hasRelation(objectType: string, relationName: string): boolean {
    return this.lookupRelation(objectType, relationName) !== undefined;
  }
}

/** Port of `addSubjectLinks`: each allowed subject becomes a Relation entrypoint. */
function addSubjectLinks(
  graph: TargetGraph,
  target: RelationReference,
  typeInfo: TypeInformation,
): void {
  for (const allowed of typeInfo.allowedDirectRelations) {
    const ep = createReachabilityEntrypoint({
      kind: "relation",
      targetRelation: target,
      containingRelation: target,
      resultStatus: "directResult",
    });

    if (isAllowedRelationPublicWildcard(allowed)) {
      graph.addBySubjectType(allowed.objectType, ep);
    } else {
      graph.addBySubjectRelation(
        { namespace: allowed.objectType, relation: allowed.relationName ?? ELLIPSIS },
        ep,
      );
    }
  }
}

/**
 * Dedup key for the collected entrypoints.
 *
 * The C# key is `$"{(int)Kind}|{ns}#{rel}|{computed}|{tupleset}|{(int)status}"`, where a null
 * computed/tupleset relation interpolates as the EMPTY STRING, so null and "" collide there. This
 * port length-prefixes each part instead, which is unconditionally injective. The divergence is
 * unobservable in practice: the kind is part of the key and each kind populates a fixed set of
 * slots, so no two entrypoints on one target can differ only by absent-versus-empty.
 */
function entrypointDedupKey(ep: ReachabilityEntrypoint): string {
  const part = (value: string): string => `${value.length}:${value}`;
  return [
    part(ep.kind),
    part(relationReferenceKey(ep.targetRelation)),
    part(ep.computedUsersetRelation ?? ""),
    part(ep.tuplesetRelation ?? ""),
    part(ep.resultStatus),
  ].join("|");
}

function addAll(
  entrypoints: readonly ReachabilityEntrypoint[],
  collected: ReachabilityEntrypoint[],
  seenKeys: Set<string>,
): void {
  for (const ep of entrypoints) {
    const key = entrypointDedupKey(ep);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      collected.push(ep);
    }
  }
}

/** Ordinal `(namespace, relation)` comparison: `a < b`, never `localeCompare`. */
function compareRelationReferenceOrdinal(a: RelationReference, b: RelationReference): number {
  if (a.namespace !== b.namespace) return a.namespace < b.namespace ? -1 : 1;
  if (a.relation !== b.relation) return a.relation < b.relation ? -1 : 1;
  return 0;
}

/**
 * Builds a fresh reachability graph for the given schema. Callers should build this at most once
 * per compiled schema and reuse the returned instance, rather than rebuilding it per request.
 *
 * @param namespaces The compiled namespace definitions, keyed by name.
 * @param mode `"full"` (the default) emits entrypoints for every operand of an
 * intersection/exclusion; `"first"` emits only the first operand's (the rest being validated by
 * Check), matching SpiceDB's optimized `FirstEntrypointsForSubjectToResource` that LookupResources
 * uses.
 */
export function buildReachabilityGraph(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  mode: ReachabilityMode = "full",
): ReachabilityGraph {
  // `ArgumentNullException.ThrowIfNull(namespaces)`: kept even though the parameter's TypeScript
  // type is non-optional, because callers reaching this from the grain boundary are untyped.
  if (namespaces === undefined || namespaces === null) {
    throw new InvalidArgumentError("namespaces is required");
  }
  return new ReachabilityGraphImpl(namespaces, mode);
}
