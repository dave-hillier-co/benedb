import type { CaveatDefinition } from "@spacedb/core/caveat-definition";
import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import type { IGraphReader } from "@spacedb/datastore/i-graph-reader";

import { CaveatEvaluator } from "./caveat-evaluator";
import { systemClockNow } from "./clock";
import type { DispatchCheckRequest, DispatchCheckResult, IDispatcher } from "./i-dispatcher";
import { IN_PROCESS_REVISION } from "./in-process-revision";
import { LocalDispatcher } from "./local-dispatcher";
import { createCheckResult, type CheckResult } from "./membership";

/**
 * The default maximum recursion depth.
 *
 * `LookupResourcesEngine` and `ExpandEngine` each declare their OWN copy of this constant in the
 * C#; they stay separate constants in the port rather than being folded into one shared value.
 */
export const DEFAULT_MAX_DEPTH = 50;

/**
 * Evaluates SpiceDB-style permission checks against a schema model and a datastore reader.
 *
 * Ported from Spiceport `Engine/CheckEngine.cs`.
 *
 * Implements `Check(resource, relation, subject, revision)` as a recursive walk of the schema's
 * relation graph: direct tuples (including ellipsis subjects and `:*` public wildcards), computed
 * usersets, tuple-to-userset arrows, and union / intersection / exclusion set operations.
 * Subject-relation walking is handled by dispatching a sub-check on each intermediate non-terminal
 * subject. Recursion is bounded by a configurable depth limit, which is the SOLE termination
 * guarantee.
 *
 * Caveated tuples carry a CEL condition that is combined across union (OR), intersection (AND),
 * exclusion (base AND NOT excluded) and arrows (tupleset caveat AND computed result), then
 * collapsed to a final verdict using the supplied request context.
 *
 * Expiration: a relationship whose `optionalExpiration` is at or before the evaluation "now" (from
 * the supplied `evaluationTime`, defaulting to the system clock) is treated as absent.
 *
 * Port decisions:
 *   * The two `Check` OVERLOADS become two distinctly named methods per the guide's overload row:
 *     {@link check} takes (resourceType, resourceId, relation), {@link checkOnr} takes a resource
 *     ONR. The string form just constructs the ONR and forwards.
 *   * The trailing optionals stay POSITIONAL and in the C#'s order - `caveatContext`,
 *     `evaluationTime`, `atRevision`, `signal`. `atRevision` sits BETWEEN `evaluationTime` and the
 *     token; reordering silently rebinds every existing call site. Each C# default becomes an
 *     absent optional plus a `??` resolver, never a default in the type.
 *   * The three C# constructors collapse to one `(namespaces, caveats?, maxDepth?)`.
 */
export class CheckEngine {
  readonly #namespaces: ReadonlyMap<string, NamespaceDefinition>;
  readonly #maxDepth: number;
  readonly #caveatEvaluator: CaveatEvaluator;

