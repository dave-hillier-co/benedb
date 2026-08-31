import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { ELLIPSIS } from "@benedb/core/core-constants";
import {
  allowedRelationDirect,
  allowedRelationWildcard,
  type AllowedRelation,
} from "@benedb/core/allowed-relation";
import { createNamespaceDefinition } from "@benedb/core/namespace-definition";
import { baseRelation, permission, type Relation } from "@benedb/core/relation";
import {
  computedUsersetOnResource,
  setOperationExclusion,
  setOperationIntersection,
  setOperationUnion,
  type SetOperationChild,
} from "@benedb/core/userset-rewrite";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { compileSchema } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { createReachabilityEntrypoint } from "./reachability-entrypoint";
import { buildReachabilityGraph, type ReachabilityMode } from "./reachability-graph";
import type { RelationReference } from "./relation-reference";

// Characterization of Spiceport `Engine/Reachability/ReachabilityGraph.cs`. NO C# test covers it
// directly - it is exercised only through `LookupResourcesEngineTests` and, three stages up, the
// schema-introspection RPCs. That makes it the file a wrong port breaks SILENTLY: a missing
// entrypoint yields fewer LookupResources results, not an error. So this suite pins the shape of
// the entrypoints the builder emits, not just their count.
//
// Port decisions and traps pinned here:
//
//   * `Dictionary<RelationReference, ...>` with a RECORD key. A JS `Map` keyed by the object
//     would miss every lookup, so the indices are keyed by the canonical string from
//     `relation-reference.ts` with the reference value kept alongside (`targets` must hand back
//     the objects, not the keys).
//
//   * `Targets => _byTarget.Keys`. .NET's dictionary order is unspecified; a JS `Map` is
//     insertion-ordered. The tests below therefore assert the target SET (sorted here for
//     legibility), never the raw enumeration order - matching what the C# could actually
//     promise. What must never be removed is the ordinal sort inside `Project` at the
//     introspection layer, which is what makes the difference benign there.
//
//   * The `Collect` recursion iterates the by-subject-relation keys filtered to non-ellipsis and
//     ORDERED ORDINALLY by (namespace, relation). That sort exists precisely because the C#
//     dictionary order was unstable, and it is observable: it decides which entrypoint arrives
//     first, which is what `optimizedFirstOnly` returns. Pinned below.
//
//   * `AddAll`'s dedup key. In the C# it is
//     `$"{(int)Kind}|{ns}#{rel}|{computed}|{tupleset}|{(int)status}"`, where a null computed or
//     tupleset relation interpolates as the EMPTY STRING - so null and "" would collide. The port
//     length-prefixes instead. The divergence is unobservable in practice: the kind is part of
//     the key, and each kind populates a fixed set of slots, so no two entrypoints on one target
//     can differ only by null-versus-empty. It is recorded rather than tested because a test for
//     it would have to construct a graph the builder cannot produce.
//
//   * `ReachabilityMode` is not wire-visible, so it is a string union.
//
//   * `Build()` runs in a private constructor behind a static entry point, which is the guide's
//     "private ctor + static entry point" row: a module-private class plus one exported
//     `buildReachabilityGraph` factory.

function namespacesOf(schemaText: string): ReadonlyMap<string, NamespaceDefinition> {
  const compiled = compileSchema(schemaText);
  return new Map(compiled.namespaces.map((ns) => [ns.name, ns]));
}

function namespacesFrom(
  ...definitions: readonly NamespaceDefinition[]
): ReadonlyMap<string, NamespaceDefinition> {
  return new Map(definitions.map((ns) => [ns.name, ns]));
}

function ref(namespace: string, relation: string): RelationReference {
  return { namespace, relation };
}

function labels(references: readonly RelationReference[]): readonly string[] {
  return references.map((r) => `${r.namespace}#${r.relation}`).sort();
}

function targetLabels(entrypoints: readonly { targetRelation: RelationReference }[]): string[] {
  return entrypoints.map((e) => `${e.targetRelation.namespace}#${e.targetRelation.relation}`);
}

function relationEntrypoint(namespace: string, relation: string) {
  const target = ref(namespace, relation);
  return createReachabilityEntrypoint({
    kind: "relation",
    targetRelation: target,
    containingRelation: target,
    resultStatus: "directResult",
  });
}

