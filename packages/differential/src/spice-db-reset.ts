import { DeleteRelationshipsRequest } from "@spacedb/protos/authzed/api/v1/permission_service";
import { ReadSchemaRequest } from "@spacedb/protos/authzed/api/v1/schema_service";

import type { SpiceDbGrpcClient } from "./spice-db-grpc-client";

/**
 * Ported from Spiceport `tests/Spiceport.Differential.Tests/SpiceDbReset.cs`.
 *
 * Pre-write reset of the shared real-SpiceDB container, for directed suites that write their own
 * schema. Other suites sharing the container can leave relationships live (there is no ordering
 * guarantee, and their cleanup is best-effort), and real SpiceDB rejects a `WriteSchema` that would
 * orphan existing relationships ("cannot delete object definition ... as at least one relationship
 * exists under it", observed as `INVALID_ARGUMENT`). That residue rejection would make accept-path
 * setup fail spuriously and pollute reject-path status-code assertions with a cause other than the
 * rule under test. Clearing every type the CURRENTLY active schema defines (read back from the
 * container, so no other suite's type list is hard-coded here) guarantees the subsequent write's
 * verdict reflects schema validation alone. Best-effort by design: a container with no schema yet
 * has nothing to reset, and a type not defined under whatever schema is active is not an error.
 *
 * LEDGER DEVIATION: the ledger row targets `spice-db-reset.test.ts`. Harness, not a suite; amended
 * to `spice-db-reset.ts`. Its covering test is
 * `Reset_makes_schema_write_verdict_independent_of_residual_relationships` in
 * `write-schema-wildcard-transitivity-tests.test.ts`.
 *
 * PORT DECISIONS.
 *
 *  1. THE REGEX IS TRANSLITERATED EXACTLY. .NET `@"(?m)^\s*definition\s+([A-Za-z0-9_/]+)"` ->
 *     {@link DEFINITION_PATTERN}, driven by `matchAll`. The `/` stays in the character class
 *     (prefixed type names), no `\b` and no extra anchors are added, and `\s` matches newlines in
 *     both engines so `^\s*` straddles blank lines identically.
 *  2. THE EARLY EXIT IS REQUIRED. `ReadSchema` throws NOT_FOUND on a container with no schema yet,
 *     and the C#'s `catch (RpcException) { return; }` is what makes the very FIRST reset a no-op
 *     rather than a crash.
 *  3. BOTH CATCHES ARE NARROWED. The C# catches `RpcException` specifically. In TypeScript every
 *     grpc-js failure is a plain `Error` carrying a numeric `.code`, so a bare `catch {}` would
 *     also swallow genuine programming errors (a typo'd field, a bad import) and turn them into
 *     silent no-ops. {@link isGrpcError} is the narrowing; anything else rethrows.
 *  4. IT ONLY DELETES RELATIONSHIPS - it never writes an empty schema, and is deliberately NOT a
 *     full container wipe.
 *
 * NOTE, per the per-file container deviation recorded in `spice-db-container-fixture.ts`: vitest
 * gives each importing FILE its own container, so the cross-CLASS rationale above is
 * defensive-only here. It is transliterated anyway - within one file the cases still share the
 * container and still leave residue for each other.
 */
const DEFINITION_PATTERN = /^\s*definition\s+([A-Za-z0-9_/]+)/gm;

/** The C#'s `catch (RpcException)`: a grpc-js failure is an `Error` carrying a numeric `code`. */
function isGrpcError(error: unknown): boolean {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "number";
}

export async function resetSpiceDb(client: SpiceDbGrpcClient): Promise<void> {
  let schemaText: string;
  try {
    schemaText = (await client.readSchema(ReadSchemaRequest.fromPartial({}))).schemaText;
  } catch (error) {
    if (!isGrpcError(error)) throw error;
    return;
  }

  for (const match of schemaText.matchAll(DEFINITION_PATTERN)) {
    // The C#'s `match.Groups[1].Value`. Group 1 is not optional in the pattern, so it always
    // participates in a successful match; the `?? ""` is TypeScript's narrowing, not a behaviour.
    const resourceType = match[1] ?? "";
    try {
      await client.deleteRelationships(
        DeleteRelationshipsRequest.fromPartial({
          relationshipFilter: { resourceType },
        }),
      );
    } catch (error) {
      // Not deletable under whatever schema is active; nothing to reset for this type.
      if (!isGrpcError(error)) throw error;
    }
  }
}
