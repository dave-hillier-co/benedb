import { createHash } from "node:crypto";

import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { IRevision } from "@benedb/core/i-revision";
import { validateRelationship, type Relationship } from "@benedb/core/relationship";
import type { RelationshipUpdate } from "@benedb/core/relationship-update";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { formatRelationship } from "@benedb/core/tuple-strings";

import type { RegisteredCounter } from "./counters";
import {
  CounterAlreadyRegisteredException,
  CounterNotRegisteredException,
  CreateRelationshipExistsException,
} from "./datastore-exceptions";
import {
  counterFilterAt,
  liveAt,
  liveCountersAt,
  schemaAt,
  type CounterVersion,
  type DatastoreState,
  type SchemaVersion,
  type StoredRelationship,
} from "./datastore-state";
import type { DeleteRelationshipsResult, IReadWriteTransaction } from "./i-datastore";
import { relationshipKeyOf, relationshipKeyString, type RelationshipKey } from "./relationship-key";
import {
  relationshipsFilterMatches,
  subjectsFilterMatches,
  type RelationshipsFilter,
  type SubjectsFilter,
} from "./relationships-filter";
import {
  compareReferencesBySubject,
  compareRelationshipsBySubject,
  type ReverseQueryOptions,
} from "./reverse-query-options";

const NANOS_PER_MILLISECOND = 1_000_000n;

/**
 * Wall-clock "now" as nanoseconds since the Unix epoch, to compare against core's
 * `Relationship.optionalExpiration`. A private duplicate of `MvccSnapshotReader`'s, exactly as
 * the C# duplicates its `IsExpired` across the two files.
 */
function nowNanos(): bigint {
  return BigInt(Date.now()) * NANOS_PER_MILLISECOND;
}

/** `exp <= now` - INCLUSIVE: an expiration exactly at the sampled now is expired. */
function isExpired(rel: Relationship, now: bigint): boolean {
  return rel.optionalExpiration !== undefined && rel.optionalExpiration <= now;
}

