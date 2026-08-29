import {
  allowedRelationDirect,
  allowedRelationWildcard,
  type AllowedRelation,
} from "@spacedb/core/allowed-relation";
import type { CaveatDefinition, CaveatTypeReference } from "@spacedb/core/caveat-definition";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@spacedb/core/namespace-definition";
import type { Relation } from "@spacedb/core/relation";
import type { Relationship } from "@spacedb/core/relationship";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { parseRelationship } from "@spacedb/core/tuple-strings";
import { setOperationUnion, type SetOperationChild } from "@spacedb/core/userset-rewrite";
import type { IDatastoreReader } from "@spacedb/datastore/i-datastore";
import {
  relationshipsFilterMatches,
  type RelationshipsFilter,
} from "@spacedb/datastore/relationships-filter";
import type { CompiledSchema } from "@spacedb/schema/compiled-schema";
import { describe, expect, it } from "vitest";

import type { ISnapshotScanner } from "./i-snapshot-scanner";
import {
  computeChecks,
  evaluateWithReader,
  evaluateWithScanner,
  validate,
  type SchemaChangeCheck,
} from "./schema-change-validator";
import { SchemaWriteValidationException } from "./schema-write-validation-exception";

/**
 * Characterization of `Grains/SchemaChangeValidator.cs`.
 *
 * The one genuine C# covering test is `SteelThreadTests.RunWriteSchema`, which calls
 * `SchemaChangeValidator.ValidateAsync(f.Schema, next, f.Reader)` against a ReferenceDatastore
 * snapshot reader and asserts only REJECTED-vs-ACCEPTED, never the message. That suite is
 * deferred, so everything below is derived from the C# source rather than from it, and the
 * message text - which `SchemaPropagationMeshTests` later asserts verbatim - is pinned
 * character-for-character here, backticks included.
 *
 * The structure the C# fixes and this file pins:
 *   * `ComputeChecks` is PURE - it takes no datastore and touches none.
 *   * `ValidateAsync` = `ComputeChecks` + the reader-based `EvaluateAsync`; a THIRD entry point
 *     evaluates the same checks against the `ISnapshotScanner` seam at a pinned revision.
 *   * `EvaluateCore` walks the checks IN ORDER: an Unconditional throws on sight; a NoOrphans
 *     throws on the FIRST yielded row and never pulls a second; an empty result falls through.
 *   * Only five delta kinds produce checks (DefinitionRemoved, RelationRemoved,
 *     RelationSubjectTypeRemoved, CaveatParameterRemoved, CaveatParameterTypeChanged). Every
 *     other delta hits the default arm, which produces NOTHING and does not throw.
 */

// ---- schema construction (same helpers as schema-diff.test.ts) ----

function ns(name: string, ...relations: Relation[]): NamespaceDefinition {
  return { name, relations };
}

function rel(name: string, ...allowed: AllowedRelation[]): Relation {
  return { name, typeInformation: { allowedDirectRelations: allowed } };
}

function perm(name: string, ...children: SetOperationChild[]): Relation {
  return { name, usersetRewrite: { operation: setOperationUnion(...children) } };
}

function cu(relation: string): SetOperationChild {
  return { kind: "computedUserset", value: { object: "tupleObject", relation } };
}

function schema(
  namespaces: NamespaceDefinition[],
  caveats: CaveatDefinition[] = [],
): CompiledSchema {
  return { namespaces, caveats };
}

function caveat(
  name: string,
  parameters: readonly (readonly [string, CaveatTypeReference])[],
): CaveatDefinition {
  return {
    name,
    serializedExpression: new Uint8Array([1]),
    parameterTypes: new Map(parameters),
  };
}

const INT: CaveatTypeReference = { typeName: "int" };
const STRING: CaveatTypeReference = { typeName: "string" };

function tuple(text: string): Relationship {
  return parseRelationship(text);
}

// ---- check accessors ----

function noOrphans(check: SchemaChangeCheck | undefined): {
  filter: RelationshipsFilter;
  describe: (r: Relationship) => string;
} {
  if (check === undefined || check.kind !== "noOrphans") {
    throw new Error(`expected a noOrphans check, got ${JSON.stringify(check)}`);
  }
  return { filter: check.filter, describe: check.describe };
}

