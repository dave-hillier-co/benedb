/**
 * Stable, process-independent, non-cryptographic string hashing shared by everything that needs
 * the SAME answer for the same string on every silo and across restarts: the graph-locality
 * placement director (silo choice per locality key) and the datastore grain's durable key-index
 * bucketing (`indexb/{version}/{dir}/{bucket}` rows - the bucket of a key is part of the durable
 * layout, so it must never change across processes or runtimes). A per-process randomized string
 * hash is deliberately NOT used.
 */

const OFFSET_BASIS = 14695981039346656037n;
const PRIME = 1099511628211n;
const MASK64 = 0xffffffffffffffffn;

/**
 * FNV-1a 64-bit over the string's UTF-16 code units.
 *
 * The C# folds `ulong` under `unchecked`, so the multiply wraps: every step masks to 64 bits.
 * `foreach (var ch in value)` in C# iterates UTF-16 CODE UNITS, so an astral character
 * contributes its two surrogate halves rather than one 21-bit code point - `charCodeAt` in an
 * index loop reproduces that, `for (const ch of value)` would not. The result stays a `bigint`
 * because `KeyIndexLayout.BucketOf` does an unsigned `hash % (ulong)bucketCount` and only then
 * narrows: doing that modulo in `number` would round the hash past 2^53 first.
 */
export function fnv1a64(value: string): bigint {
  let hash = OFFSET_BASIS;
  for (let i = 0; i < value.length; i++) {
    hash = (hash ^ BigInt(value.charCodeAt(i))) & MASK64;
    hash = (hash * PRIME) & MASK64;
  }

  return hash;
}
