import type { IRevision } from "./i-revision";
import type { RevisionMode } from "./revision-mode";

/** The outcome of resolving a `ConsistencyRequirement` against a datastore. */
export interface ResolvedRevision {
  /** The revision that will actually be evaluated. */
  readonly revision: IRevision;
  /** The schema hash at that revision, if any. */
  readonly schemaHash?: string | undefined;
  /** Why `revision` was chosen; see `RevisionMode` for why it must not reach a key. */
  readonly mode: RevisionMode;
}
