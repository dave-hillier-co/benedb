import { SiloAddress } from "@thresh/core/silo-address";
import { createSilo, type SiloBuilder } from "@thresh/hosting/silo-builder";

import { describe, expect, it } from "vitest";

import {
  CLUSTERING_ADVERTISED_HOST_KEY,
  CLUSTERING_ALLOW_IN_MEMORY_STORAGE_KEY,
  CLUSTERING_SILOS_KEY,
  CLUSTERING_SILO_PORT_KEY,
  DEFAULT_ADVERTISED_HOST,
  DEFAULT_SILO_PORT,
  applyClustering,
  readConfiguredPort,
  resolveClustering,
} from "./clustering-config";
import { createConfiguration } from "./datastore-storage-config";

/**
 * PORT-LOCAL suite: `clustering-config.ts` has no Spiceport source (Spiceport calls only
 * `silo.UseLocalhostClustering()` and has no deployment configuration), so there is no C# suite to
 * transliterate. What is pinned is the whole resolution contract, because every one of its
 * rejections stands in for a misconfiguration that would otherwise surface much later as an
 * obscure placement or dial failure in a running cluster.
 *
 * NOTHING HERE BUILDS OR STARTS A SILO. `applyClustering` is exercised through a recording proxy
 * over a real `SiloBuilder` that is never `build()`-ed, the same shape both program suites use.
 */

/** A builder whose transport/membership calls are recorded rather than asserted on the object. */
function recordingBuilder(local: SiloAddress): {
  builder: SiloBuilder;
  calls: { name: string; args: readonly unknown[] }[];
} {
  const target = createSilo({ clusterId: "spacedb-clustering-test", local });
  const calls: { name: string; args: readonly unknown[] }[] = [];
  const proxy: SiloBuilder = new Proxy(target, {
    get(receiver, property) {
      const value = Reflect.get(receiver, property);
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        calls.push({ name: property, args });
        const result = (value as (...a: unknown[]) => unknown).apply(receiver, args);
        return result === receiver ? proxy : result;
      };
    },
  }) as SiloBuilder;
  return { builder: proxy, calls };
}

/** The endpoint-derived identity rule, restated here so the test does not trust the subject's. */
function addressFor(endpoint: string): SiloAddress {
  return new SiloAddress(endpoint, `uid-${endpoint}`, endpoint);
}

/** Everything a clustered configuration needs beyond the silo list. */
const DURABLE = { "ConnectionStrings:OrleansStorage": "postgres://localhost/spacedb" };

