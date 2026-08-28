import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Mirrors thresh's transformer setup: esbuild/Oxc do not support the standard
// TC39 decorators thresh's interop surface uses, so SWC owns transformation.
export default defineConfig({
  oxc: false,
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { decoratorVersion: "2022-03" },
        target: "es2022",
        keepClassNames: true,
      },
    }),
  ],
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts"],
          exclude: ["packages/conformance/**", "packages/differential/**"],
        },
      },
      {
        // The SpiceDB conformance corpus: schema + relationships + assertions
        // driven through both the reference datastore and the grain mesh.
        extends: true,
        test: {
          name: "conformance",
          include: ["packages/conformance/src/**/*.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        // Differential tests against a real authzed/spicedb container. These
        // skip (never fail) when Docker is unavailable.
        extends: true,
        test: {
          name: "differential",
          include: ["packages/differential/src/**/*.test.ts"],
          testTimeout: 120_000,
        },
      },
    ],
  },
});
