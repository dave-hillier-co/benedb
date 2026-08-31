import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import { registerSurrogate } from "@thresh/core/value-codec";

/**
 * Value-codec surrogate for {@link RevisionNotFoundException}.
 *
 * The datastore-layer `RevisionNotFoundException` is a domain exception that must NOT take a Thresh
 * dependency, yet it crosses the grain boundary when `IDatastoreLog.readFrom` rejects a cursor older
 * than the GC window. So the registration lives here, in the grains layer, rather than alongside the
 * four siblings registered in `@benedb/datastore/datastore-exceptions`.
 *
 * The consequence is load-bearing: `dispatch-error-mapper` treats RevisionNotFoundException as a
 * DOMAIN exception (caller-facing InvalidArgument). If it did not come back as its own class the
 * mapper would fall through to `internal`, and a stale Watch cursor - an ordinary, expected client
 * condition - would surface to `zed` as a 500.
 *
 * The module has no exports: importing it for its side effect IS the contract, exactly as
 * `datastore-exceptions.ts` registers its four at module load.
 */

// The C# converter is `value.Revision is TimestampRevision t ? t.TimestampNanosSinceEpoch : 0`, and
// the lossiness is transliterated, not fixed: the revision set is open by design, so another
// datastore's revision type simply does not survive this hop and arrives as nanos 0. `long` becomes
// `bigint` end to end - the nanos run past 2^53.
registerSurrogate<RevisionNotFoundException>({
  tag: "benedb.revisionNotFoundException",
  // Narrow to the concrete class, never to the `DatastoreException` base: registration order means
  // later registrations are tested first, so a base-class predicate here would swallow every
  // datastore exception into this tag.
  test: (value) => value instanceof RevisionNotFoundException,
  encode: (error) => ({
    revisionNanos:
      error.revision instanceof TimestampRevision ? error.revision.timestampNanosSinceEpoch : 0n,
  }),
  decode: (fields) =>
    new RevisionNotFoundException(new TimestampRevision(fields.revisionNanos as bigint)),
});
