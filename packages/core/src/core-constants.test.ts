import { describe, expect, it } from "vitest";

import { ELLIPSIS, PUBLIC_WILDCARD } from "./core-constants";

// Characterization of Spiceport `CoreConstants`. A C# `static class` is a namespace, not a
// value, so this ports as two sibling `const` bindings rather than an object literal. These
// two strings are wire-visible in every tuple string; nothing else in the port may hardcode
// "..." or "*".
describe("core constants", () => {
  it("pins the ellipsis relation", () => {
    expect(ELLIPSIS).toBe("...");
  });

  it("pins the public wildcard subject id", () => {
    expect(PUBLIC_WILDCARD).toBe("*");
  });
});
