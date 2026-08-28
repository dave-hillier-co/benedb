import { allowedRelationDirect } from "@spacedb/core/allowed-relation";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import {
  createNamespaceDefinition,
  type NamespaceDefinition,
} from "@spacedb/core/namespace-definition";
import { baseRelation, permission } from "@spacedb/core/relation";
import { compile } from "@spacedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { buildMembershipCoverage, type MembershipCoverage } from "./membership-coverage";

// Ported from Spiceport `tests/Spiceport.Engine.Tests/MembershipCoverageTests.cs`, case for case.
//
// Coverage-analysis gates for `MembershipCoverage`: which (resourceType, nameOrPermission) targets
// flatten to stored base-relation edges. Pure schema analysis - no datastore, no revision.
//
// Port decisions for the surface under test:
//   * The C# is a class with a PRIVATE constructor plus a static `Build`, so it becomes an
//     interface plus the exported {@link buildMembershipCoverage} factory - the same shape
//     `reachability-graph.ts` already uses.
//   * TUPLE KEYS EVERYWHERE: the C# indexes `Dictionary<(string Type, string Name), ...>` and
//     `ImmutableHashSet<(string Type, string Relation)>`. C# value tuples have structural
//     equality; a JS `Map`/`Set` keyed by an array or object does not. ONE length-prefixed
//     canonical key function lives inside `membership-coverage.ts` and is never exported.
//   * `ScanSet` is public in the C# and `MembershipWalk` calls
//     `coverage.ScanSet.Contains((type, relation))`. Exporting a raw `ReadonlySet<string>` would
//     force the caller to reproduce the key format, so the port exposes `scanSetHas(type,
//     relation)` instead and the two files cannot drift.
//   * `TryGetYields(..., out ImmutableHashSet<string>)` -> `tryGetYields(...)` returning
//     `ReadonlySet<string> | undefined`. On a false return the C# `out` is left at its default
//     null, so a truthiness check is the whole contract.
//   * `IsEmpty` is a computed property -> a getter, never a snapshotted field.
//
// SAFETY MODEL, which the assertions below encode: coverage is a CANDIDATE predicate, never a
// verdict. For intersection/exclusion only the FIRST operand seeds candidates; arrows, `Self`,
// `This` and a computed userset on a traversed subject ABORT coverage entirely. Over-inclusion is
// safe (Check confirms); under-inclusion is a silent false negative Check confirmation cannot
// catch, because a candidate the walk never produced never reaches Check at all.

const NESTED_SCHEMA = `
definition user {}

definition group {
    relation member: user | group#member
}

definition document {
    relation viewer: user | group#member
    relation editor: user
    relation banned: user

    permission view = viewer + editor
    permission allowed_view = viewer - banned
    permission edit = editor & viewer
    permission via_arrow = viewer + parent_view
    permission parent_view = editor
    permission truly_arrowed = viewer->member
}
`;

function build(schemaText: string): MembershipCoverage {
  return buildMembershipCoverage(compile(schemaText));
}

describe("MembershipCoverage", () => {
  it("covers a base relation, yielding itself", () => {
    const coverage = build(NESTED_SCHEMA);

    const yields = coverage.tryGetYields("group", "member");

    expect(yields).toBeDefined();
    expect(yields?.has("member")).toBe(true);
    expect(coverage.scanSetHas("group", "member")).toBe(true);
  });

  it("covers a union permission, yielding all operands", () => {
    const coverage = build(NESTED_SCHEMA);

    const yields = coverage.tryGetYields("document", "view");

    expect(yields).toBeDefined();
    expect(yields?.has("viewer")).toBe(true);
    expect(yields?.has("editor")).toBe(true);
  });

  it("covers an exclusion permission, yielding only the first operand", () => {
    const coverage = build(NESTED_SCHEMA);

    const yields = coverage.tryGetYields("document", "allowed_view");

    expect(yields).toBeDefined();
    expect(yields?.has("viewer")).toBe(true);
    // The negative operand never seeds candidates.
    expect(yields?.has("banned")).toBe(false);
  });

  it("covers an intersection permission, yielding only the first operand", () => {
    const coverage = build(NESTED_SCHEMA);

    // `edit = editor & viewer` - first operand only.
    const yields = coverage.tryGetYields("document", "edit");

    expect(yields).toBeDefined();
    expect(yields?.has("editor")).toBe(true);
    expect(yields?.has("viewer")).toBe(false);
  });

  it("covers a union of computed usersets with no arrow", () => {
    const coverage = build(NESTED_SCHEMA);

    // `via_arrow = viewer + parent_view`; `parent_view = editor` has no arrow, so the whole
    // union covers.
    const yields = coverage.tryGetYields("document", "via_arrow");

    expect(yields).toBeDefined();
    expect(yields?.has("viewer")).toBe(true);
    expect(yields?.has("editor")).toBe(true);
  });

  it("aborts coverage on a tuple-to-userset arrow", () => {
    const coverage = build(NESTED_SCHEMA);

    expect(coverage.tryGetYields("document", "truly_arrowed")).toBeUndefined();
  });

  it("does not cover an unknown relation or an unknown type", () => {
    const coverage = build(NESTED_SCHEMA);

    expect(coverage.tryGetYields("document", "no_such_relation")).toBeUndefined();
    expect(coverage.tryGetYields("no_such_type", "view")).toBeUndefined();
  });

  it("covers a base relation whose subject types include a wildcard", () => {
    const wildcardSchema = `
definition user {}

definition group {
    relation member: user:* | user | group#member
}
`;
    const coverage = build(wildcardSchema);

    const yields = coverage.tryGetYields("group", "member");

    expect(yields).toBeDefined();
    expect(yields?.has("member")).toBe(true);
  });

  it("reports an empty coverage for a schema with no coverable target", () => {
    const coverage = build("definition user {}");

    expect(coverage.isEmpty).toBe(true);
  });
});

