import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import type { IDatastoreReader } from "@spacedb/datastore/i-datastore";
import { computeSchemaHash } from "@spacedb/engine/schema-hash";
import { SchemaCompileException } from "@spacedb/schema/schema-compile-exception";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { SchemaSnapshot } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import { SchemaResolver } from "./schema-resolver";
import { computeStoredSchemaHash } from "./stored-schema-hash";

/**
 * No covering C# test - a characterization of `Grains/SchemaResolver.cs`.
 *
 * Three distinct `ConcurrentDictionary` operations are in play and conflating any two of them
 * serves the WRONG compiled schema forever, silently:
 *   * `TryAdd`      - Seed, FallbackFor, the second key in CompileFetched. Insert only if absent.
 *   * `GetOrAdd`    - GetOrCompile. Existing entry wins; the factory is not run.
 *   * `TryGetValue` - TryGet and both ResolveAsync overloads. A plain lookup.
 *
 * The C# `ResolveAsync` OVERLOADS become two named methods (`resolveWithReader` /
 * `resolveWithSource`); they are deliberately NOT collapsed, and the shared table below is run
 * against both so their identical early-return sequence stays identical.
 */

const SCHEMA_TEXT = "definition user {}\n\ndefinition document {\n  relation viewer: user\n}";
const OTHER_SCHEMA_TEXT = "definition user {}\n\ndefinition folder {\n  relation reader: user\n}";
const SCHEMA_BYTES = new TextEncoder().encode(SCHEMA_TEXT);

function structuralHashOf(schemaText: string): string {
  const compiled = compileSchema(schemaText);
  return computeSchemaHash(compiled.namespaces, compiled.caveats);
}

function snapshotOf(schemaText: string, hash = structuralHashOf(schemaText)): SchemaSnapshot {
  return new SchemaSnapshot(compileSchema(schemaText), hash, schemaText, 0);
}

/** Records every fetch so "the reader was not consulted" is assertable, not assumed. */
function fakeReader(bytes: Uint8Array | undefined): {
  readonly reader: IDatastoreReader;
  readonly calls: { count: number };
} {
  const calls = { count: 0 };
  const reader = {
    readStoredSchema(): Promise<Uint8Array | undefined> {
      calls.count += 1;
      return Promise.resolve(bytes);
    },
  } as unknown as IDatastoreReader;
  return { reader, calls };
}

function fakeSource(bytes: Uint8Array | undefined): {
  readonly source: ISchemaSource;
  readonly calls: { count: number };
} {
  const calls = { count: 0 };
  const source: ISchemaSource = {
    readSchemaAt(): Promise<Uint8Array | undefined> {
      calls.count += 1;
      return Promise.resolve(bytes);
    },
  };
  return { source, calls };
}

const REVISION: IRevision = new TimestampRevision(42n);

/**
 * The two overloads share one body shape, so every early-return case is asserted against both
 * through this adapter rather than written twice and allowed to drift.
 */
interface ResolveVariant {
  readonly name: string;
  resolve(
    resolver: SchemaResolver,
    schemaHash: string | undefined,
    bytes: Uint8Array | undefined,
    fallback: SchemaSnapshot,
  ): Promise<{ readonly snapshot: SchemaSnapshot; readonly fetches: number }>;
}

const VARIANTS: readonly ResolveVariant[] = [
  {
    name: "resolveWithReader",
    async resolve(resolver, schemaHash, bytes, fallback) {
      const { reader, calls } = fakeReader(bytes);
      const snapshot = await resolver.resolveWithReader(schemaHash, reader, fallback);
      return { snapshot, fetches: calls.count };
    },
  },
  {
    name: "resolveWithSource",
    async resolve(resolver, schemaHash, bytes, fallback) {
      const { source, calls } = fakeSource(bytes);
      const snapshot = await resolver.resolveWithSource(schemaHash, source, REVISION, fallback);
      return { snapshot, fetches: calls.count };
    },
  },
];

describe("SchemaResolver.get", () => {
  it("returns undefined for a hash never seen", () => {
    // `TryGetValue` with the out-param folded into an optional return.
    expect(new SchemaResolver().get("nope")).toBeUndefined();
  });

  it("returns the seeded snapshot by identity", () => {
    const resolver = new SchemaResolver();
    const snapshot = snapshotOf(SCHEMA_TEXT);
    resolver.seed(snapshot);

    expect(resolver.get(snapshot.schemaHash)).toBe(snapshot);
  });
});

