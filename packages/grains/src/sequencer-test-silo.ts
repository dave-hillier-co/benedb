import type { GrainStorage } from "@thresh/core/grain-storage";
import type { JournalStorage } from "@thresh/core/journal-storage";
import type { GrainRegistrationSpec } from "@thresh/core/grain-registration-spec";
import type { SiloBuilder } from "@thresh/hosting/silo-builder";
import { MemoryJournalStorage } from "@thresh/journaling/memory-journal-storage";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";

import { DatastoreGrain } from "./datastore-grain";
import { GraphShardGrain } from "./graph-shard-grain";
import { IDatastoreGrain } from "./i-datastore-grain";
import { IGraphShardGrain, IShardIndexGrain } from "./i-graph-shard-grain";
import { ShardIndexGrain } from "./shard-index-grain";
import { addGraphLocalityPlacement } from "./silo-builder-extensions";

/**
 * NO SPICEPORT SOURCE: test support for the suites that host the datastore grain WITHOUT the whole
 * grain-services mesh (the C# configures those silos inline, adding `AddGraphLocalityPlacement`
 * beside the log-consistency provider).
 *
 * The sequencer reads and projects through the shard and index grains, so a silo hosting it must
 * host them too, with the shard grain's placement strategy registered. And where the C# hands a
 * second cluster the SAME grain-storage provider to prove recovery, a Thresh suite must hand it the
 * same JOURNAL as well: the datastore grain is journaled, and `TestCluster` binds a fresh journal
 * per cluster.
 */
export interface SequencerStores {
  /** The `datastore` grain-storage provider the shard and index grains persist through. */
  readonly storage: GrainStorage;
  /** The journal the datastore grain is journaled in. */
  readonly journal: JournalStorage;
}

/** Fresh in-memory stores, to share across every cluster that must see the same datastore. */
export function createSequencerStores(): SequencerStores {
  return { storage: new MemoryGrainStorage(), journal: new MemoryJournalStorage() };
}

/** The grains a bare sequencer silo hosts. */
export const SEQUENCER_GRAIN_REGISTRATIONS: readonly GrainRegistrationSpec[] = [
  { ctor: DatastoreGrain, interfaces: [IDatastoreGrain] },
  { ctor: GraphShardGrain, interfaces: [IGraphShardGrain] },
  { ctor: ShardIndexGrain, interfaces: [IShardIndexGrain] },
];

/**
 * Binds `stores` and the shard placement strategy on a `TestCluster` silo. Call it from
 * `configureSilo`, which runs after the cluster's own defaults, so the journal binding replaces
 * the cluster's per-cluster one.
 */
export function configureSequencerSilo(builder: SiloBuilder, stores: SequencerStores): void {
  builder.addStorage("datastore", stores.storage);
  builder.useMemoryJournaling(stores.journal);
  addGraphLocalityPlacement(builder);
}
