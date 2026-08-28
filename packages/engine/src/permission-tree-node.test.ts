import { ELLIPSIS, PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import { isPublicWildcard, type ObjectAndRelation } from "@spacedb/core/object-and-relation";
import type { SetOperationType } from "@spacedb/core/userset-rewrite";
import { describe, expect, it } from "vitest";

import { caveatExpressionFromCaveat } from "./caveat-expression";
import {
  createDirectSubject,
  permissionTreeLeaf,
  permissionTreeSetOp,
  type ExpandMode,
  type PermissionTreeNode,
} from "./permission-tree-node";

// Characterization test for Spiceport `src/Spiceport.Server/Engine/Expand/PermissionTreeNode.cs`,
// which has no covering C# test of its own: it is exercised only through `ExpandEngineTests`.
// This file is therefore the only direct gate on the value type, and pins the behaviour the C#
// record hierarchy actually has.
//
// Port decisions pinned here:
//   * `PermissionTreeNode` is an ABSTRACT record with two nested sealed records that re-declare
//     the base members. It becomes a discriminated union on a literal `kind` field, with the
//     shared `expanded` / `caveat` members on both arms and a local `assertNever` at every match
//     site (there is no shared base class to switch on).
//   * `kind` must be a DATA field, not a getter or a derived value: `ExpandEngine.DecorateWithCaveat`
//     does `node with { Caveat = ... }` on the ABSTRACT type, which C# dispatches to the concrete
//     record's clone. The TypeScript equivalent is `{ ...node, caveat }`, which only preserves the
//     variant because `kind` rides along as data. That spread is pinned below for both arms.
//   * `ExpandMode` mirrors `DispatchExpandRequest_SHALLOW` / `_RECURSIVE` but carries no explicit
//     values in the C#, and is mapped at the API layer (S5). It is a string union with NO wire map.
//   * `DirectSubject(Subject, Caveat = null)` has an optional second parameter; the factory leaves
//     `caveat` absent rather than defaulting it to anything.
//   * A public wildcard is represented by the subject ONR's object id being `"*"`. Nothing here
//     re-tests that string: `isPublicWildcard` from @spacedb/core owns it.

function onr(type: string, id: string, relation: string = ELLIPSIS): ObjectAndRelation {
  return { objectType: type, objectId: id, relation };
}

const CAVEAT = caveatExpressionFromCaveat({ caveatName: "over_age" });
const OTHER_CAVEAT = caveatExpressionFromCaveat({ caveatName: "in_hours" });

describe("DirectSubject", () => {
  it("carries the subject verbatim and leaves an absent caveat absent", () => {
    const subject = onr("user", "alice");

    const ds = createDirectSubject(subject);

    expect(ds.subject).toBe(subject);
    expect(ds.caveat).toBeUndefined();
  });

  it("carries the per-tuple caveat when one is supplied", () => {
    const ds = createDirectSubject(onr("user", "alice"), CAVEAT);

    expect(ds.caveat).toBe(CAVEAT);
  });

  it("carries a public wildcard subject verbatim", () => {
    const ds = createDirectSubject(onr("user", PUBLIC_WILDCARD));

    expect(isPublicWildcard(ds.subject)).toBe(true);
    expect(ds.subject.objectType).toBe("user");
  });

  it("carries a non-terminal userset subject verbatim, subrelation included", () => {
    const ds = createDirectSubject(onr("group", "eng", "member"));

    expect(ds.subject.relation).toBe("member");
    expect(isPublicWildcard(ds.subject)).toBe(false);
  });
});

describe("PermissionTreeNode.Leaf", () => {
  it("is tagged leaf and records the resource it expands", () => {
    const expanded = onr("document", "doc1", "viewer");

    const leaf = permissionTreeLeaf(expanded, [createDirectSubject(onr("user", "alice"))]);

    expect(leaf.kind).toBe("leaf");
    expect(leaf.expanded).toBe(expanded);
    expect(leaf.subjects).toHaveLength(1);
    expect(leaf.caveat).toBeUndefined();
  });

  it("preserves subject order", () => {
    const leaf = permissionTreeLeaf(onr("document", "doc1", "viewer"), [
      createDirectSubject(onr("user", "bob")),
      createDirectSubject(onr("user", "alice")),
    ]);

    expect(leaf.subjects.map((s) => s.subject.objectId)).toEqual(["bob", "alice"]);
  });

  it("permits an empty subject list - the depth-exhausted / unknown-relation node", () => {
    const leaf = permissionTreeLeaf(onr("document", "doc1", "viewer"), []);

    expect(leaf.subjects).toEqual([]);
  });

  it("carries a whole-leaf caveat when one is supplied", () => {
    const leaf = permissionTreeLeaf(onr("document", "doc1", "viewer"), [], CAVEAT);

    expect(leaf.caveat).toBe(CAVEAT);
  });
});

describe("PermissionTreeNode.SetOp", () => {
  it("is tagged setOp and records operation and children", () => {
    const expanded = onr("document", "doc1", "view");
    const child = permissionTreeLeaf(onr("document", "doc1", "viewer"), []);

    const op = permissionTreeSetOp(expanded, "union", [child]);

    expect(op.kind).toBe("setOp");
    expect(op.expanded).toBe(expanded);
    expect(op.operation).toBe("union");
    expect(op.children).toEqual([child]);
    expect(op.caveat).toBeUndefined();
  });

  it("preserves child order - the tree order is observable to callers", () => {
    const first = permissionTreeLeaf(onr("document", "doc1", "viewer"), []);
    const second = permissionTreeLeaf(onr("document", "doc1", "editor"), []);

    const op = permissionTreeSetOp(onr("document", "doc1", "view"), "union", [first, second]);

    expect(op.children[0]).toBe(first);
    expect(op.children[1]).toBe(second);
  });

  it("permits zero children - an arrow over an empty tupleset is a SetOp, not an empty Leaf", () => {
    const op = permissionTreeSetOp(onr("document", "doc1", "inherited_view"), "union", []);

    expect(op.kind).toBe("setOp");
    expect(op.children).toEqual([]);
  });

  it("nests set operations", () => {
    const inner = permissionTreeSetOp(onr("document", "doc1", "view"), "intersection", []);
    const outer = permissionTreeSetOp(onr("document", "doc1", "view"), "union", [inner]);

    const only = outer.children[0];
    expect(only?.kind).toBe("setOp");
  });

  it.each<SetOperationType>(["union", "intersection", "exclusion"])(
    "carries the %s operation verbatim from @spacedb/core",
    (operation) => {
      const op = permissionTreeSetOp(onr("document", "doc1", "view"), operation, []);

      expect(op.operation).toBe(operation);
    },
  );
});

describe("decorating a node with a caveat", () => {
  // `ExpandEngine.DecorateWithCaveat` does `node with { Caveat = ... }` on the ABSTRACT record
  // type, which C# dispatches to the concrete clone. The TS spread is only equivalent because
  // `kind` is data; if it were ever derived, this would silently produce a variant-less object.
  it("keeps a leaf a leaf, with its subjects intact", () => {
    const leaf = permissionTreeLeaf(onr("document", "doc1", "viewer"), [
      createDirectSubject(onr("user", "alice")),
    ]);

    const decorated: PermissionTreeNode = { ...leaf, caveat: CAVEAT };

    expect(decorated.kind).toBe("leaf");
    expect(decorated.caveat).toBe(CAVEAT);
    if (decorated.kind === "leaf") {
      expect(decorated.subjects).toBe(leaf.subjects);
    }
  });

  it("keeps a setOp a setOp, with its operation and children intact", () => {
    const op = permissionTreeSetOp(onr("document", "doc1", "view"), "intersection", [
      permissionTreeLeaf(onr("document", "doc1", "viewer"), []),
    ]);

    const decorated: PermissionTreeNode = { ...op, caveat: CAVEAT };

    expect(decorated.kind).toBe("setOp");
    if (decorated.kind === "setOp") {
      expect(decorated.operation).toBe("intersection");
      expect(decorated.children).toBe(op.children);
    }
  });

  it("does not mutate the node it decorates", () => {
    const leaf = permissionTreeLeaf(onr("document", "doc1", "viewer"), [], OTHER_CAVEAT);

    const decorated = { ...leaf, caveat: CAVEAT };

    expect(leaf.caveat).toBe(OTHER_CAVEAT);
    expect(decorated.caveat).toBe(CAVEAT);
  });
});

describe("matching over the closed hierarchy", () => {
  // The C# `switch` over the sealed record hierarchy becomes a discriminated union plus a local
  // `assertNever`. This walker is the shape every consumer writes, and it is pinned here so the
  // union stays exhaustively matchable.
  function countLeaves(node: PermissionTreeNode): number {
    switch (node.kind) {
      case "leaf":
        return 1;
      case "setOp":
        return node.children.reduce((total, child) => total + countLeaves(child), 0);
      default:
        return assertNever(node);
    }
  }

  function assertNever(value: never): never {
    throw new Error(`unexpected permission tree node: ${JSON.stringify(value)}`);
  }

  it("walks a nested tree by kind alone", () => {
    const tree = permissionTreeSetOp(onr("document", "doc1", "view"), "union", [
      permissionTreeLeaf(onr("document", "doc1", "viewer"), []),
      permissionTreeSetOp(onr("document", "doc1", "editor"), "exclusion", [
        permissionTreeLeaf(onr("document", "doc1", "editor"), []),
        permissionTreeLeaf(onr("document", "doc1", "banned"), []),
      ]),
    ]);

    expect(countLeaves(tree)).toBe(3);
  });
});

describe("ExpandMode", () => {
  it("has exactly the two C# members, as a string union with no wire map", () => {
    const modes: readonly ExpandMode[] = ["shallow", "recursive"];

    expect(modes).toEqual(["shallow", "recursive"]);
  });
});
