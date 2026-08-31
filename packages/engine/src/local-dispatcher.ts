import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { IRevision } from "@benedb/core/i-revision";
import { MaxDepthExceededException } from "@benedb/core/max-depth-exceeded-exception";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import {
  isPublicWildcard,
  objectAndRelationEquals,
  withRelation,
  type ObjectAndRelation,
} from "@benedb/core/object-and-relation";
import type { Relation } from "@benedb/core/relation";
import type { Relationship } from "@benedb/core/relationship";
import type {
  ComputedUserset,
  SetOperation,
  SetOperationChild,
  TupleToUsersetFunction,
} from "@benedb/core/userset-rewrite";
import type { IGraphReader } from "@benedb/datastore/i-graph-reader";
import type {
  RelationshipsFilter,
  SubjectRelationFilter,
} from "@benedb/datastore/relationships-filter";

import {
  caveatExpressionCombineAnd,
  caveatExpressionCombineOr,
  caveatExpressionFromCaveat,
  caveatExpressionSubtract,
  type CaveatExpression,
} from "./caveat-expression";
import {
  DISPATCH_CHECK_DEFINITE_MEMBER,
  DISPATCH_CHECK_NONE,
  dispatchCheckCaveatedMember,
  isDispatchCheckDetermined,
  resolverMetaWithVisited,
  visitKeyOf,
  type DispatchCheckRequest,
  type DispatchCheckResult,
  type IDispatcher,
  type ResolverMeta,
} from "./i-dispatcher";

/** A non-terminal subject reached mid-walk, with the caveat carried by the tuple that reached it. */
interface Intermediate {
  readonly onr: ObjectAndRelation;
  readonly parent: CaveatExpression | undefined;
}

/**
 * An {@link IDispatcher} that performs one expansion step of the check graph in-process and calls
 * back through the (injected) {@link LocalDispatcher.dispatcher} for every further sub-problem.
 *
 * Ported from Spiceport `Engine/LocalDispatcher.cs`.
 *
 * The local dispatcher and its "step" logic are the same object: {@link dispatchCheck} does exactly
 * one expansion (resolve the relation, match tuples, evaluate a rewrite) and routes any recursion
 * back out through {@link dispatcher}. By default `dispatcher` is `this`, but a caller may set it
 * to a decorator (e.g. a counting or caching wrapper) so that every sub-problem flows through that
 * decorator. That reassignment is genuine mutable state on a live object, which is why this stays a
 * CLASS rather than a closure over a frozen self-reference.
 *
 * **Caveat-completeness invariant.** This dispatcher models one (resource, subject) per dispatch,
 * so it has no analogue of SpiceDB's batched `ResultsSetting`. SpiceDB batches many resource ids
 * with an "allow single result" short-circuit and must force `REQUIRE_ALL_RESULTS` when any
 * incoming relationship is caveated, so every caveat reaches the final expression
 * (`internal/graph/check.go:482-512`). The equivalent guarantee here rests on a single rule: every
 * union / arrow accumulation below short-circuits ONLY on a DEFINITE, UNCAVEATED member
 * ({@link isDispatchCheckDetermined}, i.e. `member && caveat === undefined`) - never on a caveated
 * branch. Since `caveatExpr OR definitely-true` collapses to true, that drop cannot change a
 * verdict, while every undetermined branch is OR-accumulated and survives to `CheckEngine.collapse`.
 * Do NOT add an "any member found" early return that fires on a caveated result: it would silently
 * drop caveats and is the exact regression covered by `caveat-completeness-tests.test.ts`
 * (issue #3, finding 5).
 */
export class LocalDispatcher implements IDispatcher {
  readonly #namespaces: ReadonlyMap<string, NamespaceDefinition>;
  readonly #readerFor: (revision: IRevision) => IGraphReader;
  readonly #now: bigint;

  /**
   * The dispatcher used for sub-problems. Defaults to `this`; set it to a decorator to route every
   * recursive sub-problem through it. MUTABLE by design - see the class remarks.
   */
  dispatcher: IDispatcher;

