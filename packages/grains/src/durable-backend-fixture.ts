import { setTimeout as delay } from "node:timers/promises";
import type { StorageBackend } from "@thresh/hosting/storage-backend";
import { storageBackendFromEnvironment } from "@thresh/hosting/storage-backend";
import {
  GenericContainer,
  getContainerRuntimeClient,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import { afterAll, beforeAll } from "vitest";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/Durability/AdoNetDatastoreFixture.cs`.
 *
 * A DURABLE storage backend for the durability gates, which prove the datastore survives a TRUE
 * reactivation: a brand-new cluster over the same backend. The backend is THRESH's - the suites
 * hand it to `TestCluster.start({ storageBackend })` and never touch a database themselves, because
 * where state lives is Thresh's business, not BeneDB's.
 *
 * Two sources, in order:
 *
 *  1. `BENEDB_TEST_STORAGE_URL`, read through Thresh's own `THRESH_STORAGE_URL` rules
 *     (`postgres://...` or `redis://...`), for a machine with a database already running.
 *  2. Otherwise a disposable `postgres:17-alpine` container (Testcontainers), when Docker answers.
 *
 * With neither, the suites SKIP - never fail. The skip rule is the C#'s narrow one: ONLY "no
 * reachable Docker endpoint" (or the bounded probe timing out, the same signal reached slowly) is
 * skip-worthy; any other container build/start failure escapes, so a Docker-enabled machine never
 * silently skips the durability gates.
 *
 * PORT DECISIONS.
 *
 *  1. NO SCHEMA TO APPLY AND NO CLIENT. The C# applies the vendored Orleans AdoNet SQL and hands
 *     out a connection string; Thresh's Postgres providers create their own tables on silo start,
 *     so the fixture hands out a `StorageBackend` and nothing else.
 *  2. `ICollectionFixture<AdoNetDatastoreFixture>` -> {@link useDurableBackend}, one module-level
 *     `beforeAll`/`afterAll` pair the importing suite installs. vitest isolates test FILES, so each
 *     importing file gets its own container - stronger isolation than the C#'s shared database.
 *     Within a file, tests isolate by a distinct `serviceId` per test, which every Thresh provider
 *     keys its rows by.
 *  3. The probe is BOUNDED, so `pnpm test` stays fast on a machine with no Docker at all.
 */

/** The variable naming an existing durable backend for the durability gates. */
export const DURABLE_TEST_STORAGE_ENV = "BENEDB_TEST_STORAGE_URL";

/** The exact message `getContainerRuntimeClient` throws when no runtime strategy works. */
const NO_RUNTIME_MESSAGE = "Could not find a working container runtime strategy";

/** The bound on the Docker endpoint-resolution probe. */
const PROBE_TIMEOUT_MS = 5_000;

const POSTGRES_IMAGE = "postgres:17-alpine";

type Source =
  | { readonly kind: "configured"; readonly backend: StorageBackend }
  | { readonly kind: "container" }
  | { readonly kind: "unavailable"; readonly reason: string };

async function resolveSource(): Promise<Source> {
  const url = process.env[DURABLE_TEST_STORAGE_ENV];
  if (url !== undefined && url.trim().length > 0) {
    const backend = storageBackendFromEnvironment({ THRESH_STORAGE_URL: url });
    return { kind: "configured", backend };
  }

  const timeout = Symbol("timeout");
  try {
    const result = await Promise.race([
      getContainerRuntimeClient(),
      delay(PROBE_TIMEOUT_MS, timeout),
    ]);
    if (result === timeout) {
      return {
        kind: "unavailable",
        reason: `no ${DURABLE_TEST_STORAGE_ENV}, and Docker endpoint resolution did not complete within ${PROBE_TIMEOUT_MS}ms`,
      };
    }
    return { kind: "container" };
  } catch (err) {
    if (err instanceof Error && err.message === NO_RUNTIME_MESSAGE) {
      return {
        kind: "unavailable",
        reason: `no ${DURABLE_TEST_STORAGE_ENV}, and Docker/Testcontainers unavailable: ${err.message}`,
      };
    }
    throw err;
  }
}

const source = await resolveSource();

/** True when the durability gates can run. */
export const durableBackendAvailable = source.kind !== "unavailable";

/** Why they cannot, for the skip message. */
export const durableBackendSkipReason =
  source.kind === "unavailable" ? source.reason : "durable backend unavailable";

let started: { container: StartedTestContainer | undefined; backend: StorageBackend } | undefined;
let registered = false;

/**
 * Installs the shared `beforeAll`/`afterAll` pair on the calling FILE's root suite and returns the
 * accessor the suite's tests read the backend through. Calling it twice in one module is a no-op
 * beyond returning the same accessor.
 */
export function useDurableBackend(): () => StorageBackend {
  if (!registered) {
    registered = true;
    beforeAll(async () => {
      if (source.kind === "configured") {
        started = { container: undefined, backend: source.backend };
      } else if (source.kind === "container") {
        const container = await new GenericContainer(POSTGRES_IMAGE)
          .withEnvironment({
            POSTGRES_USER: "test",
            POSTGRES_PASSWORD: "test",
            POSTGRES_DB: "test",
            POSTGRES_HOST_AUTH_METHOD: "trust",
          })
          .withExposedPorts(5432)
          .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
          .start();
        started = {
          container,
          backend: {
            kind: "postgres",
            connectionString: `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`,
          },
        };
      }
    }, 300_000);
    afterAll(async () => {
      const container = started?.container;
      started = undefined;
      await container?.stop();
    }, 120_000);
  }
  return () => {
    if (started === undefined) {
      throw new Error(`the durable backend is not available: ${durableBackendSkipReason}`);
    }
    return started.backend;
  };
}
