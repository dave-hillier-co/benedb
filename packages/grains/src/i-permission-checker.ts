import {
  MINIMIZE_LATENCY,
  type ConsistencyRequirement,
} from "@benedb/core/consistency-requirement";
import type { IRevision } from "@benedb/core/i-revision";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { ResolvedRevision } from "@benedb/core/resolved-revision";
import { zedTokenFromRevision } from "@benedb/core/zed-tokens";
import type { IDatastore } from "@benedb/datastore/i-datastore";
import { resolveRevision } from "@benedb/datastore/revision-resolver";
import { CheckEngine, DEFAULT_MAX_DEPTH } from "@benedb/engine/check-engine";
import {
  visitKeyOf,
  visitKeyToCanonicalString,
  type DispatchCheckResult,
  type IDispatcher,
  type ResolverMeta,
} from "@benedb/engine/i-dispatcher";
import type { Membership } from "@benedb/engine/membership";

import type { ISchemaProvider, SchemaSnapshot } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import type { SchemaResolver } from "./schema-resolver";

/**
 * Ported from Spiceport `Grains/IPermissionChecker.cs` - five types in one file
 * (`PermissionCheckResult`, `BatchCheckItem`, `PermissionCheckResultItem`, `BatchCheckResult`,
 * `IPermissionChecker` + `PermissionChecker`), which the port ledger maps to one module.
 *
 * Port decisions:
 *   * `[GenerateSerializer]` / `[Id(n)]` map to nothing: Thresh's value codec is name-based JSON,
 *     so the numeric field ids simply do not exist here.
 *   * `PermissionChecker` takes the ENGINE's `IDispatcher` seam, not a grain - nothing in this
 *     module needs a grain implementation.
 *   * The C# dedup key is a 6-tuple `ValueTuple` used as a `Dictionary` key with VALUE equality.
 *     TypeScript has no value-equality map key, so the key becomes the LENGTH-PREFIXED canonical
 *     rendering `VisitKey` already uses - the six components ARE a (resource, subject) ONR pair.
 *     A naive separator join would collide whenever an id contained the separator.
 *   * `SemaphoreSlim(Math.Max(1, maxConcurrency))` has no Thresh counterpart for a count above one
 *     (`AsyncSerialExecutor` is a semaphore of exactly one), so the bounded fan-out uses the local
 *     {@link AsyncSemaphore} below - a direct transliteration, NOT `Promise.all` over the raw list,
 *     which would start every dispatch at once and show the mesh a burst the C# never produces.
 */

/** The verdict of a top-level permission check, plus any unresolved caveat fields. */
export interface PermissionCheckResult {
  /** The membership verdict. */
  readonly verdict: Membership;
  /**
   * When `verdict` is `"caveated"`, the caveat parameter names that were missing from the supplied
   * context; otherwise empty.
   */
  readonly missingFields: readonly string[];
  /** The revision the check actually evaluated against. */
  readonly evaluatedRevision: IRevision;
  /** The schema hash at the evaluated revision, if any. */
  readonly schemaHash: string | undefined;
  /**
   * The ZedToken minted from `evaluatedRevision` (with `schemaHash` and the datastore id), which a
   * client can chain into a subsequent `at_least_as_fresh` check.
   */
  readonly evaluatedToken: string;
}

/**
 * One item of a {@link IPermissionChecker.batchCheck} request: a single resource/permission/subject
 * triple with its OWN caveat context. There is deliberately NO per-item consistency - the whole
 * batch pins one revision (mirroring SpiceDB's `CheckBulkPermissions`).
 */
export interface BatchCheckItem {
  /** The resource namespace. */
  readonly resourceType: string;
  /** The resource object id. */
  readonly resourceId: string;
  /** The permission (or relation) to check. */
  readonly permission: string;
  /** The subject ONR (ellipsis subrelation for a direct subject). */
  readonly subject: ObjectAndRelation;
  /** The per-item request-time caveat context, or absent. */
  readonly caveatContext?: ReadonlyMap<string, unknown> | undefined;
}

/**
 * The per-item verdict of a batch check, index-aligned to the request items. The evaluated
 * revision/token live ONCE on {@link BatchCheckResult}, not per item.
 */
export interface PermissionCheckResultItem {
  /** The membership verdict for this item. */
  readonly verdict: Membership;
  /**
   * When `verdict` is `"caveated"`, the caveat parameter names that were missing from THIS item's
   * context; otherwise empty.
   */
  readonly missingFields: readonly string[];
}

