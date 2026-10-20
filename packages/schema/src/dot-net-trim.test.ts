import { describe, expect, it } from "vitest";

import { dotNetTrim } from "./dot-net-trim";

describe("dotNetTrim", () => {
  it("strips .NET whitespace from both ends, including NEL and the C0 controls", () => {
    expect(dotNetTrim("\u0085\t\v\f\r\n x y  　")).toBe("x y");
  });

  it("keeps U+FEFF, which JS trim would strip but .NET Trim does not", () => {
    expect(dotNetTrim("﻿x﻿")).toBe("﻿x﻿");
  });

  it("returns the empty string for all-whitespace input", () => {
    expect(dotNetTrim(" \t\u0085 ")).toBe("");
  });
});
