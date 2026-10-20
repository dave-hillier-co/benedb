import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

import {
  datastoreMetaStateEmpty,
  type DatastoreJournalEntry,
  type DatastoreMetaState,
} from "./datastore-meta-state";
import type { LogEvent } from "./log-event";
import type { RelationshipUpdateWire } from "./relationships-dtos";

// Port of `tests/Spiceport.Grains.Tests/LogEventMetadataWireTests.cs`.
//
// The transaction metadata a `LogEvent` carries is journaled with the sequencer's state, so it must
// survive the codec inside the journaled pending tail, and an event journaled before the field existed
// must still read back (with no metadata). Pure codec tests: no cluster, no host.
//
// PORT NOTES.
//  - `Serializer.SerializeToArray` / `Deserialize` become Thresh's `serializeValue` /
//    `deserializeValue`, the path the journal and grain storage persist through.
//  - The C# declares a `[GenerateSerializer] PreMetadataLogEvent` record with the old field ids to
//    stand for an event journaled before the field; the codec here carries plain objects by property
//    name, so the old shape is simply a `LogEvent` value without the property.
describe("LogEventMetadataWireTests", () => {
  const touch: RelationshipUpdateWire = {
    operation: "touch",
    relationship: {
      resourceType: "doc",
      resourceId: "a",
      resourceRelation: "viewer",
      subjectType: "user",
      subjectId: "alice",
      subjectRelation: "...",
    },
  };

  it("The_journaled_pending_tail_round_trips_each_events_metadata", () => {
    const state: DatastoreMetaState = {
      ...datastoreMetaStateEmpty(1n),
      headRevision: 3n,
      pending: [
        {
          revision: 2n,
          relationshipChanges: [touch],
          counterChanges: [],
          transactionMetadata: new Uint8Array([10, 20, 30]),
        },
        { revision: 3n, relationshipChanges: [touch], counterChanges: [] },
      ],
    };

    const back = deserializeValue<DatastoreMetaState>(serializeValue(state));

    expect(back.pending[0]!.transactionMetadata).toEqual(new Uint8Array([10, 20, 30]));
    expect(back.pending[1]!.transactionMetadata).toBeUndefined();

    const entry = deserializeValue<DatastoreJournalEntry>(
      serializeValue({
        kind: "committed",
        event: state.pending[0]!,
      } satisfies DatastoreJournalEntry),
    );
    expect(entry.kind).toBe("committed");
    expect((entry as { readonly event: LogEvent }).event.transactionMetadata).toEqual(
      new Uint8Array([10, 20, 30]),
    );
  });

  it("An_event_journaled_before_the_metadata_field_reads_back_with_none", () => {
    const old = { revision: 7n, relationshipChanges: [touch], counterChanges: [] };

    const back = deserializeValue<LogEvent>(serializeValue(old));

    expect(back.revision).toBe(7n);
    expect(back.relationshipChanges).toEqual([touch]);
    expect(back.transactionMetadata).toBeUndefined();
  });
});
