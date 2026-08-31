import { ELLIPSIS } from "@benedb/core/core-constants";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { isPermission } from "@benedb/core/relation";
import type { SetOperation, SetOperationChild } from "@benedb/core/userset-rewrite";

/**
 * Pure schema analysis for the Leopard membership accelerator: which `(resourceType,
 * nameOrPermission)` targets flatten, through union / intersection / exclusion of computed
 * usersets over STORED base relations, to a set of "yield" base relations whose edges directly
 * make a resource a candidate - and the full "scan set" of base relations that must be walked to
 * find those edges (yields plus their traversal closure). It carries no datastore reader and no
 * revision - a pure function of the compiled schema - so it is built once per schema snapshot
 * rather than once per request.
 *
 * Ported from Spiceport `src/Spiceport.Server/Engine/Lookup/MembershipCoverage.cs`.
 *
 * SAFETY MODEL: coverage is a CANDIDATE-set predicate - candidates, never verdicts. A covered
 * target's yield relations describe a COMPLETE superset of the resources a subject can reach; the
 * caller (the membership walk plus the confirming CheckEngine) is responsible for exactness. For
 * intersection/exclusion only the first (positive) operand seeds candidates (the rest can only
 * remove members, which Check re-applies). Any tuple-to-userset ARROW, a `self`/`this` legacy
 * operand, or a computed userset on a subject the walk has already traversed reaches resources
 * this stored-edge flatten cannot enumerate - those abort coverage and the caller falls back to
 * the live traversal. Every `default: return false` below is a deliberate abort, not an oversight.
 *
 * Port decisions:
 *   * The C# is a class with a private constructor plus a static `Build`, so it becomes this
 *     interface plus the exported {@link buildMembershipCoverage} factory.
 *   * TUPLE KEYS: the C# uses `Dictionary<(string, string), ...>` and `ImmutableHashSet<(string,
 *     string)>`, whose keys have structural equality. A JS `Map`/`Set` keyed by an array or object
 *     does not, so ONE length-prefixed canonical key function lives here and is never exported.
 *   * `ScanSet` is public in the C# and the membership walk calls
 *     `coverage.ScanSet.Contains((type, relation))`. Exposing a raw `ReadonlySet<string>` would
 *     force the caller to reproduce the key format, so {@link MembershipCoverage.scanSetHas} is
 *     the accessor and the two files cannot drift.
 *   * `TryGetYields(..., out ImmutableHashSet<string>)` returns `ReadonlySet<string> | undefined`:
 *     on a false return the C# `out` is left at its default null, so a truthiness check is the
 *     whole contract.
 *   * `IsEmpty` is a computed property, so it is a getter, never a snapshotted field.
 */
export interface MembershipCoverage {
  /** True if no target in this schema is coverable (the accelerator is a no-op for it). */
  readonly isEmpty: boolean;

  /**
   * If `resourceType`/`nameOrPermission` is a covered shape, returns the base relations on that
   * resource type whose stored edges directly make a resource a candidate. Returns `undefined`
   * for any shape this flatten does not cover (the caller must fall back to the live traversal).
   */
  tryGetYields(resourceType: string, nameOrPermission: string): ReadonlySet<string> | undefined;

  /**
   * True when `(type, relation)` is in the scan set: the union of every covered target's yield
   * relations and their userset traversal closure. A membership-walk hop discards any
   * reverse-query row whose (resource type, resource relation) is outside this set, because it
   * cannot contribute to any covered target.
   */
  scanSetHas(type: string, relation: string): boolean;
}

/**
 * The one canonical key for a `(string, string)` C# value tuple. LENGTH-PREFIXED rather than
 * separator-joined: the C# tuple's equality is unconditionally injective, and a separator the
 * grammar "excludes" would make this key's correctness depend on a validator in another layer.
 */
function pairKey(first: string, second: string): string {
  return `${first.length}:${first}|${second.length}:${second}`;
}

/**
 * Builds the coverage analysis for every relation of every namespace in the schema. One pass over
 * the compiled model; no datastore access.
 */
export function buildMembershipCoverage(
  namespaces: Iterable<NamespaceDefinition>,
): MembershipCoverage {
  // `ArgumentNullException.ThrowIfNull`, kept even though the TypeScript type is non-optional.
  if (namespaces === undefined || namespaces === null) {
    throw new InvalidArgumentError("namespaces is required");
  }

  const byType = new Map<string, NamespaceDefinition>();
  for (const ns of namespaces) {
    // `namespaces.ToImmutableDictionary(ns => ns.Name)` throws on a duplicate key; a bare
    // `Map.set` would let the last definition silently win, analysing a schema the C# refuses.
    if (byType.has(ns.name)) {
      throw new InvalidArgumentError(
        `An item with the same key has already been added. Key: ${ns.name}`,
      );
    }
    byType.set(ns.name, ns);
  }

  const covered = new Map<string, ReadonlySet<string>>();
  const scanSet = new Set<string>();

  for (const ns of byType.values()) {
    for (const relation of ns.relations) {
      const yields = new Set<string>();
      const closure = new Set<string>();
      // A target is coverable only when it flattens to stored base-relation edges (no arrows / self).
      if (!tryResolveYields(byType, ns.name, relation.name, yields, closure, new Set<string>())) {
        continue;
      }
      if (yields.size === 0) {
        continue;
      }
      covered.set(pairKey(ns.name, relation.name), yields);
      for (const c of closure) {
        scanSet.add(c);
      }
    }
  }

  return {
    get isEmpty(): boolean {
      return covered.size === 0;
    },
    tryGetYields(resourceType: string, nameOrPermission: string): ReadonlySet<string> | undefined {
      return covered.get(pairKey(resourceType, nameOrPermission));
    },
    scanSetHas(type: string, relation: string): boolean {
      return scanSet.has(pairKey(type, relation));
    },
  };
}

