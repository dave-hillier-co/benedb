import { CaveatEvaluationException } from "@spacedb/core/caveat-evaluation-exception";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { InvalidConsistencyTokenException } from "@spacedb/core/invalid-consistency-token-exception";
import { MaxDepthExceededException } from "@spacedb/core/max-depth-exceeded-exception";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@spacedb/datastore/datastore-exceptions";
import {
  GrainCallAbortedError,
  GrainCallError,
  GrainCallTimeoutError,
  GrainTaskCanceledError,
  RejectionError,
} from "@thresh/core/errors";
import { describe, expect, it } from "vitest";

import { classifyDispatchError } from "./dispatch-error-mapper";
import { DispatchFailedException } from "./dispatch-failed-exception";
import { PreconditionFailedException } from "./precondition-failed-exception";
import { SchemaWriteValidationException } from "./schema-write-validation-exception";
import { WriteConflictException } from "./write-conflict-exception";

// Ported from Spiceport `tests/Spiceport.Grains.Tests/DispatchErrorMapperTests.cs`, case for case.
//
// Two substitutions the C# cases needed, both from the port guide:
//
//   * TRANSPORT. Orleans' `SiloUnavailableException`, `OrleansMessageRejectionException`,
//     `TimeoutException` and the `OrleansException` base have no one-to-one Thresh names. Thresh
//     raises `RejectionError` (with a `kind` naming the refusal - the silo-unavailable and
//     message-rejected cases both land here), `GrainCallTimeoutError` for a call that missed its
//     deadline, and `GrainCallError` as the general dispatch/execution failure that stands in for
//     the `OrleansException` catch-all. Four C# cases, four Thresh cases.
//   * CANCELLATION. C#'s `TaskCanceledException` derives from `OperationCanceledException`, so both
//     of the C#'s cancellation cases hit the same branch. TypeScript has no such hierarchy, so the
//     port matches the ABORT FAMILY explicitly: `GrainCallAbortedError`, `GrainTaskCanceledError`
//     and a DOM `AbortError`. One predicate, all the cases.
//
// `Assert.Throws<ArgumentNullException>` becomes the project `InvalidArgumentError`, per the guide.

const domainExceptions: ReadonlyArray<readonly [string, unknown]> = [
  ["MaxDepthExceededException", new MaxDepthExceededException()],
  ["InvalidConsistencyTokenException", new InvalidConsistencyTokenException("bad token")],
  ["CaveatEvaluationException", new CaveatEvaluationException("parameterTypeMismatch", "x")],
  ["PreconditionFailedException", new PreconditionFailedException("mustMatchFoundNone", 0, "p")],
  ["WriteConflictException", new WriteConflictException("serialization", "conflict")],
  ["SchemaWriteValidationException", new SchemaWriteValidationException("dangling")],
  ["RevisionNotFoundException", new RevisionNotFoundException(new TimestampRevision(1n))],
];

const transportFailures: ReadonlyArray<readonly [string, unknown]> = [
  ["RejectionError (silo unavailable)", new RejectionError("silo gone", "noCandidates")],
  ["RejectionError (message rejected)", new RejectionError("message rejected", "unknownTarget")],
  ["GrainCallTimeoutError", new GrainCallTimeoutError("response timed out")],
  ["GrainCallError", new GrainCallError("no compatible silo")],
];

describe("dispatch error mapper", () => {
  it.each(domainExceptions)("passes the domain exception %s through unchanged", (_name, ex) => {
    const c = classifyDispatchError(ex);

    expect(c.passThrough).toBe(true);
  });

  it("passes an already-classified dispatch failure through so its code survives further hops", () => {
    const ex = new DispatchFailedException("unavailable", "transient");

    const c = classifyDispatchError(ex);

    expect(c.passThrough).toBe(true);
  });

  it.each(transportFailures)(
    "maps the transport/availability failure %s to retriable Unavailable",
    (_name, ex) => {
      const c = classifyDispatchError(ex);

      expect(c.passThrough).toBe(false);
      expect(c.code).toBe("unavailable");
    },
  );

  it("maps cancellation to Cancelled", () => {
    const c = classifyDispatchError(new GrainCallAbortedError());

    expect(c.passThrough).toBe(false);
    expect(c.code).toBe("cancelled");
  });

  it("maps a grain task cancellation to Cancelled (the C#'s TaskCanceledException case)", () => {
    const c = classifyDispatchError(new GrainTaskCanceledError());

    expect(c.passThrough).toBe(false);
    expect(c.code).toBe("cancelled");
  });

  it("maps a DOM AbortError to Cancelled - the same abort family, raised by an AbortSignal", () => {
    const c = classifyDispatchError(new DOMException("aborted", "AbortError"));

    expect(c.passThrough).toBe(false);
    expect(c.code).toBe("cancelled");
  });

  it("maps an unrecognised exception to Internal", () => {
    // The port's stand-in for the C#'s `InvalidOperationException`: the layers beneath throw a
    // plain `Error` where .NET threw one of the BCL invalid-operation types.
    const c = classifyDispatchError(new Error("boom"));

    expect(c.passThrough).toBe(false);
    expect(c.code).toBe("internal");
  });

  it("rejects null", () => {
    expect(() => classifyDispatchError(undefined)).toThrow(InvalidArgumentError);
  });
});