function unconditionalMessage(check: SchemaChangeCheck | undefined): string {
  if (check === undefined || check.kind !== "unconditional") {
    throw new Error(`expected an unconditional check, got ${JSON.stringify(check)}`);
  }
  return check.message;
}

// ---- datastore fakes ----

interface FakeReader {
  readonly reader: IDatastoreReader;
  /** The filters each query was given, in call order. */
  readonly filters: RelationshipsFilter[];
  /** How many rows were actually PULLED from the produced enumerations. */
  pulled: number;
}

/**
 * A reader over a fixed row list, matching with the REAL `relationshipsFilterMatches` - so the
 * caveat and expiration clauses of the removed-allowed-type filter are genuinely exercised, not
 * mocked away.
 */
function fakeReader(rows: readonly Relationship[]): FakeReader {
  const state: FakeReader = {
    reader: undefined as unknown as IDatastoreReader,
    filters: [],
    pulled: 0,
  };
  const reader = {
    async *queryRelationships(
      filter: RelationshipsFilter,
      _signal?: AbortSignal | undefined,
    ): AsyncIterable<Relationship> {
      state.filters.push(filter);
      for (const row of rows) {
        if (relationshipsFilterMatches(filter, row)) {
          state.pulled++;
          yield row;
        }
      }
    },
  };
  return Object.assign(state, { reader: reader as unknown as IDatastoreReader });
}

// ---- ComputeChecks: which deltas produce checks ----

describe("computeChecks", () => {
  it("returns no checks for identical schemas", () => {
    const s = schema([ns("document", rel("viewer", allowedRelationDirect("user")))]);
    expect(computeChecks(s, s)).toEqual([]);
  });

  it("rejects missing schemas (the two ArgumentNullException guards)", () => {
    const s = schema([]);
    expect(() => computeChecks(undefined as unknown as CompiledSchema, s)).toThrow(
      InvalidArgumentError,
    );
    expect(() => computeChecks(s, undefined as unknown as CompiledSchema)).toThrow(
      InvalidArgumentError,
    );
  });

  it("produces NOTHING for additions, permission changes and caveat removal (the default arm)", () => {
    // DefinitionAdded, RelationAdded, RelationSubjectTypeAdded, PermissionAdded,
    // PermissionRemoved, PermissionExprChanged, CaveatAdded, CaveatRemoved, CaveatExprChanged and
    // CaveatParameterAdded all fall through the switch WITHOUT producing a check, and without
    // throwing.
    const current = schema(
      [
        ns(
          "document",
          rel("viewer", allowedRelationDirect("user")),
          perm("view", cu("viewer")),
          perm("gone", cu("viewer")),
        ),
      ],
      [caveat("kept", [["a", INT]]), caveat("dropped", [["b", INT]])],
    );
    const next = schema(
      [
        ns(
          "document",
          rel("viewer", allowedRelationDirect("user"), allowedRelationDirect("group", "member")),
          rel("editor", allowedRelationDirect("user")),
          perm("view", cu("editor")),
        ),
        ns("folder", rel("viewer", allowedRelationDirect("user"))),
      ],
      [
        caveat("kept", [
          ["a", INT],
          ["c", STRING],
        ]),
        caveat("added", [["d", INT]]),
      ],
    );

    expect(computeChecks(current, next)).toEqual([]);
  });
});

describe("computeChecks for a removed definition", () => {
  const current = schema([
    ns("document", rel("viewer", allowedRelationDirect("user"))),
    ns("folder", rel("viewer", allowedRelationDirect("user"))),
  ]);
  const next = schema([ns("folder", rel("viewer", allowedRelationDirect("user")))]);

  it("guards the resource type alone", () => {
    // `new RelationshipsFilter { OptionalResourceType = def.Name }` - nothing else is constrained.
    const checks = computeChecks(current, next);
    expect(checks).toHaveLength(1);
    expect(noOrphans(checks[0]).filter).toEqual({ optionalResourceType: "document" });
  });

  it("renders the historical message from the first offending relationship", () => {
    const { describe: render } = noOrphans(computeChecks(current, next)[0]);
    // `Relationship.ToString()` is `TupleStrings.FormatRelationship`.
    expect(render(tuple("document:doc1#viewer@user:alice"))).toBe(
      "cannot remove definition `document`: at least one relationship still references it as a resource type (e.g. document:doc1#viewer@user:alice)",
    );
  });
});

