import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";

/**
 * A tiny, self-contained, seedable pseudo-random number generator: the port's stand-in for
 * .NET's `System.Random(int seed)`.
 *
 * It has no C# source file. `Random` is a BCL type, and `Math.random` cannot be seeded at all,
 * so the deterministic generators the property gates run over
 * (`random-authz-worlds.ts`) need an explicit algorithm written down here. No dependency: a
 * seeded PRNG pulled from npm is a supply-chain surface and a version-drift risk on the one
 * property every gate depends on.
 *
 * THE SEQUENCE DELIBERATELY DIFFERS FROM .NET'S. `System.Random(seed)` is a specific subtractive
 * generator; reproducing it byte for byte is neither possible in a small amount of code nor
 * useful, because nothing compares a SpaceDB run against a Spiceport run number by number. What
 * must hold is the property .NET's `Random(seed)` gave the C#: the same seed yields the same
 * sequence on every run, on every machine, forever. That is pinned by `seeded-random.test.ts`,
 * which hardcodes exact draws - change the algorithm and those tests fail, which is the point.
 *
 * The algorithm is mulberry32: a 32-bit-state counter fed through an avalanche mix. It is
 * chosen for being auditable at a glance and having no state larger than a `number` can hold
 * exactly. Every arithmetic step goes through `Math.imul` / `>>>` because C# `int` overflow
 * wraps and JavaScript `number` does not.
 */
export interface SeededRandom {
  /**
   * `System.Random.Next(int maxValue)`: a uniformly-drawn integer in `[0, exclusiveMax)`.
   *
   * Throws for a non-positive bound, where .NET throws `ArgumentOutOfRangeException`. .NET
   * returns 0 for `Next(0)`; that call only ever arises here from an empty alphabet, which is a
   * bug in the caller, so the port is deliberately stricter and says so.
   */
  next(exclusiveMax: number): number;
  /** `System.Random.NextDouble()`: a uniformly-drawn double in `[0, 1)`. */
  nextDouble(): number;
}

/**
 * Creates a generator for `seed`. The seed is avalanche-mixed before use because the gates run
 * over CONSECUTIVE seeds (0..SEED_COUNT-1) and a raw counter state makes consecutive seeds
 * produce visibly correlated first draws - every early world would pick the same template.
 */
export function createSeededRandom(seed: number): SeededRandom {
  if (!Number.isInteger(seed))
    throw new InvalidArgumentError(`seed must be an integer, got ${seed}`);

  let state = scramble(seed);

  const nextDouble = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    nextDouble,
    next(exclusiveMax: number): number {
      if (!Number.isInteger(exclusiveMax) || exclusiveMax <= 0)
        throw new InvalidArgumentError(
          `exclusiveMax must be a positive integer, got ${exclusiveMax}`,
        );
      return Math.floor(nextDouble() * exclusiveMax);
    },
  };
}

/** A 32-bit integer avalanche (the murmur3 finalizer), so nearby seeds start far apart. */
function scramble(seed: number): number {
  let h = seed | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}
