import type { GrainStorage } from "@thresh/core/grain-storage";
import type { SiloBuilder } from "@thresh/hosting/silo-builder";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { describe, expect, it } from "vitest";

import {
  DATASTORE_CONNECTION_STRING_KEY,
  DATASTORE_FALLBACK_CONNECTION_STRING_KEY,
  DATASTORE_PROVIDER_NAME,
  addDatastoreGrainStorage,
  createConfiguration,
  resolveDatastoreConnectionString,
} from "./datastore-storage-config";

/**
 * Characterization test for `src/Spiceport.Server/Hosting/DatastoreStorageConfig.cs`.
 *
 * The C# has NO covering suite. Every already-ported suite that touches it uses it as a FIXTURE -
 * always `AddDatastoreGrainStorage(new ConfigurationBuilder().Build())`, i.e. ONLY the in-memory
 * fallback branch, and never as the subject. So the durable branch, the two-key precedence and the
 * whitespace rule have no gate at all in Spiceport, and this file is the only one they will get.
 *
 * WHAT IS PINNED, and why each of these is behaviour rather than implementation detail:
 *
 *  1. THE PROVIDER NAME IS A LITERAL CONTRACT. `"datastore"` is the name
 *     `[PersistentState("state","datastore")]` binds to (`DatastoreGrain`'s ported `@persistentState`
 *     counterpart). Rename it and the singleton silently gets no storage.
 *  2. THE TWO KEY NAMES AND THEIR ORDER. `ConnectionStrings:OrleansStorage` is consulted FIRST,
 *     `Storage:ConnectionString` only as a fallback. Operators already set the documented env-var
 *     spelling `ConnectionStrings__OrleansStorage`, so the `__` -> `:` mapping and .NET's
 *     case-INSENSITIVE key comparison are part of the contract, not of the config library.
 *  3. `IsNullOrWhiteSpace`, NOT `IsNullOrEmpty`: a value of `" "` selects the in-memory fallback.
 *  4. THE `??` / `IsNullOrWhiteSpace` INTERACTION (see `sourceConcerns`). `configuration[Primary] ??
 *     configuration[Fallback]` short-circuits on NON-NULL, so a primary key present but EMPTY or
 *     WHITESPACE stops the fallback key from ever being read, and the host then takes the
 *     non-durable branch even though a perfectly good `Storage:ConnectionString` is configured.
 *     That is Spiceport's behaviour and the port reproduces it, so it is pinned here deliberately.
 *  5. BOTH ARGUMENTS ARE GUARDED (`ArgumentNullException.ThrowIfNull` on each). TypeScript will not
 *     throw on an undefined configuration until much later, so the guard is load-bearing.
 *
 * WHAT IS NOT PINNED, because it has no counterpart (recorded in `deviations`): the C# forces
 * `OrleansGrainStorageSerializer` on BOTH branches, because the two defaults lose boxed
 * `JsonElement` caveat context. Thresh's storage providers have no serializer seam - the same
 * concern is solved upstream by `packages/grains/src/json-element-surrogate.ts` and the state
 * converters - so the file reduces to CHOOSING a provider, and `NpgsqlInvariant` (an AdoNet
 * concept) disappears with it.
 */

/**
 * A recording stand-in for Thresh's `SiloBuilder`. `addDatastoreGrainStorage` only ever calls the
 * two registration methods, and a real builder's `addPostgresStorage` constructs a live `pg.Pool`,
 * so a stub is what keeps this test from opening a socket to a database that is not there.
 */
interface Registration {
  readonly kind: "storage" | "postgres";
  readonly name: string;
  readonly provider?: GrainStorage;
  readonly connectionString?: string;
}

function recordingBuilder(): { builder: SiloBuilder; registrations: Registration[] } {
  const registrations: Registration[] = [];
  const builder = {
    addStorage(name: string, provider: GrainStorage) {
      registrations.push({ kind: "storage", name, provider });
      return builder;
    },
    addPostgresStorage(name: string, options: { connectionString: string; tableName?: string }) {
      registrations.push({ kind: "postgres", name, connectionString: options.connectionString });
      return builder;
    },
  } as unknown as SiloBuilder;
  return { builder, registrations };
}

function register(values: Readonly<Record<string, string | undefined>>): Registration {
  const { builder, registrations } = recordingBuilder();

  const returned = addDatastoreGrainStorage(builder, createConfiguration(values));

  // The C# extension returns the builder it was handed, so a host can chain.
  expect(returned).toBe(builder);
  expect(registrations).toHaveLength(1);
  return registrations[0] as Registration;
}

describe("the constants", () => {
  it("names the provider exactly as the grain's persistent state binds it", () => {
    expect(DATASTORE_PROVIDER_NAME).toBe("datastore");
  });

  it("keeps both configuration key spellings verbatim", () => {
    expect(DATASTORE_CONNECTION_STRING_KEY).toBe("ConnectionStrings:OrleansStorage");
    expect(DATASTORE_FALLBACK_CONNECTION_STRING_KEY).toBe("Storage:ConnectionString");
  });
});

