import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { IGraphReader } from "@spacedb/datastore/i-graph-reader";
import type {
  SubjectRelationFilter,
  SubjectsFilter,
} from "@spacedb/datastore/relationships-filter";

import type { MembershipCoverage } from "./membership-coverage";

/**
 * The Leopard membership-walk primitive: one reverse-adjacency hop over a pinned MVCC snapshot,
 * plus an in-process BFS driver over it. This is the shared "walk definition" that both the
 * membership-walk grain (the addressable, sibling-recursing, cross-grain driver) and
 * {@link localClosure} (the in-process driver used by engine-level tests and the equivalence gate)
 * consume - the same one-walk-definition/two-drivers shape as the local/dispatched Check drivers.
 *
 * Ported from Spiceport `src/Spiceport.Server/Engine/Lookup/MembershipWalk.cs`.
 *
 * Because a walk runs over a reader pinned to one MVCC revision, it is revision-exact by
 * construction: a walk at revision R only ever sees rows live at R.
 *
 * CANDIDATE SEMANTICS: {@link directParents} ignores caveats entirely (a candidate is confirmed by
 * the CheckEngine, which resolves the caveat), and expired rows are excluded automatically because
 * `reverseQueryRelationships` already filters expiration at read time - there is nothing extra to
 * do here for either.
 *
 * Port decisions:
 *   * `public static class MembershipWalk` is a namespace, not a value, so it becomes these
 *     module-level functions with no namespace object.
 *   * The two nested `readonly record struct`s become plain interfaces.
 *   * `SubjectKey` OVERRIDES `ToString()`, and that string IS the visited-set key, so it is
 *     exported as {@link subjectKeyToString} rather than left to default stringification.
 *   * `CancellationToken cancellationToken = default` becomes a trailing `signal?: AbortSignal`
 *     kept in the C#'s positional slot and forwarded to the reader.
 */

/** A subject/resource identity as walked: `type:id#relation`. */
export interface SubjectKey {
  readonly type: string;
  readonly id: string;
  readonly relation: string;
}

/** A resource node reached by a hop: the containing (type, id, relation) a subject was found on. */
export interface ResourceNode {
  readonly type: string;
  readonly id: string;
  readonly relation: string;
}

/** The canonical `type:id#relation` string form, used as the visited-set key. */
export function subjectKeyToString(key: SubjectKey): string {
  return `${key.type}:${key.id}#${key.relation}`;
}

/**
 * One reverse-adjacency hop: every resource node that directly names `subject` as a subject,
 * restricted to the base relations `coverage`'s scan set actually tracks (a row on a relation
 * outside the scan set cannot contribute to any covered target, so it is discarded).
 *
 * The returned list DELIBERATELY contains duplicates; dedup happens only in
 * {@link toCoveredCandidates}.
 */
export async function directParents(
  reader: IGraphReader,
  coverage: MembershipCoverage,
  subject: SubjectKey,
  signal?: AbortSignal | undefined,
): Promise<readonly ResourceNode[]> {
  // `ArgumentNullException.ThrowIfNull`, kept even though the TypeScript types are non-optional:
  // the grain-layer caller is untyped.
  if (reader === undefined || reader === null) {
    throw new InvalidArgumentError("reader is required");
  }
  if (coverage === undefined || coverage === null) {
    throw new InvalidArgumentError("coverage is required");
  }

  const relationFilter: SubjectRelationFilter =
    subject.relation === ELLIPSIS
      ? { includeEllipsisRelation: true }
      : { nonEllipsisRelation: subject.relation };

  const filter: SubjectsFilter = {
    subjectType: subject.type,
    optionalSubjectIds: [subject.id],
    relationFilter,
  };

  const results: ResourceNode[] = [];
  // The C# passes `options: null` explicitly.
  for await (const rel of reader.reverseQueryRelationships(filter, undefined, signal)) {
    // Belt-and-braces exact match on the subject relation: SubjectRelationFilter's ellipsis
    // branch does not itself exclude non-ellipsis rows, so re-check exactly here rather than
    // lean on the datastore filter alone.
    if (rel.reference.subject.relation !== subject.relation) {
      continue;
    }
    if (!coverage.scanSetHas(rel.reference.resource.objectType, rel.reference.resource.relation)) {
      continue;
    }
    results.push({
      type: rel.reference.resource.objectType,
      id: rel.reference.resource.objectId,
      relation: rel.reference.resource.relation,
    });
  }

  return results;
}

/**
 * In-process BFS over {@link directParents} from `subject`, with a visited-set cycle guard,
 * seeding a second walk from the subject's wildcard identity (`type:*#relation`) so a
 * `type:*#rel` userset edge (which makes every such subject a member) is followed too. Terminates
 * on a data cycle (e.g. group A containing group B containing group A) because the visited set is
 * keyed by the canonical subject-key string.
 */
export async function localClosure(
  reader: IGraphReader,
  coverage: MembershipCoverage,
  subject: SubjectKey,
  signal?: AbortSignal | undefined,
): Promise<readonly ResourceNode[]> {
  const visited = new Set<string>();
  const queue: SubjectKey[] = [];
  const found: ResourceNode[] = [];

  // The C# `Enqueue` is a local function declared after the loop; TypeScript needs it before use.
  function enqueue(key: SubjectKey): void {
    const asString = subjectKeyToString(key);
    if (!visited.has(asString)) {
      visited.add(asString);
      queue.push(key);
    }
  }

  enqueue(subject);
  enqueue({ ...subject, id: PUBLIC_WILDCARD });

  while (queue.length > 0) {
    signal?.throwIfAborted();
    const current = queue.shift()!;
    const parents = await directParents(reader, coverage, current, signal);
    for (const node of parents) {
      found.push(node);
      enqueue({ type: node.type, id: node.id, relation: node.relation });
    }
  }

  return found;
}

/**
 * Filters a walked node set down to the COMPLETE candidate resource-id set for one covered
 * `(resourceType, permission)` target: nodes whose (type, relation) is one of `yieldRelations`,
 * plus the reflexive self-membership candidate when the subject and resource types match. The
 * rule lives here so the grain-mesh caller and the in-process {@link localClosure} driver cannot
 * drift on it. Returns sorted, distinct ids.
 *
 * `SortedSet<string>(StringComparer.Ordinal)` becomes a `Set` plus `[...set].sort()`: the default
 * `Array.prototype.sort` comparator is UTF-16 ordinal, which matches `StringComparer.Ordinal`.
 * `localeCompare` would reorder the ids the caller pages through and must never appear.
 */
export function toCoveredCandidates(
  nodes: Iterable<ResourceNode>,
  yieldRelations: ReadonlySet<string>,
  resourceType: string,
  subjectType: string,
  subjectId: string,
): readonly string[] {
  if (nodes === undefined || nodes === null) {
    throw new InvalidArgumentError("nodes is required");
  }
  if (yieldRelations === undefined || yieldRelations === null) {
    throw new InvalidArgumentError("yieldRelations is required");
  }

  const found = new Set<string>();
  for (const node of nodes) {
    if (node.type === resourceType && yieldRelations.has(node.relation)) {
      found.add(node.id);
    }
  }

  // Reflexive userset self-membership: a subject `T:id#rel` can reflexively hold a permission on
  // `T:id`. Over-inclusion is safe - Check resolves it - so this is unconditional.
  if (subjectType === resourceType) {
    found.add(subjectId);
  }

  return found.size === 0 ? [] : [...found].sort();
}
