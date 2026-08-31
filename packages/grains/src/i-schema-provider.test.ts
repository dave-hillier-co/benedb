import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { computeSchemaHash } from "@benedb/engine/schema-hash";
import type { CompiledSchema } from "@benedb/schema/compiled-schema";
import { SchemaCompileException } from "@benedb/schema/schema-compile-exception";
import { compileSchema } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { MutableSchemaProvider, SchemaSnapshot } from "./i-schema-provider";

/**
 * No covering C# test - a characterization of `Grains/ISchemaProvider.cs` (`SchemaSnapshot`,
 * `ISchemaProvider`, `MutableSchemaProvider`).
 *
 * Every expectation below is derived from the C# source, not from the TypeScript implementation.
 * The two behaviours that are easy to lose in translation, and that nothing downstream re-checks
 * until the mesh suites land, are:
 *
 *   1. The three `Lazy<T>` fields are PER-INSTANCE and ONCE-ONLY. `LazyThreadSafetyMode` maps to
 *      nothing on a single-threaded event loop, but "built at most once per snapshot" and
 *      "dropped for GC when the snapshot is swapped" both do: a module-level cache would make two
 *      snapshots of the same schema share a graph, which the C# comment explicitly rules out.
 *   2. `Update()` compiles FIRST and assigns SECOND ("a compile failure throws here, BEFORE any
 *      swap, so _current is never torn").
 */

const SCHEMA_TEXT = `definition user {}

definition document {
  relation viewer: user
  permission view = viewer
}`;

const OTHER_SCHEMA_TEXT = `definition user {}

definition folder {
  relation reader: user
  permission read = reader
}`;

function snapshotOf(schemaText: string, version = 0): SchemaSnapshot {
  const compiled = compileSchema(schemaText);
  return new SchemaSnapshot(
    compiled,
    computeSchemaHash(compiled.namespaces, compiled.caveats),
    schemaText,
    version,
  );
}

