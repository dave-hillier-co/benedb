import { MaxDepthExceededException } from "@spacedb/core/max-depth-exceeded-exception";
import {
  GrainCallAbortedError,
  GrainCallError,
  GrainCallTimeoutError,
  RejectionError,
} from "@thresh/core/errors";
import { describe, expect, it } from "vitest";

import {
  DISPATCH_CLASSIFICATION_DOMAIN,
  isDispatchDomainException,
  isDispatchTransportFailure,
  mappedDispatchClassification,
  translateDispatchError,
} from "./dispatch-error-mapper";
import { DispatchFailedException } from "./dispatch-failed-exception";
import { SequencerOverloadedException } from "./sequencer-overloaded-exception";

// `DispatchErrorMapperTests.cs` covers `Classify` only (see `dispatch-error-mapper-tests.test.ts`).
// This file characterizes the rest of the C# file: the `Translate` surface whose reason strings are
// USER-VISIBLE, the two public predicates, and the classification value type. Nothing here is a
// weakening of the ported cases - it pins behaviour the C# has but never asserts.
describe("dispatch classification", () => {
  it("exposes Domain as a shared, frozen singleton - call sites compare it", () => {
    expect(DISPATCH_CLASSIFICATION_DOMAIN.passThrough).toBe(true);
    expect(Object.isFrozen(DISPATCH_CLASSIFICATION_DOMAIN)).toBe(true);
  });

  it("builds a mapped classification carrying the chosen code", () => {
    const mapped = mappedDispatchClassification("deadlineExceeded");

    expect(mapped.passThrough).toBe(false);
    expect(mapped.code).toBe("deadlineExceeded");
  });
});

describe("dispatch domain predicate", () => {
  it("recognises the eight domain types the C# lists, and nothing else", () => {
    expect(isDispatchDomainException(new MaxDepthExceededException())).toBe(true);
    expect(isDispatchDomainException(new DispatchFailedException("unavailable", "t"))).toBe(true);
    expect(isDispatchDomainException(new Error("boom"))).toBe(false);
    expect(isDispatchDomainException(new GrainCallError("gone"))).toBe(false);
  });

  it("does NOT list SequencerOverloadedException, so on a dispatch hop it collapses to Internal", () => {
    // Transliterated, not repaired. The C#'s domain list omits it because it is thrown at the WRITE
    // surface (the relationships grain, straight to its gRPC caller), never across a check
    // dispatch, so the collapse is unreachable in practice. Adding it here would diverge the two
    // implementations at a point no test in either repo would notice.
    const overloaded = new SequencerOverloadedException("shed");

    expect(isDispatchDomainException(overloaded)).toBe(false);

    const translated = translateDispatchError(overloaded);

    expect(translated).toBeInstanceOf(DispatchFailedException);
    expect((translated as DispatchFailedException).code).toBe("internal");
  });

  it("does not treat a programming fault as a domain exception", () => {
    expect(isDispatchDomainException(new TypeError("x is not a function"))).toBe(false);
    expect(isDispatchDomainException(new RangeError("out of range"))).toBe(false);
  });
});

describe("dispatch transport predicate", () => {
  it("recognises Thresh's rejection, timeout and general grain-call failures", () => {
    expect(isDispatchTransportFailure(new RejectionError("gone", "noCandidates"))).toBe(true);
    expect(isDispatchTransportFailure(new GrainCallTimeoutError("timed out"))).toBe(true);
    expect(isDispatchTransportFailure(new GrainCallError("no compatible silo"))).toBe(true);
  });

  it("does not swallow a programming fault as a transient transport failure", () => {
    // The C#'s `_ => false` arm. A TypeError reported as retriable Unavailable would have `zed`
    // retrying a bug forever instead of surfacing it.
    expect(isDispatchTransportFailure(new TypeError("x is not a function"))).toBe(false);
    expect(isDispatchTransportFailure(new RangeError("out of range"))).toBe(false);
    expect(isDispatchTransportFailure(new Error("boom"))).toBe(false);
  });
});

describe("translating a dispatch failure", () => {
  it("returns a domain exception unchanged - the same instance, not a copy", () => {
    const original = new MaxDepthExceededException();

    expect(translateDispatchError(original)).toBe(original);
  });

  it("returns an already-classified dispatch failure unchanged, so its code survives", () => {
    const original = new DispatchFailedException("unavailable", "transient");

    expect(translateDispatchError(original)).toBe(original);
  });

  it("collapses a transport failure to Unavailable with the verbatim reason", () => {
    const translated = translateDispatchError(
      new RejectionError("silo gone", "noCandidates"),
    ) as DispatchFailedException;

    expect(translated).toBeInstanceOf(DispatchFailedException);
    expect(translated.code).toBe("unavailable");
    expect(translated.message).toBe(
      "the permission check could not reach the silo that owns this sub-problem; the failure " +
        "is transient and the request may be retried",
    );
  });

  it("collapses a cancellation to Cancelled with the verbatim reason", () => {
    const translated = translateDispatchError(
      new GrainCallAbortedError(),
    ) as DispatchFailedException;

    expect(translated.code).toBe("cancelled");
    expect(translated.message).toBe("the permission check was cancelled");
  });

  it("collapses anything else to Internal with the verbatim reason", () => {
    const translated = translateDispatchError(new Error("boom")) as DispatchFailedException;

    expect(translated.code).toBe("internal");
    expect(translated.message).toBe(
      "the permission check failed with an unexpected dispatch error",
    );
  });

  it.each([[new TypeError("x is not a function")], [new RangeError("out of range")]])(
    "lets a programming fault land in the Internal arm rather than the transport arm (%s)",
    (fault) => {
      const translated = translateDispatchError(fault) as DispatchFailedException;

      expect(translated.code).toBe("internal");
    },
  );

  it("keeps the original as the cause, so the local log still shows what actually failed", () => {
    const original = new GrainCallTimeoutError("timed out");

    const translated = translateDispatchError(original) as DispatchFailedException;

    expect(translated.cause).toBe(original);
  });
});
