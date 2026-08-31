import { describe, expect, it } from "vitest";

import { MaxDepthExceededException } from "./max-depth-exceeded-exception";

// Characterization test. Spiceport has no dedicated test for `MaxDepthExceededException`; it is
// asserted only indirectly, by `CheckEngineTests`' three depth cases. What those cases pin is the
// TYPE, so this file pins the two things a type-based assertion depends on surviving the port:
// `instanceof` across the downlevelled class, and the parameterless overload's exact message.
//
// LEDGER AMENDMENT. `docs/port-ledger.md` mapped `src/Spiceport.Server/MaxDepthExceededException.cs`
// to `packages/grains/src/max-depth-exceeded-exception.ts` (S4). `LocalDispatcher` throws it, and
// `@benedb/engine` cannot import from `@benedb/grains`, so the row is amended to S3 /
// `packages/core/src/...`. The C# file already declares `namespace Spiceport.Core`, so core is
// where it belonged all along; only the .cs file's directory said otherwise.
describe("MaxDepthExceededException", () => {
  it("carries the default max-depth message when constructed with no argument", () => {
    const error = new MaxDepthExceededException();

    expect(error.message).toBe(
      "the check request has exceeded the maximum allowable depth; this usually indicates a " +
        "misconfigured schema or a cycle, and may be raised for legitimately deep data",
    );
  });

  it("carries the supplied reason when constructed with a message", () => {
    const error = new MaxDepthExceededException("depth 3 exhausted");

    expect(error.message).toBe("depth 3 exhausted");
  });

  it("is an Error with a stable name and a surviving instanceof", () => {
    const error = new MaxDepthExceededException();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MaxDepthExceededException);
    expect(error.name).toBe("MaxDepthExceededException");
  });
});
