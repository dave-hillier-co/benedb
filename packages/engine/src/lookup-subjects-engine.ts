import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
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
  caveatExpressionCombineOr,
  caveatExpressionFromCaveat,
  caveatExpressionInvert,
  caveatExpressionOrKeepOther,
  type CaveatExpression,
} from "./caveat-expression";
import { systemClockNow } from "./clock";
import { createFoundSubject, type FoundSubject } from "./found-subject";

/**
 * The default maximum recursion depth.
 *
 * `LookupSubjectsEngine` declares its OWN copy of this constant in the C#; it stays a separate
 * constant here rather than being folded into `check-engine.ts`'s.
 */
export const DEFAULT_MAX_DEPTH = 50;

/**
 * Reverse-walks the userset-rewrite structure of a relation to enumerate the subjects (of a
 * requested type and optional subrelation) that hold it on a resource.
 *
 * Ported from Spiceport `src/Spiceport.Server/Engine/Lookup/LookupSubjectsEngine.cs`; port of
 * SpiceDB's `internal/graph/lookupsubjects.go`. Like `ExpandEngine` this walks the rewrite
 * structurally and does not consult any reachability graph (matching SpiceDB, where
 * `lookupsubjects.go` never touches reachability). Caveats are carried verbatim and combined
 * across union (OR), intersection (AND), exclusion (base AND NOT excluded) and arrows; a present
 * caveat on a yielded {@link FoundSubject} is the "Caveated marker". Wildcards (`"*"`) are carried
 * verbatim as `FoundSubject.isWildcard`. Recursion is bounded by a depth limit and a visited-set
 * cycle guard so cyclic schemas terminate.
 *
 * Port decisions:
 *   * `IAsyncEnumerable<FoundSubject>` becomes an `AsyncIterable<FoundSubject>` produced by an
 *     `async function*`. Only the OUTER generator streams: set operations need whole child sets,
 *     so internal collection stays materialised exactly as the C# has it.
 *   * `[EnumeratorCancellation] CancellationToken` becomes a trailing
 *     `signal?: AbortSignal | undefined` kept in the C#'s positional slot. `AsyncIterable` has no
 *     signal channel, so the producer takes it too and the yield loop checks it.
 *   * `ImmutableHashSet<string>` visited is COPY-ON-ADD, so sibling branches each receive the
 *     PARENT's set and never each other's accumulation.
 *   * `evaluationTime` is a `bigint` of epoch NANOSECONDS, as everywhere else in this package.
 *   * The `tupleObject` arrow branch (compute on the RESOURCE) is the same DELIBERATE divergence
 *     from `LocalDispatcher.checkTupleToUserset` that `ExpandEngine` has; see the note there.
 */
export class LookupSubjectsEngine {
  readonly #namespaces: ReadonlyMap<string, NamespaceDefinition>;
  readonly #maxDepth: number;

  /**
   * Creates a lookup-subjects engine over the given schema definitions.
   *
   * @param namespaces The compiled namespace definitions that make up the schema.
   * @param maxDepth The maximum recursion depth before traversal stops.
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
   * Enumerates the subjects of `subjectType` (with the given `subjectRelation`) that hold
   * `resource`'s relation, as of the reader's snapshot.
   *
   * @param reader A graph reader pinned to the revision to evaluate against.
   * @param resource The resource ONR (object type, id and relation/permission).
   * @param subjectType The requested subject namespace.
   * @param subjectRelation The requested subject relation; ellipsis for terminal subjects.
   * @param evaluationTime Optional pinned "now" (epoch nanoseconds) for expiration filtering;
   * defaults to the system clock.
   * @param signal A cancellation signal.
   */
  lookupSubjects(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    subjectType: string,
    subjectRelation?: string | undefined,
    evaluationTime?: bigint | undefined,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<FoundSubject> {
    if (reader === undefined || reader === null) {
      throw new InvalidArgumentError("reader is required");
    }
    if (resource === undefined || resource === null) {
      throw new InvalidArgumentError("resource is required");
    }
    if (subjectType === undefined || subjectType === null || subjectType.length === 0) {
      throw new InvalidArgumentError("subjectType is required");
    }
    const now = evaluationTime ?? systemClockNow();
    return this.#lookupAsync(
      reader,
      resource,
      subjectType,
      subjectRelation ?? ELLIPSIS,
      now,
      this.#maxDepth,
      new Set<string>(),
      signal,
    );
  }

