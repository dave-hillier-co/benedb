import { grain, persistentState } from "@thresh/core/decorators";
import { Grain } from "@thresh/core/grain";
import type { PersistentState } from "@thresh/core/persistent-state";

import type { GraphShardDirection, GraphShardKeyWire } from "./graph-shard-key";
import { joinGrainKey } from "./grain-key-codec";
import type { IShardIndexGrain } from "./i-graph-shard-grain";
import { fnv1a64 } from "./stable-hash";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/ShardIndexGrain.cs`.
 *
 * One bucket of the shard index (see `IShardIndexGrain`): a persisted set of object ids. The
 * sequencer adds the keys each projection touched; the set only grows, so a key whose rows were all
 * deleted stays listed and resolves to an empty shard.
 *
 * PORT NOTE: `[PersistentState("index", "datastore")]` constructor injection becomes the
 * `@persistentState` field decorator under the same state and provider names. The C#
 * `ImmutableSortedSet<string>` becomes a sorted `string[]`, so the state is plain data to the
 * storage codec.
 */
@grain()
export class ShardIndexGrain extends Grain implements IShardIndexGrain {
  @persistentState("index", {
    provider: "datastore",
    defaultValue: (): ShardIndexState => ({ ids: [] }),
  })
  private state!: PersistentState<ShardIndexState>;

  /** @inheritdoc */
  async add(ids: readonly string[]): Promise<void> {
    const current = this.state.value.ids;
    const next = new Set(current);
    for (const id of ids) next.add(id);
    if (next.size === current.length) return;
    // Restore the previous ids if the write fails, or a retry would see nothing new to persist.
    const previous = this.state.value;
    this.state.value = { ids: [...next].sort(compareOrdinal) };
    try {
      await this.state.write();
    } catch (error) {
      this.state.value = previous;
      throw error;
    }
  }

  /** @inheritdoc */
  readIds(): Promise<readonly string[]> {
    return Promise.resolve(this.state.value.ids);
  }
}

/** The persisted ids of one shard index bucket, sorted ordinally. */
export interface ShardIndexState {
  readonly ids: readonly string[];
}

/** Buckets per (direction, type): enumerating a type costs this many grain calls. */
export const SHARD_INDEX_BUCKET_COUNT = 16;

/** The bucket an object id hashes into. */
export function shardIndexBucketOf(objectId: string): number {
  return Number(fnv1a64(objectId) % BigInt(SHARD_INDEX_BUCKET_COUNT));
}

/** The index grain key for one bucket. */
export function shardIndexKeyBuild(
  direction: GraphShardDirection,
  objectType: string,
  bucket: number,
): string {
  return joinGrainKey(direction === "forward" ? "f" : "r", objectType, String(bucket));
}

/** The index grain key that lists `key`. */
export function shardIndexKeyFor(key: GraphShardKeyWire): string {
  return shardIndexKeyBuild(key.direction, key.objectType, shardIndexBucketOf(key.objectId));
}

/**
 * Every shard key of `direction` and `objectType` the index lists (a superset of the keys holding
 * rows: a key stays listed after its rows are deleted). `indexGrain` resolves an index grain key to
 * its reference - the C#'s `IGrainFactory`, which a Thresh grain reaches through `getGrain`.
 */
export async function shardIndexList(
  indexGrain: (key: string) => IShardIndexGrain,
  direction: GraphShardDirection,
  objectType: string,
): Promise<GraphShardKeyWire[]> {
  const buckets = await Promise.all(
    Array.from({ length: SHARD_INDEX_BUCKET_COUNT }, (_, bucket) =>
      indexGrain(shardIndexKeyBuild(direction, objectType, bucket)).readIds(),
    ),
  );
  return buckets.flatMap((ids) => ids.map((objectId) => ({ direction, objectType, objectId })));
}

function compareOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
