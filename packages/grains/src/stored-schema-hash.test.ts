import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import { describe, expect, it } from "vitest";

import { computeStoredSchemaHash } from "./stored-schema-hash";

/**
 * No covering C# test - a characterization of `StoredSchemaHash.Compute`.
 *
 * In C# this is the SAME definition the MVCC commit uses, by construction. Here it is a second
 * copy of `Convert.ToHexStringLower(SHA256.HashData(bytes))` next to the private helper in
 * `mvcc-read-write-transaction.ts`, so the agreement is a property to be asserted, not a fact of
 * the code: a divergence makes `ExpectedSchemaHash` CAS reject valid commits, and the value is
 * wire-visible three ways (DatastoreHeadWire.SchemaHash, CommitRequest.ExpectedSchemaHash, and
 * the final segment of every check / subject-frontier / membership-walk grain key).
 */
describe("computeStoredSchemaHash", () => {
  it("is a lowercase-hex SHA-256 with no prefix", () => {
    const hash = computeStoredSchemaHash(new TextEncoder().encode("definition user {}"));

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the published SHA-256 vectors", () => {
    expect(computeStoredSchemaHash(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(computeStoredSchemaHash(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes raw bytes, not text - every byte value is admissible", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;

    expect(computeStoredSchemaHash(bytes)).toBe(
      "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880",
    );
  });

  it("is sensitive to a single byte and to length", () => {
    const encode = (text: string) => new TextEncoder().encode(text);

    expect(computeStoredSchemaHash(encode("definition user {}"))).not.toBe(
      computeStoredSchemaHash(encode("definition User {}")),
    );
    expect(computeStoredSchemaHash(encode("definition user {}"))).not.toBe(
      computeStoredSchemaHash(encode("definition user {} ")),
    );
  });

  it("is stable across calls and independent of the backing buffer's offset", () => {
    const backing = new Uint8Array([0xff, 0x61, 0x62, 0x63, 0xff]);
    const view = backing.subarray(1, 4);

    expect(computeStoredSchemaHash(view)).toBe(
      computeStoredSchemaHash(new TextEncoder().encode("abc")),
    );
  });

  it("agrees with the hash the MVCC commit stores for the same schema bytes", async () => {
    const bytes = new TextEncoder().encode("definition user {}\ndefinition document {}\n");
    const store = new ReferenceDatastore();

    await store.readWriteTx(async (tx) => {
      await tx.writeStoredSchema(bytes);
    });
    const head = await store.headRevision();

    expect(head.schemaHash).toBe(computeStoredSchemaHash(bytes));
  });
});
