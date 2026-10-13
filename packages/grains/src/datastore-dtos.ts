import type { RelationshipWire } from "./relationships-dtos";

// A deliberately MULTI-EXPORT module, per the port ledger, ported together with `log-event.ts` (a
// `LogEvent` carries a `SchemaVersionWire` and `FullRelationshipsFilterWire`s).
//
// The width decisions this file makes, and the easiest silent bug in the whole layer: every MVCC
// REVISION is a `bigint` (`createdRevision`, `deletedRevision`, `SchemaVersionWire.revision`,
// `CounterVersionWire.revision`, `DatastoreHeadWire.head`/`gcFloor`), matching
// `packages/datastore/src/datastore-state.ts`.

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
