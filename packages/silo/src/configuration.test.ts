import { describe, expect, it } from "vitest";

import { configurationFromEnvironment, createConfiguration } from "./configuration";

describe("createConfiguration", () => {
  it("returns undefined for a key that is not set", () => {
    expect(createConfiguration({}).get("Clustering:Silos")).toBeUndefined();
  });

  it("reads the documented env-var spelling, mapping __ to :", () => {
    expect(createConfiguration({ Clustering__Silos: "a:1" }).get("Clustering:Silos")).toBe("a:1");
  });

  it("compares keys case-insensitively, as .NET configuration does", () => {
    expect(createConfiguration({ "clustering:silos": "a:1" }).get("Clustering:Silos")).toBe("a:1");
    expect(createConfiguration({ "CLUSTERING:SILOS": "a:1" }).get("clustering:silos")).toBe("a:1");
  });

  it("skips undefined values rather than storing them", () => {
    expect(createConfiguration({ "Clustering:Silos": undefined }).get("Clustering:Silos")).toBe(
      undefined,
    );
  });
});

describe("configurationFromEnvironment", () => {
  it("reads the given environment through the same rules", () => {
    expect(configurationFromEnvironment({ Api__GrpcPort: "50051" }).get("Api:GrpcPort")).toBe(
      "50051",
    );
  });
});
