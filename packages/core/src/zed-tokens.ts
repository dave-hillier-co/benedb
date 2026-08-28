import type { DecodedRevision } from "./decoded-revision";
import type { IRevision } from "./i-revision";
import type { IRevisionParser } from "./i-revision-parser";
import { InvalidArgumentError } from "./invalid-argument-error";
import { TimestampRevision } from "./timestamp-revision";
import type { ZedToken } from "./zed-token";

/**
 * Encoding and decoding helpers for `ZedToken`.
 *
 * The on-the-wire form is base64 of a newline-delimited record:
 *
 *     v1\n{datastoreId}\n{revisionString}\n{schemaHash}
 *
 * where `datastoreId` and `schemaHash` may be empty. This is intentionally simple (not protobuf)
 * but stable and round-trippable.
 */
const VERSION = "v1";

// .NET's `Convert.FromBase64String` IGNORES these four whitespace characters anywhere in the
// input, then rejects everything else that is not well-formed standard base64.
const IGNORED_WHITESPACE = /[ \t\n\r]/g;
const STANDARD_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)?$/;

/** Mints a `ZedToken` from a revision, optional schema hash, and datastore id. */
export function zedTokenFromRevision(
  revision: IRevision,
  schemaHash?: string | undefined,
  datastoreUniqueId?: string | undefined,
): ZedToken {
  if (revision === undefined || revision === null) {
    throw new InvalidArgumentError("revision must not be null");
  }
  const payload = [VERSION, datastoreUniqueId ?? "", revision.toString(), schemaHash ?? ""].join(
    "\n",
  );
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  return { token: encoded };
}

/**
 * Decodes a `ZedToken` using the supplied parser to reconstruct the revision and to determine
 * datastore-id match status.
 */
export function decodeRevision(token: ZedToken, parser: IRevisionParser): DecodedRevision {
  if (token === undefined || token === null) {
    throw new InvalidArgumentError("token must not be null");
  }
  if (parser === undefined || parser === null) {
    throw new InvalidArgumentError("parser must not be null");
  }

  // `Convert.FromBase64String` THROWS `FormatException` on malformed input, and that throw is the
  // only way a token reaches "unknown" before parsing. `Buffer.from(s, "base64")` never throws -
  // it silently skips characters outside the alphabet and accepts a truncated final group - so
  // the encoding must be validated explicitly or the unknown path is unreachable.
  const decoded = fromBase64String(token.token);
  if (decoded === undefined) return unknown();

  const payload = decoded.toString("utf8");

  const parts = payload.split("\n");
  if (parts.length !== 4 || parts[0] !== VERSION) return unknown();

  const datastoreId = parts[1] as string;
  const revisionString = parts[2] as string;
  const schemaHash = (parts[3] as string).length === 0 ? undefined : parts[3];

  // The C# `catch (Exception) when (IsParseException())` filter is a quirk: `IsParseException()`
  // always returns true, so this is a plain catch-all around the parser call.
  let revision: IRevision;
  try {
    revision = parser.parseRevisionString(revisionString);
  } catch {
    return unknown(schemaHash);
  }

  const status =
    datastoreId.length === 0
      ? "legacyEmptyDatastoreId"
      : datastoreId === parser.datastoreUniqueId
        ? "valid"
        : "mismatchedDatastoreId";

  return { revision, schemaHash, status };
}

/** `Convert.FromBase64String` semantics: whitespace-tolerant, otherwise strict; `undefined` where .NET throws. */
function fromBase64String(value: string): Buffer | undefined {
  const stripped = value.replace(IGNORED_WHITESPACE, "");
  if (!STANDARD_BASE64.test(stripped)) return undefined;
  return Buffer.from(stripped, "base64");
}

function unknown(schemaHash?: string | undefined): DecodedRevision {
  return { revision: new TimestampRevision(0n), schemaHash, status: "unknown" };
}
