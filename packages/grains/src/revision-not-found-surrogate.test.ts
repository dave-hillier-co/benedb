import type { IRevision } from "@benedb/core/i-revision";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import { deserializeValue, serializeValue } from "@thresh/core/value-codec";
import { describe, expect, it } from "vitest";

// Importing the module for its side effect IS the subject: the registration happens at module load,
// exactly as `datastore-exceptions.ts` registers the other four.
import "./revision-not-found-surrogate";

// No covering C# test. `RevisionNotFoundException` lives in @benedb/datastore and must NOT take a
// Thresh dependency, yet it crosses the grain boundary whenever `IDatastoreLog.readFrom` rejects a
// cursor older than the GC window - so the surrogate lives here, in the grains layer, instead.
//
// The consequence is load-bearing: `DispatchErrorMapper` treats RevisionNotFoundException as a
// DOMAIN exception (caller-facing InvalidArgument). If it did not come back as its own class the
// mapper would fall through to Internal, and a stale Watch cursor - an ordinary, expected client
// condition - would surface to `zed` as a 500.
describe("revision not found surrogate", () => {
  it("round-trips the exception as its own class with the revision intact", () => {
    const original = new RevisionNotFoundException(new TimestampRevision(1700000000000000000n));

    const revived = deserializeValue<RevisionNotFoundException>(serializeValue(original));

    expect(revived).toBeInstanceOf(RevisionNotFoundException);
    expect(revived.revision).toBeInstanceOf(TimestampRevision);
    expect((revived.revision as TimestampRevision).timestampNanosSinceEpoch).toBe(
      1700000000000000000n,
    );
  });

  it("reconstructs the same message, since the constructor derives it from the revision", () => {
    const original = new RevisionNotFoundException(new TimestampRevision(42n));

    const revived = deserializeValue<RevisionNotFoundException>(serializeValue(original));

    expect(revived.message).toBe(original.message);
    expect(revived.message).toBe("revision 42 is no longer available");
  });

  it("keeps full int64 precision, well past 2^53 - the nanos are a `long`", () => {
    const original = new RevisionNotFoundException(new TimestampRevision(9223372036854775807n));

    const revived = deserializeValue<RevisionNotFoundException>(serializeValue(original));

    expect((revived.revision as TimestampRevision).timestampNanosSinceEpoch).toBe(
      9223372036854775807n,
    );
  });

  it("is lossy for a non-timestamp revision, encoding it as nanos 0 - transliterated, not fixed", () => {
    // The C# converter is `value.Revision is TimestampRevision t ? t.TimestampNanosSinceEpoch : 0`.
    // The revision set is open by design, so another datastore's revision type simply does not
    // survive this hop. Pinned deliberately: this is the C#'s behaviour, and "improving" it here
    // would diverge the two implementations at a point no conformance case reaches.
    const foreign: IRevision = {
      toString: () => "foreign",
      byteSortable: false,
      compareTo: () => 0,
      equals: () => false,
      greaterThan: () => false,
    };

    const revived = deserializeValue<RevisionNotFoundException>(
      serializeValue(new RevisionNotFoundException(foreign)),
    );

    expect(revived).toBeInstanceOf(RevisionNotFoundException);
    expect(revived.revision).toBeInstanceOf(TimestampRevision);
    expect((revived.revision as TimestampRevision).timestampNanosSinceEpoch).toBe(0n);
  });

  it("does not shadow the sibling datastore exceptions registered in @benedb/datastore", () => {
    // Registration order matters to the codec (later registrations are tested first), and
    // RevisionNotFoundException shares a base class with them. A `test` predicate written against
    // the base would swallow every datastore exception into this tag.
    const revived = deserializeValue<RevisionNotFoundException>(
      serializeValue(new RevisionNotFoundException(new TimestampRevision(1n))),
    );

    expect(revived).toBeInstanceOf(RevisionNotFoundException);
    expect(revived.name).toBe("RevisionNotFoundException");
  });
});