  /**
   * Creates a local dispatcher over the given schema, reader resolver and evaluation clock.
   *
   * @param namespaces The compiled namespace definitions keyed by name.
   * @param readerFor Resolves a snapshot reader for a request's revision identity.
   * @param now The pinned evaluation "now" (epoch nanoseconds) used to filter expired relationships.
   */
  constructor(
    namespaces: ReadonlyMap<string, NamespaceDefinition>,
    readerFor: (revision: IRevision) => IGraphReader,
    now: bigint,
  ) {
    if (namespaces === undefined || namespaces === null) {
      throw new InvalidArgumentError("namespaces is required");
    }
    if (readerFor === undefined || readerFor === null) {
      throw new InvalidArgumentError("readerFor is required");
    }
    this.#namespaces = namespaces;
    this.#readerFor = readerFor;
    this.#now = now;
    this.dispatcher = this;
  }

  /** @inheritdoc */
  async dispatchCheck(
    request: DispatchCheckRequest,
    signal: AbortSignal | undefined,
  ): Promise<DispatchCheckResult> {
    if (request === undefined || request === null) {
      throw new InvalidArgumentError("request is required");
    }
    signal?.throwIfAborted();

    const resource = request.resource;
    const subject = request.subject;
    let meta = request.meta;

    // Depth exhaustion is the ONLY termination guarantee (SpiceDB's dispatch.CheckDepth). It raises
    // MaxDepthExceededException (gRPC FailedPrecondition) rather than returning a definitive
    // non-member, so a graph deeper than maxDepth - or a genuine cycle - fails the request instead
    // of producing a confident (and cacheable) false negative. A true cycle simply consumes depth
    // here until it throws, matching SpiceDB exactly: there is NO visited-set cut on the verdict
    // path.
    if (meta.depthRemaining <= 0) {
      throw new MaxDepthExceededException();
    }

    // Fast path: the resource ONR is literally the subject ONR.
    if (objectAndRelationEquals(resource, subject)) {
      return DISPATCH_CHECK_DEFINITE_MEMBER;
    }

    // Record this (resource, subject) into the exact visited set - RECORD ONLY, never
    // Contains->Cut. Correctness does not rest on the visited set; it is kept solely so a
    // downstream dispatcher can detect a genuine same-path revisit on the next hop and mark that
    // hop's result cycleCut so it is never memoized, mirroring SpiceDB's singleflight loop guard.
    const key = visitKeyOf(resource, subject);
    meta = resolverMetaWithVisited(meta, key);

    const relation = this.#lookupRelation(resource.objectType, resource.relation);
    if (relation === undefined) {
      return DISPATCH_CHECK_NONE;
    }

    const reader = this.#readerFor(meta.revision);

    const rewrite = relation.usersetRewrite;
    return rewrite !== undefined
      ? await this.#checkRewrite(reader, resource, subject, rewrite.operation, meta, signal)
      : await this.#checkDirect(reader, resource, subject, meta, signal);
  }