describe("SchemaResolver.seed", () => {
  it("keys the snapshot under its OWN hash", () => {
    // `_byHash.TryAdd(snapshot.SchemaHash, snapshot);`
    const resolver = new SchemaResolver();
    const snapshot = snapshotOf(SCHEMA_TEXT, "stored-hash-of-the-seed");
    resolver.seed(snapshot);

    expect(resolver.get("stored-hash-of-the-seed")).toBe(snapshot);
    expect(resolver.get(structuralHashOf(SCHEMA_TEXT))).toBeUndefined();
  });

  it("is TryAdd: a second seed under the same hash does NOT overwrite", () => {
    const resolver = new SchemaResolver();
    const first = snapshotOf(SCHEMA_TEXT, "same-hash");
    const second = snapshotOf(OTHER_SCHEMA_TEXT, "same-hash");

    resolver.seed(first);
    resolver.seed(second);

    expect(resolver.get("same-hash")).toBe(first);
  });

  it("rejects a null/undefined snapshot", () => {
    // `ArgumentNullException.ThrowIfNull(snapshot);`
    expect(() => new SchemaResolver().seed(undefined as unknown as SchemaSnapshot)).toThrow(
      InvalidArgumentError,
    );
  });
});

describe("SchemaResolver.getOrCompile", () => {
  it("compiles the UTF-8 bytes and reuses the passed hash VERBATIM", () => {
    // `return new SchemaSnapshot(compiled, schemaHash, text, Version: 0);` - the hash is NOT
    // recomputed, so a resolved snapshot's hash matches the grain key that selected it.
    const snapshot = new SchemaResolver().getOrCompile("a-label-not-a-hash", SCHEMA_BYTES);

    expect(snapshot.schemaHash).toBe("a-label-not-a-hash");
    expect(snapshot.version).toBe(0);
    expect(snapshot.sourceText).toBe(SCHEMA_TEXT);
    expect(snapshot.namespaces.map((n) => n.name)).toEqual(["user", "document"]);
  });

  it("decodes with UTF-8, multi-byte sequences included", () => {
    // `Encoding.UTF8.GetString(bytes)` -> `new TextDecoder().decode(bytes)`.
    const text = "// café \u{1f600}\ndefinition user {}";
    const snapshot = new SchemaResolver().getOrCompile("h", new TextEncoder().encode(text));

    expect(snapshot.sourceText).toBe(text);
  });

  it("is GetOrAdd: the second call returns the cached instance and never recompiles", () => {
    // The factory is not invoked when the key is present, so DIFFERENT bytes under the same hash
    // are ignored entirely - the existing entry wins.
    const resolver = new SchemaResolver();
    const first = resolver.getOrCompile("h", SCHEMA_BYTES);

    const second = resolver.getOrCompile("h", new TextEncoder().encode(OTHER_SCHEMA_TEXT));

    expect(second).toBe(first);
    expect(second.sourceText).toBe(SCHEMA_TEXT);
  });

  it("does not overwrite a seeded entry", () => {
    const resolver = new SchemaResolver();
    const seeded = snapshotOf(OTHER_SCHEMA_TEXT, "h");
    resolver.seed(seeded);

    expect(resolver.getOrCompile("h", SCHEMA_BYTES)).toBe(seeded);
  });

  it("caches under the hash so a later get hits", () => {
    const resolver = new SchemaResolver();
    const snapshot = resolver.getOrCompile("h", SCHEMA_BYTES);

    expect(resolver.get("h")).toBe(snapshot);
  });

  it("propagates a compile failure and caches nothing", () => {
    const resolver = new SchemaResolver();

    expect(() => resolver.getOrCompile("h", new TextEncoder().encode("definition {"))).toThrow(
      SchemaCompileException,
    );
    expect(resolver.get("h")).toBeUndefined();
  });

  it("rejects a null/undefined hash or bytes", () => {
    // The two `ArgumentNullException.ThrowIfNull` guards.
    const resolver = new SchemaResolver();

    expect(() => resolver.getOrCompile(undefined as unknown as string, SCHEMA_BYTES)).toThrow(
      InvalidArgumentError,
    );
    expect(() => resolver.getOrCompile("h", undefined as unknown as Uint8Array)).toThrow(
      InvalidArgumentError,
    );
  });
});