describe("resolveDatastoreConnectionString", () => {
  it("returns undefined when neither key is set", () => {
    expect(resolveDatastoreConnectionString(createConfiguration({}))).toBeUndefined();
  });

  it("prefers the primary key", () => {
    const configuration = createConfiguration({
      "ConnectionStrings:OrleansStorage": "Host=primary",
      "Storage:ConnectionString": "Host=fallback",
    });
    expect(resolveDatastoreConnectionString(configuration)).toBe("Host=primary");
  });

  it("falls back to Storage:ConnectionString only when the primary key is ABSENT", () => {
    const configuration = createConfiguration({ "Storage:ConnectionString": "Host=fallback" });
    expect(resolveDatastoreConnectionString(configuration)).toBe("Host=fallback");
  });

  it("reads the documented env-var spelling, mapping __ to :", () => {
    const configuration = createConfiguration({
      ConnectionStrings__OrleansStorage: "Host=env",
    });
    expect(resolveDatastoreConnectionString(configuration)).toBe("Host=env");
  });

  it("compares keys case-insensitively, as .NET configuration does", () => {
    const configuration = createConfiguration({
      "connectionstrings:orleansstorage": "Host=lower",
    });
    expect(resolveDatastoreConnectionString(configuration)).toBe("Host=lower");
  });

  it("compares the fallback key case-insensitively too", () => {
    const configuration = createConfiguration({ "STORAGE:CONNECTIONSTRING": "Host=upper" });
    expect(resolveDatastoreConnectionString(configuration)).toBe("Host=upper");
  });

  it("returns the whitespace value verbatim: the emptiness test lives in the branch, not here", () => {
    const configuration = createConfiguration({ "ConnectionStrings:OrleansStorage": " " });
    expect(resolveDatastoreConnectionString(configuration)).toBe(" ");
  });
});

describe("addDatastoreGrainStorage branch selection", () => {
  it("registers non-durable in-memory storage when nothing is configured", () => {
    const registration = register({});

    expect(registration.kind).toBe("storage");
    expect(registration.name).toBe(DATASTORE_PROVIDER_NAME);
    expect(registration.provider).toBeInstanceOf(MemoryGrainStorage);
  });

  it("registers durable Postgres storage under the same provider name when the primary key is set", () => {
    const registration = register({
      "ConnectionStrings:OrleansStorage": "postgres://localhost/benedb",
    });

    expect(registration.kind).toBe("postgres");
    expect(registration.name).toBe(DATASTORE_PROVIDER_NAME);
    expect(registration.connectionString).toBe("postgres://localhost/benedb");
  });

  it("registers durable Postgres storage from the fallback key", () => {
    const registration = register({ "Storage:ConnectionString": "postgres://localhost/fallback" });

    expect(registration.kind).toBe("postgres");
    expect(registration.connectionString).toBe("postgres://localhost/fallback");
  });

  it("prefers the primary key over the fallback", () => {
    const registration = register({
      "ConnectionStrings:OrleansStorage": "postgres://localhost/primary",
      "Storage:ConnectionString": "postgres://localhost/fallback",
    });

    expect(registration.connectionString).toBe("postgres://localhost/primary");
  });

  it("falls back to in-memory for a whitespace-only value (IsNullOrWhiteSpace, not IsNullOrEmpty)", () => {
    const registration = register({ "ConnectionStrings:OrleansStorage": "   " });

    expect(registration.kind).toBe("storage");
    expect(registration.provider).toBeInstanceOf(MemoryGrainStorage);
  });

  it("falls back to in-memory for an empty value", () => {
    const registration = register({ "ConnectionStrings:OrleansStorage": "" });

    expect(registration.kind).toBe("storage");
  });

  // See note 4 and `sourceConcerns`: `??` short-circuits on the non-null empty primary, so the
  // usable fallback is never read and the host comes up NON-DURABLE. Spiceport's behaviour, kept.
  it("lets an EMPTY primary key mask a usable fallback key, exactly as the C# does", () => {
    const registration = register({
      "ConnectionStrings:OrleansStorage": "",
      "Storage:ConnectionString": "postgres://localhost/fallback",
    });

    expect(registration.kind).toBe("storage");
    expect(registration.provider).toBeInstanceOf(MemoryGrainStorage);
  });

  it("lets a WHITESPACE primary key mask a usable fallback key too", () => {
    const registration = register({
      "ConnectionStrings:OrleansStorage": " ",
      "Storage:ConnectionString": "postgres://localhost/fallback",
    });

    expect(registration.kind).toBe("storage");
  });

  it("gives each registration its own in-memory provider instance", () => {
    expect(register({}).provider).not.toBe(register({}).provider);
  });
});

describe("the argument guards", () => {
  it("rejects a missing builder", () => {
    expect(() =>
      addDatastoreGrainStorage(undefined as unknown as SiloBuilder, createConfiguration({})),
    ).toThrow();
  });

  it("rejects a missing configuration", () => {
    const { builder } = recordingBuilder();
    expect(() =>
      addDatastoreGrainStorage(
        builder,
        undefined as unknown as ReturnType<typeof createConfiguration>,
      ),
    ).toThrow();
  });
});