  async *#lookupAsync(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    subjectType: string,
    subjectRelation: string,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<FoundSubject> {
    const collected = await this.#collect(
      reader,
      resource,
      subjectType,
      subjectRelation,
      now,
      depthRemaining,
      visited,
      signal,
    );
    for (const found of collected.toFoundSubjects()) {
      signal?.throwIfAborted();
      yield found;
    }
  }

  // Collects the full subject set for a sub-problem into a combinable map. Set operations need the
  // whole child set before combining (intersection/exclusion), so collection is materialized rather
  // than streamed internally; the public surface still streams the final result.
  async #collect(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    subjectType: string,
    subjectRelation: string,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<SubjectSet> {
    signal?.throwIfAborted();

    const result = new SubjectSet();

    // Self short-circuit: the resource itself is a subject of the requested (type, relation). NOTE
    // it runs BEFORE the depth/visited guard, so a self-match survives depth exhaustion.
    if (subjectType === resource.objectType && subjectRelation === resource.relation) {
      result.add(resource.objectId, undefined, isPublicWildcard(resource));
    }

    const key = `${resource.objectType}:${resource.objectId}#${resource.relation}`;
    if (depthRemaining <= 0 || visited.has(key)) {
      return result;
    }
    // Copy-on-add: this local rebinding is what keeps sibling branches independent.
    const nextVisited: ReadonlySet<string> = new Set(visited).add(key);

    const relation = this.#lookupRelation(resource.objectType, resource.relation);
    if (relation === undefined) {
      return result;
    }

    const rewrite = relation.usersetRewrite;
    if (rewrite !== undefined) {
      const rewritten = await this.#collectRewrite(
        reader,
        resource,
        rewrite.operation,
        subjectType,
        subjectRelation,
        now,
        depthRemaining,
        nextVisited,
        signal,
      );
      result.unionWith(rewritten);
    } else {
      const direct = await this.#collectDirect(
        reader,
        resource,
        relation.name,
        subjectType,
        subjectRelation,
        now,
        depthRemaining,
        nextVisited,
        signal,
      );
      result.unionWith(direct);
    }

    return result;
  }

  /** Reverse-walks a base relation's tuples (port of `lookupDirectSubjects`). */
  async #collectDirect(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    relation: string,
    subjectType: string,
    subjectRelation: string,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<SubjectSet> {
    const filter: RelationshipsFilter = {
      optionalResourceType: resource.objectType,
      optionalResourceIds: [resource.objectId],
      optionalResourceRelation: relation,
    };

    const result = new SubjectSet();
    for await (const rel of reader.queryRelationships(filter, signal)) {
      if (isExpired(rel, now)) {
        continue;
      }

      const subject = rel.reference.subject;
      const tupleCaveat = caveatOf(rel);

      // Direct match of (type, relation). This includes a :* wildcard matching (type, ellipsis):
      // "all subjects of this type" semantics, carried verbatim with isWildcard.
      if (subject.objectType === subjectType && subject.relation === subjectRelation) {
        result.add(subject.objectId, tupleCaveat, isPublicWildcard(subject));
        continue;
      }

      // Non-terminal subrelation (not ellipsis, not wildcard): recurse and AND-in this tuple's
      // caveat.
      if (subject.relation !== ELLIPSIS && !isPublicWildcard(subject)) {
        const nested = await this.#collect(
          reader,
          subject,
          subjectType,
          subjectRelation,
          now,
          depthRemaining - 1,
          visited,
          signal,
        );
        result.unionWith(nested.withAndedCaveat(tupleCaveat));
      }
    }

    return result;
  }

  /** Reverse-walks a rewrite set operation (port of `lookupViaRewrite`/`lookupSetOperation`). */
  async #collectRewrite(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    operation: SetOperation,
    subjectType: string,
    subjectRelation: string,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<SubjectSet> {
    const childSets: SubjectSet[] = [];
    for (const child of operation.children) {
      childSets.push(
        await this.#collectChild(
          reader,
          resource,
          child,
          subjectType,
          subjectRelation,
          now,
          depthRemaining,
          visited,
          signal,
        ),
      );
    }

    switch (operation.type) {
      case "union":
        return subjectSetUnion(childSets);
      case "intersection":
        return subjectSetIntersect(childSets);
      case "exclusion":
        return subjectSetExclude(childSets);
      default:
        // The C# switch expression has a discard arm returning an empty set.
        return assertNeverEmptySet(operation.type);
    }
  }

  /** Reverse-walks a single set-operation operand. */
  async #collectChild(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    child: SetOperationChild,
    subjectType: string,
    subjectRelation: string,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<SubjectSet> {
    switch (child.kind) {
      case "this":
        return await this.#collectDirect(
          reader,
          resource,
          resource.relation,
          subjectType,
          subjectRelation,
          now,
          depthRemaining,
          visited,
          signal,
        );

      case "nil":
        return new SubjectSet();

      case "self": {
        // The resource itself, at ellipsis, is a subject if it matches the request.
        const s = new SubjectSet();
        if (subjectType === resource.objectType && subjectRelation === ELLIPSIS) {
          s.add(resource.objectId, undefined, isPublicWildcard(resource));
        }
        return s;
      }

      case "computedUserset":
        return await this.#collect(
          reader,
          withRelation(resource, child.value.relation),
          subjectType,
          subjectRelation,
          now,
          depthRemaining - 1,
          visited,
          signal,
        );

      case "tupleToUserset":
        return await this.#collectTupleToUserset(
          reader,
          resource,
          child.value.tuplesetRelation,
          child.value.computedUserset,
          "any",
          subjectType,
          subjectRelation,
          now,
          depthRemaining,
          visited,
          signal,
        );

      case "functionedTupleToUserset":
        return await this.#collectTupleToUserset(
          reader,
          resource,
          child.value.tuplesetRelation,
          child.value.computedUserset,
          child.value.function,
          subjectType,
          subjectRelation,
          now,
          depthRemaining,
          visited,
          signal,
        );

      case "nestedRewrite":
        return await this.#collectRewrite(
          reader,
          resource,
          child.value.operation,
          subjectType,
          subjectRelation,
          now,
          depthRemaining,
          visited,
          signal,
        );

      default:
        // The C# default arm returns an empty set rather than throwing; the exhaustiveness check
        // is kept alongside it so a new variant is a compile error, not a silent empty set.
        return assertNeverEmptySet(child);
    }
  }

  /**
   * Reverse-walks a tuple-to-userset arrow (port of `lookupViaTupleToUserset` /
   * `lookupViaIntersectionTupleToUserset`): traverse the tupleset, recurse on each reached object's
   * computed relation, AND-in the tupleset tuple caveat, then union (`.any()`) or intersect
   * (`.all()`) across reached objects. An empty `.all()` tupleset yields nothing, because
   * `Intersect([])` returns an EMPTY set.
   */
  async #collectTupleToUserset(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    tuplesetRelation: string,
    computed: ComputedUserset,
    func: TupleToUsersetFunction,
    subjectType: string,
    subjectRelation: string,
    now: bigint,
    depthRemaining: number,
    visited: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<SubjectSet> {
    const filter: RelationshipsFilter = {
      optionalResourceType: resource.objectType,
      optionalResourceIds: [resource.objectId],
      optionalResourceRelation: tuplesetRelation,
    };

    const perTarget: SubjectSet[] = [];
    for await (const rel of reader.queryRelationships(filter, signal)) {
      if (isExpired(rel, now)) {
        continue;
      }

      const reached = rel.reference.subject;
      if (isPublicWildcard(reached)) {
        continue;
      }

      // "tupleObject" => compute on the resource; "tupleUsersetObject" => compute on the traversed
      // subject. Same DELIBERATE divergence from `LocalDispatcher.checkTupleToUserset` (which
      // ALWAYS computes on the reached subject) that `ExpandEngine` has.
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

      const nested = await this.#collect(
        reader,
        target,
        subjectType,
        subjectRelation,
        now,
        depthRemaining - 1,
        visited,
        signal,
      );
      perTarget.push(nested.withAndedCaveat(caveatOf(rel)));
    }

    return func === "all" ? subjectSetIntersect(perTarget) : subjectSetUnion(perTarget);
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

