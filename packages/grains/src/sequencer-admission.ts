import type { ISequencerMetrics } from "./i-sequencer-metrics";
import {
  resolveSequencerAdmissionOptions,
  type SequencerAdmissionOptions,
} from "./sequencer-admission-options";
import { SequencerOverloadedException } from "./sequencer-overloaded-exception";

/**
 * Ported from Spiceport `Grains/SequencerAdmission.cs`.
 *
 * The per-silo sequencer write admission gate (issue #36): bounds how many commits this silo may
 * have in flight to the cluster-singleton sequencer grain at once, so offered write load beyond
 * the sequencer's capacity degrades as deliberate load shedding ({@link
 * SequencerOverloadedException} -> gRPC `RESOURCE_EXHAUSTED`, a retryable signal) instead of an
 * unbounded activation queue whose requests die as opaque response timeouts. One gate per silo -
 * the same scope as the stateless-worker relationships grain activations that submit production
 * commits - so the sequencer's total queue is bounded by (silo count) x `maxInFlightCommits`.
 * Admission is NON-BLOCKING: a commit either takes a slot immediately or is shed; there is no
 * waiting tier, because waiting is exactly the latency ramp the gate exists to cut off (the
 * admitted in-flight commits already queue, bounded, at the sequencer itself).
 *
 * Only the production declarative write path (`RelationshipsGrain`) enters the gate. The
 * compatibility lambda path (`GrainBackedDatastore.readWriteTx` - tests, seed data) bypasses it.
 * Shed commits are counted via `ISequencerMetrics.recordCommitShed` on the SUBMITTING silo.
 *
 * Port decisions:
 *   * `IDisposable` has NO equivalent under this repo's ES2022 lib (no `Symbol.dispose`, no
 *     `using`), so the slot is an object with an explicit {@link SequencerAdmissionSlot.dispose}
 *     method. The C#'s `using var` becomes an explicit call at the call site; the double-`Dispose`
 *     the C# test performs explicitly still has to be a no-op, and is.
 *   * `SemaphoreSlim.Wait(0)` is a NON-BLOCKING try-take. On a single-threaded event loop the
 *     honest transliteration is a plain in-flight counter: there is no thread to block, so the
 *     semaphore's only remaining job is the bound itself.
 *   * The DOUBLE-RELEASE GUARD is not optional. `Interlocked.Exchange(ref _released, 1) == 0`
 *     becomes a per-slot boolean: a second release would grow capacity past the bound.
 */
export interface SequencerAdmissionSlot {
  /**
   * Releases the in-flight commit slot. Idempotent - a second call is a no-op, exactly as the C#
   * slot's `Interlocked.Exchange` guard makes it.
   */
  dispose(): void;
}

/** The C#'s `NoopSlot.Instance`: the shared slot handed out while the gate is disabled. */
const NOOP_SLOT: SequencerAdmissionSlot = Object.freeze({
  dispose(): void {},
});

export class SequencerAdmission {
  /**
   * `private readonly int _limit = options.MaxInFlightCommits;` - captured at construction, so a
   * later mutation of the options object does not retune the gate, and it is this captured value
   * that the shed message interpolates.
   */
  readonly #limit: number;

  /**
   * `options.MaxInFlightCommits > 0 ? new SemaphoreSlim(...) : null` - a NON-POSITIVE limit
   * leaves the gate DISABLED, which is `false` here.
   */
  readonly #enabled: boolean;

  #inFlight = 0;

  constructor(
    options: SequencerAdmissionOptions,
    private readonly metrics: ISequencerMetrics,
  ) {
    this.#limit = resolveSequencerAdmissionOptions(options).maxInFlightCommits;
    this.#enabled = this.#limit > 0;
  }

  /**
   * Takes an in-flight commit slot, or sheds the commit ({@link SequencerOverloadedException})
   * when all slots are taken. Dispose the returned slot when the sequencer call completes
   * (success, rejection, or throw). With the gate disabled (non-positive limit) every entry
   * succeeds - and records NO shed metric, ever.
   */
  enter(): SequencerAdmissionSlot {
    if (!this.#enabled) return NOOP_SLOT;

    if (this.#inFlight < this.#limit) {
      this.#inFlight += 1;
      let released = false;
      return {
        dispose: () => {
          if (released) return;
          released = true;
          this.#inFlight -= 1;
        },
      };
    }

    // Shed path order: record FIRST, then throw.
    this.metrics.recordCommitShed();
    throw new SequencerOverloadedException(
      `the sequencer write queue is full on this silo (${this.#limit} commits in flight); ` +
        "the write was shed to keep overload retryable — back off and retry",
    );
  }
}
