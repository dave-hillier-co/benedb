import type { IRevision } from "./i-revision";

/**
 * Parses a datastore-specific revision string back into an `IRevision`. Implemented by each
 * datastore so ZedTokens can be decoded; core carries no implementation.
 */
export interface IRevisionParser {
  /** A unique id for the datastore instance, embedded into minted tokens. */
  readonly datastoreUniqueId: string;

  /** Parses a revision string produced by `IRevision.toString`. */
  parseRevisionString(revisionString: string): IRevision;
}
