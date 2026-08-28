import type { IRevision } from "@spacedb/core/i-revision";
import type { IRevisionParser } from "@spacedb/core/i-revision-parser";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";

/**
 * Decodes the timestamp revision string form (integer nanos) back into a `TimestampRevision`.
 * Used by both `ReferenceDatastore` and the grain-backed datastore, which mint the same string
 * form.
 *
 * It stays a CLASS rather than a bare function: it holds state (`datastoreUniqueId`) and is
 * handed across a boundary. The grain-backed datastore returns it FROM a grain method, so it is
 * a type with behaviour crossing the wire and will need a Thresh surrogate registered at that
 * point; the reference datastore's use is in-process, so none is registered here.
 *
 * `parseRevisionString` delegates straight to `TimestampRevision.parse` and does nothing else -
 * in particular it does not catch. Core's parse throws `SyntaxError` on a malformed string and
 * `RangeError` outside int64, and `decodeRevision` relies on catching exactly that to report
 * `ZedTokenStatus` "unknown"; swallowing or retyping the throw here makes that path unreachable.
 */
export class TimestampRevisionParser implements IRevisionParser {
  /** The owning datastore's `IDatastore.getUniqueId`. */
  readonly datastoreUniqueId: string;

  constructor(datastoreUniqueId: string) {
    this.datastoreUniqueId = datastoreUniqueId;
  }

  parseRevisionString(revisionString: string): IRevision {
    return TimestampRevision.parse(revisionString);
  }
}
