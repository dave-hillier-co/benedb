import { FormatError } from "@spacedb/core/format-error";
import type { IRevision } from "@spacedb/core/i-revision";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";

import type { CaveatExpression } from "./caveat-expression";

/**
 * The dispatch seam and the four types crossing it.
 *
 * Ported from Spiceport `Engine/IDispatcher.cs`.
 *
 * Port decisions settled once, here, because every engine file downstream depends on them:
 *   * `VisitKey` is a `readonly record struct` used as the element type of
 *     `ImmutableHashSet<VisitKey>`. TypeScript has no value equality and a `Set` of objects
 *     compares by reference, so the visited set becomes a `ReadonlySet<string>` keyed by the
 *     ALREADY-EXISTING {@link visitKeyToCanonicalString}. There is no second key.
 *   * `ResolverMeta.visited` is copy-on-add (`meta with { Visited = meta.Visited.Add(key) }`), so
 *     every extension is `new Set(prev).add(key)` - never a mutation of the parent's set.
 *     `LocalDispatcher` relies on each sub-problem extending its own copy.
 *   * `DispatchCheckResult`'s three `static readonly` instances are FROZEN module constants and
 *     every C# `with` is an object spread producing a fresh object. Assigning into a shared
 *     constant would corrupt every subsequent check.
 *   * `IDispatcher.DispatchCheck(request, CancellationToken ct)` is a plain interface, not a
 *     grain, and the token is a REQUIRED positional parameter, so the signal stays positional and
 *     required-shaped (typed `AbortSignal | undefined`) rather than becoming `signal?`.
 */

/**
 * A key identifying an in-flight (resource, subject) check. Recorded into the exact visited set so
 * the dispatcher can detect a genuine same-path revisit and bypass a same-key grain re-entry; it
 * does not gate verdicts.
 *
 * Carried inside {@link ResolverMeta} rather than a closure so that a dispatch request is a
 * self-contained, serializable description of a sub-problem.
 */
export interface VisitKey {
  /** The resource namespace. */
  readonly resourceType: string;
  /** The resource object id. */
  readonly resourceId: string;
  /** The resource relation/permission. */
  readonly resourceRelation: string;
  /** The subject namespace. */
  readonly subjectType: string;
  /** The subject object id. */
  readonly subjectId: string;
  /** The subject relation (ellipsis for direct subjects). */
  readonly subjectRelation: string;
}

/**
 * The canonical field separator (U+001F). Each field is ALSO length-prefixed, which is what
 * actually makes the rendering injective -- the separator alone is not enough.
 *
 * In Spiceport `VisitKey` is a `readonly record struct` and the visited set is
 * `ImmutableHashSet<VisitKey>`, so its identity is genuine field-wise value equality;
 * `ToCanonicalString` is only a wire rendering. TypeScript has no value-equality `Set`, so this
 * string IS the identity here, and a plain join would make the cycle guard conflate two distinct
 * sub-problems whenever a separator fell inside a field. Nothing on this path enforces the
 * SpiceDB object-id grammar, so "the separator cannot occur" is not a property the engine may
 * rely on -- the same reasoning as `relationshipKeyString` in @spacedb/datastore.
 */
const SEPARATOR = String.fromCharCode(0x1f);

/** One length-prefixed field of the canonical rendering. */
function framed(part: string): string {
  return `${part.length}${SEPARATOR}${part}`;
}

/** Builds a key from a (resource, subject) ONR pair. */
export function visitKeyOf(resource: ObjectAndRelation, subject: ObjectAndRelation): VisitKey {
  return {
    resourceType: resource.objectType,
    resourceId: resource.objectId,
    resourceRelation: resource.relation,
    subjectType: subject.objectType,
    subjectId: subject.objectId,
    subjectRelation: subject.relation,
  };
}

/**
 * Renders a key as a single unit-separated (U+001F) string. This is also the visited-set element
 * type: the canonical string IS the identity here, not merely a wire rendering of it.
 */
export function visitKeyToCanonicalString(key: VisitKey): string {
  return (
    framed(key.resourceType) +
    framed(key.resourceId) +
    framed(key.resourceRelation) +
    framed(key.subjectType) +
    framed(key.subjectId) +
    framed(key.subjectRelation)
  );
}

/**
 * Parses a canonical string produced by {@link visitKeyToCanonicalString}. Throws {@link FormatError}
 * (the port's `FormatException`) on a malformed value rather than silently defaulting any field.
 */
export function visitKeyFromCanonicalString(value: string): VisitKey {
  const parts: string[] = [];
  let at = 0;
  while (at < value.length && parts.length < 6) {
    const mark = value.indexOf(SEPARATOR, at);
    if (mark < 0) break;
    const length = Number(value.slice(at, mark));
    if (!Number.isInteger(length) || length < 0) break;
    const start = mark + 1;
    const end = start + length;
    if (end > value.length) break;
    parts.push(value.slice(start, end));
    at = end;
  }
  if (parts.length !== 6 || at !== value.length) {
    throw new FormatError(
      `Malformed VisitKey canonical string: expected 6 length-prefixed parts, got ${parts.length}.`,
    );
  }
  return {
    resourceType: parts[0] as string,
    resourceId: parts[1] as string,
    resourceRelation: parts[2] as string,
    subjectType: parts[3] as string,
    subjectId: parts[4] as string,
    subjectRelation: parts[5] as string,
  };
}