  /** Dispatches a sub-problem at a decremented depth through the injected dispatcher. */
  async #sub(
    resource: ObjectAndRelation,
    subject: ObjectAndRelation,
    meta: ResolverMeta,
    signal: AbortSignal | undefined,
  ): Promise<DispatchCheckResult> {
    const subMeta: ResolverMeta = { ...meta, depthRemaining: meta.depthRemaining - 1 };
    const child = await this.dispatcher.dispatchCheck({ resource, subject, meta: subMeta }, signal);
    // This dispatch hop consumes one level of depth: the result this node returns requires one more
    // than whatever its child required. Mirrors SpiceDB's addCallToResponseMetadata.
    return { ...child, depthRequired: child.depthRequired + 1 };
  }

  /** Matches a base relation's directly-written tuples, walking non-terminal subjects. */
  async #checkDirect(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    subject: ObjectAndRelation,
    meta: ResolverMeta,
    signal: AbortSignal | undefined,
  ): Promise<DispatchCheckResult> {
    // Subject-filter pushdown (scalability-program 3.2). The selector union below is a SUPERSET of
    // everything the consumption loop below can use - that superset argument is the load-bearing
    // correctness claim, so keep it in sync with the loop:
    //   1. the EXACT subject (terminal match): type + id + the subject's relation
    //      (nonEllipsisRelation for a concrete relation; the deliberately-loose ellipsis branch of
    //      SubjectRelationFilter is fine because the loop's exact ONR re-check stays);
    //   2. the type-scoped PUBLIC WILDCARD short-circuit: type + "*" with includeEllipsisRelation
    //      (SpiceDB wildcards cannot carry a subject relation);
    //   3. every NON-TERMINAL subject (onlyNonEllipsisRelations, no type/id constraint): the
    //      userset references the loop re-dispatches into. Dropping these would break recursion -
    //      which is why a bare subject==S pushdown would be WRONG.
    // The loop consumes exactly those three row categories and nothing else; its post-filtering is
    // unchanged as belt-and-braces.
    const subjectRelationFilter: SubjectRelationFilter =
      subject.relation === ELLIPSIS
        ? { includeEllipsisRelation: true }
        : { nonEllipsisRelation: subject.relation };
    const filter: RelationshipsFilter = {
      optionalResourceType: resource.objectType,
      optionalResourceIds: [resource.objectId],
      optionalResourceRelation: resource.relation,
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: subject.objectType,
          optionalSubjectIds: [subject.objectId],
          relationFilter: subjectRelationFilter,
        },
        {
          optionalSubjectType: subject.objectType,
          optionalSubjectIds: [PUBLIC_WILDCARD],
          relationFilter: { includeEllipsisRelation: true },
        },
        { relationFilter: { onlyNonEllipsisRelations: true } },
      ],
    };

    let found = DISPATCH_CHECK_NONE;
    // Lazily allocated: `intermediates === undefined` (NOT `.length === 0`) is the early-return
    // condition, so absent and empty stay distinct exactly as in the C#.
    let intermediates: Intermediate[] | undefined = undefined;

    for await (const rel of reader.queryRelationships(filter, signal)) {
      if (this.#isExpired(rel)) {
        continue;
      }

      const s = rel.reference.subject;
      const tupleCaveat = caveatOf(rel);

      if (objectAndRelationEquals(s, subject)) {
        found = or(found, dispatchCheckCaveatedMember(tupleCaveat));
        if (isDispatchCheckDetermined(found)) {
          return found;
        }
        continue;
      }

      if (
        isPublicWildcard(s) &&
        s.objectType === subject.objectType &&
        s.relation === subject.relation
      ) {
        found = or(found, dispatchCheckCaveatedMember(tupleCaveat));
        if (isDispatchCheckDetermined(found)) {
          return found;
        }
        continue;
      }

      if (s.relation !== ELLIPSIS && !isPublicWildcard(s)) {
        (intermediates ??= []).push({ onr: s, parent: tupleCaveat });
      }
    }

    if (intermediates === undefined) {
      return found;
    }

    for (const { onr: intermediate, parent } of intermediates) {
      const sub = await this.#sub(intermediate, subject, meta, signal);
      // Carry the cycle-cut AND the depth this child consumed up into the accumulator, even when
      // the child is a non-member: the depth we walked is what gates cache reuse, regardless of
      // verdict.
      found = {
        ...found,
        cycleCut: found.cycleCut || sub.cycleCut,
        depthRequired: Math.max(found.depthRequired, sub.depthRequired),
      };
      if (!sub.member) {
        continue;
      }

      const combined: DispatchCheckResult = {
        ...dispatchCheckCaveatedMember(caveatExpressionCombineAnd(parent, sub.caveat)),
        depthRequired: sub.depthRequired,
      };
      found = or(found, combined);
      if (found.member && found.caveat === undefined) {
        return found;
      }
    }

    return found;
  }

  /** Evaluates a set operation (union / intersection / exclusion). */
  async #checkRewrite(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    subject: ObjectAndRelation,
    operation: SetOperation,
    meta: ResolverMeta,
    signal: AbortSignal | undefined,
  ): Promise<DispatchCheckResult> {
    switch (operation.type) {
      case "union": {
        let acc = DISPATCH_CHECK_NONE;
        for (const child of operation.children) {
          const b = await this.#checkChild(reader, resource, subject, child, meta, signal);
          acc = { ...acc, cycleCut: acc.cycleCut || b.cycleCut };
          acc = or(acc, b);
          // Caveat-completeness: only a DEFINITE (uncaveated) member short-circuits the union; a
          // caveated accumulator keeps gathering so every branch's caveat survives. See the class
          // remarks (issue #3, finding 5) - do not relax this to `acc.member`.
          if (acc.member && acc.caveat === undefined) {
            return acc;
          }
        }
        return acc;
      }

      case "intersection": {
        if (operation.children.length === 0) {
          return DISPATCH_CHECK_NONE;
        }
        let acc = DISPATCH_CHECK_DEFINITE_MEMBER;
        let cut = false;
        let depth = 1;
        for (const child of operation.children) {
          const b = await this.#checkChild(reader, resource, subject, child, meta, signal);
          cut = cut || b.cycleCut;
          depth = Math.max(depth, b.depthRequired);
          if (!b.member) {
            return { ...DISPATCH_CHECK_NONE, cycleCut: cut, depthRequired: depth };
          }
          acc = and(acc, b);
        }
        return { ...acc, cycleCut: cut, depthRequired: depth };
      }

      case "exclusion": {
        if (operation.children.length === 0) {
          return DISPATCH_CHECK_NONE;
        }

        const first = operation.children[0] as SetOperationChild;
        let acc = await this.#checkChild(reader, resource, subject, first, meta, signal);
        let cut = acc.cycleCut;
        let depth = acc.depthRequired;
        if (!acc.member) {
          return { ...DISPATCH_CHECK_NONE, cycleCut: cut, depthRequired: depth };
        }

        for (let i = 1; i < operation.children.length; i++) {
          const excluded = await this.#checkChild(
            reader,
            resource,
            subject,
            operation.children[i] as SetOperationChild,
            meta,
            signal,
          );
          cut = cut || excluded.cycleCut;
          depth = Math.max(depth, excluded.depthRequired);
          acc = subtract(acc, excluded);
          if (!acc.member) {
            return { ...DISPATCH_CHECK_NONE, cycleCut: cut, depthRequired: depth };
          }
        }
        return { ...acc, cycleCut: cut, depthRequired: depth };
      }

      default:
        // The C# `switch` has a `default: return None`, not a throw: an unknown operation type is
        // not an error here. Transliterated as-is rather than turned into an `assertNever`.
        return DISPATCH_CHECK_NONE;
    }
  }

  /** Evaluates a single set-operation operand. */
  async #checkChild(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    subject: ObjectAndRelation,
    child: SetOperationChild,
    meta: ResolverMeta,
    signal: AbortSignal | undefined,
  ): Promise<DispatchCheckResult> {
    switch (child.kind) {
      case "this":
        return await this.#checkDirect(reader, resource, subject, meta, signal);

      case "nil":
        return DISPATCH_CHECK_NONE;

      case "self":
        return resource.objectType === subject.objectType &&
          resource.objectId === subject.objectId &&
          subject.relation === ELLIPSIS
          ? DISPATCH_CHECK_DEFINITE_MEMBER
          : DISPATCH_CHECK_NONE;

      case "computedUserset":
        return await this.#sub(withRelation(resource, child.value.relation), subject, meta, signal);

      case "tupleToUserset":
        return await this.#checkTupleToUserset(
          reader,
          resource,
          subject,
          child.value.tuplesetRelation,
          child.value.computedUserset,
          "any",
          meta,
          signal,
        );

      case "functionedTupleToUserset":
        return await this.#checkTupleToUserset(
          reader,
          resource,
          subject,
          child.value.tuplesetRelation,
          child.value.computedUserset,
          child.value.function,
          meta,
          signal,
        );

      case "nestedRewrite":
        return await this.#checkRewrite(
          reader,
          resource,
          subject,
          child.value.operation,
          meta,
          signal,
        );

      default:
        // As above: the C# default arm returns None rather than throwing.
        return DISPATCH_CHECK_NONE;
    }
  }

  /**
   * Evaluates a tuple-to-userset arrow: walk the tupleset relation on the resource, then for each
   * reached object compute the userset relation, dispatching each as a sub-problem.
   */
  async #checkTupleToUserset(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    subject: ObjectAndRelation,
    tuplesetRelation: string,
    computed: ComputedUserset,
    func: TupleToUsersetFunction,
    meta: ResolverMeta,
    signal: AbortSignal | undefined,
  ): Promise<DispatchCheckResult> {
    const filter: RelationshipsFilter = {
      optionalResourceType: resource.objectType,
      optionalResourceIds: [resource.objectId],
      optionalResourceRelation: tuplesetRelation,
    };

    let targets: Intermediate[] | undefined = undefined;

    for await (const rel of reader.queryRelationships(filter, signal)) {
      if (this.#isExpired(rel)) {
        continue;
      }

      const reached = rel.reference.subject;
      if (isPublicWildcard(reached)) {
        continue;
      }

      const target: ObjectAndRelation = {
        objectType: reached.objectType,
        objectId: reached.objectId,
        relation: computed.relation,
      };
      (targets ??= []).push({ onr: target, parent: caveatOf(rel) });
    }

    if (targets === undefined) {
      return DISPATCH_CHECK_NONE;
    }

    if (func === "all") {
      let acc = DISPATCH_CHECK_DEFINITE_MEMBER;
      let cut = false;
      let depth = 1;
      for (const { onr: target, parent } of targets) {
        const sub = await this.#sub(target, subject, meta, signal);
        cut = cut || sub.cycleCut;
        depth = Math.max(depth, sub.depthRequired);
        if (!sub.member) {
          return { ...DISPATCH_CHECK_NONE, cycleCut: cut, depthRequired: depth };
        }
        acc = and(acc, {
          ...dispatchCheckCaveatedMember(caveatExpressionCombineAnd(parent, sub.caveat)),
          depthRequired: sub.depthRequired,
        });
      }
      return { ...acc, cycleCut: cut, depthRequired: depth };
    }

    let any = DISPATCH_CHECK_NONE;
    for (const { onr: target, parent } of targets) {
      const sub = await this.#sub(target, subject, meta, signal);
      any = {
        ...any,
        cycleCut: any.cycleCut || sub.cycleCut,
        depthRequired: Math.max(any.depthRequired, sub.depthRequired),
      };
      if (!sub.member) {
        continue;
      }
      any = or(any, {
        ...dispatchCheckCaveatedMember(caveatExpressionCombineAnd(parent, sub.caveat)),
        depthRequired: sub.depthRequired,
      });
      if (any.member && any.caveat === undefined) {
        return any;
      }
    }
    return any;
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

  #isExpired(rel: Relationship): boolean {
    const exp = rel.optionalExpiration;
    return exp !== undefined && exp <= this.#now;
  }
}

