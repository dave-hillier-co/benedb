import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";

/**
 * Parses the revision string carried in a grain key back into an `IRevision` so the grain can
 * resolve a snapshot reader at that revision.
 *
 * This slice's datastore is timestamp-based (`TimestampRevision`), whose string form is the
 * integer nanosecond count. When richer revision schemes appear, this is the single place that
 * dispatches on the string form to reconstruct the right revision type.
 *
 * The `ArgumentNullException.ThrowIfNull` guard is kept even though the parameter is typed
 * non-optional: callers reach here from wire data, and `BulkExportCursor` decodes a
 * client-supplied cursor by handing its revision segment here and catching the throw.
 */
export function parseRevision(revision: string): IRevision {
  if (revision === undefined || revision === null) {
    throw new InvalidArgumentError("revision must not be null.");
  }

  return TimestampRevision.parse(revision);
}