const DOCUMENT_SCHEMA = `
  definition user {}
  definition group {
      relation member: user | group#member
  }
  definition document {
      relation viewer: user | group#member
      relation parent: document
      permission view = viewer + parent->view
  }
`;

describe("buildReachabilityGraph", () => {
  it("rejects a null namespace map", () => {
    // `ArgumentNullException.ThrowIfNull(namespaces)`; the guard survives the port because the
    // callers reaching this from the grain boundary are untyped.
    expect(() => buildReachabilityGraph(undefined as never)).toThrow(InvalidArgumentError);
  });

  it("holds one target per relation and permission, and none for a relationless definition", () => {
    const graph = buildReachabilityGraph(namespacesOf(DOCUMENT_SCHEMA));

    expect(labels(graph.targets)).toEqual([
      "document#parent",
      "document#view",
      "document#viewer",
      "group#member",
    ]);
  });

  it("returns the target references themselves, not just their keys", () => {
    const graph = buildReachabilityGraph(namespacesOf(DOCUMENT_SCHEMA));

    for (const target of graph.targets) {
      expect(typeof target.namespace).toBe("string");
      expect(typeof target.relation).toBe("string");
    }
  });
});

describe("entrypointsForSubjectToResource", () => {
  it("finds the base-relation entrypoints a direct subject reaches a permission through", () => {
    const graph = buildReachabilityGraph(namespacesOf(DOCUMENT_SCHEMA));

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("user", ELLIPSIS),
      ref("document", "view"),
    );

    // document#view holds no entrypoint keyed on `user#...` itself; the walk descends through the
    // by-subject-relation keys (document#view, document#viewer, ordinally) and collects the
    // Relation entrypoints of document#viewer and, transitively, of group#member.
    expect(entrypoints).toEqual([
      relationEntrypoint("document", "viewer"),
      relationEntrypoint("group", "member"),
    ]);
  });

  it("finds the entrypoints a subject-relation subject reaches a permission through", () => {
    const graph = buildReachabilityGraph(namespacesOf(DOCUMENT_SCHEMA));

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("group", "member"),
      ref("document", "view"),
    );

    expect(entrypoints).toEqual([
      relationEntrypoint("document", "viewer"),
      relationEntrypoint("group", "member"),
    ]);
  });

  it("emits a computed-userset entrypoint for a permission's direct reference", () => {
    const graph = buildReachabilityGraph(namespacesOf(DOCUMENT_SCHEMA));

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("document", "viewer"),
      ref("document", "view"),
    );

    expect(entrypoints).toEqual([
      createReachabilityEntrypoint({
        kind: "computedUserset",
        targetRelation: ref("document", "view"),
        containingRelation: ref("document", "view"),
        computedUsersetRelation: "viewer",
        resultStatus: "directResult",
      }),
    ]);
  });

  it("emits a tuple-to-userset entrypoint keyed by (allowed type, computed relation)", () => {
    const graph = buildReachabilityGraph(namespacesOf(DOCUMENT_SCHEMA));

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("document", "view"),
      ref("document", "view"),
    );

    expect(entrypoints).toEqual([
      createReachabilityEntrypoint({
        kind: "tupleToUserset",
        targetRelation: ref("document", "view"),
        containingRelation: ref("document", "view"),
        computedUsersetRelation: "view",
        tuplesetRelation: "parent",
        resultStatus: "directResult",
      }),
    ]);
  });

  it("returns nothing for an unknown resource", () => {
    const graph = buildReachabilityGraph(namespacesOf(DOCUMENT_SCHEMA));

    expect(
      graph.entrypointsForSubjectToResource(ref("user", ELLIPSIS), ref("nope", "nothing")),
    ).toEqual([]);
  });

  it("returns nothing for a subject that cannot reach the resource", () => {
    const graph = buildReachabilityGraph(namespacesOf(DOCUMENT_SCHEMA));

    expect(
      graph.entrypointsForSubjectToResource(ref("document", "parent"), ref("group", "member")),
    ).toEqual([]);
  });

  it("terminates on a self-referential relation", () => {
    // group#member allows group#member, so the walk would loop without the `visited` guard.
    const graph = buildReachabilityGraph(namespacesOf(DOCUMENT_SCHEMA));

    expect(
      graph.entrypointsForSubjectToResource(ref("user", ELLIPSIS), ref("group", "member")),
    ).toEqual([relationEntrypoint("group", "member")]);
  });

  it("matches a wildcard allowed type on the subject's namespace alone", () => {
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user { relation member: user }
        definition document { relation viewer: user:* }
      `),
    );

    const expected = [relationEntrypoint("document", "viewer")];
    // A wildcard is indexed by subject TYPE, so the subject's own relation is irrelevant.
    expect(
      graph.entrypointsForSubjectToResource(ref("user", ELLIPSIS), ref("document", "viewer")),
    ).toEqual(expected);
    expect(
      graph.entrypointsForSubjectToResource(ref("user", "member"), ref("document", "viewer")),
    ).toEqual(expected);
  });

  it("dedupes entrypoints that differ only by which allowed type produced them", () => {
    // Two allowed types with the same identity-free shape produce two structurally identical
    // Relation entrypoints in one bucket; `AddAll`'s key collapses them to one.
    const duplicated: AllowedRelation[] = [
      allowedRelationDirect("user"),
      allowedRelationDirect("user"),
    ];
    const graph = buildReachabilityGraph(
      namespacesFrom(
        createNamespaceDefinition("user"),
        createNamespaceDefinition("document", baseRelation("viewer", ...duplicated)),
      ),
    );

    expect(
      graph.entrypointsForSubjectToResource(ref("user", ELLIPSIS), ref("document", "viewer")),
    ).toEqual([relationEntrypoint("document", "viewer")]);
  });

  it("walks the by-subject-relation keys in ordinal (namespace, relation) order", () => {
    // `banned` sorts before `viewer`, so the exclusion's second operand is collected first. The
    // C# sorts explicitly because .NET dictionary order was unstable; the order is observable and
    // must not be dropped just because a JS Map is already stable.
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user {}
        definition document {
            relation viewer: user
            relation banned: user
            permission view = viewer - banned
        }
      `),
    );

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("user", ELLIPSIS),
      ref("document", "view"),
    );

    expect(targetLabels(entrypoints)).toEqual(["document#banned", "document#viewer"]);
  });

  it("stops at the first entrypoint when optimizedFirstOnly is set", () => {
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user {}
        definition document {
            relation viewer: user
            relation banned: user
            permission view = viewer - banned
        }
      `),
    );

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("user", ELLIPSIS),
      ref("document", "view"),
      true,
    );

    expect(targetLabels(entrypoints)).toEqual(["document#banned"]);
  });
});

describe("result status", () => {
  it("marks a pure union's children direct", () => {
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user {}
        definition document {
            relation viewer: user
            relation editor: user
            permission view = viewer + editor
        }
      `),
    );

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("document", "viewer"),
      ref("document", "view"),
    );

    expect(entrypoints.map((e) => e.resultStatus)).toEqual(["directResult"]);
  });

  it("marks an intersection's children conditional", () => {
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user {}
        definition document {
            relation viewer: user
            relation editor: user
            permission view = viewer & editor
        }
      `),
    );

    for (const relation of ["viewer", "editor"]) {
      const entrypoints = graph.entrypointsForSubjectToResource(
        ref("document", relation),
        ref("document", "view"),
      );
      expect(entrypoints.map((e) => e.resultStatus)).toEqual(["conditionalResult"]);
    }
  });

  it("marks an exclusion's children conditional", () => {
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user {}
        definition document {
            relation viewer: user
            relation banned: user
            permission view = viewer - banned
        }
      `),
    );

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("document", "viewer"),
      ref("document", "view"),
    );

    expect(entrypoints.map((e) => e.resultStatus)).toEqual(["conditionalResult"]);
  });

  it("keeps a nested rewrite's own operator deciding its children's status", () => {
    // The outer union passes DirectResult down into the nested rewrite; the nested INTERSECTION
    // then downgrades its own children. `WalkRewrite` recurses into a nested rewrite WITHOUT
    // visiting it, so the nested node itself never becomes an entrypoint.
    const nested: SetOperationChild = {
      kind: "nestedRewrite",
      value: {
        operation: setOperationIntersection(
          { kind: "computedUserset", value: computedUsersetOnResource("viewer") },
          { kind: "computedUserset", value: computedUsersetOnResource("editor") },
        ),
      },
    };
    const relations: Relation[] = [
      baseRelation("viewer", allowedRelationDirect("user")),
      baseRelation("editor", allowedRelationDirect("user")),
      permission("view", { operation: setOperationUnion(nested) }),
    ];
    const graph = buildReachabilityGraph(
      namespacesFrom(
        createNamespaceDefinition("user"),
        createNamespaceDefinition("document", ...relations),
      ),
    );

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("document", "viewer"),
      ref("document", "view"),
    );

    expect(entrypoints).toEqual([
      createReachabilityEntrypoint({
        kind: "computedUserset",
        targetRelation: ref("document", "view"),
        containingRelation: ref("document", "view"),
        computedUsersetRelation: "viewer",
        resultStatus: "conditionalResult",
      }),
    ]);
  });

  it("forces an all() arrow conditional even under a pure union", () => {
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user {}
        definition document {
            relation parent: document
            relation viewer: user
            permission view = parent.all(view)
        }
      `),
    );

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("document", "view"),
      ref("document", "view"),
    );

    expect(entrypoints).toEqual([
      createReachabilityEntrypoint({
        kind: "tupleToUserset",
        targetRelation: ref("document", "view"),
        containingRelation: ref("document", "view"),
        computedUsersetRelation: "view",
        tuplesetRelation: "parent",
        resultStatus: "conditionalResult",
      }),
    ]);
  });

  it("leaves an any() arrow's inherited status alone", () => {
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user {}
        definition document {
            relation parent: document
            relation viewer: user
            permission view = parent.any(view)
        }
      `),
    );

    const entrypoints = graph.entrypointsForSubjectToResource(
      ref("document", "view"),
      ref("document", "view"),
    );

    expect(entrypoints.map((e) => e.resultStatus)).toEqual(["directResult"]);
  });
});

