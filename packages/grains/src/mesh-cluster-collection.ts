/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/MeshClusterCollection.cs`.
 *
 * The xunit original is a `[CollectionDefinition(Name, DisableParallelization = true)]` whose whole
 * job is that cluster-using test CLASSES never run concurrently: `MeshTestCluster` handed its
 * schema to the in-process silo through a process-wide static (`SchemaHolder`), and two concurrent
 * builds would race that static into compiling the wrong schema. `DatastoreInterleavedReadTests`
 * leant on the same guarantee for its own static `Gate` (the pausable-storage handles).
 *
 * LEDGER DEVIATION: the ledger row targeted `mesh-cluster-collection.test.ts`; the file declares no
 * cases, and a `*.test.ts` with no suite fails a vitest run outright, so it lands as
 * `mesh-cluster-collection.ts` and the ledger row is amended.
 *
 * THE DECISION (vitest has no `CollectionDefinition`, so this is a redesign, not a substitution):
 *
 *  1. THE STATIC HANDOFF IS REMOVED, not serialized. The ported `MeshTestCluster` takes its schema
 *     as a normal argument and threads it through the cluster builder into the silo's own
 *     registration, so there is no process-wide holder for two builds to race. This is the better
 *     port precisely because it deletes the hazard the collection existed to work around, rather
 *     than paying for it with a global ordering constraint on the whole suite.
 *  2. CLUSTERS ARE MODULE-SCOPED PER TEST FILE, with explicit teardown: `beforeAll` starts one
 *     `TestCluster`, `afterAll` disposes it. No cluster is ever shared ACROSS files, so there is no
 *     cross-file lifetime to coordinate - and nothing may ever start a real silo host (CLAUDE.md:
 *     a backgrounded host orphans and runs forever).
 *  3. THE REMAINING PER-FILE STATICS ARE ALREADY ISOLATED. vitest's default pool runs each test
 *     FILE with its own module registry (`isolate: true`), so a module-level handle such as
 *     `DatastoreInterleavedReadTests`' `Gate` is per-file state, not process-wide state - the exact
 *     property xunit's `DisableParallelization` had to be asked for explicitly.
 *
 * Consequence to hold onto: if a future mesh harness ever reintroduces cross-file shared state
 * (a fixed listening port, a shared temp directory, a genuine module singleton reached from more
 * than one file), points 1 and 3 stop covering it and the cluster-using files must then be pinned
 * into a dedicated sequential vitest project (`fileParallelism: false`), keyed by this name. The
 * constant is kept for exactly that traceability, and so a reader searching for `MeshCluster`
 * finds the decision rather than nothing.
 */
export const MESH_CLUSTER_COLLECTION = "MeshCluster";
