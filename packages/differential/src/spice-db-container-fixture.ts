import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll } from "vitest";
import {
  GenericContainer,
  getContainerRuntimeClient,
  Wait,
  type StartedTestContainer,
} from "testcontainers";

/**
 * Ported from Spiceport `tests/Spiceport.Differential.Tests/SpiceDbContainerFixture.cs`.
 *
 * A disposable, real SpiceDB container (Testcontainers), for the differential conformance gate: the
 * only test suite in this repo that checks BeneDB's engine against a genuine, independent SpiceDB
 * implementation rather than another view of BeneDB's own engine.
 *
 * LEDGER DEVIATION: the ledger row targets `spice-db-container-fixture.test.ts`. This file is the
 * HARNESS and declares no cases, and a `*.test.ts` with no suite fails a vitest run outright, so it
 * lands as `spice-db-container-fixture.ts` and the ledger row is amended - the same deviation
 * `mesh-test-cluster.ts` and `collecting-stream-writer.ts` already took.
 *
 * PORT DECISIONS.
 *
 *  1. THE IMAGE TAG IS PINNED, NOT `latest`, exactly as the C# pins it: {@link SPICEDB_IMAGE}. A
 *     disagreement against a different tag is a version difference, not a behaviour difference -
 *     `CorpusDifferentialTests`' history note (arrowsublr.yaml, fixed upstream in v1.47.0) is what
 *     that pin buys, and it is carried across unchanged.
 *  2. THE COMMAND ARGS ARE VERBATIM. `--enable-experimental-relationship-expiration` is
 *     load-bearing: without it every `use expiration` corpus file fails `WriteSchema` with
 *     "expiration trait is not allowed". BeneDB supports expiration unconditionally (no
 *     server-side feature flag), so enabling it here is what makes those files an apples-to-apples
 *     comparison.
 *  3. THE WAIT STRATEGY IS LOAD-BEARING. The authzed/spicedb image is distroless (no shell), so any
 *     INTERNAL probe strategy (a wait executed inside the container) can never succeed and start
 *     hangs FOREVER. `UntilMessageIsLogged("grpc server started serving")` becomes
 *     `Wait.forLogMessage(...)`, which needs nothing inside the container.
 *  4. THE ADDRESS FORMAT DIVERGES. The C# builds `http://{host}:{port}` because `Grpc.Net.Client`
 *     wants a URI scheme. `@grpc/grpc-js` wants `host:port` with NO scheme (plus insecure channel
 *     credentials, which {@link SpiceDbGrpcClient} supplies), so a literal transliteration of the
 *     address string would not dial.
 *  5. `IAsyncLifetime` + `ICollectionFixture<SpiceDbContainerFixture>` shared across all five
 *     classes of `SpiceDbCollection` -> {@link useSpiceDbContainer}, one module-level
 *     `beforeAll`/`afterAll` pair the importing suite installs, mirroring `useAdoNetDatastore`.
 *     LEDGER-VISIBLE DEVIATION: vitest isolates test FILES, so each importing suite evaluates its
 *     own copy of this module and gets its OWN container - a superset of the C#'s
 *     one-container-per-collection contract (stronger isolation, not weaker).
 *
 *     CONSEQUENCE, RECORDED NOT ACTED ON: under per-file containers the cross-class rationale in
 *     `spice-db-reset.ts` (and `CorpusDifferentialTests`' `.Concat(["group","folder","document"])`)
 *     becomes defensive-only - no sibling CLASS can leave residue in a container only this file
 *     sees. It is transliterated anyway rather than simplified away: within one file the cases
 *     still share the container and still leave residue for each other, which is the same hazard.
 *  6. THE NARROW SKIP RULE SURVIVES, via `ado-net-datastore-fixture.ts`' established precedent. The
 *     C# catches only container-start failure and lets everything after a successful start escape.
 *     The Node analogue is a BOUNDED ({@link PROBE_TIMEOUT_MS}) race of `getContainerRuntimeClient()`
 *     against a timer; ONLY {@link NO_RUNTIME_MESSAGE} (or the timeout, the same "no reachable
 *     endpoint" reached the slow way) marks the fixture unavailable, and everything else rethrows.
 *     The probe MUST fail fast: this module is `await`ed at the top level, and a probe that hangs
 *     takes the whole FILE down instead of skipping it.
 *  7. `Available`/`SkipReason` become module-level consts decided ONCE at load
 *     ({@link spiceDbAvailable} / {@link spiceDbSkipReason}), so `Skip.IfNot(...)` at the top of
 *     each test becomes `ctx.skip(!spiceDbAvailable, spiceDbSkipReason)`.
 */

