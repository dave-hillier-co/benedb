/**
 * Why a `ResolvedRevision.revision` was chosen: whether it came from the optimized (quantized,
 * cacheable) bucket or had to be pinned to an exact caller-supplied snapshot.
 *
 * This is resolution-time provenance ONLY - once a revision string is chosen, evaluation
 * downstream (the grain key, the snapshot read) depends solely on that string, not on why it was
 * picked, so NO mode segment may travel past resolution into a grain key or a cache key. Letting
 * it in fragments the cache along a dimension evaluation does not depend on.
 *
 * The C# enum (Optimized = 0, Exact = 1) becomes a string-literal union: it is internal, not a
 * proto enum, so there is no wire-number map.
 *
 * - `optimized` - sampled from the optimized (quantized) bucket for best latency/cache-hit rate.
 * - `exact` - pinned to an exact revision string derived from a caller-supplied token or head.
 */
export type RevisionMode = "optimized" | "exact";