describe.each(VARIANTS)("SchemaResolver.$name", (variant) => {
  it("returns the fallback WITHOUT fetching when the hash is undefined", async () => {
    // `if (string.IsNullOrEmpty(schemaHash)) return fallback;` - step 1 of the sequence.
    const fallback = snapshotOf(SCHEMA_TEXT);
    const result = await variant.resolve(new SchemaResolver(), undefined, SCHEMA_BYTES, fallback);

    expect(result.snapshot).toBe(fallback);
    expect(result.fetches).toBe(0);
  });

  it("returns the fallback WITHOUT fetching when the hash is the empty string", async () => {
    // IsNullOrEmpty covers "" as well as null; a bare `=== undefined` check would fetch here.
    const fallback = snapshotOf(SCHEMA_TEXT);
    const result = await variant.resolve(new SchemaResolver(), "", SCHEMA_BYTES, fallback);

    expect(result.snapshot).toBe(fallback);
    expect(result.fetches).toBe(0);
  });

  it("does not cache the fallback under the empty hash", async () => {
    const resolver = new SchemaResolver();
    const fallback = snapshotOf(SCHEMA_TEXT);

    await variant.resolve(resolver, "", SCHEMA_BYTES, fallback);

    expect(resolver.get("")).toBeUndefined();
  });

  it("returns the cached snapshot WITHOUT fetching on a hit", async () => {
    // Step 2: `if (_byHash.TryGetValue(schemaHash, out var cached)) return cached;`
    const resolver = new SchemaResolver();
    const cached = snapshotOf(OTHER_SCHEMA_TEXT, "cached-hash");
    resolver.seed(cached);
    const fallback = snapshotOf(SCHEMA_TEXT);

    const result = await variant.resolve(resolver, "cached-hash", SCHEMA_BYTES, fallback);

    expect(result.snapshot).toBe(cached);
    expect(result.fetches).toBe(0);
  });

  it("caches the fallback under the requested hash when the hash IS the fallback's", async () => {
    // FallbackFor: "the label provably names the fallback's bytes, so the fallback is cached
    // under it - turning the per-dispatch miss-fetch-null-fall-back cycle into a one-time event".
    const resolver = new SchemaResolver();
    const fallback = snapshotOf(SCHEMA_TEXT);

    const first = await variant.resolve(resolver, fallback.schemaHash, undefined, fallback);

    expect(first.snapshot).toBe(fallback);
    expect(first.fetches).toBe(1);
    expect(resolver.get(fallback.schemaHash)).toBe(fallback);

    // The now-cached entry means the second call is a pure lookup.
    const second = await variant.resolve(resolver, fallback.schemaHash, undefined, fallback);
    expect(second.snapshot).toBe(fallback);
    expect(second.fetches).toBe(0);
  });

  it("leaves a DIFFERENT requested hash uncached, serving the fallback for that call only", async () => {
    // "A requested hash that differs from the fallback's is an ambiguous label with no bytes to
    // verify it against; it stays uncached and serves the fallback for this call only."
    const resolver = new SchemaResolver();
    const fallback = snapshotOf(SCHEMA_TEXT);

    const first = await variant.resolve(resolver, "some-other-hash", undefined, fallback);

    expect(first.snapshot).toBe(fallback);
    expect(resolver.get("some-other-hash")).toBeUndefined();

    // Uncached means the fetch happens again, every time.
    const second = await variant.resolve(resolver, "some-other-hash", undefined, fallback);
    expect(second.snapshot).toBe(fallback);
    expect(second.fetches).toBe(1);
  });

  it("compiles fetched bytes under their STORED hash, never the requested one", async () => {
    // CompileFetched: `GetOrCompile(StoredSchemaHash.Compute(bytes), bytes)`. Caching under the
    // requested hash "would poison the cache PERMANENTLY".
    const resolver = new SchemaResolver();
    const fallback = snapshotOf(OTHER_SCHEMA_TEXT);
    const storedHash = computeStoredSchemaHash(SCHEMA_BYTES);

    const result = await variant.resolve(resolver, "a-stale-label", SCHEMA_BYTES, fallback);

    expect(result.snapshot.schemaHash).toBe(storedHash);
    expect(result.snapshot.sourceText).toBe(SCHEMA_TEXT);
    expect(resolver.get(storedHash)).toBe(result.snapshot);
    expect(resolver.get("a-stale-label")).toBeUndefined();
  });

  it("dual-keys the SAME snapshot under the structural hash too", async () => {
    // `_byHash.TryAdd(SchemaHash.Compute(snapshot.Namespaces, snapshot.Caveats), snapshot);`
    const resolver = new SchemaResolver();
    const fallback = snapshotOf(OTHER_SCHEMA_TEXT);

    const result = await variant.resolve(resolver, "a-stale-label", SCHEMA_BYTES, fallback);

    const structural = structuralHashOf(SCHEMA_TEXT);
    expect(structural).not.toBe(computeStoredSchemaHash(SCHEMA_BYTES));
    expect(resolver.get(structural)).toBe(result.snapshot);
    // The snapshot's OWN hash stays the stored one, so the grain key that selected it matches.
    expect(result.snapshot.schemaHash).not.toBe(structural);
  });

  it("does not overwrite an existing entry under the structural hash", async () => {
    // The second key is TryAdd, not an assignment.
    const resolver = new SchemaResolver();
    const structural = structuralHashOf(SCHEMA_TEXT);
    const squatter = snapshotOf(OTHER_SCHEMA_TEXT, structural);
    resolver.seed(squatter);
    const fallback = snapshotOf(OTHER_SCHEMA_TEXT);

    const result = await variant.resolve(resolver, "a-stale-label", SCHEMA_BYTES, fallback);

    expect(resolver.get(structural)).toBe(squatter);
    expect(result.snapshot).not.toBe(squatter);
  });

  it("reuses an already-compiled stored-hash entry instead of recompiling", async () => {
    // GetOrAdd on the stored hash: a snapshot already cached under it wins.
    const resolver = new SchemaResolver();
    const storedHash = computeStoredSchemaHash(SCHEMA_BYTES);
    const preexisting = snapshotOf(OTHER_SCHEMA_TEXT, storedHash);
    resolver.seed(preexisting);
    const fallback = snapshotOf(OTHER_SCHEMA_TEXT);

    const result = await variant.resolve(resolver, "a-stale-label", SCHEMA_BYTES, fallback);

    expect(result.snapshot).toBe(preexisting);
    // The dual key is derived from the RETURNED snapshot's model, not from the fetched bytes.
    expect(resolver.get(structuralHashOf(OTHER_SCHEMA_TEXT))).toBe(preexisting);
  });

  it("treats zero-length fetched bytes as a schema, not as the seed window", async () => {
    // `bytes is null ? FallbackFor(...) : CompileFetched(bytes)` branches on NULL only.
    const resolver = new SchemaResolver();
    const fallback = snapshotOf(SCHEMA_TEXT);
    const empty = new Uint8Array(0);

    const result = await variant.resolve(resolver, "label", empty, fallback);

    expect(result.snapshot).not.toBe(fallback);
    expect(result.snapshot.namespaces).toEqual([]);
    expect(resolver.get(computeStoredSchemaHash(empty))).toBe(result.snapshot);
  });
});

