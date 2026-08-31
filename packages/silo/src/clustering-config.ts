import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { SiloAddress } from "@thresh/core/silo-address";
import type { SiloBuilder } from "@thresh/hosting/silo-builder";
import { InProcessNetwork } from "@thresh/messaging/in-process-transport";

import type { Configuration } from "./datastore-storage-config";
import {
  DATASTORE_CONNECTION_STRING_KEY,
  resolveDatastoreConnectionString,
} from "./datastore-storage-config";

/**
 * NO SPICEPORT SOURCE. Spiceport's two hosts call `silo.UseLocalhostClustering();` and nothing
 * else - it has no deployment configuration, no Dockerfile and no manifests - so there is nothing
 * to transliterate here. This file is the port's own DEVIATION, standing in for Orleans'
 * `UseLocalhostClustering(siloPort, gatewayPort, primarySiloEndpoint)`, which is exactly how
 * Orleans runs several silos on one machine. The port ledger carries a row for it under "Files
 * with no Spiceport source", so its absence from the C# reads as a decision rather than a gap.
 *
 * It is the direct SIBLING of `datastore-storage-config.ts` and is shared by both hosts the same
 * way that file already is. That is not the shared host helper `CLAUDE.md` forbids: what must stay
 * duplicated is `configureApiSilo` / `configureSiloHost` themselves, which are independently
 * maintained in the C#. A configuration READER shared by both is the precedent this repo already
 * set, and each host keeps its own call site.
 *
 * DESIGN DECISIONS.
 *
 *  1. THE PRESENCE OF A SILO LIST IS THE SWITCH. There is no separate `Clustering:Mode` key,
 *     because a mode key alongside a list is the classic footgun of configuring a cluster and
 *     forgetting to enable it (or enabling it with no list). One key carries both the intent and
 *     the data, so it cannot be half-set, and an unset/blank list resolves to exactly today's
 *     single-process host.
 *  2. IDENTITY IS DERIVED ENTIRELY FROM THE ENDPOINT - `local = (endpoint, "uid-"+endpoint,
 *     endpoint)` - and EVERY entry of `Clustering:Silos` is turned into an address by the SAME
 *     rule. `useStaticMembership` takes the whole view, so each silo must reconstruct its peers'
 *     addresses bit-identically to how those peers construct their own; otherwise a silo's entry in
 *     the shared view differs from its own `local` and it dials itself over the wire. A
 *     `Clustering:SiloName` knob cannot satisfy that (a peer cannot know a name only that peer's
 *     environment sets), and deriving the name from each host's own constant is worse still,
 *     because an API host and a silo host in one cluster would then name the same peer differently.
 *     `SiloAddress.ringKey` is `podName` alone, so two silos sharing the hosts' constant name would
 *     be ONE ring position regardless of their ports - a directory split-brain, not a cosmetic
 *     clash. This also mirrors Orleans, where the ring identity IS `IP:port:generation` and the
 *     silo name is cosmetic. A deterministic `podUid` is correct rather than a compromise: static
 *     membership has no join/leave protocol, so a restarted silo rejoining at the same endpoint
 *     with the same identity is the intended behaviour.
 *  3. THE ADVERTISED HOST IS ALSO THE BIND HOST. `WebSocketTransport` splits this ONE endpoint for
 *     both purposes (and `SiloBuilder.embeddedClientLeg` takes the same host at port 0 for the
 *     observer seam), so a wildcard is rejected rather than accepted and then advertised to peers
 *     as something they cannot reach.
 *  4. THE ONLY DEVIATION FROM ORLEANS' SHAPE THAT MATTERS: Orleans' development clustering gossips
 *     through a PRIMARY endpoint, so a joiner needs only that one address. Thresh has no
 *     development/gossip membership provider - `useStaticMembership` takes the whole view - so
 *     every silo is handed the identical full list. A `Clustering:PrimarySilo` key becomes possible
 *     only if Thresh grows a development-membership provider.
 *  5. NO `Clustering:ClusterId` / `ServiceId`, AND NO GATEWAY PORT. Both hosts already fix the
 *     cluster id as a constant, exactly as `UseLocalhostClustering` defaults `DevelopmentClusterId`
 *     / `DevelopmentServiceId`; and Orleans' second port has no counterpart, because a Thresh silo
 *     has ONE endpoint and the embedded client leg takes an ephemeral port off the same host.
 *  6. PARSING FOLLOWS THE C# IT STANDS IN FOR. `IsNullOrWhiteSpace` decides "absent"; a port must
 *     parse as an integer in 1-65535; the boolean takes `bool.TryParse`'s case-insensitive
 *     `true`/`false` and is made LOUD rather than silently false, because a typo in the one key
 *     that says "this cluster's state is disposable" must not read as "no".
 */

