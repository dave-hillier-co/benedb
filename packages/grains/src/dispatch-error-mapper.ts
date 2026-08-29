import { CaveatEvaluationException } from "@spacedb/core/caveat-evaluation-exception";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { InvalidConsistencyTokenException } from "@spacedb/core/invalid-consistency-token-exception";
import { MaxDepthExceededException } from "@spacedb/core/max-depth-exceeded-exception";
import { RevisionNotFoundException } from "@spacedb/datastore/datastore-exceptions";
import {
  GrainCallAbortedError,
  GrainCallError,
  GrainCallTimeoutError,
  GrainTaskCanceledError,
  RejectionError,
} from "@thresh/core/errors";

import { DispatchFailedException, type DispatchErrorCode } from "./dispatch-failed-exception";
import { PreconditionFailedException } from "./precondition-failed-exception";
import { SchemaWriteValidationException } from "./schema-write-validation-exception";
import { WriteConflictException } from "./write-conflict-exception";

/**
 * The outcome of classifying a dispatch-boundary exception.
 *
 * The C# is a `readonly record struct` with a static `Domain` singleton, so the port is a readonly
 * interface plus the frozen module constant {@link DISPATCH_CLASSIFICATION_DOMAIN} (call sites
 * compare it) and the {@link mappedDispatchClassification} factory.
 */
export interface DispatchClassification {
  /**
   * When true, the exception is a known typed DOMAIN exception that already carries its own gRPC
   * meaning (max-depth, invalid-consistency, precondition, write-conflict,
   * schema-write-validation, caveat-evaluation, revision-not-found, already-classified dispatch
   * failure) and must be re-thrown UNCHANGED - never collapsed into a transport error. `code` is
   * unused in this case.
   */
  readonly passThrough: boolean;
  /**
   * When `passThrough` is false, the deliberately-chosen gRPC code the transport/cancellation/
   * unknown failure collapses to.
   */
  readonly code: DispatchErrorCode;
}

/**
 * A domain exception that must be re-thrown as-is. The C#'s `Classification.Domain` static
 * singleton; `code` carries the enum's `default`, which for the ported string-literal union is its
 * first member, and is unused.
 */
export const DISPATCH_CLASSIFICATION_DOMAIN: DispatchClassification = Object.freeze({
  passThrough: true,
  code: "unavailable" as DispatchErrorCode,
});

/** A transport/cancellation/unknown failure mapped to `code`. The C#'s `Classification.Mapped`. */
export function mappedDispatchClassification(code: DispatchErrorCode): DispatchClassification {
  return { passThrough: false, code };
}

/**
 * Whether `exception` is a known typed domain exception that already has a gRPC meaning the API
 * layer maps directly, and so must NOT be collapsed into a transport error.
 *
 * The list is exactly the C#'s, in the C#'s order. `SequencerOverloadedException` is deliberately
 * absent - see its own module.
 */
export function isDispatchDomainException(exception: unknown): boolean {
  return (
    exception instanceof MaxDepthExceededException ||
    exception instanceof InvalidConsistencyTokenException ||
    exception instanceof CaveatEvaluationException ||
    exception instanceof PreconditionFailedException ||
    exception instanceof WriteConflictException ||
    exception instanceof SchemaWriteValidationException ||
    // pinned revision fell below the GC floor: caller-facing InvalidArgument.
    exception instanceof RevisionNotFoundException ||
    // already-classified failure from a deeper hop: keep its code.
    exception instanceof DispatchFailedException
  );
}

/**
 * Whether `exception` is a cancellation.
 *
 * PORT DECISION. C#'s `TaskCanceledException` derives from `OperationCanceledException`, so the C#
 * catches both with one `is OperationCanceledException`. TypeScript has no such hierarchy, so the
 * port matches the ABORT FAMILY explicitly: Thresh's {@link GrainCallAbortedError} and
 * {@link GrainTaskCanceledError}, plus a DOM `AbortError` raised by an `AbortSignal`. One
 * predicate, all the cases.
 */
function isCancellation(exception: unknown): boolean {
  return (
    exception instanceof GrainCallAbortedError ||
    exception instanceof GrainTaskCanceledError ||
    (exception instanceof DOMException && exception.name === "AbortError")
  );
}

