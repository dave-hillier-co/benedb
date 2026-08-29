/**
 * Configuration for the per-silo sequencer write admission gate (`SequencerAdmission`). A host
 * opts out or retunes by passing an override.
 */
export interface SequencerAdmissionOptions {
  /**
   * The maximum number of commits this silo may have in flight to the cluster-singleton
   * sequencer grain at once; a commit arriving beyond it is shed with `SequencerOverloadedError`
   * (gRPC `RESOURCE_EXHAUSTED`) instead of queueing without bound on the sequencer's single
   * non-reentrant activation. The bound is the silo's worst-case sequencer-queue contribution,
   * so its product with the per-commit turn time (times the silo count) must stay well under the
   * response timeout - the failure mode this gate exists to prevent.
   *
   * ZERO OR NEGATIVE DISABLES THE GATE (unbounded, the pre-gate behaviour), so the resolver
   * defaults with `??`: a `||` default would turn that documented sentinel back into 128 and
   * quietly re-enable a gate a host deliberately turned off.
   */
  readonly maxInFlightCommits?: number | undefined;
}

/** `SequencerAdmissionOptions` with every default applied. */
export interface ResolvedSequencerAdmissionOptions {
  readonly maxInFlightCommits: number;
}

export function resolveSequencerAdmissionOptions(
  options?: SequencerAdmissionOptions,
): ResolvedSequencerAdmissionOptions {
  return { maxInFlightCommits: options?.maxInFlightCommits ?? 128 };
}