function isExpired(rel: Relationship, now: bigint): boolean {
  const exp = rel.optionalExpiration;
  return exp !== undefined && exp <= now;
}

function caveatOf(rel: Relationship): CaveatExpression | undefined {
  const c = rel.optionalCaveat;
  return c !== undefined ? caveatExpressionFromCaveat(c) : undefined;
}

function assertNeverEmptySet(value: never): SubjectSet {
  void (value satisfies never);
  return new SubjectSet();
}

/**
 * A concrete subject entry. A C# `readonly record struct`; here a frozen-by-convention interface
 * that is never mutated in place - every "update" constructs a fresh object, matching the struct's
 * copy-on-assignment semantics.
 */
interface Concrete {
  readonly id: string;
  readonly caveat?: CaveatExpression | undefined;
}

/**
 * The single optional public wildcard, with its exclusions. A C# `sealed record` (a class), shared
 * by reference from `clone()`; that is safe ONLY because a `Wildcard` is never mutated in place.
 */
interface Wildcard {
  readonly caveat?: CaveatExpression | undefined;
  readonly excluded: readonly Concrete[];
}

/**
 * A combinable set of found subjects with first-class wildcard semantics. Port of SpiceDB's
 * `internal/datasets/basesubjectset.go`: concrete subjects are tracked by id, and the public
 * wildcard (`"*"`) is tracked separately as a single optional entry carrying its own caveat and a
 * list of EXCLUDED concrete subjects.
 *
 * Unlike a plain set, a union between a wildcard and a concrete keeps BOTH present. Intersecting a
 * wildcard with a concrete yields the concrete (a concrete matches the wildcard, modulo exclusions
 * and caveats); subtracting a wildcard removes all concretes modulo its exclusions. A
 * concrete/exclusion whose entry has an absent caveat is unconditional.
 *
 * Port notes:
 *   * The C# uses `FirstOrDefault` over a `readonly record struct` alongside a separate `Any`, so
 *     the "not found" case yields `default(Concrete)` (a null Id and Caveat) rather than null, and
 *     the code only reads it inside the `isExcluded` branch. `Array.find` returns `undefined` and
 *     dereferencing it throws, so those two calls are restructured into a single find plus an
 *     `undefined` check. The observable behaviour is identical.
 *   * `_concrete` is a `Dictionary<string, Concrete>` whose iteration order feeds
 *     `toFoundSubjects` and therefore the yielded order. .NET's is unspecified and disturbed by
 *     removals; a JS `Map`'s is stable insertion order. Every covering test sorts (as the C# ones
 *     do), so no case depends on either order and no defensive sort is added - adding one would be
 *     a behaviour change the C# does not have.
 *   * `CombineOr` (short-circuited) and `OrKeepOther` are used at DIFFERENT sites here; swapping
 *     them is a silent semantic change.
 */
