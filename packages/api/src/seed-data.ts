import { ELLIPSIS } from "@spacedb/core/core-constants";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { createRelationship } from "@spacedb/core/relationship";
import type { IDatastore } from "@spacedb/datastore/i-datastore";

/**
 * Ported from Spiceport `src/Spiceport.Api/SeedData.cs`.
 *
 * The embedded test schema and the relationships seeded at startup so a `CheckPermission` call
 * returns a real answer over the in-memory datastore.
 *
 * Deferred (later phases): loading schema/relationships from a conformance YAML; for this slice a
 * single classic document/viewer fixture is enough. The datastore is now durable when Postgres
 * storage is configured, so seeding is idempotent: it only writes into an EMPTY store.
 *
 * PORT NOTE - THE RAW STRING LITERAL. As with `SILO_SCHEMA_TEXT`, the C# `"""..."""` literal
 * dedents and emits no trailing newline, so the text below is written already dedented and with no
 * trailing newline. The API host compiles THIS constant, so its hash reaches every ZedToken the API
 * mints. It is byte-identical to the silo host's constant but deliberately a separate constant in a
 * separate package: the two are separate files in the C# and drift independently.
 */
export const SEED_SCHEMA_TEXT = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

/**
 * Seeds the fixture relationship, but ONLY if the datastore is empty. With durable storage the
 * grain state survives restarts, so re-seeding a populated store every boot would churn MVCC
 * history (a Touch re-stamps the row at a new revision each time) without changing the live set.
 *
 * @returns true if the seed was written, false if an existing relationship was found and seeding
 * was skipped.
 *
 * PORT NOTE. The C# returns FROM INSIDE THE FIRST ITERATION of `await foreach` over an unfiltered
 * `QueryRelationships` - it never drains the stream, so an already-populated store costs one row,
 * not a full scan. `for await ... return` is the exact counterpart: the early `return` calls the
 * iterator's `return()`, disposing it the way `await foreach` disposes the enumerator.
 */
export async function seedAsync(
  datastore: IDatastore,
  signal?: AbortSignal | undefined,
): Promise<boolean> {
  // `ArgumentNullException.ThrowIfNull(datastore);`
  if (datastore === undefined || datastore === null) {
    throw new InvalidArgumentError("datastore is required");
  }

  const head = await datastore.headRevision(signal);
  const reader = datastore.snapshotReader(head.revision);
  for await (const _ of reader.queryRelationships({}, signal)) {
    // already populated (e.g. resumed from durable storage) - leave it untouched
    return false;
  }

  await datastore.readWriteTx(async (tx) => {
    const rel = createRelationship(
      { objectType: "document", objectId: "readme", relation: "viewer" },
      { objectType: "user", objectId: "alice", relation: ELLIPSIS },
    );
    await tx.writeRelationships([{ relationship: rel, operation: "touch" }], signal);
  }, signal);
  return true;
}
