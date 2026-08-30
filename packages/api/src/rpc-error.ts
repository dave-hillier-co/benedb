import { Metadata, type ServiceError, type status } from "@grpc/grpc-js";

/**
 * The S5 error seam: what Spiceport's `RpcException` becomes in TypeScript.
 *
 * Spiceport's API layer signals a client-visible failure by throwing
 * `new RpcException(new Status(StatusCode.X, detail))`, and its covering suites assert on
 * `ex.StatusCode` and `ex.Status.Detail`. `@grpc/grpc-js` has no such type: what it consumes is a
 * `ServiceError`, an `Error` carrying a numeric `code`, a `details` string and `Metadata`, which
 * `sendUnaryData` and `stream.destroy` propagate to the wire unchanged.
 *
 * `RpcError` is the one type that satisfies both readings, so every S5 file throws it and no
 * caller has to translate at the boundary. It has no Spiceport counterpart file of its own; the
 * ledger records it against `RequestLimits.cs`, the batch that first needed it.
 *
 * The gRPC status numbers are shared with `google.rpc.Code`, which is what lets `toRpcStatus`
 * (see `schema-validation.ts`) copy `code` straight across into a per-pair `google.rpc.Status`.
 */
export class RpcError extends Error implements Partial<ServiceError> {
  /** The gRPC status code, as C# `RpcException.StatusCode`. */
  readonly code: status;

  /** The status detail, as C# `RpcException.Status.Detail`. Also this error's `message`. */
  readonly details: string;

  /** Trailing metadata. Spiceport never sets any; an empty instance keeps the `ServiceError` shape. */
  readonly metadata: Metadata;

  constructor(code: status, details: string) {
    super(details);
    this.name = "RpcError";
    this.code = code;
    this.details = details;
    this.metadata = new Metadata();
  }
}

/** Narrows an unknown caught value to an {@link RpcError}. */
export function isRpcError(value: unknown): value is RpcError {
  return value instanceof RpcError;
}
