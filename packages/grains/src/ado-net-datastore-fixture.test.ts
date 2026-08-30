import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  GenericContainer,
  getContainerRuntimeClient,
  Wait,
  type StartedTestContainer,
} from "testcontainers";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/Durability/AdoNetDatastoreFixture.cs`.
 *
 * A disposable Postgres container, for proving the singleton `DatastoreGrain`'s state is DURABLE
 * across a TRUE reactivation. One database, one connection pool, shared by the durability suites
 * that import this module (the durability proof needs the SAME store before and after the grain
 * reactivates). Requires Docker; SKIPS - never fails - without it.
 *
 * PORT DECISIONS.
 *
 *  1. NO ORLEANS SCHEMA TO APPLY. The C# vendors `PostgreSQL-Main.sql` and
 *     `PostgreSQL-Persistence.sql` under `Durability/OrleansSql` and runs them in
 *     `ApplyOrleansSchema`, because the Orleans 10.1.0 AdoNet nupkg ships no SQL. Thresh's
 *     `PostgresGrainStorage.start()` creates its own single `(grain_id, state_name, data, etag)`
 *     table, so `ApplyOrleansSchema` and both vendored scripts have NO counterpart here and are
 *     deliberately absent rather than silently dropped. What replaces them is per-suite:
 *     `await storage.start()` before the cluster is deployed.
 *  2. `ICollectionFixture<AdoNetDatastoreFixture>` + `[CollectionDefinition("adonet-durability")]`
 *     -> {@link useAdoNetDatastore}, one module-level `beforeAll`/`afterAll` pair the importing
 *     suite installs, plus `describe.sequential` in each suite. LEDGER-VISIBLE DEVIATION: vitest
 *     isolates test FILES, so each importing file evaluates its own copy of this module and gets
 *     its OWN container. That is a superset of the C#'s one-shared-database contract (stronger
 *     isolation, not weaker), and the per-test unique table name each suite uses makes the sharing
 *     question moot either way.
 *  3. THE NARROW SKIP RULE IS LOAD-BEARING AND SURVIVES. The C# catches ONLY
 *     `DockerUnavailableException` - Testcontainers' "no reachable Docker endpoint" signal - and
 *     lets every other build/start failure (image pull, container crash) escape, so a
 *     Docker-enabled machine never silently skips the durability gates. The Node `testcontainers`
 *     analogue is `getContainerRuntimeClient()` failing every runtime strategy, which throws
 *     exactly {@link NO_RUNTIME_MESSAGE}. That call - and only that call - is what this module
 *     probes, and only that message (or the probe timing out, which is the same "no reachable
 *     endpoint" reached the slow way) marks the fixture unavailable. `GenericContainer.start()`
 *     failures are NOT caught.
 *  4. The probe is BOUNDED ({@link PROBE_TIMEOUT_MS}). A suite that hangs waiting for a container
 *     is worse than one that fails, and this file lands in the `unit` vitest project, so
 *     `pnpm test` must stay fast on a machine with no Docker at all.
 *  5. `new PostgreSqlBuilder("postgres:17-alpine")` -> a `GenericContainer` on the same image with
 *     the same trust auth and a log wait strategy; the base `testcontainers` package carries no
 *     Postgres module, and adding one for a builder that only sets three env vars is not worth a
 *     dependency. `GetConnectionString()` -> {@link connectionString}, assembled from the mapped
 *     port.
 */

/** The exact message `getContainerRuntimeClient` throws when no runtime strategy works. */
const NO_RUNTIME_MESSAGE = "Could not find a working container runtime strategy";

/** The bound on the Docker endpoint-resolution probe - see port decision 4. */
const PROBE_TIMEOUT_MS = 5_000;

const POSTGRES_IMAGE = "postgres:17-alpine";
const POSTGRES_USER = "test";
const POSTGRES_PASSWORD = "test";
const POSTGRES_DB = "test";

/** The `Available`/`SkipReason` pair, decided ONCE at module load. */
interface DockerProbe {
  readonly available: boolean;
  readonly skipReason: string | undefined;
}

async function probeDocker(): Promise<DockerProbe> {
  const timeout = Symbol("timeout");
  try {
    const result = await Promise.race([
      getContainerRuntimeClient(),
      delay(PROBE_TIMEOUT_MS, timeout),
    ]);
    if (result === timeout) {
      return {
        available: false,
        skipReason: `Docker/Testcontainers unavailable: endpoint resolution did not complete within ${PROBE_TIMEOUT_MS}ms`,
      };
    }
    return { available: true, skipReason: undefined };
  } catch (err) {
    // ONLY the no-reachable-endpoint signal is skip-worthy (port decision 3).
    if (err instanceof Error && err.message === NO_RUNTIME_MESSAGE) {
      return { available: false, skipReason: `Docker/Testcontainers unavailable: ${err.message}` };
    }
    throw err;
  }
}

const probe = await probeDocker();

/** True when a Docker endpoint answered the probe; false when Docker is absent. */
export const adoNetDatastoreAvailable = probe.available;

/** Why the fixture is unavailable, for the test skip message (`SkipReason`). */
export const adoNetDatastoreSkipReason = probe.skipReason ?? "Postgres fixture unavailable";

/** The live fixture: a started container plus the pool the durability suites write through. */
export interface AdoNetDatastore {
  /** The connection string to the single Postgres database (`ConnectionString`). */
  readonly connectionString: string;
  /** A pool over that database, for `PostgresGrainStorage` and the per-test table drops. */
  readonly pool: Pool;
}

let started: { container: StartedTestContainer; datastore: AdoNetDatastore } | undefined;
let registered = false;

/**
 * Starts the container and opens the pool. Every failure here ESCAPES: Docker is present (the
 * probe answered), so a build or start failure is broken infrastructure, not a reason to skip.
 */
async function start(): Promise<void> {
  const container = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_USER,
      POSTGRES_PASSWORD,
      POSTGRES_DB,
      // `trust` matches the Testcontainers Postgres module's own default for local test databases.
      POSTGRES_HOST_AUTH_METHOD: "trust",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const connectionString =
    `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${container.getHost()}` +
    `:${container.getMappedPort(5432)}/${POSTGRES_DB}`;
  const pool = new Pool({ connectionString });
  pool.on("error", () => {});
  started = { container, datastore: { connectionString, pool } };
}

/**
 * Installs the shared `beforeAll`/`afterAll` pair on the calling FILE's root suite and returns the
 * accessor the suite's tests read the live fixture through (the C#'s injected fixture instance).
 * Calling it twice in one module is a no-op beyond returning the same accessor.
 */
export function useAdoNetDatastore(): () => AdoNetDatastore {
  if (!registered) {
    registered = true;
    beforeAll(async () => {
      if (!adoNetDatastoreAvailable) return;
      await start();
    }, 300_000);
    afterAll(async () => {
      if (started === undefined) return;
      const { container, datastore } = started;
      started = undefined;
      await datastore.pool.end().catch(() => {});
      await container.stop();
    }, 120_000);
  }
  return () => {
    if (started === undefined) {
      throw new Error("the AdoNet datastore fixture is not started (Docker unavailable?)");
    }
    return started.datastore;
  };
}

const fixture = useAdoNetDatastore();

/**
 * The fixture's own characterization gate: with Docker present the container really answers SQL on
 * the connection string it hands out, and without Docker this file - which the `unit` vitest
 * project loads - skips cleanly and fast, carrying the reason.
 *
 * It rides along in every importing suite too (importing a module runs its top level, and a
 * `describe` at a module's top level registers on the importing FILE's collection). That is left as
 * it is rather than guarded away: the check is one `SELECT 1` against the container that suite is
 * about to run against, so it is a per-file smoke test of the very fixture the suite depends on.
 */
describe.sequential("AdoNetDatastoreFixture", () => {
  it("hands out a connection string to a live Postgres", async (ctx) => {
    ctx.skip(!adoNetDatastoreAvailable, adoNetDatastoreSkipReason);
    const { connectionString, pool } = fixture();
    expect(connectionString).toMatch(/^postgres:\/\//);
    const result = await pool.query<{ one: number }>("SELECT 1 AS one");
    expect(result.rows[0]?.one).toBe(1);
  }, 60_000);
});
