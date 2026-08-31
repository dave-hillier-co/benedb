import type { CaveatDefinition } from "@benedb/core/caveat-definition";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import type { ISchemaHashSource } from "@benedb/engine/i-schema-hash-source";
import {
  buildMembershipCoverage,
  type MembershipCoverage,
} from "@benedb/engine/membership-coverage";
import { buildReachabilityGraph, type ReachabilityGraph } from "@benedb/engine/reachability-graph";
import { computeSchemaHash } from "@benedb/engine/schema-hash";
import type { CompiledSchema } from "@benedb/schema/compiled-schema";
import { compileSchema } from "@benedb/schema/schema-compiler";

/**
 * Ported from Spiceport `Grains/ISchemaProvider.cs`, which declares THREE types in one file:
 * `SchemaSnapshot`, `ISchemaProvider` and `MutableSchemaProvider`. The port ledger maps the file
 * to one module, so the "one primary export per file" rule bends here exactly as it did for
 * `datastore-dtos.ts`: the three belong to one seam and splitting them buys nothing.
 *
 * Port decisions:
 *   * `SchemaSnapshot` is a CLASS, not the house-preferred readonly interface. The C# `sealed
 *     record` carries three private `Lazy<T>` cells, and per-instance memoisation is state a plain
 *     interface cannot hold. `LazyThreadSafetyMode.ExecutionAndPublication` maps to nothing on a
 *     single-threaded event loop; the ONCE-ONLY semantics it also carries do map, as a private
 *     field written on first read.
 *   * Record VALUE equality on `SchemaSnapshot` is never used anywhere in Spiceport - the provider
 *     swaps by reference - so no `equals` is built.
 *   * `private volatile SchemaSnapshot _current` plus the atomic reference swap is a single field
 *     assignment here. What DOES port is the ORDER in `Update`: compile first, assign second.
 */

/**
 * `Schema.Namespaces.ToImmutableDictionary(ns => ns.Name)` - the map the reachability builds take,
 * derived from THIS snapshot's own namespaces and from no ambient source.
 *
 * `ToImmutableDictionary` THROWS on a duplicate key where `new Map` would silently keep the last
 * definition, so the throw is reproduced explicitly (as `check-engine.ts` and friends do).
 */
function namespacesByName(
  namespaces: readonly NamespaceDefinition[],
): ReadonlyMap<string, NamespaceDefinition> {
  const byName = new Map<string, NamespaceDefinition>();
  for (const ns of namespaces) {
    if (byName.has(ns.name)) {
      throw new InvalidArgumentError(
        `An item with the same key has already been added. Key: ${ns.name}`,
      );
    }
    byName.set(ns.name, ns);
  }
  return byName;
}

/**
 * An immutable snapshot of the live schema: the compiled model, its stable hash, the source text
 * it was compiled from, and a monotonic version. A whole snapshot is swapped by a single reference
 * assignment, so any request that has captured one keeps observing a consistent schema for its
 * whole lifetime.
 */
export class SchemaSnapshot {
  /** The compiled schema (namespace + caveat definitions). */
  readonly schema: CompiledSchema;

  /** A stable hash of the compiled schema, used to scope dispatch cache and grain keys. */
  readonly schemaHash: string;

  /** The verbatim DSL the schema was compiled from (`CompiledSchema` is lossy; this round-trips). */
  readonly sourceText: string;

  /** A monotonic version, incremented on each successful update. */
  readonly version: number;

  // Built at most once per snapshot (lazy, not eager): the first reader triggers the build and
  // every subsequent reader of THIS snapshot observes the same cached instance; an `update()`
  // constructs a brand-new snapshot (and hence fresh cells), so the graph is dropped for GC when
  // the snapshot is swapped rather than accumulating in a process-wide cache.
  #reachabilityFull: ReachabilityGraph | undefined;
  #reachabilityFirst: ReachabilityGraph | undefined;
  #membershipCoverage: MembershipCoverage | undefined;

  constructor(schema: CompiledSchema, schemaHash: string, sourceText: string, version: number) {
    this.schema = schema;
    this.schemaHash = schemaHash;
    this.sourceText = sourceText;
    this.version = version;
  }

