import { Metadata, status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";

import { RpcError, isRpcError } from "./rpc-error";

/**
 * Characterization test for the S5 error seam.
 *
 * Spiceport's API layer throws `RpcException(new Status(StatusCode.X, detail))` and its covering
 * suites assert on `ex.StatusCode` and `ex.Status.Detail`. `@grpc/grpc-js` has no `RpcException`;
 * what it consumes is a `ServiceError` — an `Error` that additionally carries a numeric `code`, a
 * `details` string and a `Metadata`. `RpcError` is the single type that satisfies both: every S5
 * file throws it, and it can be handed straight to `sendUnaryData` / `stream.destroy` unchanged.
 *
 * There is no C# test for this file (it has no C# counterpart at all), so these cases pin the
 * seam's observable contract rather than restating its implementation.
 */
describe("RpcError", () => {
  it("is an Error", () => {
    const err = new RpcError(status.INVALID_ARGUMENT, "boom");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RpcError);
  });

  it("carries the numeric grpc status code, as `ex.StatusCode` does in C#", () => {
    expect(new RpcError(status.INVALID_ARGUMENT, "boom").code).toBe(status.INVALID_ARGUMENT);
    expect(new RpcError(status.FAILED_PRECONDITION, "boom").code).toBe(status.FAILED_PRECONDITION);
    expect(new RpcError(status.NOT_FOUND, "boom").code).toBe(status.NOT_FOUND);
  });

  it("carries the detail string, as `ex.Status.Detail` does in C#", () => {
    const err = new RpcError(status.INVALID_ARGUMENT, "object definition `foo` not found");

    expect(err.details).toBe("object definition `foo` not found");
  });

  it("uses the detail as its Error message, so an unhandled throw reads sensibly", () => {
    const err = new RpcError(status.INVALID_ARGUMENT, "too many updates (1001)");

    expect(err.message).toBe("too many updates (1001)");
  });

  it("names itself, so a caught value is identifiable without instanceof", () => {
    expect(new RpcError(status.INTERNAL, "x").name).toBe("RpcError");
  });

  it("carries a Metadata instance, which grpc-js's ServiceError shape requires", () => {
    const err = new RpcError(status.INTERNAL, "x");

    expect(err.metadata).toBeInstanceOf(Metadata);
  });

  it("preserves an empty detail rather than substituting one", () => {
    const err = new RpcError(status.CANCELLED, "");

    expect(err.details).toBe("");
    expect(err.message).toBe("");
  });

  describe("isRpcError", () => {
    it("recognises an RpcError", () => {
      expect(isRpcError(new RpcError(status.INTERNAL, "x"))).toBe(true);
    });

    it("rejects a plain Error, and non-errors", () => {
      expect(isRpcError(new Error("x"))).toBe(false);
      expect(isRpcError(undefined)).toBe(false);
      expect(isRpcError({ code: 3, details: "x" })).toBe(false);
    });
  });
});
