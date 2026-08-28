/**
 * An opaque, comparable representation of a point-in-time datastore state.
 * Implementations must be value-comparable and provide a stable string form.
 *
 * The C# `IRevision` is `IComparable<IRevision> + IEquatable<IRevision>` and carries a DEFAULT
 * INTERFACE METHOD for `GreaterThan`. TypeScript has neither default interface methods nor a way
 * for a serialized plain object to keep behaviour, so the port keeps an interface with explicit
 * members and moves the default body into the `defaultGreaterThan` free function below, which a
 * totally-ordered implementation delegates to.
 *
 * The set of revision types is OPEN by design - each datastore supplies its own - so this stays
 * an interface rather than a discriminated union. The price is that a revision crossing a grain
 * boundary is an object the receiver calls methods on, so every implementation must register a
 * Thresh surrogate with the value codec.
 */
export interface IRevision {
  /** The opaque string form of this revision (round-trippable via the owning parser). */
  toString(): string;

  /** True if the string form is lexicographically byte-sortable in revision order. */
  readonly byteSortable: boolean;

  /** Orders this revision against another; `undefined` sorts before every revision. */
  compareTo(other: IRevision | undefined): number;

  /** Value equality against another revision. */
  equals(other: IRevision | undefined): boolean;

  /**
   * True iff this revision is STRICTLY newer than `other`. For totally-ordered revisions (e.g.
   * timestamps) this is just `compareTo(other) > 0`, the default - see `defaultGreaterThan`.
   * Revisions with a partial order (e.g. Postgres snapshots, which can be CONCURRENT /
   * incomparable) MUST implement this so concurrent revisions return false - otherwise a
   * `compareTo > 0` tiebreak would wrongly treat a concurrent revision as strictly newer,
   * breaking read-your-writes and revision-window checks. Mirrors SpiceDB's
   * `Revision.GreaterThan`.
   */
  greaterThan(other: IRevision | undefined): boolean;
}

/**
 * The default `GreaterThan` body from the C# interface: strictly newer is `compareTo(other) > 0`.
 * A totally-ordered implementation calls this; a partially-ordered one calls it only after
 * ruling out concurrency.
 */
export function defaultGreaterThan(self: IRevision, other: IRevision | undefined): boolean {
  return self.compareTo(other) > 0;
}
