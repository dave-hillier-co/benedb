import type { IRevision } from "@benedb/core/i-revision";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { IDatastoreReader } from "@benedb/datastore/i-datastore";
import { computeSchemaHash } from "@benedb/engine/schema-hash";
import { compileSchema } from "@benedb/schema/schema-compiler";

import { SchemaSnapshot } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import { computeStoredSchemaHash } from "./stored-schema-hash";

/**
 * Ported from Spiceport `Grains/SchemaResolver.cs`.
 *
 * A per-silo cache of compiled {@link SchemaSnapshot}s keyed by schema hash. The hash IS the
 * identity: a given hash always compiles to the same model, so the first caller to see a hash
 * compiles it and every later caller reuses the cached snapshot - including its lazily built
 * reachability graphs. Schemas are few and small, so the cache is left unbounded.
 *
 * Port decisions:
 *   * `ConcurrentDictionary` -> a plain `Map`. The THREE distinct operations are kept distinct,
 *     because conflating any two serves the wrong compiled schema forever, silently:
 *       - `TryAdd`      (`seed`, `#fallbackFor`, the second key in `#compileFetched`): insert only
 *         if absent, never overwrite.
 *       - `GetOrAdd`    (`getOrCompile`): an existing entry wins; the factory is not run.
 *       - `TryGetValue` (`get`, both resolve methods): a plain lookup.
 *   * The two C# `ResolveAsync` OVERLOADS become two named methods. TypeScript cannot dispatch an
 *     overload on the runtime shape of the second argument, and collapsing them into one would
 *     merge two seams the C# deliberately keeps apart.
 *   * `bool TryGet(hash, out snapshot)` -> `get(hash): SchemaSnapshot | undefined`.
 *   * No promise coalescing is added. Two concurrent misses for the same hash both fetch and both
 *     reach `#compileFetched` in C# too - `TryGetValue` is not held across the await - so
 *     single-flighting here would be a redesign, not a port.
 */
export class SchemaResolver {
  readonly #byHash = new Map<string, SchemaSnapshot>();

  /** `ConcurrentDictionary.TryAdd`: insert only if absent. */
  #tryAdd(schemaHash: string, snapshot: SchemaSnapshot): void {
    if (!this.#byHash.has(schemaHash)) this.#byHash.set(schemaHash, snapshot);
  }

  /** Returns the cached compiled snapshot for the given hash, if it has already been compiled. */
  get(schemaHash: string): SchemaSnapshot | undefined {
    return this.#byHash.get(schemaHash);
  }

  /**
   * Pre-populates the cache with an already-compiled snapshot under its OWN hash. Used at
   * registration to seed the embedded startup schema: until a `WriteSchema` persists bytes into
   * the log, every grain key carries the SEED schema's hash, and without this entry each dispatch
   * would miss the cache, pay a sequencer `readSchemaAt` hop, read `undefined`, and fall back.
   */
  seed(snapshot: SchemaSnapshot): void {
    // `ArgumentNullException.ThrowIfNull(snapshot);`
    if (snapshot === undefined || snapshot === null) {
      throw new InvalidArgumentError("snapshot is required");
    }
    this.#tryAdd(snapshot.schemaHash, snapshot);
  }

  /**
   * Resolves the compiled schema named by `schemaHash` at the revision `reader` is pinned to: a
   * cache hit is a pure lookup; a miss reads the schema bytes persisted at the revision and
   * compiles-and-caches them. Returns `fallback` when the revision pins no schema hash, or holds
   * no persisted schema (the seed-only window).
   *
   * The first C# `ResolveAsync` overload.
   */
  async resolveWithReader(
    schemaHash: string | undefined,
    reader: IDatastoreReader,
    fallback: SchemaSnapshot,
    signal?: AbortSignal | undefined,
  ): Promise<SchemaSnapshot> {
    if (reader === undefined || reader === null) {
      throw new InvalidArgumentError("reader is required");
    }
    if (fallback === undefined || fallback === null) {
      throw new InvalidArgumentError("fallback is required");
    }

    // `string.IsNullOrEmpty(schemaHash)` - BOTH absent and the empty string.
    if (schemaHash === undefined || schemaHash === null || schemaHash === "") return fallback;
    const cached = this.#byHash.get(schemaHash);
    if (cached !== undefined) return cached;

    const bytes = await reader.readStoredSchema(signal);
    return bytes === undefined || bytes === null
      ? this.#fallbackFor(schemaHash, fallback)
      : this.#compileFetched(bytes);
  }