class SubjectSet {
  // Concrete subjects by id (never the wildcard id).
  readonly #concrete = new Map<string, Concrete>();
  // The single optional public wildcard with its exclusions, or undefined when absent.
  #wildcard: Wildcard | undefined = undefined;

  /** Adds a subject (concrete or wildcard) via union semantics. */
  add(id: string, caveat: CaveatExpression | undefined, isWildcard: boolean): void {
    if (id === PUBLIC_WILDCARD || isWildcard) {
      this.#addWildcard({ caveat, excluded: [] });
      return;
    }
    this.#addConcrete({ id, caveat });
  }

  #addConcrete(adding: Concrete): void {
    // Union the wildcard with this concrete (the wildcard's exclusion of this id, if any, is
    // weakened) and union the concrete with any existing same-id concrete.
    const existing = this.#concrete.get(adding.id);
    if (existing !== undefined) {
      this.#concrete.set(adding.id, {
        id: adding.id,
        caveat: caveatExpressionOrKeepOther(existing.caveat, adding.caveat),
      });
    } else {
      this.#concrete.set(adding.id, adding);
    }

    if (this.#wildcard !== undefined) {
      this.#wildcard = unionWildcardWithConcrete(this.#wildcard, adding);
    }
  }

  #addWildcard(adding: Wildcard): void {
    this.#wildcard = unionWildcardWithWildcard(this.#wildcard, adding);
    // Re-union the wildcard with every concrete so its exclusions stay consistent. The local `w`
    // is reassigned around the loop and written back; dropping the write-back silently loses the
    // exclusion weakening.
    if (this.#wildcard !== undefined) {
      let w = this.#wildcard;
      for (const c of this.#concrete.values()) {
        w = unionWildcardWithConcrete(w, c);
      }
      this.#wildcard = w;
    }
  }

  unionWith(other: SubjectSet): void {
    for (const c of other.#concrete.values()) {
      this.#addConcrete(c);
    }
    if (other.#wildcard !== undefined) {
      this.#addWildcard(other.#wildcard);
    }
  }

  /**
   * Returns a copy of this set with `caveat` AND-combined into every entry. An absent caveat
   * returns `this` (aliasing, not a copy) exactly as the C# does; safe because callers only read
   * the result.
   */
  withAndedCaveat(caveat: CaveatExpression | undefined): SubjectSet {
    if (caveat === undefined) {
      return this;
    }
    const copy = new SubjectSet();
    for (const [id, c] of this.#concrete) {
      copy.#concrete.set(id, { id, caveat: caveatExpressionCombineAnd(caveat, c.caveat) });
    }
    if (this.#wildcard !== undefined) {
      // The caveat constrains whether the wildcard applies; exclusions are unchanged.
      copy.#wildcard = {
        caveat: caveatExpressionCombineAnd(caveat, this.#wildcard.caveat),
        excluded: this.#wildcard.excluded,
      };
    }
    return copy;
  }

  toFoundSubjects(): readonly FoundSubject[] {
    const results: FoundSubject[] = [];
    for (const c of this.#concrete.values()) {
      results.push(createFoundSubject(c.id, c.caveat, false));
    }
    const w = this.#wildcard;
    if (w !== undefined) {
      // Absent, NOT empty, when there are no exclusions: `undefined` and `[]` stay distinct on
      // FoundSubject and the C# only ever emits the null.
      const excluded =
        w.excluded.length === 0
          ? undefined
          : w.excluded.map((e) => createFoundSubject(e.id, e.caveat, false));
      results.push(createFoundSubject(PUBLIC_WILDCARD, w.caveat, true, excluded));
    }
    return results;
  }

  clone(): SubjectSet {
    const copy = new SubjectSet();
    for (const [id, c] of this.#concrete) {
      copy.#concrete.set(id, c);
    }
    // Shallow: the wildcard is SHARED by reference, safe only because it is never mutated in place.
    copy.#wildcard = this.#wildcard;
    return copy;
  }

  // ---- intersection (port of IntersectionDifference) ----

  intersectWith(other: SubjectSet): void {
    const existingWildcard = this.#wildcard;
    const otherWildcard = other.#wildcard;

    const newWildcard = intersectWildcardWithWildcard(existingWildcard, otherWildcard);

    const updated = new Map<string, Concrete>();
    for (const concrete of this.#concrete.values()) {
      const otherConcrete = other.#concrete.get(concrete.id);

      const concreteIntersected = intersectConcreteWithConcrete(concrete, otherConcrete);
      const otherWildcardIntersected = intersectConcreteWithWildcard(concrete, otherWildcard);

      const result = unionConcreteWithConcrete(concreteIntersected, otherWildcardIntersected);
      if (result !== undefined) {
        updated.set(concrete.id, result);
      }
    }

    if (existingWildcard !== undefined) {
      for (const otherSubject of other.#concrete.values()) {
        const existingWildcardIntersect = intersectConcreteWithWildcard(
          otherSubject,
          existingWildcard,
        );
        const existingUpdated = updated.get(otherSubject.id);
        if (existingUpdated !== undefined) {
          const result = unionConcreteWithConcrete(existingUpdated, existingWildcardIntersect);
          if (result !== undefined) {
            updated.set(otherSubject.id, result);
          }
        } else if (existingWildcardIntersect !== undefined) {
          updated.set(otherSubject.id, existingWildcardIntersect);
        }
      }
    }

    this.#concrete.clear();
    for (const [id, c] of updated) {
      this.#concrete.set(id, c);
    }
    this.#wildcard = newWildcard;
  }

  // ---- subtraction (port of SubtractAll / Subtract) ----

  subtractAll(other: SubjectSet): void {
    for (const c of other.#concrete.values()) {
      this.#subtract({ id: c.id, caveat: c.caveat }, false, []);
    }
    if (other.#wildcard !== undefined) {
      this.#subtract(
        { id: PUBLIC_WILDCARD, caveat: other.#wildcard.caveat },
        true,
        other.#wildcard.excluded,
      );
    }
  }

  #subtract(
    toRemove: Concrete,
    isWildcard: boolean,
    wildcardExclusions: readonly Concrete[],
  ): void {
    if (isWildcard) {
      const wildcardToRemove: Wildcard = { caveat: toRemove.caveat, excluded: wildcardExclusions };
      // The C# iterates `_concrete.Keys.ToList()` - a COPY - while mutating the dictionary.
      for (const id of [...this.#concrete.keys()]) {
        const current = this.#concrete.get(id);
        if (current === undefined) {
          continue;
        }
        const updated = subtractWildcardFromConcrete(current, wildcardToRemove);
        if (updated !== undefined) {
          this.#concrete.set(id, updated);
        } else {
          this.#concrete.delete(id);
        }
      }

      const { wildcard: newWildcard, concretesToAdd } = subtractWildcardFromWildcard(
        this.#wildcard,
        wildcardToRemove,
      );
      this.#wildcard = newWildcard;
      for (const c of concretesToAdd) {
        this.#concrete.set(c.id, c);
      }
      return;
    }

    const existing = this.#concrete.get(toRemove.id);
    if (existing !== undefined) {
      const updated = subtractConcreteFromConcrete(existing, toRemove);
      if (updated !== undefined) {
        this.#concrete.set(toRemove.id, updated);
      } else {
        this.#concrete.delete(toRemove.id);
      }
    }

    if (this.#wildcard !== undefined) {
      this.#wildcard = subtractConcreteFromWildcard(this.#wildcard, toRemove);
    }
  }
}

