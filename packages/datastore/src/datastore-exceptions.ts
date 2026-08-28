import type { IRevision } from "@spacedb/core/i-revision";
import { registerSurrogate } from "@thresh/core/value-codec";

// A deliberately MULTI-EXPORT module, per the port ledger: the one sanctioned exception to the
// one-primary-export rule, because `DatastoreExceptions.cs` is a hierarchy that only makes sense
// together. The `...Exception` names are kept rather than renamed to `...Error`, following core's
// precedent (CaveatEvaluationException, InvalidConsistencyTokenException).
//
// Every class sets `Object.setPrototypeOf(this, new.target.prototype)` and an explicit `this.name`
// so `instanceof` survives downlevelling. The four that cross a grain boundary as reply data -
// SerializationException, CreateRelationshipExistsException, CounterAlreadyRegisteredException and
// CounterNotRegisteredException - register a surrogate at the bottom of this module, or Thresh
// delivers them as plain Errors and the caller can no longer choose a gRPC status.

/** Base type for datastore errors. */
export class DatastoreException extends Error {
  /** Creates a datastore exception, optionally wrapping an inner exception as the cause. */
  constructor(message: string, inner?: unknown) {
    // The C# two-arg `(message, inner)` overload maps onto the ES2022 `{ cause }` option.
    super(message, inner === undefined ? undefined : { cause: inner });
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "DatastoreException";
  }
}

/** Thrown when a requested revision is no longer available (garbage collected or never existed). */
export class RevisionNotFoundException extends DatastoreException {
  /** The revision that could not be found. */
  readonly revision: IRevision;

  /** Creates the exception for the given revision. */
  constructor(revision: IRevision) {
    // `$"revision {revision} ..."` calls ToString(), which for a TimestampRevision is the bare
    // nanos string - so `toString()`, never the object interpolated into a template.
    super(`revision ${revision.toString()} is no longer available`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "RevisionNotFoundException";
    this.revision = revision;
  }
}

/**
 * Thrown when a write conflicts with a concurrent write (a genuine write-write serialization
 * failure at commit). SpiceDB maps this to gRPC `Aborted` so the client retries the whole
 * transaction. Distinct from `CreateRelationshipExistsException`, which is a permanent
 * CREATE-on-existing conflict mapped to `AlreadyExists`.
 */
export class SerializationException extends DatastoreException {
  /** Creates a serialization exception. */
  constructor(message: string = "transaction conflicted with a concurrent write") {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "SerializationException";
  }
}

/**
 * Thrown when a CREATE update targets a relationship that already exists. SpiceDB models this as
 * `CreateRelationshipExistsError` and maps it to gRPC `AlreadyExists` (a permanent duplicate-create
 * error the client must NOT blindly retry as a transient conflict).
 */
export class CreateRelationshipExistsException extends DatastoreException {
  /**
   * The canonical (already-formatted) relationship string the CREATE collided on - carried as data
   * (mirroring `CounterAlreadyRegisteredException.counterName`) so a caller that ships the failure
   * across a process/grain boundary as reply data can reconstruct this exact exception: the
   * constructor derives the message from it deterministically.
   */
  readonly relationship: string;

  /**
   * Creates a create-conflict exception for the given (already-formatted) relationship. The
   * message matches real SpiceDB's `CreateRelationshipExistsError` verbatim (observed v1.49.2,
   * identical on WriteRelationships and ImportBulkRelationships), so clients keying on the message
   * see the same string either side.
   */
  constructor(relationship: string) {
    super(
      `could not CREATE relationship \`${relationship}\`, as it already existed. ` +
        "If this is persistent, please switch to TOUCH operations or specify a precondition",
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "CreateRelationshipExistsException";
    this.relationship = relationship;
  }
}

/** Thrown when a revision is malformed or otherwise invalid for the datastore. */
export class InvalidRevisionException extends DatastoreException {
  /** Creates an invalid revision exception. */
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "InvalidRevisionException";
  }
}

/** Thrown when registering a relationship counter whose name is already live. */
export class CounterAlreadyRegisteredException extends DatastoreException {
  /** The counter name that was already registered. */
  readonly counterName: string;

  /** Creates the exception for the given counter name. */
  constructor(name: string) {
    super(`counter with name \`${name}\` is already registered`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "CounterAlreadyRegisteredException";
    this.counterName = name;
  }
}

/**
 * Thrown when `watch` cannot run because the backend is not configured to support it. SpiceDB's
 * `WatchDisabledErr`: Postgres must run with `track_commit_timestamp=on` so the changefeed can
 * emit in commit order.
 */
export class WatchDisabledException extends DatastoreException {
  /** Creates a watch-disabled exception. */
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "WatchDisabledException";
  }
}

/** Thrown when reading, counting, or unregistering a counter that is not live. */
export class CounterNotRegisteredException extends DatastoreException {
  /** The counter name that was not registered. */
  readonly counterName: string;

  /** Creates the exception for the given counter name. */
  constructor(name: string) {
    // Note the asymmetry with the already-registered message: "not found", not "is not
    // registered". Straight from the C#.
    super(`counter with name \`${name}\` not found`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = "CounterNotRegisteredException";
    this.counterName = name;
  }
}

registerSurrogate<SerializationException>({
  tag: "spacedb.serializationException",
  test: (value) => value instanceof SerializationException,
  encode: (error) => ({ message: error.message }),
  decode: (fields) => new SerializationException(fields.message as string),
});

registerSurrogate<CreateRelationshipExistsException>({
  tag: "spacedb.createRelationshipExistsException",
  // Only the relationship crosses: the constructor derives the message from it deterministically.
  test: (value) => value instanceof CreateRelationshipExistsException,
  encode: (error) => ({ relationship: error.relationship }),
  decode: (fields) => new CreateRelationshipExistsException(fields.relationship as string),
});

registerSurrogate<CounterAlreadyRegisteredException>({
  tag: "spacedb.counterAlreadyRegisteredException",
  test: (value) => value instanceof CounterAlreadyRegisteredException,
  encode: (error) => ({ counterName: error.counterName }),
  decode: (fields) => new CounterAlreadyRegisteredException(fields.counterName as string),
});

registerSurrogate<CounterNotRegisteredException>({
  tag: "spacedb.counterNotRegisteredException",
  test: (value) => value instanceof CounterNotRegisteredException,
  encode: (error) => ({ counterName: error.counterName }),
  decode: (fields) => new CounterNotRegisteredException(fields.counterName as string),
});