function caveatOf(rel: Relationship): CaveatExpression | undefined {
  const c = rel.optionalCaveat;
  return c !== undefined ? caveatExpressionFromCaveat(c) : undefined;
}

// --- Branch algebra over DispatchCheckResult (membership + caveat), preserving cycle-cut. ---
//
// depthRequired propagates as the max consumed by any combined branch, so a result's required depth
// reflects the deepest sub-problem it actually walked (mirrors SpiceDB's max(DepthRequired) folding).

function or(a: DispatchCheckResult, b: DispatchCheckResult): DispatchCheckResult {
  const cut = a.cycleCut || b.cycleCut;
  const depth = Math.max(a.depthRequired, b.depthRequired);
  if (isDispatchCheckDetermined(a) || isDispatchCheckDetermined(b)) {
    return { member: true, caveat: undefined, cycleCut: cut, depthRequired: depth };
  }
  if (!a.member) {
    return { ...b, cycleCut: cut, depthRequired: depth };
  }
  if (!b.member) {
    return { ...a, cycleCut: cut, depthRequired: depth };
  }
  return {
    member: true,
    caveat: caveatExpressionCombineOr(a.caveat, b.caveat),
    cycleCut: cut,
    depthRequired: depth,
  };
}

function and(a: DispatchCheckResult, b: DispatchCheckResult): DispatchCheckResult {
  const cut = a.cycleCut || b.cycleCut;
  const depth = Math.max(a.depthRequired, b.depthRequired);
  if (!a.member || !b.member) {
    return { member: false, caveat: undefined, cycleCut: cut, depthRequired: depth };
  }
  return {
    member: true,
    caveat: caveatExpressionCombineAnd(a.caveat, b.caveat),
    cycleCut: cut,
    depthRequired: depth,
  };
}

function subtract(
  baseResult: DispatchCheckResult,
  excluded: DispatchCheckResult,
): DispatchCheckResult {
  const cut = baseResult.cycleCut || excluded.cycleCut;
  const depth = Math.max(baseResult.depthRequired, excluded.depthRequired);
  if (!baseResult.member) {
    return { member: false, caveat: undefined, cycleCut: cut, depthRequired: depth };
  }
  // Ordering is load-bearing: the `excluded.caveat!` non-null assertion below is safe ONLY because
  // an excluded branch that is a determined (uncaveated) member has already returned.
  if (isDispatchCheckDetermined(excluded)) {
    return { member: false, caveat: undefined, cycleCut: cut, depthRequired: depth };
  }
  if (!excluded.member) {
    return { ...baseResult, cycleCut: cut, depthRequired: depth };
  }
  return {
    member: true,
    caveat: caveatExpressionSubtract(baseResult.caveat, excluded.caveat as CaveatExpression),
    cycleCut: cut,
    depthRequired: depth,
  };
}