/**
 * The result of a batch check: per-item verdicts in request order, plus the SINGLE
 * revision/schema-hash/token the whole batch was evaluated against (every item shares it, proving
 * the one-revision pin).
 */
export interface BatchCheckResult {
  /** Per-item verdicts, index-aligned to the request items. */
  readonly items: readonly PermissionCheckResultItem[];
  /** The single revision the whole batch evaluated against. */
  readonly evaluatedRevision: IRevision;
  /** The schema hash at the evaluated revision, if any. */
  readonly schemaHash: string | undefined;
  /** The single ZedToken minted from `evaluatedRevision`. */
  readonly evaluatedToken: string;
}

/**
 * The top-level entry point used by the API: pins an optimized (quantized) revision, dispatches the
 * root sub-problem through the silo-wide dispatcher, then collapses the returned pre-context branch
 * against the request-time caveat context.
 */
export interface IPermissionChecker {
  /**
   * Checks whether the subject has the given permission on the resource.
   *
   * @param consistency The consistency the read demands; absent means
   * {@link MINIMIZE_LATENCY} (the server default).
   */
  check(
    resourceType: string,
    resourceId: string,
    permission: string,
    subject: ObjectAndRelation,
    caveatContext: ReadonlyMap<string, unknown> | undefined,
    consistency?: ConsistencyRequirement | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<PermissionCheckResult>;

  /**
   * Checks a batch of items against ONE pinned revision, fanning each item's root sub-problem out
   * over the shared dispatcher with bounded concurrency, then collapsing each against its own
   * per-item caveat context. Returns per-item verdicts (index-aligned to `items`) plus the single
   * evaluated revision/token the whole batch shares.
   */
  batchCheck(
    items: readonly BatchCheckItem[],
    consistency?: ConsistencyRequirement | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<BatchCheckResult>;
}

/**
 * The default bounded fan-out width for {@link PermissionChecker.batchCheck}, mirroring SpiceDB's
 * bulk-check `maxConcurrency` (see `internal/services/v1/bulkcheck.go`).
 */
export const DEFAULT_BATCH_CONCURRENCY = 50;

/**
 * A counting semaphore, standing in for `SemaphoreSlim(initialCount)`. Thresh's
 * `AsyncSerialExecutor` is a semaphore of ONE, so it cannot express the C#'s bounded fan-out; this
 * is the minimum faithful equivalent. A released permit is handed straight to the longest-waiting
 * acquirer (FIFO), as `SemaphoreSlim` does.
 */
class AsyncSemaphore {
  #permits: number;
  readonly #waiters: (() => void)[] = [];

  constructor(permits: number) {
    this.#permits = permits;
  }

  /**
   * `SemaphoreSlim.WaitAsync(ct)`, INCLUDING its cancellation behaviour: the token is observed
   * while queued, not only before entering the queue. Dropping the signal here would let every
   * queued lambda through on abort and dispatch a sub-problem the C# never dispatches - the
   * verdict is unchanged (each rejects at its own entry guard) but the dispatch COUNT is not, and
   * the mesh metrics suites assert call counts.
   */
  async wait(signal?: AbortSignal | undefined): Promise<void> {
    signal?.throwIfAborted();
    if (this.#permits > 0) {
      this.#permits -= 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        // Drop out of the FIFO queue so a later `release` hands its permit to a live waiter
        // rather than to this abandoned one, which would leak the permit for the whole batch.
        const at = this.#waiters.indexOf(waiter);
        if (at >= 0) this.#waiters.splice(at, 1);
        reject(signal?.reason);
      };
      this.#waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.#waiters.shift();
    if (next === undefined) {
      this.#permits += 1;
      return;
    }
    next();
  }
}

/**
 * The dedup key for a batch item: the C# 6-tuple
 * `(ResourceType, ResourceId, Permission, Subject.ObjectType, Subject.ObjectId, Subject.Relation)`
 * with VALUE equality. The caveat context is deliberately EXCLUDED - it is applied per item at
 * collapse, so one shared branch can collapse differently for two items.
 */
function batchItemDedupKey(item: BatchCheckItem): string {
  return visitKeyToCanonicalString(
    visitKeyOf(
      { objectType: item.resourceType, objectId: item.resourceId, relation: item.permission },
      item.subject,
    ),
  );
}

/**
 * Default {@link IPermissionChecker}. Mirrors the in-process `CheckEngine.check` flow, but the
 * dispatch seam is the silo-wide root dispatcher, so the recursion runs across grains.
 *
 * The revision is pinned to the datastore's optimized (quantized) revision so that the revision
 * component of every grain key - and hence the shared branch cache - buckets near-in-time checks
 * together, while still being a real, snapshot-able revision each grain can resolve a reader for.
 */
export class PermissionChecker implements IPermissionChecker {
  readonly #datastore: IDatastore;
  readonly #schemaSource: ISchemaSource;
  readonly #root: IDispatcher;
  readonly #schemaProvider: ISchemaProvider;
  readonly #schemaResolver: SchemaResolver;
  readonly #maxDepth: number;
  readonly #maxConcurrency: number;

  constructor(
    datastore: IDatastore,
    schemaSource: ISchemaSource,
    root: IDispatcher,
    schemaProvider: ISchemaProvider,
    schemaResolver: SchemaResolver,
    maxDepth: number = DEFAULT_MAX_DEPTH,
    maxConcurrency: number = DEFAULT_BATCH_CONCURRENCY,
  ) {
    this.#datastore = datastore;
    this.#schemaSource = schemaSource;
    this.#root = root;
    this.#schemaProvider = schemaProvider;
    this.#schemaResolver = schemaResolver;
    this.#maxDepth = maxDepth;
    this.#maxConcurrency = maxConcurrency;
  }

  /**
   * Resolves the compiled schema effective at the resolved revision (through the
   * {@link ISchemaSource} seam on a hash miss), matching what every check grain in the dispatched
   * tree evaluates under - rather than the possibly-stale ambient current schema on a non-writer
   * silo.
   */
  #resolveSchema(
    resolved: ResolvedRevision,
    signal: AbortSignal | undefined,
  ): Promise<SchemaSnapshot> {
    return this.#schemaResolver.resolveWithSource(
      resolved.schemaHash,
      this.#schemaSource,
      resolved.revision,
      this.#schemaProvider.current,
      signal,
    );
  }

