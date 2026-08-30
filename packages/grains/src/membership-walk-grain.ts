import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { directParents, subjectKeyToString } from "@spacedb/engine/membership-walk";
import type { SubjectKey } from "@spacedb/engine/membership-walk";
import { grain, reentrant } from "@thresh/core/decorators";
import { Grain } from "@thresh/core/grain";

import { GRAPH_LOCALITY_PLACEMENT_STRATEGY } from "./graph-locality-placement";
import type { IGraphReaderSource } from "./i-graph-reader-source";
import type {
  IMembershipWalkGrain,
  MembershipClosureReply,
  MembershipWalkArgs,
  ResourceNodeWire,
} from "./i-membership-walk-grain";
import { IMembershipWalkGrain as IMembershipWalkGrainRef } from "./i-membership-walk-grain";
import type { ISchemaProvider } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import { membershipWalkKeyBuild, membershipWalkKeyParse } from "./membership-walk-key";
import type { MembershipWalkOptions } from "./membership-walk-options";
import { resolveMembershipWalkOptions } from "./membership-walk-options";
import { parseRevision } from "./revision-codec";
import type { SchemaResolver } from "./schema-resolver";

/**
 * The C# primary-constructor parameters as an explicit options bag (Thresh has no DI container),
 * supplied through a `GrainActivator`.
 *
 * The C#'s `IGrainFactory grainFactory` parameter has NO counterpart here: the sibling dispatch
 * goes through `this.getGrain(...)` on the `Grain` base, which is the port guide's mapping for
 * `GrainFactory.GetGrain<IFoo>(id)` inside a grain.
 */
export interface MembershipWalkGrainOptions {
  readonly schemaSource: ISchemaSource;
  readonly schemaProvider: ISchemaProvider;
  readonly schemaResolver: SchemaResolver;
  readonly readerSource: IGraphReaderSource;
  readonly options?: MembershipWalkOptions | undefined;
}

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/MembershipWalkGrain.cs`.
 *
 * A grain keyed by "the membership-walk closure rooted at subject key `subjType:subjId#subjRelation`
 * at (revision, schemaHash)". It computes ONE reverse-adjacency hop (`directParents`) and
 * dispatches every parent onward to the SIBLING `IMembershipWalkGrain` keyed by that parent, so the
 * walk is a real sharded mesh - the addressable replacement for the retired per-silo
 * `MembershipIndexCache` replica.
 *
 * Flow: memo check (serve `#memo` when set and enabled) - parse the key - resolve the schema at the
 * key's revision through the `ISchemaSource` seam - read its lazily-built `membershipCoverage` -
 * compute this subject's direct parents through the `IGraphReaderSource` seam - if
 * `args.depthRemaining` is exhausted, return an `incomplete` reply with no recursion - otherwise,
 * for each parent whose OWN subject key is NOT already on the caller's path, dispatch to the
 * sibling grain for that parent with the path extended by this grain's own subject key and the
 * depth budget decremented; union every child's nodes with this hop's direct parents, and OR every
 * child's `cycleCut` / `incomplete` into this reply. A parent already on the path is a genuine
 * back-edge: it is included as a node (it IS a direct parent) but skipped for recursion and marks
 * `cycleCut`.
 *
 * TWO DIVERGENCES from `CheckGrain`'s dispatch pattern, both because this walk's job is a COMPLETE
 * candidate superset rather than a cycle-tolerant verdict:
 *  - EXACT PATH LIST, not a bounded traversal bloom. A false-positive skip in a probabilistic
 *    filter would silently drop a whole subtree of candidates here - an incomplete result a caller
 *    could not detect - whereas Check's bloom only risks a harmless re-expansion.
 *  - SKIP-ON-PATH-HIT, not call-anyway. A true back-edge is unconditionally complete, so no
 *    reentrant call is made at all, only the cheap membership test against the path list.
 *
 * CACHING mirrors `CheckGrain`'s activation memo exactly: the freshly computed reply is stored ONLY
 * when it is neither `cycleCut` nor `incomplete` (a cut/incomplete result is path- or
 * budget-dependent, not a pure function of this grain's identity alone, so caching it would be
 * unsound for another caller). The memo check happens FIRST, before the key is even parsed, and
 * ignores `args` entirely - sound precisely because only path- and budget-independent replies are
 * ever stored.
 *
 * PORT NOTES.
 *  - `[Reentrant]` -> the `@reentrant()` CLASS decorator, for the same reason as `CheckGrain`: a
 *    genuine data cycle (group A contains B contains A) re-enters the activation that started the
 *    walk.
 *  - The path is a LIST with `Contains` (O(n) exact), not a set of objects. It stays an array of
 *    canonical subject-key STRINGS, which is both the C#'s shape and the only shape a JS
 *    containment test can compare by value.
 *  - `.ConfigureAwait(true)` is a no-op in TypeScript and is simply dropped, not translated.
 */
@grain({ placement: "custom", strategy: GRAPH_LOCALITY_PLACEMENT_STRATEGY })
@reentrant()
export class MembershipWalkGrain extends Grain implements IMembershipWalkGrain {
  readonly #deps: MembershipWalkGrainOptions | undefined;

