import { FormatError } from "@spacedb/core/format-error";
import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";

import { fromBase64String, toBase64String } from "./convert-base64";
import { parseRevision } from "./revision-codec";

/**
 * Opaque continuation cursor for bulk export. It pins the snapshot by carrying BOTH the export's
 * revision and the last tuple emitted, so a resumed export reads the exact same revision (never
 * seeing writes committed after it began) and continues strictly after the last tuple.
 *
 * Wire form is base64 of a newline-delimited record `v1\n{revisionString}\n{afterTuple}`, mirroring
 * the `ZedTokens` encoding style and SpiceDB's bulk-export cursor (revision + last tuple). The
 * revision string is the `TimestampRevision` integer form (nanos, a decimal `bigint` string end to
 * end - never a `number`) parsed back by `parseRevision`.
 *
 * WIRE-VISIBLE: `zed` round-trips this token across requests, so the encoded BYTES are the
 * contract. Standard base64 - `+`, `/` and `=` padding - via `Convert.ToBase64String`; NOT URL-safe.
 */

const VERSION = "v1";

/** Every failure path carries this literal message, as the C# does. */
const INVALID = "invalid bulk export cursor";

/** The decoded parts of a bulk-export cursor. A C# `readonly record struct`. */
export interface BulkExportCursorDecoded {
  /** The revision the export is pinned at. */
  readonly revision: IRevision;
  /** The last tuple emitted; resumption continues strictly after it. */
  readonly afterTuple: string;
}

/** Encodes the pinned revision and the last emitted tuple into an opaque cursor. */
export function encodeBulkExportCursor(revision: IRevision, afterTuple: string): string {
  // `ArgumentNullException.ThrowIfNull` on both. Kept even though the parameters are typed
  // non-optional: callers reach here from wire data.
  if (revision === undefined || revision === null)
    throw new InvalidArgumentError("revision must not be null.");
  if (afterTuple === undefined || afterTuple === null)
    throw new InvalidArgumentError("afterTuple must not be null.");

  return toBase64String([VERSION, revision.toString(), afterTuple].join("\n"));
}

/**
 * Decodes a cursor. Returns ABSENT for an absent/empty cursor (a first page) and THROWS
 * `FormatError` for a malformed non-empty one - the two must not be merged.
 *
 * The C# is `bool TryDecode(string?, out Decoded)`; TypeScript has no `out` parameter, so the port
 * returns the decoded value or `undefined`. The false-vs-throw distinction, which is the point of
 * the method, is preserved exactly.
 */
export function tryDecodeBulkExportCursor(
  cursor: string | undefined,
): BulkExportCursorDecoded | undefined {
  // `string.IsNullOrEmpty` - an empty cursor is a first page, NOT a malformed one.
  if (cursor === undefined || cursor === "") return undefined;

  let payload: string;
  try {
    payload = fromBase64String(cursor);
  } catch (error) {
    if (error instanceof FormatError) throw new FormatError(INVALID);
    throw error;
  }

  // EXACTLY three parts: a tuple containing a newline yields more and is rejected, as in C#.
  const parts = payload.split("\n");
  if (parts.length !== 3 || parts[0] !== VERSION) throw new FormatError(INVALID);

  let revision: IRevision;
  try {
    revision = parseRevision(parts[1] as string);
  } catch (error) {
    // The C# filter is `FormatException or OverflowException or ArgumentException`. The ported
    // parse (`TimestampRevision.parse`) signals a bad SHAPE with `SyntaxError` and an out-of-int64
    // value with `RangeError`, which are this port's spellings of the first two; `parseRevision`'s
    // null guard is the third. Nothing else is swallowed.
    if (
      error instanceof SyntaxError ||
      error instanceof RangeError ||
      error instanceof InvalidArgumentError ||
      error instanceof FormatError
    )
      throw new FormatError(INVALID);
    throw error;
  }

  return { revision, afterTuple: parts[2] as string };
}
