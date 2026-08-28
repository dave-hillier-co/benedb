import type { IRevision } from "@spacedb/core/i-revision";
import { createRelationship } from "@spacedb/core/relationship";
import type { RelationshipUpdate } from "@spacedb/core/relationship-update";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { describe, expect, it } from "vitest";

import { WatchContent, watchOptionsContent, type RevisionChange, type WatchOptions } from "./watch";

// Port of Spiceport `Watch.cs`.
//
// Covered in Spiceport by the four Watch_ tests in ReferenceDatastoreTests
// (Watch_emits_change_committed_after_cursor, Watch_from_old_cursor_replays_committed_write,
// Watch_emits_checkpoint_after_change_when_requested,
// Watch_does_not_emit_checkpoint_when_not_requested). Those drive the MVCC datastore this port
// has not reached; what they assert ABOUT THESE TYPES - the content flags they pass, and the
// shape of the RevisionChange and checkpoint they read back - is carried across below.
//
// Port decisions pinned here:
//
// 1. `WatchContent` is a `[Flags]` enum and call sites do REAL BIT TESTS
//    (`(options.Content & WatchContent.Checkpoints) != 0`), so it is the one enum in this batch
//    that stays NUMERIC: a frozen const object of 1/2/4 plus a numeric type alias, never a
//    string union.
//
// 2. `All = Relationships | Schema` is 3 and deliberately EXCLUDES Checkpoints (4). A naive
//    "all the bits" port would make Watch_emits_change_committed_after_cursor - which passes
//    WatchContent.All and expects exactly one non-checkpoint change - see a checkpoint too.
//
// 3. `WatchOptions` defaults Content to Relationships ONLY. As with ReverseQueryOptions, the
//    C# default argument becomes an absent member plus a resolver, so a bit test never runs
//    against `undefined`.
//
// 4. `RevisionChange.RelationshipChanges` is an `IReadOnlyList<RelationshipUpdate>` - a readonly
//    array - and a CHECKPOINT carries an EMPTY array, not an absent one. Empty and absent stay
//    distinct.
const rel = createRelationship(
  { objectType: "document", objectId: "doc1", relation: "viewer" },
  { objectType: "user", objectId: "alice", relation: "..." },
);

describe("watch content", () => {
  it("has the flag values the bit tests depend on", () => {
    expect(WatchContent.relationships).toBe(1);
    expect(WatchContent.schema).toBe(2);
    expect(WatchContent.checkpoints).toBe(4);
  });

  it("combines with bitwise or", () => {
    const content: WatchContent = WatchContent.relationships | WatchContent.checkpoints;

    expect(content).toBe(5);
    expect((content & WatchContent.relationships) !== 0).toBe(true);
    expect((content & WatchContent.checkpoints) !== 0).toBe(true);
    expect((content & WatchContent.schema) !== 0).toBe(false);
  });

  it("defines All as relationships plus schema, EXCLUDING checkpoints", () => {
    expect(WatchContent.all).toBe(3);
    expect(WatchContent.all).toBe(WatchContent.relationships | WatchContent.schema);
    expect((WatchContent.all & WatchContent.checkpoints) !== 0).toBe(false);
  });

  it("is frozen, so a call site cannot renumber a flag", () => {
    expect(Object.isFrozen(WatchContent)).toBe(true);
  });
});

describe("watch options", () => {
  it("defaults to relationships only", () => {
    // `new WatchOptions()` in Watch_from_old_cursor_replays_committed_write.
    expect(watchOptionsContent({})).toBe(WatchContent.relationships);
    expect(watchOptionsContent(undefined)).toBe(WatchContent.relationships);
  });

  it("honours an explicit content mask", () => {
    const options: WatchOptions = {
      content: WatchContent.relationships | WatchContent.checkpoints,
    };

    expect(watchOptionsContent(options)).toBe(5);
  });

  it("resolves the default before any bit test, so checkpoints stay off by default", () => {
    // Watch_does_not_emit_checkpoint_when_not_requested: with Relationships only, the
    // checkpoint bit must read false rather than tripping over an absent member.
    expect((watchOptionsContent({}) & WatchContent.checkpoints) !== 0).toBe(false);
    expect(
      (watchOptionsContent({ content: WatchContent.relationships }) & WatchContent.checkpoints) !==
        0,
    ).toBe(false);
  });

  it("treats an explicit empty mask as emitting nothing, not as the default", () => {
    // 0 is a legitimate mask; `?? ` must not swallow it the way `||` would.
    expect(watchOptionsContent({ content: 0 })).toBe(0);
  });
});

describe("revision change", () => {
  const revision: IRevision = new TimestampRevision(1700000000000000000n);

  it("carries the revision and the updates committed at it", () => {
    // Watch_emits_change_committed_after_cursor: a CREATE surfaces as a Touch carrying the new
    // payload.
    const update: RelationshipUpdate = { relationship: rel, operation: "touch" };
    const change: RevisionChange = { revision, relationshipChanges: [update] };

    expect(change.revision).toBe(revision);
    expect(change.relationshipChanges).toEqual([update]);
  });

  it("defaults schemaChanged and isCheckpoint to false when absent", () => {
    const change: RevisionChange = { revision, relationshipChanges: [] };

    expect(change.schemaChanged ?? false).toBe(false);
    expect(change.isCheckpoint ?? false).toBe(false);
  });

  it("signals a schema rewrite with no relationship changes", () => {
    const change: RevisionChange = {
      revision,
      relationshipChanges: [],
      schemaChanged: true,
    };

    expect(change.schemaChanged).toBe(true);
    expect(change.relationshipChanges).toEqual([]);
  });

  it("carries an EMPTY change list for a checkpoint, not an absent one", () => {
    // Watch_emits_checkpoint_after_change_when_requested asserts Assert.Empty on the
    // checkpoint's RelationshipChanges - empty, never undefined.
    const checkpoint: RevisionChange = {
      revision,
      relationshipChanges: [],
      isCheckpoint: true,
    };

    expect(checkpoint.isCheckpoint).toBe(true);
    expect(checkpoint.relationshipChanges).toEqual([]);
    expect(checkpoint.relationshipChanges).not.toBeUndefined();
  });

  it("lets a checkpoint name the same revision as the change it followed", () => {
    // The checkpoint names the latest revision the changefeed advanced through, so the two
    // revisions are equal - the checkpoint is not a later revision.
    const change: RevisionChange = {
      revision,
      relationshipChanges: [{ relationship: rel, operation: "touch" }],
    };
    const checkpoint: RevisionChange = {
      revision: change.revision,
      relationshipChanges: [],
      isCheckpoint: true,
    };

    expect(checkpoint.revision.equals(change.revision)).toBe(true);
  });
});