describe("MembershipCoverage port decisions", () => {
  it("treats an operand-free intersection as not coverable rather than throwing", () => {
    // DIVERGENCE, stated deliberately. `TryResolveOperation`'s Intersection/Exclusion branch
    // indexes `operation.Children[0]` with NO empty guard: C# throws ArgumentOutOfRangeException,
    // while under `noUncheckedIndexedAccess` TypeScript hands back `undefined`. The safe reading
    // is "not coverable" - coverage may only ever be too narrow in a way that costs work, never
    // in a way that drops candidates. The DSL compiler cannot produce this shape, so the case is
    // reachable only from a hand-built model such as this one.
    const ns = createNamespaceDefinition(
      "document",
      baseRelation("viewer", allowedRelationDirect("user")),
      permission("degenerate", { operation: { type: "intersection", children: [] } }),
    );

    const coverage = buildMembershipCoverage([createNamespaceDefinition("user"), ns]);

    expect(coverage.tryGetYields("document", "degenerate")).toBeUndefined();
    // The sibling base relation is unaffected - one uncoverable target does not poison the schema.
    expect(coverage.tryGetYields("document", "viewer")).toBeDefined();
  });

  it("treats a permission cycle as contributing nothing rather than aborting coverage", () => {
    // `visiting.Add((type,name))` returning false means a permission cycle, and the C# returns
    // TRUE ("contributes nothing new") - not false. The `try`/`finally` removes the entry on the
    // way out, so the port keeps a `try`/`finally` rather than a trailing delete: an exception
    // from a deeper level must not leave the marker behind and silently truncate a later branch.
    const ns = createNamespaceDefinition(
      "document",
      baseRelation("viewer", allowedRelationDirect("user")),
      // `a = viewer + b`, `b = a`: a genuine permission cycle over a coverable base relation.
      permission("a", {
        operation: {
          type: "union",
          children: [
            { kind: "computedUserset", value: { object: "tupleObject", relation: "viewer" } },
            { kind: "computedUserset", value: { object: "tupleObject", relation: "b" } },
          ],
        },
      }),
      permission("b", {
        operation: {
          type: "union",
          children: [{ kind: "computedUserset", value: { object: "tupleObject", relation: "a" } }],
        },
      }),
    );

    const coverage = buildMembershipCoverage([createNamespaceDefinition("user"), ns]);

    const yields = coverage.tryGetYields("document", "a");
    expect(yields).toBeDefined();
    expect(yields?.has("viewer")).toBe(true);
  });

  // Not from the C# case list: pins the `ArgumentNullException.ThrowIfNull(namespaces)` guard,
  // which the port keeps even though the TypeScript type is non-optional because the grain-layer
  // caller is untyped.
  it("rejects an absent namespace list", () => {
    expect(() =>
      buildMembershipCoverage(undefined as unknown as Iterable<NamespaceDefinition>),
    ).toThrow(InvalidArgumentError);
  });
});

// Not from the C# suite. `namespaces.ToImmutableDictionary(ns => ns.Name)` throws on a duplicate
// key, and every other engine entry point ported in this stage reproduces that throw; this one
// silently let the last definition win, analysing a schema the C# refuses outright.
describe("buildMembershipCoverage duplicate namespaces", () => {
  it("throws rather than letting the last definition silently win", () => {
    const doc = createNamespaceDefinition("document");

    expect(() => buildMembershipCoverage([doc, doc])).toThrow(InvalidArgumentError);
  });
});