  /** @inheritdoc */
  async check(
    resourceType: string,
    resourceId: string,
    permission: string,
    subject: ObjectAndRelation,
    caveatContext: ReadonlyMap<string, unknown> | undefined,
    consistency?: ConsistencyRequirement | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<PermissionCheckResult> {
    // `ArgumentNullException.ThrowIfNull(subject);` - the FIRST statement, ahead of the revision
    // resolution, so a malformed call produces no side effects at all.
    if (subject === undefined || subject === null) {
      throw new InvalidArgumentError("subject must not be null");
    }

    // Resolve the consistency requirement to a concrete revision. Absent means MinimizeLatency ->
    // the optimized (quantized, head-pinned) revision.
    const resolved = await resolveRevision(
      this.#datastore,
      consistency ?? MINIMIZE_LATENCY,
      undefined,
      signal,
    );

    // Capture the schema effective at the RESOLVED revision (not the ambient current), so the
    // dispatch and the collapse both run under the schema that revision pins - the same one every
    // check grain in the tree resolves from its key.
    const schema = await this.#resolveSchema(resolved, signal);
    const engine = new CheckEngine(schema.namespaces, schema.caveats, this.#maxDepth);

    const resource: ObjectAndRelation = {
      objectType: resourceType,
      objectId: resourceId,
      relation: permission,
    };
    // The visited set starts EMPTY at the root: seeding it with the root's own key would force-cut
    // the very first hop.
    const meta: ResolverMeta = {
      revision: resolved.revision,
      depthRemaining: this.#maxDepth,
      visited: new Set<string>(),
      schemaHash: resolved.schemaHash,
    };

    const branch = await this.#root.dispatchCheck({ resource, subject, meta }, signal);

    const collapsed = engine.collapse(branch, caveatContext);
    const datastoreId = await this.#datastore.getUniqueId(signal);
    const token = zedTokenFromRevision(resolved.revision, resolved.schemaHash, datastoreId).token;
    return {
      verdict: collapsed.verdict,
      missingFields: collapsed.missingExprFields,
      evaluatedRevision: resolved.revision,
      schemaHash: resolved.schemaHash,
      evaluatedToken: token,
    };
  }

  /** @inheritdoc */
  async batchCheck(
    items: readonly BatchCheckItem[],
    consistency?: ConsistencyRequirement | undefined,
    signal?: AbortSignal | undefined,
  ): Promise<BatchCheckResult> {
    // `ArgumentNullException.ThrowIfNull(items);`
    if (items === undefined || items === null) {
      throw new InvalidArgumentError("items must not be null");
    }

    // ONE revision for the whole batch (mirrors SpiceDB's single RevisionFromContext). Every item's
    // meta carries the same revision, so structurally-identical sub-problems across items collide
    // on the same grain key and the same grain activation.
    const resolved = await resolveRevision(
      this.#datastore,
      consistency ?? MINIMIZE_LATENCY,
      undefined,
      signal,
    );

    // ONE schema snapshot and ONE collapse engine for the whole batch, resolved at the batch's
    // single pinned revision (not the ambient current).
    const schema = await this.#resolveSchema(resolved, signal);
    const engine = new CheckEngine(schema.namespaces, schema.caveats, this.#maxDepth);

    // ONE meta OBJECT, shared by every item's request.
    const meta: ResolverMeta = {
      revision: resolved.revision,
      depthRemaining: this.#maxDepth,
      visited: new Set<string>(),
      schemaHash: resolved.schemaHash,
    };

    // Dedup distinct sub-problems by their dispatch key (resource + subject; the caveat context is
    // excluded and applied per item at collapse). Each distinct sub-problem is dispatched ONCE and
    // its pre-context branch mapped back to every input index that requested it. A C# `Dictionary`
    // that is only ever added to enumerates in insertion order, and so does a `Map`, so
    // `distinct.Values.ToList()` and `[...distinct.values()]` agree: dispatch order is
    // first-occurrence order.
    const distinct = new Map<string, number[]>();
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (it === undefined || it === null) {
        throw new InvalidArgumentError("Batch item must not be null. (Parameter 'items')");
      }
      // A DIFFERENT exception in the C# (`ArgumentNullException`, not `ArgumentException`); the
      // port has one class for both, so the messages are what tell them apart.
      if (it.subject === undefined || it.subject === null) {
        throw new InvalidArgumentError("subject must not be null");
      }
      const key = batchItemDedupKey(it);
      const idxs = distinct.get(key);
      if (idxs === undefined) {
        distinct.set(key, [i]);
      } else {
        idxs.push(i);
      }
    }

    // Bounded fan-out over the distinct sub-problems through the shared root dispatcher.
    // `Math.max(1, ...)`: a zero or negative width becomes ONE, never unlimited.
    const distinctList = [...distinct.values()];
    const branches = new Array<DispatchCheckResult>(distinctList.length);
    const gate = new AsyncSemaphore(Math.max(1, this.#maxConcurrency));
    await Promise.all(
      distinctList.map(async (indices, slot) => {
        await gate.wait(signal);
        try {
          // `items[indices[0]]` - the FIRST item that requested this sub-problem.
          const sample = items[indices[0] as number] as BatchCheckItem;
          const resource: ObjectAndRelation = {
            objectType: sample.resourceType,
            objectId: sample.resourceId,
            relation: sample.permission,
          };
          branches[slot] = await this.#root.dispatchCheck(
            { resource, subject: sample.subject, meta },
            signal,
          );
        } finally {
          gate.release();
        }
      }),
    );

    // Collapse each item against its OWN caveat context (a shared branch can collapse differently
    // per item), assembling results BY INDEX so request order survives dispatch order. Note the two
    // index spaces: `resultItems` is aligned to `items`, `branches` to `distinctList`, joined by
    // the original indices `distinctList[slot]` holds.
    const resultItems = new Array<PermissionCheckResultItem>(items.length);
    for (let slot = 0; slot < distinctList.length; slot += 1) {
      const branch = branches[slot] as DispatchCheckResult;
      for (const i of distinctList[slot] as number[]) {
        const collapsed = engine.collapse(branch, items[i]?.caveatContext);
        resultItems[i] = {
          verdict: collapsed.verdict,
          missingFields: collapsed.missingExprFields,
        };
      }
    }

    const datastoreId = await this.#datastore.getUniqueId(signal);
    const token = zedTokenFromRevision(resolved.revision, resolved.schemaHash, datastoreId).token;
    return {
      items: resultItems,
      evaluatedRevision: resolved.revision,
      schemaHash: resolved.schemaHash,
      evaluatedToken: token,
    };
  }
}
