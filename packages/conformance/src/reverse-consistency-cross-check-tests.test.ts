import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import {
  isPublicWildcard,
  objectAndRelationKey,
  type ObjectAndRelation,
} from "@spacedb/core/object-and-relation";
import type { Relationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { formatObjectAndRelation } from "@spacedb/core/tuple-strings";
import type { IDatastoreReader } from "@spacedb/datastore/i-datastore";
import { ReferenceDatastore } from "@spacedb/datastore/reference-datastore";
import { CheckEngine } from "@spacedb/engine/check-engine";
import { ExpandEngine } from "@spacedb/engine/expand-engine";
import type { FoundSubject } from "@spacedb/engine/found-subject";
import { LookupResourcesEngine } from "@spacedb/engine/lookup-resources-engine";
import { LookupSubjectsEngine } from "@spacedb/engine/lookup-subjects-engine";
import type { PermissionTreeNode, PermissionTreeSetOp } from "@spacedb/engine/permission-tree-node";
import { compileSchema } from "@spacedb/schema/schema-compiler";

import { loadResolvedValidationFile } from "./validation-file-loader";

/**
 * Property-style consistency cross-check that ties the Phase 3 reverse/tree APIs
 * (`LookupSubjectsEngine`, `LookupResourcesEngine`, `ExpandEngine`) back to the trusted forward
 * Check semantics (`CheckEngine`). For a representative slice of the conformance corpus it
 * asserts the soundness+completeness invariants from the design's section 4:
 *
 *   * Every subject returned by LookupSubjects yields Check = Member-or-Caveated; every subject
 *     of the requested type in the bounded universe that is NOT returned yields Check = NotMember
 *     (wildcards generalise to a fresh id).
 *   * Every resource returned by LookupResources yields Check = Member-or-Caveated; every
 *     resource of the requested type in the bounded universe that is NOT returned yields
 *     Check = NotMember.
 *   * The ExpandPermissionTree of a relation/permission, flattened to its effective concrete
 *     subject set, agrees with LookupSubjects for the same target.
 *
 * The bounded universe is the finite set of object ids per type observed in the corpus
 * relationships, plus a synthetic absent id, plus (for subjects) a fresh id to validate wildcard
 * semantics. Caveated tuples are evaluated by Check with an empty context (resolving to
 * `"caveated"`), which is the allowed-set member the reverse APIs must agree with when they carry
 * a caveat.
 *
 * Ported from Spiceport `tests/Spiceport.Conformance.Tests/ReverseConsistencyCrossCheckTests.cs`.
 *
 * Port decisions:
 *   * `[Theory]` + `[MemberData]` becomes `it.each`; the C# member-data provider becomes the
 *     `CORPUS_FILES` array, in the same order and with the same per-file comments.
 *   * `Assert.True(condition, message)` becomes the local {@link assertTrue}, which forwards the
 *     message to vitest's `expect(value, message)` so a failure still names the offending tuple.
 *   * `HashSet<ObjectAndRelation>` (C# record equality) becomes a `Map` keyed by
 *     `objectAndRelationKey`, since ONRs are structural objects here and would compare by
 *     reference in a `Set`. The map's VALUES are the ONRs, because the Expand cross-check
 *     iterates the flattened set and needs the ONR back, not just its key.
 *   * `IAsyncEnumerable<T>` + `await foreach` becomes `AsyncIterable<T>` + `for await`, so
 *     `Collect` ports directly as {@link collect}.
 *   * The C# `switch` expressions over the `PermissionTreeNode` hierarchy and over
 *     `SetOperationType` have `_ =>` fallbacks that are unreachable for the sealed/enum domain;
 *     they become exhaustive `switch` statements with a local `assertNever`, per the house rule.
 *   * `Membership.Member` / `Caveated` / `NotMember` are the string literals `"member"`,
 *     `"caveated"` and `"notMember"`.
 *   * `FoundSubject.Caveat is null` is `caveat === undefined`.
 */

/**
 * The representative corpus slice the cross-check runs over, deliberately spanning each
 * productive shape: a wildcard schema, an arrow schema, nested-group indirection (incl. exclusion
 * under the group permission), basic RBAC and a caveat.
 */
const CORPUS_FILES: readonly string[] = [
  "basicrbac.yaml", // base relations + simple union permission
  "public.yaml", // wildcards (user:* and a second user type)
  "document.yaml", // arrow (parent->view) + intersection
  "directgroups.yaml", // nested group#member chains
  "indirectnestedgroups.yaml", // nested groups with exclusion in the group perm
  "basiccaveat.yaml", // caveated subjects
];

const FRESH_SUBJECT_ID = "__cc_fresh_subject__";
const ABSENT_ID = "__cc_absent__";

const CORPUS_DIR = fileURLToPath(new URL("../corpus", import.meta.url));

describe("ReverseConsistencyCrossCheck", () => {
  it.each(CORPUS_FILES)("LookupSubjects agrees with Check for %s", async (fileName) => {
    const ctx = await loadCorpus(fileName);

    // For every (resource type, resource id, relation/permission) target and every
    // requested subject (type, relation), the returned set must exactly agree with
    // Check over the bounded subject universe.
    for (const ns of ctx.namespaces) {
      for (const relation of ns.relations) {
        for (const resourceId of idsOf(ctx, ns.name)) {
          const resource: ObjectAndRelation = {
            objectType: ns.name,
            objectId: resourceId,
            relation: relation.name,
          };

          // Cross-check against terminal subjects only. For non-terminal subject
          // relations (e.g. group#member) LookupSubjects yields the *directly written*
          // usersets matching the type+relation, whereas Check resolves userset
          // membership transitively, so the two are deliberately not 1:1 there (the
          // design's section 4 cross-check is framed over concrete subjects). Terminal subjects
          // are exactly where SpiceDB's own consistency tests operate.
          for (const subjectType of ctx.terminalSubjectTypes) {
            const found = await collect(
              ctx.lookupSubjects.lookupSubjects(ctx.reader, resource, subjectType, ELLIPSIS),
            );

            await assertLookupSubjectsAgrees(ctx, resource, subjectType, ELLIPSIS, found);
          }
        }
      }
    }
  });

  it.each(CORPUS_FILES)("LookupResources agrees with Check for %s", async (fileName) => {
    const ctx = await loadCorpus(fileName);

    // For every terminal subject (type, id) and every (resource type, relation/perm),
    // the returned resource set must exactly agree with Check over the bounded
    // resource universe. Subjects are scoped to terminal (ellipsis) for the same reason
    // as LookupSubjects above: that is where the reverse/forward correspondence is 1:1.
    const subjectRelation = ELLIPSIS;
    for (const subjectType of ctx.terminalSubjectTypes) {
      for (const subjectId of idsOf(ctx, subjectType)) {
        for (const resNs of ctx.namespaces) {
          for (const relation of resNs.relations) {
            const found = await collect(
              ctx.lookupResources.lookupResources(
                ctx.reader,
                subjectType,
                subjectId,
                subjectRelation,
                resNs.name,
                relation.name,
              ),
            );

            const foundIds = new Set(found.map((f) => f.resourceId));
            const subject: ObjectAndRelation = {
              objectType: subjectType,
              objectId: subjectId,
              relation: subjectRelation,
            };

            // Soundness: each returned resource agrees with Check. An unconditional
            // (Member) result must be a definite Check Member; a Caveated result must
            // be Member-or-Caveated under Check with empty context (a satisfiable
            // conditional edge; definitely-false embedded caveats are sheared before
            // being returned).
            for (const f of found) {
              const { verdict } = await ctx.check.check(
                ctx.reader,
                resNs.name,
                f.resourceId,
                relation.name,
                subject,
              );
              if (f.membership === "member") {
                assertTrue(
                  verdict === "member",
                  `${fileName}: LookupResources returned Member ${resNs.name}:${f.resourceId}#${relation.name} ` +
                    `for ${formatObjectAndRelation(subject)}, but Check says ${verdict}`,
                );
              } else {
                assertTrue(
                  verdict === "member" || verdict === "caveated",
                  `${fileName}: LookupResources returned Caveated ${resNs.name}:${f.resourceId}#${relation.name} ` +
                    `for ${formatObjectAndRelation(subject)}, but Check says ${verdict}`,
                );
              }
            }

            // Completeness: everything in the resource universe NOT returned is NotMember.
            for (const resourceId of idsOf(ctx, resNs.name)) {
              if (foundIds.has(resourceId)) {
                continue;
              }

              const { verdict } = await ctx.check.check(
                ctx.reader,
                resNs.name,
                resourceId,
                relation.name,
                subject,
              );
              assertTrue(
                verdict === "notMember",
                `${fileName}: LookupResources did NOT return ${resNs.name}:${resourceId}#${relation.name} ` +
                  `for ${formatObjectAndRelation(subject)}, but Check says ${verdict}`,
              );
            }
          }
        }
      }
    }
  });

  it.each(CORPUS_FILES)("ExpandTree flattens to LookupSubjects for %s", async (fileName) => {
    const ctx = await loadCorpus(fileName);

    // The flattened concrete (terminal) subject set of an expansion tree, evaluated
    // by interpreting the set operations, must agree with Check for each candidate
    // subject id of every subject type. This makes Expand testable via the same cross-check.
    for (const ns of ctx.namespaces) {
      for (const relation of ns.relations) {
        for (const resourceId of idsOf(ctx, ns.name)) {
          const resource: ObjectAndRelation = {
            objectType: ns.name,
            objectId: resourceId,
            relation: relation.name,
          };

          const tree = await ctx.expand.expandPermissionTree(ctx.reader, resource, "recursive");

          const flattened = flattenTerminalSubjects(tree);

          // Subjects that appear anywhere in the tree under a caveat are exempt: the
          // structural tree carries the caveat verbatim, so a written falsifying
          // embedded context (e.g. {somecondition:41}) would make Check definitely
          // NotMember even though the structural edge exists.
          const caveatedSubjects = collectCaveatedSubjects(tree);

          // Every unconditional concrete terminal subject the tree yields must be a
          // definite Member by Check.
          for (const [key, subject] of flattened) {
            if (isPublicWildcard(subject) || caveatedSubjects.has(key)) {
              // wildcard / caveated fidelity is covered by the LookupSubjects cross-check
              continue;
            }

            const { verdict } = await ctx.check.checkOnr(ctx.reader, resource, subject);
            assertTrue(
              verdict === "member",
              `${fileName}: ExpandTree(${formatObjectAndRelation(resource)}) yielded unconditional ` +
                `subject ${formatObjectAndRelation(subject)}, but Check says ${verdict}`,
            );
          }
        }
      }
    }
  });
});

// --- LookupSubjects assertion (soundness + completeness, with wildcard handling) ---

async function assertLookupSubjectsAgrees(
  ctx: CorpusContext,
  resource: ObjectAndRelation,
  subjectType: string,
  subjectRelation: string,
  found: readonly FoundSubject[],
): Promise<void> {
  // Unconditional (caveat === undefined) returns must be definite Members of Check.
  // Conditional (caveat !== undefined) returns are the "Caveated marker": they are exempt
  // from the soundness verdict (the relationship's *embedded* caveat context may even
  // falsify the edge under Check, e.g. a written {somecondition:41}), and they are
  // excluded from the NotMember complement below. This mirrors the design section 4 rule:
  // "Member if s.Caveat == null; Member-or-Caveated if caveated; never required to be
  //  NotMember when caveated".
  const anyFound = new Set(found.filter((f) => !f.isWildcard).map((f) => f.subjectId));
  const hasUnconditionalWildcard = found.some((f) => f.isWildcard && f.caveat === undefined);
  const hasAnyWildcard = found.some((f) => f.isWildcard);

  // Soundness: each unconditional concrete returned subject is a definite Member.
  for (const f of found.filter((f) => !f.isWildcard && f.caveat === undefined)) {
    const subject: ObjectAndRelation = {
      objectType: subjectType,
      objectId: f.subjectId,
      relation: subjectRelation,
    };
    const { verdict } = await ctx.check.checkOnr(ctx.reader, resource, subject);
    assertTrue(
      verdict === "member",
      `LookupSubjects returned unconditional ${formatObjectAndRelation(subject)} for ` +
        `${formatObjectAndRelation(resource)}, but Check says ${verdict}`,
    );
  }

  // An unconditional '*' means "every subject of this type" -> a fresh id must be Member.
  // If there is NO wildcard at all -> a fresh id must be NotMember (absent everywhere).
  const freshSubject: ObjectAndRelation = {
    objectType: subjectType,
    objectId: FRESH_SUBJECT_ID,
    relation: subjectRelation,
  };
  const { verdict: freshVerdict } = await ctx.check.checkOnr(ctx.reader, resource, freshSubject);
  if (hasUnconditionalWildcard) {
    assertTrue(
      freshVerdict === "member",
      `LookupSubjects returned unconditional '*' for ${formatObjectAndRelation(resource)} ` +
        `subjectType ${subjectType}, but Check on a fresh id says ${freshVerdict}`,
    );
  } else if (!hasAnyWildcard) {
    assertTrue(
      freshVerdict === "notMember",
      `LookupSubjects did NOT return '*' for ${formatObjectAndRelation(resource)} ` +
        `subjectType ${subjectType}, but Check on a fresh id says ${freshVerdict}`,
    );
  }

  // Completeness: every concrete id of subjectType NOT returned at all (neither
  // unconditional nor caveated) and not covered by a wildcard must be NotMember.
  for (const candidateId of idsOf(ctx, subjectType)) {
    if (anyFound.has(candidateId) || hasAnyWildcard) {
      // Returned (in some form) or potentially covered by a wildcard: not part of
      // the strict NotMember complement.
      continue;
    }

    const subject: ObjectAndRelation = {
      objectType: subjectType,
      objectId: candidateId,
      relation: subjectRelation,
    };
    const { verdict } = await ctx.check.checkOnr(ctx.reader, resource, subject);
    assertTrue(
      verdict === "notMember",
      `LookupSubjects did NOT return ${formatObjectAndRelation(subject)} for ` +
        `${formatObjectAndRelation(resource)}, but Check says ${verdict}`,
    );
  }

  // Strengthen the unconditional-wildcard case: when '*' is unconditionally present,
  // every concrete id of the type must be a Member under Check.
  if (hasUnconditionalWildcard) {
    for (const candidateId of idsOf(ctx, subjectType)) {
      const subject: ObjectAndRelation = {
        objectType: subjectType,
        objectId: candidateId,
        relation: subjectRelation,
      };
      const { verdict } = await ctx.check.checkOnr(ctx.reader, resource, subject);
      assertTrue(
        verdict === "member",
        `LookupSubjects returned unconditional '*' (covering ${formatObjectAndRelation(subject)}) ` +
          `for ${formatObjectAndRelation(resource)}, but Check says ${verdict}`,
      );
    }
  }
}

// --- Expand tree flattening (interpret union/intersection/exclusion structurally) ---

/**
 * The port's stand-in for `IReadOnlySet<ObjectAndRelation>`: ONRs are structural objects, so a
 * `Set` would compare them by reference where C# record equality compares by value. Keys are
 * `objectAndRelationKey`; the values are kept so callers can recover the ONR itself.
 */
type OnrSet = Map<string, ObjectAndRelation>;

function flattenTerminalSubjects(node: PermissionTreeNode): OnrSet {
  switch (node.kind) {
    case "leaf": {
      const set: OnrSet = new Map();
      for (const s of node.subjects) {
        if (isTerminal(s.subject)) {
          set.set(objectAndRelationKey(s.subject), s.subject);
        }
      }
      return set;
    }
    case "setOp":
      return flattenSetOp(node);
    default:
      return assertNeverEmpty(node);
  }
}

function flattenSetOp(setOp: PermissionTreeSetOp): OnrSet {
  const children = setOp.children.map(flattenTerminalSubjects);
  const first = children[0];
  if (first === undefined) {
    return new Map();
  }

  switch (setOp.operation) {
    case "union": {
      const acc: OnrSet = new Map();
      for (const c of children) {
        for (const [key, onr] of c) {
          acc.set(key, onr);
        }
      }
      return acc;
    }
    case "intersection": {
      let acc: OnrSet = new Map(first);
      for (const c of children.slice(1)) {
        const kept: OnrSet = new Map();
        for (const [key, onr] of acc) {
          if (c.has(key)) {
            kept.set(key, onr);
          }
        }
        acc = kept;
      }
      return acc;
    }
    case "exclusion": {
      const acc: OnrSet = new Map(first);
      for (const c of children.slice(1)) {
        for (const key of c.keys()) {
          acc.delete(key);
        }
      }
      return acc;
    }
    default:
      return assertNeverEmpty(setOp.operation);
  }
}

function isTerminal(onr: ObjectAndRelation): boolean {
  return onr.relation === ELLIPSIS || isPublicWildcard(onr);
}

/**
 * Collects every terminal subject ONR that appears anywhere in the tree carrying a caveat (either
 * on its `DirectSubject` or on an enclosing node), so the Expand soundness check can exempt
 * conditional subjects.
 */
function collectCaveatedSubjects(node: PermissionTreeNode): OnrSet {
  const set: OnrSet = new Map();

  const walk = (n: PermissionTreeNode, underCaveat: boolean): void => {
    const nowUnderCaveat = underCaveat || n.caveat !== undefined;
    switch (n.kind) {
      case "leaf":
        for (const s of n.subjects) {
          if (!isTerminal(s.subject)) {
            continue;
          }
          if (nowUnderCaveat || s.caveat !== undefined) {
            set.set(objectAndRelationKey(s.subject), s.subject);
          }
        }
        break;
      case "setOp":
        for (const child of n.children) {
          walk(child, nowUnderCaveat);
        }
        break;
      default:
        assertNeverIgnored(n);
    }
  };

  walk(node, false);
  return set;
}

// --- Corpus loading / universe construction ---

interface CorpusContext {
  readonly fileName: string;
  readonly namespaces: readonly NamespaceDefinition[];
  readonly reader: IDatastoreReader;
  readonly idsByType: ReadonlyMap<string, readonly string[]>;
  readonly terminalSubjectTypes: readonly string[];
  readonly check: CheckEngine;
  readonly lookupSubjects: LookupSubjectsEngine;
  readonly lookupResources: LookupResourcesEngine;
  readonly expand: ExpandEngine;
}

/** The C# `CorpusContext.IdsOf`: the bounded id universe for a type, or empty when unknown. */
function idsOf(ctx: CorpusContext, type: string): readonly string[] {
  return ctx.idsByType.get(type) ?? [];
}

async function loadCorpus(fileName: string): Promise<CorpusContext> {
  const file = loadResolvedValidationFile(join(CORPUS_DIR, fileName));

  const compiled = compileSchema(file.schemaText);

  const store = new ReferenceDatastore();
  const rev = await loadRelationships(store, file.relationships);
  const reader = store.snapshotReader(rev);

  // Universe of object ids per type: every id seen as a resource or a concrete subject,
  // plus a synthetic absent id to exercise the NotMember complement.
  const idsByType = new Map<string, Set<string>>();
  const terminalSubjectTypes = new Set<string>();

  for (const ns of compiled.namespaces) {
    getIds(idsByType, ns.name).add(ABSENT_ID);
  }

  for (const rel of file.relationships) {
    getIds(idsByType, rel.reference.resource.objectType).add(rel.reference.resource.objectId);

    const subj = rel.reference.subject;
    if (!isPublicWildcard(subj)) {
      getIds(idsByType, subj.objectType).add(subj.objectId);
    }

    // Terminal subject types: the types appearing as ellipsis or wildcard subjects.
    if (subj.relation === ELLIPSIS || isPublicWildcard(subj)) {
      terminalSubjectTypes.add(subj.objectType);
    }
  }

  // Fall back to all defined types if the corpus has no terminal subjects, so the
  // cross-check still probes the natural subject types.
  if (terminalSubjectTypes.size === 0) {
    for (const ns of compiled.namespaces) {
      terminalSubjectTypes.add(ns.name);
    }
  }

  // `OrderBy(x => x, StringComparer.Ordinal)` is JavaScript's default sort, which compares UTF-16
  // code units - the same order for this corpus.
  const sortedIdsByType = new Map<string, readonly string[]>();
  for (const [type, ids] of idsByType) {
    sortedIdsByType.set(type, [...ids].sort());
  }

  return {
    fileName,
    namespaces: compiled.namespaces,
    reader,
    idsByType: sortedIdsByType,
    terminalSubjectTypes: [...terminalSubjectTypes].sort(),
    check: new CheckEngine(compiled.namespaces, compiled.caveats),
    lookupSubjects: new LookupSubjectsEngine(compiled.namespaces),
    lookupResources: new LookupResourcesEngine(compiled.namespaces, compiled.caveats),
    expand: new ExpandEngine(compiled.namespaces),
  };
}

function getIds(map: Map<string, Set<string>>, type: string): Set<string> {
  let set = map.get(type);
  if (set === undefined) {
    set = new Set<string>();
    map.set(type, set);
  }

  return set;
}

async function loadRelationships(
  datastore: ReferenceDatastore,
  relationships: readonly Relationship[],
): Promise<IRevision> {
  if (relationships.length === 0) {
    const head = await datastore.headRevision();
    return head.revision;
  }

  const updates: readonly RelationshipUpdate[] = relationships.map((r) => ({
    relationship: r,
    operation: "create",
  }));

  return await datastore.readWriteTx(async (tx) => {
    await tx.writeRelationships(updates);
  });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const list: T[] = [];
  for await (const item of source) {
    list.push(item);
  }

  return list;
}

/** The C# `Assert.True(condition, message)`; vitest carries the message on the assertion. */
function assertTrue(condition: boolean, message: string): void {
  expect(condition, message).toBe(true);
}

/**
 * The exhaustiveness check for the two `switch` expressions whose C# `_ =>` arm RETURNED an empty
 * `HashSet` rather than throwing. Per the port guide, a tolerant default arm keeps its tolerant
 * value: a throwing `assertNever` here would turn an unreachable-but-benign arm into a crash.
 */
function assertNeverEmpty(_value: never): OnrSet {
  return new Map();
}

/**
 * The exhaustiveness check for `collectCaveatedSubjects`'s walk, whose C# `switch` STATEMENT has
 * no `default` at all and so silently ignores anything that is neither a leaf nor a set-op. The
 * helper keeps the compiler's coverage guarantee without inventing a throw the C# does not have.
 */
function assertNeverIgnored(_value: never): void {
  // The C# switch statement falls out of its two cases without acting.
}