describe("SchemaResolver.resolveWithReader argument guards", () => {
  it("rejects a null reader or fallback BEFORE the empty-hash early return", async () => {
    // The ThrowIfNull guards are the first statements, so an empty hash does not save the caller.
    const resolver = new SchemaResolver();
    const fallback = snapshotOf(SCHEMA_TEXT);

    await expect(
      resolver.resolveWithReader("", undefined as unknown as IDatastoreReader, fallback),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      resolver.resolveWithReader(
        "",
        fakeReader(undefined).reader,
        undefined as unknown as SchemaSnapshot,
      ),
    ).rejects.toThrow(InvalidArgumentError);
  });
});

describe("SchemaResolver.resolveWithSource argument guards", () => {
  it("rejects a null source, revision or fallback BEFORE the empty-hash early return", async () => {
    const resolver = new SchemaResolver();
    const fallback = snapshotOf(SCHEMA_TEXT);
    const { source } = fakeSource(undefined);

    await expect(
      resolver.resolveWithSource("", undefined as unknown as ISchemaSource, REVISION, fallback),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      resolver.resolveWithSource("", source, undefined as unknown as IRevision, fallback),
    ).rejects.toThrow(InvalidArgumentError);
    await expect(
      resolver.resolveWithSource("", source, REVISION, undefined as unknown as SchemaSnapshot),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it("passes the pinned revision through to the source", async () => {
    const resolver = new SchemaResolver();
    const seen: IRevision[] = [];
    const source: ISchemaSource = {
      readSchemaAt(revision: IRevision): Promise<Uint8Array | undefined> {
        seen.push(revision);
        return Promise.resolve(undefined);
      },
    };

    await resolver.resolveWithSource("label", source, REVISION, snapshotOf(SCHEMA_TEXT));

    expect(seen).toEqual([REVISION]);
  });
});

describe("SchemaResolver concurrency", () => {
  it("does NOT single-flight concurrent misses for the same hash", async () => {
    // `TryGetValue` is not held across the await in C# either: two concurrent misses both fetch
    // and both reach CompileFetched. Adding promise coalescing would be a redesign, not a port.
    const resolver = new SchemaResolver();
    const fallback = snapshotOf(OTHER_SCHEMA_TEXT);
    let fetches = 0;
    const source: ISchemaSource = {
      async readSchemaAt(): Promise<Uint8Array | undefined> {
        fetches += 1;
        await Promise.resolve();
        return SCHEMA_BYTES;
      },
    };

    const [a, b] = await Promise.all([
      resolver.resolveWithSource("label", source, REVISION, fallback),
      resolver.resolveWithSource("label", source, REVISION, fallback),
    ]);

    expect(fetches).toBe(2);
    // GetOrAdd still collapses them onto ONE cached snapshot under the stored hash.
    expect(a).toBe(b);
    expect(resolver.get(computeStoredSchemaHash(SCHEMA_BYTES))).toBe(a);
  });
});
