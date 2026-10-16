import { createHash } from "node:crypto";

import { status } from "@grpc/grpc-js";
import { FormatError } from "@benedb/core/format-error";
import { tryParseRelationship } from "@benedb/core/tuple-strings";
import { fromBase64String, toBase64String } from "@benedb/grains/convert-base64";
import type { Cursor } from "@benedb/protos/authzed/api/v1/core";
import {
  Consistency,
  RelationshipFilter,
  type ReadRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";

import { RpcError } from "./rpc-error";

/**
 * Ported from Spiceport `src/Spiceport.Api/ReadRelationshipsCursor.cs`.
 *
 * The opaque v1 ReadRelationships cursor: standard base64 over a format tag, a hash of the request
 * that minted it, and the canonical tuple of the last relationship returned. Mirrors SpiceDB's
 * `cursor.EncodeFromDispatchCursor` / `DecodeToDispatchCursor` with
 * `computeReadRelationshipsRequestHash`: a cursor resumes only the call it came from (same filter,
 * consistency and limit), and anything else is rejected rather than read as a position.
 *
 * PORT NOTES.
 *  - The C# static class's three members become the three exported functions below, prefixed so
 *    the module's names stay distinct at their call sites.
 *  - The hash is over the same fields in the same framing as the C#: the UTF-8 domain string,
 *    then each field as a 4-byte little-endian length (`BitConverter.GetBytes(int)`) followed by
 *    its bytes; the limit is the 4-byte little-endian `uint` itself. The protobuf fields are
 *    ts-proto's encodings, which are not guaranteed byte-identical to Google.Protobuf's. A token is
 *    only ever handed back to the server that minted it, so only same-runtime determinism matters.
 *  - `new UTF8Encoding(false, throwOnInvalidBytes: true)` is a fatal `TextDecoder`. The detail after
 *    "error decoding cursor: " is .NET's own text for malformed base64 (it comes from the shared
 *    {@link fromBase64String}) and the decoder's own text for invalid UTF-8.
 */

const FORMAT_TAG = "rr1";
const SEPARATOR = "\n";

/** SpiceDB's `ErrHashMismatch` text. */
export const READ_RELATIONSHIPS_HASH_MISMATCH_MESSAGE =
  "the cursor provided does not have the same arguments as the original API call; please ensure you " +
  "are making the same API call, with the exact same parameters (besides the cursor)";

/** The hash binding a cursor to the request: everything but the cursor itself. */
export function readRelationshipsRequestHash(request: ReadRelationshipsRequest): string {
  // As in SpiceDB's computeCallHash, an absent consistency hashes as minimize_latency.
  const consistency = request.consistency ?? Consistency.fromPartial({ minimizeLatency: true });
  const sha = createHash("sha256");
  sha.update(Buffer.from("v1.readrelationships", "utf8"));
  appendField(
    sha,
    request.relationshipFilter === undefined
      ? new Uint8Array(0)
      : RelationshipFilter.encode(request.relationshipFilter).finish(),
  );
  appendField(sha, Consistency.encode(consistency).finish());
  appendField(sha, uint32LittleEndian(request.optionalLimit));
  // `Convert.ToHexString`: UPPERCASE hex.
  return sha.digest("hex").toUpperCase();
}

function appendField(sha: ReturnType<typeof createHash>, bytes: Uint8Array): void {
  sha.update(uint32LittleEndian(bytes.length));
  sha.update(bytes);
}

function uint32LittleEndian(value: number): Uint8Array {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0);
  return bytes;
}

/** Encodes the resume position after `tuple` for the request hashed as `requestHash`. */
export function encodeReadRelationshipsCursor(requestHash: string, tuple: string): string {
  return toBase64String(FORMAT_TAG + SEPARATOR + requestHash + SEPARATOR + tuple);
}

/**
 * Decodes a client cursor to the canonical tuple to resume after, or absent for an absent/empty
 * cursor. Throws SpiceDB's errors: INVALID_ARGUMENT for an undecodable cursor or one minted for
 * another call, FAILED_PRECONDITION when the resume relationship cannot be parsed.
 */
export function decodeReadRelationshipsCursor(
  cursor: Cursor | undefined,
  requestHash: string,
): string | undefined {
  if (cursor === undefined || cursor.token.length === 0) return undefined;

  let raw: string;
  try {
    // `Convert.FromBase64String` validates the shape (and throws .NET's message); the bytes are
    // then decoded strictly, as the C#'s throwing `UTF8Encoding` does.
    fromBase64String(cursor.token);
    raw = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(cursor.token.replace(/[ \t\r\n]/g, ""), "base64"),
    );
  } catch (error) {
    if (!(error instanceof FormatError) && !(error instanceof TypeError)) throw error;
    throw new RpcError(status.INVALID_ARGUMENT, `error decoding cursor: ${error.message}`);
  }

  // `raw.Split(Separator, 3)`: at most three parts, the last keeping any further separators.
  const first = raw.indexOf(SEPARATOR);
  const second = first < 0 ? -1 : raw.indexOf(SEPARATOR, first + 1);
  if (
    second < 0 ||
    raw.slice(0, first) !== FORMAT_TAG ||
    raw.slice(first + 1, second) !== requestHash
  ) {
    throw new RpcError(status.INVALID_ARGUMENT, READ_RELATIONSHIPS_HASH_MISMATCH_MESSAGE);
  }

  const tuple = raw.slice(second + 1);
  if (tryParseRelationship(tuple) === undefined) {
    throw new RpcError(
      status.FAILED_PRECONDITION,
      "the cursor provided is not valid: could not parse resume relationship",
    );
  }

  return tuple;
}