  /** `options ?? new MembershipWalkOptions()`, with every default applied. */
  readonly #options: ReturnType<typeof resolveMembershipWalkOptions>;

  /** The most-recently computed complete (non-cut, non-incomplete) reply, or absent before one exists. */
  #memo: MembershipClosureReply | undefined;

  /** Optional for the same reason as `CheckGrain`'s - see its constructor remarks. */
  constructor(options?: MembershipWalkGrainOptions) {
    super();
    this.#deps = options;
    this.#options = resolveMembershipWalkOptions(options?.options);
  }

  get #require(): MembershipWalkGrainOptions {
    if (this.#deps === undefined) {
      throw new InvalidArgumentError(
        "MembershipWalkGrain requires its collaborators; supply them through a GrainActivator",
      );
    }
    return this.#deps;
  }

  /** @inheritdoc */
  async getContainingSet(
    args: MembershipWalkArgs,
    signal?: AbortSignal | undefined,
  ): Promise<MembershipClosureReply> {
    // `ArgumentNullException.ThrowIfNull(args);`
    if (args === undefined || args === null) {
      throw new InvalidArgumentError("args is required");
    }

    const cached = this.#memo;
    if (this.#options.enabled && cached !== undefined) return cached;

    const ownKey = this.id.key as string;
    const parts = membershipWalkKeyParse(ownKey);
    const revision = parseRevision(parts.revision);

    const deps = this.#require;
    const schema = await deps.schemaResolver.resolveWithSource(
      parts.schemaHash,
      deps.schemaSource,
      revision,
      deps.schemaProvider.current,
      signal,
    );
    const coverage = schema.membershipCoverage;

    const subject: SubjectKey = {
      type: parts.subjectType,
      id: parts.subjectId,
      relation: parts.subjectRelation,
    };
    // The reverse-adjacency hop reads through the `IGraphReaderSource` seam (the shard mesh) at the
    // same pinned revision; schema resolution above goes through the `ISchemaSource` seam.
    const parents = await directParents(
      deps.readerSource.graphReaderAt(revision),
      coverage,
      subject,
      signal,
    );

    // `new List<ResourceNodeWire>(directParents.Count)` - the capacity hint has no counterpart, and
    // the DUPLICATES this list accumulates below are intentional: nothing here dedups, and the
    // dedup that does exist lives one layer up in `toCoveredCandidates`.
    const nodes: ResourceNodeWire[] = [];
    for (const p of parents) nodes.push({ type: p.type, id: p.id, relation: p.relation });

    if (args.depthRemaining <= 0) {
      // Budget exhausted before this hop could recurse into any parent: the direct parents
      // themselves are still valid candidates, but nothing beyond them was explored - the whole
      // reply is partial. `incomplete` is CONDITIONAL on there being parents at all.
      return { nodes, cycleCut: false, incomplete: parents.length > 0 };
    }

    let cycleCut = false;
    let incomplete = false;
    // The path carries CANONICAL SUBJECT KEYS (`type:id#relation`), not grain keys: the revision and
    // schema hash are constant along one walk, so the subject key is the whole cycle identity - and
    // it is the same string shape the parent-side containment test below compares against. Built
    // ONCE before the loop and REUSED for every child, so no sibling branch can prune another.
    const childPath: string[] = [...args.path, subjectKeyToString(subject)];

    for (const parent of parents) {
      signal?.throwIfAborted();

      const parentSubjectKey = subjectKeyToString({
        type: parent.type,
        id: parent.id,
        relation: parent.relation,
      });
      if (args.path.includes(parentSubjectKey)) {
        // A genuine back-edge: the ancestor is already being walked by the call that first put it
        // on the path, so its closure is already accounted for there - complete without recursing.
        cycleCut = true;
        continue;
      }

      const parentGrainKey = membershipWalkKeyBuild(
        parent.type,
        parent.id,
        parent.relation,
        parts.revision,
        parts.schemaHash,
      );
      const siblingGrain = this.getGrain(IMembershipWalkGrainRef, parentGrainKey);
      const childArgs: MembershipWalkArgs = {
        path: childPath,
        depthRemaining: args.depthRemaining - 1,
      };

      // The caller's own signal drives the sibling call directly: Thresh propagates it to that
      // activation natively, so there is nothing left to bridge here.
      const childReply = await siblingGrain.getContainingSet(childArgs, signal);

      // `nodes.AddRange(childReply.Nodes)`: a loop, because the reply deliberately does not dedup
      // (see the note above), so duplicates inflate the count past the spread argument limit well
      // before the distinct closure size would suggest.
      for (const node of childReply.nodes) nodes.push(node);
      cycleCut ||= childReply.cycleCut;
      incomplete ||= childReply.incomplete;
    }

    const reply: MembershipClosureReply = { nodes, cycleCut, incomplete };

    // Never memoize a cut/incomplete result - it is path- or budget-dependent, not a pure function
    // of this grain's identity alone (mirrors `CheckGrain`'s memo-eligibility rule verbatim).
    if (this.#options.enabled && !reply.cycleCut && !reply.incomplete) this.#memo = reply;

    return reply;
  }
}
