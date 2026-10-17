import type { status } from "@grpc/grpc-js";
import { expect } from "vitest";

import { RpcError } from "./rpc-error";
import { errorInfoOf, toRpcStatus } from "./rpc-errors";

/**
 * Spiceport's `ErrorInfoTests.AssertErrorInfo`, which `ErrorInfoServiceTests` reaches with
 * `using static`: asserts an error is an {@link RpcError} with `code` whose details carry an
 * `ErrorInfo` with domain `authzed.com`, `reason`, and exactly `metadata`.
 *
 * LEDGER DEVIATION: a plain `.ts` (not `*.test.ts`), shared by the two ported suites, because
 * importing one test file from another would register its cases twice - the deviation
 * `collecting-stream-writer.ts` already took.
 */
export function assertErrorInfo(
  caught: unknown,
  code: status,
  reason: string,
  ...metadata: readonly (readonly [string, string])[]
): void {
  expect(caught).toBeInstanceOf(RpcError);
  const error = caught as RpcError;
  expect(error.code).toBe(code);
  const rpcStatus = toRpcStatus(error);
  expect(rpcStatus.code).toBe(code);
  expect(rpcStatus.message).toBe(error.details);

  const info = errorInfoOf(error);
  expect(info).toBeDefined();
  expect(info?.domain).toBe("authzed.com");
  expect(info?.reason).toBe(reason);
  expect(info?.metadata).toEqual(Object.fromEntries(metadata));
}
