import type { CaveatDefinition } from "@benedb/core/caveat-definition";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";

/**
 * The full result of compiling a schema: both object-type namespace definitions and caveat
 * definitions, each in source order.
 *
 * Declared alongside `SchemaCompiler` in Spiceport's `SchemaCompiler.cs`; split into its own
 * module here under the no-barrels, one-primary-export rule.
 */
export interface CompiledSchema {
  /** Compiled object-type definitions, in source order. */
  readonly namespaces: readonly NamespaceDefinition[];
  /** Compiled caveat definitions, in source order. */
  readonly caveats: readonly CaveatDefinition[];
}