function subjectSetUnion(sets: readonly SubjectSet[]): SubjectSet {
  const result = new SubjectSet();
  for (const s of sets) {
    result.unionWith(s);
  }
  return result;
}

function subjectSetIntersect(sets: readonly SubjectSet[]): SubjectSet {
  const first = sets[0];
  if (first === undefined) {
    return new SubjectSet();
  }

  const result = first.clone();
  for (let i = 1; i < sets.length; i++) {
    const next = sets[i];
    if (next !== undefined) {
      result.intersectWith(next);
    }
  }
  return result;
}

function subjectSetExclude(sets: readonly SubjectSet[]): SubjectSet {
  const first = sets[0];
  if (first === undefined) {
    return new SubjectSet();
  }

  const result = first.clone();
  for (let i = 1; i < sets.length; i++) {
    const next = sets[i];
    if (next !== undefined) {
      result.subtractAll(next);
    }
  }
  return result;
}

// ---- combinators (ports of the basesubjectset.go helpers) ----

function unionConcreteWithConcrete(
  existing: Concrete | undefined,
  adding: Concrete | undefined,
): Concrete | undefined {
  if (existing === undefined) {
    return adding;
  }
  if (adding === undefined) {
    return existing;
  }
  // An absent (unconditional) caveat on either side dominates the OR.
  return { id: existing.id, caveat: caveatExpressionCombineOr(existing.caveat, adding.caveat) };
}