describe("arrow entrypoints", () => {
  it("skips an allowed type that does not have the computed relation", () => {
    // `AddTtu`'s HasRelation guard: `user` has no `view`, so only the folder link is productive.
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user {}
        definition folder {
            relation viewer: user
            permission view = viewer
        }
        definition document {
            relation parent: folder | user
            permission view = parent->view
        }
      `),
    );

    expect(
      graph.entrypointsForSubjectToResource(ref("folder", "view"), ref("document", "view")),
    ).toEqual([
      createReachabilityEntrypoint({
        kind: "tupleToUserset",
        targetRelation: ref("document", "view"),
        containingRelation: ref("document", "view"),
        computedUsersetRelation: "view",
        tuplesetRelation: "parent",
        resultStatus: "directResult",
      }),
    ]);
    // The `user` link produced no arrow entrypoint at all: nothing is keyed under (user, view).
    // (A `user` subject still reaches document#view through folder#viewer's own base relation,
    // which is a different edge and not what this guard is about.)
    expect(
      graph.entrypointsForSubjectToResource(ref("user", "view"), ref("document", "view")),
    ).toEqual([]);
  });

  it("skips a wildcard allowed type on the tupleset relation", () => {
    // A wildcard tupleset link is not productive for an arrow. With `folder:*` as the ONLY
    // allowed type of `parent`, the arrow yields no entrypoint whatsoever - which is the only way
    // the skip is observable, since a wildcard and a concrete link of the same object type would
    // otherwise land on the identical index key and dedupe.
    const graph = buildReachabilityGraph(
      namespacesFrom(
        createNamespaceDefinition("user"),
        createNamespaceDefinition(
          "folder",
          baseRelation("viewer", allowedRelationDirect("user")),
          permission("view", {
            operation: setOperationUnion({
              kind: "computedUserset",
              value: computedUsersetOnResource("viewer"),
            }),
          }),
        ),
        createNamespaceDefinition(
          "document",
          baseRelation("parent", allowedRelationWildcard("folder")),
          permission("view", {
            operation: setOperationUnion({
              kind: "tupleToUserset",
              value: {
                tuplesetRelation: "parent",
                computedUserset: computedUsersetOnResource("view"),
              },
            }),
          }),
        ),
      ),
    );

    expect(labels(graph.targets)).toContain("document#view");
    expect(
      graph.entrypointsForSubjectToResource(ref("folder", "view"), ref("document", "view")),
    ).toEqual([]);
  });

  it("emits nothing for an arrow over an unknown or rewrite-only tupleset relation", () => {
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user {}
        definition document {
            relation viewer: user
            permission alias = viewer
            permission view = alias->view
        }
      `),
    );

    // `alias` is a permission: it has a rewrite and no type information, so `AddTtu` bails.
    expect(
      graph.entrypointsForSubjectToResource(ref("document", "view"), ref("document", "view")),
    ).toEqual([]);
  });
});