/**
 * The cross-cutting metadata threaded through every dispatched sub-problem: which revision to
 * evaluate against, how much recursion budget remains, and the exact visited-set loop hint.
 *
 * Deliberately carries the revision IDENTITY, not a reader, so the request is serializable.
 * Termination rests SOLELY on {@link depthRemaining}; the visited set never affects a verdict.
 */
export interface ResolverMeta {
  /** The pinned revision identity to evaluate against. */
  readonly revision: IRevision;
  /** The remaining recursion depth budget (the sole termination guarantee). */
  readonly depthRemaining: number;
  /**
   * The exact set of (resource, subject) pairs visited on this path, keyed by
   * {@link visitKeyToCanonicalString} (at most max-depth entries). Copy-on-add: never mutate a
   * parent's set.
   */
  readonly visited: ReadonlySet<string>;
  /**
   * The schema hash effective at `revision`, pinned ONCE at the check root and carried unchanged
   * to every child. `undefined` means no schema is persisted at the revision (the seed-only
   * window), which is a genuinely meaningful absent: do not collapse it with `??` at read sites.
   */
  readonly schemaHash?: string | undefined;
}

/** Returns a copy of `meta` with `key` recorded into a FRESH visited set. */
export function resolverMetaWithVisited(meta: ResolverMeta, key: VisitKey): ResolverMeta {
  return { ...meta, visited: new Set(meta.visited).add(visitKeyToCanonicalString(key)) };
}

/**
 * A single sub-problem to evaluate: "is `subject` a member of `resource`?", together with the
 * cross-cutting `meta`.
 */
export interface DispatchCheckRequest {
  /** The resource ONR (object type, id and relation/permission). */
  readonly resource: ObjectAndRelation;
  /** The subject ONR. */
  readonly subject: ObjectAndRelation;
  /** The revision, depth budget and cycle-guard set for this sub-problem. */
  readonly meta: ResolverMeta;
}

/**
 * The result of dispatching one sub-problem: the engine's internal branch (tri-state membership
 * plus an optional gating caveat) augmented with a cycle-cut flag.
 *
 * `cycleCut` is the "depth/loop-affected, non-cacheable" flag. It is propagated upward and does NOT
 * change the verdict; a later caching phase uses it to avoid caching depth/loop-affected results.
 *
 * `depthRequired` is the recursion depth this result actually consumed below itself (a leaf = 1, a
 * combining node = max(children) + 1), mirroring SpiceDB's `ResponseMeta.DepthRequired`.
 */
export interface DispatchCheckResult {
  /** True if the subject is a (possibly caveated) member. */
  readonly member: boolean;
  /** An optional caveat expression gating membership; absent = unconditional. */
  readonly caveat?: CaveatExpression | undefined;
  /** True if this subtree was depth- or loop-affected and must not be cached. */
  readonly cycleCut: boolean;
  /** The recursion depth consumed below this node (leaf = 1). */
  readonly depthRequired: number;
}

/**
 * A fully-determined member (no caveat, not depth/loop-affected).
 *
 * FROZEN, because the C# is a `static readonly` struct instance that call sites copy with `with`.
 * Every such copy must be an object spread producing a fresh object; writing into this constant
 * would corrupt every subsequent check.
 */
export const DISPATCH_CHECK_DEFINITE_MEMBER: DispatchCheckResult = Object.freeze({
  member: true,
  caveat: undefined,
  cycleCut: false,
  // C# `int DepthRequired = 1` is a default constructor parameter; made explicit here.
  depthRequired: 1,
});

/** Not a member (not depth/loop-affected). */
export const DISPATCH_CHECK_NONE: DispatchCheckResult = Object.freeze({
  member: false,
  caveat: undefined,
  cycleCut: false,
  depthRequired: 1,
});

/** Not a member, marked depth/loop-affected (non-cacheable). */
export const DISPATCH_CHECK_CUT: DispatchCheckResult = Object.freeze({
  member: false,
  caveat: undefined,
  cycleCut: true,
  depthRequired: 1,
});

/** Creates a (possibly caveated) member result. The C# `new(true, caveat, false)`. */
export function dispatchCheckCaveatedMember(
  caveat: CaveatExpression | undefined,
): DispatchCheckResult {
  return { member: true, caveat, cycleCut: false, depthRequired: 1 };
}

/**
 * True if this is a member with NO caveat - the load-bearing short-circuit predicate in
 * `LocalDispatcher`. The C# computed property `IsDetermined`, named so it cannot be confused with
 * `member`: a union or arrow may short-circuit ONLY on this, never on `member` alone, or caveats
 * are silently dropped (issue #3, finding 5).
 */
export function isDispatchCheckDetermined(result: DispatchCheckResult): boolean {
  return result.member && result.caveat === undefined;
}

/**
 * The dispatch seam. Every recursive sub-problem in a check flows through {@link dispatchCheck}
 * rather than a direct self-call, so the work can be intercepted, counted, cached or (later)
 * relocated to another process.
 */
export interface IDispatcher {
  /**
   * Evaluates a single sub-problem and returns its branch result.
   *
   * @param request The sub-problem (resource, subject, meta).
   * @param signal A cancellation signal. POSITIONAL AND REQUIRED-SHAPED, mirroring the C#
   * `CancellationToken ct`, so decorators transliterate one-for-one.
   */
  dispatchCheck(
    request: DispatchCheckRequest,
    signal: AbortSignal | undefined,
  ): Promise<DispatchCheckResult>;
}
