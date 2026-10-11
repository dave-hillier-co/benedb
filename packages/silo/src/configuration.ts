/**
 * The host's configuration reader. Spiceport's hosts read .NET `IConfiguration`; there is none
 * here, and only two of its rules are part of the hosts' contract - operators already set the
 * documented environment spellings (`Clustering__Silos`, …) - so this module reproduces exactly
 * those: key comparison is CASE-INSENSITIVE, and `__` in a key maps onto the `:` section
 * separator. Nothing else about `IConfiguration` (providers, reloading, binding) is ported, because
 * nothing here uses it.
 *
 * Storage is deliberately absent: where durable state lives is Thresh's decision
 * (`storageBackendFromEnvironment`, `THRESH_STORAGE_URL`), not the application's.
 */

/** The read-only key/value lookup the hosts need from .NET's `IConfiguration` - and no more. */
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
