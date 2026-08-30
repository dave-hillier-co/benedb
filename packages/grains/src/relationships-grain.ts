import { FULLY_CONSISTENT } from "@spacedb/core/consistency-requirement";
import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import {
  CounterAlreadyRegisteredException,
  CounterNotRegisteredException,
  CreateRelationshipExistsException,
  SerializationException,
} from "@spacedb/datastore/datastore-exceptions";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import type {
  RelationshipsFilter,
  SubjectRelationFilter,
  SubjectsSelector,
} from "@spacedb/datastore/relationships-filter";
import { resolveRevision } from "@spacedb/datastore/revision-resolver";
import { SchemaTypeException } from "@spacedb/engine/schema-type-exception";
import { validateSchemaTypes } from "@spacedb/engine/schema-type-validator";
import type { CompiledSchema } from "@spacedb/schema/compiled-schema";
import { SchemaCompileException } from "@spacedb/schema/schema-compile-exception";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import { grain } from "@thresh/core/decorators";
import { Grain } from "@thresh/core/grain";

import type {
  CommitFailureWire,
  CommitPreconditionWire,
  CommitReply,
  CommitRequest,
} from "./commit-contract";
import type { CounterDeltaWire } from "./log-event";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import type { IRelationshipsGrain } from "./i-relationships-grain";
import type { ISchemaProvider } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import type { ISnapshotScanner } from "./i-snapshot-scanner";
import type { LogWatchHub } from "./log-watch-hub";
import { PreconditionFailedException } from "./precondition-failed-exception";
import { tryParsePreconditionFailure } from "./precondition-messages";
import type {
  BulkImportRelationshipsArgs,
  BulkImportRelationshipsReply,
  CountRelationshipsArgs,
  CountRelationshipsReply,
  DeleteRelationshipsArgs,
  DeleteRelationshipsReply,
  PreconditionWire,
  ReadSchemaReply,
  RegisterCounterArgs,
  RegisterCounterReply,
  RelationshipUpdateWire,
  RelationshipsFilterWire,
  UnregisterCounterArgs,
  UnregisterCounterReply,
  WriteRelationshipsArgs,
  WriteRelationshipsReply,
  WriteSchemaArgs,
  WriteSchemaReply,
} from "./relationships-dtos";
import {
  CounterOperationException,
  REGISTER_COUNTER_REPLY,
  UNREGISTER_COUNTER_REPLY,
} from "./relationships-dtos";
import { computeChecks, evaluateWithScanner } from "./schema-change-validator";
import { SchemaWriteValidationException } from "./schema-write-validation-exception";
import type { SequencerAdmission } from "./sequencer-admission";
import { toFullFilter } from "./wire-convert";
import { WriteConflictException } from "./write-conflict-exception";

/**
 * The C# primary-constructor parameters. Thresh has no constructor DI, so they become an explicit
 * options bag supplied through a `GrainActivator` - the same shape `CheckGrain`, `DatastoreGrain`,
 * `MembershipWalkGrain` and `SubjectFrontierGrain` already use.
 */
export interface RelationshipsGrainOptions {
  readonly datastore: IDatastore;
  readonly schemaProvider: ISchemaProvider;
  readonly schemaSource: ISchemaSource;
  readonly scanner: ISnapshotScanner;
  readonly hub: LogWatchHub;
  readonly admission: SequencerAdmission;
}

/**
 * Bound on schema-write validate-and-commit retries (a retry happens only when the schema hash or
 * the guarded data moved under the validation - both grain-detected races) AND on the declarative
 * commit paths' `headMoved` retries ({@link RelationshipsGrain.commitDeclarative}). Mirrors the
 * compatibility write path's CAS bound (`GrainBackedDatastore` `MAX_CAS_ATTEMPTS`); on exhaustion
 * the same retryable serialization conflict surfaces.
 */