describe("operand-free rewrite children", () => {
  it("emits a self entrypoint keyed on the definition's ellipsis subject", () => {
    const graph = buildReachabilityGraph(
      namespacesFrom(
        createNamespaceDefinition(
          "document",
          permission("view", { operation: setOperationUnion({ kind: "self" }) }),
        ),
      ),
    );

    expect(
      graph.entrypointsForSubjectToResource(ref("document", ELLIPSIS), ref("document", "view")),
    ).toEqual([
      createReachabilityEntrypoint({
        kind: "self",
        targetRelation: ref("document", "view"),
        containingRelation: ref("document", "view"),
        resultStatus: "directResult",
      }),
    ]);
  });

  it("emits no entrypoint for nil or this", () => {
    // `this` is documented as invalid in a compiled rewrite and, like `nil`, falls through the
    // default branch producing nothing.
    const graph = buildReachabilityGraph(
      namespacesFrom(
        createNamespaceDefinition(
          "document",
          permission("nothing", {
            operation: setOperationUnion({ kind: "nil" }, { kind: "this" }),
          }),
        ),
      ),
    );

    expect(labels(graph.targets)).toEqual(["document#nothing"]);
    expect(
      graph.entrypointsForSubjectToResource(ref("document", ELLIPSIS), ref("document", "nothing")),
    ).toEqual([]);
  });
});