  /**
   * Resolves the compiled schema named by `schemaHash` at the pinned `revision` through the
   * {@link ISchemaSource} seam: a cache hit is a pure lookup; a miss reads the schema bytes
   * persisted at the revision straight from the sequencer's fold (so the hop happens once per hash
   * per silo) and compiles-and-caches them. Returns `fallback` when the revision pins no schema
   * hash, or holds no persisted schema (the seed-only window).
   *
   * The second C# `ResolveAsync` overload. Its early-return sequence is deliberately identical to
   * {@link resolveWithReader}'s.
   */
  async resolveWithSource(
    schemaHash: string | undefined,
    source: ISchemaSource,
    revision: IRevision,
    fallback: SchemaSnapshot,
    signal?: AbortSignal | undefined,
  ): Promise<SchemaSnapshot> {
    if (source === undefined || source === null) {
      throw new InvalidArgumentError("source is required");
    }
    if (revision === undefined || revision === null) {
      throw new InvalidArgumentError("revision is required");
    }
    if (fallback === undefined || fallback === null) {
      throw new InvalidArgumentError("fallback is required");
    }

    if (schemaHash === undefined || schemaHash === null || schemaHash === "") return fallback;
    const cached = this.#byHash.get(schemaHash);
    if (cached !== undefined) return cached;

    const bytes = await source.readSchemaAt(revision, signal);
    return bytes === undefined || bytes === null
      ? this.#fallbackFor(schemaHash, fallback)
      : this.#compileFetched(bytes);
  }

  /**
   * The no-persisted-schema (seed-window) fallback. When the requested hash IS the fallback's own
   * hash, the label provably names the fallback's bytes, so the fallback is cached under it -
   * turning the per-dispatch miss-fetch-null-fall-back cycle into a one-time event per silo. A
   * requested hash that DIFFERS from the fallback's is an ambiguous label with no bytes to verify
   * it against; it stays UNCACHED and serves the fallback for this call only. That asymmetry is
   * the whole point of the method.
   */
  #fallbackFor(schemaHash: string, fallback: SchemaSnapshot): SchemaSnapshot {
    if (schemaHash === fallback.schemaHash) this.#tryAdd(schemaHash, fallback);
    return fallback;
  }

  /**
   * Compiles-and-caches bytes fetched on a cache miss under their ACTUAL computed hash - never
   * under the requested hash. A token can pair a fresh revision with a stale silo-local hash;
   * caching the fetched bytes under that mismatched requested hash would poison the cache
   * PERMANENTLY.
   *
   * Dual-key rationale: the bytes are indexed under BOTH their stored-bytes hash (a raw SHA-256
   * over the persisted UTF-8 - what the log folds a schema write's hash as) AND their structural
   * hash (what `MutableSchemaProvider.currentSchemaHash`, and therefore every dispatch grain key,
   * pins). The two hash spaces are different functions of the same bytes, so a lookup keyed by one
   * alone would never hit an entry cached only under the other. Both are pure, always-correct
   * functions of the compiled model actually produced, so neither entry can name the wrong schema.
   *
   * The returned snapshot's own `schemaHash` is the STORED hash, not the structural one.
   */
  #compileFetched(bytes: Uint8Array): SchemaSnapshot {
    const snapshot = this.getOrCompile(computeStoredSchemaHash(bytes), bytes);
    this.#tryAdd(computeSchemaHash(snapshot.namespaces, snapshot.caveats), snapshot);
    return snapshot;
  }

  /**
   * Returns the compiled snapshot for `schemaHash`, compiling `schemaBytes` on first sight and
   * caching the result. `schemaBytes` is the UTF-8 schema DSL persisted at the revision (the exact
   * bytes a `WriteSchema` stored); it is consulted only on a cache miss.
   */
  getOrCompile(schemaHash: string, schemaBytes: Uint8Array): SchemaSnapshot {
    if (schemaHash === undefined || schemaHash === null) {
      throw new InvalidArgumentError("schemaHash is required");
    }
    if (schemaBytes === undefined || schemaBytes === null) {
      throw new InvalidArgumentError("schemaBytes is required");
    }
    // `GetOrAdd`: the factory is not run when the key is present.
    const existing = this.#byHash.get(schemaHash);
    if (existing !== undefined) return existing;
    const compiled = compile(schemaHash, schemaBytes);
    this.#byHash.set(schemaHash, compiled);
    return compiled;
  }
}

function compile(schemaHash: string, schemaBytes: Uint8Array): SchemaSnapshot {
  const text = new TextDecoder().decode(schemaBytes);
  const compiled = compileSchema(text);
  // The persisted hash is authoritative (computed and validated at write time); reuse it VERBATIM
  // so a resolved snapshot's hash matches the grain key that selected it, rather than recomputing.
  return new SchemaSnapshot(compiled, schemaHash, text, 0);
}
