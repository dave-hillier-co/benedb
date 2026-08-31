import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { systemClockNow } from "@benedb/engine/clock";
import type { IDispatcher } from "@benedb/engine/i-dispatcher";
import {
  visitKeyFromCanonicalString,
  visitKeyToCanonicalString,
} from "@benedb/engine/i-dispatcher";
import { LocalDispatcher } from "@benedb/engine/local-dispatcher";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { grain, reentrant } from "@thresh/core/decorators";
import { Grain } from "@thresh/core/grain";

import type { ActivationMemoOptions } from "./activation-memo-options";
import { resolveActivationMemoOptions } from "./activation-memo-options";
import { caveatToWire } from "./caveat-wire";
import { requireDepthRemaining, requireVisited } from "./dispatch-context";
import { grainKeyParse } from "./grain-key";
import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import type { DispatchCheckReply, ICheckGrain } from "./i-check-grain";
import { dispatchCheckReplyDepthRequired } from "./i-check-grain";
import type { IDispatchMetrics } from "./i-dispatch-metrics";
import type { IGraphReaderSource } from "./i-graph-reader-source";
import type { ISchemaProvider } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import { parseRevision } from "./revision-codec";
import type { SchemaResolver } from "./schema-resolver";

/**
 * The C# primary-constructor parameters. Thresh has no DI container, so constructor injection
 * becomes an explicit options bag supplied through a `GrainActivator` - the same shape
 * `DatastoreGrain` uses. `memoOptions` and `metrics` keep the C#'s optional-with-null defaults.
 */
export interface CheckGrainOptions {
  readonly schemaSource: ISchemaSource;
  readonly schemaProvider: ISchemaProvider;
  readonly schemaResolver: SchemaResolver;
  readonly onward: IDispatcher;
  readonly readerSource: IGraphReaderSource;
  readonly memoOptions?: ActivationMemoOptions | undefined;
  readonly metrics?: IDispatchMetrics | undefined;
}

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/CheckGrain.cs`.
 *
 * A grain keyed by a single canonical sub-problem. It computes exactly ONE expansion step of that
 * sub-problem and dispatches every deeper sub-problem back out through the dispatcher, so
 * recursion crosses grain boundaries and the mesh is real.
 *
 * On {@link dispatchCheck} the grain decodes its identity from its string key (resource, subject,
 * revision, schema hash), resolves a graph reader at that revision through the
 * {@link IGraphReaderSource} seam (schema resolution goes through the {@link ISchemaSource} seam on
 * a hash miss), and runs a `LocalDispatcher` whose onward `dispatcher` is the silo-wide
 * `OrleansDispatcher` singleton. The local dispatcher performs the one step; children flow onward
 * as further grain calls.
 *
 * CACHING (stage (a) of "Activation-as-cache"): the grain holds a single memoized reply in
 * `#memo` - the PRE-CONTEXT branch (membership + caveat wire), never the collapsed verdict. On
 * entry, when the memo is enabled and a memo exists whose `depthRequired` is at most the caller's
 * remaining budget, it is returned with no re-expansion (a depth guard:
 * `depthRemaining >= depthRequired`, else fall through and recompute under the tighter budget). A
 * freshly computed reply is stored ONLY when it is not `cycleCut` (a cycle-cut result depends on
 * the in-flight visited set, which is not part of this grain's identity, so caching it would be
 * unsound on another path) and only when it is STRICTLY more servable than any existing memo, so
 * the activation keeps the most-reusable entry it has ever computed. The grain identity already
 * embeds the quantized revision and schema hash, so the keyspace rotates on its own every
 * quantization window; the activation's own idle-collection age IS the memo's eviction policy.
 *
 * NOT a singleflight cache: concurrent calls never await one another's in-flight promise. The
 * grain is reentrant precisely so a same-key re-entry on a genuine cycle is accepted rather than
 * blocked; if a re-entrant call instead awaited a shared in-flight promise for the same key, a
 * same-key cyclic re-entry would deadlock against itself. Letting concurrent duplicate calls
 * recompute independently is benign - both read the same pinned snapshot and schema.
 *
 * PORT NOTES.
 *  - `[Reentrant]` is a CLASS-level Orleans attribute, and Thresh spells that as the
 *    `@reentrant()` class decorator (`markReentrant`), not as a per-method entry in the interface
 *    `options` map - that map's `alwaysInterleave` is the per-METHOD `[AlwaysInterleave]`. The
 *    two are not interchangeable, so `ICheckGrain`'s options map stays empty.
 *  - `[GraphLocalityPlacement]` -> `{ placement: "custom", strategy }` plus the silo-side
 *    `addPlacementStrategy` registration; what survives the attribute/director pair is the name.
 *  - `DateTimeOffset.UtcNow` -> `systemClockNow()` (epoch NANOS), which is the carrier
 *    `LocalDispatcher` already takes for its pinned evaluation clock.
 *  - The memo field is per-activation mutable state read-then-written with plain assignments,
 *    deliberately: a turn is single-threaded even for a reentrant grain (interleaving happens only
 *    at awaits), so there is no torn read/write here.
 */
@grain({ placement: "custom", strategy: GRAPH_LOCALITY_PLACEMENT_STRATEGY })
@reentrant()
export class CheckGrain extends Grain implements ICheckGrain {
  readonly #deps: CheckGrainOptions | undefined;

  /** `memoOptions ?? new ActivationMemoOptions()`, with every default applied. */
  readonly #memoOptions: ReturnType<typeof resolveActivationMemoOptions>;

