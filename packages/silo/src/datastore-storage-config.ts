import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { SiloBuilder } from "@thresh/hosting/silo-builder";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";

/**
 * Ported from Spiceport `src/Spiceport.Server/Hosting/DatastoreStorageConfig.cs`.
 *
 * Config-gated registration of the "datastore" grain-storage provider (the durability seam for the
 * cluster-singleton `DatastoreGrain`). When a Postgres connection string is configured, the
 * singleton's state is persisted DURABLY and survives silo restart / activation migration;
 * otherwise it falls back to non-durable in-memory storage so the default localhost dev host and
 * all in-memory tests run with no Postgres dependency.
 *
 * PORT DECISIONS.
 *
 *  1. THERE IS NO `IConfiguration`. .NET's configuration surface is case-INSENSITIVE and maps `__`
 *     in an environment variable onto the `:` section separator. Both are part of THIS file's
 *     contract, not of the library it happened to use - operators already set the documented
 *     `ConnectionStrings__OrleansStorage` - so {@link createConfiguration} reproduces exactly those
 *     two rules over a plain record, and {@link configurationFromEnvironment} points it at
 *     `process.env`. Nothing else about `IConfiguration` (providers, reloading, binding) is ported,
 *     because nothing here uses it.
 *  2. THE SERIALIZER FORCING HAS NO TRANSLATION. Both C# branches install
 *     `OrleansGrainStorageSerializer` explicitly, because the two provider defaults lose boxed
 *     `JsonElement` caveat context (in-memory returns `ValueKind.Undefined`; AdoNet's JSON default
 *     emits `{}`). Thresh's storage providers have no serializer seam: there is one storage codec,
 *     and the caveat-context round trip is solved upstream by `@benedb/grains/json-element-
 *     surrogate` and the state converters. So this file reduces to CHOOSING a provider, and
 *     `NpgsqlInvariant` - an AdoNet concept, with no `DbProviderFactories` reflection to replace -
 *     disappears with it.
 *  3. THE DURABLE BRANCH IS `addPostgresStorage`. Thresh's helper owns the pool: it creates it
 *     here, creates the backing table on silo start and closes the pool on stop. Thresh keys rows
 *     by `(grain_id, state_name)` only, so there is no ServiceId isolation to port either. A host
 *     that also needs the provider INSTANCE (the datastore grain takes its storage by injection)
 *     reads it back with `SiloBuilder.storageProvider(DATASTORE_PROVIDER_NAME)`.
 */

/**
 * The grain-storage provider name. MUST match `[PersistentState("state","datastore")]`'s ported
 * counterpart - rename it and the singleton silently gets no storage.
 */
export const DATASTORE_PROVIDER_NAME = "datastore";

/**
 * Primary configuration key for the grain-storage Postgres connection string. Set this (or env
 * `ConnectionStrings__OrleansStorage`) to enable durable Postgres storage. When neither this key
 * nor the fallback is present at all, storage falls back to non-durable in-memory; a key that is
 * present but blank refuses to start instead.
 */
export const DATASTORE_CONNECTION_STRING_KEY = "ConnectionStrings:OrleansStorage";

/** Fallback configuration key checked when {@link DATASTORE_CONNECTION_STRING_KEY} is unset. */
export const DATASTORE_FALLBACK_CONNECTION_STRING_KEY = "Storage:ConnectionString";

/** The read-only key/value lookup this file needs from .NET's `IConfiguration` - and no more. */
export interface Configuration {
  /** The value for a key, or `undefined` where the C# indexer returns null. */
  get(key: string): string | undefined;
}

/** `key.Replace("__", ":")`, then .NET's case-insensitive comparison. */
function normalizeKey(key: string): string {
  return key.replaceAll("__", ":").toLowerCase();
}

/**
 * A {@link Configuration} over a plain record, reproducing .NET configuration's two key rules:
 * comparison is CASE-INSENSITIVE, and `__` in a key maps onto the `:` section separator.
 */
export function createConfiguration(
  values: Readonly<Record<string, string | undefined>>,
): Configuration {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    normalized.set(normalizeKey(key), value);
  }
  return {
    get(key: string): string | undefined {
      return normalized.get(normalizeKey(key));
    },
  };
}

/** The host's real configuration: the process environment, read through the same two rules. */
export function configurationFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Configuration {
  return createConfiguration(env);
}

/**
 * Resolves the connection string as the first configured key that is present AND non-blank -
 * unlike `??`, an empty (but present) primary value does NOT short-circuit the fallback. If a key
 * was configured (present in the configuration) but every configured key resolved blank, this
 * refuses to start rather than silently degrading a production silo to non-durable in-memory
 * storage over what is almost always an unset env var / Helm default / typo. A configuration where
 * NEITHER key is present at all (the ordinary local-dev/test shape) is left alone and falls back
 * to in-memory as before. (Spiceport `ResolveConnectionString`, the fix for issue #40.)
 */
export function resolveDatastoreConnectionString(configuration: Configuration): string | undefined {
  const primary = configuration.get(DATASTORE_CONNECTION_STRING_KEY);
  const fallback = configuration.get(DATASTORE_FALLBACK_CONNECTION_STRING_KEY);

  if (!isNullOrWhiteSpace(primary)) {
    return primary;
  }

  if (!isNullOrWhiteSpace(fallback)) {
    return fallback;
  }

  if (primary !== undefined || fallback !== undefined) {
    throw new Error(
      `Datastore connection string configuration is present but blank ` +
        `(checked '${DATASTORE_CONNECTION_STRING_KEY}' and '${DATASTORE_FALLBACK_CONNECTION_STRING_KEY}'). ` +
        "Refusing to silently start a non-durable in-memory datastore in place of the " +
        "durable Postgres storage that was evidently intended. Either supply a valid " +
        "connection string, or remove the key(s) entirely to opt into in-memory storage.",
    );
  }

  return undefined;
}

/** `string.IsNullOrWhiteSpace` - a value of `" "` is empty for this decision. */
function isNullOrWhiteSpace(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * Registers the "datastore" provider: durable Postgres when a connection string is configured,
 * otherwise non-durable in-memory.
 */
export function addDatastoreGrainStorage(
  builder: SiloBuilder,
  configuration: Configuration,
): SiloBuilder {
  // `ArgumentNullException.ThrowIfNull(silo); ArgumentNullException.ThrowIfNull(configuration);` -
  // kept explicit, because TypeScript would not fault on an undefined config until much later.
  if (builder === undefined || builder === null) {
    throw new InvalidArgumentError("builder is required");
  }
  if (configuration === undefined || configuration === null) {
    throw new InvalidArgumentError("configuration is required");
  }

  const connectionString = resolveDatastoreConnectionString(configuration);

  if (isNullOrWhiteSpace(connectionString)) {
    return builder.addStorage(DATASTORE_PROVIDER_NAME, new MemoryGrainStorage());
  }

  return builder.addPostgresStorage(DATASTORE_PROVIDER_NAME, {
    connectionString: connectionString as string,
  });
}