function unionWildcardWithWildcard(existing: Wildcard | undefined, adding: Wildcard): Wildcard {
  if (existing === undefined) {
    return adding;
  }

  // The union wildcard applies when either applies; its exclusions are those excluded by BOTH
  // (intersection of exclusion sets), since an exclusion only survives if both exclude it.
  const caveat = caveatExpressionOrKeepOther(existing.caveat, adding.caveat);
  const addingExclusions = new Map<string, Concrete>();
  for (const e of adding.excluded) {
    addingExclusions.set(e.id, e);
  }
  const newExclusions: Concrete[] = [];
  for (const ex of existing.excluded) {
    const other = addingExclusions.get(ex.id);
    if (other !== undefined) {
      // Excluded by both: survives as an exclusion only when both exclusions hold (AND).
      const c = caveatExpressionCombineAnd(ex.caveat, other.caveat);
      newExclusions.push({ id: ex.id, caveat: c });
    }
  }
  return { caveat, excluded: newExclusions };
}

function unionWildcardWithConcrete(wildcard: Wildcard, adding: Concrete): Wildcard {
  // Adding a concrete to a wildcard weakens any matching exclusion: the concrete is now present,
  // so the exclusion only holds when the concrete's caveat is false AND the prior exclusion held.
  // A non-caveated concrete removes the exclusion outright.
  const newExclusions: Concrete[] = [];
  for (const ex of wildcard.excluded) {
    if (ex.id !== adding.id) {
      newExclusions.push(ex);
      continue;
    }
    if (adding.caveat === undefined) {
      continue; // unconditional concrete: exclusion removed.
    }
    // exclusion survives as ex.Caveat AND NOT(adding.Caveat).
    const c = caveatExpressionCombineAnd(ex.caveat, caveatExpressionInvert(adding.caveat));
    if (c !== undefined) {
      newExclusions.push({ id: ex.id, caveat: c });
    }
  }
  return { caveat: wildcard.caveat, excluded: newExclusions };
}