  /** The compiled namespace definitions. */
  get namespaces(): readonly NamespaceDefinition[] {
    return this.schema.namespaces;
  }

  /** The compiled caveat definitions. */
  get caveats(): readonly CaveatDefinition[] {
    return this.schema.caveats;
  }

  /** The full-mode reachability graph for this snapshot's schema, built lazily on first use. */
  get reachabilityFull(): ReachabilityGraph {
    this.#reachabilityFull ??= buildReachabilityGraph(
      namespacesByName(this.schema.namespaces),
      "full",
    );
    return this.#reachabilityFull;
  }

  /** The first-mode reachability graph for this snapshot's schema, built lazily on first use. */
  get reachabilityFirst(): ReachabilityGraph {
    this.#reachabilityFirst ??= buildReachabilityGraph(
      namespacesByName(this.schema.namespaces),
      "first",
    );
    return this.#reachabilityFirst;
  }

  /**
   * The Leopard membership-coverage analysis for this snapshot's schema, built lazily on first
   * use: a pure function of the compiled schema alone, so it is computed once here rather than
   * once per `MembershipWalkGrain` call.
   */
  get membershipCoverage(): MembershipCoverage {
    this.#membershipCoverage ??= buildMembershipCoverage(this.schema.namespaces);
    return this.#membershipCoverage;
  }
}

/**
 * Supplies the process-wide compiled schema that the check engine evaluates against, as a mutable,
 * versioned snapshot that can be swapped at runtime via {@link ISchemaProvider.update}.
 *
 * Reads observe a whole consistent {@link SchemaSnapshot} via `current`; updates compile-then-swap.
 * The dispatch mesh reads `SchemaSnapshot.schemaHash` per request (through `ISchemaHashSource`), so
 * a swap is reflected in every new cache and grain key and pre-change cache entries are never
 * reused.
 */
export interface ISchemaProvider {
  /** Reads the whole current schema snapshot. */
  readonly current: SchemaSnapshot;

  /**
   * Compiles the given schema DSL text and swaps it in as the current snapshot. Throws before any
   * swap if the text fails to compile, so the live schema is never left torn.
   */
  update(schemaText: string): SchemaSnapshot;
}

/**
 * Default {@link ISchemaProvider}: holds a single {@link SchemaSnapshot} swapped on `update`. Also
 * exposes the current hash via `ISchemaHashSource` for the dispatch mesh.
 */
export class MutableSchemaProvider implements ISchemaProvider, ISchemaHashSource {
  #current: SchemaSnapshot;

  /** Creates a provider seeded with the given schema text (compiled immediately). */
  constructor(schemaText: string) {
    // `ArgumentNullException.ThrowIfNull(schemaText)`, kept even though the parameter type is
    // non-optional: the caller may be untyped.
    if (schemaText === undefined || schemaText === null) {
      throw new InvalidArgumentError("schemaText is required");
    }
    this.#current = compile(schemaText, 0);
  }

  /** @inheritdoc */
  get current(): SchemaSnapshot {
    return this.#current;
  }

  /**
   * @inheritdoc
   *
   * A GETTER, not a snapshotted field: the dispatch mesh reads the hash per request, so a swap
   * must be visible through the read.
   */
  get currentSchemaHash(): string {
    return this.#current.schemaHash;
  }

  /** @inheritdoc */
  update(schemaText: string): SchemaSnapshot {
    if (schemaText === undefined || schemaText === null) {
      throw new InvalidArgumentError("schemaText is required");
    }

    // Compile first: a compile failure throws here, BEFORE any swap, so `#current` is never torn.
    const next = compile(schemaText, this.#current.version + 1);

    // A single reference assignment: in-flight readers keep their captured snapshot; new readers
    // see the new one.
    this.#current = next;
    return next;
  }
}

function compile(schemaText: string, version: number): SchemaSnapshot {
  const compiled = compileSchema(schemaText);
  const hash = computeSchemaHash(compiled.namespaces, compiled.caveats);
  return new SchemaSnapshot(compiled, hash, schemaText, version);
}
