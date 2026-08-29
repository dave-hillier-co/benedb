import {
  allowedRelationDirect,
  allowedRelationWildcard,
  type AllowedRelation,
} from "@spacedb/core/allowed-relation";
import type { CaveatDefinition, CaveatTypeReference } from "@spacedb/core/caveat-definition";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import type { Relation } from "@spacedb/core/relation";
import {
  setOperationUnion,
  type SetOperationChild,
  type UsersetRewrite,
} from "@spacedb/core/userset-rewrite";
import type { CompiledSchema } from "@spacedb/schema/compiled-schema";
import { describe, expect, it } from "vitest";

import { computeSchemaDiff, rewriteEquals, sameAllowedType, type SchemaDelta } from "./schema-diff";

/**
 * No covering C# test - a characterization of `Grains/SchemaDiff.cs`.
 *
 * THE DELTA ORDER IS THE CONTRACT, not a bag. `SchemaChangeValidator` derives its check list in
 * `Compute()` order and the FIRST failing check throws, so reordering two individually-correct
 * emissions changes which rejection message a user sees. Every ordering assertion below therefore
 * compares the WHOLE list, in order, rather than asserting containment.
 *
 * The order the C# fixes:
 *   Compute            -> DiffDefinitions, then DiffCaveats.
 *   DiffDefinitions    -> every DefinitionAdded (iterating next.Namespaces), then per existing
 *                         definition either DefinitionRemoved or DiffRelations.
 *   DiffRelations      -> every added (iterating nextDef.Relations), then the per-existing pass.
 *   DiffCaveats        -> every CaveatAdded, then per existing caveat CaveatRemoved, or
 *                         (CaveatExprChanged then DiffCaveatParameters).
 *   DiffCaveatParams   -> every added, then removed / type-changed.
 * There is NO sorting anywhere in the file: order is source/collection order, and `ToDictionary`
 * is only a membership index - the iteration is always over the LIST.
 *
 * KNOWN, DELIBERATE DIVERGENCE (parameter type comparison): the C# `nextType != existingType` is
 * record equality, and `CaveatTypeReference.ChildTypes` is an `ImmutableList` whose `Equals` is
 * REFERENCE-based, so C# reports two separately-compiled but structurally identical NESTED
 * generic types as CHANGED. The port uses core's structural `caveatTypeReferenceEquals`, which
 * only ever removes spurious rejections and never adds one. Pinned below.
 *
 * KNOWN ORDER DIVERGENCE (multi-parameter caveats): `ParameterTypes` is an `ImmutableDictionary`
 * in C# (HASH enumeration order) and a `Map` here (INSERTION order). For a caveat with more than
 * one changed parameter the deltas therefore come out in a different order from C#, and since the
 * validator throws on the first failing check the rejection MESSAGE can differ. That is accepted;
 * reproducing .NET hash order is not attempted. The tests below use insertion order.
 */

function ns(name: string, ...relations: Relation[]): NamespaceDefinition {
  return { name, relations };
}

function rel(name: string, ...allowed: AllowedRelation[]): Relation {
  return { name, typeInformation: { allowedDirectRelations: allowed } };
}

/** A base relation with NO TypeInformation at all - distinct from one with an empty list. */
function untypedRel(name: string): Relation {
  return { name };
}

function perm(name: string, ...children: SetOperationChild[]): Relation {
  return { name, usersetRewrite: { operation: setOperationUnion(...children) } };
}

function cu(relation: string): SetOperationChild {
  return { kind: "computedUserset", value: { object: "tupleObject", relation } };
}

function schema(
  namespaces: readonly NamespaceDefinition[],
  caveats: readonly CaveatDefinition[] = [],
): CompiledSchema {
  return { namespaces, caveats };
}

function caveat(
  name: string,
  expression: string,
  parameters: readonly (readonly [string, CaveatTypeReference])[] = [],
): CaveatDefinition {
  return {
    name,
    serializedExpression: new TextEncoder().encode(expression),
    parameterTypes: new Map(parameters),
  };
}

const EMPTY = schema([]);

