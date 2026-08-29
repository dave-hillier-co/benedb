import type { CounterDeltaWire } from "./log-event";
import type { RelationshipUpdateWire, RelationshipWire } from "./relationships-dtos";

// A deliberately MULTI-EXPORT module, per the port ledger. It is MUTUALLY RECURSIVE with
// `log-event.ts` (a `ProposedWrite` carries `CounterDeltaWire`s; a `LogEvent` carries a
// `SchemaVersionWire` and `FullRelationshipsFilterWire`s) - type-only circular imports are fine in
// TypeScript, and the two files are ported together.
//
// The width decisions this file makes, and the easiest silent bug in the whole layer: every MVCC
// REVISION is a `bigint` (`createdRevision`, `deletedRevision`, `SchemaVersionWire.revision`,
// `CounterVersionWire.revision`, `DatastoreHeadWire.head`/`gcFloor`), matching
// `packages/datastore/src/datastore-state.ts`; every STORAGE VERSION (`LogHeadEntry.logVersion`,
// `snapshotVersion`) is an `int` and stays a `number`. They sit side by side in one record and
// mean entirely different things.

/**
 * A relationship row on the wire, carrying its MVCC visibility window. Mirrors the in-memory
 * `StoredRelationship` (payload + created/deleted revision stamps) so the whole datastore state
 * round-trips across the grain boundary.
 */
export interface StoredRelationshipWire {
  /** The relationship payload. */
  readonly relationship: RelationshipWire;
  /** The revision at which the row became live. */
  readonly createdRevision: bigint;
  /** The revision at which the row was deleted, or ABSENT if still live (never 0n: 0 is legal). */
  readonly deletedRevision?: bigint | undefined;
}

/**
 * A schema-bytes version stamped with the revision at which it was written.
 *
 * `byte[]` becomes `Uint8Array`, which compares BY REFERENCE - the same broken equality the C#
 * record has - so any equality helper must compare content explicitly (the round-trip test works
 * around it with `SequenceEqual`; the port compares element-wise for the same reason). `hash` is
 * what the port compares when it means "same schema".
 */
export interface SchemaVersionWire {
  /** The revision at which this version was written. */
  readonly revision: bigint;
  /** The serialized schema bytes. */
  readonly bytes: Uint8Array;
  /** The hash of the schema bytes. */
  readonly hash: string;
}

/**
 * An MVCC version of a registered counter, stamped with the revision at which it was written. An
 * ABSENT `filter` marks a tombstone (the counter was unregistered at this revision).
 */
export interface CounterVersionWire {
  /** The revision at which this version was written. */
  readonly revision: bigint;
  /** The counter's name. */
  readonly name: string;
  /** The registered filter, or absent for a tombstone. */
  readonly filter?: FullRelationshipsFilterWire | undefined;
}

/**
 * The full relationships filter on the wire (lossless mirror of the core `RelationshipsFilter`),
 * used for counters: the counter's registered filter must round-trip exactly through the grain.
 */
export interface FullRelationshipsFilterWire {
  /** The resource namespace constraint. */
  readonly optionalResourceType?: string | undefined;
  /** The explicit resource id constraint. */
  readonly optionalResourceIds?: readonly string[] | undefined;
  /** The resource id prefix constraint. */
  readonly optionalResourceIdPrefix?: string | undefined;
  /** The resource relation constraint. */
  readonly optionalResourceRelation?: string | undefined;
  /** The subject selectors, or ABSENT for no subject constraint (distinct from an empty list). */
  readonly optionalSubjectsSelectors?: readonly SubjectsSelectorWire[] | undefined;
  /** The caveat presence/name constraint. */
  readonly optionalCaveatNameFilter?: CaveatNameFilterWire | undefined;
  /**
   * An `int` MIRROR of the core expiration-filter enum. It stays a NUMBER here: `WireConvert` owns
   * the mapping, and narrowing it into a union at this layer would strand that mapping's tolerant
   * default arms - which is how an unknown value from a newer peer degrades rather than throwing.
   */
  readonly optionalExpirationOption: number;
}