// Resolves the "yield" base relations on `type` that a relation/permission contributes,
// accumulating the full set of base relations to scan (yields plus their userset traversal
// closure). Returns false (aborts coverage) for any arrow / self / legacy operand or a missing
// relation. `visiting` guards permission cycles.
function tryResolveYields(
  byType: ReadonlyMap<string, NamespaceDefinition>,
  type: string,
  name: string,
  yields: Set<string>,
  closure: Set<string>,
  visiting: Set<string>,
): boolean {
  const ns = byType.get(type);
  if (ns === undefined) {
    return false;
  }
  const relation = ns.relations.find((r) => r.name === name);
  if (relation === undefined) {
    return false;
  }

  if (!isPermission(relation)) {
    // A stored base relation: its own edges yield resources of `type`, and its userset closure
    // must be all-base so the ancestor walk over those edges is complete.
    if (relation.typeInformation === undefined) {
      return false;
    }
    if (!tryAddClosure(byType, type, name, closure)) {
      return false;
    }
    yields.add(name);
    return true;
  }

  const visitKey = pairKey(type, name);
  if (visiting.has(visitKey)) {
    // Already being resolved on this path - a permission cycle contributes nothing new.
    return true;
  }
  visiting.add(visitKey);
  try {
    // `isPermission` is exactly "has a rewrite", so the rewrite is present here; this mirrors the
    // C#'s `relation.UsersetRewrite!`.
    return tryResolveOperation(
      byType,
      type,
      relation.usersetRewrite!.operation,
      yields,
      closure,
      visiting,
    );
  } finally {
    // try/finally, not a trailing delete: an exception from a deeper level must not leave the
    // marker behind and silently truncate a later branch.
    visiting.delete(visitKey);
  }
}

function tryResolveOperation(
  byType: ReadonlyMap<string, NamespaceDefinition>,
  type: string,
  operation: SetOperation,
  yields: Set<string>,
  closure: Set<string>,
  visiting: Set<string>,
): boolean {
  switch (operation.type) {
    case "union":
      // Members are the union of the children: every child must be coverable, all contribute
      // candidates.
      for (const child of operation.children) {
        if (!tryResolveChild(byType, type, child, yields, closure, visiting)) {
          return false;
        }
      }
      return true;

    case "intersection":
    case "exclusion": {
      // Members are a subset of the FIRST (positive) operand; it alone seeds a complete candidate
      // superset, and Check re-applies the intersection/exclusion. Later operands are ignored.
      //
      // DIVERGENCE: the C# indexes `operation.Children[0]` with no empty guard and throws
      // ArgumentOutOfRangeException on an operand-free operation. Under noUncheckedIndexedAccess
      // TypeScript hands back `undefined` instead, and the safe reading is "not coverable":
      // coverage may only ever be too narrow in a way that costs work, never in a way that drops
      // candidates. The DSL compiler cannot produce this shape.
      const first = operation.children[0];
      if (first === undefined) {
        return false;
      }
      return tryResolveChild(byType, type, first, yields, closure, visiting);
    }

    default:
      return false;
  }
}

function tryResolveChild(
  byType: ReadonlyMap<string, NamespaceDefinition>,
  type: string,
  child: SetOperationChild,
  yields: Set<string>,
  closure: Set<string>,
  visiting: Set<string>,
): boolean {
  switch (child.kind) {
    case "nil":
      return true; // contributes no members
    case "computedUserset":
      return child.value.object === "tupleObject"
        ? tryResolveYields(byType, type, child.value.relation, yields, closure, visiting)
        : false;
    case "nestedRewrite":
      return tryResolveOperation(byType, type, child.value.operation, yields, closure, visiting);
    default:
      // Self, This, tuple-to-userset arrows, and computed usersets on a traversed subject reach
      // resources this stored-edge flatten cannot enumerate - abort coverage so the caller runs
      // the live traversal.
      return false;
  }
}

// Adds `(type, relation)` and every base relation reachable through its non-ellipsis userset
// subject types, transitively, to `closure`. Returns false if the closure references a missing
// relation or a permission (a rewrite cannot be flattened from stored edges).
function tryAddClosure(
  byType: ReadonlyMap<string, NamespaceDefinition>,
  type: string,
  relation: string,
  closure: Set<string>,
): boolean {
  const queue: { readonly type: string; readonly relation: string }[] = [{ type, relation }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = pairKey(current.type, current.relation);
    if (closure.has(key)) {
      continue;
    }
    closure.add(key);

    const ns = byType.get(current.type);
    if (ns === undefined) {
      return false;
    }
    const rel = ns.relations.find((r) => r.name === current.relation);
    if (rel === undefined || isPermission(rel) || rel.typeInformation === undefined) {
      return false;
    }

    for (const allowed of rel.typeInformation.allowedDirectRelations) {
      if (allowed.kind !== "relation") {
        continue;
      }
      const sub = allowed.relationName ?? ELLIPSIS;
      if (sub === ELLIPSIS) {
        continue; // a terminal (leaf) subject type - no further userset edge.
      }
      queue.push({ type: allowed.objectType, relation: sub });
    }
  }

  return true;
}
