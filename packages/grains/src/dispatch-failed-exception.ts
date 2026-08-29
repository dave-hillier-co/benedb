import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * The deliberate gRPC-status taxonomy a cross-silo dispatch failure collapses to, mirroring
 * SpiceDB's `rewriteError` (`internal/dispatch/graph/graph.go`) and the remote dispatch boundary
 * (`internal/dispatch/remote/cluster.go`). Each member names the gRPC status code the API front
 * door must emit so a remote grain/transport failure surfaces as a stable, documented code instead
 * of an opaque runtime exception.
 *
 * PORT DECISION. The C# enum's numeric values (`Unavailable = 0` ... `Internal = 3`) are internal:
 * nothing serializes them, and the API layer maps the members onto gRPC codes separately. So this
 * is a string-literal union with NO wire map, per the port guide's non-wire-enum row. What is
 * load-bearing is that the MEMBERS stay distinct - `unavailable` makes `zed` retry a transient hop
 * failure, `internal` makes it fail outright, and collapsing the two either hides a bug or turns a
 * recoverable blip into an error the caller gives up on.
 *
 * - `unavailable`: a transient transport / silo-availability failure mid-dispatch (silo
 *   unreachable, message rejected, call timeout). Retriable: maps to gRPC `Unavailable`, NOT
 *   `Internal`.
 * - `cancelled`: the dispatch was cancelled (caller cancellation). Maps to gRPC `Cancelled`.
 * - `deadlineExceeded`: the dispatch exceeded its deadline. Maps to gRPC `DeadlineExceeded`.
 * - `internal`: an unexpected, non-transient failure with no better classification. Maps to gRPC
 *   `Internal`.
 */
export type DispatchErrorCode = "unavailable" | "cancelled" | "deadlineExceeded" | "internal";

/**
 * Carries a cross-silo dispatch failure back across the grain boundary with its
 * deliberately-chosen gRPC {@link DispatchErrorCode} already settled, so the failure round-trips as
 * a stable code rather than an opaque/lost-type transport exception.
 *
 * Raised by the dispatcher at the dispatch hop when a remote grain call fails with a
 * transport/availability/cancellation/unknown error (the cases SpiceDB's `rewriteError` rewrites).
 * Known typed DOMAIN exceptions (max-depth, invalid-consistency, precondition, write-conflict,
 * schema-write-validation) are deliberately NOT collapsed into this type - they keep their own
 * semantics and pass through unchanged.
 *
 * The C#'s `[GenerateSerializer]` becomes the surrogate registered at the bottom of this module: a
 * child sub-problem may fail on a remote silo several hops below the API call, and the failure must
 * travel back with its code intact.
 */
export class DispatchFailedException extends Error {
  /** The gRPC status the API front door must emit for this dispatch failure. */
  readonly code: DispatchErrorCode;

  /**
   * Creates the exception carrying the settled dispatch error code, a human-readable reason, and
   * optionally the underlying cause (the C# two-arg `(message, innerException)` overload, which
   * maps onto the ES2022 `{ cause }` option). `inner` is `unknown` because a rejected promise can
   * carry anything, not only an `Error`.
   */
  constructor(code: DispatchErrorCode, message: string, inner?: unknown) {
    super(message, inner === undefined ? undefined : { cause: inner });
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "DispatchFailedException";
    this.code = code;
  }
}

// Only `code` and `message` cross: the inner cause is a local diagnostic, and an arbitrary
// exception from a remote silo may not itself be encodable. What must survive the hop is the
// classification - `dispatchErrorMapper` passes an already-classified DispatchFailedException
// through so its code survives further hops, and a lost code would silently degrade a retriable
// `unavailable` to a fatal `internal` at the front door.
registerSurrogate<DispatchFailedException>({
  tag: "spacedb.dispatchFailedException",
  test: (value) => value instanceof DispatchFailedException,
  encode: (error) => ({ code: error.code, message: error.message }),
  decode: (fields) =>
    new DispatchFailedException(fields.code as DispatchErrorCode, fields.message as string),
});
