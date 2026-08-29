import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * Thrown at the write surface when the per-silo sequencer admission gate is full: the silo already
 * has its configured maximum of commits in flight to the cluster-singleton sequencer grain, so this
 * write is shed instead of joining an unbounded activation queue (where it would eventually die as
 * an opaque response timeout). The gRPC front door maps it to `RESOURCE_EXHAUSTED` - a deliberate,
 * retryable overload signal the client backs off from, in contrast to the `Unknown` a timeout storm
 * produced.
 *
 * Note the deliberate asymmetry, transliterated rather than repaired: `dispatch-error-mapper` does
 * NOT list this among the domain exceptions, so on a dispatch hop it would collapse to `internal`.
 * That is unreachable in practice - it is thrown at the write surface (the relationships grain,
 * straight to its gRPC caller), never across a check dispatch.
 *
 * The C#'s `[GenerateSerializer]` becomes the surrogate registered below: it crosses the grain
 * boundary.
 */
export class SequencerOverloadedException extends Error {
  /** Creates the exception with the shed diagnostic message. */
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "SequencerOverloadedException";
  }
}

registerSurrogate<SequencerOverloadedException>({
  tag: "spacedb.sequencerOverloadedException",
  test: (value) => value instanceof SequencerOverloadedException,
  encode: (error) => ({ message: error.message }),
  decode: (fields) => new SequencerOverloadedException(fields.message as string),
});