describe("SchemaSnapshot", () => {
  it("carries the four constructor components verbatim", () => {
    const compiled = compileSchema(SCHEMA_TEXT);
    const snapshot = new SchemaSnapshot(compiled, "hash-abc", SCHEMA_TEXT, 7);

    expect(snapshot.schema).toBe(compiled);
    // The hash is whatever the caller passed. `SchemaResolver.Compile` depends on this: it reuses
    // the persisted hash verbatim rather than recomputing, so the snapshot must not "correct" it.
    expect(snapshot.schemaHash).toBe("hash-abc");
    expect(snapshot.sourceText).toBe(SCHEMA_TEXT);
    expect(snapshot.version).toBe(7);
  });

  it("projects Namespaces and Caveats straight off the compiled schema", () => {
    // `public ImmutableList<NamespaceDefinition> Namespaces => Schema.Namespaces;`
    const compiled = compileSchema(
      "caveat only_odd(v int) {\n  v % 2 == 1\n}\n\ndefinition user {}",
    );
    const snapshot = new SchemaSnapshot(compiled, "h", "", 0);

    expect(snapshot.namespaces).toBe(compiled.namespaces);
    expect(snapshot.caveats).toBe(compiled.caveats);
  });

  it("builds each of the three lazies at most once per snapshot", () => {
    const snapshot = snapshotOf(SCHEMA_TEXT);

    // `Lazy<T>.Value` returns the SAME instance on every read of THIS snapshot.
    expect(snapshot.reachabilityFull).toBe(snapshot.reachabilityFull);
    expect(snapshot.reachabilityFirst).toBe(snapshot.reachabilityFirst);
    expect(snapshot.membershipCoverage).toBe(snapshot.membershipCoverage);
  });

  it("keeps the full and first reachability graphs distinct", () => {
    // Two separate Lazy cells built with ReachabilityMode.Full and ReachabilityMode.First.
    const snapshot = snapshotOf(SCHEMA_TEXT);

    expect(snapshot.reachabilityFull).not.toBe(snapshot.reachabilityFirst);
  });

  it("gives every snapshot its OWN lazies - there is no process-wide cache", () => {
    // "a schema Update() constructs a brand-new SchemaSnapshot (and hence fresh Lazy<> cells), so
    // the graph is dropped for GC when the snapshot is swapped rather than accumulating in a
    // process-wide cache". Identical text and identical hash must still not share a graph.
    const first = snapshotOf(SCHEMA_TEXT);
    const second = snapshotOf(SCHEMA_TEXT);

    expect(second.schemaHash).toBe(first.schemaHash);
    expect(second.reachabilityFull).not.toBe(first.reachabilityFull);
    expect(second.reachabilityFirst).not.toBe(first.reachabilityFirst);
    expect(second.membershipCoverage).not.toBe(first.membershipCoverage);
  });

  it("builds the graphs from THIS snapshot's own namespaces", () => {
    // `ReachabilityGraph.Build(Schema.Namespaces.ToImmutableDictionary(ns => ns.Name), ...)` -
    // the map comes from the snapshot's own compiled schema, never from an ambient source.
    const snapshot = snapshotOf(SCHEMA_TEXT);

    const targets = snapshot.reachabilityFull.targets.map((t) => `${t.namespace}#${t.relation}`);
    expect(targets).toContain("document#view");
    expect(targets.some((t) => t.startsWith("folder#"))).toBe(false);
  });

  it("is LAZY: a schema whose graph build would throw still constructs", () => {
    // The Lazy factory does not run in the constructor. A duplicate namespace name makes
    // `ToImmutableDictionary(ns => ns.Name)` throw, but only on first Value read.
    const duplicated: CompiledSchema = {
      namespaces: [
        { name: "user", relations: [] },
        { name: "user", relations: [] },
      ] satisfies NamespaceDefinition[],
      caveats: [],
    };

    const snapshot = new SchemaSnapshot(duplicated, "h", "", 0);

    expect(snapshot.namespaces).toHaveLength(2);
    // `ToImmutableDictionary` throws on a duplicate key; both graph builds and the coverage build
    // key by name, so all three surface it - lazily, on access.
    expect(() => snapshot.reachabilityFull).toThrow(InvalidArgumentError);
    expect(() => snapshot.reachabilityFirst).toThrow(InvalidArgumentError);
    expect(() => snapshot.membershipCoverage).toThrow(InvalidArgumentError);
  });

  it("has no value equality - the provider swaps by reference", () => {
    // The C# `sealed record` generates one, but nothing in Spiceport calls it, so the port does
    // not build one. Two snapshots of the same schema are distinct objects.
    const first = snapshotOf(SCHEMA_TEXT);
    const second = snapshotOf(SCHEMA_TEXT);

    expect(second).not.toBe(first);
  });
});

