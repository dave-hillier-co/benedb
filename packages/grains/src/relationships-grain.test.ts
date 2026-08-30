import { FULLY_CONSISTENT } from "@spacedb/core/consistency-requirement";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { IRevisionParser } from "@spacedb/core/i-revision-parser";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import type { RegisteredCounter } from "@spacedb/datastore/counters";
import {
  CounterAlreadyRegisteredException,
  CounterNotRegisteredException,
  CreateRelationshipExistsException,
  SerializationException,
} from "@spacedb/datastore/datastore-exceptions";
import type {
  IDatastore,
  IDatastoreReader,
  RevisionWithSchemaHash,
} from "@spacedb/datastore/i-datastore";
import type { RelationshipsFilter } from "@spacedb/datastore/relationships-filter";
import { grain } from "@thresh/core/decorators";
import { Grain } from "@thresh/core/grain";
import type { GrainFactoryAccess } from "@thresh/hosting/silo-builder";
import { TestCluster } from "@thresh/testing/test-cluster";
import { constructGrain } from "@thresh/runtime/construct-grain";
import { afterEach, describe, expect, it } from "vitest";

import type { CommitFailureKind, CommitReply, CommitRequest } from "./commit-contract";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import type { ISchemaProvider, SchemaSnapshot } from "./i-schema-provider";
import { MutableSchemaProvider } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import type { ISnapshotScanner } from "./i-snapshot-scanner";
import { IRelationshipsGrain, RELATIONSHIPS_GRAIN_KEY } from "./i-relationships-grain";
import { SequencerMetrics } from "./i-sequencer-metrics";
import { LogWatchHub } from "./log-watch-hub";
import { PreconditionFailedException } from "./precondition-failed-exception";
import { mustMatchFailedMessage, mustNotMatchFailedMessage } from "./precondition-messages";
import { CounterOperationException } from "./relationships-dtos";
import type {
  PreconditionWire,
  RelationshipWire,
  RelationshipsFilterWire,
} from "./relationships-dtos";
import { RelationshipsGrain } from "./relationships-grain";
import { SchemaWriteValidationException } from "./schema-write-validation-exception";
import { SequencerAdmission } from "./sequencer-admission";
import { SequencerOverloadedException } from "./sequencer-overloaded-exception";
import { WriteConflictException } from "./write-conflict-exception";

/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/RelationshipsGrain.cs`.
 *
 * NO COVERING C# TEST. In Spiceport this grain is graded from ABOVE - the S5 gRPC service suites
 * and `DataPlaneMeshTests` - and neither is in this stage's scope. Within this stage it is
 * exercised only INDIRECTLY, by every mesh suite that calls `cluster.writeSchema(...)`, which
 * proves the happy path of ONE of its seven methods and nothing else. So this file is a
 * CHARACTERIZATION: it pins the behaviour the C# actually has, and it is the only gate this file
 * will have for some time. It does not claim to be the coverage the S5 suites will bring.
 *
 * The grain runs REAL, inside a single-silo Thresh {@link TestCluster}, against a SCRIPTED
 * `IDatastoreGrain` registered under the singleton key. Scripting the sequencer is not a shortcut:
 * the whole point of the declarative write path is that a rejection arrives as STRUCTURED REPLY
 * DATA and this grain rethrows the exact typed exception the inline write path used to throw. A
 * real `DatastoreGrain` cannot be made to reject on demand, and the rethrow table - not the
 * storage - is what this file exists to protect.
 *
 * A single-silo cluster is also what makes the exception ASSERTIONS meaningful: a same-silo grain
 * call preserves the thrown instance, so `toBeInstanceOf` is checking the real rethrow rather than
 * a message that survived the wire (the same reason `Stage1JournaledWritePathTests` can assert
 * `RevisionNotFoundException` directly).
 *
 * The nine rules that are easy to lose, and what pins each:
 *
 *  1. THREE EXCEPTION TYPES, THREE gRPC CODES. A compile failure of the CALLER'S schema is an
 *     `InvalidArgumentError` (InvalidArgument); a type-system rejection is a
 *     `SchemaWriteValidationException` (FailedPrecondition); a compile failure of the STORED
 *     schema is a plain loud error (Internal) whose message names the corruption. Blaming the
 *     caller for a corrupt stored schema is the specific mistake being guarded against, and
 *     CLAUDE.md's rule applies: a wrong code makes `zed` retry or crash.
 *  2. THE DIFF BASE IS THE STORED SCHEMA AT THE PINNED HEAD, read through `ISchemaSource` - NOT
 *     the live provider snapshot, which only falls back when nothing is stored. A port that
 *     always diffs against `schemaProvider.current` passes every single-writer test and silently
 *     computes the wrong guards the moment another silo wrote the schema.
 *  3. `expectedSchemaHash: head.schemaHash ?? ""`. The sequencer's gate treats an ABSENT current
 *     hash as matching only an EMPTY expected hash, so the house preference for `undefined` must
 *     not smooth this away.
 *  4. RETRY CLASSIFICATION. `schemaHashMoved`, `preconditionFailed` and `headMoved` all re-validate
 *     against a fresh base and retry; ANY other kind throws loudly. Exhaustion at 50 attempts
 *     raises the serialization conflict.
 *  5. PULSE FIRST, SWAP SECOND. `hub.pulse(revision)` precedes `schemaProvider.update(...)`, so a
 *     rejected change leaves the live schema intact and a committed one is never visible before
 *     it is durable. Swapping first is a real divergence bug, so the ORDER is asserted, not just
 *     the fact that both happened.
 *  6. THE MESSAGE ROUND-TRIP. `preconditionFailed` details are parsed back into an exact
 *     `PreconditionFailedException(kind, index, message)`; a detail this port did not produce
 *     falls back to `(mustMatchFoundNone, 0, message)`. `createAlreadyExists` and the two counter
 *     kinds carry a DETAIL from which the message is DERIVED - the detail is never the message.
 *  7. `commitDeclarative` retries `headMoved` ONLY, and on exhaustion throws
 *     `WriteConflictException("serialization", new SerializationException().message)` - the
 *     message byte-identical to the default text, because the front door maps it to Aborted and
 *     the client retries on exactly that.
 *  8. `toFilter` creates a subjects selector ONLY for a non-empty subject constraint. An empty
 *     string must not produce one: that would turn an unconstrained filter into a constrained one
 *     and change which rows match.
 *  9. EVERY commit passes through the admission gate, and each RETRY ATTEMPT RE-ENTERS - so a
 *     retry storm sheds like any other offered load rather than holding one slot for a whole
 *     50-attempt loop.
 *
 * PORT NOTES.
 *  - `[StatelessWorker]` -> `@grain({ stateless: true })` on the implementation. It carries no
 *    per-key identity, so every call here uses `RELATIONSHIPS_GRAIN_KEY`.
 *  - Thresh has no constructor DI: the C# primary-constructor parameters become an explicit
 *    `RelationshipsGrainOptions` bag supplied through a `GrainActivator`, the same shape
 *    `CheckGrain`, `MembershipWalkGrain` and `SubjectFrontierGrain` already use.
 *  - `ArgumentException` -> `InvalidArgumentError`; `InvalidOperationException` has no single
 *    stand-in in this port, so the two loud throws are plain `Error`s whose MESSAGE is asserted
 *    (they are unreachable-by-design paths, not a typed contract).
 *  - `using var slot = admission.Enter()` -> an explicit `slot.dispose()` in a `finally`.
 */

// --- schemas ----------------------------------------------------------------------------------

const SEED_SCHEMA = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

/** The seed plus one extra relation: a pure ADDITION, so the diff carries no orphan guard. */
const SCHEMA_WITH_EDITOR = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;

/** The seed MINUS `viewer`: a removal, so the diff carries the orphan guards. */
const SCHEMA_WITHOUT_VIEWER = `definition user {}