describe("reachability mode", () => {
  const SCHEMA = `
    definition user {}
    definition document {
        relation viewer: user
        relation banned: user
        permission view = viewer - banned
    }
  `;

  function reachedTargets(mode: ReachabilityMode): string[] {
    const graph = buildReachabilityGraph(namespacesOf(SCHEMA), mode);
    return targetLabels(
      graph.entrypointsForSubjectToResource(ref("user", ELLIPSIS), ref("document", "view")),
    );
  }

  it("defaults to full, where every operand of an exclusion contributes", () => {
    const graph = buildReachabilityGraph(namespacesOf(SCHEMA));
    expect(
      targetLabels(
        graph.entrypointsForSubjectToResource(ref("user", ELLIPSIS), ref("document", "view")),
      ),
    ).toEqual(["document#banned", "document#viewer"]);
    expect(reachedTargets("full")).toEqual(["document#banned", "document#viewer"]);
  });

  it("takes only the first operand of a non-union in first mode", () => {
    expect(reachedTargets("first")).toEqual(["document#viewer"]);
  });

  it("still takes every operand of a union in first mode", () => {
    const graph = buildReachabilityGraph(
      namespacesOf(`
        definition user {}
        definition document {
            relation viewer: user
            relation editor: user
            permission view = viewer + editor
        }
      `),
      "first",
    );

    expect(
      targetLabels(
        graph.entrypointsForSubjectToResource(ref("user", ELLIPSIS), ref("document", "view")),
      ),
    ).toEqual(["document#editor", "document#viewer"]);
  });

  it("emits nothing for a childless non-union in first mode", () => {
    // `operation.Children.Count > 0` guards the `[Children[0]]` slice; with
    // `noUncheckedIndexedAccess` that index is `T | undefined` and must be handled.
    const graph = buildReachabilityGraph(
      namespacesFrom(
        createNamespaceDefinition(
          "document",
          permission("view", { operation: setOperationExclusion() }),
        ),
      ),
      "first",
    );

    expect(labels(graph.targets)).toEqual(["document#view"]);
    expect(
      graph.entrypointsForSubjectToResource(ref("document", ELLIPSIS), ref("document", "view")),
    ).toEqual([]);
  });
});