describe("MutableSchemaProvider", () => {
  it("compiles the seed text immediately at version 0", () => {
    // `_current = Compile(schemaText, version: 0);`
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);

    expect(provider.current.version).toBe(0);
    expect(provider.current.sourceText).toBe(SCHEMA_TEXT);
    expect(provider.current.namespaces.map((n) => n.name)).toEqual(["user", "document"]);
  });

  it("hashes with SchemaHash.Compute over the COMPILED model", () => {
    // `var hash = SchemaHash.Compute(compiled.Namespaces, compiled.Caveats);` - the structural
    // hash, not a hash of the source text.
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);
    const compiled = compileSchema(SCHEMA_TEXT);

    expect(provider.current.schemaHash).toBe(
      computeSchemaHash(compiled.namespaces, compiled.caveats),
    );
  });

  it("exposes the same hash through the ISchemaHashSource seam", () => {
    // `public string CurrentSchemaHash => _current.SchemaHash;`
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);

    expect(provider.currentSchemaHash).toBe(provider.current.schemaHash);
  });

  it("re-reads the hash through the seam after a swap", () => {
    // The remark's whole point: the dispatch mesh reads the hash PER REQUEST, so a swap must be
    // visible through a property read, never a value captured at construction.
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);
    const before = provider.currentSchemaHash;

    provider.update(OTHER_SCHEMA_TEXT);

    expect(provider.currentSchemaHash).not.toBe(before);
    expect(provider.currentSchemaHash).toBe(provider.current.schemaHash);
  });

  it("keeps SourceText verbatim so ReadSchema round-trips", () => {
    // "CompiledSchema is lossy; this round-trips ReadSchema" - comments and layout survive.
    const text = "// leading comment\ndefinition user {}\n\n// trailing\n";
    const provider = new MutableSchemaProvider(text);

    expect(provider.current.sourceText).toBe(text);
  });

  it("returns the newly installed snapshot from Update and swaps Current to it", () => {
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);

    const next = provider.update(OTHER_SCHEMA_TEXT);

    expect(provider.current).toBe(next);
    expect(next.sourceText).toBe(OTHER_SCHEMA_TEXT);
  });

  it("increments Version monotonically, never resetting", () => {
    // `Compile(schemaText, _current.Version + 1)`.
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);

    expect(provider.update(OTHER_SCHEMA_TEXT).version).toBe(1);
    expect(provider.update(SCHEMA_TEXT).version).toBe(2);
    expect(provider.update(SCHEMA_TEXT).version).toBe(3);
  });

  it("increments Version even when the schema is unchanged", () => {
    // Version counts UPDATES, not distinct schemas: there is no equality short-circuit.
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);
    const before = provider.current;

    const next = provider.update(SCHEMA_TEXT);

    expect(next).not.toBe(before);
    expect(next.schemaHash).toBe(before.schemaHash);
    expect(next.version).toBe(1);
  });

  it("leaves Current untorn when the update text fails to compile", () => {
    // "Compile first: a compile failure throws here, BEFORE any swap, so _current is never torn."
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);
    const before = provider.current;

    expect(() => provider.update("definition {")).toThrow(SchemaCompileException);

    expect(provider.current).toBe(before);
    expect(provider.current.version).toBe(0);
    expect(provider.currentSchemaHash).toBe(before.schemaHash);
  });

  it("still numbers the NEXT successful update from the unchanged version", () => {
    // A failed Update must not consume a version number, because it never touched _current.
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);
    expect(() => provider.update("definition {")).toThrow(SchemaCompileException);

    expect(provider.update(OTHER_SCHEMA_TEXT).version).toBe(1);
  });

  it("throws when the seed text fails to compile", () => {
    expect(() => new MutableSchemaProvider("definition {")).toThrow(SchemaCompileException);
  });

  it("accepts the empty schema - empty is not null", () => {
    // `ArgumentNullException.ThrowIfNull` guards null only; "" compiles to an empty model.
    const provider = new MutableSchemaProvider("");

    expect(provider.current.namespaces).toEqual([]);
    expect(provider.current.caveats).toEqual([]);
    expect(provider.current.version).toBe(0);
  });

  it("rejects a null/undefined seed text", () => {
    // `ArgumentNullException.ThrowIfNull(schemaText);` in the constructor.
    expect(() => new MutableSchemaProvider(undefined as unknown as string)).toThrow(
      InvalidArgumentError,
    );
    expect(() => new MutableSchemaProvider(null as unknown as string)).toThrow(
      InvalidArgumentError,
    );
  });

  it("rejects a null/undefined update text without touching Current", () => {
    // `ArgumentNullException.ThrowIfNull(schemaText);` in Update, BEFORE the compile.
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);
    const before = provider.current;

    expect(() => provider.update(undefined as unknown as string)).toThrow(InvalidArgumentError);
    expect(() => provider.update(null as unknown as string)).toThrow(InvalidArgumentError);

    expect(provider.current).toBe(before);
  });

  it("lets an in-flight reader keep its captured snapshot across a swap", () => {
    // "in-flight readers keep their captured snapshot; new readers see the new one."
    const provider = new MutableSchemaProvider(SCHEMA_TEXT);
    const captured = provider.current;

    provider.update(OTHER_SCHEMA_TEXT);

    expect(captured.version).toBe(0);
    expect(captured.namespaces.map((n) => n.name)).toEqual(["user", "document"]);
    expect(provider.current.namespaces.map((n) => n.name)).toEqual(["user", "folder"]);
  });
});