/** Pinned (not `latest`) so the suite does not flake when upstream publishes a breaking image. */
const SPICEDB_IMAGE = "authzed/spicedb:v1.49.2";

const GRPC_PORT = 50051;

const PRESHARED_KEY = "testkey";

/** The exact message `getContainerRuntimeClient` throws when no runtime strategy works. */
const NO_RUNTIME_MESSAGE = "Could not find a working container runtime strategy";

/** The bound on the Docker endpoint-resolution probe - see port decision 6. */
const PROBE_TIMEOUT_MS = 5_000;

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
    if (err instanceof Error && err.message === NO_RUNTIME_MESSAGE) {
      return { available: false, skipReason: `Docker/Testcontainers unavailable: ${err.message}` };
    }
    throw err;
  }
}

const probe = await probeDocker();

/** `Available`: true when a Docker endpoint answered the probe. */
export const spiceDbAvailable = probe.available;

/** `SkipReason`: why the fixture is unavailable, for the test skip message. */
export const spiceDbSkipReason = probe.skipReason ?? "Docker/SpiceDB container unavailable";

/** The live fixture: the dial address and the pre-shared key the container was started with. */
export interface SpiceDbContainer {
  /** The gRPC endpoint for `SpiceDbGrpcClient`: `host:port`, NO scheme (port decision 4). */
  readonly address: string;
  /** The gRPC pre-shared key configured on the container (also the client's auth header). */
  readonly preSharedKey: string;
}

let started: { container: StartedTestContainer; spiceDb: SpiceDbContainer } | undefined;
let registered = false;

/**
 * Starts the container. Every failure here ESCAPES: Docker is present (the probe answered), so an
 * image-pull or start failure is broken infrastructure, not a reason to skip.
 */
async function start(): Promise<void> {
  const container = await new GenericContainer(SPICEDB_IMAGE)
    .withCommand([
      "serve",
      "--grpc-preshared-key",
      PRESHARED_KEY,
      "--enable-experimental-relationship-expiration",
    ])
    .withExposedPorts(GRPC_PORT)
    .withWaitStrategy(Wait.forLogMessage("grpc server started serving"))
    .start();
  const address = `${container.getHost()}:${container.getMappedPort(GRPC_PORT)}`;
  started = { container, spiceDb: { address, preSharedKey: PRESHARED_KEY } };
}

/**
 * Installs the shared `beforeAll`/`afterAll` pair on the calling FILE's root suite and returns the
 * accessor the suite's tests read the live fixture through (the C#'s injected fixture instance).
 * Calling it twice in one module is a no-op beyond returning the same accessor.
 *
 * TEARDOWN IS UNCONDITIONAL: `afterAll` stops the container even when a test threw, and `started`
 * is cleared BEFORE the stop so a failed stop cannot leak a second attempt.
 */
export function useSpiceDbContainer(): () => SpiceDbContainer {
  if (!registered) {
    registered = true;
    beforeAll(async () => {
      if (!spiceDbAvailable) return;
      await start();
    }, 300_000);
    afterAll(async () => {
      if (started === undefined) return;
      const { container } = started;
      started = undefined;
      await container.stop();
    }, 120_000);
  }
  return () => {
    if (started === undefined) {
      throw new Error("the SpiceDB container fixture is not started (Docker unavailable?)");
    }
    return started.spiceDb;
  };
}
