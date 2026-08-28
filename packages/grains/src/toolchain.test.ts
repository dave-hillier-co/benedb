import { GrainId } from "@thresh/core/grain-id";
import { describe, expect, it } from "vitest";

// Part of the S0 gate: the workspace resolves Thresh through the sibling checkout, and
// SWC transforms its TypeScript. If this fails, no ported grain can be trusted to be
// failing for its own reasons.
describe("toolchain", () => {
  it("resolves Thresh from the linked sibling checkout", () => {
    expect(new GrainId("Check", "document:budget#viewer").toString()).toBe(
      "Check/document:budget#viewer",
    );
  });
});
