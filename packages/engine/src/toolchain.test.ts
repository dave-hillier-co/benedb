import { createEnv } from "@bufbuild/cel";
import { createRegistry } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

// Part of the S0 gate: the CEL evaluator caveats are built on can parse, plan and
// evaluate an expression against a supplied context — the exact mechanism a caveat
// needs. Spiceport uses the .NET `Cel` package for this; SpiceDB uses cel-go.
//
// Note `createEnv`, not `new CelEnv()`: the bare constructor leaves the parser unset.
describe("toolchain", () => {
  it("evaluates a caveat-shaped expression against a context", () => {
    const env = createEnv("", createRegistry());
    env.set("allowed_ips", ["10.0.0.1", "10.0.0.2"]);

    env.set("user_ip", "10.0.0.2");
    expect(env.run("user_ip in allowed_ips")).toBe(true);

    env.set("user_ip", "10.0.0.9");
    expect(env.run("user_ip in allowed_ips")).toBe(false);
  });
});
