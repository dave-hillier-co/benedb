import { FormatError } from "@benedb/core/format-error";

import { joinGrainKey, splitGrainKey } from "./grain-key-codec";
import type { GraphShardDirection, GraphShardKeyWire } from "./graph-shard-key";

/**
 * The forward direction's wire segment: rows whose RESOURCE is the object.
 *
 * The literal `f`/`r` segments are mapped explicitly from the `GraphShardDirection` union, never
 * spelled from a union member name: the union members are `"forward"`/`"reverse"` and letting one
 * become the segment would rewrite a durable layout.
 */
const FORWARD_SEGMENT = "f";

/** The reverse direction's wire segment: rows whose SUBJECT is the object. */
const REVERSE_SEGMENT = "r";

/**
 * Encodes the `IGraphShardGrain` string key, which IS the shard's identity - one adjacency slice of
 * the graph: `direction/objectType/objectId`, where direction is `f` (forward: rows whose RESOURCE
 * is the object) or `r` (reverse: rows whose SUBJECT is the object).
 *
 * WIRE- AND DURABLE-VISIBLE. This string is the grain key, the string stored in
 * `DatastoreMetaState.forwardKeys`/`reverseKeys`, and the input to `keyIndexLayoutBucketOf`, so its
 * bytes are part of the durable layout and must be byte-exact, not merely round-trip-correct.
 *
 * Mirrors `grainKeyBuild`/`membershipWalkKeyBuild`'s escaping/parsing conventions via the shared
 * grain-key codec: components are URL-style escaped so a literal separator in any field cannot
 * corrupt the key. UNLIKE those keys this one carries NO revision or schema-hash segment: the shard
 * holds the key's whole MVCC history within the GC window and serves any covered revision, so the
 * revision is a call argument (`rowsAt`), not part of the identity - one activation per slice, not
 * one per (slice, revision).
 */
export function graphShardGrainKeyBuild(key: GraphShardKeyWire): string {
  return joinGrainKey(
    key.direction === "forward" ? FORWARD_SEGMENT : REVERSE_SEGMENT,
    key.objectType,
    key.objectId,
  );
}

/**
 * Decodes an `IGraphShardGrain` string key. Throws `FormatError` on the wrong segment count (from
 * the shared codec, BEFORE the direction is examined) and on an unrecognised direction segment,
 * with the key interpolated into the message.
 */
export function graphShardGrainKeyParse(key: string): GraphShardKeyWire {
  // Sound because `splitGrainKey` has already thrown unless there are exactly three segments; the
  // assertion exists only because `noUncheckedIndexedAccess` widens every index of a `string[]`.
  const [directionSegment, objectType, objectId] = splitGrainKey(key, 3) as [
    string,
    string,
    string,
  ];

  let direction: GraphShardDirection;
  switch (directionSegment) {
    case FORWARD_SEGMENT:
      direction = "forward";
      break;
    case REVERSE_SEGMENT:
      direction = "reverse";
      break;
    default:
      throw new FormatError(
        `Malformed graph-shard key (unknown direction '${directionSegment}'): '${key}'.`,
      );
  }

  return { direction, objectType, objectId };
}