describe("computeChecks for a removed relation", () => {
  const current = schema([
    ns(
      "document",
      rel("viewer", allowedRelationDirect("user")),
      rel("editor", allowedRelationDirect("user")),
    ),
  ]);
  const next = schema([ns("document", rel("viewer", allowedRelationDirect("user")))]);

  it("emits TWO checks, resource side first, then subject side", () => {
    const checks = computeChecks(current, next);
    expect(checks).toHaveLength(2);

    expect(noOrphans(checks[0]).filter).toEqual({
      optionalResourceType: "document",
      optionalResourceRelation: "editor",
    });
    expect(noOrphans(checks[1]).filter).toEqual({
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: "document",
          relationFilter: { nonEllipsisRelation: "editor" },
        },
      ],
    });
  });

  it("renders the two distinct historical messages", () => {
    const checks = computeChecks(current, next);
    expect(noOrphans(checks[0]).describe(tuple("document:doc1#editor@user:alice"))).toBe(
      "cannot remove relation `editor` in definition `document`: at least one relationship still references it (e.g. document:doc1#editor@user:alice)",
    );
    expect(noOrphans(checks[1]).describe(tuple("folder:f1#parent@document:doc1#editor"))).toBe(
      "cannot remove relation `editor` in definition `document`: at least one relationship references it as part of a subject (e.g. folder:f1#parent@document:doc1#editor)",
    );
  });

  it("also fires when a relation becomes a permission", () => {
    // `RelationRemoved` covers "turned into a permission" - a permission holds no stored rows, so
    // the existing ones would be orphaned.
    const toPermission = schema([
      ns("document", rel("viewer", allowedRelationDirect("user")), perm("editor", cu("viewer"))),
    ]);
    expect(computeChecks(current, toPermission)).toHaveLength(2);
  });
});

describe("computeChecks for a removed allowed subject type", () => {
  function removalOf(
    removed: AllowedRelation,
    kept: AllowedRelation = allowedRelationDirect("keeper"),
  ) {
    const current = schema([ns("document", rel("viewer", kept, removed))]);
    const next = schema([ns("document", rel("viewer", kept))]);
    const checks = computeChecks(current, next);
    expect(checks).toHaveLength(1);
    return noOrphans(checks[0]);
  }

  it("filters resource type, relation, subject type and an ELLIPSIS subject relation", () => {
    const { filter } = removalOf(allowedRelationDirect("user"));
    expect(filter).toEqual({
      optionalResourceType: "document",
      optionalResourceRelation: "viewer",
      optionalSubjectsSelectors: [
        {
          optionalSubjectType: "user",
          optionalSubjectIds: undefined,
          relationFilter: { includeEllipsisRelation: true },
        },
      ],
      optionalCaveatNameFilter: { option: "noCaveat" },
      optionalExpirationOption: "noExpiration",
    });
    // `subjectIds` is NULL, not an empty list: an empty list would match nothing.
    expect(filter.optionalSubjectsSelectors?.[0]?.optionalSubjectIds).toBeUndefined();
  });

  it("filters a SUBRELATION subject with a non-ellipsis relation filter", () => {
    const { filter } = removalOf(allowedRelationDirect("group", "member"));
    expect(filter.optionalSubjectsSelectors).toEqual([
      {
        optionalSubjectType: "group",
        optionalSubjectIds: undefined,
        relationFilter: { nonEllipsisRelation: "member" },
      },
    ]);
  });

  it("constrains the subject id to the public wildcard for a wildcard allowed type", () => {
    // A wildcard leaves RelationName ABSENT, so the subject relation is the ellipsis.
    const { filter } = removalOf(allowedRelationWildcard("user"));
    expect(filter.optionalSubjectsSelectors).toEqual([
      {
        optionalSubjectType: "user",
        optionalSubjectIds: ["*"],
        relationFilter: { includeEllipsisRelation: true },
      },
    ]);
  });

  it("filters on the REQUIRED CAVEAT NAME when the removed type carried one", () => {
    // Removing `user with cav1` only orphans rows that actually carry cav1.
    const { filter } = removalOf(allowedRelationDirect("user", "...", { caveatName: "cav1" }));
    expect(filter.optionalCaveatNameFilter).toEqual({
      option: "hasMatchingCaveat",
      caveatName: "cav1",
    });
  });

  it("takes the NO-CAVEAT branch for a present-but-empty caveat name", () => {
    // `RequiredCaveat is { CaveatName.Length: > 0 }` - a present caveat with an empty name fails
    // the pattern and falls to NoCaveat.
    const { filter } = removalOf(allowedRelationDirect("user", "...", { caveatName: "" }));
    expect(filter.optionalCaveatNameFilter).toEqual({ option: "noCaveat" });
  });

  it("filters on expiration presence, never leaving the option unconstrained", () => {
    const withExpiration = removalOf(allowedRelationDirect("user", "...", undefined, true));
    expect(withExpiration.filter.optionalExpirationOption).toBe("hasExpiration");

    const without = removalOf(allowedRelationDirect("user"));
    expect(without.filter.optionalExpirationOption).toBe("noExpiration");
  });

  it("names the removed type by its canonical SOURCE identity in the message", () => {
    // `AllowedRelationIdentity.Source(allowed)` - traits included, spacing load-bearing.
    const plain = removalOf(allowedRelationDirect("user"));
    expect(plain.describe(tuple("document:doc1#viewer@user:alice"))).toBe(
      "cannot remove allowed subject type `user` from `document#viewer`: at least one relationship still references it (e.g. document:doc1#viewer@user:alice)",
    );

    const traited = removalOf(allowedRelationDirect("user", "...", { caveatName: "cav1" }, true));
    expect(traited.describe(tuple("document:doc1#viewer@user:alice"))).toBe(
      "cannot remove allowed subject type `user with cav1 and expiration` from `document#viewer`: at least one relationship still references it (e.g. document:doc1#viewer@user:alice)",
    );
  });
});