  /**
   * The most-servable pre-context reply computed on this activation so far (or absent before the
   * first compute, or if the memo is disabled). See the CACHING remarks on this class.
   */
  #memo: DispatchCheckReply | undefined;

  /**
   * The C# takes its five collaborators as REQUIRED primary-constructor parameters, resolved by the
   * DI container. Thresh's grain registration types every grain constructor as zero-argument (the
   * activator supplies the instance), so the bag is optional here and its absence is reported at
   * first use through {@link require} - the same shape `DatastoreGrain` uses for its storage
   * provider. A grain activated without collaborators cannot do anything at all, and saying so
   * beats a `TypeError` from deep inside the dispatch.
   */
  constructor(options?: CheckGrainOptions) {
    super();
    this.#deps = options;
    this.#memoOptions = resolveActivationMemoOptions(options?.memoOptions);
  }

  get #require(): CheckGrainOptions {
    if (this.#deps === undefined) {
      throw new InvalidArgumentError(
        "CheckGrain requires its collaborators; supply them through a GrainActivator",
      );
    }
    return this.#deps;
  }

  /** @inheritdoc */
  async dispatchCheck(signal?: AbortSignal | undefined): Promise<DispatchCheckReply> {
    // The depth budget and exact visited-set cycle guard are call-chain context, not part of this
    // grain's identity, so they arrive ambiently via the RequestContext (imported before any
    // incoming call filter runs) rather than as a method argument - see `dispatch-context.ts`. A
    // missing value here means some caller reached `dispatchCheck` without going through the
    // dispatcher / test seam that sets it; that is a bug and must throw loudly, not default.
    const depthRemaining = requireDepthRemaining();
    // `RequireVisited().Select(VisitKey.FromCanonicalString).ToImmutableHashSet()`: the set travels
    // the wire as canonical STRINGS, and `ResolverMeta.visited` is a `ReadonlySet<string>` of those
    // same canonical strings (a `Set` of `VisitKey` OBJECTS would be reference-keyed and never
    // match), so the round trip through `visitKeyFromCanonicalString` is kept - it is the C#'s
    // validating parse - and the canonical form is what lands in the set.
    const visited = new Set(
      requireVisited().map((s) => visitKeyToCanonicalString(visitKeyFromCanonicalString(s))),
    );

    const cached = this.#memo;
    if (
      this.#memoOptions.enabled &&
      cached !== undefined &&
      depthRemaining >= dispatchCheckReplyDepthRequired(cached)
    ) {
      this.#deps?.metrics?.recordMemoHit();
      return cached;
    }

    if (this.#memoOptions.enabled) this.#deps?.metrics?.recordMemoMiss();

    const parts = grainKeyParse(this.id.key as string);
    const revision = parseRevision(parts.revision);

    // 'now' is captured once per COMPUTE (not once per activation): the memo's staleness class is
    // bounded by the activation's idle-collection age within one quantized-revision keyspace.
    const now = systemClockNow();

    // Resolve the schema this sub-problem must evaluate under: exactly the one named by the key's
    // schemaHash at the key's revision. This makes evaluation a pure function of the pinned
    // revision - the schema bytes are folded into the log on EVERY silo, so a grain activated on a
    // silo that never handled the WriteSchema still evaluates the right schema, rather than
    // trusting a possibly-stale local `ISchemaProvider.current`. Only when the key names no schema
    // (the seed-only window) do we fall back to `current`, the identical embedded seed everywhere.
    const deps = this.#require;
    const schema = await deps.schemaResolver.resolveWithSource(
      parts.schemaHash,
      deps.schemaSource,
      revision,
      deps.schemaProvider.current,
      signal,
    );

    // A `LocalDispatcher` does ONE expansion step; its onward dispatcher turns each child
    // sub-problem into a further grain call. The graph reads flow through the
    // `IGraphReaderSource` seam (the shard mesh); schema resolution above goes through the
    // `ISchemaSource` seam (a sequencer read once per hash per silo, cached by `SchemaResolver`).
    const namespaces = namespacesByName(schema.namespaces);
    const local = new LocalDispatcher(namespaces, (r) => deps.readerSource.graphReaderAt(r), now);
    local.dispatcher = deps.onward;

    const meta = { revision, depthRemaining, visited };
    const request = { resource: parts.resource, subject: parts.subject, meta };

    const result = await local.dispatchCheck(request, signal);

    const reply: DispatchCheckReply = {
      member: result.member,
      caveat: caveatToWire(result.caveat),
      cycleCut: result.cycleCut,
      depthRequired: result.depthRequired,
    };

    // Never memoize a cycle-cut result (path-dependent on the in-flight visited set, which is
    // excluded from this grain's identity); of the remaining candidates, keep the one that requires
    // the least depth, so the activation always holds its most-servable entry.
    const existing = this.#memo;
    if (
      this.#memoOptions.enabled &&
      !result.cycleCut &&
      (existing === undefined ||
        dispatchCheckReplyDepthRequired(reply) < dispatchCheckReplyDepthRequired(existing))
    ) {
      this.#memo = reply;
    }

    return reply;
  }
}

/**
 * `schema.Namespaces.ToImmutableDictionary(ns => ns.Name)`, which THROWS on a duplicate name where
 * `new Map` would silently let the last one win. A duplicate reaching the dispatcher unnoticed
 * would evaluate half a schema and answer confidently, so the throw is reproduced explicitly (as
 * `i-schema-provider.ts` and the engines do).
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
