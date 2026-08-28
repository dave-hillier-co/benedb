import type { IRevision } from "./i-revision";
import type { ZedTokenStatus } from "./zed-token-status";

/** The decoded contents of a `ZedToken`. */
export interface DecodedRevision {
  /**
   * The revision carried by the token. On a decode failure this is a `TimestampRevision(0)`
   * SENTINEL, not an absent value, so callers must branch on `status` and never on the revision.
   */
  readonly revision: IRevision;
  /** Optional schema hash captured when the token was minted. */
  readonly schemaHash?: string | undefined;
  /** The validation status relative to the current datastore. */
  readonly status: ZedTokenStatus;
}
