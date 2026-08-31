import type { IRevision } from "@benedb/core/i-revision";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";

/**
 * What a `Watch` stream should carry.
 *
 * The C# is a `[Flags]` enum and call sites do real bit tests
 * (`(options.Content & WatchContent.Checkpoints) != 0`), so this is the one enum in this layer
 * that stays NUMERIC: a frozen const object plus a numeric type alias, never a string union.
 *
 * - `relationships` (1): relationship create/touch/delete updates committed at the revision.
 * - `schema` (2): a signal that the schema changed at the revision (no detailed diff).
 * - `checkpoints` (4): emit checkpoint markers carrying only a revision (no content). Mirrors
 *   SpiceDB's `WatchCheckpoints`: a consumer watching a subset of content still sees revision
 *   progress even when nothing matching its filter changed.
 * - `all` (3): relationship updates and schema-change signals. Note it deliberately EXCLUDES
 *   `checkpoints`; a naive "every bit" port would start emitting checkpoints to callers that
 *   never asked for them.
 */
export const WatchContent = Object.freeze({
  relationships: 1,
  schema: 2,
  checkpoints: 4,
  all: 1 | 2,
});

/** A bit mask of `WatchContent` flags. */
export type WatchContent = number;

/**
 * Options controlling a `Watch` stream.
 *
 * The C# `WatchContent Content = WatchContent.Relationships` default argument becomes an absent
 * member plus the `watchOptionsContent` resolver, so a bit test never runs against `undefined`.
 */
export interface WatchOptions {
  /** Which kinds of change to emit; absent means relationships only. */
  readonly content?: WatchContent | undefined;
}

/**
 * The content mask for the given options, applying the C# default of relationships only.
 *
 * `??`, not `||`: an explicit mask of 0 is a legitimate "emit nothing" and must survive.
 */
export function watchOptionsContent(options: WatchOptions | undefined): WatchContent {
  return options?.content ?? WatchContent.relationships;
}

/**
 * The set of changes committed at a single revision. Emitted in strictly increasing revision
 * order. Mirrors SpiceDB's `datastore.RevisionChanges`: a revision plus the relationship updates
 * (and an optional schema-changed flag) that became visible at it.
 */
export interface RevisionChange {
  /** The revision at which these changes committed. */
  readonly revision: IRevision;
  /**
   * Relationship mutations committed at `revision`. A create/touch surfaces as a `touch` update
   * carrying the new payload; a delete surfaces as a `delete` update carrying the removed
   * relationship. A checkpoint carries an EMPTY array, never an absent one - empty and absent
   * stay distinct.
   */
  readonly relationshipChanges: readonly RelationshipUpdate[];
  /** True if the unified schema was (re)written at this revision. Absent means false. */
  readonly schemaChanged?: boolean | undefined;
  /**
   * True if this is a checkpoint marker (no content): it signals that the changefeed has
   * progressed through `revision` so a consumer filtering to a subset of content still observes
   * revision progress. Mirrors SpiceDB's `RevisionChanges.IsCheckpoint`. Absent means false.
   */
  readonly isCheckpoint?: boolean | undefined;
}
