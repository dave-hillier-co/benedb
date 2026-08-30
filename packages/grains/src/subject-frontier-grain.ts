import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { systemClockNow } from "@spacedb/engine/clock";
import { LookupSubjectsEngine } from "@spacedb/engine/lookup-subjects-engine";
import { grain } from "@thresh/core/decorators";
import { Grain } from "@thresh/core/grain";

import { frontierSubjectToWire } from "./frontier-wire";
import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import type { IDispatchMetrics } from "./i-dispatch-metrics";
import type { IGraphReaderSource } from "./i-graph-reader-source";
import type { ISchemaProvider } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import type { ISubjectFrontierGrain } from "./i-subject-frontier-grain";
import { parseRevision } from "./revision-codec";
import type { SchemaResolver } from "./schema-resolver";
import type { FrontierSubjectWire, SubjectFrontierReply } from "./subject-frontier-dtos";
import { subjectFrontierKeyParse } from "./subject-frontier-key";
import type { SubjectFrontierMemoOptions } from "./subject-frontier-memo-options";
import { resolveSubjectFrontierMemoOptions } from "./subject-frontier-memo-options";

/**
 * The C# primary-constructor parameters as an explicit options bag (Thresh has no DI container),
 * supplied through a `GrainActivator`. `memoOptions` and `metrics` keep the C#'s optional defaults.
 */
export interface SubjectFrontierGrainOptions {
  readonly schemaSource: ISchemaSource;
  readonly schemaProvider: ISchemaProvider;
  readonly schemaResolver: SchemaResolver;
  readonly readerSource: IGraphReaderSource;
  readonly memoOptions?: SubjectFrontierMemoOptions | undefined;
  readonly metrics?: IDispatchMetrics | undefined;
}

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/SubjectFrontierGrain.cs`.
 *
 * A grain keyed by "the pre-context subject frontier of resource#relation for
 * subjectType(#subjectRelation) at (quantizedRevision, schemaHash)". It runs a whole
 * `LookupSubjectsEngine.lookupSubjects` walk from its key's root, in-process, behind a single grain
 * call, and memoizes the materialized result in activation state - the LookupSubjects analogue of
 * `CheckGrain`'s reply memo.
 *
 * UNLIKE `CheckGrain`, this grain is deliberately NOT reentrant. `CheckGrain` must be reentrant
 * because it dispatches sub-problems back out to OTHER `ICheckGrain` activations, and a genuine
 * relation cycle can re-enter the very activation that started the recursion. This grain has no
 * dispatcher seam at all: `LookupSubjectsEngine` is consumed unchanged and walks the whole
 * sub-graph in-process from this activation, with no cross-grain recursion to re-enter. Default
 * (non-reentrant) turn-based execution therefore gives this grain single-flight FOR FREE - two
 * concurrent calls to the same activation simply queue, and the second is served by the memo the
 * first one just populated, rather than recomputing independently. Thresh grains are non-reentrant
 * by DEFAULT (`grain-metadata.ts`'s `reentrantRegistry` is opt-in via `@reentrant()`), verified for
 * this port, so the ABSENCE of the decorator here is the whole design - do not add one, and do not
 * let one arrive by copying `CheckGrain`.
 *
 * The memoized value is the PRE-CONTEXT frontier (verbatim caveat expressions, exactly as the
 * engine yields them), never a collapsed verdict - caveat context is applied per-request at the
 * caller (`ReverseOps.streamLookupSubjects`), matching `CheckGrain`'s memo contract.
 *
 * There is no depth guard / cycle-cut analogue here (unlike `CheckGrain`'s exact visited set and
 * `depthRequired` gate): this grain always runs the WHOLE walk from its key's root in one call, and
 * the walk's own depth limit and visited-set cycle guard are entirely internal to
 * `LookupSubjectsEngine` - the result is a pure function of the key alone, so there is no
 * caller-supplied budget varying the completeness of what gets cached, and hence nothing to guard.
 */
@grain({ placement: "custom", strategy: GRAPH_LOCALITY_PLACEMENT_STRATEGY })
export class SubjectFrontierGrain extends Grain implements ISubjectFrontierGrain {
  readonly #deps: SubjectFrontierGrainOptions | undefined;

  /** `memoOptions ?? new SubjectFrontierMemoOptions()`, with every default applied. */
  readonly #memoOptions: ReturnType<typeof resolveSubjectFrontierMemoOptions>;

  /** The memoized frontier computed on this activation so far, or absent before the first compute. */
  #memo: SubjectFrontierReply | undefined;

  /** Optional for the same reason as `CheckGrain`'s - see its constructor remarks. */
  constructor(options?: SubjectFrontierGrainOptions) {
    super();
    this.#deps = options;
    this.#memoOptions = resolveSubjectFrontierMemoOptions(options?.memoOptions);
  }

  get #require(): SubjectFrontierGrainOptions {
    if (this.#deps === undefined) {
      throw new InvalidArgumentError(
        "SubjectFrontierGrain requires its collaborators; supply them through a GrainActivator",
      );
    }
    return this.#deps;
  }

  /** @inheritdoc */
  async getFrontier(signal?: AbortSignal | undefined): Promise<SubjectFrontierReply> {
    const cached = this.#memo;
    if (this.#memoOptions.enabled && cached !== undefined) {
      this.#deps?.metrics?.recordFrontierMemoHit();
      return cached;
    }

    if (this.#memoOptions.enabled) this.#deps?.metrics?.recordFrontierMemoMiss();

    const parts = subjectFrontierKeyParse(this.id.key as string);
    const revision = parseRevision(parts.revision);

    // 'now' is captured once per compute, not once per activation, exactly matching `CheckGrain`:
    // the memo's staleness class is bounded by the activation's idle-collection age within one
    // quantized-revision keyspace.
    const now = systemClockNow();

    const deps = this.#require;
    const schema = await deps.schemaResolver.resolveWithSource(
      parts.schemaHash,
      deps.schemaSource,
      revision,
      deps.schemaProvider.current,
      signal,
    );

    // The engine walk reads through the `IGraphReaderSource` seam (the shard mesh) at the same
    // pinned revision; schema resolution above goes through the `ISchemaSource` seam (a sequencer
    // read once per hash per silo, cached by `SchemaResolver`).
    const engine = new LookupSubjectsEngine(schema.namespaces);
    const subjects: FrontierSubjectWire[] = [];
    for await (const found of engine.lookupSubjects(
      deps.readerSource.graphReaderAt(revision),
      parts.resource,
      parts.subjectType,
      parts.subjectRelation,
      now,
      signal,
    )) {
      subjects.push(frontierSubjectToWire(found));
    }

    const reply: SubjectFrontierReply = { subjects };

    // Over-cap results are served but not retained: the caller above always gets the freshly
    // computed reply regardless of this check.
    if (this.#memoOptions.enabled && subjects.length <= this.#memoOptions.maxMemoSubjects) {
      this.#memo = reply;
    }

    return reply;
  }
}