definition document {
    relation editor: user
    permission view = editor
}`;

// --- the scripted sequencer -------------------------------------------------------------------

interface Script {
  /** Every commit the grain submitted, in order. */
  readonly commits: CommitRequest[];
  /** Replies handed back in order; the LAST entry repeats forever. */
  replies: CommitReply[];
}

let script: Script = { commits: [], replies: [] };

function resetScript(): void {
  script = { commits: [], replies: [] };
}

/** A successful commit reply at `revision`. */
function ok(revision: bigint, deletedCount = 0n, reachedLimit = false): CommitReply {
  return { revision, deletedCount, reachedLimit };
}

/** A rejected commit reply. */
function rejected(kind: CommitFailureKind, detail?: string): CommitReply {
  return {
    failure: { kind, ...(detail !== undefined ? { detail } : {}) },
    deletedCount: 0n,
    reachedLimit: false,
  };
}

/**
 * The scripted stand-in for the cluster-singleton sequencer. Only `commit` is implemented: every
 * other `IDatastoreGrain` member is deliberately absent, so a port that reaches the sequencer for
 * anything else from this grain (a head probe instead of `IDatastore.headRevision`, say) fails
 * loudly here rather than passing with the wrong design.
 */
@grain()
class ScriptedSequencerGrain extends Grain {
  async commit(request: CommitRequest): Promise<CommitReply> {
    script.commits.push(request);
    const next = script.replies.length > 1 ? script.replies.shift()! : script.replies[0];
    if (next === undefined) throw new Error("scripted sequencer: no reply queued");
    return next;
  }
}

// --- fakes ------------------------------------------------------------------------------------

const DATASTORE_ID = "ds-unique-id";

/**
 * The three `IDatastore` members this grain touches: `headRevision` (the pinned validation base),
 * `optimizedRevision` (`readSchema`) and `getUniqueId` (token minting). Every other member throws,
 * for the same reason the scripted sequencer omits its unused members.
 */
class FakeDatastore implements IDatastore {
  head: RevisionWithSchemaHash = { revision: new TimestampRevision(1_000n), schemaHash: "hash-1" };
  optimized: RevisionWithSchemaHash = {
    revision: new TimestampRevision(900n),
    schemaHash: "hash-1",
  };

  readonly headCalls: RevisionWithSchemaHash[] = [];

  headRevision(): Promise<RevisionWithSchemaHash> {
    this.headCalls.push(this.head);
    return Promise.resolve(this.head);
  }

  optimizedRevision(): Promise<RevisionWithSchemaHash> {
    return Promise.resolve(this.optimized);
  }

  getUniqueId(): Promise<string> {
    return Promise.resolve(DATASTORE_ID);
  }

  snapshotReader(): IDatastoreReader {
    throw new Error("not reached");
  }
  readWriteTx(): Promise<IRevision> {
    throw new Error("not reached");
  }
  checkRevision(): Promise<boolean> {
    throw new Error("not reached");
  }
  watch(): AsyncIterable<never> {
    throw new Error("not reached");
  }
  /**
   * REACHED, unlike the members below it: `resolveRevision` fetches the parser BEFORE it switches
   * on the requirement (the C# `RevisionResolver.Resolve` does exactly the same), so
   * `countRelationships`' FullyConsistent resolve passes through here on its way to `headRevision`.
   */
  getRevisionParser(): Promise<IRevisionParser> {
    return Promise.resolve({
      datastoreUniqueId: DATASTORE_ID,
      parseRevisionString: (revisionString: string) =>
        new TimestampRevision(BigInt(revisionString)),
    });
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** `ISchemaSource` over a scriptable stored-schema answer. */
class FakeSchemaSource implements ISchemaSource {
  stored: Uint8Array | undefined;
  readonly readAt: IRevision[] = [];

  readSchemaAt(revision: IRevision): Promise<Uint8Array | undefined> {
    this.readAt.push(revision);
    return Promise.resolve(this.stored);
  }
}

/**
 * `ISnapshotScanner` for the two things this grain asks of it: the schema-change guards' existence
 * scans (empty unless a case stocks `rows`) and the on-demand counter count.
 */
class FakeScanner implements ISnapshotScanner {
  rows: Relationship[] = [];
  count: bigint | Error = 0n;
  readonly countCalls: Array<{ name: string; revision: IRevision }> = [];

  async *scan(): AsyncIterable<Relationship> {
    for (const row of this.rows) yield row;
  }

  countRelationships(counterName: string, revision: IRevision): Promise<bigint> {
    this.countCalls.push({ name: counterName, revision });
    if (this.count instanceof Error) return Promise.reject(this.count);
    return Promise.resolve(this.count);
  }

  readCounterFilter(): Promise<RelationshipsFilter | undefined> {
    throw new Error("not reached");
  }

  // eslint-disable-next-line require-yield
  async *lookupCounters(): AsyncIterable<RegisteredCounter> {
    throw new Error("not reached");
  }
}

/**
 * The one ordered log the pulse-then-swap gate reads. The hub and the provider both append to it,
 * so rule 5 is asserted as an ORDER, not as two independent facts.
 */
const trace: string[] = [];

/** A `LogWatchHub` whose `pulse` is recorded. Subclassed rather than faked so the type stays honest. */
class RecordingHub extends LogWatchHub {
  readonly pulses: bigint[] = [];

  override pulse(head: bigint): void {
    this.pulses.push(head);
    trace.push(`pulse:${head}`);
  }
}

/** An `ISchemaProvider` decorator recording every swap, delegating to the real provider. */
class RecordingSchemaProvider implements ISchemaProvider {
  readonly updates: string[] = [];

  constructor(private readonly inner: MutableSchemaProvider) {}

  get current(): SchemaSnapshot {
    return this.inner.current;
  }

  update(schemaText: string): SchemaSnapshot {
    this.updates.push(schemaText);
    trace.push("update");
    return this.inner.update(schemaText);
  }
}

// --- fixture ----------------------------------------------------------------------------------

interface Fixture {
  readonly cluster: TestCluster;
  readonly datastore: FakeDatastore;
  readonly schemaSource: FakeSchemaSource;
  readonly scanner: FakeScanner;
  readonly hub: RecordingHub;
  readonly provider: RecordingSchemaProvider;
  readonly metrics: SequencerMetrics;
}

let fixture: Fixture | undefined;

/**
 * `grainFactory` for the hub. The hub is never STARTED in this file (nothing here opens a Watch
 * stream), so the observer members throw rather than pretending - the same stance
 * `Stage1JournaledWritePathTests` takes.
 */
function hubFactory(cluster: TestCluster): GrainFactoryAccess {
  return {
    getGrain(def, key) {
      return cluster.primary.host.getGrain(def, key);
    },
    createObjectReference<T>(): T {
      throw new Error("the watch hub is never started by these gates");
    },
    deleteObjectReference(): void {
      throw new Error("the watch hub is never started by these gates");
    },
  };
}

async function start(options: { maxInFlightCommits?: number } = {}): Promise<Fixture> {
  resetScript();
  trace.length = 0;

  const datastore = new FakeDatastore();
  const schemaSource = new FakeSchemaSource();
  const scanner = new FakeScanner();
  const provider = new RecordingSchemaProvider(new MutableSchemaProvider(SEED_SCHEMA));
  const metrics = new SequencerMetrics();
  const admission = new SequencerAdmission(
    options.maxInFlightCommits !== undefined
      ? { maxInFlightCommits: options.maxInFlightCommits }
      : {},
    metrics,
  );

  // A holder rather than a `let`: the activator closure reads the hub BEFORE it is assigned (the
  // hub needs the cluster's grain factory, which the cluster needs the activator to build), and a
  // single-assignment `let` read before assignment is exactly what `prefer-const` rejects.
  const hubRef: { current: RecordingHub | undefined } = { current: undefined };
  const cluster = await TestCluster.start({
    initialSilos: 1,
    grains: [
      { ctor: RelationshipsGrain, interfaces: [IRelationshipsGrain] },
      {
        ctor: ScriptedSequencerGrain as unknown as typeof RelationshipsGrain,
        interfaces: [IDatastoreGrain as unknown as typeof IRelationshipsGrain],
      },
    ],
    configureSilo: (builder) => {
      builder.useGrainActivator({
        createInstance: (ctor) =>
          ctor === RelationshipsGrain
            ? new RelationshipsGrain({
                datastore,
                schemaProvider: provider,
                schemaSource,
                scanner,
                hub: hubRef.current!,
                admission,
              })
            : constructGrain(ctor),
      });
    },
  });

  const hub = new RecordingHub(
    cluster.primary.host.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY),
    hubFactory(cluster),
  );
  hubRef.current = hub;

  fixture = { cluster, datastore, schemaSource, scanner, hub, provider, metrics };
  return fixture;
}

afterEach(async () => {
  const current = fixture;
  fixture = undefined;
  if (current !== undefined) {
    await current.hub.dispose();
    await current.cluster.dispose();
  }
});

function target(f: Fixture): IRelationshipsGrain {
  return f.cluster.primary.host.getGrain(IRelationshipsGrain, RELATIONSHIPS_GRAIN_KEY);
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(value: Uint8Array | undefined): string {
  return value === undefined ? "" : new TextDecoder().decode(value);
}

function rel(resourceId: string, subjectId: string): RelationshipWire {
  return {
    resourceType: "document",
    resourceId,
    resourceRelation: "viewer",
    subjectType: "user",
    subjectId,
    subjectRelation: ELLIPSIS,
  };
}

/** The single commit the case under test submitted (asserting there was exactly one). */
function onlyCommit(): CommitRequest {
  expect(script.commits).toHaveLength(1);
  return script.commits[0]!;
}

// --- the gates --------------------------------------------------------------------------------

describe("RelationshipsGrain", () => {
  describe("writeSchema: the three rejection types", () => {
    it("rejects a caller schema that does not compile as an argument error, before any commit", async () => {
      const f = await start();
      script.replies = [ok(2_000n)];

      const error = await target(f)
        .writeSchema({ schemaText: "definition user {" })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      // InvalidArgument, and the ORIGINAL compile message is carried through verbatim.
      expect(error).toBeInstanceOf(InvalidArgumentError);
      expect((error as Error).message).not.toBe("");
      // Nothing was pinned, read or submitted: the compile happens FIRST, before the datastore is
      // touched at all.
      expect(script.commits).toEqual([]);
      expect(f.datastore.headCalls).toEqual([]);
    });

    it("rejects a type-invalid schema as a write-validation failure, before any commit", async () => {
      const f = await start();
      script.replies = [ok(2_000n)];

      // `viewer: missing` names an undefined type - a SchemaTypeException, not a compile failure.
      const error = await target(f)
        .writeSchema({
          schemaText: "definition document {\n    relation viewer: missing\n}",
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(SchemaWriteValidationException);
      expect(script.commits).toEqual([]);
      expect(f.datastore.headCalls).toEqual([]);
    });

    it("blames the STORE, not the caller, when the stored schema fails to compile", async () => {
      const f = await start();
      f.schemaSource.stored = bytes("definition document {");
      script.replies = [ok(2_000n)];

      const error = await target(f)
        .writeSchema({ schemaText: SCHEMA_WITH_EDITOR })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      // NOT an InvalidArgumentError: the caller's schema compiled fine. This is Internal.
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidArgumentError);
      expect(error).not.toBeInstanceOf(SchemaWriteValidationException);
      expect((error as Error).message).toContain(
        "stored schema failed to compile; the persisted schema at the pinned revision is corrupt: ",
      );
      expect(script.commits).toEqual([]);
    });
  });

  describe("writeSchema: the commit request", () => {
    it("carries the schema bytes, the pinned schema hash, and nothing else", async () => {
      const f = await start();
      script.replies = [ok(2_000n)];

      await target(f).writeSchema({ schemaText: SCHEMA_WITH_EDITOR });

      const commit = onlyCommit();
      expect(text(commit.schemaBytes)).toBe(SCHEMA_WITH_EDITOR);
      expect(commit.expectedSchemaHash).toBe("hash-1");
      expect(commit.updates).toEqual([]);
      expect(commit.deleteByFilter).toBeUndefined();
      expect(commit.counterChanges).toEqual([]);
      // A declarative commit: no head CAS rides this request.
      expect(commit.expectedHead).toBeUndefined();
      // A pure addition carries no orphan guard.
      expect(commit.preconditions).toEqual([]);
    });

    it("sends an EMPTY expected hash - never absent - when the head carries no schema hash", async () => {
      const f = await start();
      f.datastore.head = { revision: new TimestampRevision(1_000n) };
      script.replies = [ok(2_000n)];

      await target(f).writeSchema({ schemaText: SCHEMA_WITH_EDITOR });

      // `head.SchemaHash ?? string.Empty`. The sequencer's gate treats an absent CURRENT hash as
      // matching only an EMPTY expected hash, so `undefined` here would reject every first write.
      expect(onlyCommit().expectedSchemaHash).toBe("");
    });

    it("rides the no-orphans guards as MUST_NOT_MATCH preconditions", async () => {
      const f = await start();
      script.replies = [ok(2_000n)];

      // Removing `viewer` from the seed produces the removal-delta orphan guards.
      await target(f).writeSchema({ schemaText: SCHEMA_WITHOUT_VIEWER });

      const commit = onlyCommit();
      expect(commit.preconditions.length).toBeGreaterThan(0);
      // Every one is MUST_NOT_MATCH: the guard is "no data would be orphaned".
      expect(commit.preconditions.every((p) => p.mustMatch === false)).toBe(true);
    });

    it("diffs against the STORED schema at the pinned revision, not the live snapshot", async () => {
      const f = await start();
      // The live provider is ALREADY at the target text, so a live-vs-next diff is empty; the
      // stored schema at head still has `viewer`, so a stored-vs-next diff carries orphan guards.
      f.provider.update(SCHEMA_WITHOUT_VIEWER);
      f.schemaSource.stored = bytes(SEED_SCHEMA);
      script.replies = [ok(2_000n)];

      await target(f).writeSchema({ schemaText: SCHEMA_WITHOUT_VIEWER });

      expect(f.schemaSource.readAt).toHaveLength(1);
      expect(f.schemaSource.readAt[0]).toBe(f.datastore.head.revision);
      // Non-empty proves the base was the STORED schema. A port that diffed against
      // `schemaProvider.current` would send zero preconditions here and lose the guard entirely.
      expect(onlyCommit().preconditions.length).toBeGreaterThan(0);
    });

    it("falls back to the live snapshot only when nothing is stored", async () => {
      const f = await start();
      f.schemaSource.stored = undefined;
      script.replies = [ok(2_000n)];

      await target(f).writeSchema({ schemaText: SCHEMA_WITHOUT_VIEWER });

      // The live snapshot IS the seed, so the removal guards appear from the fallback base.
      expect(onlyCommit().preconditions.length).toBeGreaterThan(0);
    });

    it("rejects an orphaning change client-side, with the descriptive message and no commit", async () => {
      const f = await start();
      // One live `document:readme#viewer@user:alice` row makes the removal of `viewer` orphaning.
      f.scanner.rows = [
        createRelationship(
          { objectType: "document", objectId: "readme", relation: "viewer" },
          { objectType: "user", objectId: "alice", relation: ELLIPSIS },
        ),
      ];
      script.replies = [ok(2_000n)];

      const error = await target(f)
        .writeSchema({ schemaText: SCHEMA_WITHOUT_VIEWER })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(SchemaWriteValidationException);
      expect(script.commits).toEqual([]);
      // Rejected: the live schema must be untouched.
      expect(f.provider.updates).toEqual([]);
    });
  });

  describe("writeSchema: success", () => {
    it("pulses the hub BEFORE swapping the live schema, then mints the token", async () => {
      const f = await start();
      script.replies = [ok(2_000n)];

      const reply = await target(f).writeSchema({ schemaText: SCHEMA_WITH_EDITOR });

      // THE ORDER IS THE GATE. Swapping first would publish a schema the persist had not yet
      // committed.
      expect(trace).toEqual(["pulse:2000", "update"]);
      expect(f.hub.pulses).toEqual([2_000n]);
      expect(f.provider.updates).toEqual([SCHEMA_WITH_EDITOR]);
      // The token names the COMMITTED revision and the NEW snapshot's hash.
      expect(reply.writtenAtToken).toBe(
        zedTokenFromRevision(
          new TimestampRevision(2_000n),
          f.provider.current.schemaHash,
          DATASTORE_ID,
        ).token,
      );
    });
  });

  describe("writeSchema: retry classification", () => {
    it.each(["schemaHashMoved", "preconditionFailed", "headMoved"] as const)(
      "re-validates against a fresh base and retries on %s",
      async (kind) => {
        const f = await start();
        script.replies = [rejected(kind), ok(3_000n)];

        await target(f).writeSchema({ schemaText: SCHEMA_WITH_EDITOR });

        expect(script.commits).toHaveLength(2);
        // A FRESH base each attempt: the head is re-pinned and the stored schema re-read.
        expect(f.datastore.headCalls).toHaveLength(2);
        expect(f.schemaSource.readAt).toHaveLength(2);
        expect(f.hub.pulses).toEqual([3_000n]);
      },
    );

    it("throws loudly on any other failure kind", async () => {
      const f = await start();
      script.replies = [rejected("createAlreadyExists", "document:readme#viewer@user:alice")];

      const error = await target(f)
        .writeSchema({ schemaText: SCHEMA_WITH_EDITOR })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect((error as Error).message).toContain("unexpected schema-commit failure");
      expect((error as Error).message).toContain("createAlreadyExists");
    });

    it("gives up after exactly 50 attempts with a serialization conflict", async () => {
      const f = await start();
      script.replies = [rejected("schemaHashMoved")];

      const error = await target(f)
        .writeSchema({ schemaText: SCHEMA_WITH_EDITOR })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(SerializationException);
      // `MaxCommitAttempts = 50`, and the throw happens INSIDE the loop after the 50th reply.
      expect(script.commits).toHaveLength(50);
      // A rejected write never swaps the live schema.
      expect(f.provider.updates).toEqual([]);
      expect(f.hub.pulses).toEqual([]);
    });
  });

  describe("readSchema", () => {
    it("returns the live source text with a token at the OPTIMIZED revision", async () => {
      const f = await start();

      const reply = await target(f).readSchema();

      expect(reply.schemaText).toBe(SEED_SCHEMA);
      expect(reply.readAtToken).toBe(
        zedTokenFromRevision(
          f.datastore.optimized.revision,
          f.provider.current.schemaHash,
          DATASTORE_ID,
        ).token,
      );
      // A read submits nothing.
      expect(script.commits).toEqual([]);
    });
  });

  describe("writeRelationships", () => {
    it("submits one declarative commit carrying the updates and the mapped preconditions", async () => {
      const f = await start();
      script.replies = [ok(4_000n)];

      const preconditions: PreconditionWire[] = [
        { operation: "mustMatch", filter: { resourceType: "document" } },
        { operation: "mustNotMatch", filter: { resourceType: "folder" } },
      ];
      const reply = await target(f).writeRelationships({
        updates: [{ operation: "touch", relationship: rel("readme", "alice") }],
        preconditions,
      });

      const commit = onlyCommit();
      expect(commit.updates).toHaveLength(1);
      expect(commit.updates[0]!.operation).toBe("touch");
      expect(commit.preconditions.map((p) => p.mustMatch)).toEqual([true, false]);
      expect(commit.preconditions[0]!.filter.optionalResourceType).toBe("document");
      expect(commit.schemaBytes).toBeUndefined();
      expect(commit.expectedSchemaHash).toBeUndefined();
      expect(commit.expectedHead).toBeUndefined();
      expect(commit.counterChanges).toEqual([]);
      expect(commit.deleteByFilter).toBeUndefined();

      expect(f.hub.pulses).toEqual([4_000n]);
      expect(reply.writtenAtToken).toBe(
        zedTokenFromRevision(
          new TimestampRevision(4_000n),
          f.provider.current.schemaHash,
          DATASTORE_ID,
        ).token,
      );
    });

    it("sends an empty precondition list when none are supplied", async () => {
      const f = await start();
      script.replies = [ok(4_000n)];

      await target(f).writeRelationships({
        updates: [{ operation: "create", relationship: rel("readme", "alice") }],
      });

      expect(onlyCommit().preconditions).toEqual([]);
    });

    it("rethrows a precondition rejection with the kind and index recovered from the message", async () => {
      const f = await start();
      const detail = mustNotMatchFailedMessage(3, { optionalResourceType: "document" });
      script.replies = [rejected("preconditionFailed", detail)];

      const error = await target(f)
        .writeRelationships({ updates: [{ operation: "touch", relationship: rel("a", "b") }] })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(PreconditionFailedException);
      const failure = error as PreconditionFailedException;
      // The text round-trip: kind and index come back out of the message the sequencer sent.
      expect(failure.kind).toBe("mustNotMatchFoundOne");
      expect(failure.preconditionIndex).toBe(3);
      expect(failure.message).toBe(detail);
    });

    it("recovers a MUST_MATCH failure the same way", async () => {
      const f = await start();
      const detail = mustMatchFailedMessage(0, { optionalResourceType: "document" });
      script.replies = [rejected("preconditionFailed", detail)];

      const error = (await target(f)
        .writeRelationships({ updates: [] })
        .catch((e: unknown) => e)) as PreconditionFailedException;

      expect(error.kind).toBe("mustMatchFoundNone");
      expect(error.preconditionIndex).toBe(0);
    });

    it("falls back to (mustMatchFoundNone, 0) on a detail this port did not produce", async () => {
      const f = await start();
      script.replies = [rejected("preconditionFailed", "something else entirely")];

      const error = (await target(f)
        .writeRelationships({ updates: [] })
        .catch((e: unknown) => e)) as PreconditionFailedException;

      expect(error).toBeInstanceOf(PreconditionFailedException);
      expect(error.kind).toBe("mustMatchFoundNone");
      expect(error.preconditionIndex).toBe(0);
      // The message is still the detail verbatim.
      expect(error.message).toBe("something else entirely");
    });

    it("treats an ABSENT detail as the empty message", async () => {
      const f = await start();
      script.replies = [rejected("preconditionFailed")];

      const error = (await target(f)
        .writeRelationships({ updates: [] })
        .catch((e: unknown) => e)) as PreconditionFailedException;

      expect(error.message).toBe("");
      expect(error.kind).toBe("mustMatchFoundNone");
      expect(error.preconditionIndex).toBe(0);
    });

    it("DERIVES the create-conflict message from the detail rather than using the detail", async () => {
      const f = await start();
      const conflicting = "document:readme#viewer@user:alice";
      script.replies = [rejected("createAlreadyExists", conflicting)];

      const error = await target(f)
        .writeRelationships({
          updates: [{ operation: "create", relationship: rel("readme", "alice") }],
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(WriteConflictException);
      const conflict = error as WriteConflictException;
      expect(conflict.kind).toBe("createExisting");
      // The detail is the RELATIONSHIP; the message is what the datastore exception derives from it
      // (SpiceDB-verbatim), so a port that used the detail as the message changes what clients see.
      expect(conflict.message).toBe(new CreateRelationshipExistsException(conflicting).message);
      expect(conflict.message).not.toBe(conflicting);
    });

    it("retries headMoved only, and gives up with the exact serialization message", async () => {
      const f = await start();
      script.replies = [rejected("headMoved")];

      const error = await target(f)
        .writeRelationships({ updates: [] })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(WriteConflictException);
      expect((error as WriteConflictException).kind).toBe("serialization");
      // BYTE-IDENTICAL to the default text: the front door maps this to Aborted and the client
      // retries the whole transaction on exactly this.
      expect((error as Error).message).toBe(new SerializationException().message);
      expect(script.commits).toHaveLength(50);
      expect(f.hub.pulses).toEqual([]);
    });

    it("retries headMoved and succeeds when it recedes", async () => {
      const f = await start();
      script.replies = [rejected("headMoved"), rejected("headMoved"), ok(5_000n)];

      await target(f).writeRelationships({ updates: [] });

      expect(script.commits).toHaveLength(3);
      // The SAME request is resubmitted: a declarative commit needs no re-validation.
      expect(script.commits[0]).toEqual(script.commits[2]);
      expect(f.hub.pulses).toEqual([5_000n]);
    });

    it("pulses on ANY reply carrying a revision, including a failure reply", async () => {
      const f = await start();
      script.replies = [
        {
          failure: { kind: "createAlreadyExists", detail: "x" },
          revision: 6_000n,
          deletedCount: 0n,
          reachedLimit: false,
        },
      ];

      await target(f)
        .writeRelationships({ updates: [] })
        .catch(() => undefined);

      // `if (reply.Revision is { } revision) hub.Pulse(revision);` sits BEFORE the failure mapping.
      expect(f.hub.pulses).toEqual([6_000n]);
    });
  });

  describe("deleteRelationships", () => {
    it("submits the filter as a delete-by-filter and returns the reply's counts", async () => {
      const f = await start();
      script.replies = [ok(7_000n, 4n, true)];

      const reply = await target(f).deleteRelationships({
        filter: { resourceType: "document", resourceIds: ["readme"], subjectType: "user" },
        optionalLimit: 10n,
      });

      const commit = onlyCommit();
      expect(commit.deleteByFilter?.limit).toBe(10n);
      expect(commit.deleteByFilter?.filter.optionalResourceType).toBe("document");
      expect(commit.updates).toEqual([]);
      expect(reply.deletedCount).toBe(4n);
      expect(reply.reachedLimit).toBe(true);
      expect(reply.deletedAtToken).toBe(
        zedTokenFromRevision(
          new TimestampRevision(7_000n),
          f.provider.current.schemaHash,
          DATASTORE_ID,
        ).token,
      );
    });

    it("leaves the limit absent when none is given", async () => {
      const f = await start();
      script.replies = [ok(7_000n)];

      await target(f).deleteRelationships({ filter: { resourceType: "document" } });

      expect(onlyCommit().deleteByFilter?.limit).toBeUndefined();
    });
  });

  describe("toFilter: the subjects selector", () => {
    /** Submits a delete and hands back the full filter the commit carried. */
    async function filterFor(f: Fixture, wire: RelationshipsFilterWire) {
      script.commits.length = 0;
      script.replies = [ok(8_000n)];
      await target(f).deleteRelationships({ filter: wire });
      return script.commits[script.commits.length - 1]!.deleteByFilter!.filter;
    }

    it("creates NO selector for absent subject constraints", async () => {
      const f = await start();
      const filter = await filterFor(f, { resourceType: "document" });
      expect(filter.optionalSubjectsSelectors).toBeUndefined();
    });

    it("creates NO selector for EMPTY subject constraints", async () => {
      const f = await start();
      // `{ Length: > 0 }` / `{ Count: > 0 }`: an empty string or empty list is NOT a constraint.
      // Producing a selector here would turn an unconstrained filter into a constrained one and
      // change which rows the delete matches.
      const filter = await filterFor(f, {
        resourceType: "document",
        subjectType: "",
        subjectRelation: "",
        subjectIds: [],
      });
      expect(filter.optionalSubjectsSelectors).toBeUndefined();
    });

    it("creates ONE selector when the subject type is non-empty", async () => {
      const f = await start();
      const filter = await filterFor(f, { subjectType: "user" });
      expect(filter.optionalSubjectsSelectors).toHaveLength(1);
      expect(filter.optionalSubjectsSelectors![0]!.optionalSubjectType).toBe("user");
      // No relation constraint was asked for, so none is created.
      expect(filter.optionalSubjectsSelectors![0]!.relationFilter).toBeUndefined();
    });

    it("creates a selector when only the subject IDS are given", async () => {
      const f = await start();
      const filter = await filterFor(f, { subjectIds: ["alice"] });
      expect(filter.optionalSubjectsSelectors).toHaveLength(1);
      expect(filter.optionalSubjectsSelectors![0]!.optionalSubjectIds).toEqual(["alice"]);
    });

    it("maps a non-empty subject relation to the non-ellipsis relation filter", async () => {
      const f = await start();
      const filter = await filterFor(f, { subjectRelation: "member" });
      expect(filter.optionalSubjectsSelectors).toHaveLength(1);
      expect(filter.optionalSubjectsSelectors![0]!.relationFilter?.nonEllipsisRelation).toBe(
        "member",
      );
    });
  });

  describe("bulkImportRelationships", () => {
    it("loads every row with CREATE semantics in ONE commit", async () => {
      const f = await start();
      script.replies = [ok(9_000n)];

      const reply = await target(f).bulkImportRelationships({
        relationships: [rel("a", "alice"), rel("b", "bob"), rel("c", "carol")],
      });

      const commit = onlyCommit();
      // CREATE per row, matching real SpiceDB v1.49.2 - never a silent upsert.
      expect(commit.updates.map((u) => u.operation)).toEqual(["create", "create", "create"]);
      expect(commit.preconditions).toEqual([]);
      // `(ulong)updates.Count` -> a bigint on the wire.
      expect(reply.numLoaded).toBe(3n);
      expect(typeof reply.numLoaded).toBe("bigint");
    });

    it("rejects the WHOLE import when a row already exists, applying nothing", async () => {
      const f = await start();
      const conflicting = "document:a#viewer@user:alice";
      script.replies = [rejected("createAlreadyExists", conflicting)];

      const error = await target(f)
        .bulkImportRelationships({ relationships: [rel("a", "alice"), rel("b", "bob")] })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(WriteConflictException);
      expect((error as WriteConflictException).kind).toBe("createExisting");
      expect((error as Error).message).toBe(
        new CreateRelationshipExistsException(conflicting).message,
      );
      // ONE commit: the import is a single declarative transaction, so a rejection applies nothing.
      expect(script.commits).toHaveLength(1);
    });

    it("reports zero loaded for an empty import", async () => {
      const f = await start();
      script.replies = [ok(9_000n)];

      const reply = await target(f).bulkImportRelationships({ relationships: [] });

      expect(reply.numLoaded).toBe(0n);
      expect(onlyCommit().updates).toEqual([]);
    });
  });

  describe("counters", () => {
    it("registers with a single counter delta carrying the filter", async () => {
      const f = await start();
      script.replies = [ok(10_000n)];

      await target(f).registerRelationshipCounter({
        name: "docs",
        filter: { resourceType: "document" },
      });

      const commit = onlyCommit();
      expect(commit.counterChanges).toHaveLength(1);
      expect(commit.counterChanges[0]!.name).toBe("docs");
      expect(commit.counterChanges[0]!.filter?.optionalResourceType).toBe("document");
      expect(commit.updates).toEqual([]);
      expect(commit.preconditions).toEqual([]);
      expect(commit.deleteByFilter).toBeUndefined();
      expect(commit.schemaBytes).toBeUndefined();
    });

    it("unregisters with a delta whose filter is ABSENT - the tombstone the grain keys on", async () => {
      const f = await start();
      script.replies = [ok(10_000n)];

      await target(f).unregisterRelationshipCounter({ name: "docs" });

      const commit = onlyCommit();
      expect(commit.counterChanges).toHaveLength(1);
      expect(commit.counterChanges[0]!.name).toBe("docs");
      // The C# sends a NULL filter and the grain-side DeleteCounter guard keys on exactly that.
      expect(commit.counterChanges[0]!.filter).toBeUndefined();
      expect("filter" in commit.counterChanges[0]!).toBe(true);
    });

    it("maps counterAlreadyRegistered to a derived-message counter failure", async () => {
      const f = await start();
      script.replies = [rejected("counterAlreadyRegistered", "docs")];

      const error = await target(f)
        .registerRelationshipCounter({ name: "docs", filter: {} })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(CounterOperationException);
      expect((error as CounterOperationException).kind).toBe("alreadyRegistered");
      // Derived from the NAME, exactly as the datastore exception derives it.
      expect((error as Error).message).toBe(new CounterAlreadyRegisteredException("docs").message);
    });

    it("maps counterNotRegistered to a derived-message counter failure", async () => {
      const f = await start();
      script.replies = [rejected("counterNotRegistered", "docs")];

      const error = await target(f)
        .unregisterRelationshipCounter({ name: "docs" })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(CounterOperationException);
      expect((error as CounterOperationException).kind).toBe("notRegistered");
      expect((error as Error).message).toBe(new CounterNotRegisteredException("docs").message);
    });

    it("surfaces any other counter-commit failure loudly", async () => {
      const f = await start();
      script.replies = [rejected("preconditionFailed", "whatever")];

      const error = await target(f)
        .registerRelationshipCounter({ name: "docs", filter: {} })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).not.toBeInstanceOf(CounterOperationException);
      expect((error as Error).message).toContain("unexpected counter-commit failure");
    });
  });

  describe("countRelationships", () => {
    it("resolves FULLY consistent and counts through the storage-direct scan seam", async () => {
      const f = await start();
      f.scanner.count = 42n;

      const reply = await target(f).countRelationships({ name: "docs" });

      // FullyConsistent resolves to the HEAD revision (SpiceDB's on-demand path), not the
      // optimized one, and the count goes through ISnapshotScanner - never the shard mesh.
      expect(f.scanner.countCalls).toEqual([{ name: "docs", revision: f.datastore.head.revision }]);
      expect(reply.count).toBe(42n);
      expect(reply.readAtToken).toBe(
        zedTokenFromRevision(f.datastore.head.revision, "hash-1", DATASTORE_ID).token,
      );
      // Its own resolution: no commit is submitted for a read.
      expect(script.commits).toEqual([]);
      // The resolver is the FullyConsistent one; asserting the constant keeps the intent readable.
      expect(FULLY_CONSISTENT.kind).toBe("fullyConsistent");
    });

    it("falls back to the live schema hash when the resolved revision carries none", async () => {
      const f = await start();
      f.datastore.head = { revision: new TimestampRevision(1_000n) };
      f.scanner.count = 1n;

      const reply = await target(f).countRelationships({ name: "docs" });

      expect(reply.readAtToken).toBe(
        zedTokenFromRevision(f.datastore.head.revision, f.provider.current.schemaHash, DATASTORE_ID)
          .token,
      );
    });

    it("re-wraps an unregistered counter as the serializable counter failure", async () => {
      const f = await start();
      f.scanner.count = new CounterNotRegisteredException("docs");

      const error = await target(f)
        .countRelationships({ name: "docs" })
        .then(
          () => undefined,
          (e: unknown) => e,
        );

      expect(error).toBeInstanceOf(CounterOperationException);
      expect((error as CounterOperationException).kind).toBe("notRegistered");
      // The message is the CAUGHT exception's, carried through unchanged.
      expect((error as Error).message).toBe(new CounterNotRegisteredException("docs").message);
    });
  });

  describe("the sequencer admission gate", () => {
    it("sheds a commit when the gate is full", async () => {
      // A gate of ONE, and a sequencer that never answers the first commit: the second is shed.
      const f = await start({ maxInFlightCommits: 1 });
      let release: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      script.replies = [];
      const original = ScriptedSequencerGrain.prototype.commit;
      ScriptedSequencerGrain.prototype.commit = async function commit(request: CommitRequest) {
        script.commits.push(request);
        await blocked;
        return ok(11_000n);
      };

      try {
        const first = target(f).writeRelationships({ updates: [] });
        // Let the first call reach the sequencer and take the slot.
        await Promise.resolve();
        await Promise.resolve();

        const error = await target(f)
          .writeRelationships({ updates: [] })
          .then(
            () => undefined,
            (e: unknown) => e,
          );

        expect(error).toBeInstanceOf(SequencerOverloadedException);
        expect(f.metrics.snapshot().commitShed).toBe(1);

        release!();
        await first;
      } finally {
        ScriptedSequencerGrain.prototype.commit = original;
      }
    });

    it("releases the slot per ATTEMPT, so a retry loop is not self-blocking", async () => {
      // With a gate of one, a retrying write can only complete if each attempt releases its slot.
      const f = await start({ maxInFlightCommits: 1 });
      script.replies = [rejected("headMoved"), rejected("headMoved"), ok(12_000n)];

      await target(f).writeRelationships({ updates: [] });

      expect(script.commits).toHaveLength(3);
      expect(f.metrics.snapshot().commitShed).toBe(0);
    });
  });
});