/**
 * The silo list, and the switch: comma-separated `host:port` endpoints covering the WHOLE cluster,
 * this silo included. Unset or blank keeps the single-process default (env
 * `Clustering__Silos`).
 */
export const CLUSTERING_SILOS_KEY = "Clustering:Silos";

/** This silo's listen/advertise port - Orleans' `EndpointOptions.DEFAULT_SILO_PORT`. */
export const CLUSTERING_SILO_PORT_KEY = "Clustering:SiloPort";

/** This silo's bind AND advertised host - Orleans' `AdvertisedIPAddress = IPAddress.Loopback`. */
export const CLUSTERING_ADVERTISED_HOST_KEY = "Clustering:AdvertisedHost";

/** Opt-in to a clustered silo over per-silo in-memory grain storage - see {@link resolveClustering}. */
export const CLUSTERING_ALLOW_IN_MEMORY_STORAGE_KEY = "Clustering:AllowInMemoryStorage";

/** `EndpointOptions.DEFAULT_SILO_PORT`. */
export const DEFAULT_SILO_PORT = 11111;

/** `EndpointOptions.AdvertisedIPAddress = IPAddress.Loopback` - the same-machine cluster's scope. */
export const DEFAULT_ADVERTISED_HOST = "127.0.0.1";

/**
 * Hosts that name every interface rather than one dialable address. A silo advertises the host it
 * binds, so a wildcard would be handed to peers as the address to dial back - see design decision 3.
 */
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(["0.0.0.0", "::", "[::]", "*"]);

/** How this host joins its cluster: today's single process, or a static multi-silo view. */
export type ClusteringOptions =
  | {
      readonly kind: "singleProcess";
    }
  | {
      readonly kind: "clustered";
      /** This silo's own address, derived from its endpoint (design decision 2). */
      readonly local: SiloAddress;
      /** The WHOLE static view, self included, in configured order (design decision 4). */
      readonly silos: readonly SiloAddress[];
    };

/** `string.IsNullOrWhiteSpace` - a value of `" "` is absent for every decision in this file. */
function isNullOrWhiteSpace(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

/**
 * `int.TryParse` bounded to a TCP port, made loud. Absent or whitespace takes `fallback`; anything
 * that is not a whole number in 1-65535 throws NAMING THE KEY, because a mistyped port otherwise
 * surfaces as a bind or dial failure with nothing pointing back at the variable that caused it.
 *
 * Exported because the API host reads `Api:GrpcPort` / `Api:HttpPort` through the identical rule -
 * the same idiom, not a second configuration mechanism.
 */
export function readConfiguredPort(
  configuration: Configuration,
  key: string,
  fallback: number,
): number {
  const raw = configuration.get(key);
  if (isNullOrWhiteSpace(raw)) return fallback;

  const text = (raw as string).trim();
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError(
      `${key} must be a port between 1 and 65535, but was "${raw as string}"`,
    );
  }
  return port;
}

/** `bool.TryParse`, made loud: absent takes `fallback`, anything unrecognised throws. */
function readConfiguredBoolean(
  configuration: Configuration,
  key: string,
  fallback: boolean,
): boolean {
  const raw = configuration.get(key);
  if (isNullOrWhiteSpace(raw)) return fallback;

  const text = (raw as string).trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  throw new InvalidArgumentError(`${key} must be "true" or "false", but was "${raw as string}"`);
}

/** The one identity rule, applied to this silo and to every peer alike (design decision 2). */
function addressForEndpoint(endpoint: string): SiloAddress {
  return new SiloAddress(endpoint, `uid-${endpoint}`, endpoint);
}

/** Splits `host:port` at the LAST colon, so an IPv6 literal in brackets survives. */
function parseEndpoint(entry: string, key: string): string {
  const separator = entry.lastIndexOf(":");
  const host = separator < 0 ? "" : entry.slice(0, separator);
  const port = separator < 0 ? "" : entry.slice(separator + 1);
  if (
    host.length === 0 ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    WILDCARD_HOSTS.has(host)
  ) {
    throw new InvalidArgumentError(
      `${key} entries must be "host:port" with a dialable host, but one was "${entry}"`,
    );
  }
  return `${host}:${port}`;
}

/**
 * Reads the clustering branch out of configuration. PURE and deterministic: it builds no silo,
 * touches no socket and has no side effect, so a host can resolve it BEFORE `createSilo` - which it
 * must, because `SiloConfig.local` is constructor input.
 *
 * @throws InvalidArgumentError on a clustered configuration that cannot work: a silo missing from
 * its own view, an unparseable port or entry, a wildcard advertised host, an unrecognised boolean,
 * or per-silo in-memory grain storage with no explicit opt-in.
 */