describe("computeChecks for caveat parameter changes", () => {
  it("rejects a removed parameter UNCONDITIONALLY (no datastore query)", () => {
    const current = schema(
      [],
      [
        caveat("cav", [
          ["a", INT],
          ["b", STRING],
        ]),
      ],
    );
    const next = schema([], [caveat("cav", [["a", INT]])]);

    const checks = computeChecks(current, next);
    expect(checks).toHaveLength(1);
    expect(unconditionalMessage(checks[0])).toBe("cannot remove parameter `b` on caveat `cav`");
  });

  it("rejects a changed parameter type UNCONDITIONALLY", () => {
    const current = schema([], [caveat("cav", [["a", INT]])]);
    const next = schema([], [caveat("cav", [["a", STRING]])]);

    const checks = computeChecks(current, next);
    expect(checks).toHaveLength(1);
    expect(unconditionalMessage(checks[0])).toBe(
      "cannot change the type of parameter `a` on caveat `cav`",
    );
  });
});

describe("computeChecks ordering", () => {
  it("keeps the diff order: definition deltas before caveat deltas", () => {
    // `SchemaDiff.Compute` runs DiffDefinitions then DiffCaveats, and `EvaluateCore` throws on the
    // FIRST failing check - so this order decides which message a user sees.
    const current = schema(
      [ns("document", rel("viewer", allowedRelationDirect("user")))],
      [caveat("cav", [["a", INT]])],
    );
    const next = schema([], [caveat("cav", [])]);

    const checks = computeChecks(current, next);
    expect(checks.map((c) => c.kind)).toEqual(["noOrphans", "unconditional"]);
    expect(noOrphans(checks[0]).filter).toEqual({ optionalResourceType: "document" });
  });
});

// ---- EvaluateCore ----