function intersectConcreteWithConcrete(
  first: Concrete,
  second: Concrete | undefined,
): Concrete | undefined {
  if (second === undefined) {
    return undefined;
  }
  return { id: first.id, caveat: caveatExpressionCombineAnd(first.caveat, second.caveat) };
}

function intersectWildcardWithWildcard(
  first: Wildcard | undefined,
  second: Wildcard | undefined,
): Wildcard | undefined {
  if (first === undefined || second === undefined) {
    return undefined;
  }
  // Intersection: AND of conditionals, UNION of exclusions.
  const exclusions = new Map<string, Concrete>();
  for (const e of [...first.excluded, ...second.excluded]) {
    const x = exclusions.get(e.id);
    exclusions.set(
      e.id,
      x !== undefined ? { id: e.id, caveat: caveatExpressionOrKeepOther(x.caveat, e.caveat) } : e,
    );
  }
  return {
    caveat: caveatExpressionCombineAnd(first.caveat, second.caveat),
    excluded: [...exclusions.values()],
  };
}

function intersectConcreteWithWildcard(
  concrete: Concrete,
  wildcard: Wildcard | undefined,
): Concrete | undefined {
  if (wildcard === undefined) {
    return undefined;
  }

  // The C# pairs `FirstOrDefault` with a separate `Any`; over a record STRUCT the not-found case
  // is `default(Concrete)`, never null, and `exclusion.Caveat` is only read inside the excluded
  // branch. A single find plus an undefined check is the equivalent that does not throw in TS.
  const exclusion = wildcard.excluded.find((e) => e.id === concrete.id);
  const isExcluded = exclusion !== undefined;

  if (!isExcluded && wildcard.caveat === undefined) {
    return concrete; // {tom} & {*} => {tom}
  }
  if (!isExcluded) {
    return {
      id: concrete.id,
      caveat: caveatExpressionCombineAnd(concrete.caveat, wildcard.caveat),
    };
  }
  if (exclusion.caveat === undefined) {
    return undefined; // unconditionally excluded.
  }
  // excluded conditionally: concrete AND wildcard AND NOT(exclusion).
  return {
    id: concrete.id,
    caveat: caveatExpressionCombineAnd(
      concrete.caveat,
      caveatExpressionCombineAnd(wildcard.caveat, caveatExpressionInvert(exclusion.caveat)),
    ),
  };
}

function subtractConcreteFromConcrete(
  existing: Concrete,
  toRemove: Concrete,
): Concrete | undefined {
  if (toRemove.caveat === undefined) {
    return undefined;
  }
  // existing AND NOT(toRemove).
  return {
    id: existing.id,
    caveat: caveatExpressionCombineAnd(existing.caveat, caveatExpressionInvert(toRemove.caveat)),
  };
}

