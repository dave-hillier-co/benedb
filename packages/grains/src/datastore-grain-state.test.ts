import { describe, expect, it } from "vitest";

import type { SchemaVersionWire } from "./datastore-dtos";
import {
  datastoreGrainStateEmpty,
  datastoreGrainStateSchemaHashAt,
  datastoreGrainStateSchemaVersionAt,
  type DatastoreGrainState,
} from "./datastore-grain-state";

// Characterization test for `src/Spiceport.Server/Grains.Abstractions/DatastoreGrainState.cs`.
//
// `DatastoreStateWireRoundTripTests` (ported as `datastore-state-wire-round-trip-tests.test.ts`)
// covers the SERIALIZATION of this record. It does not touch `Empty`, `SchemaVersionAt` or
// `SchemaHashAt`, and those are what the sequencer's schema resolution reads, so they are pinned
// here.
//
// The type mirrors the already-ported in-memory `packages/datastore/src/datastore-state.ts`
// field-for-field: `DatastoreStateConverters` (a later batch) must be a pure relabeling between
// the two, and it can only be that if the shapes match.
describe("datastoreGrainStateEmpty", () => {
  it("seeds an empty state at the given initial revision", () => {
    const state = datastoreGrainStateEmpty(1234n);

    expect(state).toEqual({
      headRevision: 1234n,
      relationships: [],
      schemas: [],
      counters: [],
      gcFloor: 0n,
    });
  });

  it("keeps the GC floor at zero: nothing has been collected yet", () => {
    // `long GcFloor { get; init; }` defaults to 0, and 0 is a LEGAL floor rather than a sentinel
    // for "no floor" - reads pinned strictly below it are rejected, and nothing is below 0.
    expect(datastoreGrainStateEmpty(0n).gcFloor).toBe(0n);
    expect(typeof datastoreGrainStateEmpty(0n).gcFloor).toBe("bigint");
  });

  it("hands back a fresh state each call, so one grain's empty is not another's", () => {
    const first = datastoreGrainStateEmpty(1n);
    const second = datastoreGrainStateEmpty(1n);

    expect(first).not.toBe(second);
    expect(first.relationships).not.toBe(second.relationships);
  });
});

describe("datastoreGrainStateSchemaVersionAt", () => {
  const schema = (revision: bigint, hash: string): SchemaVersionWire => ({
    revision,
    bytes: new TextEncoder().encode(hash),
    hash,
  });

  const stateWith = (schemas: readonly SchemaVersionWire[]): DatastoreGrainState => ({
    ...datastoreGrainStateEmpty(100n),
    schemas,
  });

  it("returns nothing when no schema was persisted at or before the revision", () => {
    expect(datastoreGrainStateSchemaVersionAt(stateWith([]), 50n)).toBeUndefined();
    expect(datastoreGrainStateSchemaVersionAt(stateWith([schema(10n, "h1")]), 9n)).toBeUndefined();
    expect(datastoreGrainStateSchemaHashAt(stateWith([schema(10n, "h1")]), 9n)).toBeUndefined();
  });

  it("returns the last version written at or before the revision", () => {
    const state = stateWith([schema(10n, "h1"), schema(20n, "h2"), schema(30n, "h3")]);

    expect(datastoreGrainStateSchemaVersionAt(state, 10n)?.hash).toBe("h1");
    expect(datastoreGrainStateSchemaVersionAt(state, 19n)?.hash).toBe("h1");
    expect(datastoreGrainStateSchemaVersionAt(state, 20n)?.hash).toBe("h2");
    expect(datastoreGrainStateSchemaVersionAt(state, 999n)?.hash).toBe("h3");
    expect(datastoreGrainStateSchemaHashAt(state, 20n)).toBe("h2");
  });

  it("is inclusive of the revision itself: a schema written AT the revision is effective", () => {
    // The `<=` is load-bearing: a commit reads the schema at its own minted revision.
    const state = stateWith([schema(20n, "h2")]);

    expect(datastoreGrainStateSchemaVersionAt(state, 20n)?.hash).toBe("h2");
    expect(datastoreGrainStateSchemaVersionAt(state, 19n)).toBeUndefined();
  });

  it("BREAKS at the first schema above the revision, relying on ascending write order", () => {
    // The C# loop `if (schema.Revision <= at) result = schema; else break;` is NOT the same as
    // "the last matching schema": on an out-of-order list the break stops early. That difference
    // is deliberate, and it is kept rather than 'simplified' to a filter-and-take-last, because
    // MetaFold's compaction is what preserves the order the loop depends on - so if the order ever
    // breaks, this must fail loudly rather than quietly paper over it.
    const outOfOrder = stateWith([schema(10n, "h1"), schema(50n, "h5"), schema(20n, "h2")]);

    expect(datastoreGrainStateSchemaVersionAt(outOfOrder, 30n)?.hash).toBe("h1");
    expect(datastoreGrainStateSchemaHashAt(outOfOrder, 30n)).toBe("h1");
  });

  it("mirrors SchemaVersionAt exactly: SchemaHashAt is its hash, or nothing", () => {
    const state = stateWith([schema(10n, "h1")]);

    expect(datastoreGrainStateSchemaHashAt(state, 10n)).toBe(
      datastoreGrainStateSchemaVersionAt(state, 10n)?.hash,
    );
    expect(datastoreGrainStateSchemaHashAt(state, 1n)).toBeUndefined();
  });
});
