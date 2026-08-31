import { defaultGreaterThan, type IRevision } from "@benedb/core/i-revision";
import { describe, expect, it } from "vitest";

import { IN_PROCESS_REVISION } from "./in-process-revision";

// Characterization of Spiceport `InProcessRevision.cs` (no covering C# test - the type is
// `internal`, and DispatcherSeamTests deliberately substitutes a real revision instead).
//
// The whole point of this type is that its identity semantics are HAND-WRITTEN and deliberately
// NOT a valid total order: `CompareTo` returns 0 for the singleton itself and -1 for EVERY other
// revision, including itself compared the other way round by a different implementation. That
// asymmetry is transliterated verbatim; do not "fix" it into a total order.
//
// Because the equality IS reference equality, the export is a single FROZEN MODULE CONSTANT, not
// a factory. A factory would silently break every `=== IN_PROCESS_REVISION` match downstream.

// A stand-in for any other IRevision implementation. Declared locally rather than importing
// `TimestampRevision`, so this suite (and the engine layer) stays free of @thresh/* transitively.
class OtherRevision implements IRevision {
  readonly byteSortable = true;
  toString(): string {
    return "other";
  }
  compareTo(other: IRevision | undefined): number {
    return other === undefined ? 1 : 0;
  }
  equals(other: IRevision | undefined): boolean {
    return other instanceof OtherRevision;
  }
  greaterThan(other: IRevision | undefined): boolean {
    return defaultGreaterThan(this, other);
  }
}

describe("in-process revision", () => {
  it('stringifies as "in-process"', () => {
    expect(IN_PROCESS_REVISION.toString()).toBe("in-process");
    expect(`${IN_PROCESS_REVISION}`).toBe("in-process");
  });

  it("is not byte-sortable", () => {
    expect(IN_PROCESS_REVISION.byteSortable).toBe(false);
  });

  it("is a frozen singleton, not a factory", () => {
    expect(Object.isFrozen(IN_PROCESS_REVISION)).toBe(true);
    expect(IN_PROCESS_REVISION).toBe(IN_PROCESS_REVISION);
  });

  describe("compareTo", () => {
    it("returns 0 only for the singleton itself (reference identity)", () => {
      expect(IN_PROCESS_REVISION.compareTo(IN_PROCESS_REVISION)).toBe(0);
    });

    it("returns -1 for any other revision", () => {
      expect(IN_PROCESS_REVISION.compareTo(new OtherRevision())).toBe(-1);
    });

    it("returns -1 for undefined", () => {
      expect(IN_PROCESS_REVISION.compareTo(undefined)).toBe(-1);
    });

    it("returns -1 against a structurally identical but distinct object", () => {
      // Reference equality, not structural: a look-alike is NOT the singleton.
      const lookalike: IRevision = {
        byteSortable: false,
        toString: () => "in-process",
        compareTo: () => 0,
        equals: () => true,
        greaterThan: () => false,
      };

      expect(IN_PROCESS_REVISION.compareTo(lookalike)).toBe(-1);
    });

    it("is deliberately NOT a valid total order", () => {
      const other = new OtherRevision();

      // Both directions claim to be less than the other. This is the C# behaviour verbatim.
      expect(IN_PROCESS_REVISION.compareTo(other)).toBe(-1);
      expect(other.compareTo(IN_PROCESS_REVISION)).toBe(0);
    });
  });

  describe("equals", () => {
    it("is reference equality", () => {
      expect(IN_PROCESS_REVISION.equals(IN_PROCESS_REVISION)).toBe(true);
      expect(IN_PROCESS_REVISION.equals(new OtherRevision())).toBe(false);
      expect(IN_PROCESS_REVISION.equals(undefined)).toBe(false);
    });
  });

  describe("greaterThan", () => {
    it("is never greater than anything, because compareTo never returns a positive", () => {
      expect(IN_PROCESS_REVISION.greaterThan(IN_PROCESS_REVISION)).toBe(false);
      expect(IN_PROCESS_REVISION.greaterThan(new OtherRevision())).toBe(false);
      expect(IN_PROCESS_REVISION.greaterThan(undefined)).toBe(false);
    });
  });
});