describe("computeSchemaDiff argument guards", () => {
  it("rejects a null/undefined schema on either side", () => {
    // The two `ArgumentNullException.ThrowIfNull` guards at the top of Compute.
    expect(() => computeSchemaDiff(undefined as unknown as CompiledSchema, EMPTY)).toThrow(
      InvalidArgumentError,
    );
    expect(() => computeSchemaDiff(EMPTY, undefined as unknown as CompiledSchema)).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("computeSchemaDiff on identical schemas", () => {
  it("returns an empty list", () => {
    const s = schema(
      [
        ns("user"),
        ns("document", rel("viewer", allowedRelationDirect("user")), perm("view", cu("viewer"))),
      ],
      [caveat("c", "a > 1", [["a", { typeName: "int" }]])],
    );

    expect(computeSchemaDiff(s, s)).toEqual([]);
  });

  it("returns an empty list for two empty schemas", () => {
    expect(computeSchemaDiff(EMPTY, EMPTY)).toEqual([]);
  });

  it("treats structurally equal but separately built schemas as unchanged", () => {
    // Nothing in the diff relies on object identity: the whole file is a structural compare.
    const build = (): CompiledSchema =>
      schema(
        [ns("document", rel("viewer", allowedRelationDirect("user")), perm("view", cu("viewer")))],
        [caveat("c", "a > 1", [["a", { typeName: "list", childTypes: [{ typeName: "int" }] }]])],
      );

    expect(computeSchemaDiff(build(), build())).toEqual([]);
  });
});

describe("computeSchemaDiff definition-level deltas", () => {
  it("emits DefinitionAdded carrying the NEXT definition", () => {
    const next = ns("user");

    expect(computeSchemaDiff(EMPTY, schema([next]))).toEqual([
      { kind: "definitionAdded", definition: next } satisfies SchemaDelta,
    ]);
  });

  it("emits DefinitionRemoved carrying the EXISTING definition", () => {
    const existing = ns("user");

    expect(computeSchemaDiff(schema([existing]), EMPTY)).toEqual([
      { kind: "definitionRemoved", definition: existing } satisfies SchemaDelta,
    ]);
  });

  it("emits ALL adds before ANY removal", () => {
    // Two separate loops in DiffDefinitions, adds first. A single interleaved pass would emit
    // removed-then-added here.
    const gone = ns("gone");
    const fresh1 = ns("fresh1");
    const fresh2 = ns("fresh2");

    expect(computeSchemaDiff(schema([gone]), schema([fresh1, fresh2]))).toEqual([
      { kind: "definitionAdded", definition: fresh1 },
      { kind: "definitionAdded", definition: fresh2 },
      { kind: "definitionRemoved", definition: gone },
    ]);
  });

  it("emits adds in NEXT's list order and removals in EXISTING's list order", () => {
    // `foreach (var nextDef in next.Namespaces)` / `foreach (var existingDef in ...)` - the
    // dictionaries are membership indexes only, so declaration order is preserved.
    const b = ns("b");
    const a = ns("a");
    const z = ns("z");
    const y = ns("y");

    expect(computeSchemaDiff(schema([z, y]), schema([b, a]))).toEqual([
      { kind: "definitionAdded", definition: b },
      { kind: "definitionAdded", definition: a },
      { kind: "definitionRemoved", definition: z },
      { kind: "definitionRemoved", definition: y },
    ]);
  });

  it("does not descend into a removed definition", () => {
    // `deltas.Add(DefinitionRemoved); continue;` - no per-relation deltas follow.
    const existing = ns(
      "document",
      rel("viewer", allowedRelationDirect("user")),
      perm("view", cu("viewer")),
    );

    expect(computeSchemaDiff(schema([existing]), EMPTY)).toEqual([
      { kind: "definitionRemoved", definition: existing },
    ]);
  });

  it("does not descend into an added definition", () => {
    const next = ns(
      "document",
      rel("viewer", allowedRelationDirect("user")),
      perm("view", cu("viewer")),
    );

    expect(computeSchemaDiff(EMPTY, schema([next]))).toEqual([
      { kind: "definitionAdded", definition: next },
    ]);
  });
});

describe("computeSchemaDiff relation-level deltas", () => {
  it("emits RelationAdded with the next definition's name", () => {
    // `new SchemaDelta.RelationAdded(nextDef.Name, nextRel)`.
    const added = rel("editor", allowedRelationDirect("user"));

    expect(computeSchemaDiff(schema([ns("document")]), schema([ns("document", added)]))).toEqual([
      { kind: "relationAdded", definitionName: "document", relation: added },
    ]);
  });

  it("emits PermissionAdded for an added relation that has a rewrite", () => {
    // `nextRel.IsPermission ? PermissionAdded : RelationAdded` - a permission is exactly a
    // relation with a userset rewrite.
    const added = perm("view", cu("viewer"));

    expect(computeSchemaDiff(schema([ns("document")]), schema([ns("document", added)]))).toEqual([
      { kind: "permissionAdded", definitionName: "document", permission: added },
    ]);
  });

  it("emits RelationRemoved / PermissionRemoved with the EXISTING definition's name", () => {
    const goneRel = rel("editor", allowedRelationDirect("user"));
    const gonePerm = perm("view", cu("editor"));

    expect(
      computeSchemaDiff(schema([ns("document", goneRel, gonePerm)]), schema([ns("document")])),
    ).toEqual([
      { kind: "relationRemoved", definitionName: "document", relation: goneRel },
      { kind: "permissionRemoved", definitionName: "document", permission: gonePerm },
    ]);
  });

  it("emits ALL relation adds before the per-existing pass", () => {
    const gone = rel("gone", allowedRelationDirect("user"));
    const fresh = rel("fresh", allowedRelationDirect("user"));

    expect(
      computeSchemaDiff(schema([ns("document", gone)]), schema([ns("document", fresh)])),
    ).toEqual([
      { kind: "relationAdded", definitionName: "document", relation: fresh },
      { kind: "relationRemoved", definitionName: "document", relation: gone },
    ]);
  });

  it("emits a relation->permission flip as PermissionAdded preceded by RelationRemoved", () => {
    // The flip block: RelationRemoved(existingDef.Name, existingRel) then
    // PermissionAdded(nextDef.Name, nextRel), in that exact order.
    const before = rel("view", allowedRelationDirect("user"));
    const after = perm("view", cu("viewer"));

    expect(
      computeSchemaDiff(schema([ns("document", before)]), schema([ns("document", after)])),
    ).toEqual([
      { kind: "relationRemoved", definitionName: "document", relation: before },
      { kind: "permissionAdded", definitionName: "document", permission: after },
    ]);
  });

  it("emits a permission->relation flip as PermissionRemoved then RelationAdded", () => {
    const before = perm("view", cu("viewer"));
    const after = rel("view", allowedRelationDirect("user"));

    expect(
      computeSchemaDiff(schema([ns("document", before)]), schema([ns("document", after)])),
    ).toEqual([
      { kind: "permissionRemoved", definitionName: "document", permission: before },
      { kind: "relationAdded", definitionName: "document", relation: after },
    ]);
  });

  it("stops after a flip - no subject-type or expression delta follows", () => {
    // `continue;` ends the per-relation body after the flip pair.
    const before = rel("view", allowedRelationDirect("user"));
    const after = perm("view", cu("viewer"), cu("editor"));

    expect(
      computeSchemaDiff(schema([ns("document", before)]), schema([ns("document", after)])),
    ).toHaveLength(2);
  });

  it("emits PermissionExprChanged carrying the NEXT definition name and NEXT relation", () => {
    // `new SchemaDelta.PermissionExprChanged(nextDef.Name, nextRel)`.
    const before = perm("view", cu("viewer"));
    const after = perm("view", cu("editor"));

    expect(
      computeSchemaDiff(schema([ns("document", before)]), schema([ns("document", after)])),
    ).toEqual([{ kind: "permissionExprChanged", definitionName: "document", permission: after }]);
  });

  it("emits nothing for a permission whose rewrite is structurally identical", () => {
    // "Record equality is not enough here: the trees hold ImmutableList children, whose Equals is
    // reference, not value, based" - so the compare must be structural.
    const before = perm("view", cu("viewer"), cu("editor"));
    const after = perm("view", cu("viewer"), cu("editor"));

    expect(
      computeSchemaDiff(schema([ns("document", before)]), schema([ns("document", after)])),
    ).toEqual([]);
  });
});

describe("computeSchemaDiff allowed subject types", () => {
  it("emits RelationSubjectTypeAdded with the NEXT relation and the EXISTING definition name", () => {
    // `new SchemaDelta.RelationSubjectTypeAdded(defName, nextRel, added)` where `defName` is
    // `existingDef.Name` (passed in from DiffRelations).
    const before = rel("viewer", allowedRelationDirect("user"));
    const extra = allowedRelationDirect("group", "member");
    const after = rel("viewer", allowedRelationDirect("user"), extra);

    expect(
      computeSchemaDiff(schema([ns("document", before)]), schema([ns("document", after)])),
    ).toEqual([
      {
        kind: "relationSubjectTypeAdded",
        definitionName: "document",
        relation: after,
        subjectType: extra,
      },
    ]);
  });

  it("emits RelationSubjectTypeRemoved carrying the EXISTING relation", () => {
    // The removal delta carries `existingRel`, not `nextRel`.
    const dropped = allowedRelationDirect("group", "member");
    const before = rel("viewer", allowedRelationDirect("user"), dropped);
    const after = rel("viewer", allowedRelationDirect("user"));

    expect(
      computeSchemaDiff(schema([ns("document", before)]), schema([ns("document", after)])),
    ).toEqual([
      {
        kind: "relationSubjectTypeRemoved",
        definitionName: "document",
        relation: before,
        subjectType: dropped,
      },
    ]);
  });

  it("emits every add before every removal", () => {
    const dropped = allowedRelationDirect("group", "member");
    const extra = allowedRelationWildcard("user");
    const before = rel("viewer", dropped);
    const after = rel("viewer", extra);

    expect(
      computeSchemaDiff(schema([ns("document", before)]), schema([ns("document", after)])),
    ).toEqual([
      {
        kind: "relationSubjectTypeAdded",
        definitionName: "document",
        relation: after,
        subjectType: extra,
      },
      {
        kind: "relationSubjectTypeRemoved",
        definitionName: "document",
        relation: before,
        subjectType: dropped,
      },
    ]);
  });

  it("treats an ABSENT TypeInformation as an empty list, not as a skip", () => {
    // `existingRel.TypeInformation?.AllowedDirectRelations ?? []` on BOTH sides.
    const added = allowedRelationDirect("user");
    const before = untypedRel("viewer");
    const after = rel("viewer", added);

    expect(
      computeSchemaDiff(schema([ns("document", before)]), schema([ns("document", after)])),
    ).toEqual([
      {
        kind: "relationSubjectTypeAdded",
        definitionName: "document",
        relation: after,
        subjectType: added,
      },
    ]);

    const removed = allowedRelationDirect("user");
    expect(
      computeSchemaDiff(
        schema([ns("document", rel("viewer", removed))]),
        schema([ns("document", untypedRel("viewer"))]),
      ),
    ).toEqual([
      {
        kind: "relationSubjectTypeRemoved",
        definitionName: "document",
        relation: rel("viewer", removed),
        subjectType: removed,
      },
    ]);
  });

  it("emits nothing when both sides are untyped", () => {
    expect(
      computeSchemaDiff(
        schema([ns("document", untypedRel("viewer"))]),
        schema([ns("document", untypedRel("viewer"))]),
      ),
    ).toEqual([]);
  });

  it("treats a changed required caveat as a genuine subject-type change", () => {
    // SameAllowedType folds the required caveat name into the canonical source string.
    const before = allowedRelationDirect("user", "...", { caveatName: "one" });
    const after = allowedRelationDirect("user", "...", { caveatName: "two" });

    const deltas = computeSchemaDiff(
      schema([ns("document", rel("viewer", before))]),
      schema([ns("document", rel("viewer", after))]),
    );

    expect(deltas.map((d) => d.kind)).toEqual([
      "relationSubjectTypeAdded",
      "relationSubjectTypeRemoved",
    ]);
  });

  it("treats adding `with expiration` as a genuine subject-type change", () => {
    const before = allowedRelationDirect("user", "...", undefined, false);
    const after = allowedRelationDirect("user", "...", undefined, true);

    expect(
      computeSchemaDiff(
        schema([ns("document", rel("viewer", before))]),
        schema([ns("document", rel("viewer", after))]),
      ).map((d) => d.kind),
    ).toEqual(["relationSubjectTypeAdded", "relationSubjectTypeRemoved"]);
  });

  it("does not confuse a wildcard with the direct subject of the same type", () => {
    const direct = allowedRelationDirect("user");
    const wildcard = allowedRelationWildcard("user");

    expect(
      computeSchemaDiff(
        schema([ns("document", rel("viewer", direct))]),
        schema([ns("document", rel("viewer", wildcard))]),
      ).map((d) => d.kind),
    ).toEqual(["relationSubjectTypeAdded", "relationSubjectTypeRemoved"]);
  });
});

describe("computeSchemaDiff caveat-level deltas", () => {
  it("emits CaveatAdded and CaveatRemoved, adds first", () => {
    const gone = caveat("gone", "true");
    const fresh = caveat("fresh", "true");

    expect(computeSchemaDiff(schema([], [gone]), schema([], [fresh]))).toEqual([
      { kind: "caveatAdded", caveat: fresh },
      { kind: "caveatRemoved", caveat: gone },
    ]);
  });

  it("runs every definition delta before any caveat delta", () => {
    // `DiffDefinitions(...); DiffCaveats(...);` - the top-level order in Compute.
    const goneDef = ns("gone");
    const goneCaveat = caveat("gone", "true");

    expect(computeSchemaDiff(schema([goneDef], [goneCaveat]), EMPTY).map((d) => d.kind)).toEqual([
      "definitionRemoved",
      "caveatRemoved",
    ]);
  });

  it("does not descend into a removed caveat", () => {
    const gone = caveat("gone", "true", [["a", { typeName: "int" }]]);

    expect(computeSchemaDiff(schema([], [gone]), EMPTY)).toEqual([
      { kind: "caveatRemoved", caveat: gone },
    ]);
  });

  it("emits CaveatExprChanged carrying the NEXT caveat when the bytes differ", () => {
    const before = caveat("c", "a > 1");
    const after = caveat("c", "a > 2");

    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([
      { kind: "caveatExprChanged", caveat: after },
    ]);
  });

  it("compares expressions by BYTE CONTENT, not by reference", () => {
    // `SerializedExpression.AsSpan().SequenceEqual(...)` - two distinct arrays with equal bytes
    // are equal. A reference compare would report every recompiled caveat as changed.
    const before = caveat("c", "a > 1");
    const after = caveat("c", "a > 1");

    expect(before.serializedExpression).not.toBe(after.serializedExpression);
    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([]);
  });

  it("treats an empty expression as different from a one-byte one", () => {
    const before = caveat("c", "");
    const after = caveat("c", "x");

    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([
      { kind: "caveatExprChanged", caveat: after },
    ]);
  });

  it("emits CaveatExprChanged BEFORE the parameter deltas of the same caveat", () => {
    // `if (!...SequenceEqual(...)) deltas.Add(CaveatExprChanged); DiffCaveatParameters(...);`
    const before = caveat("c", "a > 1");
    const after = caveat("c", "a > 2", [["a", { typeName: "int" }]]);

    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([
      { kind: "caveatExprChanged", caveat: after },
      {
        kind: "caveatParameterAdded",
        caveatName: "c",
        parameterName: "a",
        type: { typeName: "int" },
      },
    ]);
  });

  it("still diffs parameters when the expression is unchanged", () => {
    const before = caveat("c", "a > 1", [["a", { typeName: "int" }]]);
    const after = caveat("c", "a > 1", [["a", { typeName: "uint" }]]);

    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([
      {
        kind: "caveatParameterTypeChanged",
        caveatName: "c",
        parameterName: "a",
        type: { typeName: "uint" },
        previousType: { typeName: "int" },
      },
    ]);
  });
});

describe("computeSchemaDiff caveat parameters", () => {
  const INT: CaveatTypeReference = { typeName: "int" };
  const STR: CaveatTypeReference = { typeName: "string" };

  it("emits CaveatParameterAdded with the NEXT caveat's name", () => {
    // `new SchemaDelta.CaveatParameterAdded(next.Name, name, type)`.
    const before = caveat("c", "e");
    const after = caveat("c", "e", [["a", INT]]);

    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([
      { kind: "caveatParameterAdded", caveatName: "c", parameterName: "a", type: INT },
    ]);
  });

  it("emits CaveatParameterRemoved with the EXISTING caveat's name and its type", () => {
    // `new SchemaDelta.CaveatParameterRemoved(existing.Name, name, existingType)`.
    const before = caveat("c", "e", [["a", INT]]);
    const after = caveat("c", "e");

    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([
      { kind: "caveatParameterRemoved", caveatName: "c", parameterName: "a", type: INT },
    ]);
  });

  it("emits every parameter add before any removal or type change", () => {
    // Two loops, adds first. Insertion order stands in for the C# hash order (see the module
    // note): only the ADDS-BEFORE-THE-REST grouping is portable, and that is what is asserted.
    const before = caveat("c", "e", [["gone", INT]]);
    const after = caveat("c", "e", [["fresh", STR]]);

    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([
      { kind: "caveatParameterAdded", caveatName: "c", parameterName: "fresh", type: STR },
      { kind: "caveatParameterRemoved", caveatName: "c", parameterName: "gone", type: INT },
    ]);
  });

  it("carries BOTH the new and the previous type on a type change", () => {
    // `CaveatParameterTypeChanged(next.Name, name, nextType, existingType)` - the positional
    // order is (Type, PreviousType), so the NEW type comes first.
    const before = caveat("c", "e", [["a", INT]]);
    const after = caveat("c", "e", [["a", STR]]);

    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([
      {
        kind: "caveatParameterTypeChanged",
        caveatName: "c",
        parameterName: "a",
        type: STR,
        previousType: INT,
      },
    ]);
  });

  it("reports a nested generic type change", () => {
    const before = caveat("c", "e", [["a", { typeName: "list", childTypes: [INT] }]]);
    const after = caveat("c", "e", [["a", { typeName: "list", childTypes: [STR] }]]);

    expect(computeSchemaDiff(schema([], [before]), schema([], [after])).map((d) => d.kind)).toEqual(
      ["caveatParameterTypeChanged"],
    );
  });

  it("DIVERGES from C#: structurally identical nested generics are NOT a change", () => {
    // C# record equality over `ImmutableList<CaveatTypeReference>? ChildTypes` is REFERENCE
    // equality, so the C# would emit CaveatParameterTypeChanged here. The port uses core's
    // structural `caveatTypeReferenceEquals` instead; this only ever removes a spurious
    // rejection, never adds one.
    const before = caveat("c", "e", [["a", { typeName: "map", childTypes: [STR, INT] }]]);
    const after = caveat("c", "e", [["a", { typeName: "map", childTypes: [STR, INT] }]]);

    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([]);
  });

  it("keeps a scalar distinct from a zero-argument generic", () => {
    // `undefined` childTypes (scalar) vs `[]`: core's equality keeps them distinct.
    const before = caveat("c", "e", [["a", { typeName: "list" }]]);
    const after = caveat("c", "e", [["a", { typeName: "list", childTypes: [] }]]);

    expect(computeSchemaDiff(schema([], [before]), schema([], [after])).map((d) => d.kind)).toEqual(
      ["caveatParameterTypeChanged"],
    );
  });

  it("reports nothing for an unchanged parameter", () => {
    const before = caveat("c", "e", [["a", INT]]);
    const after = caveat("c", "e", [["a", { typeName: "int" }]]);

    expect(computeSchemaDiff(schema([], [before]), schema([], [after]))).toEqual([]);
  });
});

describe("computeSchemaDiff whole-schema ordering", () => {
  it("emits the full Compute() order across every level", () => {
    const addedDef = ns("added");
    const removedDef = ns("removed");
    const addedRel = rel("fresh", allowedRelationDirect("user"));
    const removedRel = rel("gone", allowedRelationDirect("user"));
    const addedCaveat = caveat("added_caveat", "true");
    const removedCaveat = caveat("removed_caveat", "true");

    const existing = schema([removedDef, ns("kept", removedRel)], [removedCaveat]);
    const next = schema([addedDef, ns("kept", addedRel)], [addedCaveat]);

    expect(computeSchemaDiff(existing, next)).toEqual([
      { kind: "definitionAdded", definition: addedDef },
      { kind: "definitionRemoved", definition: removedDef },
      { kind: "relationAdded", definitionName: "kept", relation: addedRel },
      { kind: "relationRemoved", definitionName: "kept", relation: removedRel },
      { kind: "caveatAdded", caveat: addedCaveat },
      { kind: "caveatRemoved", caveat: removedCaveat },
    ]);
  });

  it("keeps each kept definition's relation deltas together, in existing-list order", () => {
    const goneA = rel("a", allowedRelationDirect("user"));
    const goneB = rel("b", allowedRelationDirect("user"));

    const existing = schema([ns("one", goneA), ns("two", goneB)]);
    const next = schema([ns("one"), ns("two")]);

    expect(computeSchemaDiff(existing, next)).toEqual([
      { kind: "relationRemoved", definitionName: "one", relation: goneA },
      { kind: "relationRemoved", definitionName: "two", relation: goneB },
    ]);
  });
});

describe("rewriteEquals", () => {
  const tree: UsersetRewrite = { operation: setOperationUnion(cu("viewer")) };

  it("is true only when BOTH sides are absent", () => {
    // `if (a is null || b is null) return ReferenceEquals(a, b);`
    expect(rewriteEquals(undefined, undefined)).toBe(true);
    expect(rewriteEquals(tree, undefined)).toBe(false);
    expect(rewriteEquals(undefined, tree)).toBe(false);
  });

  it("compares operation type and child count", () => {
    expect(
      rewriteEquals(
        { operation: { type: "union", children: [cu("a")] } },
        { operation: { type: "intersection", children: [cu("a")] } },
      ),
    ).toBe(false);
    expect(
      rewriteEquals(
        { operation: { type: "union", children: [cu("a")] } },
        { operation: { type: "union", children: [cu("a"), cu("b")] } },
      ),
    ).toBe(false);
  });

  it("compares children POSITIONALLY, not as a set", () => {
    // `for (var i = 0; ...) ChildEquals(a.Children[i], b.Children[i])`.
    expect(
      rewriteEquals(
        { operation: setOperationUnion(cu("a"), cu("b")) },
        { operation: setOperationUnion(cu("b"), cu("a")) },
      ),
    ).toBe(false);
  });

  it("is true for separately built but structurally identical trees", () => {
    expect(
      rewriteEquals(
        { operation: setOperationUnion(cu("viewer"), cu("editor")) },
        { operation: setOperationUnion(cu("viewer"), cu("editor")) },
      ),
    ).toBe(true);
  });

  it("recurses into nested rewrites", () => {
    const nested = (relation: string): SetOperationChild => ({
      kind: "nestedRewrite",
      value: { operation: setOperationUnion(cu(relation)) },
    });

    expect(
      rewriteEquals(
        { operation: setOperationUnion(nested("a")) },
        { operation: setOperationUnion(nested("a")) },
      ),
    ).toBe(true);
    expect(
      rewriteEquals(
        { operation: setOperationUnion(nested("a")) },
        { operation: setOperationUnion(nested("b")) },
      ),
    ).toBe(false);
  });

  it("never equates a nested rewrite with a child of any other kind", () => {
    // `(NestedRewrite, _) or (_, NestedRewrite) => false` - checked before the value-equality arm.
    const nested: SetOperationChild = {
      kind: "nestedRewrite",
      value: { operation: setOperationUnion(cu("a")) },
    };

    expect(
      rewriteEquals(
        { operation: setOperationUnion(nested) },
        { operation: setOperationUnion({ kind: "this" }) },
      ),
    ).toBe(false);
  });

  it("DIVERGES from C#: an operationPath is compared structurally, not by reference", () => {
    // Divergence 3. `ChildEquals`'s value-equality arm (`a == b`) is C# record equality over
    // SetOperationChild, whose `ImmutableList<uint>? OperationPath` has REFERENCE-based Equals -
    // so C# reports two separately built children carrying an equal path as DIFFERENT. Like
    // divergence 1 this only ever removes a spurious PermissionExprChanged. Unreachable through
    // computeSchemaDiff (the compiler never populates operationPath) but reachable here.
    expect(
      rewriteEquals(
        { operation: setOperationUnion({ ...cu("a"), operationPath: [0, 1] }) },
        { operation: setOperationUnion({ ...cu("a"), operationPath: [0, 1] }) },
      ),
    ).toBe(true);

    // A genuinely different path is still a difference, in both the C# and here.
    expect(
      rewriteEquals(
        { operation: setOperationUnion({ ...cu("a"), operationPath: [0, 1] }) },
        { operation: setOperationUnion({ ...cu("a"), operationPath: [0, 2] }) },
      ),
    ).toBe(false);
  });

  it("distinguishes the operand-free child kinds from one another", () => {
    expect(
      rewriteEquals(
        { operation: setOperationUnion({ kind: "this" }) },
        { operation: setOperationUnion({ kind: "nil" }) },
      ),
    ).toBe(false);
    expect(
      rewriteEquals(
        { operation: setOperationUnion({ kind: "nil" }) },
        { operation: setOperationUnion({ kind: "nil" }) },
      ),
    ).toBe(true);
  });

  it("compares tuple-to-userset operands by value", () => {
    const ttu = (tupleset: string, relation: string): SetOperationChild => ({
      kind: "tupleToUserset",
      value: { tuplesetRelation: tupleset, computedUserset: { object: "tupleObject", relation } },
    });

    expect(
      rewriteEquals(
        { operation: setOperationUnion(ttu("parent", "view")) },
        { operation: setOperationUnion(ttu("parent", "view")) },
      ),
    ).toBe(true);
    expect(
      rewriteEquals(
        { operation: setOperationUnion(ttu("parent", "view")) },
        { operation: setOperationUnion(ttu("owner", "view")) },
      ),
    ).toBe(false);
  });
});

describe("sameAllowedType", () => {
  it("compares the canonical source strings, not the fields", () => {
    // `AllowedRelationIdentity.Source(a) == AllowedRelationIdentity.Source(b)`.
    expect(sameAllowedType(allowedRelationDirect("user"), allowedRelationDirect("user"))).toBe(
      true,
    );
    expect(
      sameAllowedType(allowedRelationDirect("user"), allowedRelationDirect("user", "member")),
    ).toBe(false);
    expect(sameAllowedType(allowedRelationDirect("user"), allowedRelationWildcard("user"))).toBe(
      false,
    );
  });

  it("folds the required caveat and the expiration trait into the identity", () => {
    expect(
      sameAllowedType(
        allowedRelationDirect("user", "...", { caveatName: "c" }),
        allowedRelationDirect("user"),
      ),
    ).toBe(false);
    expect(
      sameAllowedType(
        allowedRelationDirect("user", "...", undefined, true),
        allowedRelationDirect("user", "...", undefined, false),
      ),
    ).toBe(false);
  });

  it("normalizes the ellipsis subrelation", () => {
    // Source() renders a bare object type for the ellipsis, so an explicit "..." and the default
    // are the same identity.
    expect(
      sameAllowedType(allowedRelationDirect("user", "..."), allowedRelationDirect("user")),
    ).toBe(true);
  });
});