describe("evaluateWithReader", () => {
  it("throws an unconditional check's message without querying at all", async () => {
    const reader = fakeReader([tuple("document:doc1#viewer@user:alice")]);
    const checks: SchemaChangeCheck[] = [{ kind: "unconditional", message: "nope" }];

    await expect(evaluateWithReader(checks, reader.reader)).rejects.toThrow(
      SchemaWriteValidationException,
    );
    await expect(evaluateWithReader(checks, reader.reader)).rejects.toThrow("nope");
    expect(reader.filters).toEqual([]);
  });

  it("passes a NoOrphans check whose filter matches nothing, and moves to the next check", async () => {
    const reader = fakeReader([tuple("folder:f1#viewer@user:alice")]);
    const first: SchemaChangeCheck = {
      kind: "noOrphans",
      filter: { optionalResourceType: "document" },
      describe: () => "first",
    };
    const second: SchemaChangeCheck = { kind: "unconditional", message: "second" };

    await expect(evaluateWithReader([first, second], reader.reader)).rejects.toThrow("second");
    expect(reader.filters).toEqual([{ optionalResourceType: "document" }]);
  });

  it("resolves when every check passes", async () => {
    const reader = fakeReader([]);
    await expect(
      evaluateWithReader([{ kind: "noOrphans", filter: {}, describe: () => "x" }], reader.reader),
    ).resolves.toBeUndefined();
  });

  it("throws on the FIRST offending row and never pulls a second", async () => {
    // `await foreach (...) throw` - the loop body throws on the first element, so a large scan is
    // abandoned immediately. Eagerly materialising the query would be a behaviour change.
    const reader = fakeReader([
      tuple("document:doc1#viewer@user:alice"),
      tuple("document:doc2#viewer@user:bob"),
      tuple("document:doc3#viewer@user:carol"),
    ]);

    await expect(
      evaluateWithReader(
        [
          {
            kind: "noOrphans",
            filter: { optionalResourceType: "document" },
            describe: (r) => `offender ${r.reference.resource.objectId}`,
          },
        ],
        reader.reader,
      ),
    ).rejects.toThrow("offender doc1");

    expect(reader.pulled).toBe(1);
  });

  it("evaluates the checks in list order", async () => {
    const reader = fakeReader([tuple("document:doc1#viewer@user:alice")]);
    const checks: SchemaChangeCheck[] = [
      { kind: "noOrphans", filter: { optionalResourceType: "folder" }, describe: () => "folder" },
      {
        kind: "noOrphans",
        filter: { optionalResourceType: "document" },
        describe: () => "document",
      },
      { kind: "unconditional", message: "never reached" },
    ];

    await expect(evaluateWithReader(checks, reader.reader)).rejects.toThrow("document");
    expect(reader.filters.map((f) => f.optionalResourceType)).toEqual(["folder", "document"]);
  });

  it("rejects missing arguments", async () => {
    const reader = fakeReader([]);
    await expect(
      evaluateWithReader(undefined as unknown as SchemaChangeCheck[], reader.reader),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(evaluateWithReader([], undefined as unknown as IDatastoreReader)).rejects.toThrow(
      InvalidArgumentError,
    );
  });
});

describe("evaluateWithScanner", () => {
  /** A scanner recording the (filter, revision) pairs it is scanned with. */
  function fakeScanner(rows: readonly Relationship[]): {
    scanner: ISnapshotScanner;
    calls: { filter: RelationshipsFilter; revision: unknown }[];
  } {
    const calls: { filter: RelationshipsFilter; revision: unknown }[] = [];
    const scanner = {
      async *scan(filter: RelationshipsFilter, revision: unknown): AsyncIterable<Relationship> {
        calls.push({ filter, revision });
        for (const row of rows) if (relationshipsFilterMatches(filter, row)) yield row;
      },
    };
    return { scanner: scanner as unknown as ISnapshotScanner, calls };
  }

  it("scans at the PINNED revision and rejects on the first offending row", async () => {
    const at = new TimestampRevision(42n);
    const { scanner, calls } = fakeScanner([tuple("document:doc1#viewer@user:alice")]);

    await expect(
      evaluateWithScanner(
        [
          {
            kind: "noOrphans",
            filter: { optionalResourceType: "document" },
            describe: (r) => `offender ${r.reference.resource.objectId}`,
          },
        ],
        scanner,
        at,
      ),
    ).rejects.toThrow("offender doc1");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.revision).toBe(at);
    expect(calls[0]?.filter).toEqual({ optionalResourceType: "document" });
  });

  it("has identical semantics to the reader form: an empty scan falls through", async () => {
    const { scanner } = fakeScanner([]);
    await expect(
      evaluateWithScanner(
        [{ kind: "noOrphans", filter: {}, describe: () => "x" }],
        scanner,
        new TimestampRevision(1n),
      ),
    ).resolves.toBeUndefined();
  });

  it("throws an unconditional check without scanning", async () => {
    const { scanner, calls } = fakeScanner([tuple("document:doc1#viewer@user:alice")]);
    await expect(
      evaluateWithScanner(
        [{ kind: "unconditional", message: "nope" }],
        scanner,
        new TimestampRevision(1n),
      ),
    ).rejects.toThrow(SchemaWriteValidationException);
    expect(calls).toEqual([]);
  });

  it("rejects missing arguments", async () => {
    const { scanner } = fakeScanner([]);
    await expect(
      evaluateWithScanner(
        undefined as unknown as SchemaChangeCheck[],
        scanner,
        new TimestampRevision(1n),
      ),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      evaluateWithScanner([], undefined as unknown as ISnapshotScanner, new TimestampRevision(1n)),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      evaluateWithScanner([], scanner, undefined as unknown as TimestampRevision),
    ).rejects.toThrow(InvalidArgumentError);
  });
});

