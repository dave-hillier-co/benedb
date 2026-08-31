import { defaultGreaterThan, type IRevision } from "@benedb/core/i-revision";

/**
 * A placeholder revision used when the engine is driven directly from an
 * `IDatastoreReader` (the in-process path) and no concrete revision identity is supplied. The
 * dispatch request still carries a revision so it is serializable; the local reader resolver maps
 * any revision back to the single reader it closed over.
 *
 * Ported from Spiceport `Engine/InProcessRevision.cs` (an `internal sealed class` singleton).
 *
 * Its identity semantics are HAND-WRITTEN and deliberately NOT a valid total order:
 * `CompareTo(other) => ReferenceEquals(this, other) ? 0 : -1` claims to be less than every other
 * revision, including ones that claim the same of it. That is transliterated verbatim; do not
 * "fix" it into a total order.
 *
 * Because the equality IS reference equality, this is a single FROZEN MODULE CONSTANT, never a
 * factory - a factory would silently break every `=== IN_PROCESS_REVISION` match downstream.
 * `GetHashCode() => 0` has no counterpart in TypeScript and is dropped.
 */
export const IN_PROCESS_REVISION: IRevision = Object.freeze({
  byteSortable: false,

  toString(): string {
    return "in-process";
  },

  compareTo(other: IRevision | undefined): number {
    return other === IN_PROCESS_REVISION ? 0 : -1;
  },

  equals(other: IRevision | undefined): boolean {
    return other === IN_PROCESS_REVISION;
  },

  greaterThan(other: IRevision | undefined): boolean {
    return defaultGreaterThan(IN_PROCESS_REVISION, other);
  },
});
