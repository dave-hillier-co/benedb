import { describe, expect, it } from "vitest";

import type { IDatastore } from "@benedb/datastore/i-datastore";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";

import { seedAsync } from "./seed-data";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/SeedDataTests.cs`.
 *
 * `seedAsync` must be idempotent: it seeds an empty datastore but leaves a populated one
 * untouched, so a host restart over durable storage resumes cleanly instead of re-stamping the
 * fixture relationship (which would churn MVCC history every boot). Plain {@link
 * ReferenceDatastore} (no cluster) - the seed only depends on the `IDatastore` contract.
 *
 * PORT NOTES.
 *  - The C# suite lives in `Spiceport.Grains.Tests` but its subject is `Spiceport.Api`'s
 *    `SeedData`, so per the port ledger it lands beside `seed-data.ts` in `@benedb/api`.
 *  - `new RelationshipsFilter()` is an all-default C# record: the empty object literal `{}`.
 *  - `Assert.Equal(headAfterFirst, ...)` compares two `IRevision` VALUES, which in C# is record
 *    equality. TypeScript revisions are class instances with no value equality on `toBe`/`toEqual`
 *    semantics worth leaning on, so the head-unchanged assertion goes through the revision's own
 *    `equals` (and its serialised form, which for a `TimestampRevision` is its nanos).
 */

/** The C# `CountRelationships`: drains an unfiltered snapshot query at head. */
async function countRelationships(datastore: IDatastore): Promise<number> {
  const head = await datastore.headRevision();
  const reader = datastore.snapshotReader(head.revision);
  let count = 0;
  for await (const _ of reader.queryRelationships({})) {
    count++;
  }
  return count;
}

describe("SeedDataTests", () => {
  it("SeedAsync_OnEmptyDatastore_WritesTheFixtureOnce", async () => {
    const datastore = new ReferenceDatastore();

    const seeded = await seedAsync(datastore);

    expect(seeded).toBe(true);
    expect(await countRelationships(datastore)).toBe(1);
  });

  it("SeedAsync_OnPopulatedDatastore_SkipsAndDoesNotChurn", async () => {
    const datastore = new ReferenceDatastore();
    expect(await seedAsync(datastore)).toBe(true);
    const headAfterFirst = (await datastore.headRevision()).revision;

    const seededAgain = await seedAsync(datastore);

    expect(seededAgain).toBe(false);
    expect(await countRelationships(datastore)).toBe(1);
    // No write happened on the second call, so head did not advance.
    const headNow = (await datastore.headRevision()).revision;
    expect(headAfterFirst.equals(headNow)).toBe(true);
    expect(headNow.toString()).toBe(headAfterFirst.toString());
  });
});