const MAX_COMMIT_ATTEMPTS = 50;

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/RelationshipsGrain.cs`.
 *
 * Stateless-worker implementation of `IRelationshipsGrain`: the data-plane write side. Schema
 * writes compile-and-swap the live `ISchemaProvider` and persist to the datastore; relationship
 * writes/deletes are DECLARATIVE commits executed inside the sequencer grain
 * (`IDatastoreGrain.commit` - one hop, no client retry loop, the single-threaded activation is the
 * serialization point); reads pin the optimized revision. Replies carry opaque revision tokens
 * minted by `zedTokenFromRevision`.
 *
 * The grain is `[StatelessWorker]` so the silo scales activations with load; it carries no per-key
 * identity, so callers always use `RELATIONSHIPS_GRAIN_KEY`. Commit rejections arrive as STRUCTURED
 * REPLY DATA (`CommitReply.failure`), and this grain rethrows exactly the typed exceptions the
 * inline write path historically threw - same types, same messages - so every gRPC status mapping
 * in the front door is preserved unchanged.
 *
 * PORT NOTES.
 *  - `[StatelessWorker]` -> `@grain({ stateless: true })`. It is a GRAIN-side option, never an
 *    interface option.
 *  - `ArgumentException` -> `InvalidArgumentError` (gRPC InvalidArgument). `InvalidOperationException`
 *    has no single stand-in in this port, so the two loud throws are plain `Error`s whose MESSAGE
 *    carries the diagnosis; both are unreachable-by-design paths rather than a typed contract.
 *  - `using var slot = admission.Enter()` -> an explicit `slot.dispose()` in a `finally`.
 *  - `ConfigureAwait(ContinueOnCapturedContext)` maps to nothing: there is no synchronization
 *    context to keep.
 */
@grain({ stateless: true })
export class RelationshipsGrain extends Grain implements IRelationshipsGrain {
  readonly #deps: RelationshipsGrainOptions | undefined;

  /**
   * The C# takes its six collaborators as REQUIRED primary-constructor parameters, resolved by the
   * DI container. Thresh types every grain constructor as zero-argument (the activator supplies
   * the instance), so the bag is optional here and its absence is reported at first use.
   */
  constructor(options?: RelationshipsGrainOptions) {
    super();
    this.#deps = options;
  }

  get #require(): RelationshipsGrainOptions {
    if (this.#deps === undefined) {
      throw new InvalidArgumentError(
        "RelationshipsGrain requires its collaborators; supply them through a GrainActivator",
      );
    }
    return this.#deps;
  }

  /** The cluster-singleton sequencer grain every declarative commit executes inside. */
  get #sequencer(): IDatastoreGrain {
    return this.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
  }

  /**
   * Submits one commit to the sequencer through the per-silo admission gate: a slot is held only
   * for the duration of the grain call (each retry attempt re-enters, so a retry storm is shed like
   * any other offered load). A full gate throws `SequencerOverloadedException` - the write is shed
   * before it can join the sequencer's activation queue.
   */
  async #submitCommit(request: CommitRequest): Promise<CommitReply> {
    const slot = this.#require.admission.enter();
    try {
      return await this.#sequencer.commit(request);
    } finally {
      slot.dispose();
    }
  }

  /** @inheritdoc */
  async writeSchema(args: WriteSchemaArgs): Promise<WriteSchemaReply> {
    // `ArgumentNullException.ThrowIfNull(args);`
    if (args === undefined || args === null) {
      throw new InvalidArgumentError("args is required");
    }
    const { datastore, schemaProvider, schemaSource, scanner, hub } = this.#require;

    // Compile the proposed schema FIRST, but do NOT swap yet. A compile failure is surfaced as an
    // InvalidArgumentError carrying the original message, so the gRPC layer maps it to
    // InvalidArgument.
    let nextCompiled: CompiledSchema;
    try {
      nextCompiled = compileSchema(args.schemaText);
    } catch (ex) {
      if (ex instanceof SchemaCompileException) throw new InvalidArgumentError(ex.message);
      throw ex;
    }

    // SpiceDB's type-system + caveat-definition validation on the freshly compiled schema BEFORE
    // touching the datastore. A type error is rejected at write time as a FailedPrecondition.
    try {
      validateSchemaTypes(nextCompiled);
    } catch (ex) {
      if (ex instanceof SchemaTypeException) throw new SchemaWriteValidationException(ex.message);
      throw ex;
    }

    const schemaBytes = new TextEncoder().encode(args.schemaText);

    // Validate-and-commit loop. The change validation (compile + diff) stays CLIENT-SIDE against a
    // pinned snapshot - it produces the descriptive SchemaWriteValidationException messages - while
    // its data-existence guards ALSO ride the commit as MUST_NOT_MATCH preconditions, and the
    // commit carries expectedSchemaHash (the stored-schema hash the diff base was read at). The
    // sequencer therefore re-proves, atomically at the commit snapshot, both that no other schema
    // landed (schemaHashMoved) and that no conflicting data landed (preconditionFailed) since
    // validation; either race re-runs the whole loop against a fresh base.
    for (let attempt = 0; ; attempt++) {
      // Pin the validation base: the head revision and the stored-schema hash effective at it.
      const head = await datastore.headRevision();

      // The CURRENT schema for the diff must be the one the pinned hash represents, so the gate and
      // the validation can never disagree: compile the stored bytes at the pinned revision, read
      // through the ISchemaSource seam. Pre-first-schema falls back to the host-seeded live
      // snapshot; the gate then expects the empty hash (which is what an absent stored hash
      // matches).
      const storedBytes = await schemaSource.readSchemaAt(head.revision);
      let current: CompiledSchema;
      if (storedBytes === undefined) {
        current = schemaProvider.current.schema;
      } else {
        // This compile is of the STORED schema (the diff base), never the caller's input: those
        // bytes were validated when written, so a compile failure here is server-side corruption.
        // It must surface as a loud Internal failure - the InvalidArgumentError at the top of this
        // method is reserved for the caller's NEW schema, and blaming the caller for a corrupt
        // stored schema would be wrong.
        try {
          current = compileSchema(new TextDecoder().decode(storedBytes));
        } catch (ex) {
          const message = ex instanceof Error ? ex.message : String(ex);
          throw new Error(
            "stored schema failed to compile; the persisted schema at the pinned revision is " +
              `corrupt: ${message}`,
            { cause: ex },
          );
        }
      }

      const checks = computeChecks(current, nextCompiled);
      await evaluateWithScanner(checks, scanner, head.revision);

      const preconditions: CommitPreconditionWire[] = checks
        .filter((c) => c.kind === "noOrphans")
        .map((c) => ({ filter: toFullFilter(c.filter), mustMatch: false }));

      const reply = await this.#submitCommit({
        preconditions,
        updates: [],
        deleteByFilter: undefined,
        schemaBytes,
        // `head.SchemaHash ?? string.Empty` - the sequencer's gate treats an ABSENT current hash as
        // matching only an EMPTY expected hash, so the house `undefined` preference must not smooth
        // this away.
        expectedSchemaHash: head.schemaHash ?? "",
        counterChanges: [],
        expectedHead: undefined,
      });

      if (reply.revision !== undefined) {
        // Same-silo Watch pulse parity with the readWriteTx path: the sequencer's observer push is
        // best-effort, so a local commit wakes this silo's parked Watch streams directly.
        hub.pulse(reply.revision);

        // The persist committed: only now swap the live snapshot, so the datastore and the live
        // schema never diverge and a rejected change leaves the live schema intact.
        const snapshot = schemaProvider.update(args.schemaText);
        const token = await this.#mintToken(
          new TimestampRevision(reply.revision),
          snapshot.schemaHash,
        );
        return { writtenAtToken: token };
      }

      const failure = reply.failure!;
      switch (failure.kind) {
        case "schemaHashMoved":
        case "preconditionFailed":
          // A grain-detected race with another schema/data write: re-validate and retry.
          break;
        case "headMoved":
          // Near-impossible on this path (no expectedHead rides the request) - it exists only for
          // duplicate-activation churn during cluster membership changes. Retryable, like the
          // pre-declarative write loop treated it.
          break;
        default:
          throw new Error(
            `unexpected schema-commit failure ${failure.kind}: ${failure.detail ?? ""}`,
          );
      }

      if (attempt + 1 >= MAX_COMMIT_ATTEMPTS) throw new SerializationException();
    }
  }

  /** @inheritdoc */
  async readSchema(): Promise<ReadSchemaReply> {
    const { datastore, schemaProvider } = this.#require;
    const snapshot = schemaProvider.current;
    const optimized = await datastore.optimizedRevision();
    const token = await this.#mintToken(optimized.revision, snapshot.schemaHash);
    return { schemaText: snapshot.sourceText, readAtToken: token };
  }

  /** @inheritdoc */
  async writeRelationships(args: WriteRelationshipsArgs): Promise<WriteRelationshipsReply> {
    if (args === undefined || args === null) {
      throw new InvalidArgumentError("args is required");
    }

    // One declarative commit: the sequencer evaluates the preconditions against the same snapshot
    // the updates commit at and applies the updates with Create preserved, so a duplicate create is
    // rejected there and nothing commits.
    const reply = await this.#commitDeclarative({
      preconditions: toCommitPreconditions(args.preconditions),
      updates: args.updates,
      deleteByFilter: undefined,
      schemaBytes: undefined,
      expectedSchemaHash: undefined,
      counterChanges: [],
      expectedHead: undefined,
    });

    if (reply.failure !== undefined) throw relationshipWriteFailure(reply.failure);

    const token = await this.#mintToken(
      new TimestampRevision(reply.revision!),
      this.#require.schemaProvider.current.schemaHash,
    );
    return { writtenAtToken: token };
  }

  /** @inheritdoc */
  async deleteRelationships(args: DeleteRelationshipsArgs): Promise<DeleteRelationshipsReply> {
    if (args === undefined || args === null) {
      throw new InvalidArgumentError("args is required");
    }

    const reply = await this.#commitDeclarative({
      preconditions: toCommitPreconditions(args.preconditions),
      updates: [],
      deleteByFilter: {
        filter: toFullFilter(toFilter(args.filter)),
        limit: args.optionalLimit,
      },
      schemaBytes: undefined,
      expectedSchemaHash: undefined,
      counterChanges: [],
      expectedHead: undefined,
    });

    if (reply.failure !== undefined) throw relationshipWriteFailure(reply.failure);

    const token = await this.#mintToken(
      new TimestampRevision(reply.revision!),
      this.#require.schemaProvider.current.schemaHash,
    );
    return {
      deletedCount: reply.deletedCount,
      reachedLimit: reply.reachedLimit,
      deletedAtToken: token,
    };
  }

  /** @inheritdoc */
  async bulkImportRelationships(
    args: BulkImportRelationshipsArgs,
  ): Promise<BulkImportRelationshipsReply> {
    if (args === undefined || args === null) {
      throw new InvalidArgumentError("args is required");
    }

    // CREATE semantics per row, matching real SpiceDB's ImportBulkRelationships (observed v1.49.2):
    // a row that already exists in the store, or appears twice in the import, rejects the whole
    // import with the CREATE-conflict failure - never a silent upsert. The entire import loads in
    // ONE declarative commit, so a rejected import applies nothing.
    const updates: RelationshipUpdateWire[] = args.relationships.map((r) => ({
      operation: "create",
      relationship: r,
    }));

    const reply = await this.#commitDeclarative({
      preconditions: [],
      updates,
      deleteByFilter: undefined,
      schemaBytes: undefined,
      expectedSchemaHash: undefined,
      counterChanges: [],
      expectedHead: undefined,
    });

    if (reply.failure !== undefined) throw relationshipWriteFailure(reply.failure);

    const token = await this.#mintToken(
      new TimestampRevision(reply.revision!),
      this.#require.schemaProvider.current.schemaHash,
    );
    // `(ulong)updates.Count` -> a bigint on the wire.
    return { numLoaded: BigInt(updates.length), loadedAtToken: token };
  }

  /** @inheritdoc */
  async registerRelationshipCounter(args: RegisterCounterArgs): Promise<RegisterCounterReply> {
    if (args === undefined || args === null) {
      throw new InvalidArgumentError("args is required");
    }

    const reply = await this.#commitDeclarative(
      counterCommit({ name: args.name, filter: toFullFilter(toFilter(args.filter)) }),
    );

    if (reply.failure !== undefined) throw counterFailure(reply.failure);

    return REGISTER_COUNTER_REPLY;
  }

  /** @inheritdoc */
  async unregisterRelationshipCounter(
    args: UnregisterCounterArgs,
  ): Promise<UnregisterCounterReply> {
    if (args === undefined || args === null) {
      throw new InvalidArgumentError("args is required");
    }

    // An ABSENT filter is the unregister tombstone (the guarded deleteCounter op grain-side).
    const reply = await this.#commitDeclarative(
      counterCommit({ name: args.name, filter: undefined }),
    );

    if (reply.failure !== undefined) throw counterFailure(reply.failure);

    return UNREGISTER_COUNTER_REPLY;
  }

  /** @inheritdoc */
  async countRelationships(args: CountRelationshipsArgs): Promise<CountRelationshipsReply> {
    if (args === undefined || args === null) {
      throw new InvalidArgumentError("args is required");
    }
    const { datastore, scanner, schemaProvider } = this.#require;

    // The proto request carries no consistency, so (like SpiceDB's on-demand path, which uses
    // HeadRevision) resolve a fully-consistent revision and count at that pinned snapshot.
    const resolved = await resolveRevision(datastore, FULLY_CONSISTENT);

    let count: bigint;
    try {
      // The count is a broad filter scan at the pinned revision - the storage-direct scan seam's
      // workload, not the shard mesh's.
      count = await scanner.countRelationships(args.name, resolved.revision);
    } catch (ex) {
      if (ex instanceof CounterNotRegisteredException) {
        throw new CounterOperationException("notRegistered", ex.message);
      }
      throw ex;
    }

    const token = await this.#mintToken(
      resolved.revision,
      resolved.schemaHash ?? schemaProvider.current.schemaHash,
    );
    return { count, readAtToken: token };
  }

  // --- declarative commit submission ---

  /**
   * Submits a declarative commit (absent `expectedHead`) with a bounded retry on `headMoved` ONLY;
   * every other outcome (success or failure) returns to the caller for its own mapping. HeadMoved
   * is near-impossible here - a declarative commit carries no head CAS and the sequencer's
   * single-writer, non-reentrant activation cannot lose its own conditional append - and exists
   * only for duplicate-activation churn during cluster membership changes. That is a transient
   * condition the pre-declarative write path retried, so the declarative path stays retryable too:
   * bounded by {@link MAX_COMMIT_ATTEMPTS}, and on exhaustion it throws the same retryable
   * exception the old path surfaced - {@link WriteConflictException} with kind `serialization`,
   * which the gRPC front door maps to Aborted so the client retries the whole transaction.
   */
  async #commitDeclarative(request: CommitRequest): Promise<CommitReply> {
    for (let attempt = 0; ; attempt++) {
      const reply = await this.#submitCommit(request);
      if (reply.failure?.kind !== "headMoved") {
        // Same-silo Watch pulse parity with `GrainBackedDatastore.readWriteTx`: the sequencer's
        // observer push is best-effort, so a successful local commit wakes this silo's parked Watch
        // streams immediately instead of costing up to one heartbeat of latency.
        if (reply.revision !== undefined) this.#require.hub.pulse(reply.revision);
        return reply;
      }

      if (attempt + 1 >= MAX_COMMIT_ATTEMPTS) {
        throw new WriteConflictException("serialization", new SerializationException().message);
      }
    }
  }

  async #mintToken(revision: IRevision, schemaHash: string): Promise<string> {
    const datastoreId = await this.#require.datastore.getUniqueId();
    return zedTokenFromRevision(revision, schemaHash, datastoreId).token;
  }
}

// --- commit failure mapping (reply data -> the exact historical typed exceptions) ---

/**
 * Maps a relationship-write commit rejection back to the exact exception the inline write path
 * threw: a precondition failure rethrows {@link PreconditionFailedException} (kind/index recovered
 * from the shared message text), and a duplicate create rethrows {@link WriteConflictException}
 * with kind `createExisting` carrying the message {@link CreateRelationshipExistsException} DERIVES
 * from the conflicting relationship (the reply detail). `headMoved` never reaches this mapper - the
 * declarative commit retries it - and no other kind can occur on a declarative relationship commit,
 * so anything else is surfaced loudly.
 */
function relationshipWriteFailure(failure: CommitFailureWire): Error {
  switch (failure.kind) {
    case "preconditionFailed":
      return preconditionFailure(failure.detail);
    case "createAlreadyExists":
      return new WriteConflictException(
        "createExisting",
        new CreateRelationshipExistsException(failure.detail ?? "").message,
      );
    default:
      return new Error(
        `unexpected relationship-commit failure ${failure.kind}: ${failure.detail ?? ""}`,
      );
  }
}

function preconditionFailure(detail: string | undefined): PreconditionFailedException {
  const message = detail ?? "";
  // The detail is always a precondition-messages-formatted text (the single shared copy), so the
  // parse recovers the exact kind and index the inline evaluation stamped on the exception.
  const parsed = tryParsePreconditionFailure(message);
  return parsed !== undefined
    ? new PreconditionFailedException(parsed.kind, parsed.index, message)
    : new PreconditionFailedException("mustMatchFoundNone", 0, message);
}

/** A commit carrying exactly one counter register/unregister delta and nothing else. */
function counterCommit(delta: CounterDeltaWire): CommitRequest {
  return {
    preconditions: [],
    updates: [],
    deleteByFilter: undefined,
    schemaBytes: undefined,
    expectedSchemaHash: undefined,
    counterChanges: [delta],
    expectedHead: undefined,
  };
}

/**
 * Maps a counter commit rejection back to the serializable {@link CounterOperationException} the
 * counter RPCs have always thrown, with the message the underlying datastore exception DERIVES from
 * the counter name (the reply detail) - so the gRPC front door's FailedPrecondition mapping and
 * message are byte-identical to the inline path.
 */
function counterFailure(failure: CommitFailureWire): Error {
  switch (failure.kind) {
    case "counterAlreadyRegistered":
      return new CounterOperationException(
        "alreadyRegistered",
        new CounterAlreadyRegisteredException(failure.detail ?? "").message,
      );
    case "counterNotRegistered":
      return new CounterOperationException(
        "notRegistered",
        new CounterNotRegisteredException(failure.detail ?? "").message,
      );
    default:
      return new Error(
        `unexpected counter-commit failure ${failure.kind}: ${failure.detail ?? ""}`,
      );
  }
}

// --- wire conversions ---

/**
 * Converts the RPC-surface preconditions to the commit contract's form: the lossless full filter
 * (round-tripping the same core `RelationshipsFilter` the inline evaluation built via
 * {@link toFilter}) plus the MUST_MATCH/MUST_NOT_MATCH flag.
 */
function toCommitPreconditions(
  preconditions: readonly PreconditionWire[] | undefined,
): readonly CommitPreconditionWire[] {
  if (preconditions === undefined || preconditions.length === 0) return [];

  return preconditions.map((p) => ({
    filter: toFullFilter(toFilter(p.filter)),
    mustMatch: p.operation === "mustMatch",
  }));
}

/**
 * The data-plane filter wire form as a core `RelationshipsFilter`.
 *
 * A subjects selector is created ONLY when the subject type, ids or relation is present AND
 * NON-EMPTY (`{ Length: > 0 }` / `{ Count: > 0 }`). An empty string must NOT produce a selector -
 * that would turn an unconstrained filter into a constrained one and change which rows match.
 */
function toFilter(wire: RelationshipsFilterWire): RelationshipsFilter {
  let selectors: readonly SubjectsSelector[] | undefined = undefined;
  if (
    isNonEmpty(wire.subjectType) ||
    (wire.subjectIds !== undefined && wire.subjectIds.length > 0) ||
    isNonEmpty(wire.subjectRelation)
  ) {
    const relFilter: SubjectRelationFilter | undefined = isNonEmpty(wire.subjectRelation)
      ? { nonEllipsisRelation: wire.subjectRelation }
      : undefined;
    selectors = [
      {
        optionalSubjectType: wire.subjectType,
        optionalSubjectIds: wire.subjectIds,
        relationFilter: relFilter,
      },
    ];
  }

  return {
    optionalResourceType: wire.resourceType,
    optionalResourceIds: wire.resourceIds,
    optionalResourceIdPrefix: wire.resourceIdPrefix,
    optionalResourceRelation: wire.resourceRelation,
    optionalSubjectsSelectors: selectors,
  };
}

/** The C#'s `is { Length: > 0 }`: present and not the empty string. */
function isNonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}