export function resolveClustering(configuration: Configuration): ClusteringOptions {
  if (configuration === undefined || configuration === null) {
    throw new InvalidArgumentError("configuration is required");
  }

  const configuredSilos = configuration.get(CLUSTERING_SILOS_KEY);
  if (isNullOrWhiteSpace(configuredSilos)) return { kind: "singleProcess" };

  const configuredHost = configuration.get(CLUSTERING_ADVERTISED_HOST_KEY);
  const advertisedHost = isNullOrWhiteSpace(configuredHost)
    ? DEFAULT_ADVERTISED_HOST
    : (configuredHost as string).trim();
  if (WILDCARD_HOSTS.has(advertisedHost)) {
    // A silo advertises what it binds, so peers would be told to dial a wildcard - see decision 3.
    throw new InvalidArgumentError(
      `${CLUSTERING_ADVERTISED_HOST_KEY} must be an address peers can dial, but was ` +
        `"${advertisedHost}"; it is both the bind address and the advertised one`,
    );
  }

  const siloPort = readConfiguredPort(configuration, CLUSTERING_SILO_PORT_KEY, DEFAULT_SILO_PORT);
  const local = addressForEndpoint(`${advertisedHost}:${siloPort}`);

  const silos = (configuredSilos as string)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => addressForEndpoint(parseEndpoint(entry, CLUSTERING_SILOS_KEY)));

  if (!silos.some((silo) => silo.equals(local))) {
    // Otherwise this fails much later as an obscure placement error, with nothing naming the cause.
    throw new InvalidArgumentError(
      `${CLUSTERING_SILOS_KEY} must contain this silo's own endpoint "${local.endpoint}", but was ` +
        `"${configuredSilos as string}"`,
    );
  }

  const allowInMemoryStorage = readConfiguredBoolean(
    configuration,
    CLUSTERING_ALLOW_IN_MEMORY_STORAGE_KEY,
    false,
  );
  if (
    !allowInMemoryStorage &&
    isNullOrWhiteSpace(resolveDatastoreConnectionString(configuration))
  ) {
    // THE DATASTORE GRAIN IS A CLUSTER SINGLETON over a grain-storage provider, and
    // `addDatastoreGrainStorage`'s fallback branch constructs a MemoryGrainStorage PER SILO. The
    // grain declares no placement, so after an idle deactivation it reactivates on an arbitrary
    // silo and reads an EMPTY store: not merely non-durable across restarts, but silent data loss
    // during normal operation. (`MeshTestCluster` shares ONE storage instance across its silos for
    // exactly this reason; the production wiring never had to.) Refusing at configure time is the
    // house idiom - `requireObserverHosting`, `validateClassSpecificCollectionAges` and "no
    // membership configured" all fail at build rather than in production - and a warning has
    // nowhere to go, because neither host configures a logger.
    throw new InvalidArgumentError(
      `a clustered silo needs durable grain storage: set ${DATASTORE_CONNECTION_STRING_KEY} (env ` +
        `ConnectionStrings__OrleansStorage), or set ${CLUSTERING_ALLOW_IN_MEMORY_STORAGE_KEY}=true ` +
        `to accept that the singleton datastore grain's state is per-silo and disposable`,
    );
  }

  return { kind: "clustered", local, silos };
}

/** The exhaustiveness guard for {@link ClusteringOptions}' discriminant. */
function assertNever(value: never): never {
  throw new InvalidArgumentError(`unhandled clustering kind: ${JSON.stringify(value)}`);
}

/**
 * `silo.UseLocalhostClustering();` - the membership view and the transport, and nothing else.
 *
 * The two branches are EXPLICIT rather than one parameterised path, so the single-process default
 * emits byte-identically what both hosts emit today and reads `builder.local` rather than any
 * re-resolved address. A builder handed in by a test therefore records exactly the calls, with
 * exactly the arguments, that it records today.
 */
export function applyClustering(builder: SiloBuilder, options: ClusteringOptions): SiloBuilder {
  if (builder === undefined || builder === null) {
    throw new InvalidArgumentError("builder is required");
  }
  if (options === undefined || options === null) {
    throw new InvalidArgumentError("options is required");
  }

  switch (options.kind) {
    case "singleProcess":
      builder.useStaticMembership([builder.local]);
      builder.useInProcessTransport(new InProcessNetwork());
      return builder;
    case "clustered": {
      if (!options.local.equals(builder.local)) {
        // The resolved address is what peers dial; the builder's is what this silo answers as.
        throw new InvalidArgumentError(
          `the resolved silo address "${options.local.toString()}" is not the address this silo ` +
            `was created with ("${builder.local.toString()}")`,
        );
      }
      builder.useStaticMembership(options.silos);
      builder.useWebSocketTransport();
      return builder;
    }
    default:
      return assertNever(options);
  }
}