describe("resolveClustering", () => {
  it("resolves to the single-process default when Clustering:Silos is absent", () => {
    expect(resolveClustering(createConfiguration({}))).toEqual({ kind: "singleProcess" });
  });

  it("treats a whitespace-only silo list as absent, as IsNullOrWhiteSpace does", () => {
    expect(resolveClustering(createConfiguration({ [CLUSTERING_SILOS_KEY]: "   " }))).toEqual({
      kind: "singleProcess",
    });
  });

  it("switches to clustered on the mere presence of a silo list", () => {
    const options = resolveClustering(
      createConfiguration({
        ...DURABLE,
        [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111,127.0.0.1:11112",
      }),
    );

    expect(options.kind).toBe("clustered");
  });

  it("derives this silo's identity from its own endpoint, defaults included", () => {
    const options = resolveClustering(
      createConfiguration({
        ...DURABLE,
        [CLUSTERING_SILOS_KEY]: `${DEFAULT_ADVERTISED_HOST}:${DEFAULT_SILO_PORT}`,
      }),
    );

    expect(options.kind === "clustered" && options.local).toEqual(
      addressFor(`${DEFAULT_ADVERTISED_HOST}:${DEFAULT_SILO_PORT}`),
    );
  });

  it("moves the whole identity when only the silo port changes", () => {
    const options = resolveClustering(
      createConfiguration({
        ...DURABLE,
        [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111,127.0.0.1:11112",
        [CLUSTERING_SILO_PORT_KEY]: "11112",
      }),
    );

    expect(options.kind === "clustered" && options.local).toEqual(addressFor("127.0.0.1:11112"));
  });

  it("honours a configured advertised host for both this silo and its endpoint", () => {
    const options = resolveClustering(
      createConfiguration({
        ...DURABLE,
        [CLUSTERING_ADVERTISED_HOST_KEY]: "10.1.2.3",
        [CLUSTERING_SILOS_KEY]: "10.1.2.3:11111",
      }),
    );

    expect(options.kind === "clustered" && options.local.endpoint).toBe("10.1.2.3:11111");
  });

  it("hands back the WHOLE view, self included, in configured order", () => {
    const options = resolveClustering(
      createConfiguration({
        ...DURABLE,
        [CLUSTERING_SILOS_KEY]: " 127.0.0.1:11111 , 127.0.0.1:11112 ,127.0.0.1:11113",
      }),
    );

    expect(options.kind === "clustered" && options.silos).toEqual([
      addressFor("127.0.0.1:11111"),
      addressFor("127.0.0.1:11112"),
      addressFor("127.0.0.1:11113"),
    ]);
  });

  it("derives a peer's address by the SAME rule that peer derives for itself", () => {
    const first = resolveClustering(
      createConfiguration({
        ...DURABLE,
        [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111,127.0.0.1:11112",
      }),
    );
    const second = resolveClustering(
      createConfiguration({
        ...DURABLE,
        [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111,127.0.0.1:11112",
        [CLUSTERING_SILO_PORT_KEY]: "11112",
      }),
    );

    // The second silo's own `local` must be bit-identical to the entry the first silo derived for
    // it, or each dials the other as a stranger (and itself over the wire).
    expect(second.kind === "clustered" && first.kind === "clustered" && first.silos[1]).toEqual(
      second.kind === "clustered" ? second.local : undefined,
    );
  });

  it("reads the `__` environment spelling of every key, case-insensitively", () => {
    const options = resolveClustering(
      createConfiguration({
        ConnectionStrings__OrleansStorage: "postgres://localhost/spacedb",
        clustering__silos: "127.0.0.1:11111,127.0.0.1:11112",
        CLUSTERING__SILOPORT: "11112",
        Clustering__AdvertisedHost: "127.0.0.1",
      }),
    );

    expect(options.kind === "clustered" && options.local.endpoint).toBe("127.0.0.1:11112");
  });

  it("rejects a silo absent from its own configured view", () => {
    expect(() =>
      resolveClustering(
        createConfiguration({ ...DURABLE, [CLUSTERING_SILOS_KEY]: "127.0.0.1:11112" }),
      ),
    ).toThrow(/127\.0\.0\.1:11111/);
  });

  it("rejects an unparseable silo port", () => {
    expect(() =>
      resolveClustering(
        createConfiguration({
          ...DURABLE,
          [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111",
          [CLUSTERING_SILO_PORT_KEY]: "eleven",
        }),
      ),
    ).toThrow(/Clustering:SiloPort/);
  });

  it("rejects a silo port outside 1-65535", () => {
    expect(() =>
      resolveClustering(
        createConfiguration({
          ...DURABLE,
          [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111",
          [CLUSTERING_SILO_PORT_KEY]: "70000",
        }),
      ),
    ).toThrow(/Clustering:SiloPort/);
  });

  it("rejects a malformed entry in the silo list", () => {
    expect(() =>
      resolveClustering(
        createConfiguration({
          ...DURABLE,
          [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111,127.0.0.1",
        }),
      ),
    ).toThrow(/Clustering:Silos/);
  });

  it("rejects a wildcard advertised host, which peers cannot dial back", () => {
    for (const wildcard of ["0.0.0.0", "::", "[::]"]) {
      expect(() =>
        resolveClustering(
          createConfiguration({
            ...DURABLE,
            [CLUSTERING_ADVERTISED_HOST_KEY]: wildcard,
            [CLUSTERING_SILOS_KEY]: `${wildcard}:11111`,
          }),
        ),
      ).toThrow(/Clustering:AdvertisedHost/);
    }
  });

  it("rejects a non-boolean AllowInMemoryStorage rather than reading it as false", () => {
    expect(() =>
      resolveClustering(
        createConfiguration({
          ...DURABLE,
          [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111",
          [CLUSTERING_ALLOW_IN_MEMORY_STORAGE_KEY]: "yes",
        }),
      ),
    ).toThrow(/Clustering:AllowInMemoryStorage/);
  });

  it("refuses to cluster over per-silo in-memory grain storage", () => {
    // The datastore grain is a cluster singleton and its default MemoryGrainStorage is constructed
    // PER SILO, so its state lives only on the silo the activation happens to be on.
    expect(() =>
      resolveClustering(createConfiguration({ [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111" })),
    ).toThrow(/ConnectionStrings:OrleansStorage/);
  });

  it("allows a disposable dev cluster when the operator opts in explicitly", () => {
    const options = resolveClustering(
      createConfiguration({
        [CLUSTERING_SILOS_KEY]: "127.0.0.1:11111",
        [CLUSTERING_ALLOW_IN_MEMORY_STORAGE_KEY]: "TRUE",
      }),
    );

    expect(options.kind).toBe("clustered");
  });

  it("leaves the single-process default untouched by an in-memory datastore", () => {
    expect(resolveClustering(createConfiguration({}))).toEqual({ kind: "singleProcess" });
  });
});

describe("readConfiguredPort", () => {
  it("falls back to the default when the key is absent or whitespace", () => {
    expect(readConfiguredPort(createConfiguration({}), "Api:GrpcPort", 50051)).toBe(50051);
    expect(
      readConfiguredPort(createConfiguration({ "Api:GrpcPort": " " }), "Api:GrpcPort", 50051),
    ).toBe(50051);
  });

  it("parses a configured port", () => {
    expect(
      readConfiguredPort(createConfiguration({ Api__GrpcPort: "50052" }), "Api:GrpcPort", 50051),
    ).toBe(50052);
  });

  it("rejects anything that is not a port, naming the key", () => {
    expect(() =>
      readConfiguredPort(createConfiguration({ "Api:GrpcPort": "50051.5" }), "Api:GrpcPort", 50051),
    ).toThrow(/Api:GrpcPort/);
    expect(() =>
      readConfiguredPort(createConfiguration({ "Api:GrpcPort": "0" }), "Api:GrpcPort", 50051),
    ).toThrow(/Api:GrpcPort/);
  });
});

describe("applyClustering", () => {
  it("wires the in-process transport and a one-address view for the single-process default", () => {
    const { builder, calls } = recordingBuilder(
      new SiloAddress("spiceport-silo", "uid-spiceport-silo", "spiceport-silo:11111"),
    );

    applyClustering(builder, { kind: "singleProcess" });

    const membership = calls.filter((call) => call.name === "useStaticMembership");
    expect(membership).toHaveLength(1);
    expect(membership[0]?.args[0]).toEqual([builder.local]);
    expect(calls.filter((call) => call.name === "useInProcessTransport")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "useWebSocketTransport")).toHaveLength(0);
  });

  it("wires the WebSocket transport and the full peer view when clustered", () => {
    const local = addressFor("127.0.0.1:11112");
    const silos = [addressFor("127.0.0.1:11111"), local];
    const { builder, calls } = recordingBuilder(local);

    applyClustering(builder, { kind: "clustered", local, silos });

    expect(calls.filter((call) => call.name === "useWebSocketTransport")).toHaveLength(1);
    expect(calls.filter((call) => call.name === "useInProcessTransport")).toHaveLength(0);
    expect(calls.find((call) => call.name === "useStaticMembership")?.args[0]).toEqual(silos);
  });

  it("rejects a resolved address that is not the one the silo was constructed with", () => {
    const { builder } = recordingBuilder(addressFor("127.0.0.1:11111"));
    const local = addressFor("127.0.0.1:11112");

    expect(() => applyClustering(builder, { kind: "clustered", local, silos: [local] })).toThrow(
      /127\.0\.0\.1:11112/,
    );
  });

  it("guards both arguments, as the ported hosts' ThrowIfNull pairs do", () => {
    const { builder } = recordingBuilder(addressFor("127.0.0.1:11111"));

    expect(() =>
      applyClustering(undefined as unknown as SiloBuilder, { kind: "singleProcess" }),
    ).toThrow();
    expect(() =>
      applyClustering(builder, undefined as unknown as ReturnType<typeof resolveClustering>),
    ).toThrow();
  });
});