// ---- validate: ComputeChecks + EvaluateAsync, the SteelThreadTests entry point ----

describe("validate", () => {
  const current = schema([
    ns("document", rel("viewer", allowedRelationDirect("user"))),
    ns("folder", rel("viewer", allowedRelationDirect("user"))),
  ]);
  const withoutDocument = schema([ns("folder", rel("viewer", allowedRelationDirect("user")))]);

  it("accepts a removal that orphans nothing (SteelThreadTests.RunWriteSchema, accepted case)", async () => {
    const reader = fakeReader([tuple("folder:f1#viewer@user:alice")]);

    await expect(validate(current, withoutDocument, reader.reader)).resolves.toBeUndefined();
  });

  it("rejects a removal that orphans a written relationship (rejected case)", async () => {
    const reader = fakeReader([tuple("document:doc1#viewer@user:alice")]);

    await expect(validate(current, withoutDocument, reader.reader)).rejects.toThrow(
      new SchemaWriteValidationException(
        "cannot remove definition `document`: at least one relationship still references it as a resource type (e.g. document:doc1#viewer@user:alice)",
      ),
    );
  });

  it("accepts an ADDITIVE change without querying the datastore at all", async () => {
    const reader = fakeReader([tuple("document:doc1#viewer@user:alice")]);
    const additive = schema([
      ns(
        "document",
        rel("viewer", allowedRelationDirect("user")),
        rel("editor", allowedRelationDirect("user")),
      ),
      ns("folder", rel("viewer", allowedRelationDirect("user"))),
    ]);

    await expect(validate(current, additive, reader.reader)).resolves.toBeUndefined();
    expect(reader.filters).toEqual([]);
  });

  it("does NOT reject a removed caveated allowed type when live rows carry a DIFFERENT caveat", async () => {
    // The caveat clause of the removed-allowed-type filter is what makes this pass: removing
    // `user with cav1` orphans only rows carrying cav1. Dropping the clause is the exact bug the
    // C# comment warns about.
    const before = schema([
      ns(
        "document",
        rel(
          "viewer",
          allowedRelationDirect("user", "...", { caveatName: "cav1" }),
          allowedRelationDirect("user"),
        ),
      ),
    ]);
    const after = schema([ns("document", rel("viewer", allowedRelationDirect("user")))]);
    const reader = fakeReader([
      tuple("document:doc1#viewer@user:alice[cav2]"),
      tuple("document:doc2#viewer@user:bob"),
    ]);

    await expect(validate(before, after, reader.reader)).resolves.toBeUndefined();
  });

  it("DOES reject when a live row carries the removed type's own caveat", async () => {
    const before = schema([
      ns(
        "document",
        rel(
          "viewer",
          allowedRelationDirect("user", "...", { caveatName: "cav1" }),
          allowedRelationDirect("user"),
        ),
      ),
    ]);
    const after = schema([ns("document", rel("viewer", allowedRelationDirect("user")))]);
    const reader = fakeReader([tuple("document:doc1#viewer@user:alice[cav1]")]);

    await expect(validate(before, after, reader.reader)).rejects.toThrow(
      "cannot remove allowed subject type `user with cav1` from `document#viewer`: at least one relationship still references it (e.g. document:doc1#viewer@user:alice[cav1])",
    );
  });

  it("rejects missing arguments", async () => {
    const reader = fakeReader([]);
    await expect(
      validate(undefined as unknown as CompiledSchema, current, reader.reader),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      validate(current, undefined as unknown as CompiledSchema, reader.reader),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      validate(current, current, undefined as unknown as IDatastoreReader),
    ).rejects.toThrow(InvalidArgumentError);
  });
});
