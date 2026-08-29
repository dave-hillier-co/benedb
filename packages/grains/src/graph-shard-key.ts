import type { RelationshipWire } from "./relationships-dtos";

/** Which adjacency slice of the graph a shard key names. */
export type GraphShardDirection =
  /** The forward slice: all rows whose RESOURCE is the shard's object. */
  | "forward"
  /** The reverse slice: all rows whose SUBJECT is the shard's object. */
  | "reverse";

/**
 * A shard key names one adjacency slice of the graph: the forward slice (all rows whose RESOURCE
 * is this object) or the reverse slice (all rows whose SUBJECT is this object). Every relationship
 * row belongs to exactly one forward and one reverse slice, so the per-key restriction of the log
 * fold partitions the whole state (the sharding lemma pinned by the shard-fold lemma test).
 */
export interface GraphShardKeyWire {
  /** Which slice this key names. */
  readonly direction: GraphShardDirection;
  /** The object's namespace. */
  readonly objectType: string;
  /** The object's id. */
  readonly objectId: string;
}

/**
 * The canonical key string for use as a `Map`/`Set` key.
 *
 * C# record equality answers `Dictionary`/`HashSet` lookups structurally; a JS `Map`/`Set` keys by
 * REFERENCE, so every such use keys on this string instead. It is UNCONDITIONALLY injective, as
 * the record equality it replaces is: the fields are LENGTH-PREFIXED rather than joined on a
 * separator "the grammar excludes", because object ids can and do contain slashes and colons -
 * which is exactly why `GrainKeyCodec` escapes them.
 *
 * This is an IN-PROCESS key, deliberately spelled differently from the durable
 * `GraphShardGrainKey` form (which encodes the direction as `f`/`r`): the two representations are
 * kept distinct and mapped explicitly, so a union member name can never become a wire segment by
 * accident.
 */
export function graphShardKeyString(key: GraphShardKeyWire): string {
  return `${key.direction}|${key.objectType.length}:${key.objectType}|${key.objectId.length}:${key.objectId}`;
}

/**
 * True if the relationship belongs to this shard's slice.
 *
 * The C#'s comparisons are `StringComparison.Ordinal`, which plain `===` already is.
 */
export function graphShardKeyMatches(key: GraphShardKeyWire, rel: RelationshipWire): boolean {
  return key.direction === "forward"
    ? rel.resourceType === key.objectType && rel.resourceId === key.objectId
    : rel.subjectType === key.objectType && rel.subjectId === key.objectId;
}

/** The forward shard key for the object: all rows with this resource. */
export function graphShardKeyForResource(type: string, id: string): GraphShardKeyWire {
  return { direction: "forward", objectType: type, objectId: id };
}

/** The reverse shard key for the object: all rows with this subject. */
export function graphShardKeyForSubject(type: string, id: string): GraphShardKeyWire {
  return { direction: "reverse", objectType: type, objectId: id };
}
