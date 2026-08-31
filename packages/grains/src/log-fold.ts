import { collectBelow, type CounterVersion } from "@benedb/datastore/datastore-state";
import { MvccReadWriteTransaction } from "@benedb/datastore/mvcc-read-write-transaction";

import type { ProposedWrite, SchemaVersionWire } from "./datastore-dtos";
import type { DatastoreGrainState } from "./datastore-grain-state";
import { toGrainState, toMemoryState } from "./datastore-state-converters";
import type { LogEvent } from "./log-event";
import { computeStoredSchemaHash } from "./stored-schema-hash";
import { toCoreFilter, toUpdate } from "./wire-convert";

/**
 * The event-log fold and its inverse (the proposal diff). This is the single definition of "apply a
 * committed {@link LogEvent} to the datastore state", used by the event-sourced datastore grain's
 * `transition` (replay + live append) and by the storage replay on reactivation. It is deliberately
 * implemented by REUSING the in-memory MVCC `MvccReadWriteTransaction` (the same mechanics the
 * write path runs through), so the fold is provably equal to the in-memory `commit()` rather than a
 * divergent re-derivation of the MVCC visibility rules.
 *
 * SYNCHRONOUS, and that is load-bearing. The C# calls `.GetAwaiter().GetResult()` because the
 * in-memory transaction stages immediately; in the port `writeRelationships` and
 * `writeStoredSchema` are NON-async methods that do their work synchronously and hand back
 * `Promise.resolve()`, and `commit()` is already synchronous. So the settled promises are simply
 * discarded and this stays a synchronous function - which it must be, because a journaled grain's
 * `transition` cannot await. A `CreateRelationshipExistsException` still propagates synchronously
 * out of the staging call, so no rejection escapes unobserved.
 */
export function logFoldApplyEvent(state: DatastoreGrainState, ev: LogEvent): DatastoreGrainState {
  // `ev.GcFloor is { } floor`. NEVER a truthiness test: 0n is a legal floor (the floor of a store
  // that has collected nothing), and `if (ev.gcFloor)` would turn a GC-to-zero event into an
  // ordinary one that replays no changes at all.
  if (ev.gcFloor !== undefined) {
    // A GC event carries no relationship/schema/counter changes: collect below the floor, then
    // advance the head to the event's own revision exactly like any other event (`collectBelow`
    // itself never touches `headRevision`).
    const collected = collectBelow(toMemoryState(state), ev.gcFloor);
    return { ...toGrainState(collected), headRevision: ev.revision };
  }

  const baseState = toMemoryState(state);

  // Replay the resolved changes through a fresh in-memory transaction pinned at the event revision,
  // then commit - exactly the path the write produced this event from, so the fold equals that
  // commit.
  const tx = new MvccReadWriteTransaction(baseState, ev.revision);

  if (ev.relationshipChanges.length > 0) {
    const updates = ev.relationshipChanges.map(toUpdate);
    // Settled synchronously; the promise is discarded (see the class remark above).
    void tx.writeRelationships(updates);
  }

  if (ev.schemaChange !== undefined) void tx.writeStoredSchema(ev.schemaChange.bytes);

  const committed = tx.commit();

  // Counters are folded by appending the event's NET counter versions DIRECTLY, matching what
  // `commit()` appends (a raw `CounterVersion` for whatever net op survived) - NOT by replaying
  // through the guarded `writeCounter`/`deleteCounter`, whose register/unregister preconditions can
  // be false in the fold base for a same-commit register+unregister (or the inverse), which would
  // throw and poison replay even though the original commit succeeded.
  let counters: readonly CounterVersion[] = committed.counters;
  for (const counter of ev.counterChanges) {
    const filter = counter.filter === undefined ? undefined : toCoreFilter(counter.filter);
    counters = [...counters, { revision: ev.revision, name: counter.name, filter }];
  }

  return toGrainState({ ...committed, counters });
}

/**
 * Builds the canonical {@link LogEvent} from a `ProposedWrite` by stamping the grain-minted
 * `revision`: the proposal already carries the resolved relationship Touch/Delete changes and the
 * counter deltas, so the only derivation is the schema version (revision + bytes + hash) for the
 * optional schema bytes. This is the single point that turns a revision-less proposal into a
 * self-contained, foldable event.
 */
export function eventFromProposal(write: ProposedWrite, revision: bigint): LogEvent {
  const schemaChange: SchemaVersionWire | undefined =
    write.schemaBytes === undefined
      ? undefined
      : {
          revision,
          bytes: write.schemaBytes,
          hash: computeStoredSchemaHash(write.schemaBytes),
        };
  return {
    revision,
    relationshipChanges: write.relationshipChanges,
    schemaChange,
    counterChanges: write.counterChanges,
    gcFloor: undefined,
  };
}