/**
 * Whether `exception` is a transient transport / silo-availability / timeout failure that should be
 * reported as retriable `unavailable`.
 *
 * PORT DECISION. Orleans' `SiloUnavailableException`, `OrleansMessageRejectionException`,
 * `TimeoutException` and the `OrleansException` catch-all base have no one-to-one Thresh names.
 * Thresh raises {@link RejectionError} for a refused call (its `kind` names the refusal; both the
 * silo-unavailable and message-rejected cases land here), {@link GrainCallTimeoutError} for a call
 * that missed its deadline, and {@link GrainCallError} as the general dispatch/execution failure
 * that stands in for the `OrleansException` catch-all. Thresh has no single base class beneath all
 * three, so the arm is an explicit list rather than one `instanceof` - recorded as a Thresh gap.
 *
 * The C#'s `_ => false` default arm is load-bearing and is kept: a programming fault (TypeError,
 * RangeError, a plain Error) must NOT be reported as retriable, or `zed` retries a bug forever.
 */
export function isDispatchTransportFailure(exception: unknown): boolean {
  return (
    exception instanceof RejectionError ||
    // Thresh surfaces a response timeout / dropped request as a call-timeout error; treat it as a
    // transient hop failure (retriable), not a deadline the caller set.
    exception instanceof GrainCallTimeoutError ||
    // Any other Thresh grain-call failure (e.g. no compatible silo for placement) is an
    // availability problem at the mesh layer -> retriable.
    exception instanceof GrainCallError
  );
}

/**
 * Classifies `exception` into the dispatch-error taxonomy. Pure: no I/O, no silo.
 *
 * ORDER MATTERS. Known domain exceptions are recognised FIRST so a domain failure that happens to be
 * wrapped is never mislabeled as a transport error. Then cancellation/deadline, then transport /
 * availability (retriable -> `unavailable`), then everything else -> `internal`.
 */
export function classifyDispatchError(exception: unknown): DispatchClassification {
  // The C#'s `ArgumentNullException.ThrowIfNull`, per the port guide's argument-guard row.
  if (exception === undefined || exception === null) {
    throw new InvalidArgumentError("exception must not be null or undefined");
  }

  // 1. Known typed domain exceptions keep their own gRPC semantics - pass through unchanged.
  if (isDispatchDomainException(exception)) return DISPATCH_CLASSIFICATION_DOMAIN;

  // 2. Cancellation / deadline. A cancellation surfaced as a timeout (a deadline elapsed) is
  //    DeadlineExceeded; a plain caller cancellation is Cancelled.
  if (isCancellation(exception)) return mappedDispatchClassification("cancelled");

  // 3. Transport / silo-availability failures are TRANSIENT -> retriable Unavailable (NOT
  //    Internal): a silo dropping mid-check should let the client retry, matching SpiceDB.
  if (isDispatchTransportFailure(exception)) return mappedDispatchClassification("unavailable");

  // 4. Anything else is unexpected -> Internal.
  return mappedDispatchClassification("internal");
}

/**
 * Translates an exception surfaced from (or at) a cross-silo `ICheckGrain.dispatchCheck` hop into
 * the exception the caller should see: a known domain exception (and an already-classified
 * {@link DispatchFailedException}) is re-thrown unchanged; everything else is collapsed to a
 * {@link DispatchFailedException} carrying its deliberately-mapped {@link DispatchErrorCode}. Pure,
 * given {@link classifyDispatchError}.
 *
 * The reason strings are USER-VISIBLE and are copied from the C# verbatim.
 */
export function translateDispatchError(exception: unknown): unknown {
  const classification = classifyDispatchError(exception);
  if (classification.passThrough) return exception;

  let reason: string;
  switch (classification.code) {
    case "unavailable":
      reason =
        "the permission check could not reach the silo that owns this sub-problem; the failure " +
        "is transient and the request may be retried";
      break;
    case "cancelled":
      reason = "the permission check was cancelled";
      break;
    case "deadlineExceeded":
      reason = "the permission check exceeded its deadline";
      break;
    default:
      reason = "the permission check failed with an unexpected dispatch error";
      break;
  }

  return new DispatchFailedException(classification.code, reason, exception);
}