  /**
   * Creates a check engine over the given schema definitions.
   *
   * @param namespaces The compiled namespace definitions that make up the schema.
   * @param caveats The compiled caveat definitions, or absent if the schema has none.
   * @param maxDepth The maximum recursion depth before a check fails. Defaults to
   * {@link DEFAULT_MAX_DEPTH}.
   */
  constructor(
    namespaces: Iterable<NamespaceDefinition>,
    caveats?: Iterable<CaveatDefinition> | undefined,
    maxDepth?: number | undefined,
  ) {
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
    this.#caveatEvaluator = new CaveatEvaluator(caveats ?? []);
    this.#maxDepth = maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /**
   * Checks whether `subject` is a member of `resourceType:resourceId#relation` as of the given
   * reader's snapshot.
   *
   * @param reader A graph reader pinned to the revision to evaluate against.
   * @param resourceType The resource namespace.
   * @param resourceId The resource object id.
   * @param relation The relation or permission to check.
   * @param subject The subject ONR (may carry a subrelation; use ellipsis for direct subjects).
   * @param caveatContext Optional request-time caveat context (overrides relationship context).
   * @param evaluationTime Optional pinned evaluation "now" (epoch nanoseconds) for expiration
   * filtering; defaults to the system clock.
   * @param atRevision Optional real read revision identity to carry in the dispatch request.
   * @param signal A cancellation signal.
   */
  check(
    reader: IGraphReader,
    resourceType: string,
    resourceId: string,
    relation: string,
    subject: ObjectAndRelation,
    caveatContext?: ReadonlyMap<string, unknown> | undefined,
    evaluationTime?: bigint | undefined,
    atRevision?: IRevision | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<CheckResult> {
    if (reader === undefined || reader === null) {
      throw new InvalidArgumentError("reader is required");
    }
    if (subject === undefined || subject === null) {
      throw new InvalidArgumentError("subject is required");
    }
    const resource: ObjectAndRelation = {
      objectType: resourceType,
      objectId: resourceId,
      relation,
    };
    return this.checkOnr(
      reader,
      resource,
      subject,
      caveatContext,
      evaluationTime,
      atRevision,
      signal,
    );
  }

  /**
   * Checks whether `subject` is a member of the given `resource` ONR.
   *
   * @param reader A graph reader pinned to the revision to evaluate against.
   * @param resource The resource ONR (object type, id and relation/permission).
   * @param subject The subject ONR.
   * @param caveatContext Optional request-time caveat context (overrides relationship context).
   * @param evaluationTime Optional pinned evaluation "now" (epoch nanoseconds); defaults to the
   * system clock.
   * @param atRevision Optional real read revision identity to carry in the dispatch request.
   * @param signal A cancellation signal.
   */
  async checkOnr(
    reader: IGraphReader,
    resource: ObjectAndRelation,
    subject: ObjectAndRelation,
    caveatContext?: ReadonlyMap<string, unknown> | undefined,
    evaluationTime?: bigint | undefined,
    atRevision?: IRevision | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<CheckResult> {
    if (reader === undefined || reader === null) {
      throw new InvalidArgumentError("reader is required");
    }
    if (resource === undefined || resource === null) {
      throw new InvalidArgumentError("resource is required");
    }
    if (subject === undefined || subject === null) {
      throw new InvalidArgumentError("subject is required");
    }

    const now = evaluationTime ?? systemClockNow();

    // In-process drive: build a FRESH LocalDispatcher that resolves ANY revision back to the single
    // reader we were handed, then dispatch the top-level sub-problem through it. The request
    // carries a revision identity purely so it stays serializable; `readerFor` ignores it.
    const local = new LocalDispatcher(this.#namespaces, () => reader, now);

    // The local dispatcher is both the top-level entry point and its own onward seam: a bare
    // in-process check simply runs the recursive walk once.
    const dispatcher: IDispatcher = local;

    // Carry the caller-supplied real read revision when available (informational identity only);
    // fall back to the in-process placeholder identity when none is supplied.
    const revision = atRevision ?? IN_PROCESS_REVISION;
    const request: DispatchCheckRequest = {
      resource,
      subject,
      meta: {
        revision,
        depthRemaining: this.#maxDepth,
        visited: new Set<string>(),
        schemaHash: undefined,
      },
    };
    const result = await dispatcher.dispatchCheck(request, signal);

    // Collapse stays the per-request, post-dispatch step: evaluate the accumulated caveat with the
    // request-time context. (cycleCut is computed/propagated but does not affect the verdict.)
    return this.collapse(result, caveatContext);
  }

  /**
   * Collapses a pre-context dispatch result into the public, possibly-caveated verdict by
   * evaluating the accumulated caveat expression against the request-time context.
   *
   * PUBLIC by design: S4's Orleans root dispatcher collapses a shared, cached pre-context branch
   * with its own request context, so this must stay reachable and must not be inlined into
   * {@link checkOnr}. `cycleCut` is ignored: it does not affect the verdict.
   *
   * @param result The pre-context dispatch branch (membership + caveat expression).
   * @param caveatContext The request-time caveat context, or absent.
   */
  collapse(
    result: DispatchCheckResult,
    caveatContext: ReadonlyMap<string, unknown> | undefined,
  ): CheckResult {
    if (!result.member) {
      return createCheckResult("notMember");
    }

    if (result.caveat === undefined) {
      return createCheckResult("member");
    }

    const evaluated = this.#caveatEvaluator.evaluateExpression(result.caveat, caveatContext);
    switch (evaluated.outcome) {
      case "definitelyTrue":
        return createCheckResult("member");
      case "definitelyFalse":
        return createCheckResult("notMember");
      default:
        return createCheckResult("caveated", evaluated.missingFields);
    }
  }
}