/** One subject selector within a `FullRelationshipsFilterWire`. */
export interface SubjectsSelectorWire {
  /** The subject namespace constraint. */
  readonly optionalSubjectType?: string | undefined;
  /** The explicit subject id constraint. */
  readonly optionalSubjectIds?: readonly string[] | undefined;
  /** The subject-relation constraint. */
  readonly relationFilter?: SubjectRelationFilterWire | undefined;
}

/** A subject-relation constraint within a `SubjectsSelectorWire`. */
export interface SubjectRelationFilterWire {
  /** The non-ellipsis relation to match, or absent. */
  readonly nonEllipsisRelation?: string | undefined;
  /** Whether the ellipsis relation is included. */
  readonly includeEllipsisRelation: boolean;
  /** Whether only non-ellipsis relations match. */
  readonly onlyNonEllipsisRelations: boolean;
}

/** A caveat-presence/name constraint within a `FullRelationshipsFilterWire`. */
export interface CaveatNameFilterWire {
  /** An `int` mirror of the core caveat-filter enum; a NUMBER here, for the reason above. */
  readonly option: number;
  /** The caveat name to match, or absent. */
  readonly caveatName?: string | undefined;
}

/**
 * A lightweight head probe: head revision, the schema hash effective at that head, and the current
 * GC floor (the revision below which MVCC history has been collected - reads/cursors below it are
 * invalid).
 */
export interface DatastoreHeadWire {
  /** The head (freshest committed) revision. */
  readonly head: bigint;
  /** The schema hash effective at head, or absent in the pre-first-schema seed window. */
  readonly schemaHash?: string | undefined;
  /** The GC floor. A C# DEFAULT PARAMETER (`long GcFloor = 0`), so optional plus a resolver. */
  readonly gcFloor?: bigint | undefined;
}

/** Resolver for the C# default parameter `long GcFloor = 0`. */
export function datastoreHeadWireGcFloor(head: DatastoreHeadWire): bigint {
  return head.gcFloor ?? 0n;
}

/**
 * A revision-less net commit diff: the resolved relationship changes (Touch / Delete on full
 * payloads), an optional new schema (bytes), and the counter deltas (an ABSENT
 * `CounterDeltaWire.filter` being a tombstone). Once the wire shape of the retired two-step
 * propose/append write path, it survives as the input of the log-fold helper that stamps a minted
 * revision onto a canonical `LogEvent` (`logFoldEventFromProposal`) - the same net diff a
 * `CommitRequest` carries field-by-field. It therefore carries no revision of its own.
 */
export interface ProposedWrite {
  /** The relationship changes, in request order. */
  readonly relationshipChanges: readonly RelationshipUpdateWire[];
  /** The new schema source bytes, or absent for no schema change. */
  readonly schemaBytes?: Uint8Array | undefined;
  /** The counter deltas. */
  readonly counterChanges: readonly CounterDeltaWire[];
}

/**
 * The durable "head" pointer entry for the event-sourced datastore grain (a single grain-storage
 * row). It records the two distinct counters: the contiguous append-only log `logVersion` (the
 * custom-storage optimistic-concurrency version, = the number of confirmed events), and the latest
 * timestamp `headRevision` (the MVCC / zedtoken revision carried in the events).
 * `snapshotVersion` names the current flush boundary: under the thin-sequencer layout it is the
 * version of the current `meta/{version}` row (see `DatastoreMetaEntry`), so a cold read loads the
 * small state plus per-key shard rows and replays only the log tail above it. On a store written
 * by the retired whole-state layout the same field named the `snapshot/{version}` row; activation
 * migrates such a store in place (split into per-key rows + meta) on first read.
 */
export interface LogHeadEntry {
  /** The log version: an `int` STORAGE version, not a revision. */
  readonly logVersion: number;
  /** The head MVCC revision carried in the events. */
  readonly headRevision: bigint;
  /** The current flush boundary: an `int` STORAGE version, not a revision. */
  readonly snapshotVersion: number;
}