function subtractConcreteFromWildcard(wildcard: Wildcard, concreteToRemove: Concrete): Wildcard {
  // Subtracting a concrete adds it to the wildcard's exclusions.
  const newExclusions: Concrete[] = [];
  let found = false;
  for (const ex of wildcard.excluded) {
    if (ex.id === concreteToRemove.id) {
      // shortcircuited OR: either side non-caveated => exclusion non-caveated.
      const c = caveatExpressionCombineOr(ex.caveat, concreteToRemove.caveat);
      newExclusions.push({ id: ex.id, caveat: c });
      found = true;
    } else {
      newExclusions.push(ex);
    }
  }
  if (!found) {
    newExclusions.push(concreteToRemove);
  }
  return { caveat: wildcard.caveat, excluded: newExclusions };
}

function subtractWildcardFromConcrete(
  existingConcrete: Concrete,
  wildcardToRemove: Wildcard,
): Concrete | undefined {
  // Same single-find restructure as `intersectConcreteWithWildcard`; see the note there.
  const exclusion = wildcardToRemove.excluded.find((e) => e.id === existingConcrete.id);

  if (exclusion === undefined) {
    // Not in the exclusions: removed when the wildcard applies. Unconditional wildcard removes it
    // outright; a caveated wildcard keeps it conditional on NOT(wildcard).
    if (wildcardToRemove.caveat === undefined) {
      return undefined;
    }
    return {
      id: existingConcrete.id,
      caveat: caveatExpressionCombineAnd(
        existingConcrete.caveat,
        caveatExpressionInvert(wildcardToRemove.caveat),
      ),
    };
  }

  // Excluded from the wildcard: present unless the exclusion itself is conditional.
  if (exclusion.caveat === undefined) {
    return existingConcrete;
  }

  // Present when the exclusion holds OR the wildcard does not apply.
  const exclusionConditional = caveatExpressionOrKeepOther(
    caveatExpressionInvert(wildcardToRemove.caveat),
    exclusion.caveat,
  );
  return {
    id: existingConcrete.id,
    caveat: caveatExpressionCombineAnd(existingConcrete.caveat, exclusionConditional),
  };
}

/** The C# value-tuple return becomes a named readonly interface, per the guide. */
interface SubtractWildcardResult {
  readonly wildcard: Wildcard | undefined;
  readonly concretesToAdd: readonly Concrete[];
}

function subtractWildcardFromWildcard(
  existing: Wildcard | undefined,
  toRemove: Wildcard,
): SubtractWildcardResult {
  if (existing === undefined) {
    return { wildcard: undefined, concretesToAdd: [] };
  }

  // Unconditional removal with no exclusions: {*} - {*} => {}.
  if (toRemove.caveat === undefined && toRemove.excluded.length === 0) {
    return { wildcard: undefined, concretesToAdd: [] };
  }

  const existingExclusions = new Map<string, Concrete>();
  for (const e of existing.excluded) {
    existingExclusions.set(e.id, e);
  }
  const concretesToAdd: Concrete[] = [];
  for (const excludedSubject of toRemove.excluded) {
    const existingExclusion = existingExclusions.get(excludedSubject.id);
    const hasExisting = existingExclusion !== undefined;
    if (!hasExisting || existingExclusion.caveat !== undefined) {
      let expr = caveatExpressionCombineAnd(
        caveatExpressionCombineAnd(existing.caveat, toRemove.caveat),
        excludedSubject.caveat,
      );
      if (hasExisting && existingExclusion.caveat !== undefined) {
        expr = caveatExpressionCombineAnd(
          caveatExpressionCombineAnd(
            caveatExpressionCombineAnd(existing.caveat, toRemove.caveat),
            caveatExpressionInvert(existingExclusion.caveat),
          ),
          excludedSubject.caveat,
        );
      }
      concretesToAdd.push({ id: excludedSubject.id, caveat: expr });
    }
  }

  const combined = caveatExpressionCombineAnd(
    existing.caveat,
    caveatExpressionInvert(toRemove.caveat),
  );
  if (combined !== undefined) {
    return { wildcard: { caveat: combined, excluded: existing.excluded }, concretesToAdd };
  }
  return { wildcard: undefined, concretesToAdd };
}
