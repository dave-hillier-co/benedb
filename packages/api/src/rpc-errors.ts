import { Metadata, type status } from "@grpc/grpc-js";
import { errorReasonToJSON, type ErrorReason } from "@benedb/protos/authzed/api/v1/error_reason";
import { ErrorInfo } from "@benedb/protos/google/rpc/error_info";
import { Status } from "@benedb/protos/google/rpc/status";

import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `src/Spiceport.Api/RpcErrors.cs`.
 *
 * The structured error detail SpiceDB attaches to the errors it gives a reason: a
 * `google.rpc.ErrorInfo` with domain `authzed.com`, the `authzed.api.v1.ErrorReason` name as its
 * reason, and the error's metadata, carried in the status's details (the `grpc-status-details-bin`
 * trailer). Mirrors `pkg/spiceerrors`' `WithCodeAndDetails` and `ForReason`.
 *
 * Port decisions:
 *   * The C# `static class` becomes sibling bindings; `RpcException(Status, Metadata)` is
 *     `new RpcError(code, details, metadata)`, whose metadata grpc-js sends as trailers.
 *   * `Any.Pack` is spelled out: the type URL is `type.googleapis.com/` and the full name.
 */

/** SpiceDB's `spiceerrors.Domain`. */
export const DOMAIN = "authzed.com";

/** The trailer gRPC carries a status's details in. */
export const STATUS_DETAILS_TRAILER = "grpc-status-details-bin";

const ERROR_INFO_TYPE_URL = "type.googleapis.com/google.rpc.ErrorInfo";

/**
 * An {@link RpcError} with `code` and `message` whose details carry an `ErrorInfo` for `reason` and
 * `metadata`.
 */
export function rpcErrorWithReason(
  code: status,
  message: string,
  reason: ErrorReason,
  metadata: readonly (readonly [string, string])[] = [],
): RpcError {
  const info: ErrorInfo = { reason: reasonName(reason), domain: DOMAIN, metadata: {} };
  for (const [key, value] of metadata) info.metadata[key] = value;

  const rpcStatus: Status = {
    code,
    message,
    details: [{ typeUrl: ERROR_INFO_TYPE_URL, value: ErrorInfo.encode(info).finish() }],
  };
  const trailers = new Metadata();
  trailers.set(STATUS_DETAILS_TRAILER, Buffer.from(Status.encode(rpcStatus).finish()));
  return new RpcError(code, message, trailers);
}

/**
 * The `google.rpc.Status` an {@link RpcError} stands for: its code and detail, with the details it
 * carries in its `grpc-status-details-bin` trailer, as Go's `status.Convert(err).Proto()` gives them.
 */
export function toRpcStatus(error: RpcError): Status {
  const trailer = error.metadata.get(STATUS_DETAILS_TRAILER)[0];
  if (trailer instanceof Buffer) return Status.decode(trailer);

  return { code: error.code, message: error.details, details: [] };
}

/** The `ErrorInfo` an {@link RpcError} carries, or `undefined` when it has none. */
export function errorInfoOf(error: RpcError): ErrorInfo | undefined {
  const detail = toRpcStatus(error).details.find((d) => d.typeUrl === ERROR_INFO_TYPE_URL);
  return detail === undefined ? undefined : ErrorInfo.decode(detail.value);
}

/** The proto name of `reason` (`ERROR_REASON_...`), as Go's `ErrorReason_name`. */
export function reasonName(reason: ErrorReason): string {
  return errorReasonToJSON(reason);
}