/** `string.CompareOrdinal`. JS `<` / `>` on strings IS UTF-16 ordinal comparison. */
function compareOrdinal(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The delete-limit truncation order: the full six-tuple identity, RESOURCE FIRST. Deliberately a
 * DIFFERENT order from `compareReferencesBySubject` (which is subject-first); the two must not
 * share one function.
 */
function compareKeys(a: RelationshipKey, b: RelationshipKey): number {
  let c: number;
  if ((c = compareOrdinal(a.resourceType, b.resourceType)) !== 0) return c;
  if ((c = compareOrdinal(a.resourceId, b.resourceId)) !== 0) return c;
  if ((c = compareOrdinal(a.resourceRelation, b.resourceRelation)) !== 0) return c;
  if ((c = compareOrdinal(a.subjectType, b.subjectType)) !== 0) return c;
  if ((c = compareOrdinal(a.subjectId, b.subjectId)) !== 0) return c;
  return compareOrdinal(a.subjectRelation, b.subjectRelation);
}

/**
 * `Convert.ToHexStringLower(SHA256.HashData(bytes))` - LOWERCASE hex, no prefix. This value
 * becomes the schema hash inside ZedTokens and is wire-visible; Node's `digest("hex")` already
 * lowercases. `createHash` (synchronous) rather than WebCrypto's async `subtle.digest`, because
 * `commit` is synchronous.
 */
function computeHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertNever(value: never): never {
  throw new Error(`unreachable update operation: ${JSON.stringify(value)}`);
}

/**
 * A read-write transaction. Reads see prior committed state plus this transaction's own staged
 * mutations. On successful completion the datastore atomically commits the resulting state.
 *
 * The C# is `internal sealed`; TypeScript has no friend-assembly grant, so it is exported
 * normally. Nothing but `ReferenceDatastore` should construct one.
 *
 * The C# keys `Dictionary<RelationshipKey, Relationship>` and two `HashSet<RelationshipKey>` by
 * record value equality. A `Map`/`Set` keys by REFERENCE, so all three are keyed by the canonical
 * `relationshipKeyString` here - and `live` keeps the RELATIONSHIP as its value, from which
 * `commit` and the delete-limit sort recover the structured key via `relationshipKeyOf`.
 */
export class MvccReadWriteTransaction implements IReadWriteTransaction {
  private readonly baseState: DatastoreState;
  private readonly newRevisionNanos: bigint;

  // Live relationships keyed by identity, as visible inside this transaction.
  private readonly live = new Map<string, Relationship>();
  // Identity keys that existed in the base state and have been deleted in this transaction.
  private readonly deleted = new Set<string>();
  // Identity keys created (not previously present) within this transaction.
  private readonly created = new Set<string>();

  private pendingSchema: Uint8Array | undefined = undefined;

  // Staged counter mutations: name -> filter to register; names to tombstone.
  private readonly pendingCounterWrites = new Map<string, RelationshipsFilter>();
  private readonly pendingCounterDeletes = new Set<string>();

  constructor(baseState: DatastoreState, newRevision: bigint) {
    this.baseState = baseState;
    this.newRevisionNanos = newRevision;
    for (const rel of liveAt(baseState, baseState.headRevision))
      this.live.set(relationshipKeyString(relationshipKeyOf(rel)), rel);
  }

  /**
   * @inheritdoc
   *
   * Allocates a FRESH `TimestampRevision` on every access, as the C# `new TimestampRevision(...)`
   * property does; call sites must compare it with `.equals`, never by identity.
   */
  get newRevision(): IRevision {
    return new TimestampRevision(this.newRevisionNanos);
  }

  /** @inheritdoc - always true for a transaction. */
  get isValid(): boolean {
    return true;
  }

  /** @inheritdoc */
  writeRelationships(
    mutations: readonly RelationshipUpdate[],
    signal?: AbortSignal | undefined,
  ): Promise<void> {
    for (const update of mutations) {
      signal?.throwIfAborted();
      const rel = update.relationship;
      validateRelationship(rel);
      const key = relationshipKeyString(relationshipKeyOf(rel));

      switch (update.operation) {
        case "create":
          if (this.live.has(key))
            // `rel.ToString()` is the wire-visible tuple string.
            throw new CreateRelationshipExistsException(formatRelationship(rel));
          this.apply(key, rel);
          break;
        case "touch":
          this.apply(key, rel);
          break;
        case "delete":
          this.remove(key);
          break;
        default:
          // The C# switch has no default arm; the union is closed, so this is unreachable.
          assertNever(update.operation);
      }
    }
    return Promise.resolve();
  }

  /** @inheritdoc */
  deleteRelationships(
    filter: RelationshipsFilter,
    limit?: bigint | undefined,
    _signal?: AbortSignal | undefined,
  ): Promise<DeleteRelationshipsResult> {
    // The C# parameter is `ulong? limit`, so a negative value is unrepresentable and
    // `GetRange(0, (int)lim)` is always a valid count. `bigint` is signed, and
    // `slice(0, Number(-1n))` counts from the END rather than throwing -- a negative limit would
    // silently delete `n - |limit|` rows and report the limit as reached. Restore the range
    // invariant the C# type system enforced.
    if (limit !== undefined && limit < 0n)
      throw new InvalidArgumentError("delete limit may not be negative");

    const matched: { readonly keyString: string; readonly key: RelationshipKey }[] = [];
    for (const [keyString, rel] of this.live) {
      if (relationshipsFilterMatches(filter, rel))
        matched.push({ keyString, key: relationshipKeyOf(rel) });
    }

    let reachedLimit = false;
    let toRemove = matched;
    if (limit !== undefined && BigInt(matched.length) > limit) {
      // The subset a truncating limit removes must be a pure function of the MATCHED SET, never of
      // the base state's internal row order: the thin-sequencer write path assembles its base from
      // per-key shard states (whose concatenation order differs from the reference model's
      // insertion order), and the fold-equivalence gates require both backends to delete the SAME
      // rows. Order canonically by the full six-tuple identity before truncating. When the limit
      // is not reached every match dies, so ordering is irrelevant and skipped.
      //
      // (.NET `Dictionary` enumeration order is unspecified and disturbed by removals while a JS
      // `Map` is insertion-ordered and stable across removals - a benign divergence, and exactly
      // why this sort exists.)
      matched.sort((a, b) => compareKeys(a.key, b.key));
      // `limit` is a bigint, so the length comparison above is a bigint comparison; `Number` is
      // used only for the slice, where the value is provably below `matched.length`.
      toRemove = matched.slice(0, Number(limit));
      reachedLimit = true;
    }

    for (const entry of toRemove) this.remove(entry.keyString);

    return Promise.resolve({ count: BigInt(toRemove.length), reachedLimit });
  }

  /** @inheritdoc */
  writeStoredSchema(schemaBytes: Uint8Array, _signal?: AbortSignal | undefined): Promise<void> {
    this.pendingSchema = schemaBytes;
    return Promise.resolve();
  }

  /** @inheritdoc */
  async bulkLoad(
    relationships: AsyncIterable<Relationship>,
    signal?: AbortSignal | undefined,
  ): Promise<bigint> {
    let count = 0n;
    for await (const rel of relationships) {
      // The C# is `relationships.WithCancellation(cancellationToken)`. `AsyncIterable` has no
      // signal channel, so the check moves into the loop body -- an abort mid-load stops it.
      signal?.throwIfAborted();
      validateRelationship(rel);
      const key = relationshipKeyString(relationshipKeyOf(rel));
      this.apply(key, rel);
      count++;
    }
    return count;
  }

  // --- Reads (snapshot = prior committed state + staged mutations) ---

  /** @inheritdoc */
  async *queryRelationships(
    filter: RelationshipsFilter,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship> {
    const now = nowNanos();
    for (const rel of this.live.values()) {
      signal?.throwIfAborted();
      if (isExpired(rel, now)) continue;
      if (relationshipsFilterMatches(filter, rel)) yield rel;
    }
  }

  /** @inheritdoc */
  async *reverseQueryRelationships(
    subjectsFilter: SubjectsFilter,
    options?: ReverseQueryOptions | undefined,
    signal?: AbortSignal | undefined,
  ): AsyncIterable<Relationship> {
    const now = nowNanos();

    if (options === undefined || options.sort === undefined || options.sort === "unsorted") {
      for (const rel of this.live.values()) {
        signal?.throwIfAborted();
        if (isExpired(rel, now)) continue;
        if (subjectsFilterMatches(subjectsFilter, rel)) yield rel;
      }
      return;
    }

    const matches: Relationship[] = [];
    for (const rel of this.live.values()) {
      signal?.throwIfAborted();
      if (isExpired(rel, now)) continue;
      if (subjectsFilterMatches(subjectsFilter, rel)) matches.push(rel);
    }

    matches.sort(compareRelationshipsBySubject);
    for (const rel of matches) {
      signal?.throwIfAborted();
      const after = options.after;
      if (after !== undefined && compareReferencesBySubject(rel.reference, after) <= 0) continue;
      yield rel;
    }
  }

  /** @inheritdoc */
  readStoredSchema(_signal?: AbortSignal | undefined): Promise<Uint8Array | undefined> {
    return Promise.resolve(
      this.pendingSchema ?? schemaAt(this.baseState, this.baseState.headRevision),
    );
  }

  // --- Counter reads / mutations (snapshot = base committed + staged ops) ---

  /** @inheritdoc */
  readCounterFilter(
    name: string,
    _signal?: AbortSignal | undefined,
  ): Promise<RelationshipsFilter | undefined> {
    return Promise.resolve(this.counterFilterNow(name));
  }

  /** @inheritdoc */
  async countRelationships(name: string, signal?: AbortSignal | undefined): Promise<bigint> {
    const filter = this.counterFilterNow(name);
    if (filter === undefined) throw new CounterNotRegisteredException(name);
    let count = 0n;
    for await (const _ of this.queryRelationships(filter, signal)) count++;
    return count;
  }

  /**
   * @inheritdoc
   *
   * The C# iterates a `HashSet<string>` in unspecified .NET order while a JS `Set` is
   * insertion-ordered: a benign divergence, and no test may assert this order.
   */
  async *lookupCounters(signal?: AbortSignal | undefined): AsyncIterable<RegisteredCounter> {
    const names = new Set<string>();
    for (const counter of liveCountersAt(this.baseState, this.baseState.headRevision))
      names.add(counter.name);
    for (const name of this.pendingCounterWrites.keys()) names.add(name);

    for (const name of names) {
      signal?.throwIfAborted();
      const filter = this.counterFilterNow(name);
      if (filter !== undefined) yield { name, filter };
    }
  }

  /** @inheritdoc */
  writeCounter(
    name: string,
    filter: RelationshipsFilter,
    _signal?: AbortSignal | undefined,
  ): Promise<void> {
    if (this.counterFilterNow(name) !== undefined)
      throw new CounterAlreadyRegisteredException(name);
    this.pendingCounterDeletes.delete(name);
    this.pendingCounterWrites.set(name, filter);
    return Promise.resolve();
  }

  /** @inheritdoc */
  deleteCounter(name: string, _signal?: AbortSignal | undefined): Promise<void> {
    if (this.counterFilterNow(name) === undefined) throw new CounterNotRegisteredException(name);
    this.pendingCounterWrites.delete(name);
    this.pendingCounterDeletes.add(name);
    return Promise.resolve();
  }

  /** Resolves the counter filter as visible inside this transaction (base committed + staged). */
  private counterFilterNow(name: string): RelationshipsFilter | undefined {
    const staged = this.pendingCounterWrites.get(name);
    if (staged !== undefined) return staged;
    if (this.pendingCounterDeletes.has(name)) return undefined;
    return counterFilterAt(this.baseState, name, this.baseState.headRevision);
  }

  // --- Commit ---

  /** Produces the committed state by applying staged mutations to the base state. */
  commit(): DatastoreState {
    let relationships = this.baseState.relationships;

    // Close out deleted base rows. The C# `builder[i] = row with { DeletedRevision = ... }` writes
    // back a COPY into a COPIED array: the base array is shared with live snapshot readers and
    // must never be mutated in place. Only copy when there is something to close, as the C# does.
    if (this.deleted.size > 0) {
      const builder: StoredRelationship[] = [...relationships];
      for (let i = 0; i < builder.length; i++) {
        const row = builder[i]!;
        if (
          row.deletedRevision === undefined &&
          this.deleted.has(relationshipKeyString(relationshipKeyOf(row.relationship)))
        )
          builder[i] = { ...row, deletedRevision: this.newRevisionNanos };
      }
      relationships = builder;
    }

    // Append created / touched rows. A touch on an existing live row closes the old and adds new.
    const additions: StoredRelationship[] = [];
    for (const key of this.created) {
      const rel = this.live.get(key);
      if (rel !== undefined)
        additions.push({ relationship: rel, createdRevision: this.newRevisionNanos });
    }

    if (additions.length > 0) relationships = [...relationships, ...additions];

    let schemas: readonly SchemaVersion[] = this.baseState.schemas;
    if (this.pendingSchema !== undefined)
      schemas = [
        ...schemas,
        {
          revision: this.newRevisionNanos,
          bytes: this.pendingSchema,
          hash: computeHash(this.pendingSchema),
        },
      ];

    let counters: readonly CounterVersion[] = this.baseState.counters;
    for (const [name, filter] of this.pendingCounterWrites)
      counters = [...counters, { revision: this.newRevisionNanos, name, filter }];
    for (const name of this.pendingCounterDeletes)
      counters = [...counters, { revision: this.newRevisionNanos, name, filter: undefined }];

    // Carry the base state's GC floor forward: a regular commit never collects anything (only a GC
    // LogEvent does, via `collectBelow`), so the floor must survive unchanged here - otherwise
    // every write would silently reset it to 0 and re-admit reads below the real floor.
    return {
      headRevision: this.newRevisionNanos,
      relationships,
      schemas,
      counters,
      gcFloor: this.baseState.gcFloor,
    };
  }

  private apply(key: string, rel: Relationship): void {
    const existedInBase = !this.created.has(key) && this.baseHas(key);
    if (existedInBase) {
      // Touch over a base row: mark base row deleted and re-create with new payload. The key lands
      // in BOTH sets, deliberately.
      this.deleted.add(key);
      this.created.add(key);
    } else {
      this.created.add(key);
    }
    this.live.set(key, rel);
  }

  private remove(key: string): void {
    // A SILENT NO-OP when the key was not live - not an error.
    if (!this.live.delete(key)) return;
    if (this.created.delete(key)) {
      // Was created in this transaction; if it also shadowed a base row, that base row deletion stands.
    }
    if (this.baseHas(key)) this.deleted.add(key);
  }

  /**
   * An O(n) linear scan of every base row, on every `apply`/`remove`. Deliberately NOT indexed
   * into a `Map`: this is the reference model, and a divergence in it costs more than the scan.
   */
  private baseHas(key: string): boolean {
    for (const row of this.baseState.relationships) {
      if (
        row.deletedRevision === undefined &&
        relationshipKeyString(relationshipKeyOf(row.relationship)) === key
      )
        return true;
    }
    return false;
  }
}
